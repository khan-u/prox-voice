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


if __name__ == "__main__":
    print(f"data dir: {DATA}\n")
    group12()
