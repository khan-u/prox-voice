/**
 * Grace-window harness — duty-cycle effectiveness sweep.
 *
 * Measures three things for a given grace window W and absence duration D:
 *   reconnectGapMs   — listener-perceived silence from departure to audio resuming
 *   holdKbps         — uplink bandwidth burned during the absence (idle-link cost)
 *   bPeersDuringAbsence — whether B still showed a peer entry during A's absence
 *
 * The grace window is set via the ?wsngrace= URL query lever and validated with
 * wsnVoiceCtl.grace() before the run. The warm flag signals whether W > D, i.e.
 * the link should already be warm when A returns.
 *
 * Usage:  node gracegap.cjs <graceMs> [absenceSec]    (defaults: 0, 6)
 */
const path = require("path");
const fs   = require("fs");
const { TS_CLIENT, FAKE_MEDIA_ARGS, sleep, log, bootContext, loginPage } = require("./lib/wsn-client.cjs");
const { ensureToneWav } = require("./lib/tonegen.cjs");
const { chromium } = require(path.join(TS_CLIENT, "node_modules", "playwright-core"));

const BASE        = process.env.BASE_URL || "http://127.0.0.1:5001";
const GRACE_MS    = parseInt(process.argv[2] || "0", 10);
const ABSENCE_MS  = Math.max(2, parseInt(process.argv[3] || "6", 10)) * 1000;
const STALL_MS    = 1200;
const STAMP       = new Date().toISOString().replace(/[:.]/g, "-");
const OUT_DIR     = path.join(__dirname, "data");
const ASSETS_DIR  = path.join(__dirname, "assets");
const TONE_WAV    = path.join(ASSETS_DIR, "wsn-tone-sweep-48k-180s.wav");
const UID         = Date.now().toString(36).slice(-6);

const FAKE_SENDER = FAKE_MEDIA_ARGS
    .filter((f) => !f.startsWith("--use-file-for-fake-audio-capture"))
    .concat([`--use-file-for-fake-audio-capture=${TONE_WAV}`]);

const rxPkts  = (page) => page.evaluate(async () => {
    let pkts = 0;
    const pcs = window.wsnVoiceCtl._pcs ? [...window.wsnVoiceCtl._pcs.values()] : [];
    for (const pc of pcs) {
        const s = await pc.getStats();
        s.forEach((r) => { if (r.type === "inbound-rtp" && r.kind === "audio") pkts += r.packetsReceived || 0; });
    }
    return pkts;
});
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

    const rec = {
        exportedAt: new Date().toISOString(),
        graceMs: GRACE_MS,
        absenceMs: ABSENCE_MS,
        warm: GRACE_MS > ABSENCE_MS,
        reconnectGapMs: -1,
        stopAfterOutMs: -1,
        holdKbps: null,
        bPeersDuringAbsence: null,
    };

    const senderBrowser   = await chromium.launch({ headless: true, args: FAKE_SENDER });
    const listenerBrowser = await chromium.launch({ headless: true, args: FAKE_MEDIA_ARGS });

    try {
        const graceUrl = `${BASE}?wsngrace=${GRACE_MS}`;
        const ctxA = await bootContext(senderBrowser,   BASE, { stripProcessing: true });
        const ctxB = await bootContext(listenerBrowser, BASE);
        const pA = await ctxA.newPage(), pB = await ctxB.newPage();
        await pA.goto(graceUrl, { waitUntil: "domcontentloaded" });
        await pB.goto(BASE,     { waitUntil: "domcontentloaded" });
        await loginPage(pA, `gg${UID}a`, `ggpass${UID}a`);
        await loginPage(pB, `gg${UID}b`, `ggpass${UID}b`);
        // Confirm the grace window lever took effect.
        const actualGrace = await pA.evaluate(() => window.wsnVoiceCtl.grace?.() ?? -1);
        log(`grace lever: requested=${GRACE_MS} ms, confirmed=${actualGrace} ms`);
        await pA.evaluate(() => window.wsnVoiceCtl.enable());
        await pB.evaluate(() => window.wsnVoiceCtl.enable());

        // Wait for baseline packet flow.
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
            }
        }
        if (!flowing) { log("no baseline flow — aborting"); return; }
        log("baseline flowing");

        // A departs WEST.
        const posA = await pA.evaluate(() => window.wsnGame.pos());
        const tDepart = Date.now();
        await pA.evaluate((p) => window.wsnGame.teleport(-25, p.y), posA);

        // Sample uplink bytes during the absence.
        const bSnap0 = await snapBytes(pA);

        // Monitor B's packet stream to detect audio stop.
        let tStop = -1, lastPkts = await rxPkts(pB), lastChange = Date.now();
        const peersLog = [];
        const stopLoop = setInterval(async () => {
            const cur = await rxPkts(pB).catch(() => lastPkts);
            if (cur > lastPkts) { lastPkts = cur; lastChange = Date.now(); }
            if (tStop < 0 && Date.now() - lastChange > STALL_MS) {
                tStop = lastChange + STALL_MS / 2 - tDepart;
            }
            peersLog.push(await pB.evaluate(() => window.wsnVoiceCtl.peers()).catch(() => -1));
        }, 250);

        await sleep(ABSENCE_MS);
        clearInterval(stopLoop);
        rec.bPeersDuringAbsence = peersLog.some((p) => p >= 1);

        // Uplink kbps during absence.
        const bSnap1 = await snapBytes(pA).catch(() => null);
        if (bSnap1 && bSnap1.ts > bSnap0.ts) {
            const dt = (bSnap1.ts - bSnap0.ts) / 1000;
            rec.holdKbps = dt > 0 ? Math.round((bSnap1.b - bSnap0.b) * 8 / dt / 1000) : null;
        }

        // A returns.
        const tReturn = Date.now();
        await pA.evaluate((p) => window.wsnGame.teleport(p.x, p.y), posA);

        let tResume = -1; lastPkts = await rxPkts(pB);
        for (let t = 0; t < 30000; t += 500) {
            await sleep(500);
            const cur = await rxPkts(pB).catch(() => lastPkts);
            if (cur > lastPkts + 2) { tResume = Date.now() - tReturn; break; }
            lastPkts = cur;
        }

        rec.stopAfterOutMs  = tStop;
        rec.reconnectGapMs  = tResume;
        log(`grace=${GRACE_MS} ms  stop=${tStop} ms  gap=${tResume} ms  hold=${rec.holdKbps} kbps`);

        const file = path.join(OUT_DIR, `wsn-gracegap-G${GRACE_MS}-D${ABSENCE_MS}-${STAMP}.json`);
        fs.writeFileSync(file, JSON.stringify(rec, null, 1));
        log(`wrote ${path.basename(file)}`);
    } finally {
        await senderBrowser.close();
        await listenerBrowser.close();
    }
})();
