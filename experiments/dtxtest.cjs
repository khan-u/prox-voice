/**
 * DTX uplink harness — media-plane event-driven transmission lever.
 *
 * Measures outbound uplink bandwidth for source × DTX combinations:
 *   source: tone (continuous) or speech (burst/silence)
 *   dtx:    0 (DTX off) or 1 (DTX on, Opus discontinuous transmission)
 *
 * DTX is set via the ?wsndtx= URL query lever. With a tone source, DTX on vs
 * off yields near-identical kbps (continuous signal, no silence). With speech,
 * DTX should cut uplink substantially during the 2.2 s silence windows.
 *
 * Usage:  HEADED=1 node dtxtest.cjs <tone|speech> <0|1> [holdSec]   (default 20)
 */
const path = require("path");
const fs   = require("fs");
const { TS_CLIENT, FAKE_MEDIA_ARGS, sleep, log, bootContext, loginPage } = require("./lib/wsn-client.cjs");
const { ensureToneWav, ensureSpeechWav } = require("./lib/tonegen.cjs");
const { chromium } = require(path.join(TS_CLIENT, "node_modules", "playwright-core"));

const BASE       = process.env.BASE_URL || "http://127.0.0.1:5001";
const SOURCE     = (process.argv[2] || "tone").toLowerCase();
const DTX        = parseInt(process.argv[3] || "0", 10) !== 0;
const HOLD_MS    = Math.max(5, parseInt(process.argv[4] || "20", 10)) * 1000;
const STAMP      = new Date().toISOString().replace(/[:.]/g, "-");
const OUT_DIR    = path.join(__dirname, "data");
const ASSETS_DIR = path.join(__dirname, "assets");
const UID        = Date.now().toString(36).slice(-6);

const TONE_WAV   = path.join(ASSETS_DIR, "wsn-tone-sweep-48k-180s.wav");
const SPEECH_WAV = path.join(ASSETS_DIR, "wsn-speech-pattern-48k-180s.wav");

function audioArgs(source) {
    const wav = source === "speech" ? SPEECH_WAV : TONE_WAV;
    return FAKE_MEDIA_ARGS
        .filter((f) => !f.startsWith("--use-file-for-fake-audio-capture"))
        .concat([`--use-file-for-fake-audio-capture=${wav}`]);
}

const snapBytes = (page) => page.evaluate(async () => {
    let b = 0, ts = 0;
    const pcs = window.wsnVoiceCtl._pcs ? [...window.wsnVoiceCtl._pcs.values()] : [];
    for (const pc of pcs) {
        const s = await pc.getStats();
        s.forEach((r) => { if (r.type === "outbound-rtp" && r.kind === "audio") { b += r.bytesSent || 0; ts = r.timestamp || 0; } });
    }
    return { b, ts };
});

(async () => {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.mkdirSync(ASSETS_DIR, { recursive: true });
    ensureToneWav(TONE_WAV);
    ensureSpeechWav(SPEECH_WAV);

    const rec = {
        exportedAt: new Date().toISOString(),
        source: SOURCE,
        dtx: DTX,
        holdMs: HOLD_MS,
        uplinkKbps: null,
    };

    const dtxUrl    = `${BASE}?wsndtx=${DTX ? 1 : 0}`;
    const senderBrowser   = await chromium.launch({ headless: !process.env.HEADED, args: audioArgs(SOURCE) });
    const listenerBrowser = await chromium.launch({ headless: !process.env.HEADED, args: FAKE_MEDIA_ARGS });

    try {
        const ctxA = await bootContext(senderBrowser,   BASE, { stripProcessing: true });
        const ctxB = await bootContext(listenerBrowser, BASE);
        const pA = await ctxA.newPage(), pB = await ctxB.newPage();
        await pA.goto(dtxUrl, { waitUntil: "domcontentloaded" });
        await pB.goto(BASE,   { waitUntil: "domcontentloaded" });
        await loginPage(pA, `dx${UID}a`, `dxpass${UID}a`);
        await loginPage(pB, `dx${UID}b`, `dxpass${UID}b`);
        await pA.evaluate(() => window.wsnVoiceCtl.enable());
        await pB.evaluate(() => window.wsnVoiceCtl.enable());
        log(`source=${SOURCE} dtx=${DTX} — waiting for peer link`);

        // Wait for B to see A as a peer.
        for (let t = 0; t < 20000; t += 500) {
            if (await pB.evaluate(() => window.wsnVoiceCtl.peers()) >= 1) break;
            await sleep(500);
        }

        log(`hold ${HOLD_MS / 1000} s, sampling uplink`);
        const snap0 = await snapBytes(pA);
        await sleep(HOLD_MS);
        const snap1 = await snapBytes(pA);

        if (snap1.ts > snap0.ts) {
            const dt = (snap1.ts - snap0.ts) / 1000;
            rec.uplinkKbps = dt > 0 ? Math.round((snap1.b - snap0.b) * 8 / dt / 1000) : null;
        }

        log(`uplinkKbps=${rec.uplinkKbps}`);
        const file = path.join(OUT_DIR, `wsn-dtx-${SOURCE}-dtx${DTX ? 1 : 0}-${STAMP}.json`);
        fs.writeFileSync(file, JSON.stringify(rec, null, 1));
        log(`wrote ${path.basename(file)}`);
    } finally {
        await senderBrowser.close();
        await listenerBrowser.close();
    }
})();
