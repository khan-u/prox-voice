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
#include <cmath>
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

struct Burst {
    int idx;
    double tRefS;
    double latencyMs;
    double corrPeak;
    double qualityDb;
    bool kept;
};

// Parabolic sub-sample interpolation around an integer NCC peak → fractional bin offset.
double parabolicPeak(double ym1, double y0, double yp1) {
    double denom = 2.0 * (ym1 - 2.0 * y0 + yp1);
    if (std::fabs(denom) < 1e-12) return 0.0;
    return (ym1 - yp1) / denom;
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
    if (peaks.empty()) return 0;

    // Decimate for the cross-correlation search (lower rate → shorter NCC windows,
    // faster search). Full-rate envelope used only for click detection above.
    std::vector<float> refD = rigdsp::decimate(refEnv, p.decim);
    std::vector<float> micD = rigdsp::decimate(micEnv, p.decim);
    const double fsD = fs / (double)p.decim;

    // Noise floor: RMS of the first 0.5 s of the decimated mic envelope, before any
    // click arrives — used as the reference level for the quality-gate dB check.
    const size_t noiseWin = std::min((size_t)(0.5 * fsD), micD.size() / 4);
    double noiseSum = 0.0;
    for (size_t i = 0; i < noiseWin; i++) { noiseSum += (double)micD[i] * micD[i]; }
    const double noiseFloor = noiseWin > 0 ? std::sqrt(noiseSum / (double)noiseWin) : 1e-9;

    const size_t winD = (size_t)(p.winMs    / 1000.0 * fsD);
    const size_t preD = (size_t)(p.preMs    / 1000.0 * fsD);
    const size_t lagD = (size_t)(p.maxLagMs / 1000.0 * fsD);

    printf("\n%6s  %8s  %10s  %8s  %8s  %s\n",
           "burst", "t_ref_s", "latency_ms", "corr", "qual_db", "kept");

    std::vector<Burst> bursts;
    for (size_t bi = 0; bi < peaks.size(); bi++) {
        const size_t pkD      = peaks[bi] / (size_t)p.decim;
        const size_t refStart = (pkD >= preD) ? pkD - preD : 0;
        if (refStart + winD > refD.size()) continue;

        // Slide the mic window from refStart to refStart + lagD, maximise NCC.
        double bestCorr = -2.0;
        size_t bestLag  = 0;
        const size_t maxLag = (micD.size() > refStart + winD)
                              ? std::min(lagD, micD.size() - refStart - winD)
                              : 0;
        for (size_t lag = 0; lag <= maxLag; lag++) {
            if (refStart + lag + winD > micD.size()) break;
            double c = rigdsp::ncc(refD, refStart, micD, refStart + lag, winD);
            if (c > bestCorr) { bestCorr = c; bestLag = lag; }
        }

        // Parabolic refinement: fit a parabola through the three samples around
        // the integer-lag peak to recover the sub-sample maximum.
        double fracOff = 0.0;
        if (bestLag > 0 && bestLag < maxLag) {
            double ym1 = rigdsp::ncc(refD, refStart, micD, refStart + bestLag - 1, winD);
            double yp1 = rigdsp::ncc(refD, refStart, micD, refStart + bestLag + 1, winD);
            fracOff = parabolicPeak(ym1, bestCorr, yp1);
        }
        const double latencyMs = ((double)bestLag + fracOff) / fsD * 1000.0;

        // Quality gate 1: mic envelope level at echo onset vs noise floor (dB).
        const size_t echoIdx = std::min(refStart + bestLag + preD, micD.size() - 1);
        const double qDb = 20.0 * std::log10(std::max((double)micD[echoIdx], 1e-9)
                                             / std::max(noiseFloor, 1e-9));

        // Quality gate 2: absolute correlation coefficient threshold.
        const bool kept = (qDb >= p.minDb) && (bestCorr >= p.minCorr);

        bursts.push_back({ (int)bi + 1, (double)peaks[bi] / fs, latencyMs, bestCorr, qDb, kept });
        printf("%6d  %8.3f  %10.2f  %8.4f  %8.2f  %s\n",
               (int)bi + 1, (double)peaks[bi] / fs, latencyMs, bestCorr, qDb, kept ? "Y" : "-");
    }

    int keptN = 0;
    for (const auto& b : bursts) { if (b.kept) keptN++; }
    printf("\nbursts: %zu total, %d kept (both quality gates passed)\n", bursts.size(), keptN);
    return 0;
}
