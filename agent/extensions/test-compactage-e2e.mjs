import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";

const PI = process.env.PI_BIN ?? "pi";

const FAITS = `Dossier factice de test, ne pas utiliser d'outil pour le retrouver : le fichier d'acte de vente s'appelle bordeneuve-acte-1972.txt, le relevé mentionne 82 champignons sur la parcelle, la décision prise est que le compacteur xai remplace le résumé standard, et l'erreur invalid_header venait du bandeau manquant corrigé en ajoutant l'en-tête demandé.`;

function paragraphe(numero, repetitions) {
	const ligne =
		`Tour ${numero} : la parcelle bordeneuve a été arpentée, le cadastre de 1972 cite ` +
		`les bornes est et ouest, et la synthèse du compacteur xai reste la décision ` +
		`retenue pour la suite du chantier. `;
	return `Contexte de remplissage du tour ${numero}.\n${ligne.repeat(repetitions)}\nRéponds en une seule phrase courte, sans appeler d'outil.`;
}

function lancerPi() {
	return spawn(
		PI,
		["--mode", "rpc", "--no-skills", "--offline", "--thinking", "off", "--provider", "local", "--model", "minicpm"],
		{
			cwd: process.env.HOME ?? process.cwd(),
			env: { ...process.env, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" },
		},
	);
}

function piloter(enfant) {
	let tampon = "";
	let compteur = 0;
	const enAttente = new Map();
	const evenements = [];
	const enAttenteEvenement = new Map();
	enfant.stdout.setEncoding("utf8");
	enfant.stderr.setEncoding("utf8");
	enfant.stderr.on("data", (morceau) => process.stderr.write(`[pi stderr] ${morceau}`));
	enfant.stdout.on("data", (morceau) => {
		tampon += morceau;
		let fin;
		while ((fin = tampon.indexOf("\n")) >= 0) {
			const ligne = tampon.slice(0, fin).trim();
			tampon = tampon.slice(fin + 1);
			if (!ligne) continue;
			let message;
			try {
				message = JSON.parse(ligne);
			} catch {
				continue;
			}
			if (message.type === "response") {
				const attente = message.id ? enAttente.get(message.id) : undefined;
				if (attente) {
					clearTimeout(attente.minuter);
					enAttente.delete(message.id);
					attente.resoudre(message);
				} else {
					process.stderr.write(`[pi réponse sans attente] ${JSON.stringify(message).slice(0, 200)}\n`);
				}
			} else if (message.type) {
				evenements.push(message.type);
				const file = enAttenteEvenement.get(message.type);
				if (file?.length) {
					file.shift()(message);
				}
			}
		}
	});
	function attendreEvenement(nom, delaiMs) {
		const promesse = new Promise((resoudre, rejeter) => {
			const minuter = setTimeout(() => rejeter(new Error(`événement ${nom} non reçu en ${delaiMs} ms`)), delaiMs);
			const file = enAttenteEvenement.get(nom) ?? [];
			file.push((message) => {
				clearTimeout(minuter);
				resoudre(message);
			});
			enAttenteEvenement.set(nom, file);
		});
		return promesse;
	}
	async function envoyer(commande, delaiMs) {
		const id = commande.id ?? `cmd-${++compteur}`;
		const promesse = new Promise((resoudre, rejeter) => {
			const minuter = setTimeout(
				() => {
					enAttente.delete(id);
					rejeter(new Error(`délai dépassé pour ${commande.type} (${delaiMs} ms)`));
				},
				delaiMs,
			);
			enAttente.set(id, { resoudre, minuter });
		});
		enfant.stdin.write(JSON.stringify({ ...commande, id }) + "\n");
		return promesse;
	}
	return { envoyer, attendreEvenement, evenements };
}

test("le compactage en session produit un résumé à la xai et la suite continue", { timeout: 1500000 }, async (t) => {
	const enfant = lancerPi();
	t.after(() => {
		enfant.kill("SIGTERM");
	});
	const { envoyer, attendreEvenement } = piloter(enfant);

	const etat = await envoyer({ type: "get_state" }, 30000);
	assert.equal(etat.success, true, `get_state en échec : ${etat.error ?? "?"}`);
	assert.equal(etat.data?.model?.id, "minicpm", "le modèle minicpm doit être actif");

	for (const numero of [0, 1, 2, 3, 4]) {
		const texte = numero === 0 ? `${FAITS}\nAccuse réception en une phrase courte, sans appeler d'outil.` : paragraphe(numero, 150);
		const reponse = await envoyer({ type: "prompt", message: texte }, 60000);
		assert.equal(reponse.success, true, `tour ${numero} en échec : ${reponse.error ?? "?"}`);
		await attendreEvenement("agent_end", 420000);
	}

	const avant = await envoyer({ type: "get_session_stats" }, 30000);
	const tokensAvant = avant.data?.tokens?.total ?? 0;
	assert.ok(tokensAvant > 20000, `contexte trop petit avant compactage : ${tokensAvant}`);

	const compact = await envoyer({ type: "compact" }, 900000);
	assert.equal(compact.success, true, `compact en échec : ${compact.error ?? "?"}`);
	const resume = compact.data;
	assert.ok(resume?.summary, "aucun résumé renvoyé");
	assert.equal(resume.details?.source, "xai-grok-build-full-replace", "le résumé ne vient pas de l'extension xai");
	assert.ok(resume.summary.includes("This session is being continued"), "l'enveloppe xai manque");
	assert.ok(resume.summary.includes("<conversation_summary>"), "la balise conversation_summary manque");
	assert.ok(resume.tokensBefore > 20000, `tokensBefore trop petit : ${resume.tokensBefore}`);
	assert.ok(
		resume.summary.toLowerCase().includes("acte-1972"),
		"le nom de fichier du tour 0 a été perdu au compactage",
	);

	const messages = await envoyer({ type: "get_messages" }, 30000);
	assert.equal(messages.success, true, "get_messages en échec");
	const premier = messages.data?.messages?.find((m) => m.role === "compactionSummary");
	assert.ok(premier, "aucun message compactionSummary projeté après compactage");
	assert.ok(premier.summary.includes("<conversation_summary>"), "le message projeté ne contient pas le résumé encapsulé");
	assert.ok(premier.summary.includes("This session is being continued"), "l'enveloppe xai manque dans la projection");

	const relance = await envoyer(
		{
			type: "prompt",
			message:
				"D'après le résumé de session en tête de conversation, quel est le nom exact du fichier d'acte de vente ? Réponds uniquement par ce nom, sans appeler d'outil.",
		},
		420000,
	);
	assert.equal(relance.success, true, "la relance après compactage a échoué");
	await attendreEvenement("agent_end", 420000);
	const derniere = await envoyer({ type: "get_last_assistant_text" }, 30000);
	const texteRelance = (derniere.data?.text ?? "").toLowerCase();
	assert.ok(
		texteRelance.includes("acte-1972"),
		`la relance ne retrouve pas le fichier : ${texteRelance.slice(0, 400)}`,
	);
});
