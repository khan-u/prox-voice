/**
 * node:test unit checks for wsn-client.cjs.
 * Run: node --test experiments/lib/wsn-client.test.cjs
 */
const { test } = require("node:test");
const assert   = require("node:assert/strict");
const { TS_CLIENT, FAKE_MEDIA_ARGS, sleep, log, bootContext, loginPage } = require("./wsn-client.cjs");

test("TS_CLIENT is a non-empty string", () => {
    assert.equal(typeof TS_CLIENT, "string");
    assert.ok(TS_CLIENT.length > 0);
});

test("FAKE_MEDIA_ARGS contains the required headless-media flags", () => {
    assert.ok(Array.isArray(FAKE_MEDIA_ARGS));
    assert.ok(FAKE_MEDIA_ARGS.some((f) => f.includes("fake-device-for-media-stream")));
    assert.ok(FAKE_MEDIA_ARGS.some((f) => f.includes("fake-ui-for-media-stream")));
    assert.ok(FAKE_MEDIA_ARGS.some((f) => f.includes("autoplay-policy")));
});

test("sleep resolves after approximately the requested delay", async () => {
    const t0 = Date.now();
    await sleep(50);
    const elapsed = Date.now() - t0;
    assert.ok(elapsed >= 40 && elapsed < 500, `elapsed=${elapsed} ms — expected 40-500`);
});

test("log does not throw", () => {
    assert.doesNotThrow(() => log("test message", 42));
});

test("bootContext is exported as a function", () => {
    assert.equal(typeof bootContext, "function");
});

test("loginPage is exported as a function", () => {
    assert.equal(typeof loginPage, "function");
});
