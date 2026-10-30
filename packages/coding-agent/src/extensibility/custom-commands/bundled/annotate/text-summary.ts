import { completeSimple } from "@oh-my-pi/pi-ai";
import { prompt } from "@oh-my-pi/pi-utils";
import type { CustomCommandContext } from "../../../../extensibility/custom-commands/types";
import summaryPrompt from "./prompts/text-summary.md" with { type: "text" };
import { normalizeTextReviewContextSummary } from "./text-review";

type SummaryContext = Pick<CustomCommandContext, "model" | "modelRegistry" | "sessionManager">;

/** Generate grounding context with the selected session model, never a hidden fallback model. */
export async function generateTextReviewContextSummary(
	ctx: SummaryContext,
	sourceText: string,
	signal?: AbortSignal,
): Promise<string | undefined> {
	const model = ctx.model;
	if (!model) return undefined;

	const timeout = AbortSignal.timeout(60_000);
	const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
	const message = await completeSimple(
		model,
		{
			systemPrompt: [prompt.render(summaryPrompt)],
			messages: [{ role: "user", content: sourceText, timestamp: Date.now() }],
		},
		{
			apiKey: ctx.modelRegistry.resolver(model, ctx.sessionManager.getSessionId()),
			disableReasoning: true,
			maxTokens: 512,
			signal: requestSignal,
		},
	);
	if (message.stopReason === "error" || message.stopReason === "aborted") return undefined;
	const completion = message.content
		.filter((part): part is Extract<(typeof message.content)[number], { type: "text" }> => part.type === "text")
		.map(part => part.text)
		.join("");
	return normalizeTextReviewContextSummary(completion) || undefined;
}
