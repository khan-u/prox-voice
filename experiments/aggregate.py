#!/usr/bin/env python3
"""Consolidate collected PROX-VOICE experiment JSON into result tables.

Reads impl/experiments/data/:
  wsn-voice-N*-summary-*.json   (VoiceMetrics: formation/glare/latency/candidate)
  wsn-*-summary-*.json with meanUpKbps/sense (Phase B: uplink + suppression)
  wsn-mobility-*.json           (teardown / reconnect)
Prints one table per experiment group. Newest run per N wins.

Usage:  python3 aggregate.py
"""
import glob, json, os, statistics as st

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")


def med(a):
    return round(st.median(a)) if a else "-"


def mean(a):
    return round(st.mean(a)) if a else "-"


def group12():
    latest = {}
    for f in sorted(glob.glob(os.path.join(DATA, "*summary*.json"))):
        d = json.load(open(f))
        if "perClient" in d:
            latest[d["N"]] = d
    if not latest:
        print("  (no cluster-sweep data yet — run: node harness.cjs <N> 40)")
        return
    print("== Group 1+2: formation / glare / latency / uplink vs N ==")
    print(f"{'N':>2} {'peers':>5} {'connLinks':>9} {'setupMed':>8} {'ICE%':>4} "
          f"{'relay%':>6} {'m2e~ms':>6} {'glare':>5} {'up/link':>7} {'sup%':>4}")
    for N in sorted(latest):
        pcs = latest[N]["perClient"]
        s   = [c["kpis"]["setupMedianMs"]  for c in pcs if c["kpis"]["setupMedianMs"]  >= 0]
        ic  = [c["kpis"]["iceSuccessPct"]  for c in pcs if c["kpis"]["iceSuccessPct"]  >= 0]
        rp  = [c["kpis"]["relayPct"]       for c in pcs if c["kpis"].get("relayPct", -1) >= 0]
        lat = [c["kpis"]["latRawMedianMs"] for c in pcs if c["kpis"]["latRawMedianMs"] >= 0]
        gl  = sum(c["kpis"]["glareTotal"] for c in pcs)
        lk  = sum(max(0, c["kpis"]["links"]) for c in pcs)
        ap  = round(sum((c["peers"] or 0) for c in pcs) / len(pcs), 1)
        up  = [c["meanUpKbps"] for c in pcs if c.get("meanUpKbps") is not None]
        sup = [c["sense"]["suppressedPct"] for c in pcs if c.get("sense")]
        print(f"{N:>2} {ap:>5} {lk:>9} {str(med(s)):>8} {str(mean(ic)):>4} "
              f"{str(mean(rp)):>6} {str(mean(lat)):>6} {gl:>5} "
              f"{str(mean(up)):>7} {str(mean(sup)):>4}")


def group3():
    files = sorted(glob.glob(os.path.join(DATA, "wsn-mobility-*.json")))
    if not files:
        print("\n== Group 3: mobility ==\n  (no mobility data yet — run: node mobility.cjs 22 6)")
        return
    # Complete-case validity: a cycle counts only if ALL THREE phases completed
    # (form, teardown, reconnect >= 0). A run where one phase times out (-1) is a
    # failed trial, not a data point — and the phases are causally coupled, so a
    # partial run corrupts the others: a teardown that never fires leaves the link
    # up, making the following "reconnect" spuriously instant (~25 ms). Filtering
    # per phase (the old behaviour) leaked those artifacts in; whole-cycle
    # validity is the experiment's own success condition, applied uniformly.
    forms, tears, recons, skipped = [], [], [], 0
    for f in files:
        p  = json.load(open(f)).get("phases", {})
        fm = p.get("initialForm", {}).get("ms", -1)
        td = p.get("teardown",    {}).get("ms", -1)
        rc = p.get("reconnect",   {}).get("ms", -1)
        if fm < 0 or td < 0 or rc < 0:
            skipped += 1
            continue
        forms.append(fm); tears.append(td); recons.append(rc)
    print("\n== Group 3: mobility (teardown / reconnect) ==")
    if not forms:
        print(f"  (no complete cycles among {len(files)} files)")
        return
    def rng(a): return f"{med(a)} [{min(a)}-{max(a)}]"
    print(f"  complete cycles={len(forms)} (skipped {skipped} partial/failed)")
    print(f"  form median={rng(forms)}ms  teardown median={rng(tears)}ms  "
          f"reconnect median={rng(recons)}ms")


def audiogap():
    files = sorted(glob.glob(os.path.join(DATA, "wsn-audiogap-*.json")))
    if not files:
        print("\n== Group 3b: audio gap ==\n  (no audio-gap data yet — run: ./audiogap-run.sh 5)")
        return
    # Only valid==True runs count: the harness marks runs invalid when either
    # instant (stop/resume) could not be measured, and earlier detector-era
    # files were retro-marked invalid (see invalidReason inside the JSON).
    stops, recons, totals, skipped = [], [], [], 0
    for f in files:
        d = json.load(open(f))
        if d.get("valid") is not True:
            skipped += 1
            continue
        stops.append(d["audioStopAfterOutMs"])
        recons.append(d["reconnectAudioGapMs"])
        totals.append(d["totalSilenceMs"])
    print("\n== Group 3b: audio gap (listener-perceived silence, out-and-back) ==")
    if not stops:
        print(f"  (no VALID runs among {len(files)} files)")
        return
    print(f"  valid runs={len(stops)} (skipped {skipped} invalid/superseded)")
    print(f"  audio stop after leaving range: median={med(stops)}ms  range={min(stops)}-{max(stops)}ms")
    print(f"  reconnect audio gap on return:  median={med(recons)}ms  range={min(recons)}-{max(recons)}ms")
    print(f"  total silence (9s absence):     median={med(totals)}ms  range={min(totals)}-{max(totals)}ms")


def sensing():
    files = sorted(glob.glob(os.path.join(DATA, "wsn-sensing-*.json")))
    if not files:
        print("\n== Sensing scenarios ==\n  (no data yet — run: ./sensing-run.sh 5)")
        return
    by_sc = {}
    for f in files:
        d  = json.load(open(f))
        sc = d.get("scenario")
        if not sc:
            continue
        row = by_sc.setdefault(sc, {"sup": [], "kinds": {}, "n": 0})
        row["n"] += 1
        for c in d.get("clients", {}).values():
            st_ = c.get("stats") or {}
            if isinstance(st_.get("suppressedPct"), (int, float)):
                row["sup"].append(st_["suppressedPct"])
        for k, v in (d.get("kindCounts") or {}).items():
            row["kinds"][k] = row["kinds"].get(k, 0) + v
    print("\n== Sensing scenarios: suppression + report mix (60 s holds) ==")
    print(f"{'scenario':>8} {'trials':>6} {'sup% med':>8}  reports/trial by kind")
    for sc in ["idle", "walk", "conv", "churn"]:
        if sc not in by_sc:
            continue
        r     = by_sc[sc]
        kinds = "  ".join(f"{k}={v / r['n']:.1f}" for k, v in sorted(r["kinds"].items()))
        print(f"{sc:>8} {r['n']:>6} {str(med(r['sup'])):>8}  {kinds}")


if __name__ == "__main__":
    print(f"data dir: {DATA}\n")
    group12()
    group3()
    audiogap()
    sensing()
