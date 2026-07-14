import { describe, it, expect } from "vitest";
import {
    newLinkRecord, shouldRedetect, applyState, applyCalibration,
} from "./metrics";

describe("link record lifecycle", () => {
    it("stamps setup time on the first connected transition", () => {
        const rec = newLinkRecord(7, 1000);
        applyState(rec, "connecting", 1200);
        expect(rec.connectedMs).toBe(-1);
        applyState(rec, "connected", 1850);
        expect(rec.setupMs).toBe(850);
        expect(rec.failed).toBe(false);
    });

    it("counts a never-connected link as a failure", () => {
        const rec = newLinkRecord(7, 1000);
        applyState(rec, "failed", 1400);
        expect(rec.failed).toBe(true);
        expect(rec.connectedMs).toBe(-1);
    });

    it("clears a transient failure that later recovers", () => {
        const rec = newLinkRecord(7, 1000);
        applyState(rec, "failed", 1400);
        applyState(rec, "connected", 1600);
        expect(rec.failed).toBe(false);
        expect(rec.setupMs).toBe(600);
    });

    it("keeps a pending record but replaces a settled one on re-detection", () => {
        const pending = newLinkRecord(7, 1000);
        expect(shouldRedetect(pending)).toBe(false);
        const connected = newLinkRecord(7, 1000);
        applyState(connected, "connected", 1500);
        expect(shouldRedetect(connected)).toBe(true);
        expect(shouldRedetect(undefined)).toBe(true);
    });

    it("only calibrates links that already have a raw estimate", () => {
        const rec = newLinkRecord(7, 1000);
        applyCalibration(rec, 12);
        expect(rec.latCalMs).toBe(-1);   // no raw estimate yet
        rec.latRawMs = 78;
        applyCalibration(rec, 12);
        expect(rec.latCalMs).toBe(90);
    });
});
