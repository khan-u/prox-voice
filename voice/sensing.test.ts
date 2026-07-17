import { describe, it, expect } from "vitest";
import {
    LinkReading,
    energyLevel, energySource, lossPct, upKbps, suppressedPct, detectEvent,
    VIRTUAL_BUDGET_BYTES,
} from "./sensing";

const reading = (over: Partial<LinkReading>): LinkReading =>
    ({ index: 0, state: "connected", rttMs: -1, jitterMs: -1, lossPct: -1, upKbps: -1, ...over });

describe("energy model priority", () => {
    it("prefers a forced value over everything", () => {
        expect(energyLevel(0.15, 0.9, VIRTUAL_BUDGET_BYTES)).toBe(0.15);
        expect(energySource(0.15, 0.9)).toBe("forced");
    });
    it("uses the real battery when no forced value is set", () => {
        expect(energyLevel(null, 0.8, VIRTUAL_BUDGET_BYTES / 2)).toBe(0.8);
        expect(energySource(null, 0.8)).toBe("battery");
    });
    it("falls back to the virtual budget, debited by bytes sent", () => {
        expect(energyLevel(null, null, 0)).toBe(1);
        expect(energyLevel(null, null, VIRTUAL_BUDGET_BYTES / 4)).toBeCloseTo(0.75, 6);
        expect(energyLevel(null, null, VIRTUAL_BUDGET_BYTES * 2)).toBe(0);   // clamped
        expect(energySource(null, null)).toBe("virtual");
    });
});

describe("link-reading arithmetic", () => {
    it("computes one-decimal loss percentage, -1 when nothing arrived", () => {
        expect(lossPct(0, 0)).toBe(-1);
        expect(lossPct(5, 995)).toBe(0.5);
        expect(lossPct(2, 98)).toBe(2);
    });
    it("computes uplink kbps from a byte/time delta", () => {
        expect(upKbps(3000, 1000)).toBe(24);   // 3000 B/s ≈ 24 kbit/s
        expect(upKbps(0, 1000)).toBe(0);
        expect(upKbps(100, 0)).toBe(-1);        // no elapsed time
    });
});

describe("suppression ratio", () => {
    it("is the reported share of samples, 0 before any sample", () => {
        expect(suppressedPct(0, 0)).toBe(0);
        expect(suppressedPct(100, 91)).toBe(91);
    });
});

describe("event detection against the last reported state", () => {
    const one = [reading({ index: 5, rttMs: 40, lossPct: 0 })];
    const known = new Map([[5, reading({ index: 5, rttMs: 40, lossPct: 0 })]]);

    it("reports the first position fix, then movement past the threshold", () => {
        expect(detectEvent(one, known, { x: 10, y: 10 }, null)?.kind).toBe("move");
        expect(detectEvent(one, known, { x: 16, y: 10 }, { x: 10, y: 10 })?.kind).toBe("move");  // 6 tiles
        expect(detectEvent(one, known, { x: 13, y: 12 }, { x: 10, y: 10 })).toBeNull();           // ~3.6 tiles
    });

    it("flags a change in the neighbour set as topology", () => {
        expect(detectEvent([], known, null, null)?.kind).toBe("topology");
    });

    it("flags a state change and a large RTT shift, ignoring small ones", () => {
        expect(detectEvent([reading({ index: 5, state: "failed", rttMs: 40 })], known, null, null)?.kind).toBe("link");
        expect(detectEvent([reading({ index: 5, rttMs: 90, lossPct: 0 })], known, null, null)?.kind).toBe("link");
        expect(detectEvent([reading({ index: 5, rttMs: 48, lossPct: 0 })], known, null, null)).toBeNull();
    });

    it("flags a loss increase past the threshold", () => {
        expect(detectEvent([reading({ index: 5, rttMs: 40, lossPct: 3 })], known, null, null)?.kind).toBe("link");
    });
});
