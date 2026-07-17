import { describe, it, expect } from "vitest";
import {
    energyLevel, energySource, VIRTUAL_BUDGET_BYTES,
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
