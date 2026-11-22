#!/bin/sh
set -eu
# shellcheck disable=SC3040
if (set -o pipefail) 2>/dev/null; then set -o pipefail; fi

nom=${0##*/}
bin=${LLAMA_SERVER:-${HOME}/.local/opt/llama.cpp/current/llama-server}
modele=${MINICPM_GGUF:-${HOME}/.local/share/models/minicpm-v47/MiniCPM-V-4.7-35B-A3B-IQ2_XXS.gguf}
passerelle=${BONSAI_PASSERELLE:-${HOME}/.local/opt/bonsai-passerelle/passerelle.py}
etat=${MINICPM_ETAT:-${HOME}/.local/state/minicpm-serve}
api=http://127.0.0.1:8080/v1/models
llm=http://127.0.0.1:8090/v1/models

contient_minicpm()
{
	curl -fsS --max-time 2 "$1" 2>/dev/null | grep -F minicpm >/dev/null
}

if [ ! -x "$bin" ]; then
	printf '%s\n' "$nom: binaire absent ($bin)." >&2
	exit 127
fi
if [ ! -f "$modele" ]; then
	printf '%s\n' "$nom: modèle absent ($modele)." >&2
	exit 1
fi
if [ ! -f "$passerelle" ]; then
	printf '%s\n' "$nom: passerelle absente ($passerelle)." >&2
	exit 127
fi
command -v curl >/dev/null 2>&1 || {
	printf '%s\n' "$nom: curl absent." >&2
	exit 127
}
command -v python3 >/dev/null 2>&1 || {
	printf '%s\n' "$nom: python3 absent." >&2
	exit 127
}

if contient_minicpm "$api"; then
	exit 0
fi

mkdir -p "$etat"

pkill -f 'llama-server --host 127.0.0.1 --port 8090' 2>/dev/null || true
sleep 3

if ! contient_minicpm "$llm"; then
	if curl -fsS --max-time 2 "$llm" >/dev/null 2>&1; then
		printf '%s\n' "$nom: 8090 répond déjà sans minicpm." >&2
		exit 1
	fi
	"$bin" \
		--host 127.0.0.1 \
		--port 8090 \
		--alias minicpm \
		--cpu-moe \
		--fit on \
		--fit-target 256 \
		--fit-ctx 65536 \
		-c 65536 \
		-fa on \
		-ctk q8_0 \
		-ctv q8_0 \
		--load-mode none \
		--lazy-mode off \
		--jinja \
		--reasoning off \
		--threads 8 \
		--threads-batch 8 \
		-m "$modele" \
		"$@" \
		>"$etat/llama-server.log" 2>&1 &
	printf '%s\n' $! >"$etat/llama-server.pid"
fi

if ! curl -fsS --max-time 2 "$api" >/dev/null 2>&1; then
	python3 -- "$passerelle" --hote 127.0.0.1 --port 8080 --amont http://127.0.0.1:8090 \
		>"$etat/passerelle.log" 2>&1 &
	printf '%s\n' $! >"$etat/passerelle.pid"
fi

n=0
while [ "$n" -lt 180 ]; do
	if contient_minicpm "$api"; then
		exit 0
	fi
	n=$((n + 1))
	sleep 2
done

printf '%s\n' "$nom: minicpm n'a pas répondu sur 8080." >&2
exit 1
