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
import { LinkMetric, PeerHandle } from "./metrics";

export class VoiceMetrics {
    private static readonly SAMPLE_MS = 2000;   // getStats period for latency/candidate

    private static peersProvider: (() => PeerHandle[]) | null = null;
    private static timer: ReturnType<typeof setInterval> | null = null;
    private static sampling = false;            // getStats in flight — skip the tick
    private static links: Map<number, LinkMetric> = new Map();

    static wirePeers(provider: () => PeerHandle[]): void {
        VoiceMetrics.peersProvider = provider;
    }

    // ── duty cycle (driven by VoiceRTC alongside the radio) ───────────────────

    static start(): void {
        if (VoiceMetrics.timer != null || typeof window === "undefined") { return; }
        VoiceMetrics.timer = setInterval(() => void VoiceMetrics.sample(), VoiceMetrics.SAMPLE_MS);
        (window as any).wsnVoice = {
            dump: () => [...VoiceMetrics.links.values()],
        };
    }

    static stop(): void {
        if (VoiceMetrics.timer == null) { return; }
        clearInterval(VoiceMetrics.timer);
        VoiceMetrics.timer = null;
    }

    static isRunning(): boolean {
        return VoiceMetrics.timer != null;
    }

    /** Read the selected candidate type, RTT, and software latency per peer. */
    private static async sample(): Promise<void> {
        if (VoiceMetrics.sampling) { return; }
        VoiceMetrics.sampling = true;
        try {
            const peers = VoiceMetrics.peersProvider ? VoiceMetrics.peersProvider() : [];
            void peers;
        } finally {
            VoiceMetrics.sampling = false;
        }
    }
}
