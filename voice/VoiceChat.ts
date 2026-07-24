/**
 * VoiceChat — Phase 1: push-to-talk mic → in-browser Whisper → public chat.
 *
 * Held mic button captures mono PCM; on release it downsamples to 16 kHz and
 * posts to a Whisper worker (transformers.js) that returns text, which goes to
 * chat. Whisper runs in a Web Worker so transcription never blocks the render
 * loop, and the worker is built from an inline Blob that loads transformers.js
 * from a CDN — deliberately bypassing the bundler, which cannot handle the ESM +
 * wasm + nested-worker shape. Retained as the predecessor that motivated the
 * Phase-2 WebRTC mesh; the PCM math lives in ./pcm so it can be tested.
 */
import { DebugFlags } from "../DebugFlags";

const TRANSFORMERS_CDN = "https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2";
const WHISPER_MODEL = "Xenova/whisper-tiny.en";

// Inline module-worker source, kept as a string so the bundler never processes
// it; created via a Blob URL below.
const WORKER_SOURCE = `
import { pipeline, env } from '${TRANSFORMERS_CDN}';
env.allowLocalModels = false;
env.backends.onnx.wasm.numThreads = 1;

const dbg = (msg, extra) => self.postMessage({ type: 'debug', msg, extra: extra == null ? null : extra });

let asr = null, loading = null;
async function getAsr() {
  if (asr) return asr;
  if (!loading) {
    loading = pipeline('automatic-speech-recognition', '${WHISPER_MODEL}', {
      quantized: true,
      progress_callback: (p) => self.postMessage({ type: 'progress', data: p }),
    });
  }
  asr = await loading;
  return asr;
}

// The PCM buffer is transferred across the thread boundary; these stats prove it
// arrived intact (a detached buffer reads len/peak 0) and is in Whisper's range.
function audioStats(a) {
  if (!a || !a.length) return { len: a ? a.length : 0, peak: 0, nonzero: 0 };
  let peak = 0, nz = 0;
  for (let i = 0; i < a.length; i++) { const m = a[i] < 0 ? -a[i] : a[i]; if (m > peak) peak = m; if (a[i] !== 0) nz++; }
  return { len: a.length, peak: +peak.toFixed(4), nonzero: nz };
}

self.onmessage = async (e) => {
  const m = e.data;
  if (m.type === 'preload') {
    try { await getAsr(); self.postMessage({ type: 'ready' }); }
    catch (err) { self.postMessage({ type: 'error', error: String((err && err.message) || err) }); }
    return;
  }
  if (m.type === 'transcribe') {
    try {
      const fn = await getAsr();
      dbg('audio received', audioStats(m.audio));
      const out = await fn(m.audio, { chunk_length_s: 30 });
      self.postMessage({ type: 'result', id: m.id, text: (out && out.text ? out.text : '').trim() });
    } catch (err) {
      self.postMessage({ type: 'error', id: m.id, error: String((err && (err.stack || err.message)) || err) });
    }
  }
};
`;

type TranscriptHandler = (text: string) => void;

export class VoiceChat {
    private static instance: VoiceChat | null = null;

    private onTranscript: TranscriptHandler;
    private worker: Worker | null = null;
    private modelReady = false;
    private button: HTMLButtonElement | null = null;
    private statusEl: HTMLDivElement | null = null;
    private visible = false;
    private lastProgressLogged = -10;

    private constructor(onTranscript: TranscriptHandler) {
        this.onTranscript = onTranscript;
    }

    private dbg(...args: any[]): void { if (DebugFlags.voice) { console.info("[voice]", ...args); } }

    /** Idempotent: builds the mic button + worker once. */
    static init(onTranscript: TranscriptHandler): VoiceChat | null {
        if (VoiceChat.instance != null) { return VoiceChat.instance; }
        if (typeof navigator === "undefined" || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            console.warn("[voice] getUserMedia unavailable (needs HTTPS) — voice chat disabled");
            return null;
        }
        const vc = new VoiceChat(onTranscript);
        try {
            vc.buildUi();
            vc.spawnWorker();
            VoiceChat.instance = vc;
        } catch (e) {
            console.error("[voice] init failed", e);
            return null;
        }
        return vc;
    }

    private spawnWorker(): void {
        const blob = new Blob([WORKER_SOURCE], { type: "application/javascript" });
        this.worker = new Worker(URL.createObjectURL(blob), { type: "module" });
        this.worker.onmessage = (e: MessageEvent) => this.onWorkerMessage(e.data);
        this.worker.onerror = (e) => {
            console.error("[voice] worker error", (e as any).message || e);
            this.setStatus("voice: worker error (see console)");
        };
    }

    private onWorkerMessage(msg: any): void {
        if (msg == null) { return; }
        if (msg.type === "progress") {
            if (msg.data && typeof msg.data.progress === "number" && msg.data.status === "progress") {
                const pct = Math.round(msg.data.progress);
                this.setStatus("loading model… " + pct + "%");
                if (pct >= this.lastProgressLogged + 10) { this.lastProgressLogged = pct; this.dbg("model download", pct + "%"); }
            }
        } else if (msg.type === "ready") {
            this.modelReady = true;
            this.setStatus("voice ready — hold to talk");
        } else if (msg.type === "debug") {
            this.dbg("worker:", msg.msg, msg.extra != null ? msg.extra : "");
        } else if (msg.type === "result") {
            const text: string = (msg.text || "").trim();
            this.setStatus(text ? "sent: " + text : "(no speech detected)");
            if (text && this.onTranscript) {
                try { this.onTranscript(text); } catch (e) { console.error("[voice] onTranscript failed", e); }
            }
            this.setButtonBusy(false);
        } else if (msg.type === "error") {
            console.error("[voice] transcription error:", msg.error);
            this.setStatus("voice error (see console)");
            this.setButtonBusy(false);
        }
    }

    // ── UI ──────────────────────────────────────────────────────────────────────

    private buildUi(): void {
        const btn = document.createElement("button");
        btn.textContent = "🎤";
        btn.title = "Hold to talk (voice → chat)";
        Object.assign(btn.style, {
            position: "fixed", right: "38%", bottom: "16px", width: "56px", height: "56px",
            borderRadius: "50%", border: "2px solid #2b2b2b", background: "#3a3a3a",
            color: "#fff", fontSize: "24px", cursor: "pointer", zIndex: "100000",
            userSelect: "none", touchAction: "none", boxShadow: "0 2px 8px rgba(0,0,0,.5)",
            display: "none",
        } as CSSStyleDeclaration);

        const status = document.createElement("div");
        Object.assign(status.style, {
            position: "fixed", right: "38%", bottom: "78px", maxWidth: "240px",
            padding: "4px 8px", borderRadius: "6px", background: "rgba(0,0,0,.7)",
            color: "#ddd", fontSize: "12px", fontFamily: "sans-serif", zIndex: "100000",
            pointerEvents: "none", display: "none",
        } as CSSStyleDeclaration);

        const down = (e: Event) => { e.preventDefault(); void this.startRecording(); };
        const up = (e: Event) => { e.preventDefault(); this.stopRecording(); };
        btn.addEventListener("pointerdown", down);
        btn.addEventListener("pointerup", up);
        btn.addEventListener("pointerleave", up);
        btn.addEventListener("pointercancel", up);

        document.body.appendChild(btn);
        document.body.appendChild(status);
        this.button = btn;
        this.statusEl = status;
    }

    /** Show/hide the mic UI (present only while in the game world). */
    static setVisible(visible: boolean): void {
        const vc = VoiceChat.instance;
        if (vc == null || vc.button == null || vc.visible === visible) { return; }
        vc.visible = visible;
        vc.button.style.display = visible ? "block" : "none";
        if (!visible && vc.statusEl) { vc.statusEl.style.display = "none"; }
    }

    private setStatus(text: string): void {
        if (!this.statusEl) { return; }
        this.statusEl.textContent = text;
        this.statusEl.style.display = "block";
    }

    private setButtonActive(active: boolean): void {
        if (this.button) { this.button.style.background = active ? "#b03030" : "#3a3a3a"; }
    }

    private setButtonBusy(busy: boolean): void {
        if (!this.button) { return; }
        this.button.disabled = busy;
        this.button.style.opacity = busy ? "0.6" : "1";
    }

    // Capture (startRecording / stopRecording) lands with the PCM helpers.
    private async startRecording(): Promise<void> { void this.modelReady; }
    private stopRecording(): void { this.setButtonActive(false); }
}
