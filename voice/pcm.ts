/**
 * PCM helpers for the push-to-talk capture path (pure). Concatenate the captured
 * frames, resample to Whisper's 16 kHz, and read peak amplitude for the
 * silent-buffer check — all plain array math, so they're testable off-thread.
 */

/** Concatenate captured Float32 frames into one contiguous buffer. */
export function flatten(chunks: Float32Array[]): Float32Array {
    let total = 0;
    for (const c of chunks) { total += c.length; }
    const out = new Float32Array(total);
    let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.length; }
    return out;
}

/** Linear-interpolation resample to a lower rate (good enough for ASR). */
export function downsample(input: Float32Array, inRate: number, outRate: number): Float32Array {
    if (inRate === outRate) { return input; }
    const ratio = inRate / outRate;
    const outLen = Math.floor(input.length / ratio);
    const out = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
        const pos = i * ratio;
        const i0 = Math.floor(pos);
        const i1 = Math.min(i0 + 1, input.length - 1);
        const frac = pos - i0;
        out[i] = input[i0] * (1 - frac) + input[i1] * frac;
    }
    return out;
}

/** Largest absolute sample — distinguishes silent capture from real audio. */
export function peakAmplitude(a: Float32Array): number {
    let peak = 0;
    for (let i = 0; i < a.length; i++) { const m = a[i] < 0 ? -a[i] : a[i]; if (m > peak) { peak = m; } }
    return peak;
}
