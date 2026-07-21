import { describe, it, expect } from "vitest";
import { mungeDtx } from "./sdp";

const OPUS_SDP = [
    "v=0",
    "m=audio 9 UDP/TLS/RTP/SAVPF 111",
    "a=rtpmap:111 opus/48000/2",
    "a=fmtp:111 minptime=10;useinbandfec=1",
].join("\r\n");

describe("mungeDtx", () => {
    it("appends usedtx=1 to an existing Opus fmtp line", () => {
        const out = mungeDtx(OPUS_SDP);
        expect(out).toContain("a=fmtp:111 minptime=10;useinbandfec=1;usedtx=1");
    });

    it("is idempotent — it won't add usedtx twice", () => {
        const once = mungeDtx(OPUS_SDP);
        expect(mungeDtx(once)).toBe(once);
    });

    it("adds an fmtp line when the payload has none", () => {
        const bare = "m=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=rtpmap:111 opus/48000/2";
        expect(mungeDtx(bare)).toContain("a=fmtp:111 usedtx=1");
    });

    it("leaves a description with no Opus payload untouched", () => {
        const pcma = "m=audio 9 UDP/TLS/RTP/SAVPF 8\r\na=rtpmap:8 PCMA/8000";
        expect(mungeDtx(pcma)).toBe(pcma);
        expect(mungeDtx("")).toBe("");
    });
});
