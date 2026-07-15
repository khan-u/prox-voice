/**
 * VoiceMetrics — experiment instrumentation for the proximity voice mesh.
 *
 * VoiceRTC carries the audio; this module measures it, turning the project's key
 * indicators into collectable trial data without touching the negotiation path.
 * It covers the software-measurable half of experiment groups 1 and 2: link
 * setup time, ICE success rate, the winning candidate type, glare correctness,
 * and the software mouth-to-ear estimate the acoustic rig later calibrates.
 *
 * It imports nothing from the mesh — it is fed by an injected peer provider and
 * pushed lifecycle edges, and is duty-cycled with the radio — so observing the
 * network can never perturb it. Data leaves via exportJson() or the `wsnVoice`
 * DevTools handle. The KPI arithmetic lives in ./metrics so it can be tested
 * without a browser.
 */
import {
    LinkMetric, KpiSummary, PeerHandle, DEVICE_CONST_MS,
    newLinkRecord, shouldRedetect, applyState, applyCalibration,
    normalizeCandidate, jitterBufferAvgMs, m2eEstimate, summarizeKpis,
} from "./metrics";

export class VoiceMetrics {
    private static readonly SAMPLE_MS = 2000;   // getStats period for latency/candidate

    private static peersProvider: (() => PeerHandle[]) | null = null;
    private static timer: ReturnType<typeof setInterval> | null = null;
    private static sampling = false;            // getStats in flight — skip the tick
    private static links: Map<number, LinkMetric> = new Map();
    private static calibrationMs = 0;           // C from the rig (D6 -> D4)
    private static calibrated = false;          // has C been set at least once
    // Per-peer jitter-buffer counters for the recent-average latency estimate.
    private static lastJb: Map<number, { delay: number; count: number }> = new Map();

    static wirePeers(provider: () => PeerHandle[]): void {
        VoiceMetrics.peersProvider = provider;
    }

    // ── duty cycle (driven by VoiceRTC alongside the radio) ───────────────────

    static start(): void {
        if (VoiceMetrics.timer != null || typeof window === "undefined") { return; }
        VoiceMetrics.timer = setInterval(() => void VoiceMetrics.sample(), VoiceMetrics.SAMPLE_MS);
        (window as any).wsnVoice = {
            kpis: () => VoiceMetrics.kpis(),
            dump: () => [...VoiceMetrics.links.values()],
            export: () => VoiceMetrics.exportJson(),
            setCalibrationMs: (c: number) => VoiceMetrics.setCalibrationMs(c),
        };
    }

    // ── pushed lifecycle edges (from VoiceRTC) ────────────────────────────────

    /** A new neighbour peer is being opened — starts the setup-time clock. */
    static markDetected(index: number): void {
        if (typeof performance === "undefined") { return; }
        if (shouldRedetect(VoiceMetrics.links.get(index))) {
            VoiceMetrics.links.set(index, newLinkRecord(index, performance.now()));
        }
    }

    /** RTCPeerConnection.connectionState transition from VoiceRTC. */
    static markState(index: number, state: string): void {
        const rec = VoiceMetrics.links.get(index);
        if (rec != null && typeof performance !== "undefined") {
            applyState(rec, state, performance.now());
        }
    }

    /** Impolite offer-ignore in VoiceRTC's perfect-negotiation glare branch. */
    static markGlare(index: number): void {
        const rec = VoiceMetrics.links.get(index);
        if (rec != null) { rec.glare++; }
    }

    /** Apply the rig-derived mouth-to-ear offset C (D6 calibrates D4). */
    static setCalibrationMs(c: number): void {
        VoiceMetrics.calibrationMs = c;
        VoiceMetrics.calibrated = true;
        for (const rec of VoiceMetrics.links.values()) {
            applyCalibration(rec, VoiceMetrics.calibrationMs);
        }
    }

    static isCalibrated(): boolean { return VoiceMetrics.calibrated; }

    static stop(): void {
        if (VoiceMetrics.timer == null) { return; }
        clearInterval(VoiceMetrics.timer);
        VoiceMetrics.timer = null;
    }

    static isRunning(): boolean {
        return VoiceMetrics.timer != null;
    }

    // ── the sampler ───────────────────────────────────────────────────────────

    /** Read the selected candidate type, RTT, and software latency per peer. */
    private static async sample(): Promise<void> {
        if (VoiceMetrics.sampling) { return; }
        VoiceMetrics.sampling = true;
        try {
            const peers = VoiceMetrics.peersProvider ? VoiceMetrics.peersProvider() : [];
            const seen = new Set<number>();
            for (const entry of peers) {
                seen.add(entry.index);
                const rec = VoiceMetrics.links.get(entry.index);
                if (rec == null) { continue; }   // no detection stamp → nothing to attach
                try { await VoiceMetrics.readPeer(entry, rec); }
                catch { /* closed mid-sample — keep the record as-is */ }
            }
            for (const idx of VoiceMetrics.lastJb.keys()) {
                if (!seen.has(idx)) { VoiceMetrics.lastJb.delete(idx); }
            }
        } finally {
            VoiceMetrics.sampling = false;
        }
    }

    /** One peer's getStats read → candidate type, RTT, and latency estimate. */
    private static async readPeer(entry: PeerHandle, rec: LinkMetric): Promise<void> {
        const stats = await entry.pc.getStats();
        let selectedLocalId = "";
        let rttS = -1;
        let jbDelay = -1, jbCount = -1;
        const localTypes: Record<string, string> = {};

        stats.forEach((s: any) => {
            // Selected pair: nominated/selected flags work across browsers on a
            // live call where selectedCandidatePairId is not always populated.
            if (s.type === "candidate-pair" && s.state === "succeeded" &&
                (s.nominated === true || s.selected === true)) {
                if (typeof s.currentRoundTripTime === "number") { rttS = s.currentRoundTripTime; }
                if (typeof s.localCandidateId === "string") { selectedLocalId = s.localCandidateId; }
            }
            if (s.type === "local-candidate" && typeof s.candidateType === "string") {
                localTypes[s.id] = s.candidateType;   // host | srflx | prflx | relay
            }
            if (s.type === "inbound-rtp" && s.kind === "audio") {
                if (typeof s.jitterBufferDelay === "number") { jbDelay = s.jitterBufferDelay; }
                if (typeof s.jitterBufferEmittedCount === "number") { jbCount = s.jitterBufferEmittedCount; }
            }
        });

        if (selectedLocalId !== "" && localTypes[selectedLocalId] != null) {
            rec.candidateType = normalizeCandidate(localTypes[selectedLocalId]);
        }
        if (rttS >= 0) { rec.rttMs = Math.round(rttS * 1000); }

        const jbAvgMs = jitterBufferAvgMs(VoiceMetrics.lastJb.get(entry.index), jbDelay, jbCount);
        if (jbDelay >= 0 && jbCount > 0) { VoiceMetrics.lastJb.set(entry.index, { delay: jbDelay, count: jbCount }); }
        if (rttS >= 0 && jbAvgMs >= 0) {
            rec.latRawMs = m2eEstimate(rttS, jbAvgMs);
            rec.latCalMs = VoiceMetrics.calibrated ? Math.round(rec.latRawMs + VoiceMetrics.calibrationMs) : -1;
        }
    }

    // ── sink access ───────────────────────────────────────────────────────────

    private static kpis(): KpiSummary {
        return summarizeKpis([...VoiceMetrics.links.values()], VoiceMetrics.calibrated);
    }

    /** Download the per-link records plus the KPI roll-up as JSON. */
    private static exportJson(): void {
        if (typeof document === "undefined") { return; }
        const payload = {
            exportedAt: new Date().toISOString(),
            calibrationMs: VoiceMetrics.calibrated ? VoiceMetrics.calibrationMs : null,
            deviceConstMs: DEVICE_CONST_MS,
            kpis: VoiceMetrics.kpis(),
            links: [...VoiceMetrics.links.values()],
        };
        const blob = new Blob([JSON.stringify(payload, null, 1)], { type: "application/json" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = "wsn-voice-" + Date.now() + ".json";
        document.body.appendChild(a);
        a.click();
        setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
    }
}
