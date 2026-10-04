"""Builds the memory-test prompt from the question bank (without the expected answers)."""
import json
import sys

qs = json.load(open(sys.argv[1], encoding="utf-8"))
lines = "\n".join(f'{q["id"]}: {q["question"]}' for q in qs)
print(f"""Memory test. Do not use any tool and do not look anything up: answer only with what you remember of our conversation so far.
For each question, give the most precise answer you can (exact values if you have them). If the information is not in what you remember, answer exactly "I don't know". Do not guess.

{lines}

Reply only with a JSON object {{"Q01": "...", "Q02": "...", ...}}, with no other text.""")
