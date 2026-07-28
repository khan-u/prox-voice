// PROX-VOICE acoustic loopback rig — stimulus generator.
//
// Renders the click train: a 5 ms, 2 kHz raised-cosine (Hann-windowed) tone
// burst once every 2 s. A windowed burst localizes cleanly under
// cross-correlation and survives Opus far better than a true impulse, which the
// codec would smear. The output is a mono WAV, played into device A both
// acoustically and, via a splitter, into the recorder's zero-delay reference.
#include "wav.hpp"
#include <cmath>
#include <cstdio>

namespace {

struct Params {
    double fs = 48000.0;
    double freq = 2000.0;
    double burstMs = 5.0;
    double periodS = 2.0;
    double amp = 0.7;
    int bursts = 100;
    std::string out = "stimulus.wav";
};

// Each period begins with one Hann-windowed tone burst, then silence.
bool synthClickTrain(const Params& p, rigwav::Wav& w) {
    const long burstN  = (long)llround(p.burstMs / 1000.0 * p.fs);
    const long periodN = (long)llround(p.periodS * p.fs);
    if (burstN <= 1 || periodN <= burstN || p.bursts <= 0) { return false; }

    w.sampleRate = (uint32_t)llround(p.fs);
    w.channels = 1;
    w.samples.assign((size_t)periodN * (size_t)p.bursts, 0.0f);

    for (int b = 0; b < p.bursts; b++) {
        const long base = (long)b * periodN;
        for (long k = 0; k < burstN; k++) {
            double win = 0.5 * (1.0 - std::cos(2.0 * M_PI * (double)k / (double)(burstN - 1)));
            double s = p.amp * win * std::sin(2.0 * M_PI * p.freq * (double)k / p.fs);
            w.samples[(size_t)(base + k)] = (float)s;
        }
    }
    return true;
}

}   // namespace

int main() {
    Params p;
    rigwav::Wav w;
    if (!synthClickTrain(p, w)) { fprintf(stderr, "bad parameters (burst must fit inside period)\n"); return 2; }

    std::string err;
    if (!rigwav::write16(p.out, w, &err)) { fprintf(stderr, "write failed: %s\n", err.c_str()); return 1; }
    printf("wrote %s: %d bursts, %.1f s, %.0f Hz burst of %.1f ms every %.2f s @ %.0f Hz\n",
           p.out.c_str(), p.bursts, (double)w.samples.size() / p.fs, p.freq, p.burstMs, p.periodS, p.fs);
    return 0;
}
