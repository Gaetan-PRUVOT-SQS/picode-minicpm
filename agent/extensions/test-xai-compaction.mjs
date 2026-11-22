import assert from "node:assert/strict";
import test from "node:test";
import { PROMPT, envelopper, extraireResume } from "./xai-compaction.ts";

test("l'invite de compactage couvre les neuf sections xai", () => {
	const sections = [
		"1. Primary Request and Intent",
		"2. Key Technical Concepts",
		"3. Files and Code Sections",
		"4. Errors and Fixes",
		"5. Problem Solving",
		"6. All User Messages",
		"7. Pending Tasks",
		"8. Current Work",
		"9. Optional Next Step",
	];
	for (const section of sections) {
		assert.ok(PROMPT.includes(section), `section manquante : ${section}`);
	}
});

test("l'invite interdit les outils et exige un bloc summary unique", () => {
	assert.match(PROMPT, /Do NOT call or use any tools/);
	assert.match(PROMPT, /<summary>/);
	assert.match(PROMPT, /<\/summary>/);
	assert.match(PROMPT, /nothing after the closing/);
});

test("l'invite porte le placeholder de contexte utilisateur", () => {
	assert.ok(PROMPT.includes("{user_context_section}"));
});

test("l'invite fait porter les summaries anterieurs", () => {
	assert.match(PROMPT, /<conversation_summary>/);
	assert.match(PROMPT, /carry its still-relevant information forward/);
});

test("extraireResume isole le contenu entre balises summary", () => {
	assert.equal(extraireResume("blabla <summary>  le vrai texte  </summary> fin"), "le vrai texte");
	assert.equal(
		extraireResume("<summary>a</summary> bruit <summary>b</summary>"),
		"a</summary> bruit <summary>b",
		"du premier ouvert au dernier fermé : rien ne se perd",
	);
});

test("extraireResume rend le texte brut sans balises", () => {
	assert.equal(extraireResume("  texte sans balise  "), "texte sans balise");
	assert.equal(extraireResume("<summary>sans fermeture"), "<summary>sans fermeture");
	assert.equal(extraireResume("</summary> ouvert apres"), "</summary> ouvert apres");
});

test("envelopper produit l'enveloppe xai attendue", () => {
	const enveloppe = envelopper("contenu du resume");
	assert.ok(enveloppe.startsWith("This session is being continued from a previous conversation"));
	assert.ok(enveloppe.includes("<conversation_summary>\ncontenu du resume\n</conversation_summary>"));
	assert.ok(!enveloppe.endsWith("\n\n"));
});

test("la chaine extraire puis envelopper preserve le contenu", () => {
	const brut = "preambule <summary>\nle fichier bordeneuve-acte-1972.txt\n</summary> fin";
	assert.equal(envelopper(extraireResume(brut)).includes("bordeneuve-acte-1972.txt"), true);
});
