/**
 * Rulebook Tool
 *
 * Allows the agent to fetch full content of rules that have descriptions.
 * Rules are listed in the system prompt with name + description; this tool
 * retrieves the complete rule content on demand.
 */

import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { Type } from "@sinclair/typebox";
import type { Rule } from "../../capability/rule";

export interface RulebookToolDetails {
	type: "rulebook";
	ruleName: string;
	found: boolean;
	content?: string;
}

const rulebookSchema = Type.Object({
	name: Type.String({ description: "The name of the rule to fetch" }),
});

/**
 * Create a rulebook tool with access to discovered rules.
 * @param rules - Array of discovered rules (non-TTSR rules with descriptions)
 */
export function createRulebookTool(rules: Rule[]): AgentTool<typeof rulebookSchema> {
	// Build lookup map for O(1) access
	const ruleMap = new Map<string, Rule>();
	for (const rule of rules) {
		ruleMap.set(rule.name, rule);
	}

	const ruleNames = rules.map((r) => r.name);

	return {
		name: "rulebook",
		label: "Rulebook",
		description: `Fetch the full content of a project rule by name. Use this when a rule listed in <available_rules> is relevant to your current task. Available: ${ruleNames.join(", ") || "(none)"}`,
		parameters: rulebookSchema,
		execute: async (_toolCallId: string, { name }: { name: string }) => {
			const rule = ruleMap.get(name);

			if (!rule) {
				const available = ruleNames.join(", ");
				return {
					content: [{ type: "text", text: `Rule "${name}" not found. Available rules: ${available || "(none)"}` }],
					details: {
						type: "rulebook",
						ruleName: name,
						found: false,
					} satisfies RulebookToolDetails,
				};
			}

			return {
				content: [{ type: "text", text: `# Rule: ${rule.name}\n\n${rule.content}` }],
				details: {
					type: "rulebook",
					ruleName: name,
					found: true,
					content: rule.content,
				} satisfies RulebookToolDetails,
			};
		},
	};
}

/**
 * Filter rules to only those suitable for the rulebook (have descriptions, no TTSR trigger).
 */
export function filterRulebookRules(rules: Rule[]): Rule[] {
	return rules.filter((rule) => {
		// Exclude TTSR rules (handled separately by streaming)
		if (rule.ttsrTrigger) return false;
		// Exclude always-apply rules (already in context)
		if (rule.alwaysApply) return false;
		// Must have a description for agent to know when to fetch
		if (!rule.description) return false;
		return true;
	});
}

/**
 * Format rules for inclusion in the system prompt.
 * Lists rule names and descriptions so the agent knows what's available.
 */
export function formatRulesForPrompt(rules: Rule[]): string {
	if (rules.length === 0) {
		return "";
	}

	const lines = [
		"\n\n## Available Rules",
		"",
		"The following project rules are available. Use the `rulebook` tool to fetch a rule's full content when it's relevant to your task.",
		"",
		"<available_rules>",
	];

	for (const rule of rules) {
		lines.push("  <rule>");
		lines.push(`    <name>${escapeXml(rule.name)}</name>`);
		lines.push(`    <description>${escapeXml(rule.description || "")}</description>`);
		if (rule.globs && rule.globs.length > 0) {
			lines.push(`    <globs>${escapeXml(rule.globs.join(", "))}</globs>`);
		}
		lines.push("  </rule>");
	}

	lines.push("</available_rules>");

	return lines.join("\n");
}

function escapeXml(str: string): string {
	return str
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}
