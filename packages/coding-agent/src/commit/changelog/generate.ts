import type { ThinkingLevel } from "@pk-nerdsaver-ai/pi-agent-core";
import type { Api, ApiKey, AssistantMessage, Model, ServiceTier } from "@pk-nerdsaver-ai/pi-ai";
import { completeSimple, validateToolCall } from "@pk-nerdsaver-ai/pi-ai";
import { prompt } from "@pk-nerdsaver-ai/pi-utils";
import { type } from "arktype";
import changelogSystemPrompt from "../../commit/prompts/changelog-system.md" with { type: "text" };
import changelogUserPrompt from "../../commit/prompts/changelog-user.md" with { type: "text" };
import type { ChangelogGenerationResult } from "../../commit/types";
import { toReasoningEffort } from "../../thinking";
import { extractTextContent, extractToolCall, parseJsonPayload } from "../utils";

// Build the changelog entry schema with arktype
// Each category maps to an optional array of strings
const changelogEntriesSchema = type({
	"Breaking Changes?": "string[]",
	"Added?": "string[]",
	"Changed?": "string[]",
	"Deprecated?": "string[]",
	"Removed?": "string[]",
	"Fixed?": "string[]",
	"Security?": "string[]",
});

export const changelogTool = {
	name: "create_changelog_entries",
	description: "Generate changelog entries grouped by Keep a Changelog categories.",
	parameters: type({ entries: changelogEntriesSchema }),
};

export interface ChangelogPromptInput {
	model: Model<Api>;
	apiKey: ApiKey;
	thinkingLevel?: ThinkingLevel;
	serviceTier?: ServiceTier;
	changelogPath: string;
	isPackageChangelog: boolean;
	existingEntries?: string;
	stat: string;
	diff: string;
}

export async function generateChangelogEntries({
	model,
	apiKey,
	thinkingLevel,
	serviceTier,
	changelogPath,
	isPackageChangelog,
	existingEntries,
	stat,
	diff,
}: ChangelogPromptInput): Promise<ChangelogGenerationResult> {
	const userContent = prompt.render(changelogUserPrompt, {
		changelog_path: changelogPath,
		is_package_changelog: isPackageChangelog,
		existing_entries: existingEntries,
		stat,
		diff,
	});
	const response = await completeSimple(
		model,
		{
			systemPrompt: [prompt.render(changelogSystemPrompt)],
			messages: [{ role: "user", content: userContent, timestamp: Date.now() }],
			tools: [changelogTool],
		},
		{ apiKey, maxTokens: 1200, reasoning: toReasoningEffort(thinkingLevel), serviceTier },
	);

	const parsed = parseChangelogResponse(response);
	return { entries: dedupeEntries(parsed.entries) };
}

function parseChangelogResponse(message: AssistantMessage): ChangelogGenerationResult {
	const toolCall = extractToolCall(message, "create_changelog_entries");
	if (toolCall) {
		const parsed = validateToolCall([changelogTool], toolCall) as typeof changelogTool.parameters.infer;
		return { entries: parsed.entries ?? {} };
	}

	const text = extractTextContent(message);
	const parsed = parseJsonPayload(text) as ChangelogGenerationResult;
	return { entries: parsed.entries ?? {} };
}

function dedupeEntries(entries: Record<string, string[]>): Record<string, string[]> {
	const result: Record<string, string[]> = {};
	for (const [category, values] of Object.entries(entries)) {
		const seen = new Set<string>();
		const cleaned: string[] = [];
		for (const value of values) {
			const trimmed = value.trim().replace(/\.$/, "");
			const key = trimmed.toLowerCase();
			if (!trimmed || seen.has(key)) continue;
			seen.add(key);
			cleaned.push(trimmed);
		}
		if (cleaned.length > 0) {
			result[category] = cleaned;
		}
	}
	return result;
}
