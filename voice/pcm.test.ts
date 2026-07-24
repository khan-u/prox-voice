import { describe, it, expect } from "vitest";
import { flatten, downsample, peakAmplitude } from "./pcm";

describe("flatten", () => {
    it("concatenates frames in order", () => {
        const out = flatten([new Float32Array([1, 2]), new Float32Array([3]), new Float32Array([4, 5])]);
        expect(Array.from(out)).toEqual([1, 2, 3, 4, 5]);
    });
    it("returns an empty buffer for no frames", () => {
        expect(flatten([]).length).toBe(0);
    });
});

describe("downsample", () => {
    it("returns the input untouched when rates match", () => {
        const input = new Float32Array([0, 0.5, 1]);
        expect(downsample(input, 16000, 16000)).toBe(input);
    });
    it("halves the length at a 2:1 ratio and interpolates", () => {
        const input = new Float32Array([0, 1, 2, 3]);
        const out = downsample(input, 32000, 16000);
        expect(out.length).toBe(2);
        expect(out[0]).toBeCloseTo(0, 6);
        expect(out[1]).toBeCloseTo(2, 6);
    });
});

describe("peakAmplitude", () => {
    it("finds the largest absolute sample", () => {
        expect(peakAmplitude(new Float32Array([0.1, -0.8, 0.3]))).toBeCloseTo(0.8, 6);
        expect(peakAmplitude(new Float32Array([]))).toBe(0);
    });
});
