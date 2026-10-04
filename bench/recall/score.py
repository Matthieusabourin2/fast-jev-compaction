"""Aggregates the judge's verdicts: recall per variant, category, criticality, and whether the information was restated.

usage: score.py <run dir> [...]   reads questions.json, judgments.json and .mapping.json in each run dir;
writes scores.json next to the run dirs (in the parent of the first one).
Recall = correct + 0.5 x partial. "wrong" = a false answer asserted (worse than an abstention).
"""
import json
import os
import sys
from collections import defaultdict

POINTS = {"correct": 1.0, "partial": 0.5, "wrong": 0.0, "abstain": 0.0}
rows = []
for d in sys.argv[1:]:
    qs = {q["id"]: q for q in json.load(open(os.path.join(d, "questions.json"), encoding="utf-8"))}
    mapping = json.load(open(os.path.join(d, ".mapping.json")))
    for j in json.load(open(os.path.join(d, "judgments.json"), encoding="utf-8")):
        q = qs[j["id"]]
        for letter, verdict in j["verdicts"].items():
            rows.append({"session": os.path.basename(os.path.normpath(d)),
                         "variant": mapping[j["id"]][letter],
                         "verdict": verdict, "category": q["category"], "criticality": q["criticality"],
                         "restated": q["restated"], "id": q["id"]})


def table(key):
    acc = defaultdict(lambda: defaultdict(list))
    for r in rows:
        acc[key(r)][r["variant"]].append(r["verdict"])
    out = {}
    for k, per in sorted(acc.items(), key=lambda x: str(x[0])):
        out[str(k)] = {v: {"n": len(vs), "recall": round(100 * sum(POINTS[x] for x in vs) / len(vs), 1),
                           "wrong": sum(x == "wrong" for x in vs), "abstain": sum(x == "abstain" for x in vs)}
                       for v, vs in sorted(per.items())}
    return out


res = {"global": table(lambda r: "all"), "session": table(lambda r: r["session"]),
       "category": table(lambda r: r["category"]), "criticality": table(lambda r: r["criticality"]),
       "restated": table(lambda r: "restated in the dialogue" if r["restated"] else "only in a tool"),
       "rows": rows}
json.dump(res, open(os.path.join(os.path.dirname(os.path.abspath(os.path.normpath(sys.argv[1]))), "scores.json"), "w"),
          ensure_ascii=False, indent=1)
for name in ("global", "session", "category", "criticality", "restated"):
    print("==", name)
    for k, per in res[name].items():
        print(f"  {k:32}", "  ".join(f"{v}:{s['recall']:5.1f}% (wrong {s['wrong']})" for v, s in per.items()))
