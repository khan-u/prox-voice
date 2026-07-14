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
