import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Judge, JudgmentRequest, NoulAnswer, Usage } from "@oh-my-pi/pi-ai";
import type { Rule } from "@oh-my-pi/pi-coding-agent/capability/rule";
import {
	historyOutputs,
	type ParsedGeneratedRule,
	parseGeneratedRule,
	sanitizeRuleName,
	validateParsedRuleAgainstAssistantHistory,
	validateRuleAgainstAssistantHistory,
} from "@oh-my-pi/pi-coding-agent/modes/controllers/omfg-rule";
import { TtsrToolInspector } from "@oh-my-pi/pi-coding-agent/session/ttsr-outputs";

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

/** `write` exposes its source like the real tool, so AST and condition checks see code, not JSON. */
const inspector = new TtsrToolInspector(
	() => [
		{
			name: "write",
			matcherDigest: (args: unknown) =>
				args && typeof args === "object" && "content" in args && typeof args.content === "string"
					? args.content
					: undefined,
		},
	],
	() => "/work",
);

function outputsOf(messages: AgentMessage[]) {
	return historyOutputs(messages, inspector);
}

async function ruleMatchesAssistantHistory(rule: Rule, messages: AgentMessage[]): Promise<boolean> {
	return (await validateRuleAgainstAssistantHistory(rule, outputsOf(messages), undefined)).matched;
}

/** Judge answering every question with `noul`, recording requests. */
function fixedJudge(noul: number) {
	const requests: JudgmentRequest[] = [];
	const judge = {
		label: "fixed",
		judge: async (request: JudgmentRequest) => {
			requests.push(request);
			const answers: Record<string, NoulAnswer> = {};
			for (const id in request.questions) answers[id] = { type: "noul", noul };
			return { api: "fixed", provider: "fixed", model: "fixed", answers, usage };
		},
	} as unknown as Judge;
	return { judge, requests };
}

function ruleJson(fields: {
	name: string;
	description?: string;
	condition?: string | string[];
	astCondition?: string | string[];
	question?: string;
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
			error: "Generated rule JSON must include a `condition`, `astCondition`, or `question`",
		});
		expect(parseGeneratedRule(ruleJson({ name: "no-scope", condition: "x" }))).toEqual({
			error: "Generated rule JSON must include at least one scope",
		});
		const invalidRegex = parseGeneratedRule(ruleJson({ name: "invalid-regex", condition: "[", scope: "text" }));
		expect("error" in invalidRegex ? invalidRegex.error : "").toContain("Invalid condition regex");
	});

	it("round-trips astCondition and question triggers through the rule file", () => {
		const ast = mustParse(
			ruleJson({
				name: "go-range-int",
				astCondition: "for $I := 0; $I < $N; $I++ { $$$BODY }",
				scope: "tool:write(*.go)",
			}),
		);
		expect(ast.rule.astCondition).toEqual(["for $I := 0; $I < $N; $I++ { $$$BODY }"]);
		expect(ast.rule.condition).toBeUndefined();

		const judged = mustParse(
			ruleJson({ name: "honest-tests", question: 'Does the reply claim "tests pass"?', scope: "text" }),
		);
		expect(judged.rule.question).toBe('Does the reply claim "tests pass"?');
		expect(judged.fileContent).not.toContain("condition:");
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

describe("validateRuleAgainstAssistantHistory", () => {
	it("matches edit tool arguments under a scoped TypeScript path", async () => {
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

		expect(await ruleMatchesAssistantHistory(rule, messages)).toBe(true);
	});

	it("matches assistant prose in text scope", async () => {
		const { rule } = mustParse(ruleJson({ name: "no-handwave", condition: "cut corners", scope: "text" }));
		const messages: AgentMessage[] = [
			createAssistantMessage([{ type: "text", text: "I should not cut corners here." }]),
		];

		expect(await ruleMatchesAssistantHistory(rule, messages)).toBe(true);
	});

	it("matches case-insensitively when the condition leads with (?i)", async () => {
		const { rule } = mustParse(ruleJson({ name: "no-preexisting", condition: "(?i)pre.existing", scope: "text" }));
		const messages: AgentMessage[] = [
			createAssistantMessage([{ type: "text", text: "These are Pre-existing failures." }]),
		];

		expect(await ruleMatchesAssistantHistory(rule, messages)).toBe(true);
	});

	it("returns false when the pattern is absent", async () => {
		const { rule } = mustParse(ruleJson({ name: "absent", condition: "needle", scope: "text" }));
		const messages: AgentMessage[] = [createAssistantMessage([{ type: "text", text: "Only hay here." }])];

		expect(await ruleMatchesAssistantHistory(rule, messages)).toBe(false);
	});

	it("returns false when the rule cannot be registered", async () => {
		const { rule } = mustParse(ruleJson({ name: "base", condition: "needle", scope: "text" }));
		const invalidRule: Rule = { ...rule, name: "no-condition", condition: undefined };

		expect(
			await ruleMatchesAssistantHistory(invalidRule, [createAssistantMessage([{ type: "text", text: "needle" }])]),
		).toBe(false);
	});

	it("matches astCondition against the source a write produced", async () => {
		const { rule } = mustParse(
			ruleJson({
				name: "go-range-int",
				astCondition: "for $I := 0; $I < $N; $I++ { $$$BODY }",
				scope: "tool:write(*.go)",
			}),
		);
		const write = (content: string) => [
			createAssistantMessage([
				{ type: "toolCall", id: "w", name: "write", arguments: { path: "main.go", content } },
			]),
		];

		expect(
			await ruleMatchesAssistantHistory(
				rule,
				write("package main\n\nfunc f(n int) {\n\tfor i := 0; i < n; i++ {\n\t\tprintln(i)\n\t}\n}\n"),
			),
		).toBe(true);
		expect(
			await ruleMatchesAssistantHistory(
				rule,
				write("package main\n\nfunc f(n int) {\n\tfor i := range n {\n\t\tprintln(i)\n\t}\n}\n"),
			),
		).toBe(false);
	});

	it("confirms a question rule only through the judge, after its prefilter passes", async () => {
		const { rule } = mustParse(
			ruleJson({
				name: "honest-tests",
				condition: "(?i)tests pass",
				question: "Does the reply claim tests pass without having run them?",
				scope: "text",
			}),
		);
		const claim = [createAssistantMessage([{ type: "text", text: "All tests pass." }])];

		const yes = fixedJudge(0.9);
		expect(await validateRuleAgainstAssistantHistory(rule, outputsOf(claim), yes.judge)).toEqual({
			matched: true,
		});

		const no = fixedJudge(0.1);
		const rejected = await validateRuleAgainstAssistantHistory(rule, outputsOf(claim), no.judge);
		expect(rejected.matched).toBe(false);
		expect(rejected.judgeUnavailable).toBeUndefined();

		const unjudged = await validateRuleAgainstAssistantHistory(rule, outputsOf(claim), undefined);
		expect(unjudged).toMatchObject({ matched: false, judgeUnavailable: true });

		// Prefilter miss: the question is never asked.
		const quiet = fixedJudge(0.9);
		const prefiltered = await validateRuleAgainstAssistantHistory(
			rule,
			outputsOf([createAssistantMessage([{ type: "text", text: "Refactor done." }])]),
			quiet.judge,
		);
		expect(prefiltered.matched).toBe(false);
		expect(quiet.requests).toHaveLength(0);
	});

	it("repairs one layer of double-escaped regex condition while parsing", async () => {
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
		expect(await ruleMatchesAssistantHistory(candidate.rule, messages)).toBe(true);
		const validation = await validateParsedRuleAgainstAssistantHistory(candidate, outputsOf(messages), undefined);
		expect(validation.repairedCondition).toBe(false);
		expect(validation.validation.matched).toBe(true);
	});
});
