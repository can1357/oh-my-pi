import type { ThinkingLevel } from "@pk-nerdsaver-ai/pi-agent-core";
import type { Api, ApiKey, AssistantMessage, Model, ServiceTier } from "@pk-nerdsaver-ai/pi-ai";
import { completeSimple, validateToolCall } from "@pk-nerdsaver-ai/pi-ai";
import { prompt } from "@pk-nerdsaver-ai/pi-utils";
import { type } from "arktype";
import summarySystemPrompt from "../../commit/prompts/summary-system.md" with { type: "text" };
import summaryUserPrompt from "../../commit/prompts/summary-user.md" with { type: "text" };
import type { CommitSummary } from "../../commit/types";
import { toReasoningEffort } from "../../thinking";
import { extractTextContent, extractToolCall } from "../utils";

const SummaryToolSchema = type({
	summary: "string",
});

const SummaryTool = {
	name: "create_commit_summary",
	description: "Generate the summary line for a conventional commit message.",
	parameters: SummaryToolSchema,
};

export interface SummaryInput {
	model: Model<Api>;
	apiKey: ApiKey;
	thinkingLevel?: ThinkingLevel;
	serviceTier?: ServiceTier;
	commitType: string;
	scope: string | null;
	details: string[];
	stat: string;
	maxChars: number;
	userContext?: string;
}

/**
 * Generate a commit summary line for the conventional commit header.
 */
export async function generateSummary({
	model,
	apiKey,
	thinkingLevel,
	serviceTier,
	commitType,
	scope,
	details,
	stat,
	maxChars,
	userContext,
}: SummaryInput): Promise<CommitSummary> {
	const systemPrompt = renderSummaryPrompt({ commitType, scope, maxChars });
	const userPrompt = prompt.render(summaryUserPrompt, {
		user_context: userContext,
		details: details.join("\n"),
		stat,
	});

	const response = await completeSimple(
		model,
		{
			systemPrompt: [systemPrompt],
			messages: [{ role: "user", content: userPrompt, timestamp: Date.now() }],
			tools: [SummaryTool],
		},
		{ apiKey, maxTokens: 200, reasoning: toReasoningEffort(thinkingLevel), serviceTier },
	);

	return parseSummaryFromResponse(response, commitType, scope);
}

function renderSummaryPrompt({
	commitType,
	scope,
	maxChars,
}: {
	commitType: string;
	scope: string | null;
	maxChars: number;
}): string {
	const scopePrefix = scope ? `(${scope})` : "";
	return prompt.render(summarySystemPrompt, {
		commit_type: commitType,
		scope_prefix: scopePrefix,
		chars: String(maxChars),
	});
}

function parseSummaryFromResponse(message: AssistantMessage, commitType: string, scope: string | null): CommitSummary {
	const toolCall = extractToolCall(message, "create_commit_summary");
	if (toolCall) {
		const parsed = validateToolCall([SummaryTool], toolCall) as (typeof SummaryToolSchema)["infer"];
		return { summary: stripTypePrefix(parsed.summary, commitType, scope) };
	}
	const text = extractTextContent(message);
	return { summary: stripTypePrefix(text, commitType, scope) };
}

export function stripTypePrefix(summary: string, commitType: string, scope: string | null): string {
	const trimmed = summary.trim();
	const scopePart = scope ? `(${scope})` : "";
	const withScope = `${commitType}${scopePart}: `;
	if (trimmed.startsWith(withScope)) {
		return trimmed.slice(withScope.length).trim();
	}
	const withoutScope = `${commitType}: `;
	if (trimmed.startsWith(withoutScope)) {
		return trimmed.slice(withoutScope.length).trim();
	}
	return trimmed;
}
