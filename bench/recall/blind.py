"""Hides the variants' answers behind letters, with a different random draw for each question.

usage: blind.py <run dir> [variant,variant,...]   writes blind.json (for the judge) and .mapping.json (letters -> variants)
Variants default to every answers_<variant>.json present in the run dir. The draw is seeded by the run dir name,
so it is reproducible. The judge must never see .mapping.json; score.py reveals the labels.
"""
import json
import os
import random
import re
import string
import sys

d = sys.argv[1]
if len(sys.argv) > 2:
    variants = [v for v in sys.argv[2].split(",") if os.path.exists(os.path.join(d, f"answers_{v}.json"))]
else:
    variants = sorted(f[len("answers_"):-len(".json")] for f in os.listdir(d) if re.fullmatch(r"answers_.+\.json", f))
if not variants:
    sys.exit("no answers_<variant>.json in " + d)
answers = {}
for v in variants:
    raw = json.load(open(os.path.join(d, f"answers_{v}.json"))).get("result", "")
    m = re.search(r"\{.*\}", raw, re.S)
    answers[v] = json.loads(m.group(0)) if m else {}
qs = json.load(open(os.path.join(d, "questions.json"), encoding="utf-8"))
rng = random.Random("blind-" + os.path.basename(os.path.normpath(d)))
letters = string.ascii_uppercase[:len(variants)]
blind, mapping = [], {}
for q in qs:
    order = variants[:]
    rng.shuffle(order)
    mapping[q["id"]] = dict(zip(letters, order))
    blind.append({"id": q["id"], "question": q["question"], "expected_answer": q["expected_answer"],
                  "answers": {L: answers[v].get(q["id"], "(no answer)") for L, v in zip(letters, order)}})
json.dump(blind, open(os.path.join(d, "blind.json"), "w"), ensure_ascii=False, indent=1)
json.dump(mapping, open(os.path.join(d, ".mapping.json"), "w"))
print(len(blind), "questions;", {v: sum(1 for q in qs if q["id"] in answers[v]) for v in variants}, "answers per variant")
