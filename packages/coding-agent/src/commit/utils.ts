import type { AssistantMessage, ToolCall } from "@oh-my-pi/pi-ai";
import type { ChangelogCategory, ConventionalAnalysis, ConventionalDetail } from "./types";

export function extractToolCall(message: AssistantMessage, name: string): ToolCall | undefined {
	return message.content.find(content => content.type === "toolCall" && content.name === name) as ToolCall | undefined;
}

export function extractTextContent(message: AssistantMessage): string {
	return message.content
		.filter(content => content.type === "text")
		.map(content => content.text)
		.join("")
		.trim();
}

export function parseJsonPayload(text: string): unknown {
	const trimmed = text.trim();
	if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
		return JSON.parse(trimmed) as unknown;
	}
	const match = trimmed.match(/\{[\s\S]*\}/);
	if (!match) {
		throw new Error("No JSON payload found in response");
	}
	return JSON.parse(match[0]) as unknown;
}

export function normalizeAnalysis(parsed: {
	type: ConventionalAnalysis["type"];
	scope: string | null;
	details: Array<{ text: string; changelog_category?: ChangelogCategory; user_visible?: boolean }>;
	issue_refs: string[];
}): ConventionalAnalysis {
	return {
		type: parsed.type,
		scope: parsed.scope?.trim() || null,
		details: parsed.details.map(detail => ({
			text: detail.text.trim(),
			changelogCategory: detail.user_visible ? detail.changelog_category : undefined,
			userVisible: detail.user_visible ?? false,
		})),
		issueRefs: parsed.issue_refs ?? [],
	};
}

export function normalizeDetails(
	details: Array<{
		text: string;
		changelog_category?: ConventionalDetail["changelogCategory"];
		user_visible?: boolean;
	}>,
): ConventionalDetail[] {
	return details.map(detail => ({
		text: detail.text.trim(),
		changelogCategory: detail.user_visible ? detail.changelog_category : undefined,
		userVisible: detail.user_visible ?? false,
	}));
}
