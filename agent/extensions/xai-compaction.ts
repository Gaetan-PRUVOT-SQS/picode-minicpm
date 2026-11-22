import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";

export const PROMPT = `Your task is to produce a faithful, concise summary of the conversation so far so that a successor assistant can continue the work seamlessly after the earlier turns are discarded. The successor will see the user's original query plus this summary. Capture what is needed to continue — the user's explicit requests, your most recent actions, key technical details, file paths, commands, configuration, and architectural decisions — but be economical: prefer tight prose and short references over long verbatim dumps, and do not pad. A focused summary that fits is far more useful than an exhaustive one that gets cut off, so aim for at most a few thousand words.
{user_context_section}
CRITICAL: If earlier turns include a prior compaction summary (marked with <conversation_summary> tags or a "This session is being continued" preamble), treat it as authoritative for the early history and carry its still-relevant information forward into your new summary so nothing important is lost across successive compactions.

Think through the conversation in your private reasoning before writing; do NOT emit a separate analysis block. Output the final summary inside a single <summary>...</summary> block, organized into the following numbered sections. Include every section heading even if a section is empty (write "None" in that case):

1. Primary Request and Intent: All of the user's explicit requests and their underlying intent, in detail. Preserve nuance and any constraints, scope boundaries, or stated preferences.
2. Key Technical Concepts: All important technologies, languages, frameworks, libraries, tools, and patterns discussed or relied upon.
3. Files and Code Sections: Every file examined, created, or modified. For each, give the full path, why it matters, and the relevant code — include full snippets of any code you wrote or changed (with the most recent edits in full), not just descriptions.
4. Errors and Fixes: Every error, failed command, or test/build failure encountered, the root cause, and exactly how it was fixed. Note any fix that came from user feedback verbatim.
5. Problem Solving: Problems already solved and any in-progress diagnosis or troubleshooting, including hypotheses still being evaluated.
6. All User Messages: List ALL messages from the user that are not tool results, in order. These are critical for understanding intent and how it evolved. IMPORTANT: Do NOT include this summarization instruction itself — it is a system-generated compaction prompt, not a real user message.
7. Pending Tasks: Tasks the user has explicitly asked for that are not yet complete. Do not invent tasks the user never requested.
8. Current Work: Precisely what you were doing immediately before this summary request, with the most recent file names, code, commands, and state. Be specific enough that work can resume mid-stream.
9. Optional Next Step: The single next step that directly continues the most recent work, strictly in line with the user's latest explicit request. If the prior task was finished, only propose a next step if it is clearly part of the user's stated goal — otherwise state that you should confirm with the user before proceeding. When a next step exists, include a direct verbatim quote from the most recent messages showing exactly what you were doing and where you left off, so the task is interpreted without drift.

IMPORTANT: Do NOT call or use any tools. Respond with ONLY the <summary>...</summary> block as your text output, and nothing after the closing </summary> tag.`;

export function extraireResume(texte: string): string {
	const ouvert = texte.indexOf("<summary>");
	const ferme = texte.lastIndexOf("</summary>");
	if (ouvert >= 0 && ferme > ouvert) {
		return texte.slice(ouvert + "<summary>".length, ferme).trim();
	}
	return texte.trim();
}

export function envelopper(resume: string): string {
	return (
		"This session is being continued from a previous conversation that ran out of context. " +
		"The summary below covers the earlier portion of the conversation.\n\n" +
		"<conversation_summary>\n" +
		resume +
		"\n</conversation_summary>"
	);
}

export default function (pi: ExtensionAPI) {
	pi.on("session_before_compact", async (event, ctx) => {
		const { preparation, customInstructions, signal } = event;
		const {
			messagesToSummarize,
			turnPrefixMessages,
			tokensBefore,
			firstKeptEntryId,
			previousSummary,
		} = preparation;

		const tout = [...messagesToSummarize, ...turnPrefixMessages];
		if (tout.length === 0) {
			return;
		}

		const modele = ctx.model;
		if (!modele) {
			return;
		}

		let conversation = serializeConversation(convertToLlm(tout));
		if (previousSummary) {
			conversation =
				"Previous session summary for context:\n" +
				previousSummary +
				"\n\n" +
				conversation;
		}

		const contexte = customInstructions
			? "\n\n**User-provided context for this compaction:**\n" +
				customInstructions +
				"\n\nPlease incorporate this context into your summary, ensuring it is prominently addressed in the relevant sections.\n\n"
			: "";

		const consigne = PROMPT.replace("{user_context_section}", contexte);

		try {
			const reponse = await ctx.modelRegistry.complete(
				modele,
				{
					messages: [
						{
							role: "user",
							content: [
								{
									type: "text",
									text:
										consigne +
										"\n\n<conversation>\n" +
										conversation +
										"\n</conversation>",
								},
							],
							timestamp: Date.now(),
						},
					],
				},
				{
					maxTokens: Math.min(4096, modele.maxTokens),
					signal,
					cacheRetention: "none",
				},
			);

			const brut = reponse.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("\n");
			const resume = extraireResume(brut);
			if (!resume) {
				return;
			}

			return {
				compaction: {
					summary: envelopper(resume),
					firstKeptEntryId,
					tokensBefore,
					usage: reponse.usage,
					details: { source: "xai-grok-build-full-replace" },
				},
			};
		} catch {
			return;
		}
	});
}
