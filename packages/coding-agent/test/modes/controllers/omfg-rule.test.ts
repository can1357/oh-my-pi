import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Usage } from "@oh-my-pi/pi-ai";
import type { Rule } from "@oh-my-pi/pi-coding-agent/capability/rule";
import {
	type ParsedGeneratedRule,
	parseGeneratedRule,
	ruleMatchesAssistantHistory,
	sanitizeRuleName,
	validateParsedRuleAgainstAssistantHistory,
} from "@oh-my-pi/pi-coding-agent/modes/controllers/omfg-rule";

const usage: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function createAssistantMessage(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage,
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function mustParse(text: string): ParsedGeneratedRule {
	const result = parseGeneratedRule(text);
	if ("error" in result) {
		throw new Error(result.error);
	}
	return result;
}

function ruleJson(fields: {
	name: string;
	description?: string;
	condition?: string | string[];
	scope?: string | string[];
	body?: string;
}): string {
	return JSON.stringify({
		description: "Generated rule",
		body: "Use the safer pattern.",
		...fields,
	});
}

describe("omfg rule parsing", () => {
	it("extracts JSON and assembles markdown with nested fences in the body", () => {
		const result = mustParse(
			ruleJson({
				name: "TypeScript Any Guard",
				description: "No any",
				condition: ": any|as any",
				scope: ["tool:edit(*.ts)", "tool:write(*.ts)"],
				body: "Use `unknown` instead.\n\n```typescript\nconst value: unknown = input;\n```",
			}),
		);

		expect(result.rule.name).toBe("typescript-any-guard");
		expect(result.rule.condition).toEqual([": any|as any"]);
		expect(result.rule.scope).toEqual(["tool:edit(*.ts)", "tool:write(*.ts)"]);
		expect(result.fileContent).toStartWith("---");
		expect(result.fileContent).toContain("```typescript");
	});

	it("accepts a fenced JSON object", () => {
		const result = mustParse(
			`Here:\n\`\`\`json\n${ruleJson({ name: "no-handwave", condition: "cut corners", scope: "text" })}\n\`\`\``,
		);

		expect(result.rule.name).toBe("no-handwave");
		expect(result.rule.scope).toEqual(["text"]);
	});

	it("reports malformed model output", () => {
		expect(parseGeneratedRule("no object")).toEqual({ error: "Missing generated rule JSON object" });
		expect(parseGeneratedRule(ruleJson({ name: "", condition: "x", scope: "text" }))).toEqual({
			error: "Generated rule JSON must include a non-empty name",
		});
		expect(parseGeneratedRule(ruleJson({ name: "no-condition", scope: "text" }))).toEqual({
			error: "Generated rule JSON must include at least one condition",
		});
		expect(parseGeneratedRule(ruleJson({ name: "no-scope", condition: "x" }))).toEqual({
			error: "Generated rule JSON must include at least one scope",
		});
		const invalidRegex = parseGeneratedRule(ruleJson({ name: "invalid-regex", condition: "[", scope: "text" }));
		expect("error" in invalidRegex ? invalidRegex.error : "").toContain("Invalid condition regex");
	});

	it("accepts a leading inline regex flag in generated conditions", () => {
		const result = mustParse(ruleJson({ name: "no-preexisting", condition: "(?i)pre.existing", scope: "text" }));
		expect(result.rule.condition).toEqual(["(?i)pre.existing"]);
	});

	it("sanitizes generated names to slugs", () => {
		expect(sanitizeRuleName("  Caps & Spaces!!  ")).toBe("caps-spaces");
		expect(sanitizeRuleName("already_ok-123")).toBe("already_ok-123");
		expect(sanitizeRuleName("***")).toBe("");
	});
});

describe("ruleMatchesAssistantHistory", () => {
	it("matches edit tool arguments under a scoped TypeScript path", () => {
		const { rule } = mustParse(ruleJson({ name: "ts-no-any", condition: ": any|as any", scope: "tool:edit(*.ts)" }));
		const messages: AgentMessage[] = [
			createAssistantMessage([
				{
					type: "toolCall",
					id: "call-1",
					name: "edit",
					arguments: { path: "src/example.ts", content: "const value: any = input;" },
				},
			]),
		];

		expect(ruleMatchesAssistantHistory(rule, messages)).toBe(true);
	});

	it("matches assistant prose in text scope", () => {
		const { rule } = mustParse(ruleJson({ name: "no-handwave", condition: "cut corners", scope: "text" }));
		const messages: AgentMessage[] = [
			createAssistantMessage([{ type: "text", text: "I should not cut corners here." }]),
		];

		expect(ruleMatchesAssistantHistory(rule, messages)).toBe(true);
	});

	it("matches case-insensitively when the condition leads with (?i)", () => {
		const { rule } = mustParse(ruleJson({ name: "no-preexisting", condition: "(?i)pre.existing", scope: "text" }));
		const messages: AgentMessage[] = [
			createAssistantMessage([{ type: "text", text: "These are Pre-existing failures." }]),
		];

		expect(ruleMatchesAssistantHistory(rule, messages)).toBe(true);
	});

	it("returns false when the pattern is absent", () => {
		const { rule } = mustParse(ruleJson({ name: "absent", condition: "needle", scope: "text" }));
		const messages: AgentMessage[] = [createAssistantMessage([{ type: "text", text: "Only hay here." }])];

		expect(ruleMatchesAssistantHistory(rule, messages)).toBe(false);
	});

	it("returns false when the rule cannot be registered", () => {
		const { rule } = mustParse(ruleJson({ name: "base", condition: "needle", scope: "text" }));
		const invalidRule: Rule = { ...rule, name: "no-condition", condition: undefined };

		expect(
			ruleMatchesAssistantHistory(invalidRule, [createAssistantMessage([{ type: "text", text: "needle" }])]),
		).toBe(false);
	});

	it("repairs one layer of double-escaped regex condition while parsing", () => {
		const candidate = mustParse(
			ruleJson({
				name: "ruby-no-eval",
				condition: "\\\\beval\\\\s*\\\\(",
				scope: "tool:write(*.rb)",
			}),
		);
		const messages: AgentMessage[] = [
			createAssistantMessage([
				{
					type: "toolCall",
					id: "call-1",
					name: "write",
					arguments: { path: "/tmp/bad_quality.rb", content: 'eval("@last_result = #{result}")' },
				},
			]),
		];

		expect(candidate.rule.condition).toEqual(["\\beval\\s*\\("]);
		expect(ruleMatchesAssistantHistory(candidate.rule, messages)).toBe(true);
		const validation = validateParsedRuleAgainstAssistantHistory(candidate, messages);
		expect(validation.repairedCondition).toBe(false);
		expect(validation.validation.matched).toBe(true);
	});
});
