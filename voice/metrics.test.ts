import { describe, it, expect } from "vitest";
import {
    LinkMetric,
    newLinkRecord, shouldRedetect, applyState, applyCalibration,
    normalizeCandidate, jitterBufferAvgMs, m2eEstimate, percentile, summarizeKpis,
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

describe("percentile (nearest-rank)", () => {
    it("returns -1 for an empty sample", () => {
        expect(percentile([], 50)).toBe(-1);
    });
    it("takes the nearest rank, order-independent", () => {
        expect(percentile([50, 10, 30, 40, 20], 50)).toBe(30);
        expect(percentile([50, 10, 30, 40, 20], 95)).toBe(50);
        expect(percentile([850], 95)).toBe(850);
    });
});

describe("jitter-buffer average", () => {
    it("uses the delta between reads once a prior read exists", () => {
        // 0.20 s over 100 samples since the last read = 2 ms/sample.
        expect(jitterBufferAvgMs({ delay: 1.0, count: 400 }, 1.2, 500)).toBeCloseTo(2, 6);
    });
    it("falls back to the lifetime mean on the first read", () => {
        expect(jitterBufferAvgMs(undefined, 1.0, 500)).toBeCloseTo(2, 6);
    });
    it("returns -1 when the counters are unpopulated", () => {
        expect(jitterBufferAvgMs(undefined, -1, -1)).toBe(-1);
        expect(jitterBufferAvgMs(undefined, 1.0, 0)).toBe(-1);
    });
    it("builds the estimate as RTT/2 + jitter + device constant", () => {
        expect(m2eEstimate(0.044, 16)).toBe(Math.round(22 + 16 + 40));   // 78 ms
    });
});

describe("normalizeCandidate", () => {
    it("folds peer-reflexive into srflx and passes others through", () => {
        expect(normalizeCandidate("prflx")).toBe("srflx");
        expect(normalizeCandidate("host")).toBe("host");
        expect(normalizeCandidate("relay")).toBe("relay");
    });
});

describe("KPI roll-up", () => {
    const link = (over: Partial<LinkMetric>): LinkMetric => ({ ...newLinkRecord(0, 0), ...over });

    it("scores ICE success, setup percentiles, relay share, and glare", () => {
        const links: LinkMetric[] = [
            link({ connectedMs: 1, setupMs: 500, candidateType: "host", latRawMs: 70, glare: 1 }),
            link({ connectedMs: 1, setupMs: 900, candidateType: "relay", latRawMs: 90 }),
            link({ failed: true }),   // never connected
        ];
        const k = summarizeKpis(links, false);
        expect(k.links).toBe(2);
        expect(k.iceAttempts).toBe(3);
        expect(k.iceSuccessPct).toBe(67);
        expect(k.setupMedianMs).toBe(500);
        expect(k.relayPct).toBe(50);
        expect(k.candidateMix).toEqual({ host: 1, srflx: 0, relay: 1 });
        expect(k.latRawMedianMs).toBe(70);
        expect(k.glareTotal).toBe(1);
        expect(k.latCalMedianMs).toBe(-1);   // uncalibrated
    });

    it("reports -1 ICE success when there were no attempts", () => {
        expect(summarizeKpis([], false).iceSuccessPct).toBe(-1);
    });
});
