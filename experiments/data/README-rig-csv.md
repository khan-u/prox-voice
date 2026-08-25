# Rig capture data — two CSV variants

Each capture ships as a raw stereo recording plus two per-burst CSVs. The raw
`rig-rec-*.wav` files are the ground truth; the CSVs are derived from them.

- `rig-latency-<stamp>-uncalibrated.csv` — **the paper's source.** Produced by
  `analyze <wav> --min-corr 0.9 --min-lag-ms 30` (no `--est-median`). Its kept
  median is the true acoustic air-to-air latency (e.g. 151.7 ms for the first
  capture). The device constant is `C = median(uncalibrated) − software_median`.

- `rig-latency-<stamp>.csv` — a **calibrated intermediate** emitted live by the
  driver, which runs the analyzer with `--est-median <software_median>`. That
  flag shifts every burst so the kept median equals the software estimate, so by
  construction this file's `C` is ~0. It records what the operator saw on
  screen; it is **not** the source of the reported air-to-air latency.

Canonical reproduction: `experiments/compare-rig-runs.sh` re-analyzes every
`rig-rec-*.wav` with the paper's gates and no calibration, reprinting the
per-capture medians in Table 1. Software medians are in `rig-software-medians.csv`.
