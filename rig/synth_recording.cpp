// PROX-VOICE acoustic loopback rig — synthetic recording (test fixture).
//
// Fabricates the stereo WAV the real rig would capture, so the analyzer can be
// validated with no hardware. Channel 0 is the stimulus at its true birth time
// (the zero-delay wired reference); channel 1 is the same stimulus delayed by a
// known amount, attenuated, and buried in Gaussian noise (the acoustic mic
// path). Equal pre-roll silence is prepended to both channels to mimic an
// arbitrary record start — that common offset must cancel in the measured
// latency, which is a genuine robustness check. Run analyze on the output and
// confirm it recovers --delay-ms.
#include "wav.hpp"
#include <cmath>
#include <cstdio>
#include <random>
#include <string>

namespace {

struct Params {
    std::string in = "stimulus.wav";
    std::string out = "synth_rec.wav";
    double delayMs = 85.0;
    double gain = 0.5;
    double noise = 0.02;
    double prerollMs = 250.0;
    unsigned seed = 42;
};

// ch0 = reference (stimulus after pre-roll); ch1 = delayed, attenuated, + noise.
void mix(const rigwav::Wav& s, const Params& p, rigwav::Wav& o) {
    const double fs = (double)s.sampleRate;
    const size_t N = s.frames();
    const size_t delayN   = (size_t)llround(p.delayMs / 1000.0 * fs);
    const size_t prerollN = (size_t)llround(p.prerollMs / 1000.0 * fs);
    const size_t outN = prerollN + N + delayN;   // room for the delayed tail

    o.sampleRate = s.sampleRate;
    o.channels = 2;
    o.samples.assign(outN * 2, 0.0f);

    std::mt19937 rng(p.seed);
    std::normal_distribution<double> gauss(0.0, p.noise);

    for (size_t i = 0; i < outN; i++) {
        double r = 0.0;
        if (i >= prerollN && (i - prerollN) < N) { r = s.samples[i - prerollN]; }
        double m = gauss(rng);
        if (i >= prerollN + delayN && (i - prerollN - delayN) < N) { m += p.gain * s.samples[i - prerollN - delayN]; }
        o.samples[i * 2 + 0] = (float)r;
        o.samples[i * 2 + 1] = (float)m;
    }
}

}   // namespace

int main() {
    Params p;
    rigwav::Wav s;
    std::string err;
    if (!rigwav::read(p.in, s, &err)) { fprintf(stderr, "read failed: %s\n", err.c_str()); return 1; }
    if (s.channels != 1) { fprintf(stderr, "expected a mono stimulus; got %u channels\n", s.channels); return 1; }

    rigwav::Wav o;
    mix(s, p, o);
    if (!rigwav::write16(p.out, o, &err)) { fprintf(stderr, "write failed: %s\n", err.c_str()); return 1; }
    printf("wrote %s: stereo, %.1f s, injected delay %.1f ms (gain %.2f, noise sd %.3f, preroll %.0f ms)\n",
           p.out.c_str(), (double)o.frames() / o.sampleRate, p.delayMs, p.gain, p.noise, p.prerollMs);
    return 0;
}
