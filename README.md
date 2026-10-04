# fast-jev-compaction (fork avec règles de résumé)

*[English version](README.en.md)*

Les longues sessions Claude Code oublient.

Quand le contexte se remplit, Claude Code remplace toute la conversation par un résumé écrit par Claude. Ce résumé est court, générique, et il perd des choses. Sur nos vraies sessions de travail, Claude ne répondait plus qu'à 58 % des questions factuelles sur la partie résumée. Un montant corrigé, une consigne donnée une seule fois, un chemin de fichier : c'est ce qui part en premier.

Ce fork de [tamaratran/fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction) change l'ordre des opérations. Jev, un modèle rapide de TypeSafe, nettoie d'abord, en retirant sans jamais réécrire. Claude résume en dernier, à partir d'un historique allégé, avec des règles qui gardent vos mots et les faits exacts. Nettoyer tôt, résumer tard, garder les mots.

## 1. Ce que c'est

Un plugin Claude Code, construit sur les function hooks, qui intervient à trois moments de la vie d'une session.

1. **Jev nettoie le contexte sans le réécrire.** Dès 30 % de la fenêtre de contexte, il retire les appels d'outils et leurs résultats devenus inutiles. Le texte écrit par vous et par Claude reste mot pour mot. Les blocs de réflexion de Claude, les fichiers joints et les images de l'historique reconstruit ne survivent pas à un passage.
2. **Le plugin refuse les compactions qui ne valent pas le coup.** Entre deux nettoyages, Claude Code demande une compaction avant chaque appel au modèle. Le plugin dit non tant que le contexte n'a pas assez grossi pour justifier un nouveau passage.
3. **Claude résume une seule fois, tard, avec des règles plus strictes.** À 60 % de la fenêtre, Jev nettoie une dernière fois, puis Claude écrit le résumé à partir de cet historique réduit. Un plan fixe lui dit quoi garder : chaque message de l'utilisateur mot pour mot, les consignes en vigueur, les chiffres exacts avec les valeurs qu'ils remplacent, les décisions, le travail fait, les points ouverts.

### Ce qu'on a mesuré

Quatre vraies sessions de travail, coupées chacune à leur point de compaction (environ 600k tokens). Un modèle a écrit 30 questions par session sur la partie à résumer, et un juge à l'aveugle a noté les réponses sans savoir quelle compaction les avait produites.

| Ce que Claude garde après la compaction | Questions réussies |
|---|---|
| La conversation complète (référence, 2 sessions) | 98 % |
| Les nettoyages Jev seuls, avant tout résumé | 97 % |
| Le résumé par défaut de Claude Code | 58 % |
| Le résumé de Claude avec les règles de ce fork | 70 à 75 % |
| **Nettoyage Jev, puis résumé de Claude avec les règles** (ce plugin) | **80 à 87 %** |

Raisonnement après un résumé à 600k : un fil fictif de 8 échanges (six clients aux noms proches, des règles données une seule fois, un montant mis à jour tard) planté dans 2 vraies sessions longues, 12 questions, 3 essais chacune.

| Résumé | Réponses justes |
|---|---|
| Résumé par défaut de Claude Code | 74 % |
| Résumé de Claude avec les règles | 79 à 82 % |
| **Nettoyage Jev, puis résumé de Claude avec les règles** | **100 %** (12/12 à chaque essai) |

Dérive de comportement : six règles de travail données tôt (signature, tutoiement, montants HT, pas de rendez-vous le vendredi), puis trois mails à rédiger sans aucun rappel. Les règles tiennent à 100 % en contexte brut jusqu'à environ 890k tokens, et après le résumé avec les règles, avec ou sans Jev. Elles tombent à 93 % après le résumé par défaut.

Tokens relus sur les quatre sessions : 321 M à l'origine, 234 M avec ce plugin (−27 %, de −69 % à 0 % selon la session). Laisser Claude Code compacter seul à 30 % en relit moins (146 M, −55 %), au prix de 2 à 3 résumés appauvris par session.

<details>
<summary>Limites de ces mesures</summary>

- Petit échantillon : 4 sessions pour le rappel, 2 pour le raisonnement, un seul modèle (Claude Opus 5), des sessions en français.
- Les questions ont été écrites par un modèle, et les réponses données sans outils. En vrai travail, Claude peut relire un fichier ou relancer une commande.
- Le résumé de Claude varie d'un essai à l'autre : la même session a donné 7/12 puis 12/12 avec les mêmes règles.
- Sur les longues sessions testées, le contexte brut ne montre aucune perte de raisonnement mesurable jusqu'à environ 890k tokens. Compacter plus tôt économise des tokens, pas des erreurs.
- Les chiffres ont été mesurés avec les règles de la v0.7.0. La v0.7.1 ajoute deux lignes non re-mesurées : votre texte après `/compact` passe devant le plan, et la section des points ouverts n'est jamais coupée.
- Le protocole et les scripts sont dans [`bench/`](bench/README.md) (en anglais). Les scripts de rappel et de tokens sont ceux qui ont produit ces chiffres. Les sondes de raisonnement et de dérive ont été réécrites en anglais, avec de nouveaux noms fictifs et un correcteur un peu plus souple : leurs scores ne se comparent pas directement aux nôtres. Lancez-les sur vos propres sessions avant de croire nos chiffres.

</details>

## 2. Comment ça marche

```
contexte 0% ─────────── 30% ───────────────────────── 60% ──────── 85%
                         │                              │            │
                         │  passage Jev : retire les    │  final :   │  plafond :
                         │  vieux appels d'outils et    │  passage   │  étape finale
                         │  leurs résultats (texte      │  Jev puis  │  quels que
                         │  gardé mot pour mot)         │  résumé    │  soient les
                         │                              │  Claude    │  réglages
                         │  refus jusqu'à +100k tokens  │  avec les  │
                         │  depuis le dernier passage   │  règles    │
```

Claude Code déclenche `session.compact` avant chaque appel au modèle dès que le contexte dépasse `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` (30 %). Le hook de [`hooks/fast-jev.ts`](hooks/fast-jev.ts) décide de la suite :

| Situation | Ce que fait le plugin |
|---|---|
| Sous `summarizeAtPercent` (60 %), contexte grossi de `passGrowthTokens` (100k) depuis le dernier passage | Passage Jev : retire appels d'outils et résultats, garde tout le texte |
| Sous 60 %, croissance insuffisante, Jev a retiré moins de 25 %, Jev en échec, ou dernier passage il y a moins de 3 appels | Refus : un avis `not compacted`, la conversation reste intacte |
| À 60 % ou plus, ou sur `/compact` | Étape finale : passage Jev, puis résumé de Claude avec les règles |
| Compaction d'un sous-agent | Compaction de Claude Code, sans intervention |

Chaque passage reporte aussi ce que Claude Code perdrait sinon : les messages tapés pendant que Claude travaillait et les skills invoquées plus tôt. Chaque passage et chaque étape finale sont consignés dans `~/.claude/jev-journal/`.

Les règles de résumé sont dans `handoverInstructions`, dans [`src/v2.ts`](src/v2.ts). Le texte passé à `/compact <texte>` s'ajoute après le plan et passe devant lui.

> Des règles écrites dans `CLAUDE.md`, même sous un titre « Compact Instructions », sont ignorées par le résumé de Claude Code : on l'a testé deux fois. `/compact <règles>` fonctionne, mais seulement à la main. Pour la compaction automatique, seul un plugin peut transmettre des règles.

## 3. Comment l'utiliser

### Prérequis

- Claude Code avec les function hooks (accès anticipé). Tout a été mesuré sur la version 2.1.286.
- Une clé API TypeSafe pour Jev (voir ci-dessous).

### Obtenir une clé Jev

1. Connectez-vous à la [console TypeSafe](https://console.typesafe.ai/), avec Google ou un code reçu par e-mail.
2. Ouvrez la page [API Keys](https://console.typesafe.ai/keys), créez une clé et copiez-la tout de suite.
3. Vérifiez-la dans un terminal :

   ```bash
   curl -s https://api.typesafe.ai/v1/models -H "Authorization: Bearer $TYPESAFE_API_KEY"
   ```

   La réponse liste les modèles. Le plugin utilise `jev-1.13.0`.

Prix public : 0,042 $ par million de tokens envoyés, d'après la [page d'accueil de TypeSafe](https://typesafe.ai). Un passage de nettoyage envoie quelques dizaines de milliers de tokens.

Les inscriptions ont changé plusieurs fois depuis le lancement : ouvertes à tous le 21 septembre 2026, mises en pause le lendemain faute de capacité, toujours en pause fin septembre. Si la console ne vous propose pas de créer un compte, écrivez à hello@typesafe.ai. L'accès à Jev par la passerelle IA de Vercel ne fonctionne pas avec ce plugin, qui appelle directement l'API de TypeSafe. Documentation officielle : [démarrage rapide](https://docs.typesafe.ai/introduction/quickstart).

### Installer

1. Ajoutez ces variables dans `~/.claude/settings.json`, sous `"env"` :

   ```json
   {
     "env": {
       "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1",
       "TYPESAFE_API_KEY": "<votre clé>",
       "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE": "30"
     }
   }
   ```

   `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` fixe le moment où Jev commence à nettoyer. Sans elle, Claude Code attend que la fenêtre soit presque pleine, et chaque compaction devient une étape finale.

2. Ajoutez ce dépôt comme marketplace et installez le plugin :

   ```bash
   claude plugin marketplace add Matthieusabourin2/fast-jev-compaction
   ```

   ```bash
   claude plugin install fast-jev-compaction@jev-compaction
   ```

   Si vous avez installé le plugin d'origine, désactivez-le d'abord (`claude plugin disable fast-jev-compaction@fast-jev-compaction`) pour que les deux ne répondent pas en même temps.

3. Redémarrez Claude Code. Gardez les options par défaut, sauf raison précise.

### Recevoir les mises à jour

Dans Claude Code, tapez `/plugin`, ouvrez **Marketplaces**, choisissez `jev-compaction` et activez la mise à jour automatique. Une nouvelle version vous arrive quand son numéro change dans `plugin.json`.

Ce fork suit le projet d'origine. Une GitHub Action hebdomadaire ([`sync-upstream.yml`](.github/workflows/sync-upstream.yml)) fusionne ses nouveautés dans une branche, lance les tests et ouvre une pull request. En cas de conflit, elle ouvre une issue.

### Vérifier que ça tourne

- Lancez `/compact` dans une longue session. Un nouveau fichier apparaît dans `~/.claude/jev-journal/` avec `"stage": "final"`, et le résumé suit les sept sections.
- Entre 30 % et 60 %, un avis `not compacted` signifie que le plugin a refusé une compaction, volontairement.

### Options

| Option | Défaut | Effet |
|---|---|---|
| `summarizeAtPercent` | 60 | Seuil où Claude résume après un dernier passage Jev |
| `hardCapPercent` | 85 | Étape finale quels que soient les autres réglages |
| `passGrowthTokens` | 100000 | Croissance nécessaire entre deux passages Jev |
| `minReductionRatio` | 0.25 | Sous cette réduction, le passage est refusé |
| `keepThreshold` | 0.5 | Probabilité minimale, selon Jev, pour garder un appel d'outil ou son résultat |
| `preserveRecentMessages` | 6 | Messages les plus récents, jamais touchés |

La liste complète est dans [`.claude-plugin/plugin.json`](.claude-plugin/plugin.json). L'usage en bibliothèque et les options d'origine sont dans [`docs/library.md`](docs/library.md) (en anglais). Les mesures du moteur qui ont guidé la conception (ce que voit un hook de compaction, ce que Claude Code garde) sont dans [`docs/mesures-compaction.md`](docs/mesures-compaction.md).

### Lancer le benchmark

[`bench/README.md`](bench/README.md) applique le même protocole à vos propres sessions : rappel après compaction, tokens relus, raisonnement à plusieurs tailles de contexte, dérive de comportement. Chaque appel à Claude est plafonné en coût, et les copies de vos sessions restent sur votre machine.

### Développement

```bash
npm install && npm run typecheck && npm test
```

Pour charger le plugin depuis un clone sans l'installer : `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude --plugin-dir .`

Licence MIT, comme le projet d'origine.
