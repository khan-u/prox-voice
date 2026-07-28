// Pure DSP for the loopback analyzer, split out from analyze.cpp so it can be
// unit-tested on its own: an RBJ band-pass biquad, an amplitude envelope, and
// decimation. No I/O, no argument parsing.
#pragma once
#include <algorithm>
#include <cmath>
#include <cstddef>
#include <vector>

namespace rigdsp {

// RBJ constant-skirt band-pass, direct form I. The same filter runs on both
// channels in the analyzer, so its group delay is common-mode and cancels.
struct Biquad {
    double b0 = 0, b1 = 0, b2 = 0, a1 = 0, a2 = 0;

    void bandpass(double fs, double f0, double q) {
        double w0 = 2.0 * M_PI * f0 / fs;
        double alpha = std::sin(w0) / (2.0 * q);
        double a0 = 1.0 + alpha;
        b0 = alpha / a0;  b1 = 0.0;  b2 = -alpha / a0;
        a1 = (-2.0 * std::cos(w0)) / a0;  a2 = (1.0 - alpha) / a0;
    }

    void run(const std::vector<float>& in, std::vector<float>& out) const {
        out.resize(in.size());
        double x1 = 0, x2 = 0, y1 = 0, y2 = 0;
        for (size_t i = 0; i < in.size(); i++) {
            double x = in[i];
            double y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
            x2 = x1; x1 = x; y2 = y1; y1 = y;
            out[i] = (float)y;
        }
    }
};

// Rectify + one-pole low-pass → amplitude envelope. Common-mode group delay
// again cancels in the two-channel delay measurement.
inline void envelope(const std::vector<float>& in, std::vector<float>& out, double fs, double tauS) {
    out.resize(in.size());
    double k = 1.0 - std::exp(-1.0 / (tauS * fs));
    double e = 0.0;
    for (size_t i = 0; i < in.size(); i++) {
        double x = std::fabs((double)in[i]);
        e += k * (x - e);
        out[i] = (float)e;
    }
}

inline std::vector<float> decimate(const std::vector<float>& in, int d) {
    if (d < 1) d = 1;
    std::vector<float> out;
    out.reserve(in.size() / (size_t)d + 1);
    for (size_t i = 0; i < in.size(); i += (size_t)d) { out.push_back(in[i]); }
    return out;
}

// Zero-normalized cross-correlation of a[ai..ai+W) against b[bi..bi+W) → [-1,1].
// 1.0 for identical windows; ~0 for uncorrelated ones.
inline double ncc(const std::vector<float>& a, size_t ai,
                  const std::vector<float>& b, size_t bi, size_t W) {
    double ma = 0, mb = 0;
    for (size_t k = 0; k < W; k++) { ma += a[ai + k]; mb += b[bi + k]; }
    ma /= W; mb /= W;
    double num = 0, da = 0, db = 0;
    for (size_t k = 0; k < W; k++) {
        double xa = a[ai + k] - ma, xb = b[bi + k] - mb;
        num += xa * xb; da += xa * xa; db += xb * xb;
    }
    if (da <= 0 || db <= 0) return 0.0;
    return num / std::sqrt(da * db);
}

// Linearly-interpolated percentile of a sample (copy sorted in place).
inline double percentile(std::vector<double> v, double p) {
    if (v.empty()) return 0.0;
    std::sort(v.begin(), v.end());
    double idx = p / 100.0 * (double)(v.size() - 1);
    size_t lo = (size_t)std::floor(idx);
    size_t hi = (size_t)std::ceil(idx);
    double frac = idx - (double)lo;
    return v[lo] * (1.0 - frac) + v[hi] * frac;
}

}   // namespace rigdsp
