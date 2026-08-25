# Acoustic loopback rig — live capture runsheet (D6, "calibrated mouth-to-ear")

Procedure behind the report's calibrated-latency row (Table V). A **hybrid** run:
device A + capture are automated on the host Mac; device B (phone) and the
physical wiring are manual.

## Requirements
- Game server reachable at the same world URL from both clients (`BASE_URL`,
  default `http://localhost:5001`).
- A ts-client checkout (`TS_CLIENT`) — playwright-core + chromium come from its
  `node_modules`.
- `ffmpeg` and `SwitchAudioSource` on PATH.
- A stereo USB audio interface (Behringer UCA202 or equivalent; enumerates as
  "USB Audio CODEC"). The driver resolves its avfoundation index by name at run
  start and prints it; indices are positional, so never hardcode one.
- Rig built + self-test passing (`analyze` recovers a known 85 ms to <0.1 ms).

## Why not headless
Headless harnesses use `--use-fake-device-for-media-stream` (fake mic → null
sink) and can only produce the *software* estimate. The acoustic rig needs real
audio at both ends: device A runs **headful** with the real built-in mic and
device B is a real phone.

## Wiring (matches the methodology §VI live-capture configuration)
```
UCA202 OUT L ── RCA cable ──► UCA202 IN L            = ch0 REFERENCE (zero-delay)
UCA202 HEADPHONE OUT ── earbud @ ~1cm from the Mac's built-in mic   (stimulus into A)
PHONE ── USB-C→3.5mm adapter (integrated DAC) ── 3.5mm→RCA ──► UCA202 IN R = ch1 RETURN
```
- ch0 = LEFT input, ch1 = RIGHT input (`--ref-ch 0 --mic-ch 1` defaults).
- Only one conductor of each RCA pair is used; UCA202 OUT R stays empty.
- If ch0 clips, regenerate a quieter stimulus: `./stimulus --amp 0.4`.

## Phone (device B) — manual
1. Open the world URL, log in, enable voice (tap the mic). The client holds a
   screen wake lock while voice is on; still keep the tab foregrounded.
2. Low Power Mode OFF; battery ≥30% (the port carries the audio adapter, so no
   charger). Phone still; quiet room fine.
3. Volume moderate-high; confirm the adapter chain ends at UCA202 IN R.
4. Leave the phone logged in between sessions — a live session answers the
   WebRTC offer in seconds; a suspended one never answers.

## Run (host Mac) — automated
```sh
TS_CLIENT=<path-to-ts-client> node rig-driver.cjs --runs 5
#   --runs N        captures per session (login once, replicate N times)
#   --bursts 60     (=120 s per capture)   --secs <capture>   --peer-wait 600
#   --audio-index N explicit device override (normally resolved by name)
#   --dry           validate login + peer gate only (no audio switch / capture)
# BASE_URL=<world URL> if the server is not on localhost; if an interactive
# access gate fronts it, the driver pauses for the operator (ENTER to resume).
```
Per capture the driver plays `stimulus.wav` (60 × 2 kHz/5 ms clicks at 2 s
spacing), records both UCA202 channels, reads the software median
(`wsnVoice.kpis().latRawMedianMs`), runs
`analyze rec.wav --min-corr 0.9 --min-lag-ms 30 --est-median <sw>`, prints
**C = median(rig) − median(software)**, applies `wsnVoice.setCalibrationMs(C)`,
and archives a timestamped `rig-rec-<STAMP>.wav` + CSV pair into
`experiments/data/`. Multi-run sessions end with an ensemble summary.

## Read-out
- `analyze` prints median / p95 / mean mouth-to-ear + histogram per capture.
- `--min-lag-ms 30` floors the lag search: electrical crosstalk of the
  reference into ch1 correlates near 0 ms and can outscore a weak acoustic
  return; no real mouth-to-ear path is under 30 ms.
- `./compare-rig-runs.sh` re-analyzes every archived capture with identical
  gates, one line per run.
- Sanity, on the measured device pair: rig medians ~130–155 ms with a ~10 ms
  bimodal split inside each capture (one audio-callback quantum); occasional
  bursts up to ~750 ms are jitter-buffer excursions the median ignores.
