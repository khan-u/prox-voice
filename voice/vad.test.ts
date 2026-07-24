import { describe, it, expect } from "vitest";
import {
    rmsFromBytes, newVadState, stepVad,
    VAD_OPEN_MS, VAD_HANG_MS, VAD_POLL_MS,
} from "./vad";

describe("rmsFromBytes", () => {
    it("is zero for a silent (centered) buffer", () => {
        expect(rmsFromBytes(new Uint8Array([128, 128, 128, 128]))).toBe(0);
    });
    it("rises with excursion from the 128 centre", () => {
        const loud = rmsFromBytes(new Uint8Array([0, 255, 0, 255]));
        expect(loud).toBeGreaterThan(0.9);
    });
});

describe("VAD hysteresis", () => {
    const drive = (rms: number, ms: number) => {
        const st = newVadState();
        const edges: string[] = [];
        for (let t = 0; t < ms; t += VAD_POLL_MS) {
            const e = stepVad(st, rms, VAD_POLL_MS);
            if (e) { edges.push(e); }
        }
        return { st, edges };
    };

    it("opens only after sustained energy above the open threshold", () => {
        // one poll above threshold is not enough
        const brief = drive(0.1, VAD_POLL_MS);
        expect(brief.st.active).toBe(false);
        // sustained past VAD_OPEN_MS opens exactly once
        const held = drive(0.1, VAD_OPEN_MS + VAD_POLL_MS);
        expect(held.edges).toEqual(["open"]);
        expect(held.st.active).toBe(true);
    });

    it("holds through a brief dip, then closes after the hang", () => {
        const st = newVadState();
        for (let t = 0; t < VAD_OPEN_MS + VAD_POLL_MS; t += VAD_POLL_MS) { stepVad(st, 0.1, VAD_POLL_MS); }
        expect(st.active).toBe(true);

        // a short quiet dip shorter than the hang keeps the slot
        stepVad(st, 0.0, VAD_POLL_MS);
        expect(st.active).toBe(true);

        // sustained quiet past the hang releases it
        let closed = false;
        for (let t = 0; t < VAD_HANG_MS + VAD_POLL_MS; t += VAD_POLL_MS) {
            if (stepVad(st, 0.0, VAD_POLL_MS) === "close") { closed = true; }
        }
        expect(closed).toBe(true);
        expect(st.active).toBe(false);
    });
});
