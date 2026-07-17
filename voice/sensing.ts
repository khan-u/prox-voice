/**
 * Pure sensing logic for SensorNode: the event model, the energy model, and the
 * per-reading arithmetic. No timers, no getStats, no DOM — the SensorNode class
 * owns those and calls in here, which is what makes the thresholds testable.
 */

/** One peer's data-plane connection, as exposed by VoiceRTC's provider. */
export interface PeerEntry {
    index: number;
    pc: RTCPeerConnection;
}

/** Tile-space position of the local node (Game wires the provider). */
export interface NodePosition {
    x: number;
    y: number;
}

/** A single link-quality reading for one neighbour (units in the names). */
export interface LinkReading {
    index: number;
    state: string;       // connectionState at sample time
    rttMs: number;       // -1 until the selected candidate pair reports RTT
    jitterMs: number;    // -1 until inbound-rtp audio reports jitter
    lossPct: number;     // cumulative inbound loss percentage (-1 unknown)
    upKbps: number;      // uplink bitrate since the previous sample (-1 first time)
}

/** One event-driven report sent to the sink. */
export interface SenseReport {
    t: number;           // epoch ms
    kind: string;        // speech-start|speech-stop|move|link|topology|heartbeat|node-sleep|cluster
    pos: NodePosition | null;
    neighbors: number;
    links: LinkReading[];
    energy: number;      // residual energy 0..1
    note: string;
}

// ── sensing cadence and event thresholds ──────────────────────────────────────
export const SAMPLE_MS = 2000;         // link/position sampling period
export const HEARTBEAT_MS = 30000;     // max quiet time between reports
export const MOVE_TILES = 6;           // movement that counts as an event
export const RTT_DELTA_MIN_MS = 20;    // absolute RTT shift floor...
export const RTT_DELTA_FRAC = 0.5;     // ...and relative shift trigger
export const LOSS_DELTA_PCT = 2;       // loss increase that's an event
export const MAX_REPORTS = 500;        // sink buffer bound (ring)

// The virtual energy model charges the node for radio use: 1.0 minus cumulative
// measured uplink bytes against a fixed budget (energy spent proportional to
// bytes sent), so the same node runs on browsers with no Battery API.
export const VIRTUAL_BUDGET_BYTES = 50 * 1024 * 1024;

/** Residual energy 0..1 — forced value > real battery > virtual budget. */
export function energyLevel(
    forced: number | null, battery: number | null, totalBytesSent: number,
): number {
    if (forced != null) { return forced; }
    if (battery != null) { return battery; }
    return Math.max(0, 1 - totalBytesSent / VIRTUAL_BUDGET_BYTES);
}

export function energySource(forced: number | null, battery: number | null): string {
    if (forced != null) { return "forced"; }
    if (battery != null) { return "battery"; }
    return "virtual";
}

/** Cumulative inbound loss as a one-decimal percentage; -1 when nothing arrived. */
export function lossPct(lost: number, received: number): number {
    const total = received + lost;
    return total > 0 ? Math.round((lost * 1000) / total) / 10 : -1;
}

/** Uplink bitrate from a byte/time delta. bits/ms == kbit/s; -1 if undefined. */
export function upKbps(bytesDelta: number, msDelta: number): number {
    return msDelta > 0 && bytesDelta >= 0 ? Math.round((bytesDelta * 8) / msDelta) : -1;
}

/** Share of samples the event-driven layer declined to report (0..100). */
export function suppressedPct(samples: number, suppressed: number): number {
    return samples > 0 ? Math.round((suppressed * 100) / samples) : 0;
}

/**
 * Decide whether a periodic sample is a significant event, judged against what
 * the sink *last heard* (not the previous sample) — exactly how suppression
 * works in a real node. Returns the event kind + note, or null to suppress.
 */
export function detectEvent(
    links: LinkReading[],
    lastReportedLinks: Map<number, LinkReading>,
    pos: NodePosition | null,
    lastPos: NodePosition | null,
): { kind: string; note: string } | null {
    // Movement: straight-line tiles since the last *reported* position.
    if (pos != null && lastPos != null) {
        const dx = pos.x - lastPos.x, dy = pos.y - lastPos.y;
        if (dx * dx + dy * dy >= MOVE_TILES * MOVE_TILES) {
            return { kind: "move", note: "moved " + Math.round(Math.hypot(dx, dy)) + " tiles" };
        }
    } else if (pos != null && lastPos == null) {
        return { kind: "move", note: "first position fix" };
    }

    // Topology: the neighbour set the sink knows no longer matches reality.
    if (links.length !== lastReportedLinks.size) {
        return { kind: "topology", note: lastReportedLinks.size + " → " + links.length + " neighbors" };
    }

    // Link quality: a state change, or a significant RTT / loss shift.
    for (const cur of links) {
        const ref = lastReportedLinks.get(cur.index);
        if (ref == null) { return { kind: "topology", note: "peer " + cur.index + " replaced a neighbor" }; }
        if (cur.state !== ref.state) {
            return { kind: "link", note: "peer " + cur.index + " " + ref.state + " → " + cur.state };
        }
        if (cur.rttMs >= 0 && ref.rttMs >= 0) {
            const delta = Math.abs(cur.rttMs - ref.rttMs);
            if (delta >= RTT_DELTA_MIN_MS && delta >= ref.rttMs * RTT_DELTA_FRAC) {
                return { kind: "link", note: "peer " + cur.index + " RTT " + ref.rttMs + " → " + cur.rttMs + " ms" };
            }
        }
        if (cur.lossPct >= 0 && ref.lossPct >= 0 && cur.lossPct - ref.lossPct >= LOSS_DELTA_PCT) {
            return { kind: "link", note: "peer " + cur.index + " loss " + ref.lossPct + " → " + cur.lossPct + "%" };
        }
    }
    return null;
}
