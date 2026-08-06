/**
 * ghostrepro.cjs — latent bug 1 repro: does a SIGKILLed client leave a ghost?
 *
 * 1. Boot client G, login (unique name), enable voice.  2. SIGKILL its browser
 * process (no clean logout).  3. Boot probe P at spawn, enable voice, watch
 * peers for 20 s — a ghost shows up as peers>=1 with no live counterpart.
 * 4. Re-login using G's name — the zombie-identity symptom blocks/wedges it.
 *
 * Usage: HEADED=1 node ghostrepro.cjs
 */
const path = require("path");
const { TS_CLIENT, FAKE_MEDIA_ARGS, sleep, log, bootContext, loginPage } = require("./lib/wsn-client.cjs");
const { chromium } = require(path.join(TS_CLIENT, "node_modules", "playwright-core"));

const BASE = process.env.BASE_URL || "http://127.0.0.1:5001";
const UID  = Date.now().toString(36).slice(-6);

(async () => {
    const gName = "gh" + UID, gPass = "ghpass" + UID;

    // 1-2: ghost client, then SIGKILL its whole browser process tree. A unique
    // marker arg lets pkill target exactly this browser without affecting others.
    const marker   = "--wsn-ghost-marker=" + UID;
    const gBrowser = await chromium.launch({ headless: !process.env.HEADED, args: FAKE_MEDIA_ARGS.concat([marker]) });
    const gCtx     = await bootContext(gBrowser, BASE);
    const gPage    = await gCtx.newPage();
    await gPage.goto(BASE, { waitUntil: "domcontentloaded" });
    await loginPage(gPage, gName, gPass);
    await gPage.evaluate(() => window.wsnVoiceCtl.enable());
    log(`ghost '${gName}' logged in + voice on @`, JSON.stringify(await gPage.evaluate(() => window.wsnGame.pos())));
    await sleep(3000);
    log(`SIGKILL browser tree (marker ${UID}) — no logout`);
    require("child_process").execSync(`pkill -9 -f -- "${marker}" || true`);
    await sleep(3000);   // give the server time to notice (or not)

    // 3: probe — does the corpse still stand at spawn?
    const pBrowser = await chromium.launch({ headless: !process.env.HEADED, args: FAKE_MEDIA_ARGS });
    try {
        const pCtx  = await bootContext(pBrowser, BASE);
        const pPage = await pCtx.newPage();
        await pPage.goto(BASE, { waitUntil: "domcontentloaded" });
        await loginPage(pPage, "pr" + UID, "prpass" + UID);
        await pPage.evaluate(() => window.wsnVoiceCtl.enable());
        log("probe logged in + voice on");
        let sawPeer = false;
        for (let t = 0; t <= 20000; t += 2000) {
            const peers = await pPage.evaluate(() => window.wsnVoiceCtl.peers());
            log(`  probe +${t / 1000}s peers=${peers}`);
            if (peers >= 1) { sawPeer = true; }
            await sleep(2000);
        }
        // 4: re-login with the ghost's own name from a fresh context.
        let relogin = "OK";
        try {
            const rCtx  = await bootContext(pBrowser, BASE);
            const rPage = await rCtx.newPage();
            await rPage.goto(BASE, { waitUntil: "domcontentloaded" });
            await loginPage(rPage, gName, gPass);
        } catch (e) { relogin = "FAILED (" + String(e).slice(0, 80) + ")"; }
        log(`re-login as '${gName}': ${relogin}`);
        console.log("\n===== GHOSTREPRO =====");
        console.log(sawPeer ? "GHOST: probe saw a peer (corpse in-world after SIGKILL)"
                            : "CLEAN: no ghost peer seen after SIGKILL");
        console.log("re-login: " + relogin);
        process.exitCode = sawPeer || relogin !== "OK" ? 1 : 0;
    } finally { await pBrowser.close(); }
})();
