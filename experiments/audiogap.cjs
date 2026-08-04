/**
 * Audio-gap harness — listener-perceived silence during an out-and-back trip.
 *
 * Two clients form the mesh. Client A is the sender (tone WAV injected via
 * --use-file-for-fake-audio-capture); B is the listener. A teleports WEST
 * beyond the proximity radius for ABSENCE_MS, then returns. The harness times
 * how long B's inbound packet stream stalls (audio stop) and how long it takes
 * to recover (audio gap) using packetsReceived as the detector — loudness-
 * independent, so it works even when Opus mutes the encoder.
 *
 * Valid runs: both tStop and tResume must be captured and the stop must track
 * A's departure closely. The valid flag gates aggregate.py's audiogap() filter;
 * invalid runs are archived but excluded from statistics.
 *
 * Usage:  node audiogap.cjs [absenceSec]    (default 9)
 */
const path = require("path");
const fs   = require("fs");
const os   = require("os");
const { TS_CLIENT, FAKE_MEDIA_ARGS, sleep, log, bootContext, loginPage } = require("./lib/wsn-client.cjs");
const { ensureToneWav }  = require("./lib/tonegen.cjs");
const { chromium } = require(path.join(TS_CLIENT, "node_modules", "playwright-core"));

const BASE         = process.env.BASE_URL || "http://127.0.0.1:5001";
const ABSENCE_MS   = Math.max(3, parseInt(process.argv[2] || "9", 10)) * 1000;
const STALL_MS     = 1200;   // packet gap this long signals audio has stopped
const STAMP        = new Date().toISOString().replace(/[:.]/g, "-");
const OUT_DIR      = path.join(__dirname, "data");
const UID          = Date.now().toString(36).slice(-6);
const ASSETS_DIR   = path.join(__dirname, "assets");
const TONE_WAV     = path.join(ASSETS_DIR, "wsn-tone-sweep-48k-180s.wav");

const FAKE_SENDER = FAKE_MEDIA_ARGS
    .filter((f) => !f.startsWith("--use-file-for-fake-audio-capture"))
    .concat([`--use-file-for-fake-audio-capture=${TONE_WAV}`]);

const rxPkts = (page) => page.evaluate(async () => {
    let pkts = 0;
    const pcs = window.wsnVoiceCtl._pcs ? [...window.wsnVoiceCtl._pcs.values()] : [];
    for (const pc of pcs) {
        const s = await pc.getStats();
        s.forEach((r) => { if (r.type === "inbound-rtp" && r.kind === "audio") pkts += r.packetsReceived || 0; });
    }
    return pkts;
});

(async () => {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.mkdirSync(ASSETS_DIR, { recursive: true });
    ensureToneWav(TONE_WAV);

    const rec = {
        exportedAt: new Date().toISOString(),
        absenceMs: ABSENCE_MS,
        valid: false,
        audioStopAfterOutMs: -1,
        reconnectAudioGapMs: -1,
        totalSilenceMs: -1,
        invalidReason: null,
    };

    const senderBrowser   = await chromium.launch({ headless: true, args: FAKE_SENDER });
    const listenerBrowser = await chromium.launch({ headless: true, args: FAKE_MEDIA_ARGS });

    try {
        // Sender (A) uses the tone WAV; listener (B) uses the default fake mic.
        const ctxA = await bootContext(senderBrowser, BASE, { stripProcessing: true });
        const ctxB = await bootContext(listenerBrowser, BASE);
        const pA = await ctxA.newPage(), pB = await ctxB.newPage();
        await pA.goto(BASE, { waitUntil: "domcontentloaded" });
        await pB.goto(BASE, { waitUntil: "domcontentloaded" });
        await loginPage(pA, `ag${UID}a`, `agpass${UID}a`);
        await loginPage(pB, `ag${UID}b`, `agpass${UID}b`);
        await pA.evaluate(() => window.wsnVoiceCtl.enable());
        await pB.evaluate(() => window.wsnVoiceCtl.enable());
        log("clients online, waiting for packet flow");

        // Wait for B to receive packets (with a kick-retry if the first connect fails).
        let flowing = false;
        for (let attempt = 1; attempt <= 3 && !flowing; attempt++) {
            let prev = await rxPkts(pB);
            for (let t = 0; t < 15000; t += 1000) {
                await sleep(1000);
                const cur = await rxPkts(pB);
                if (cur > prev + 5) { flowing = true; break; }
                prev = cur;
            }
            if (!flowing && attempt < 3) {
                await pA.evaluate(() => window.wsnVoiceCtl.disable()); await sleep(700);
                await pA.evaluate(() => window.wsnVoiceCtl.enable());
                log(`  kicked A (attempt ${attempt})`);
            }
        }
        if (!flowing) { rec.invalidReason = "no baseline packet flow after 3 kick attempts"; }
        else {
            // A moves WEST (avoids scene-rebuild border on the east edge).
            const tDepart = Date.now();
            const posA = await pA.evaluate(() => window.wsnGame.pos());
            await pA.evaluate((p) => window.wsnGame.teleport(-25, p.y), posA);
            log("A out WEST, watching B's packet stream");

            let tStop = -1, lastPkts = await rxPkts(pB), lastChange = Date.now();
            const stopLoop = setInterval(async () => {
                const cur = await rxPkts(pB).catch(() => lastPkts);
                if (cur > lastPkts) { lastPkts = cur; lastChange = Date.now(); }
                if (tStop < 0 && Date.now() - lastChange > STALL_MS) {
                    tStop = lastChange + STALL_MS / 2 - tDepart;
                    log(`  packet stall detected: stop=${tStop} ms after departure`);
                }
            }, 200);

            await sleep(ABSENCE_MS);
            clearInterval(stopLoop);

            // A returns to original position.
            const tReturn = Date.now();
            await pA.evaluate((p) => window.wsnGame.teleport(p.x, p.y), posA);
            log("A back, watching recovery");

            let tResume = -1; lastPkts = await rxPkts(pB); lastChange = Date.now();
            for (let t = 0; t < 30000; t += 500) {
                await sleep(500);
                const cur = await rxPkts(pB).catch(() => lastPkts);
                if (cur > lastPkts + 2) {
                    tResume = Date.now() - tReturn;
                    log(`  packets resumed: gap=${tResume} ms`);
                    break;
                }
                lastPkts = cur;
            }

            rec.audioStopAfterOutMs  = tStop;
            rec.reconnectAudioGapMs  = tResume;
            rec.totalSilenceMs       = tStop >= 0 && tResume >= 0 ? tStop + tResume : -1;
            // Valid if both events were captured and the stop closely tracked departure.
            rec.valid = tStop > 0 && tResume > 0 && tStop < ABSENCE_MS + 3000;
            if (!rec.valid) rec.invalidReason = `tStop=${tStop} tResume=${tResume}`;
        }

        const file = path.join(OUT_DIR, `wsn-audiogap-${STAMP}.json`);
        fs.writeFileSync(file, JSON.stringify(rec, null, 1));
        log(`wrote ${path.basename(file)}`);
        log(`valid=${rec.valid}  stop=${rec.audioStopAfterOutMs} ms  gap=${rec.reconnectAudioGapMs} ms`);
    } finally {
        await senderBrowser.close();
        await listenerBrowser.close();
    }
})();
