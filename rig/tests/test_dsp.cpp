// Unit checks for the analyzer DSP: the band-pass keeps energy at its centre and
// rejects a far-off tone, and the envelope tracks a burst's amplitude.
#include "../dsp.hpp"
#include <cmath>
#include <cstdio>
#include <vector>

static int failures = 0;
#define CHECK(cond) do { if (!(cond)) { printf("  FAIL: %s (line %d)\n", #cond, __LINE__); failures++; } } while (0)

static std::vector<float> tone(double fs, double f, size_t n) {
    std::vector<float> v(n);
    for (size_t i = 0; i < n; i++) { v[i] = (float)std::sin(2.0 * M_PI * f * i / fs); }
    return v;
}

static double rms(const std::vector<float>& v) {
    double s = 0; for (float x : v) { s += (double)x * x; }
    return v.empty() ? 0 : std::sqrt(s / v.size());
}

int main() {
    const double fs = 48000;

    // Band-pass at 2 kHz, Q=4: a 2 kHz tone passes, a 200 Hz tone is knocked down.
    rigdsp::Biquad bp; bp.bandpass(fs, 2000, 4);
    std::vector<float> onBand, offBand;
    bp.run(tone(fs, 2000, 4800), onBand);
    bp.run(tone(fs, 200, 4800), offBand);
    // skip the filter warm-up transient
    std::vector<float> onTail(onBand.begin() + 480, onBand.end());
    std::vector<float> offTail(offBand.begin() + 480, offBand.end());
    CHECK(rms(onTail) > 0.6);              // passband roughly preserved
    CHECK(rms(offTail) < 0.1 * rms(onTail));   // far-off tone strongly rejected

    // Envelope of a half-amplitude tone settles near its rectified mean (2/pi * A).
    std::vector<float> env;
    rigdsp::envelope(tone(fs, 2000, 4800), env, fs, 0.002);
    double tail = 0; int c = 0;
    for (size_t i = 4000; i < env.size(); i++) { tail += env[i]; c++; }
    tail /= c;
    CHECK(tail > 0.4 && tail < 0.75);

    // Decimation keeps every d-th sample.
    std::vector<float> in = {0, 1, 2, 3, 4, 5, 6, 7};
    auto dec = rigdsp::decimate(in, 4);
    CHECK(dec.size() == 2);
    CHECK(dec[0] == 0.0f && dec[1] == 4.0f);

    // NCC: a window with itself is 1.0; a window against a shifted copy is lower.
    std::vector<float> sig = tone(fs, 1000, 2048);
    CHECK(std::fabs(rigdsp::ncc(sig, 0, sig, 0, 512) - 1.0) < 1e-9);
    CHECK(rigdsp::ncc(sig, 0, sig, 7, 512) < 0.99);   // quarter-period-ish shift decorrelates

    // Percentile: interpolated median and p95 of a known ramp.
    std::vector<double> ramp;
    for (int i = 0; i <= 100; i++) { ramp.push_back((double)i); }
    CHECK(std::fabs(rigdsp::percentile(ramp, 50) - 50.0) < 1e-9);
    CHECK(std::fabs(rigdsp::percentile(ramp, 95) - 95.0) < 1e-9);
    CHECK(rigdsp::percentile({}, 50) == 0.0);

    printf("%s: test_dsp (%d checks failed)\n", failures ? "FAIL" : "PASS", failures);
    return failures ? 1 : 0;
}
