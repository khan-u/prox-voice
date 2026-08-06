/**
 * audiodiag.cjs — diagnostic: do two headless clients exchange audio?
 *
 * Boots A and B, enables voice, then logs both sides' inbound packet count,
 * jitter-buffer sample count, and audio level every 3 s for 45 s. Use this
 * when a scenario harness fails with "no baseline packet flow" to verify the
 * stack is running and the fake microphone is connecting correctly.
 *
 * Usage: HEADED=1 node audiodiag.cjs
 */
const path = require("path");
const { TS_CLIENT, FAKE_MEDIA_ARGS, sleep, log, bootContext, loginPage } = require("./lib/wsn-client.cjs");
const { chromium } = require(path.join(TS_CLIENT, "node_modules", "playwright-core"));

const BASE = process.env.BASE_URL || "http://127.0.0.1:5001";
// Per-run unique accounts: fixed names get zombied by killed sessions server-
// side and then peer with corpses instead of each other.
const UID  = Date.now().toString(36).slice(-6);

const snap = (page) => page.evaluate(async () => {
    let pkts = 0, samples = 0, level = 0;
    const pcs = window.wsnVoiceCtl._pcs ? [...window.wsnVoiceCtl._pcs.values()] : [];
    for (const pc of pcs) {
        const s = await pc.getStats();
        s.forEach((r) => {
            if (r.type === "inbound-rtp" && r.kind === "audio") {
                pkts    += r.packetsReceived || 0;
                samples += r.jitterBufferEmittedCount || 0;
                level    = Math.max(level, r.audioLevel || 0);
            }
        });
    }
    return { peers: window.wsnVoiceCtl.peers(), pkts, samples, level };
});

(async () => {
    const browser = await chromium.launch({ headless: !process.env.HEADED, args: FAKE_MEDIA_ARGS });
    try {
        const ctxA = await bootContext(browser, BASE);
        const ctxB = await bootContext(browser, BASE);
        const pA = await ctxA.newPage(), pB = await ctxB.newPage();
        await pA.goto(BASE, { waitUntil: "domcontentloaded" });
        await pB.goto(BASE, { waitUntil: "domcontentloaded" });
        await loginPage(pA, `dg${UID}a`, `dgpass${UID}a`);
        await sleep(1500);
        await loginPage(pB, `dg${UID}b`, `dgpass${UID}b`);
        await pA.evaluate(() => window.wsnVoiceCtl.enable());
        await pB.evaluate(() => window.wsnVoiceCtl.enable());
        log("voice enabled; watching audio for 45s");
        for (let t = 0; t < 45; t += 3) {
            await sleep(3000);
            const [sa, sb] = await Promise.all([snap(pA), snap(pB)]);
            log(`+${t + 3}s  A[peers=${sa.peers} rxSamp=${sa.samples} pkts=${sa.pkts} lvl=${sa.level.toFixed(3)}]  B[peers=${sb.peers} rxSamp=${sb.samples} pkts=${sb.pkts} lvl=${sb.level.toFixed(3)}]`);
        }
    } catch (e) { log("ERR", String(e).slice(0, 200)); } finally { await browser.close(); }
})();
