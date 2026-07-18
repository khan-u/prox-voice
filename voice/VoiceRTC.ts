/**
 * VoiceRTC — proximity ad-hoc P2P voice mesh (the raw-audio channel).
 *
 * The game world is treated as a MANET: each logged-in player is a node, the
 * in-world proximity radius is the transmission range, and players walking makes
 * neighbourhoods form and dissolve. Audio is a direct WebRTC Opus/SRTP link
 * (infrastructure-free); the signalling server is a pure control-plane gateway that
 * relays SDP/ICE and never carries audio.
 *
 * A client does not know its own server index, so the mesh cannot use
 * "lower index initiates". Instead every client draws a random `nonce` at
 * startup and both peers may offer at once; on an offer/offer glare the lower
 * nonce is polite and yields (WebRTC perfect negotiation). No coordinator, no
 * identity — pure self-organisation.
 *
 * Signalling wire (relayed by the server gateway): the JSON blob is one of
 * {k:'offer'|'answer', sdp, nonce} | {k:'ice', cand} | {k:'bye'}.
 */
import { DebugFlags } from "../DebugFlags";
import { VoiceMetrics } from "./VoiceMetrics";
import { SensorNode } from "./SensorNode";

/** Sends one signalling blob to a target player via the server gateway. */
export type RtcSignalSender = (targetIndex: number, json: string) => void;

interface Peer {
    index: number;                      // remote player's server index (node id)
    pc: RTCPeerConnection;
    audioEl: HTMLAudioElement | null;
    makingOffer: boolean;               // perfect-negotiation guard
    ignoreOffer: boolean;
    remoteNonce: number;                // their tie-break value (-1 until known)
    remoteSet: boolean;                 // remoteDescription applied yet?
    pendingIce: RTCIceCandidateInit[];  // ICE buffered until remote desc set
    bornMs: number;                     // creation time — watchdog baseline
    everConnected: boolean;             // has connectionState ever hit "connected"?
    iceRestarted: boolean;              // tier-1 recovery (restartIce) used once
    graceUntil: number;                 // >0: out of range but held warm until this ms
}

export class VoiceRTC {
    private static instance: VoiceRTC | null = null;

    private sendSignal: RtcSignalSender;
    private nonce: number;               // our perfect-negotiation tie-break
    private peers: Map<number, Peer> = new Map();
    private enabled = false;             // proximity voice is off until turned on

    // Teardown grace window W (ms): on range-exit, hold the peer warm for W and
    // resume on return with no ICE rebuild; W=0 is the on-demand default. Set via
    // ?wsngrace= or wsnVoiceCtl.setGrace(ms).
    private graceMs: number = readIntParam("wsngrace", 0);
    // Opus DTX: usedtx=1 munged into the SDP so the encoder falls silent between
    // utterances (event-driven transmission). Set via ?wsndtx=1 or setDtx(true).
    private dtxOn: boolean = readParam("wsndtx") === "1";

    private constructor(sendSignal: RtcSignalSender) {
        this.sendSignal = sendSignal;
        // High-entropy tie-break for glare resolution; not security-sensitive.
        this.nonce = (Math.floor(Math.random() * 0x7fffffff) ^ (Date.now() & 0xffff)) >>> 0;
    }

    static supported(): boolean {
        return typeof window !== "undefined" &&
            typeof (window as any).RTCPeerConnection !== "undefined" &&
            typeof navigator !== "undefined" && !!navigator.mediaDevices &&
            !!navigator.mediaDevices.getUserMedia;
    }

    static init(sendSignal: RtcSignalSender): VoiceRTC | null {
        if (VoiceRTC.instance) { VoiceRTC.instance.sendSignal = sendSignal; return VoiceRTC.instance; }
        if (!VoiceRTC.supported()) {
            const insecure = typeof window !== "undefined" && (window as any).isSecureContext === false;
            console.error("[rtc] proximity voice DISABLED — " +
                (insecure ? "insecure context: getUserMedia is blocked off HTTPS." : "this browser lacks WebRTC/getUserMedia."));
            return null;
        }
        const rtc = new VoiceRTC(sendSignal);
        VoiceRTC.instance = rtc;

        // Instrumentation is duty-cycled with the mesh and reads only getStats /
        // lifecycle edges, never the negotiation path.
        VoiceMetrics.wirePeers(() => [...rtc.peers.values()]);
        VoiceMetrics.start();
        SensorNode.wirePeers(() => [...rtc.peers.values()].map((p) => ({ index: p.index, pc: p.pc })));

        if (typeof window !== "undefined") {
            (window as any).wsnVoiceCtl = {
                enable: () => rtc.setEnabled(true),
                disable: () => rtc.setEnabled(false),
                enabled: () => rtc.isEnabled(),
                peers: () => rtc.peerCount(),
                peerIndices: () => [...rtc.peers.keys()],
                setGrace: (ms: number) => { rtc.graceMs = Math.max(0, ms | 0); },
                grace: () => rtc.graceMs,
                setDtx: (on: boolean) => { rtc.dtxOn = !!on; },
                dtx: () => rtc.dtxOn,
                audioLatency: () => measureAudioLatency(),
            };
        }
        rtc.dbg("init (nonce=" + rtc.nonce + ", voice OFF by default)");
        return rtc;
    }

    static get(): VoiceRTC | null { return VoiceRTC.instance; }

    private dbg(...a: any[]): void { if ((DebugFlags as any).voice) { console.info("[rtc]", ...a); } }

    // ── controls ──────────────────────────────────────────────────────────────

    setEnabled(on: boolean): void {
        if (this.enabled === on) { return; }
        this.enabled = on;
        if (on) { SensorNode.start(); }   // sensing duty-cycles with the radio
        else { this.shutdown(); }         // closes peers + stops the sensors
        this.dbg("proximity voice", on ? "ENABLED" : "DISABLED");
    }

    isEnabled(): boolean { return this.enabled; }
    peerCount(): number { return this.peers.size; }

    shutdown(): void {
        SensorNode.stop();   // node sleeps with the radio (flushes a final report)
        for (const idx of [...this.peers.keys()]) { this.closePeer(idx, true); }
    }

    /** Tear a peer down, optionally sending a bye so the remote half drops too. */
    private closePeer(index: number, sendBye: boolean): void {
        const peer = this.peers.get(index);
        if (!peer) { return; }
        if (sendBye) { try { this.sendSignal(index, JSON.stringify({ k: "bye" })); } catch { /* closing */ } }
        try { peer.pc.ontrack = null; peer.pc.onicecandidate = null; peer.pc.close(); } catch { /* already closed */ }
        if (peer.audioEl) { try { peer.audioEl.srcObject = null; peer.audioEl.remove(); } catch { /* detached */ } }
        this.peers.delete(index);
    }
}

// ── module-local helpers ──────────────────────────────────────────────────────

function readParam(name: string): string | null {
    try { return new URLSearchParams(window.location.search).get(name); }
    catch { return null; }
}

function readIntParam(name: string, fallback: number): number {
    const v = parseInt(readParam(name) || "", 10);
    return isNaN(v) ? fallback : Math.max(0, v);
}

/** Audio-stack latency probe (baseLatency + outputLatency) for the constructed
 *  device constant C. Standalone — creates and closes its own AudioContext. */
async function measureAudioLatency(): Promise<{ baseLatencyMs: number; outputLatencyMs: number; sampleRate: number } | null> {
    const AC: any = (window as any).AudioContext || (window as any).webkitAudioContext;
    if (!AC) { return null; }
    const ctx = new AC();
    try { await ctx.resume(); } catch { /* already running */ }
    await new Promise((r) => setTimeout(r, 150));   // let outputLatency settle
    const out = {
        baseLatencyMs: Math.round((ctx.baseLatency || 0) * 1000 * 10) / 10,
        outputLatencyMs: Math.round((ctx.outputLatency || 0) * 1000 * 10) / 10,
        sampleRate: ctx.sampleRate,
    };
    try { void ctx.close(); } catch { /* already closed */ }
    return out;
}
