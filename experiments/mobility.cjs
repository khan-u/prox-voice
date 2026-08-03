/**
 * Mobility harness — teardown / reconnect timing.
 *
 * Two clients form the mesh at spawn. Client A teleports beyond the proximity
 * radius (default 22 tiles), causing the link to tear down. After HOLD_MS the
 * link reforms. Measures how long each phase takes.
 *
 * Complete-case validity: a trial counts only when all three phases (form,
 * teardown, reconnect) complete. A partial trial — where the tear-down or
 * reconnect never fires — is written with -1 and excluded by aggregate.py's
 * group3() filter to avoid spurious latency readings.
 *
 * Usage:  node mobility.cjs [tiles] [holdSec]    (defaults: 22, 6)
 */
const path = require("path");
const fs   = require("fs");
const { TS_CLIENT, FAKE_MEDIA_ARGS, sleep, log, bootContext, loginPage } = require("./lib/wsn-client.cjs");
const { chromium } = require(path.join(TS_CLIENT, "node_modules", "playwright-core"));

const BASE     = process.env.BASE_URL || "http://127.0.0.1:5001";
const TILES    = parseInt(process.argv[2] || "22", 10);
const HOLD_MS  = Math.max(2, parseInt(process.argv[3] || "6", 10)) * 1000;
const POLL_MS  = 250;
const STAMP    = new Date().toISOString().replace(/[:.]/g, "-");
const OUT_DIR  = path.join(__dirname, "data");
const UID      = Date.now().toString(36).slice(-6);

const peers = (page) => page.evaluate(() => window.wsnVoiceCtl.peers());

async function waitPeers(page, target, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await peers(page) === target) return true;
        await sleep(POLL_MS);
    }
    return false;
}

(async () => {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const browser = await chromium.launch({ headless: true, args: FAKE_MEDIA_ARGS });
    const rec = { exportedAt: new Date().toISOString(), tiles: TILES, holdMs: HOLD_MS, phases: {} };

    try {
        const ctxA = await bootContext(browser, BASE), ctxB = await bootContext(browser, BASE);
        const pA = await ctxA.newPage(), pB = await ctxB.newPage();
        await pA.goto(BASE, { waitUntil: "domcontentloaded" });
        await pB.goto(BASE, { waitUntil: "domcontentloaded" });
        const userA = `mob${UID}a`, userB = `mob${UID}b`;
        await loginPage(pA, userA, `mopass${UID}a`);
        await loginPage(pB, userB, `mopass${UID}b`);
        await pA.evaluate(() => window.wsnVoiceCtl.enable());
        await pB.evaluate(() => window.wsnVoiceCtl.enable());

        // Phase 1: initial mesh formation.
        const t0Form = Date.now();
        const formed = await waitPeers(pB, 1, 30000);
        rec.phases.initialForm = { ms: formed ? Date.now() - t0Form : -1 };
        log(`initial form: ${rec.phases.initialForm.ms} ms`);

        if (!formed) {
            log("form timeout — writing partial trial");
            rec.phases.teardown = { ms: -1 }; rec.phases.reconnect = { ms: -1 };
        } else {
            // Phase 2: A moves out of range → link tears down.
            await pA.evaluate((d) => window.wsnGame.teleport(d, 0), TILES);
            const t0Tear = Date.now();
            const tornDown = await waitPeers(pB, 0, 20000);
            rec.phases.teardown = { ms: tornDown ? Date.now() - t0Tear : -1 };
            log(`teardown: ${rec.phases.teardown.ms} ms`);

            await sleep(HOLD_MS);

            // Phase 3: A returns → mesh reforms.
            await pA.evaluate((d) => window.wsnGame.teleport(-d, 0), TILES);
            const t0Recon = Date.now();
            const reconnected = await waitPeers(pB, 1, 30000);
            rec.phases.reconnect = { ms: reconnected ? Date.now() - t0Recon : -1 };
            log(`reconnect: ${rec.phases.reconnect.ms} ms`);
        }

        const file = path.join(OUT_DIR, `wsn-mobility-${STAMP}.json`);
        fs.writeFileSync(file, JSON.stringify(rec, null, 1));
        log(`wrote ${path.basename(file)}`);
    } finally {
        await browser.close();
    }
})();
