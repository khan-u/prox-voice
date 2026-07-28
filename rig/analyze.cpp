// PROX-VOICE acoustic loopback rig — cross-correlation analyzer.
//
// Input: one stereo WAV recorded on a single clock, so no clock sync is needed.
// Channel 0 (ref) is the wired split of the stimulus at the instant each click
// is born; channel 1 (mic) is the microphone at device B's speaker — the same
// click after crossing A's capture stack, the mesh link under test, and B's
// playout stack. The gap between a ref click and its mic echo is the
// mouth-to-ear latency.
//
// Pipeline: band-pass both channels around 2 kHz, envelope-detect, locate each
// stimulus click in ref, then for each click find the first strong
// cross-correlation peak in mic within a search window. The DSP itself lives in
// dsp.hpp; this file is the pipeline, the quality gates, and the reporting.
#include "wav.hpp"
#include "dsp.hpp"
#include <algorithm>
#include <cstdio>
#include <string>
#include <vector>

namespace {

struct Params {
    std::string path;
    int refCh = 0, micCh = 1, decim = 16;
    double freq = 2000, q = 4, envMs = 2, winMs = 30, preMs = 5, maxLagMs = 1000;
    double thrFrac = 0.30, minDb = 6.0, minCorr = 0.5, histBinMs = 10.0;
};

// Locate stimulus clicks in the clean reference envelope (full rate for accuracy).
std::vector<size_t> findClicks(const std::vector<float>& refEnv, double fs, double thrFrac, double maxLagMs) {
    double mx = 0.0;
    for (float v : refEnv) { mx = std::max(mx, (double)v); }
    const double thr = thrFrac * mx;
    const size_t minGap = (size_t)(maxLagMs / 1000.0 * fs * 1.5 + 1);   // 1.5× search window: guard so an echo can't be mistaken for the next click onset

    std::vector<size_t> peaks;
    const size_t F = refEnv.size();
    for (size_t i = 0; i < F;) {
        if (refEnv[i] >= thr) {
            size_t best = i;
            double bv = refEnv[i];
            size_t lim = std::min(F, i + minGap);
            for (size_t j = i; j < lim && refEnv[j] >= thr * 0.5; j++) {
                if (refEnv[j] > bv) { bv = refEnv[j]; best = j; }
            }
            peaks.push_back(best);
            i = best + minGap;
        } else {
            i++;
        }
    }
    return peaks;
}

}   // namespace

int main(int argc, char** argv) {
    if (argc < 2) { fprintf(stderr, "usage: %s REC.wav [options]  (try --help)\n", argv[0]); return 2; }
    Params p;
    p.path = argv[1];

    rigwav::Wav w;
    std::string err;
    if (!rigwav::read(p.path, w, &err)) { fprintf(stderr, "read failed: %s\n", err.c_str()); return 1; }
    if (w.channels < 2) { fprintf(stderr, "need a stereo recording (ref + mic); got %u channel(s)\n", w.channels); return 1; }

    const double fs = (double)w.sampleRate;
    const size_t F = w.frames();
    std::vector<float> ref(F), mic(F);
    for (size_t i = 0; i < F; i++) {
        ref[i] = w.samples[i * w.channels + (size_t)p.refCh];
        mic[i] = w.samples[i * w.channels + (size_t)p.micCh];
    }

    // Band-pass → envelope (full rate) → decimate for the correlation search.
    rigdsp::Biquad bp;
    bp.bandpass(fs, p.freq, p.q);
    std::vector<float> refBp, micBp, refEnv, micEnv;
    bp.run(ref, refBp);
    bp.run(mic, micBp);
    rigdsp::envelope(refBp, refEnv, fs, p.envMs / 1000.0);
    rigdsp::envelope(micBp, micEnv, fs, p.envMs / 1000.0);

    std::vector<size_t> peaks = findClicks(refEnv, fs, p.thrFrac, p.maxLagMs);

    printf("PROX-VOICE loopback rig — input %s (%.1f s, %u ch @ %.0f Hz), clicks found: %zu\n",
           p.path.c_str(), (double)F / fs, w.channels, fs, peaks.size());
    return 0;
}
