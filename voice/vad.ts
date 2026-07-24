/**
 * Voice-activity detection (pure): short-window RMS plus a hysteresis state
 * machine. The RMS opens a "speaking" edge once it stays above the open
 * threshold for VAD_OPEN_MS, and closes it once it stays below the close
 * threshold for VAD_HANG_MS — the hang bridges brief mid-sentence pauses.
 */
export const VAD_OPEN_RMS = 0.06;    // rise above this for VAD_OPEN_MS → grab the slot; tuned for browser mic + Opus DTX
export const VAD_CLOSE_RMS = 0.035;  // fall below for VAD_HANG_MS → release (hysteresis prevents chatter)
export const VAD_OPEN_MS = 120;
export const VAD_HANG_MS = 700;      // bridge brief pauses mid-sentence
export const VAD_POLL_MS = 50;

/** RMS of a byte time-domain buffer (0..255, 128 = silence). */
export function rmsFromBytes(buf: Uint8Array): number {
    let sum = 0;
    for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v; }
    return buf.length > 0 ? Math.sqrt(sum / buf.length) : 0;
}

export interface VadState {
    active: boolean;   // currently holding the speaking slot
    hiMs: number;      // time accumulated above the open threshold
    loMs: number;      // time accumulated below the close threshold
}

export function newVadState(): VadState {
    return { active: false, hiMs: 0, loMs: 0 };
}

/**
 * Advance the hysteresis by one poll of `pollMs`. Returns the edge crossed —
 * "open" to acquire the slot, "close" to release it — or null for no change.
 */
export function stepVad(state: VadState, rms: number, pollMs: number): "open" | "close" | null {
    if (!state.active) {
        state.hiMs = rms >= VAD_OPEN_RMS ? state.hiMs + pollMs : 0;
        if (state.hiMs >= VAD_OPEN_MS) { state.active = true; state.loMs = 0; return "open"; }
    } else {
        state.loMs = rms < VAD_CLOSE_RMS ? state.loMs + pollMs : 0;
        if (state.loMs >= VAD_HANG_MS) { state.active = false; state.hiMs = 0; return "close"; }
    }
    return null;
}
