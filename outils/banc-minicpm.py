#!/usr/bin/env python3
"""Banc de vitesse du chemin réel : passerelle 8080 -> llama-server 8090.

Mesure le préfill, la génération en contexte long et la réutilisation de
cache, comme pi les vit. Sortie : une ligne JSON par scénario.
"""

from __future__ import annotations

import json
import sys
import time
from urllib.request import Request, urlopen

PASSERELLE = "http://127.0.0.1:8080/v1/chat/completions"

BLOC = (
    "La parcelle bordeneuve est arpentée depuis 1972, le cadastre cite les bornes "
    "est et ouest, le relevé des champignons est contresigné et la synthèse reste "
    "la décision retenue pour la suite du chantier. "
)
REPETITIONS = 120


def scenario_prefill(max_tokens: int = 1) -> dict:
    contenu = BLOC * REPETITIONS + " Reponds par le seul mot: ok."
    charge = {
        "model": "minicpm",
        "messages": [{"role": "user", "content": contenu}],
        "max_tokens": max_tokens,
        "stream": False,
    }
    return requete("prefill", charge)


def scenario_generation() -> dict:
    contenu = BLOC * REPETITIONS + " Compte de un a cent en une seule ligne, sans espace."
    charge = {
        "model": "minicpm",
        "messages": [{"role": "user", "content": contenu}],
        "max_tokens": 220,
        "stream": False,
    }
    return requete("generation-ctx-long", charge)


def scenario_recopiage() -> dict:
    contenu = (
        BLOC * REPETITIONS
        + "\nRecopie mot pour mot, sans rien changer ni ajouter, exactement les "
        + "120 premiers mots du texte ci-dessus, puis arrête-toi."
    )
    charge = {
        "model": "minicpm",
        "messages": [{"role": "user", "content": contenu}],
        "max_tokens": 220,
        "stream": False,
    }
    return requete("recopiage-ngram", charge)


def scenario_cache_premier() -> dict:
    contenu = BLOC * REPETITIONS + " Reponds par le seul mot: pret."
    charge = {
        "model": "minicpm",
        "messages": [{"role": "user", "content": contenu}],
        "max_tokens": 2,
        "stream": False,
    }
    return requete("cache-premier-passage", charge)


def scenario_cache_second() -> dict:
    contenu = BLOC * REPETITIONS + " Reponds par le seul mot: liste."
    charge = {
        "model": "minicpm",
        "messages": [{"role": "user", "content": contenu}],
        "max_tokens": 60,
        "stream": False,
    }
    return requete("cache-second-passage", charge)


def requete(nom: str, charge: dict) -> dict:
    corps = json.dumps(charge).encode()
    demande = Request(
        PASSERELLE,
        data=corps,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    debut = time.monotonic()
    with urlopen(demande, timeout=900) as reponse:
        corps_reponse = json.loads(reponse.read())
    total = time.monotonic() - debut
    temps = corps_reponse.get("timings", {})
    return {
        "scenario": nom,
        "wall_s": round(total, 2),
        "prompt_n": temps.get("prompt_n"),
        "prompt_tps": round(temps["prompt_n"] / (temps["prompt_ms"] / 1000), 1)
        if temps.get("prompt_ms")
        else None,
        "predicted_n": temps.get("predicted_n"),
        "predicted_tps": round(temps["predicted_n"] / (temps["predicted_ms"] / 1000), 2)
        if temps.get("predicted_ms") and temps.get("predicted_n")
        else None,
        "cache_n": temps.get("cache_n"),
    }


def main() -> int:
    scenarios = sys.argv[1:] or ["prefill", "generation", "recopiage", "cache"]
    table = {
        "prefill": [scenario_prefill],
        "generation": [scenario_generation],
        "recopiage": [scenario_recopiage],
        "cache": [scenario_cache_premier, scenario_cache_second],
    }
    for nom in scenarios:
        for scenario in table[nom]:
            print(json.dumps(scenario(), ensure_ascii=False), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
