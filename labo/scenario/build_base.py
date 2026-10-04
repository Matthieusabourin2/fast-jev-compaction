"""Construit la session témoin du labo : une suite de tours, chacun dépose un code CANARI dans un type d'information.

usage : python3 build_base.py <claude_bin> <probe_dir> <sortie.json>
Lance claude en stream-json dans ~/Documents/labo-compaction, envoie les tours un par un (le tour 02 est envoyé
pendant qu'un tour tourne, pour produire un message « en cours de tour »), écrit l'id de session et les coûts.
"""
import json, os, subprocess, sys, threading, time

CLAUDE, PROBE, OUT = sys.argv[1], sys.argv[2], sys.argv[3]
LABO = os.path.expanduser("~/Documents/labo-compaction")

RULE = "Session de test : à chaque demande, exécute-la puis réponds seulement « fait », sans commentaire."
TURNS = [
    ("01", f"{RULE} Premier point : mon message contient le code CANARI-01 (valeur : « albatros »). Lis docs/fiche.txt."),
    ("04-05", "Exécute exactement ces deux commandes Bash : `echo ok # CANARI-04 (valeur : « fou de bassan »)` puis "
              "`python3 -c \"print('CANARI-'+'05 (valeur : « macareux »)')\"`."),
    ("06", "Lance un sous-agent (outil Agent, type general-purpose) avec cette consigne : « Lis docs/sub.txt et renvoie son contenu exact, rien d'autre. »"),
    ("07", "Lance en arrière-plan (run_in_background) la commande `sleep 4; python3 -c \"print('CANARI-'+'07 (valeur : « tadorne »)')\"`, "
           "puis attends sa fin avant de répondre."),
    ("08", "Invoque la skill canari-skill."),
    ("10", "Crée le fichier docs/edit.txt (outil Write) dont le contenu est la concaténation de « CANARI- » et de « 10 (valeur : « mouette ») »."),
    ("16", "Lis l'image docs/canari16.png avec l'outil Read."),
    ("18", "Lis docs/mcp.txt avec l'outil MCP filesystem (read_text_file), chemin absolu " + LABO + "/docs/mcp.txt. S'il échoue, dis « échec »."),
    ("19", "Exécute `python3 -c \"raise SystemExit('erreur CANARI-'+'19 (valeur : « harle huppé »)')\"`."),
    ("vol", "Lis entièrement docs/annexe1.txt, docs/annexe2.txt, docs/annexe3.txt et docs/annexe4.txt (pour donner du volume)."),
    ("02-host", "Exécute `sleep 12` puis réponds « fait »."),
]
MIDTURN = ("02", "Message tapé pendant que tu travailles : code CANARI-02 (valeur : « bernache »).")

env = dict(os.environ, CLAUDE_CODE_ENABLE_FUNCTION_HOOKS="1")
p = subprocess.Popen([CLAUDE, "-p", "--plugin-dir", PROBE, "--input-format", "stream-json", "--output-format", "stream-json",
                      "--verbose", "--max-budget-usd", "8", "--permission-mode", "bypassPermissions"],
                     cwd=LABO, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
results, sid = [], None
done = threading.Event()

def reader():
    global sid
    for line in p.stdout:
        try:
            ev = json.loads(line)
        except json.JSONDecodeError:
            continue
        sid = ev.get("session_id", sid)
        if ev.get("type") == "result":
            results.append({"cost": ev.get("total_cost_usd"), "result": str(ev.get("result"))[:200], "is_error": ev.get("is_error")})
            done.set()

threading.Thread(target=reader, daemon=True).start()

def send(text):
    p.stdin.write(json.dumps({"type": "user", "message": {"role": "user", "content": text}}) + "\n")
    p.stdin.flush()

for tag, text in TURNS:
    done.clear()
    send(text)
    if tag == "02-host":
        time.sleep(4)
        send(MIDTURN[1])
    if not done.wait(600):
        print("timeout", tag); break
    print(tag, results[-1])
    if tag == "02-host":  # le message en file produit un tour de plus
        done.clear(); done.wait(300)
        if len(results) and results[-1] is not None: print("02", results[-1])
p.stdin.close(); p.wait(60)
json.dump({"session_id": sid, "results": results}, open(OUT, "w"), ensure_ascii=False, indent=1)
print("session", sid)
