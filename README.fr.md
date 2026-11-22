[English](README.md) | Français

# picode-minicpm

Une pile de code 100 % locale : l'[agent pi](https://github.com/badlogic/pi-mono) pilotant **MiniCPM-V 4.7** (35B-A3B MoE, quant IQ2_XXS) via un serveur llama.cpp sur un hybride GPU portable 4 Go + CPU avec décodage spéculatif par n-grammes sans draft, ubatch de préfill surdimensionné et une extension de compactage de contexte façon xAI.

Pas de cloud, pas de clé d'API, pas de changement de GPU : la même machine va 1,6× plus vite de bout en bout après les optimisations documentées ci-dessous.

## Fonctionnalités

- `minicpm-serve` : lanceur qui démarre `llama-server` (experts MoE sur CPU, attention sur GPU) plus une passerelle compatible OpenAI, et ne fait rien si la pile répond déjà.
- Décodage spéculatif sans draft (`--spec-type ngram-mod`, drafts jusqu'à 128 tokens depuis les n-grammes du contexte, acceptation mesurée 0,82-1,0).
- `--ubatch-size 2048` : +80 % de débit de préfill face au défaut de 512.
- Extension de compactage de contexte pour pi : résumé à 9 sections au format xAI/Grok (enveloppe `<conversation_summary>`), déclenché à la main, au seuil de contexte, ou en rattrapage de débordement.
- Outils de mesure : banc du chemin réel (via la passerelle, protocole serveur frais) et relanceur d'essais qui redémarre toujours le serveur pour éviter le biais d'état chaud.

## Prérequis

Testé sur : Linux x86_64, Intel i5-12450H (4P+4E), NVIDIA RTX 2050 4 Go, 14 Go de RAM.

- `llama-server` depuis un build llama.cpp avec la famille de drapeaux `--spec-type`, `--fit`, `--cpu-moe` (le lanceur fourni est testé contre le build 12128, `d7b289683`).
- Un GGUF MiniCPM-V 4.7 `35B-A3B` en IQ2_XXS (≈10 Go). Texte seul ici : le fichier vision `mmproj` n'est pas chargé.
- Node.js ≥ 24 (le stripping de types exécute directement l'extension `.ts` et les tests `.mjs`).
- L'agent pi (`@earendil-works/pi-coding-agent` 1.4.0) pour l'extension de compactage.
- Python 3 (banc), [bats](https://bats-core.readthedocs.io/) (tests shell), `shellcheck` + `shfmt` (développement).

## Installation

Le layout du dépôt reflète l'emplacement des fichiers sur la machine cible :

| Chemin du dépôt | Destination | Rôle |
| --- | --- | --- |
| `agent/extensions/` | `~/.pi/agent/extensions/` | extension pi et ses tests |
| `bin/minicpm-serve` | `~/.local/bin/` | lanceur du serveur de modèle |
| `outils/` | n'importe où (ex. `~/.local/share/models/minicpm-v47/`) | banc et outils d'essai |

```sh
git clone https://github.com/Gaetan-PRUVOT-SQS/picode-minicpm.git
cd picode-minicpm
npm install          # dépendance de dev des tests unitaires (API de l'agent)

cp agent/extensions/*.ts agent/extensions/*.mjs ~/.pi/agent/extensions/
cp bin/minicpm-serve ~/.local/bin/
```

Les chemins se règlent par variables d'environnement (défauts ci-dessous) :

| Variable | Défaut | Rôle |
| --- | --- | --- |
| `LLAMA_SERVER` | `$HOME/.local/opt/llama.cpp/current/llama-server` | binaire serveur |
| `MINICPM_GGUF` | `$HOME/.local/share/models/minicpm-v47/MiniCPM-V-4.7-35B-A3B-IQ2_XXS.gguf` | fichier modèle |
| `BONSAI_PASSERELLE` | `$HOME/.local/opt/bonsai-passerelle/passerelle.py` | script passerelle |
| `MINICPM_ETAT` | `$HOME/.local/state/minicpm-serve` | journaux et pid |
| `PI_BIN` | `pi` | binaire pi utilisé par le test E2E |

## Utilisation

Démarre la pile (idempotent : sortie 0 quand MiniCPM répond déjà sur le port passerelle 8080) :

```sh
minicpm-serve
```

Puis pointe pi vers le provider local. `~/.pi/agent/models.json` minimal :

```json
{
  "providers": {
    "local": {
      "baseUrl": "http://127.0.0.1:8080/v1",
      "api": "openai-completions",
      "apiKey": "local",
      "models": [
        {
          "id": "minicpm",
          "name": "MiniCPM-V 4.7 35B-A3B",
          "input": ["text"],
          "contextWindow": 65536,
          "maxTokens": 4096
        }
      ]
    }
  }
}
```

Un wrapper mince garde les drapeaux de lancement au même endroit :

```sh
#!/bin/sh
set -eu
minicpm-serve
exec pi --no-skills --offline --thinking off \
  --provider local --model minicpm "$@"
```

Le compactage est disponible de trois façons dans pi : `/compact [instructions]` à la main, automatique au seuil de contexte, et rattrapage de débordement. Réglages utilisés ici (`~/.pi/agent/settings.json`) :

```json
{
  "compaction": {
    "enabled": true,
    "reserveTokens": 9536,
    "keepRecentTokens": 16384,
    "modelOverrides": {
      "local/minicpm": { "reserveTokens": 9536, "keepRecentTokens": 16384 }
    }
  }
}
```

## Fonctionnement de l'extension de compactage

pi déclenche `session_before_compact` avant chaque compactage. L'extension (`agent/extensions/xai-compaction.ts`) l'intercepte et :

1. sérialise les messages à résumer plus le préfixe de tour coupé ;
2. préfixe le résumé précédent s'il existe (rien ne se perd entre compactages successifs) ;
3. demande au modèle un bloc `<summary>` unique structuré en 9 sections fixes : demande initiale et intention, concepts techniques, fichiers et sections de code, erreurs et correctifs, résolution de problèmes, tous les messages utilisateur, tâches en attente, travail en cours, étape suivante optionnelle ;
4. extrait le bloc et l'enveloppe (`This session is being continued…` + `<conversation_summary>`) — le format qu'un tour successeur reprend sans dérive.

Si le handler ne renvoie rien (conversation vide, échec modèle, abort), pi retombe sur son compactage intégré.

## Benchmarks

Mesurés sur le matériel documenté, via la passerelle (chemin réel des requêtes), avec un protocole serveur frais : redémarrage forcé avant chaque configuration, requête d'échauffement, puis mesure ; la requête de préfill doit rapporter `cache_n = 0` pour prouver l'absence de biais d'état chaud.

| Scénario | Avant | Après | Δ |
| --- | --- | --- | --- |
| Préfill (~6 300 tokens) | 380 t/s | **687 t/s** | +80 % |
| Génération dérivée du contexte | 24,9 t/s | **60,0 t/s** | +141 % |
| Génération libre (comptage) | 24,7 t/s | 25,6 t/s | +3 % |
| Session pi complète (5 tours + compactage + relance) | 224 s | **141 s** | −37 % |

Les chiffres `ubatch` et threads viennent de balayages `llama-bench` sur le même build : 8 threads restent optimaux (12 threads dégradent la génération sur les E-cores), `ubatch 2048` double le débit de préfill. La démarche d'optimisation (quant ajusté à la RAM, décodage spéculatif, mesurer avant de changer quoi que ce soit) suit [« Mon IA locale va 11 fois plus vite »](https://www.youtube.com/watch?v=VFC16Tb3lwU).

Limites connues :

- La génération libre est bornée par la bande mémoire (~25 t/s sur les experts résidents en CPU) ; les 15 Go de swap utilisés sur une machine de 14 Go restent le facteur physique dominant.
- Le GGUF ne porte pas de couches MTP exploitables : `--spec-type draft-mtp` échoue sur ce quant.
- Aucune marge sur les 4 Go de VRAM : les couches d'experts occupent déjà ~3,5 Go aux pics de préfill, déplacer plus d'experts en VRAM n'est pas une option.

## Développement

```sh
npm test                                              # les deux suites
node --test agent/extensions/test-xai-compaction.mjs  # unitaires de l'extension (8 tests)
bats outils/test-essai-serveur.bats                   # gardes du lanceur (3 tests)
```

Le test E2E du compactage (`agent/extensions/test-compactage-e2e.mjs`) pilote une session pi complète par le protocole RPC contre le modèle vivant : cinq tours d'environ 6k tokens, un compactage manuel asserté sur sa signature xai (`details.source`, enveloppe, marqueurs), puis une question de relance répondue depuis le seul résumé. Il exige `minicpm-serve` en marche et prend quelques minutes.

Les modifications shell passent par `shfmt -fn`, `shellcheck` et `checkbashisms -p`. L'hygiène de mesure fait partie des outils : `outils/essai-serveur.sh` redémarre toujours le serveur (épinglé par un test), parce qu'une relance sautée mesure en silence la configuration précédente.

## Licence

Non tranchée — tous droits réservés en attendant.
