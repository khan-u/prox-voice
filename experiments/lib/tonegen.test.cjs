/**
 * node:test unit checks for tonegen.cjs.
 * Run: node --test experiments/lib/tonegen.test.cjs
 */
const { test } = require("node:test");
const assert   = require("node:assert/strict");
const fs       = require("fs");
const os       = require("os");
const path     = require("path");
const { writePcm16Wav, ensureToneWav, ensureSpeechWav, SR } = require("./tonegen.cjs");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "prox-voice-tonegen-"));

test("SR is 48000", () => {
    assert.equal(SR, 48000);
});

test("writePcm16Wav creates a valid RIFF/WAVE file", () => {
    const p       = path.join(TMP, "short.wav");
    const samples = new Float32Array(480);   // 10 ms of silence
    writePcm16Wav(p, samples, 48000, 1);

    const buf = fs.readFileSync(p);
    assert.equal(buf.slice(0,  4).toString(), "RIFF");
    assert.equal(buf.slice(8, 12).toString(), "WAVE");
    assert.equal(buf.slice(12, 16).toString(), "fmt ");
    assert.equal(buf.slice(36, 40).toString(), "data");
    assert.equal(buf.readUInt16LE(20), 1);       // PCM
    assert.equal(buf.readUInt16LE(22), 1);       // mono
    assert.equal(buf.readUInt32LE(24), 48000);   // sample rate
    assert.equal(buf.readUInt16LE(34), 16);      // bits per sample
    assert.equal(buf.readUInt32LE(40), 480 * 2); // data size
    assert.equal(buf.length, 44 + 480 * 2);
});

test("writePcm16Wav clamps samples to [-1, 1] before encoding", () => {
    const p       = path.join(TMP, "clamp.wav");
    const samples = [2.0, -2.0, 1.0, -1.0];
    writePcm16Wav(p, samples, 48000, 1);
    const buf = fs.readFileSync(p);
    assert.equal(buf.readInt16LE(44), 32767);    // 2.0 clamped
    assert.equal(buf.readInt16LE(46), -32767);   // -2.0 clamped
});

test("ensureToneWav creates a 180-s mono 48 kHz WAV", () => {
    const p = path.join(TMP, "tone.wav");
    ensureToneWav(p);
    assert.ok(fs.existsSync(p));
    const buf = fs.readFileSync(p);
    assert.equal(buf.readUInt32LE(40), SR * 180 * 2);   // 180 s of PCM16
    assert.equal(buf.readUInt16LE(22), 1);               // mono
});

test("ensureToneWav skips generation when the file already exists", () => {
    const p = path.join(TMP, "tone-skip.wav");
    fs.writeFileSync(p, "sentinel");
    ensureToneWav(p);
    assert.equal(fs.readFileSync(p, "utf8"), "sentinel");
});

test("ensureSpeechWav creates a 180-s mono 48 kHz WAV", () => {
    const p = path.join(TMP, "speech.wav");
    ensureSpeechWav(p);
    assert.ok(fs.existsSync(p));
    const buf = fs.readFileSync(p);
    assert.equal(buf.readUInt32LE(40), SR * 180 * 2);   // 180 s of PCM16
    assert.equal(buf.readUInt16LE(22), 1);               // mono
});

test("ensureSpeechWav skips generation when the file already exists", () => {
    const p = path.join(TMP, "speech-skip.wav");
    fs.writeFileSync(p, "sentinel");
    ensureSpeechWav(p);
    assert.equal(fs.readFileSync(p, "utf8"), "sentinel");
});
