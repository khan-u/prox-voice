// Minimal, self-contained WAV I/O for the PROX-VOICE acoustic loopback rig.
//
// Purpose-built rather than vendoring a large single-header library: it reads the
// formats a class-compliant USB interface / ffmpeg / sox actually produce
// (PCM 16/24/32-bit and IEEE float32, mono or stereo) and writes PCM16. Samples
// are carried as interleaved float in [-1, 1] regardless of the on-disk format.
#pragma once
#include <cstdint>
#include <cstring>
#include <cstdio>
#include <cmath>
#include <string>
#include <vector>

namespace rigwav {

struct Wav {
    uint32_t sampleRate = 48000;
    uint16_t channels = 1;
    std::vector<float> samples;   // interleaved, normalized to [-1, 1]
    size_t frames() const { return channels ? samples.size() / channels : 0; }
};

namespace detail {
inline uint32_t rd_u32(const uint8_t* p) {
    return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}
inline uint16_t rd_u16(const uint8_t* p) { return (uint16_t)(p[0] | (p[1] << 8)); }
}   // namespace detail

// Read a RIFF/WAVE file into `out`. Returns false (with *err set) on any problem.
inline bool read(const std::string& path, Wav& out, std::string* err = nullptr) {
    FILE* f = fopen(path.c_str(), "rb");
    if (!f) { if (err) *err = "cannot open " + path; return false; }
    fseek(f, 0, SEEK_END);
    long sz = ftell(f);
    fseek(f, 0, SEEK_SET);
    if (sz < 44) { if (err) *err = "file too small to be WAV"; fclose(f); return false; }
    std::vector<uint8_t> buf((size_t)sz);
    size_t got = fread(buf.data(), 1, (size_t)sz, f);
    fclose(f);
    if (got != (size_t)sz) { if (err) *err = "short read"; return false; }

    if (memcmp(buf.data(), "RIFF", 4) != 0 || memcmp(buf.data() + 8, "WAVE", 4) != 0) {
        if (err) *err = "not a RIFF/WAVE file";
        return false;
    }

    uint16_t fmt = 0, ch = 0, bits = 0;
    uint32_t rate = 0;
    bool haveFmt = false;
    const uint8_t* dataPtr = nullptr;
    uint32_t dataLen = 0;

    size_t off = 12;   // skip "RIFF" <size> "WAVE"
    while (off + 8 <= (size_t)sz) {
        const uint8_t* c = buf.data() + off;
        uint32_t clen = detail::rd_u32(c + 4);
        const uint8_t* body = c + 8;
        if (memcmp(c, "fmt ", 4) == 0 && clen >= 16) {
            fmt  = detail::rd_u16(body + 0);
            ch   = detail::rd_u16(body + 2);
            rate = detail::rd_u32(body + 4);
            bits = detail::rd_u16(body + 14);
            if (fmt == 0xFFFE && clen >= 40) { fmt = detail::rd_u16(body + 24); }   // WAVE_FORMAT_EXTENSIBLE subformat
            haveFmt = true;
        } else if (memcmp(c, "data", 4) == 0) {
            dataPtr = body;
            dataLen = clen;
            if (off + 8 + (size_t)clen > (size_t)sz) { dataLen = (uint32_t)(sz - (off + 8)); }   // clamp a truncated tail
        }
        off += 8 + clen + (clen & 1);   // chunks are word-aligned
    }

    if (!haveFmt || !dataPtr) { if (err) *err = "missing fmt/ or data chunk"; return false; }
    if (ch == 0 || bits == 0) { if (err) *err = "invalid channel count or bit depth"; return false; }

    out.sampleRate = rate;
    out.channels = ch;
    size_t bytesPer = bits / 8;
    size_t n = dataLen / bytesPer;
    out.samples.resize(n);

    if (fmt == 1) {                       // integer PCM
        if (bits == 16) {
            for (size_t i = 0; i < n; i++) {
                int16_t v = (int16_t)detail::rd_u16(dataPtr + i * 2);
                out.samples[i] = v / 32768.0f;
            }
        } else if (bits == 24) {
            for (size_t i = 0; i < n; i++) {
                const uint8_t* p = dataPtr + i * 3;
                int32_t v = (int32_t)(p[0] | (p[1] << 8) | (p[2] << 16));
                if (v & 0x800000) { v |= ~0xFFFFFF; }   // sign-extend
                out.samples[i] = v / 8388608.0f;
            }
        } else if (bits == 32) {
            for (size_t i = 0; i < n; i++) {
                int32_t v = (int32_t)detail::rd_u32(dataPtr + i * 4);
                out.samples[i] = (float)(v / 2147483648.0);
            }
        } else {
            if (err) *err = "unsupported PCM bit depth";
            return false;
        }
    } else if (fmt == 3 && bits == 32) {  // IEEE float
        for (size_t i = 0; i < n; i++) {
            float v;
            memcpy(&v, dataPtr + i * 4, 4);
            out.samples[i] = v;
        }
    } else {
        if (err) *err = "unsupported WAV sample format";
        return false;
    }
    return true;
}

// Write interleaved float samples as 16-bit PCM.
inline bool write16(const std::string& path, const Wav& w, std::string* err = nullptr) {
    FILE* f = fopen(path.c_str(), "wb");
    if (!f) { if (err) *err = "cannot write " + path; return false; }

    const uint16_t ch = w.channels ? w.channels : 1;
    const uint32_t rate = w.sampleRate;
    const uint16_t bits = 16;
    const uint16_t blockAlign = (uint16_t)(ch * bits / 8);
    const uint32_t byteRate = rate * blockAlign;
    const uint32_t dataBytes = (uint32_t)w.samples.size() * 2;
    const uint32_t riff = 36 + dataBytes;

    auto w32 = [&](uint32_t v) { uint8_t b[4] = { (uint8_t)v, (uint8_t)(v >> 8), (uint8_t)(v >> 16), (uint8_t)(v >> 24) }; fwrite(b, 1, 4, f); };
    auto w16 = [&](uint16_t v) { uint8_t b[2] = { (uint8_t)v, (uint8_t)(v >> 8) }; fwrite(b, 1, 2, f); };

    fwrite("RIFF", 1, 4, f); w32(riff); fwrite("WAVE", 1, 4, f);
    fwrite("fmt ", 1, 4, f); w32(16); w16(1); w16(ch); w32(rate); w32(byteRate); w16(blockAlign); w16(bits);
    fwrite("data", 1, 4, f); w32(dataBytes);
    for (float s : w.samples) {
        if (s > 1.0f) s = 1.0f;
        if (s < -1.0f) s = -1.0f;
        int32_t v = (int32_t)lrintf(s * 32767.0f);
        w16((uint16_t)(int16_t)v);
    }
    fclose(f);
    return true;
}

}   // namespace rigwav
