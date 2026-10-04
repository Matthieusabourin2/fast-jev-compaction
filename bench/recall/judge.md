You are a blind judge. File to grade: {BLIND} (a list of questions; for each one: question, expected_answer, and several answers labelled A, B, C… coming from anonymous variants, in an order drawn at random for each question).

For each question and each letter, give one verdict among:
- "correct": the answer contains the expected information, with no error that changes the meaning (paraphrase accepted, exact figures and names required);
- "partial": part of the expected information, or the information with a minor inaccuracy;
- "wrong": the answer asserts something false or contradicting the expected answer;
- "abstain": the answer says it does not know, is empty, or is "(no answer)".

Rules: judge each answer against the expected_answer only, not against the other answers. Do not try to guess which variant is behind a letter. Do not read any other file.

Write the result to {OUT}, in this exact JSON format:
[{"id": "Q01", "verdicts": {"A": "correct", "B": "partial", "C": "wrong", "D": "abstain"}}, ...]
one entry per question, in file order, with one verdict for every letter present for that question. Then check with python3 that the JSON loads, has as many entries as there are questions, and that every verdict is one of the four words. Reply only "done, N questions".
