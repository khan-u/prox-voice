import { describe, it, expect } from "vitest";
import {
    energyLevel, energySource, lossPct, upKbps, VIRTUAL_BUDGET_BYTES,
} from "./sensing";

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
