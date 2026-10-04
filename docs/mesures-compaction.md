# Compaction Claude Code et Jev : ce qui est mesuré (03/10/2026)

Moteur : Claude Code **2.1.286**, la version embarquée dans l'app desktop. Les tests passent par `claude -p` sur ce même binaire.

Instrument : `labo/probe`, un plugin de function hooks. Il journalise :
- chaque ligne ajoutée à la conversation (`session.append`) ;
- l'entrée et la sortie de `session.compact` ;
- la forme API exacte de la conversation (`$.session.messages({as:'api'})`) ;
- le découpage de `/context` (`$.session.usage({breakdown:'full'})`).

Session témoin : `labo/scenario/build_base.py`, environ 195k tokens. Chaque type d'information y porte un code `CANARI-xx` unique.

Légende des sources :
- **test** : mesuré ici ;
- **doc** : documentation officielle `code.claude.com` ;
- **types** : `claude-code.d.ts` 2.1.286.

## 1. Ce que voit un hook de compaction

| Type d'information | Dans l'entrée du hook | Source |
|---|---|---|
| Message tapé par l'utilisateur | oui (`text`) | test |
| Texte de Claude | oui | test |
| Appel d'outil (entrée) | oui (`toolUses[].input`) | test |
| Résultat d'outil (texte) | oui (`toolResults[].text`) | test |
| Retour de sous-agent | oui, comme résultat de l'outil Agent | test |
| Notification de tâche de fond | oui, comme message user (`<task-notification>`) | test |
| Message tapé pendant que Claude travaille (`queued_command`) | **non**, c'est une pièce jointe | test |
| Corps d'une skill invoquée (ligne `isMeta`) | **non** | test |
| CLAUDE.md, mémoire, contexte de hook | **non**, ce sont des pièces jointes | test |
| Listes injectées : outils différés, skills, MCP, agents | **non** | test |
| Fichiers joints par l'utilisateur (`att:file`, PDF, images) | **non** | test (transcripts réels) |
| Image lue par un outil | **non**, seul le texte est exposé | test |
| Blocs de réflexion de Claude | **non** | test, types |

Le hook reçoit une ligne de transcript par message. Le moteur ne regroupe pas les blocs d'un même `message.id`, et une ligne qui ne contient que de la réflexion devient un message vide. Mesuré : 77 messages sur 77 identiques au convertisseur `labo/offline/to_session_messages.py`, avec seulement l'ordre de 6 messages permuté quand des outils tournent en parallèle.

## 2. Ce que le moteur fait de la réponse du hook

**Un message rendu avec son `handle`** est gardé entier par le moteur : réflexion, pièces jointes et image comprises.
- Il est réécrit après la frontière **avec son `parentUuid` d'origine**.
- Si Jev a retiré un message intermédiaire, la chaîne pointe vers l'historique d'avant la compaction. Exemple : la ligne 274 pointe vers la ligne 178.
- Une reprise (`--resume`, réouverture) recharge alors **tout** l'historique : 192k tokens au lieu de 57,6k. *(test)*

**Un message rendu sans `handle`** est reconstruit à partir de `role`, `text` et des blocs d'outils.
- Réflexion, pièces jointes, images et corps de skills disparaissent.
- La reprise ne recharge que ce qui a été rendu, plus une réinjection des listes. *(test)*

**Tout ce qui n'est pas représenté dans la réponse** disparaît : messages en cours de tour, notifications sous forme de pièce jointe, corps de skills. *(test)*

**Après une compaction par hook**, le moteur réinjecte au tour suivant :
- les listes d'outils différés, de skills, MCP et d'agents ;
- l'environnement, CLAUDE.md et la mémoire ;
- les rappels.

*(test)*

**Après la compaction de Claude**, le moteur réinjecte :
- CLAUDE.md et la mémoire, ainsi que les références des fichiers lus (`compact_file_reference`) et un fichier (`file`) ;
- les listes d'outils différés, MCP et d'agents, **mais pas la liste des skills** *(test, conforme à la doc)* ;
- les skills invoquées, à 5k tokens chacune et 25k au total *(doc)*.

## 3. Taille et coût, sur la session témoin de 195k tokens

| Variante | Contexte au tour suivant | Après une reprise | Codes retrouvés sans outil | Durée |
|---|---|---|---|---|
| Sans compaction | 195k | — | 14 sur 14 | — |
| Compaction de Claude, manuelle | 41k | 59k | 14 sur 14 | 26 s |
| Compaction de Claude, automatique | 50k | 49k | 14 sur 14 | 28 s |
| Jev 0.3, manuel | 58k | **192k** | 14 sur 14 après reprise, 7 sur 14 présents en mémoire vive | 1,1 s |
| Jev 0.3, automatique | 58k | **194k** | idem | 1,1 s |
| Hook « tout reconstruire », sans aucune suppression | **77k** | **106k** | 12 sur 14 présents (skill et image perdues) | < 0,1 s |

Le score parfait de Jev 0.3 après reprise vient du bug : la reprise recharge tout l'historique.

**L'appel de résumé de Claude lit le cache.** Mesuré : 195k tokens lus depuis le cache, 0 écrit, 2,4k en entrée et 2,9k en sortie, soit environ 0,18 $ au prix liste. La doc annonce le même comportement. *(test)*

## 4. D'où viennent les tokens après Jev 0.3, sur de vraies sessions

Mesure par reprise de copies réparées (S1, S4), avec Jev coupé et l'instrument actif :
- **S4.** La partie messages pèse 204k tokens. Le texte visible fait 240k caractères, soit environ 65k tokens. Le reste correspond aux **114 blocs de réflexion** des réponses de Claude conservées : chiffrés, invisibles au hook, mais facturés.
- **S1.** 221k tokens de messages. On y retrouve en plus des fichiers joints (`att:file`, 35 % des caractères du segment gardé).

Conséquence : **le surcoût de Jev 0.3 ne vient pas des outils, qu'il retire bien, mais de la réflexion et des pièces jointes qu'il ne voit pas et garde en entier.**

## 5. Déclencheurs

| Point de départ | `$.session.compact()` possible ? | Source |
|---|---|---|
| `prompt.submit` | **non** : le moteur le refuse (« it would compact under the turn this hook is holding ») | test |
| `turn.complete` en `claude -p` | **non** : « not available in a headless (-p / SDK) session yet » | test |
| `turn.complete` en desktop | à tester | — |
| `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` | **appliqué** : à 10 %, la compaction se déclenche à 100k sur une fenêtre de 1M. Le `/context` affiche pourtant toujours un seuil de 967k. | test |
| Seuil automatique | fenêtre − 33k de réserve (exemple : 100k → 67k) | test |
| Sous-agents | compaction propre, avec `agentId` et `trigger: auto` | test |

**Risque observé.** Avec Jev 0.3 actif, un sous-agent qui lisait 80k tokens de fichiers a planté sur l'erreur « Autocompact is thrashing » : son contexte s'est rempli trois fois juste après une compaction. Sans Jev, le même sous-agent a terminé. *(test, 1 essai chacun)*

## 6. Méthode de mesure du rappel

`--tools ""` ou le retrait de ToolSearch gonfle le contexte d'environ 330k tokens : les outils différés sont alors chargés en entier. Le rappel se mesure donc avec les outils par défaut et `--disallowedTools` sur les outils de lecture et d'exécution. *(test)*

Les coûts `total_cost_usd` d'une session reprise **cumulent** ceux de la session d'origine.
