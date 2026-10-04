"""Prints the context really loaded by the answering session and records its file for cleanup.

modelUsage accumulates the resumed session's history: we read the usage of the last assistant message of the new file.
"""
import glob
import json
import os
import sys

out = sys.argv[1]
d = json.load(open(out))
sid = d.get("session_id")
f = glob.glob(os.path.expanduser(f"~/.claude/projects/*/{sid}.jsonl"))[0]
with open(os.path.join(os.path.dirname(os.path.abspath(out)), "created_sessions.txt"), "a") as log:
    log.write(f + "\n")
usages = [json.loads(l)["message"]["usage"] for l in open(f) if '"usage"' in l and '"type":"assistant"' in l]
u = usages[-1]
loaded = u.get("input_tokens", 0) + u.get("cache_read_input_tokens", 0) + u.get("cache_creation_input_tokens", 0)
d["_context_loaded"] = loaded
json.dump(d, open(out, "w"), ensure_ascii=False)
print("context loaded:", loaded)
print(d.get("result", "")[:300])
