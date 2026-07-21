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
import { shouldIgnoreOffer } from "./glare";

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

    private localStream: MediaStream | null = null;
    private gettingStream: Promise<MediaStream | null> | null = null;
    private micMuted = false;
    // In-flight ensurePeer() promises, keyed by index, so the proximity tick and
    // an inbound offer share one promise and exactly one connection is created.
    private ensuring: Map<number, Promise<Peer | null>> = new Map();

    // STUN discovers each node's server-reflexive candidate; TURN is the
    // multi-hop store-and-forward fallback for symmetric-NAT pairs. The live
    // config (short-lived TURN creds) is fetched once from /api/turn, so the
    // secret token never ships in the client and any failure keeps STUN.
    private static ICE: RTCConfiguration = {
        iceServers: [
            { urls: "stun:stun.l.google.com:19302" },
            { urls: "stun:stun.cloudflare.com:3478" },
        ],
    };
    private static iceFetched = false;
    private static iceFetching: Promise<void> | null = null;

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
        void VoiceRTC.ensureIce();   // warm the TURN credentials before the first neighbour

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
                rxAudio: () => rtc.rxAudio(),
                linkDebug: () => rtc.linkDebug(),
            };
        }
        rtc.dbg("init (nonce=" + rtc.nonce + ", voice OFF by default)");
        return rtc;
    }

    static get(): VoiceRTC | null { return VoiceRTC.instance; }

    private dbg(...a: any[]): void { if ((DebugFlags as any).voice) { console.info("[rtc]", ...a); } }

    /** Pull the live ICE config (TURN creds) from /api/turn once, replacing the
     *  STUN-only default. Best-effort: any failure keeps the STUN fallback. */
    private static ensureIce(): Promise<void> {
        if (VoiceRTC.iceFetched) { return Promise.resolve(); }
        if (VoiceRTC.iceFetching) { return VoiceRTC.iceFetching; }
        VoiceRTC.iceFetching = (async () => {
            try {
                const res = await fetch("/api/turn", { cache: "no-store" });
                const j = await res.json();
                if (j && Array.isArray(j.iceServers) && j.iceServers.length > 0) {
                    // Forced-relay routes every link through TURN even when a direct
                    // path exists, to isolate the relay hop's cost.
                    let forceRelay = !!(window as any).wsnForceRelay;
                    if (readParam("wsnforcerelay") === "1") { forceRelay = true; }
                    VoiceRTC.ICE = { iceServers: j.iceServers, iceTransportPolicy: forceRelay ? "relay" : "all" };
                }
            } catch { /* keep STUN fallback */ }
            finally { VoiceRTC.iceFetched = true; VoiceRTC.iceFetching = null; }
        })();
        return VoiceRTC.iceFetching;
    }

    // ── mic: one capture, fanned to every peer (the node's radio) ─────────────

    private async getLocalStream(): Promise<MediaStream | null> {
        if (this.localStream) { return this.localStream; }
        if (this.gettingStream) { return this.gettingStream; }
        this.gettingStream = (async () => {
            try {
                const s = await navigator.mediaDevices.getUserMedia({
                    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
                    video: false,
                });
                this.localStream = s;
                this.applyMuteState();
                this.dbg("local mic acquired");
                return s;
            } catch (e) {
                console.error("[rtc] getUserMedia failed", e);
                return null;
            } finally { this.gettingStream = null; }
        })();
        return this.gettingStream;
    }

    setMuted(muted: boolean): void { this.micMuted = muted; this.applyMuteState(); }
    isMuted(): boolean { return this.micMuted; }

    private applyMuteState(): void {
        if (this.localStream) {
            for (const t of this.localStream.getAudioTracks()) { t.enabled = !this.micMuted; }
        }
    }

    // ── peer creation ──────────────────────────────────────────────────────────

    /** Get-or-create the peer for `index`, deduped across concurrent callers. */
    private ensurePeer(index: number): Promise<Peer | null> {
        const existing = this.peers.get(index);
        if (existing) { return Promise.resolve(existing); }
        const inflight = this.ensuring.get(index);
        if (inflight) { return inflight; }
        const p = this.createPeer(index).finally(() => this.ensuring.delete(index));
        this.ensuring.set(index, p);
        return p;
    }

    private async createPeer(index: number): Promise<Peer | null> {
        const existing = this.peers.get(index);
        if (existing) { return existing; }
        const stream = await this.getLocalStream();
        if (!stream) { return null; }
        await VoiceRTC.ensureIce();   // live TURN creds (STUN fallback if unavailable)

        const pc = new RTCPeerConnection(VoiceRTC.ICE);
        const peer: Peer = {
            index, pc, audioEl: null, makingOffer: false, ignoreOffer: false,
            remoteNonce: -1, remoteSet: false, pendingIce: [], bornMs: Date.now(),
            everConnected: false, iceRestarted: false, graceUntil: 0,
        };
        this.peers.set(index, peer);

        for (const track of stream.getAudioTracks()) { pc.addTrack(track, stream); }

        pc.onicecandidate = (ev) => {
            if (ev.candidate) { this.sendSignal(index, JSON.stringify({ k: "ice", cand: ev.candidate.toJSON() })); }
        };
        pc.ontrack = (ev) => {
            this.dbg("remote track from", index);
            this.attachRemoteAudio(peer, ev.streams[0] || new MediaStream([ev.track]));
        };
        pc.onnegotiationneeded = async () => { try { await this.makeOffer(peer); } catch (e) { this.dbg("negneeded err", e); } };
        pc.onconnectionstatechange = () => {
            const st = pc.connectionState;
            this.dbg("peer", index, "state:", st);
            VoiceMetrics.markState(index, st);      // setup-time / ICE-success record
            SensorNode.recordLinkState(index, st);  // precise link-event edge
            if (st === "connected") { peer.everConnected = true; }
            if (st === "failed" || st === "closed") { this.closePeer(index, false); }
        };
        return peer;
    }

    private async makeOffer(peer: Peer): Promise<void> {
        try {
            peer.makingOffer = true;
            await peer.pc.setLocalDescription();   // implicit createOffer
            this.sendSignal(peer.index, JSON.stringify({ k: "offer", sdp: peer.pc.localDescription, nonce: this.nonce }));
            this.dbg("→ offer to", peer.index);
        } catch (e) {
            this.dbg("makeOffer failed", e);
        } finally { peer.makingOffer = false; }
    }

    private attachRemoteAudio(peer: Peer, stream: MediaStream): void {
        if (!peer.audioEl) {
            const el = document.createElement("audio");
            el.autoplay = true;
            (el as any).playsInline = true;   // iOS: stay inline
            el.style.display = "none";
            document.body.appendChild(el);
            peer.audioEl = el;
        }
        peer.audioEl.srcObject = stream;
        const p = peer.audioEl.play();
        if (p && (p as any).catch) { (p as Promise<void>).catch(() => {}); }
    }

    // ── inbound signalling (perfect negotiation) ─────────────────────────────

    async onSignal(fromIndex: number, json: string): Promise<void> {
        if (!this.enabled) { return; }
        let msg: any;
        try { msg = JSON.parse(json); } catch { return; }
        if (msg.k === "bye") { this.closePeer(fromIndex, false); return; }

        const peer = await this.ensurePeer(fromIndex);
        if (!peer) { return; }

        try {
            if (msg.k === "offer" || msg.k === "answer") {
                if (typeof msg.nonce === "number") { peer.remoteNonce = msg.nonce >>> 0; }
                if (msg.k === "offer") {
                    peer.ignoreOffer = shouldIgnoreOffer(this.nonce, peer.remoteNonce, peer.makingOffer, peer.pc.signalingState);
                    if (peer.ignoreOffer) { VoiceMetrics.markGlare(fromIndex); this.dbg("glare with", fromIndex, "→ ignore (impolite)"); return; }
                    // setRemoteDescription does an implicit rollback when polite and
                    // in have-local-offer (modern WebRTC).
                    await peer.pc.setRemoteDescription(msg.sdp);
                    peer.remoteSet = true;
                    await this.flushIce(peer);
                    await peer.pc.setLocalDescription();   // implicit createAnswer
                    this.sendSignal(fromIndex, JSON.stringify({ k: "answer", sdp: peer.pc.localDescription, nonce: this.nonce }));
                    this.dbg("→ answer to", fromIndex);
                } else {
                    await peer.pc.setRemoteDescription(msg.sdp);
                    peer.remoteSet = true;
                    await this.flushIce(peer);
                }
            } else if (msg.k === "ice" && msg.cand) {
                if (peer.remoteSet) {
                    try { await peer.pc.addIceCandidate(msg.cand); }
                    catch (e) { if (!peer.ignoreOffer) { this.dbg("addIce err", e); } }
                } else {
                    peer.pendingIce.push(msg.cand);
                }
            }
        } catch (e) { this.dbg("onSignal error from", fromIndex, e); }
    }

    private async flushIce(peer: Peer): Promise<void> {
        const buffered = peer.pendingIce; peer.pendingIce = [];
        for (const c of buffered) { try { await peer.pc.addIceCandidate(c); } catch (e) { this.dbg("flushIce err", e); } }
    }

    // ── harness probes over the live peers (read-only) ────────────────────────

    /** Total inbound audio packets + emitted samples + loudest level across
     *  peers — the packet-arrival signal the audio-gap/grace drivers key on. */
    private async rxAudio(): Promise<{ pkts: number; samples: number; level: number }> {
        let pkts = 0, samples = 0, level = 0;
        for (const peer of this.peers.values()) {
            try {
                const stats = await peer.pc.getStats();
                stats.forEach((s: any) => {
                    if (s.type === "inbound-rtp" && s.kind === "audio") {
                        if (typeof s.packetsReceived === "number") { pkts += s.packetsReceived; }
                        if (typeof s.jitterBufferEmittedCount === "number") { samples += s.jitterBufferEmittedCount; }
                        if (typeof s.audioLevel === "number") { level = Math.max(level, s.audioLevel); }
                    }
                });
            } catch { /* pc closing — skip */ }
        }
        return { pkts, samples, level };
    }

    /** Per-peer connection forensics: distinguishes a never-connected wedge from
     *  a connected-but-silent one without guessing from sample counts. */
    private async linkDebug(): Promise<any[]> {
        const out: any[] = [];
        for (const peer of this.peers.values()) {
            const d: any = {
                index: peer.index, conn: peer.pc.connectionState, sig: peer.pc.signalingState,
                ice: peer.pc.iceConnectionState, makingOffer: peer.makingOffer,
                everConnected: peer.everConnected, outBytes: -1, inPkts: -1,
            };
            try {
                const stats = await peer.pc.getStats();
                stats.forEach((s: any) => {
                    if (s.type === "outbound-rtp" && s.kind === "audio" && typeof s.bytesSent === "number") { d.outBytes = s.bytesSent; }
                    if (s.type === "inbound-rtp" && s.kind === "audio" && typeof s.packetsReceived === "number") { d.inPkts = s.packetsReceived; }
                });
            } catch { /* pc closing */ }
            out.push(d);
        }
        return out;
    }

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
