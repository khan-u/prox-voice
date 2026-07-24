// Round-trip check for wav.hpp: write interleaved float as PCM16, read it back,
// and confirm the header and samples survive (within 16-bit quantization).
#include "../wav.hpp"
#include <cmath>
#include <cstdio>
#include <string>

static int failures = 0;
#define CHECK(cond) do { if (!(cond)) { printf("  FAIL: %s (line %d)\n", #cond, __LINE__); failures++; } } while (0)

int main() {
    rigwav::Wav w;
    w.sampleRate = 44100;
    w.channels = 2;
    for (int i = 0; i < 200; i++) {
        w.samples.push_back(std::sin(0.10f * i));   // ch 0
        w.samples.push_back(std::sin(0.05f * i));   // ch 1
    }

    const std::string path = "/tmp/rig_roundtrip.wav";
    std::string err;
    CHECK(rigwav::write16(path, w, &err));

    rigwav::Wav r;
    CHECK(rigwav::read(path, r, &err));
    CHECK(r.sampleRate == 44100);
    CHECK(r.channels == 2);
    CHECK(r.samples.size() == w.samples.size());
    CHECK(r.frames() == 200);

    double maxErr = 0.0;
    for (size_t i = 0; i < r.samples.size(); i++) {
        maxErr = std::fmax(maxErr, std::fabs((double)r.samples[i] - w.samples[i]));
    }
    CHECK(maxErr < 2.0 / 32768.0);   // PCM16 step, incl. the 32767/32768 scale asymmetry

    printf("%s: test_wav (%d checks failed)\n", failures ? "FAIL" : "PASS", failures);
    return failures ? 1 : 0;
}
