English | [Français](README.fr.md)

# picode-minicpm

A fully local coding stack: the [pi coding agent](https://github.com/badlogic/pi-mono) driving **MiniCPM-V 4.7** (35B-A3B MoE, IQ2_XXS quant) through a llama.cpp server on a 4 GB laptop GPU + CPU hybrid — with draft-free n-gram speculative decoding, an oversized prefill batch, and an xAI-style context compaction extension.

No cloud, no API key, no GPU upgrade: the same machine runs 1.6× faster end to end after the optimizations documented below.

## Features

- `minicpm-serve`: launcher that brings up `llama-server` (MoE experts on CPU, attention on GPU) plus an OpenAI-compatible gateway, and no-ops when the stack is already up.
- Draft-free speculative decoding (`--spec-type ngram-mod`, drafts up to 128 tokens from context n-grams, measured acceptance 0.82–1.0).
- `--ubatch-size 2048`: +80% prefill throughput over the 512 default.
- Context compaction extension for pi: a 9-section summary in the xAI/Grok format (`<conversation_summary>` wrapper), triggered manually, at the context threshold, or on overflow recovery.
- Measurement tools: a real-path benchmark (through the gateway, fresh-server protocol) and an experiment relauncher that always restarts the server to avoid warm-state bias.

## Requirements

Tested on: Linux x86_64, Intel i5-12450H (4P+4E), NVIDIA RTX 2050 4 GB, 14 GB RAM.

- `llama-server` from a llama.cpp build with the `--spec-type`, `--fit`, `--cpu-moe` flag family (the included launcher was tested against build 12128, `d7b289683`).
- A MiniCPM-V 4.7 `35B-A3B` GGUF in IQ2_XXS (≈10 GB). Text-only here: the vision `mmproj` file is not loaded.
- Node.js ≥ 24 (type stripping runs the `.ts` extension and `.mjs` tests directly).
- The pi coding agent (`@earendil-works/pi-coding-agent` 1.4.0) for the compaction extension.
- Python 3 (benchmark), [bats](https://bats-core.readthedocs.io/) (shell tests), `shellcheck` + `shfmt` (development).

## Install

The repo layout mirrors where the files live on the target machine:

| Repo path | Destination | Role |
| --- | --- | --- |
| `agent/extensions/` | `~/.pi/agent/extensions/` | pi extension + its tests |
| `bin/minicpm-serve` | `~/.local/bin/` | model server launcher |
| `outils/` | anywhere (e.g. `~/.local/share/models/minicpm-v47/`) | benchmark and experiment tools |

```sh
git clone https://github.com/Gaetan-PRUVOT-SQS/picode-minicpm.git
cd picode-minicpm
npm install          # dev dependency of the unit tests (agent API)

cp agent/extensions/*.ts agent/extensions/*.mjs ~/.pi/agent/extensions/
cp bin/minicpm-serve ~/.local/bin/
```

Paths are configurable through environment variables (defaults below):

| Variable | Default | Role |
| --- | --- | --- |
| `LLAMA_SERVER` | `$HOME/.local/opt/llama.cpp/current/llama-server` | server binary |
| `MINICPM_GGUF` | `$HOME/.local/share/models/minicpm-v47/MiniCPM-V-4.7-35B-A3B-IQ2_XXS.gguf` | model file |
| `BONSAI_PASSERELLE` | `$HOME/.local/opt/bonsai-passerelle/passerelle.py` | gateway script |
| `MINICPM_ETAT` | `$HOME/.local/state/minicpm-serve` | logs and pid files |
| `PI_BIN` | `pi` | pi binary used by the E2E test |

## Usage

Start the stack (idempotent: exits 0 when MiniCPM already answers on the gateway port 8080):

```sh
minicpm-serve
```

Then point pi at the local provider. Minimal `~/.pi/agent/models.json`:

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

A thin wrapper keeps the launch flags in one place:

```sh
#!/bin/sh
set -eu
minicpm-serve
exec pi --no-skills --offline --thinking off \
  --provider local --model minicpm "$@"
```

Compaction is available three ways in pi: manual `/compact [instructions]`, automatic at the context threshold, and overflow recovery. Settings used here (`~/.pi/agent/settings.json`):

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

## How the compaction extension works

pi fires `session_before_compact` before every compaction. The extension (`agent/extensions/xai-compaction.ts`) intercepts it and:

1. serializes the messages that would be summarized plus the split-turn prefix;
2. prepends the previous summary when one exists (nothing is lost across successive compactions);
3. asks the model for a single `<summary>` block structured in 9 fixed sections: primary request and intent, key technical concepts, files and code sections, errors and fixes, problem solving, all user messages, pending tasks, current work, optional next step;
4. extracts the block and wraps it (`This session is being continued…` + `<conversation_summary>`) — the format a successor turn can pick up without drift.

If the handler returns nothing (empty conversation, model failure, abort), pi falls back to its built-in compaction.

## Benchmarks

Measured on the documented hardware, through the gateway (the real request path), with a fresh-server protocol: forced restart before each configuration, warm-up request, then measurement; the prefill request must report `cache_n = 0` to prove no warm-state bias.

| Scenario | Before | After | Δ |
| --- | --- | --- | --- |
| Prefill (~6,300 tokens) | 380 t/s | **687 t/s** | +80% |
| Context-derived generation | 24.9 t/s | **60.0 t/s** | +141% |
| Free generation (counting) | 24.7 t/s | 25.6 t/s | +3% |
| Full pi session (5 turns + compaction + follow-up) | 224 s | **141 s** | −37% |

The `ubatch` and threads numbers come from `llama-bench` sweeps on the same build: threads 8 is optimal (12 threads degrade generation on the E-cores), `ubatch 2048` doubles prefill throughput. The optimization playbook (fit the quant to RAM, speculative decoding, measure before changing anything) follows ["Mon IA locale va 11 fois plus vite"](https://www.youtube.com/watch?v=VFC16Tb3lwU).

Known limits:

- Free generation is memory-bandwidth bound (~25 t/s on CPU-resident experts); the 15 GB of used swap on a 14 GB machine is the dominant physical factor.
- The GGUF carries no usable MTP layers, so `--spec-type draft-mtp` fails on this quant.
- No headroom on the 4 GB GPU: expert layers already fill ~3.5 GB at prefill peaks, moving more experts to VRAM is not an option.

## Development

```sh
npm test                                              # both suites
node --test agent/extensions/test-xai-compaction.mjs  # extension units (8 tests)
bats outils/test-essai-serveur.bats                   # launcher guards (3 tests)
```

The E2E compaction test (`agent/extensions/test-compactage-e2e.mjs`) drives a full pi session over the RPC protocol against the live model: five ~6k-token turns, a manual compaction asserted on its xAI signature (`details.source`, wrapper, markers), then a follow-up question answered from the summary alone. It needs `minicpm-serve` running and takes a few minutes.

Shell changes go through `shfmt -fn`, `shellcheck` and `checkbashisms -p`. Measurement hygiene is part of the tooling: `outils/essai-serveur.sh` always restarts the server (pinned by a test), because a skipped restart silently measures the previous configuration.

## License

Not decided yet — all rights reserved in the meantime.
