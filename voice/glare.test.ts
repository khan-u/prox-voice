import { describe, it, expect } from "vitest";
import { isPolite, isColliding, shouldIgnoreOffer } from "./glare";

describe("glare resolution", () => {
    it("makes the lower nonce polite", () => {
        expect(isPolite(10, 20)).toBe(true);
        expect(isPolite(20, 10)).toBe(false);
    });

    it("treats an in-flight offer or a non-stable state as a collision", () => {
        expect(isColliding(true, "stable")).toBe(true);
        expect(isColliding(false, "have-local-offer")).toBe(true);
        expect(isColliding(false, "stable")).toBe(false);
    });

    it("ignores an offer only when impolite and colliding", () => {
        // impolite (higher nonce) + colliding → ignore
        expect(shouldIgnoreOffer(20, 10, true, "stable")).toBe(true);
        // polite (lower nonce) always accepts, even mid-offer
        expect(shouldIgnoreOffer(10, 20, true, "have-local-offer")).toBe(false);
        // impolite but no collision → accept
        expect(shouldIgnoreOffer(20, 10, false, "stable")).toBe(false);
    });
});
