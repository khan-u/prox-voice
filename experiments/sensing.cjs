/**
 * Sensing-scenario harness — suppression + report-kind profiling.
 *
 * Runs one of four scenarios:
 *   idle  — two clients, no movement or speech (baseline suppression)
 *   walk  — A moves ±7 tiles every 4 s (above MOVE_TILES=6; stays in range)
 *   conv  — A and B exchange speakTo/speakAccept; speech-pattern WAV injected
 *   churn — A moves ±22 tiles every 8 s (tears down and reforms the link)
 *
 * Collects wsnSense.stats() for each client after a 60 s hold and counts the
 * sensor report kinds emitted during the run.
 *
 * Signature validation: conv needs speech-* reports, walk needs move, churn
 * needs link — aggregate.py uses these to check the run is plausible.
 *
 * Usage:  node sensing.cjs <idle|walk|conv|churn>
 */
const path = require("path");
const fs   = require("fs");
const { TS_CLIENT, FAKE_MEDIA_ARGS, sleep, log, bootContext, loginPage } = require("./lib/wsn-client.cjs");
const { ensureSpeechWav } = require("./lib/tonegen.cjs");
const { chromium } = require(path.join(TS_CLIENT, "node_modules", "playwright-core"));

const BASE       = process.env.BASE_URL || "http://127.0.0.1:5001";
const SCENARIO   = (process.argv[2] || "idle").toLowerCase();
const HOLD_MS    = 60000;
const STAMP      = new Date().toISOString().replace(/[:.]/g, "-");
const OUT_DIR    = path.join(__dirname, "data");
const ASSETS_DIR = path.join(__dirname, "assets");
const SPEECH_WAV = path.join(ASSETS_DIR, "wsn-speech-pattern-48k-180s.wav");
const UID        = Date.now().toString(36).slice(-6);

const FAKE_SPEECH = FAKE_MEDIA_ARGS
    .filter((f) => !f.startsWith("--use-file-for-fake-audio-capture"))
    .concat([`--use-file-for-fake-audio-capture=${SPEECH_WAV}`]);

(async () => {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.mkdirSync(ASSETS_DIR, { recursive: true });
    if (SCENARIO === "conv") ensureSpeechWav(SPEECH_WAV);

    const argsA = SCENARIO === "conv" ? FAKE_SPEECH : FAKE_MEDIA_ARGS;
    const browser = await chromium.launch({ headless: true, args: argsA });
    const kindCounts = {};
    const rec = { exportedAt: new Date().toISOString(), scenario: SCENARIO, clients: {}, kindCounts };

    try {
        const ctxA = await bootContext(browser, BASE, { stripProcessing: SCENARIO === "conv" });
        const ctxB = await bootContext(browser, BASE);
        const pA = await ctxA.newPage(), pB = await ctxB.newPage();
        await pA.goto(BASE, { waitUntil: "domcontentloaded" });
        await pB.goto(BASE, { waitUntil: "domcontentloaded" });
        await loginPage(pA, `sn${UID}a`, `snpass${UID}a`);
        await loginPage(pB, `sn${UID}b`, `snpass${UID}b`);
        await pA.evaluate(() => window.wsnVoiceCtl.enable());
        await pB.evaluate(() => window.wsnVoiceCtl.enable());
        log(`scenario=${SCENARIO}, hold=${HOLD_MS / 1000} s`);

        // Collect sensor report kinds as they emit (via console intercept would be
        // ideal, but we poll stats deltas instead; kindCounts come from wsnSense).
        const kindSamplers = [];

        if (SCENARIO === "walk") {
            // ±7 tiles every 4 s — stays within proximity range (15 tiles).
            let dir = 1;
            const walkLoop = setInterval(async () => {
                await pA.evaluate((d) => window.wsnGame.teleport(d, 0), dir * 7);
                dir *= -1;
            }, 4000);
            kindSamplers.push(walkLoop);
        } else if (SCENARIO === "conv") {
            // Exchange speakTo/speakAccept so the sensor logs conversation-type reports.
            const convLoop = setInterval(async () => {
                await pA.evaluate(() => window.wsnGame.speakTo && window.wsnGame.speakTo(0));
                await sleep(200);
                await pB.evaluate(() => window.wsnGame.speakAccept && window.wsnGame.speakAccept());
            }, 5000);
            kindSamplers.push(convLoop);
        } else if (SCENARIO === "churn") {
            // ±22 tiles every 8 s — crosses the proximity border.
            let dir = 1;
            const churnLoop = setInterval(async () => {
                await pA.evaluate((d) => window.wsnGame.teleport(d, 0), dir * 22);
                dir *= -1;
            }, 8000);
            kindSamplers.push(churnLoop);
        }

        await sleep(HOLD_MS);
        kindSamplers.forEach(clearInterval);

        // Collect final sensor stats from both clients.
        for (const [label, page] of [["A", pA], ["B", pB]]) {
            try {
                const stats = await page.evaluate(async () => {
                    const s = window.wsnSense ? await window.wsnSense.stats() : null;
                    const kinds = window.wsnSense?.kindCounts?.() ?? {};
                    return { stats: s, kinds };
                });
                rec.clients[label] = { stats: stats.stats };
                for (const [k, v] of Object.entries(stats.kinds)) {
                    kindCounts[k] = (kindCounts[k] || 0) + v;
                }
            } catch (e) { log(`stats error (${label}):`, String(e).slice(0, 80)); }
        }

        const file = path.join(OUT_DIR, `wsn-sensing-${SCENARIO}-${STAMP}.json`);
        fs.writeFileSync(file, JSON.stringify(rec, null, 1));
        log(`wrote ${path.basename(file)}`);
        log("kindCounts:", JSON.stringify(kindCounts));
    } finally {
        await browser.close();
    }
})();
