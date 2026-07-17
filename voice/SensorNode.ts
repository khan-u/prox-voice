/**
 * SensorNode — the WSN sensing layer for the proximity voice mesh.
 *
 * VoiceRTC models the game world as a MANET; this module makes each client a
 * sensor node on top of it. Three modalities: acoustic (VAD speech edges pushed
 * from VoiceRTC), position (tile coordinates, provider wired by Game), and link
 * quality (per-peer RTT / jitter / loss / uplink from getStats — the RSSI
 * stand-in). Reporting follows the DTX principle at the telemetry layer: a 2 s
 * sampler turns a sample into a report only on a significant event or a slow
 * heartbeat, and every suppressed sample is counted, so the suppression ratio is
 * itself a measured outcome. Like the radio, the sampler is duty-cycled — it runs
 * only while the mesh is up. The pure event/energy logic lives in ./sensing.
 */
import {
    PeerEntry, LinkReading, SenseReport,
    SAMPLE_MS, energyLevel, energySource, lossPct, upKbps,
} from "./sensing";

export class SensorNode {
    private static peersProvider: (() => PeerEntry[]) | null = null;
    private static timer: ReturnType<typeof setInterval> | null = null;
    private static sampling = false;            // getStats in flight — skip the tick
    private static reports: SenseReport[] = [];
    private static samples = 0;
    private static suppressed = 0;
    // Per-peer byte counters for uplink bitrate (previous sample, not reported).
    private static lastBytes: Map<number, { bytes: number; t: number }> = new Map();
    // Most recent sample's readings — feeds the election cost metric between reports.
    private static lastSampleLinks: LinkReading[] = [];

    // ── energy modality (HEED's primary parameter) ────────────────────────────
    // Priority: forced (experiments) > real battery > virtual byte budget.
    private static energyForced: number | null = null;
    private static batteryLevel: number | null = null;
    private static batteryHooked = false;
    private static totalBytesSent = 0;

    static wirePeers(provider: () => PeerEntry[]): void {
        SensorNode.peersProvider = provider;
    }

    // ── duty cycle (driven by VoiceRTC alongside the radio) ───────────────────

    static start(): void {
        if (SensorNode.timer != null || typeof window === "undefined") { return; }
        SensorNode.timer = setInterval(() => void SensorNode.sample(), SAMPLE_MS);
        SensorNode.hookBattery();
        (window as any).wsnSense = {
            stats: () => SensorNode.statsSnapshot(),
            dump: () => SensorNode.reports.slice(),
            export: () => SensorNode.exportJson(),
            energy: () => ({ level: SensorNode.energyLevel(), source: SensorNode.energySource() }),
            setEnergy: (v: number | null) => { SensorNode.energyForced = v; },
        };
    }

    static stop(): void {
        if (SensorNode.timer == null) { return; }
        clearInterval(SensorNode.timer);
        SensorNode.timer = null;
    }

    static isRunning(): boolean {
        return SensorNode.timer != null;
    }

    // ── energy readings ───────────────────────────────────────────────────────

    private static hookBattery(): void {
        if (SensorNode.batteryHooked || typeof navigator === "undefined") { return; }
        SensorNode.batteryHooked = true;
        const getBattery = (navigator as any).getBattery;
        if (typeof getBattery !== "function") { return; }   // Safari/Firefox → virtual model
        try {
            getBattery.call(navigator).then((b: any) => {
                SensorNode.batteryLevel = b.level;
                b.addEventListener("levelchange", () => { SensorNode.batteryLevel = b.level; });
            }).catch(() => {});
        } catch { /* getBattery threw synchronously */ }
    }

    static energyLevel(): number {
        return energyLevel(SensorNode.energyForced, SensorNode.batteryLevel, SensorNode.totalBytesSent);
    }

    static energySource(): string {
        return energySource(SensorNode.energyForced, SensorNode.batteryLevel);
    }

    /** Mean RTT across current links (ms) — the election's cost metric (HEED's
     *  AMRP stand-in). -1 when no link has reported RTT yet. */
    static avgLinkRttMs(): number {
        let sum = 0, n = 0;
        for (const r of SensorNode.lastSampleLinks) {
            if (r.rttMs >= 0) { sum += r.rttMs; n++; }
        }
        return n > 0 ? Math.round(sum / n) : -1;
    }

    // ── the sampler ───────────────────────────────────────────────────────────
    private static async sample(): Promise<void> {
        if (SensorNode.sampling) { return; }
        SensorNode.sampling = true;
        try {
            SensorNode.samples++;
            await SensorNode.readLinks();
        } catch {
            // A closing peer connection can reject getStats mid-teardown; drop it.
        } finally {
            SensorNode.sampling = false;
        }
    }

    /** Read every neighbour's link-quality modality from getStats. */
    private static async readLinks(): Promise<LinkReading[]> {
        const peers = SensorNode.peersProvider ? SensorNode.peersProvider() : [];
        const out: LinkReading[] = [];
        const seen = new Set<number>();
        for (const entry of peers) {
            seen.add(entry.index);
            const reading: LinkReading = {
                index: entry.index, state: entry.pc.connectionState,
                rttMs: -1, jitterMs: -1, lossPct: -1, upKbps: -1,
            };
            try {
                const stats = await entry.pc.getStats();
                let lost = 0, received = 0, bytesSent = 0;
                stats.forEach((s: any) => {
                    if (s.type === "candidate-pair" && s.state === "succeeded" &&
                        (s.nominated === true || s.selected === true) &&
                        typeof s.currentRoundTripTime === "number") {
                        reading.rttMs = Math.round(s.currentRoundTripTime * 1000);
                    }
                    if (s.type === "inbound-rtp" && s.kind === "audio") {
                        if (typeof s.jitter === "number") { reading.jitterMs = Math.round(s.jitter * 1000); }
                        if (typeof s.packetsLost === "number") { lost = s.packetsLost; }
                        if (typeof s.packetsReceived === "number") { received = s.packetsReceived; }
                    }
                    if (s.type === "outbound-rtp" && s.kind === "audio" &&
                        typeof s.bytesSent === "number") {
                        bytesSent = s.bytesSent;
                    }
                });
                reading.lossPct = lossPct(lost, received);
                const now = Date.now();
                const prev = SensorNode.lastBytes.get(entry.index);
                if (prev != null && bytesSent >= prev.bytes) {
                    reading.upKbps = upKbps(bytesSent - prev.bytes, now - prev.t);
                    SensorNode.totalBytesSent += bytesSent - prev.bytes;   // virtual energy debit
                }
                SensorNode.lastBytes.set(entry.index, { bytes: bytesSent, t: now });
            } catch { /* closed mid-sample — keep the state-only reading */ }
            out.push(reading);
        }
        // Forget byte counters for departed peers so a reused index starts clean.
        for (const idx of SensorNode.lastBytes.keys()) {
            if (!seen.has(idx)) { SensorNode.lastBytes.delete(idx); }
        }
        SensorNode.lastSampleLinks = out;
        return out;
    }

    // ── sink access ───────────────────────────────────────────────────────────

    static statsSnapshot(): { samples: number; reports: number; suppressedPct: number } {
        const total = SensorNode.samples;
        return {
            samples: total,
            reports: SensorNode.reports.length,
            suppressedPct: total > 0 ? Math.round((SensorNode.suppressed * 100) / total) : 0,
        };
    }

    /** Download the sink buffer as JSON — the experiment data-collection path. */
    static exportJson(): void {
        if (typeof document === "undefined") { return; }
        const payload = {
            exportedAt: new Date().toISOString(),
            counters: { samples: SensorNode.samples, suppressed: SensorNode.suppressed },
            reports: SensorNode.reports,
        };
        const blob = new Blob([JSON.stringify(payload, null, 1)], { type: "application/json" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = "wsn-sense-" + Date.now() + ".json";
        document.body.appendChild(a);
        a.click();
        setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
    }
}
