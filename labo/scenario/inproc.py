"""Compacte une copie de session puis envoie un tour, dans le même processus (sans reprise), et rend la main.
usage : python3 inproc.py <claude_bin> <probe_dir> <session_base> <jev:on|off> <sortie.json> [env K=V ...]"""
import json, os, subprocess, sys, threading
CLAUDE, PROBE, BASE, JEV, OUT = sys.argv[1:6]
env = dict(os.environ, CLAUDE_CODE_ENABLE_FUNCTION_HOOKS="1")
prompts = ["/compact", "Réponds seulement « ok »."]
extra_plugins = []
for kv in sys.argv[6:]:
    k, v = kv.split("=", 1)
    if k == "PROMPTS": prompts = json.loads(v)
    elif k == "EXTRA_PLUGIN": extra_plugins.append(v)
    else: env[k] = v
settings = json.dumps({"enabledPlugins": {"fast-jev-compaction@fast-jev-compaction": JEV == "on"}})
plug = [a for d in extra_plugins for a in ("--plugin-dir", d)]
p = subprocess.Popen([CLAUDE, "-p", "--resume", BASE, "--fork-session", "--plugin-dir", PROBE, *plug, "--settings", settings,
                      "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--max-budget-usd", "60"],
                     cwd=os.path.expanduser("~/Documents/labo-compaction"), env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
res, sid, done = [], None, threading.Event()
def reader():
    global sid
    for line in p.stdout:
        try: ev = json.loads(line)
        except json.JSONDecodeError: continue
        sid = ev.get("session_id", sid)
        if ev.get("type") == "result":
            res.append({"cost": ev.get("total_cost_usd"), "result": str(ev.get("result"))[:200]}); done.set()
threading.Thread(target=reader, daemon=True).start()
for text in prompts:
    done.clear()
    p.stdin.write(json.dumps({"type": "user", "message": {"role": "user", "content": text}}) + "\n"); p.stdin.flush()
    done.wait(600)
p.stdin.close(); p.wait(60)
json.dump({"session_id": sid, "results": res}, open(OUT, "w"), ensure_ascii=False, indent=1)
print(sid, res)
