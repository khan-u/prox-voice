/**
 * silentprobe.cjs — catch the formation-time "peers=1 but no audio" wedge in
 * the act and classify it: never-connected (glare / lost answer) vs connected-
 * but-silent (track attach). Boots A+B up to N times; each boot samples both
 * sides' wsnVoiceCtl.linkDebug() every second for 10 s (before the 8 s
 * watchdog can mask much) and prints the timeline. Exits after the first
 * anomalous boot.
 *
 * Usage: HEADED=1 node silentprobe.cjs [boots=6]
 */
const path = require("path");
const { TS_CLIENT, FAKE_MEDIA_ARGS, sleep, log, bootContext, loginPage } = require("./lib/wsn-client.cjs");
const { ensureToneWav } = require("./lib/tonegen.cjs");
const { chromium } = require(path.join(TS_CLIENT, "node_modules", "playwright-core"));

const BASE      = process.env.BASE_URL || "http://127.0.0.1:5001";
const BOOTS     = parseInt(process.argv[2] || "6", 10);
const ASSETS    = path.join(__dirname, "assets");
const TONE_WAV  = path.join(ASSETS, "wsn-tone-sweep-48k-180s.wav");

const FAKE_TONE = FAKE_MEDIA_ARGS
    .filter((f) => !f.startsWith("--use-file-for-fake-audio-capture"))
    .concat([`--use-file-for-fake-audio-capture=${TONE_WAV}`]);

const dbg = (p) => p.evaluate(async () => await window.wsnVoiceCtl.linkDebug());
const fmt = (arr) => arr.map((d) => `#${d.index} ${d.conn}/${d.sig}/${d.ice} out=${d.outBytes} in=${d.inPkts}`).join("  ") || "(none)";

(async () => {
    require("fs").mkdirSync(ASSETS, { recursive: true });
    ensureToneWav(TONE_WAV);

    for (let k = 1; k <= BOOTS; k++) {
        const UID     = Date.now().toString(36).slice(-6);
        const browser = await chromium.launch({ headless: !process.env.HEADED, args: FAKE_TONE });
        try {
            const ctxA = await bootContext(browser, BASE, { stripProcessing: true });
            const ctxB = await bootContext(browser, BASE);
            const pA = await ctxA.newPage(), pB = await ctxB.newPage();
            await pA.goto(BASE, { waitUntil: "domcontentloaded" });
            await pB.goto(BASE, { waitUntil: "domcontentloaded" });
            await loginPage(pA, `sp${UID}a`, `sppass${UID}a`);
            await loginPage(pB, `sp${UID}b`, `sppass${UID}b`);
            await pA.evaluate(() => window.wsnVoiceCtl.enable());
            await pB.evaluate(() => window.wsnVoiceCtl.enable());
            log(`boot ${k}/${BOOTS} — watching linkDebug 10s`);
            let anomaly = false, connectedSilent = false, neverConnected = false;
            for (let t = 0; t <= 10000; t += 1000) {
                const [da, db] = await Promise.all([dbg(pA), dbg(pB)]);
                log(`  +${t / 1000}s  A[${fmt(da)}]  B[${fmt(db)}]`);
                // classify at the 8s mark, before/at watchdog
                if (t === 8000) {
                    for (const [, arr] of [["A", da], ["B", db]]) {
                        for (const d of arr) {
                            if (d.conn !== "connected") { neverConnected = true; anomaly = true; }
                            else if (d.inPkts <= 0) { connectedSilent = true; anomaly = true; }
                        }
                        if (arr.length === 0) { neverConnected = true; anomaly = true; }
                    }
                }
                await sleep(1000);
            }
            if (anomaly) {
                console.log("\n===== SILENTPROBE =====");
                console.log(connectedSilent
                    ? "CONNECTED-BUT-SILENT: pc connected, no inbound audio → track-attach bug"
                    : "NEVER-CONNECTED: pc stuck pre-connected at 8s → glare/lost-signal wedge");
                process.exitCode = 2;
                return;
            }
            log(`boot ${k}: clean`);
        } finally { await browser.close(); }
    }
    console.log("\n===== SILENTPROBE =====\nall boots clean — no wedge reproduced");
})();
