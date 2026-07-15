/**
 * Pure KPI/latency math for VoiceMetrics.
 *
 * Everything here is a plain function over plain data: no timers, no getStats,
 * no DOM. The VoiceMetrics class owns those side effects and calls into this
 * module, which is what lets the numbers be unit-tested without a browser.
 */

/** Per-neighbour experiment record (units are in the field names). */
export interface LinkMetric {
    index: number;
    detectedMs: number;      // performance.now() at neighbour detection
    connectedMs: number;     // first 'connected' (-1 while pending)
    setupMs: number;         // connectedMs - detectedMs (-1 until connected)
    failed: boolean;         // reached failed/closed before ever connecting
    candidateType: string;   // selected local candidate: host|srflx|relay|"" unknown
    rttMs: number;           // selected candidate-pair RTT (-1 unknown)
    latRawMs: number;        // software mouth-to-ear estimate (-1 unknown)
    latCalMs: number;        // latRawMs + calibration offset C (-1 until known)
    glare: number;           // impolite offer-ignores resolved on this link
}

/** Rolled-up indicators over every link seen this session. */
export interface KpiSummary {
    links: number;           // links that reached 'connected'
    iceAttempts: number;     // connected + failed-before-connect
    iceSuccessPct: number;   // 100 * connected / attempts (-1 if no attempts)
    setupMedianMs: number;
    setupP95Ms: number;
    relayPct: number;        // relay share of links with a known candidate type
    candidateMix: { host: number; srflx: number; relay: number };
    latRawMedianMs: number;
    latRawP95Ms: number;
    latCalMedianMs: number;  // -1 until a calibration offset is set
    latCalP95Ms: number;
    glareTotal: number;
}

/** One peer's data-plane connection, as exposed by VoiceRTC's provider. */
export interface PeerHandle {
    index: number;
    pc: RTCPeerConnection;
}

// Fixed capture + encode + packetize + de-jitter + decode + playout delay that
// no getStats field reports; the acoustic rig's offset C corrects the residual.
export const DEVICE_CONST_MS = 40;

/** A fresh, all-pending link record stamped at detection time. */
export function newLinkRecord(index: number, nowMs: number): LinkMetric {
    return {
        index, detectedMs: nowMs, connectedMs: -1, setupMs: -1, failed: false,
        candidateType: "", rttMs: -1, latRawMs: -1, latCalMs: -1, glare: 0,
    };
}

/**
 * Whether a (re-)detection of `index` should start a fresh record. A still-
 * pending record keeps its original detection stamp; only a settled one — one
 * that connected or failed — is replaced when the index is reused after teardown.
 */
export function shouldRedetect(prev: LinkMetric | undefined): boolean {
    return prev == null || prev.connectedMs >= 0 || prev.failed;
}

/**
 * Fold a connectionState transition into a link record: the first 'connected'
 * stamps the setup time, and failed/closed before ever connecting counts against
 * ICE success. A transient failure that later recovers is cleared.
 */
export function applyState(rec: LinkMetric, state: string, nowMs: number): void {
    if (state === "connected" && rec.connectedMs < 0) {
        rec.connectedMs = nowMs;
        rec.setupMs = Math.round(nowMs - rec.detectedMs);
        rec.failed = false;
    } else if ((state === "failed" || state === "closed") && rec.connectedMs < 0) {
        rec.failed = true;
    }
}

/** Rewrite one link's calibrated latency once the rig supplies the offset C. */
export function applyCalibration(rec: LinkMetric, c: number): void {
    if (rec.latRawMs >= 0) { rec.latCalMs = Math.round(rec.latRawMs + c); }
}

/** prflx (peer-reflexive) is a NAT-learned srflx for reporting purposes. */
export function normalizeCandidate(t: string): string {
    return t === "prflx" ? "srflx" : t;
}

/**
 * Recent-average jitter-buffer delay in ms from the cumulative getStats
 * counters. jitterBufferDelay is total seconds summed per emitted sample and
 * jitterBufferEmittedCount is that sample count, so the delta between two reads
 * gives the recent average; the first read falls back to the lifetime mean.
 * Returns -1 when the counters are not yet populated.
 */
export function jitterBufferAvgMs(
    prev: { delay: number; count: number } | undefined,
    delay: number, count: number,
): number {
    if (delay < 0 || count <= 0) { return -1; }
    if (prev != null && count > prev.count && delay >= prev.delay) {
        return ((delay - prev.delay) / (count - prev.count)) * 1000;
    }
    return (delay / count) * 1000;
}

/** The Eq. (1) software mouth-to-ear estimate: RTT/2 + jitter buffer + C. */
export function m2eEstimate(rttSeconds: number, jbAvgMs: number): number {
    return Math.round((rttSeconds * 1000) / 2 + jbAvgMs + DEVICE_CONST_MS);
}

/** Nearest-rank percentile of a numeric sample; -1 for an empty sample. */
export function percentile(xs: number[], p: number): number {
    if (xs.length === 0) { return -1; }
    const sorted = [...xs].sort((a, b) => a - b);
    const rank = Math.ceil((p / 100) * sorted.length) - 1;
    return Math.round(sorted[Math.min(sorted.length - 1, Math.max(0, rank))]);
}

/** Roll the per-link records into the session summary the harness reads. */
export function summarizeKpis(all: LinkMetric[], calibrated: boolean): KpiSummary {
    const connected = all.filter((m) => m.connectedMs >= 0);
    const failed = all.filter((m) => m.failed && m.connectedMs < 0);
    const attempts = connected.length + failed.length;

    const setups = connected.map((m) => m.setupMs).filter((v) => v >= 0);
    const typed = connected.filter((m) => m.candidateType !== "");
    const relay = typed.filter((m) => m.candidateType === "relay");
    const latRaw = connected.map((m) => m.latRawMs).filter((v) => v >= 0);
    const latCal = connected.map((m) => m.latCalMs).filter((v) => v >= 0);

    return {
        links: connected.length,
        iceAttempts: attempts,
        iceSuccessPct: attempts > 0 ? Math.round((connected.length * 100) / attempts) : -1,
        setupMedianMs: percentile(setups, 50),
        setupP95Ms: percentile(setups, 95),
        relayPct: typed.length > 0 ? Math.round((relay.length * 100) / typed.length) : -1,
        candidateMix: {
            host: typed.filter((m) => m.candidateType === "host").length,
            srflx: typed.filter((m) => m.candidateType === "srflx").length,
            relay: relay.length,
        },
        latRawMedianMs: percentile(latRaw, 50),
        latRawP95Ms: percentile(latRaw, 95),
        latCalMedianMs: calibrated ? percentile(latCal, 50) : -1,
        latCalP95Ms: calibrated ? percentile(latCal, 95) : -1,
        glareTotal: all.reduce((sum, m) => sum + m.glare, 0),
    };
}
