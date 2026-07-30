/**
 * Shared Playwright helpers for PROX-VOICE experiment harnesses.
 *
 * Factors out the common browser-boot and login flow so each experiment file
 * is only concerned with the scenario it measures. Every harness requires this
 * module and uses its bootContext / loginPage pair.
 */
const path = require("path");

/** Absolute path to the directory containing node_modules/playwright-core.
 *  Set TS_CLIENT in the environment to the game client installation root. */
const TS_CLIENT = process.env.TS_CLIENT;

/** Chromium launch flags that enable a headless fake microphone, bypass autoplay
 *  policy, and route GPU work through Metal/ANGLE for stability on Apple silicon. */
const FAKE_MEDIA_ARGS = [
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
    "--autoplay-policy=no-user-gesture-required",
    "--use-angle=metal",
    "--enable-gpu",
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log   = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

/**
 * Create a browser context with the standard PROX-VOICE init scripts: grants
 * microphone permission, sets the localStorage keys that select the classic
 * world skin. Pass { stripProcessing: true } to also override getUserMedia and
 * remove browser-side NS/AGC/AEC so a fake audio file plays back unaltered.
 */
async function bootContext(browser, baseUrl, { stripProcessing = false } = {}) {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    try { await ctx.grantPermissions(["microphone"], { origin: baseUrl }); } catch (_) {}
    await ctx.addInitScript(() => {
        try {
            localStorage.setItem("juva.world.classic", "1");
            localStorage.setItem("juva.login.bg", "classic");
        } catch (_) {}
    });
    if (stripProcessing) {
        await ctx.addInitScript(() => {
            const gum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
            navigator.mediaDevices.getUserMedia = (c) => {
                if (c && c.audio) {
                    c.audio = { channelCount: 1, echoCancellation: false,
                                noiseSuppression: false, autoGainControl: false };
                }
                return gum(c);
            };
        });
    }
    return ctx;
}

/**
 * Standard login flow: wait for the login button to be enabled, fill
 * credentials, submit, then wait for wsnGame.loggedIn() to become true.
 */
async function loginPage(page, user, pass) {
    await page.waitForFunction(
        () => {
            const b = [...document.querySelectorAll("button")]
                .find((x) => /login/i.test(x.textContent || ""));
            return b && !b.disabled;
        },
        null, { timeout: 240000 }
    );
    const inp = page.locator("input");
    await inp.nth(0).fill(user);
    await inp.nth(1).fill(pass);
    await page.locator("button", { hasText: /^Login/ }).first().click();
    await page.waitForFunction(
        () => window.wsnGame && window.wsnGame.loggedIn && window.wsnGame.loggedIn() === true,
        null, { timeout: 60000 }
    );
}

module.exports = { TS_CLIENT, FAKE_MEDIA_ARGS, sleep, log, bootContext, loginPage };
