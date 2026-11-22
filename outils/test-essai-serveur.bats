# Les tests ne touchent ni le port 8090 ni la passerelle : syntaxe et source seulement.

@test "syntaxe du script d'essai valide" {
	sh -n "$BATS_TEST_DIRNAME/essai-serveur.sh"
}

@test "la relance forcée reste dans le script, leçon des mesures biaisées" {
	grep -Fq "pkill -f 'llama-server --host 127.0.0.1 --port 8090'" "$BATS_TEST_DIRNAME/essai-serveur.sh"
}

@test "les drapeaux d'essai passent au serveur" {
	grep -Fq '"$@"' "$BATS_TEST_DIRNAME/essai-serveur.sh"
}
