/**
 * PROX-VOICE formation + KPI harness — headless multi-client sweep.
 *
 * Boots N headless Chromium peers, forms the voice mesh, holds for HOLD_MS,
 * then reads each client's KPIs (formation latency, ICE success, relay%,
 * RTT, glare), uplink bandwidth, and sensor stats. Writes per-client JSON
 * and an aggregate summary to experiments/data/.
 *
 * Usage:  node harness.cjs <N> [holdSec]    (defaults: 2, 40)
 */
const path = require("path");
const fs   = require("fs");
const { TS_CLIENT, FAKE_MEDIA_ARGS, sleep, log, bootContext, loginPage } = require("./lib/wsn-client.cjs");
const { chromium } = require(path.join(TS_CLIENT, "node_modules", "playwright-core"));

const BASE    = process.env.BASE_URL || "http://127.0.0.1:5001";
const N       = Math.max(1, parseInt(process.argv[2] || "2", 10));
const HOLD_MS = Math.max(5, parseInt(process.argv[3] || "40", 10)) * 1000;
const STAMP   = new Date().toISOString().replace(/[:.]/g, "-");
const OUT_DIR = path.join(__dirname, "data");
const UID     = Date.now().toString(36).slice(-6);

async function bootClient(browser, i) {
    const ctx  = await bootContext(browser, BASE);
    const page = await ctx.newPage();
    await page.goto(BASE, { waitUntil: "domcontentloaded" });
    return { page, ctx, user: `hv${UID}${i}`, pass: `hvpass${UID}${i}` };
}

// Sample outbound-rtp bytesSent for all active peer connections.
const snapUplink = (page) => page.evaluate(async () => {
    let bytes = 0, ts = 0;
    const pcs = window.wsnVoiceCtl._pcs ? [...window.wsnVoiceCtl._pcs.values()] : [];
    for (const pc of pcs) {
        const s = await pc.getStats();
        s.forEach((r) => {
            if (r.type === "outbound-rtp" && r.kind === "audio") {
                bytes += r.bytesSent || 0; ts = r.timestamp || 0;
            }
        });
    }
    return { bytes, ts };
});

async function collect(page, user, uplinkKbps) {
    const rec = await page.evaluate(async (u) => {
        const kpis       = await window.wsnVoice.kpis();
        const sense      = window.wsnSense      ? await window.wsnSense.stats()          : null;
        const senseLinks = window.wsnSense?.links ? window.wsnSense.links()               : null;
        const energy     = window.wsnEnergy     ? window.wsnEnergy.total()               : null;
        return {
            user: u,
            pos:     window.wsnGame      ? window.wsnGame.pos()           : null,
            enabled: window.wsnVoiceCtl.enabled(),
            peers:   window.wsnVoiceCtl.peers(),
            kpis,
            links:   kpis.links || null,
            sense,
            senseLinks,
            energy,
        };
    }, user);
    rec.meanUpKbps = uplinkKbps;
    return rec;
}

(async () => {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const browser = await chromium.launch({ headless: true, args: FAKE_MEDIA_ARGS });
    const clients = [];

    try {
        log(`booting ${N} clients (hold=${HOLD_MS / 1000} s)`);
        for (let i = 0; i < N; i++) {
            const c = await bootClient(browser, i);
            await loginPage(c.page, c.user, c.pass);
            await c.page.evaluate(() => window.wsnVoiceCtl.enable());
            clients.push(c);
            log(`client ${i} (${c.user}) online`);
        }

        log(`all ${N} clients online — holding ${HOLD_MS / 1000} s`);
        await sleep(HOLD_MS);

        // Uplink: before/after 5-s window for each client.
        const snaps0 = await Promise.all(clients.map((c) => snapUplink(c.page).catch(() => null)));
        await sleep(5000);
        const snaps1 = await Promise.all(clients.map((c) => snapUplink(c.page).catch(() => null)));
        const uplinkKbps = clients.map((_, i) => {
            const s0 = snaps0[i], s1 = snaps1[i];
            if (!s0 || !s1) return null;
            const dt = (s1.ts - s0.ts) / 1000;
            return dt > 0 ? Math.round((s1.bytes - s0.bytes) * 8 / dt / 1000) : null;
        });

        const perClient = [];
        for (let i = 0; i < clients.length; i++) {
            const c = clients[i];
            try {
                const rec  = await collect(c.page, c.user, uplinkKbps[i]);
                perClient.push(rec);
                const file = path.join(OUT_DIR, `wsn-client-${c.user}-${STAMP}.json`);
                fs.writeFileSync(file, JSON.stringify(rec, null, 1));
                log(`wrote ${path.basename(file)}`);
            } catch (e) { log(`collect error (${c.user}):`, String(e).slice(0, 120)); }
        }

        const summary = { exportedAt: new Date().toISOString(), N, perClient };
        const sumFile = path.join(OUT_DIR, `wsn-voice-N${N}-summary-${STAMP}.json`);
        fs.writeFileSync(sumFile, JSON.stringify(summary, null, 1));
        log(`wrote summary → ${path.basename(sumFile)}`);
    } finally {
        await browser.close();
    }
})();
