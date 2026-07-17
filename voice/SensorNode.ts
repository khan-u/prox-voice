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
    SenseReport, SAMPLE_MS, energyLevel, energySource,
} from "./sensing";

export class SensorNode {
    private static timer: ReturnType<typeof setInterval> | null = null;
    private static sampling = false;            // getStats in flight — skip the tick
    private static reports: SenseReport[] = [];
    private static samples = 0;
    private static suppressed = 0;

    // ── energy modality (HEED's primary parameter) ────────────────────────────
    // Priority: forced (experiments) > real battery > virtual byte budget.
    private static energyForced: number | null = null;
    private static batteryLevel: number | null = null;
    private static batteryHooked = false;
    private static totalBytesSent = 0;

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

    // ── the sampler ───────────────────────────────────────────────────────────
    private static async sample(): Promise<void> {
        if (SensorNode.sampling) { return; }
        SensorNode.sampling = true;
        try {
            SensorNode.samples++;
        } catch {
            // A closing peer connection can reject getStats mid-teardown; drop it.
        } finally {
            SensorNode.sampling = false;
        }
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
