/**
 * Audio fixture generator for PROX-VOICE experiment harnesses.
 *
 * Produces two WAV assets used across multiple experiments:
 *   - tone sweep   (audiogap, silentprobe, wedgetest): AM'd triangle sweep that
 *                   keeps the Opus encoder transmitting for the full 180 s run.
 *   - speech pattern (sensing, dtxtest):  2.4 s bursts / 2.2 s silence that
 *                   mimics a conversational turn-taking cadence for DTX testing.
 *
 * Helpers: writePcm16Wav (bare PCM16 WAV encoder) is exported so test harnesses
 * can also write short calibration fixtures without pulling in the full generator.
 *
 * All output is mono 48 kHz PCM16 — the format Chromium's fake-audio-capture
 * device requires.
 */
const fs   = require("fs");
const path = require("path");

const SR = 48000;   // sample rate expected by Chromium's fake audio capture

/**
 * Write a mono or multi-channel PCM16 WAV file. `samples` is a Float32Array
 * (or plain array) of interleaved floats in [-1, 1]; values are clamped before
 * encoding.
 */
function writePcm16Wav(filePath, samples, sampleRate, channels) {
    const n        = samples.length;
    const dataSize = n * 2;   // PCM16 = 2 bytes per sample
    const buf      = Buffer.alloc(44 + dataSize);

    buf.write("RIFF", 0);
    buf.writeUInt32LE(36 + dataSize, 4);
    buf.write("WAVE", 8);
    buf.write("fmt ",   12);
    buf.writeUInt32LE(16,                 16);   // fmt chunk size
    buf.writeUInt16LE(1,                  20);   // PCM
    buf.writeUInt16LE(channels,           22);
    buf.writeUInt32LE(sampleRate,         24);
    buf.writeUInt32LE(sampleRate * channels * 2, 28);   // byteRate
    buf.writeUInt16LE(channels * 2,       32);   // blockAlign
    buf.writeUInt16LE(16,                 34);   // bitsPerSample
    buf.write("data", 36);
    buf.writeUInt32LE(dataSize,           40);

    for (let i = 0; i < n; i++) {
        const v = Math.max(-1, Math.min(1, samples[i]));
        buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
    }
    fs.writeFileSync(filePath, buf);
}

/**
 * Generate (once) a 180 s mono 48 kHz AM'd triangle sweep and write it to
 * `filePath`. Skips generation if the file already exists.
 *
 * The sweep ramps from 600 Hz to 1800 Hz over 180 s so the spectral content
 * stays well within the Opus codec's voice band and away from the 2 kHz rig
 * stimulus. The 2 Hz amplitude modulation keeps the envelope time-varying,
 * which prevents Opus from switching into DTX even during long silences in the
 * rest of the scenario.
 */
function ensureToneWav(filePath) {
    if (fs.existsSync(filePath)) return;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });

    const N       = SR * 180;
    const samples = new Float32Array(N);
    let phase = 0;
    for (let i = 0; i < N; i++) {
        const t    = i / SR;
        const freq = 600 + 1200 * (t / 180);           // linear sweep 600→1800 Hz
        phase     += (2 * Math.PI * freq) / SR;
        const tri  = (2 / Math.PI) * Math.asin(Math.sin(phase));   // triangle
        const am   = 0.5 + 0.5 * Math.cos(2 * Math.PI * 2 * t);   // 2 Hz AM
        samples[i] = 0.7 * am * tri;
    }
    writePcm16Wav(filePath, samples, SR, 1);
}

/**
 * Generate (once) a 180 s mono 48 kHz speech-pattern WAV and write it to
 * `filePath`. Skips generation if the file already exists.
 *
 * Alternates 2.4 s of 440 Hz tone (speech-like burst) with 2.2 s of silence
 * so the DTX encoder sees a realistic duty cycle and conversational harnesses
 * have something to feed getUserMedia with during the "speaking" windows.
 */
function ensureSpeechWav(filePath) {
    if (fs.existsSync(filePath)) return;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });

    const N         = SR * 180;
    const samples   = new Float32Array(N);
    const BURST_S   = 2.4;
    const SILENCE_S = 2.2;
    const PERIOD_S  = BURST_S + SILENCE_S;
    let phase = 0;
    for (let i = 0; i < N; i++) {
        const tInPeriod = (i / SR) % PERIOD_S;
        if (tInPeriod < BURST_S) {
            phase    += (2 * Math.PI * 440) / SR;
            samples[i] = 0.6 * Math.sin(phase);
        } else {
            phase      = 0;
            samples[i] = 0;
        }
    }
    writePcm16Wav(filePath, samples, SR, 1);
}

module.exports = { writePcm16Wav, ensureToneWav, ensureSpeechWav, SR };
