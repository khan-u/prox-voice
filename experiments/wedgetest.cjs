/**
 * wedgetest.cjs — reproduce/verify the "+50-east teleport wedge" (latent bug 3):
 * predicted-mode adopted jumps that exceed the client's loaded scene without
 * tripping the server's (128-scene-sized) reload bounds leave the avatar
 * off-scene; on return, voice re-forms slowly/never (no-RTP peer).
 *
 * Two clients co-locate, verify audio packets flow, teleport A +EAST tiles,
 * hold 9 s, return, then watch B's peers/pkts for 40 s. PASS = packets resume.
 *
 * Usage: HEADED=1 node wedgetest.cjs [tiles-east]   (default 50)
 */
const path = require("path");
const fs   = require("fs");
const { TS_CLIENT, FAKE_MEDIA_ARGS, sleep, log, bootContext, loginPage } = require("./lib/wsn-client.cjs");
const { ensureToneWav } = require("./lib/tonegen.cjs");
const { chromium } = require(path.join(TS_CLIENT, "node_modules", "playwright-core"));

const BASE     = process.env.BASE_URL || "http://127.0.0.1:5001";
const EAST     = parseInt(process.argv[2] || "50", 10);
const ASSETS   = path.join(__dirname, "assets");
const TONE_WAV = path.join(ASSETS, "wsn-tone-sweep-48k-180s.wav");
const UID      = Date.now().toString(36).slice(-6);

const FAKE_TONE = FAKE_MEDIA_ARGS
    .filter((f) => !f.startsWith("--use-file-for-fake-audio-capture"))
    .concat([`--use-file-for-fake-audio-capture=${TONE_WAV}`]);

const rx    = (page) => page.evaluate(async () => {
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
    return { pkts, samples, level };
});
const peers = (page) => page.evaluate(() => window.wsnVoiceCtl.peers());
const pos   = (page) => page.evaluate(() => window.wsnGame ? window.wsnGame.pos() : null);

(async () => {
    fs.mkdirSync(ASSETS, { recursive: true });
    ensureToneWav(TONE_WAV);

    const browser = await chromium.launch({ headless: !process.env.HEADED, args: FAKE_TONE });
    try {
        const ctxA = await bootContext(browser, BASE, { stripProcessing: true });
        const ctxB = await bootContext(browser, BASE);
        const pA = await ctxA.newPage(), pB = await ctxB.newPage();
        await pA.goto(BASE, { waitUntil: "domcontentloaded" });
        await pB.goto(BASE, { waitUntil: "domcontentloaded" });
        await loginPage(pA, `wt${UID}a`, `wtpass${UID}a`);
        await sleep(1500);
        await loginPage(pB, `wt${UID}b`, `wtpass${UID}b`);
        await pA.evaluate(() => window.wsnVoiceCtl.enable());
        await pB.evaluate(() => window.wsnVoiceCtl.enable());
        await sleep(1500);
        const pA0 = await pos(pA), pB0 = await pos(pB);
        if (pA0 && pB0) { await pA.evaluate((d) => window.wsnGame.teleport(d.x, d.y), { x: pB0.x - pA0.x, y: pB0.y - pA0.y }); }
        log(`co-located @${pB0?.x},${pB0?.y}`);

        // Wait for flowing packets (with one voice-kick retry like audiogap).
        let flowing = false;
        for (let attempt = 1; attempt <= 3 && !flowing; attempt++) {
            let prev = (await rx(pB)).pkts;
            for (let t = 0; t < 15000; t += 1000) {
                await sleep(1000);
                const cur = (await rx(pB)).pkts;
                if (cur > prev + 20) { flowing = true; break; }
                prev = cur;
            }
            if (!flowing && attempt < 3) {
                await pA.evaluate(() => window.wsnVoiceCtl.disable()); await sleep(700);
                await pA.evaluate(() => window.wsnVoiceCtl.enable());
                log("  kicked A voice");
            }
        }
        if (!flowing) { throw new Error("no baseline audio — abort"); }
        log("baseline audio flowing");

        await pA.evaluate((d) => window.wsnGame.teleport(d, 0), EAST);
        log(`A out +${EAST} EAST  A@`, JSON.stringify(await pos(pA)));
        await sleep(9000);
        await pA.evaluate((d) => window.wsnGame.teleport(-d, 0), EAST);
        const tBack = Date.now();
        log("A back  A@", JSON.stringify(await pos(pA)));

        // Watch 40s: does the peer re-form AND do packets flow?
        let resumedAt = -1, lastPkts = -1;
        for (let i = 0; i < 400; i++) {
            const r = await rx(pB);
            if (r.pkts > 0 && r.pkts !== lastPkts && lastPkts !== -1 && resumedAt < 0) { resumedAt = Date.now() - tBack; }
            lastPkts = r.pkts;
            if (i % 20 === 0) { log(`  +${((Date.now() - tBack) / 1000).toFixed(1)}s  B.peers=${await peers(pB)} pkts=${r.pkts}`); }
            if (resumedAt > 0) { break; }
            await sleep(100);
        }
        console.log("\n===== WEDGETEST =====");
        console.log(resumedAt > 0
            ? `PASS: audio packets resumed ${resumedAt} ms after return`
            : `WEDGE: no audio packets within 40 s of return (peers=${await peers(pB)})`);
        process.exitCode = resumedAt > 0 ? 0 : 1;
    } catch (e) { log("ERR", String(e).slice(0, 300)); process.exitCode = 1; }
    finally { await browser.close(); }
})();
