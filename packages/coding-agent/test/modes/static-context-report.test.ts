import { describe, expect, it } from "bun:test";
import { Tokenizer } from "@oh-my-pi/pi-agent-core";
import {
	buildStaticContextReport,
	formatStaticContextReport,
	reconcileStaticPromptContextSources,
	type StaticContextSources,
} from "@oh-my-pi/pi-coding-agent/modes/utils/static-context-report";

const tokenizer = new Tokenizer();
const renderedSystemTemplate = ["system α", "policy"];
const nativeToolSchemas = ["read", '{"type":"object"}'];
const projectContextBlocks = ["AGENTS.md\nproject rules"];
const skillCatalog = ["- qa: File issues", "- tdd: Write a failing test"];
const sources = {
	completeStaticContext: [
		[...renderedSystemTemplate, ...skillCatalog].join(""),
		...projectContextBlocks,
		...nativeToolSchemas,
	],
	renderedSystemTemplate,
	nativeToolSchemas,
	projectContextBlocks,
	skillCatalog,
} satisfies StaticContextSources;

function expectedTokens(fragments: readonly string[]): number {
	return tokenizer.countTokens(Array.from(fragments));
}

describe("buildStaticContextReport", () => {
	it("reconciles every static component to canonical token and UTF-8 byte counts", () => {
		const report = buildStaticContextReport({ sources, tokenizer });
		const [systemTemplate, toolSchemas, contextBlocks, skillCatalog] = report.components;
		const rawSystemTokens = expectedTokens(sources.renderedSystemTemplate);
		const expectedToolTokens = expectedTokens(sources.nativeToolSchemas);
		const expectedContextTokens = expectedTokens(sources.projectContextBlocks);
		const expectedSkillTokens = expectedTokens(sources.skillCatalog);
		const expectedTotalTokens = expectedTokens(sources.completeStaticContext);
		const expectedSystemTokens =
			rawSystemTokens +
			expectedTotalTokens -
			(rawSystemTokens + expectedToolTokens + expectedContextTokens + expectedSkillTokens);
		const rawSystemBytes = Buffer.byteLength(sources.renderedSystemTemplate.join(""), "utf8");
		const expectedTotalBytes = Buffer.byteLength(sources.completeStaticContext.join(""), "utf8");
		const measuredBytes =
			rawSystemBytes +
			Buffer.byteLength(sources.nativeToolSchemas.join(""), "utf8") +
			Buffer.byteLength(sources.projectContextBlocks.join(""), "utf8") +
			Buffer.byteLength(sources.skillCatalog.join(""), "utf8");
		const expectedSystemBytes = rawSystemBytes + expectedTotalBytes - measuredBytes;

		expect(systemTemplate).toMatchObject({
			id: "renderedSystemTemplate",
			bytes: expectedSystemBytes,
			tokens: expectedSystemTokens,
		});
		expect(toolSchemas).toMatchObject({
			id: "nativeToolSchemas",
			bytes: Buffer.byteLength(sources.nativeToolSchemas.join(""), "utf8"),
			tokens: expectedToolTokens,
		});
		expect(contextBlocks).toMatchObject({
			id: "projectContextBlocks",
			bytes: Buffer.byteLength(sources.projectContextBlocks.join(""), "utf8"),
			tokens: expectedContextTokens,
		});
		expect(skillCatalog).toMatchObject({
			id: "skillCatalog",
			bytes: Buffer.byteLength(sources.skillCatalog.join(""), "utf8"),
			tokens: expectedSkillTokens,
		});
		expect(report.total).toEqual({
			bytes: expectedTotalBytes,
			tokens: expectedTotalTokens,
		});
		expect(report.components.reduce((sum, component) => sum + component.bytes, 0)).toBe(report.total.bytes);
		expect(report.components.reduce((sum, component) => sum + component.tokens, 0)).toBe(report.total.tokens);
	});

	it("assigns provider-boundary byte and token residuals to the rendered template", () => {
		const completeStaticContext = [...sources.completeStaticContext, "\n"];
		const report = buildStaticContextReport({
			sources: { ...sources, completeStaticContext },
			tokenizer,
		});
		const rawSystemBytes = Buffer.byteLength(sources.renderedSystemTemplate.join(""), "utf8");
		const measuredTokens =
			expectedTokens(sources.renderedSystemTemplate) +
			expectedTokens(sources.nativeToolSchemas) +
			expectedTokens(sources.projectContextBlocks) +
			expectedTokens(sources.skillCatalog);

		expect(report.components[0].bytes).toBe(rawSystemBytes + 1);
		expect(report.components[0].tokens).toBe(
			expectedTokens(sources.renderedSystemTemplate) + report.total.tokens - measuredTokens,
		);
		expect(report.components.reduce((sum, component) => sum + component.bytes, 0)).toBe(report.total.bytes);
		expect(report.components.reduce((sum, component) => sum + component.tokens, 0)).toBe(report.total.tokens);
	});

	it("rejects component splits that cannot reconcile to the complete provider sequence", () => {
		expect(() =>
			buildStaticContextReport({
				sources: { ...sources, completeStaticContext: [] },
				tokenizer,
			}),
		).toThrow("Static context component measurements exceed the complete provider-boundary sequence");
	});

	it("reports stable component shares and model-window percentage", () => {
		const withoutWindow = buildStaticContextReport({ sources, tokenizer });
		const contextWindowTokens = withoutWindow.total.tokens * 8;
		const report = buildStaticContextReport({ sources, tokenizer, contextWindowTokens });
		if (report.contextWindow.kind !== "known") throw new Error("Expected a known context window");

		expect(report.contextWindow).toEqual({ kind: "known", tokens: contextWindowTokens, percentUsed: 12.5 });
		expect(report.components[0].percentOfStaticTokens).toBe(
			(report.components[0].tokens / report.total.tokens) * 100,
		);
		expect(report.components.reduce((sum, component) => sum + component.percentOfStaticTokens, 0)).toBeCloseTo(
			100,
			10,
		);
		expect(formatStaticContextReport(report)).toContain(
			`Model context window: ${contextWindowTokens} tokens (12.5% used by static context)`,
		);
	});

	it("keeps a no-model startup report measurable without inventing a percentage", () => {
		const report = buildStaticContextReport({ sources, tokenizer });

		expect(report.contextWindow).toEqual({ kind: "unknown" });
		expect(formatStaticContextReport(report)).toEndWith("Model context window: unknown");
	});
});

describe("reconcileStaticPromptContextSources", () => {
	const captured = {
		completeSystemPrompt: ["base", "project"],
		renderedSystemTemplate: ["base"],
		projectContextBlocks: ["project"],
		skillCatalog: [],
	};

	it("keeps captured ownership when the effective prompt only appends blocks", () => {
		const reconciled = reconcileStaticPromptContextSources(captured, ["base", "project", "memory"]);

		expect(reconciled.completeSystemPrompt).toEqual(["base", "project", "memory"]);
		expect(reconciled.projectContextBlocks).toEqual(["project"]);
	});

	it("treats a replaced effective prompt as the rendered template", () => {
		const reconciled = reconcileStaticPromptContextSources(captured, ["extension replacement"]);

		expect(reconciled).toEqual({
			completeSystemPrompt: ["extension replacement"],
			renderedSystemTemplate: ["extension replacement"],
			projectContextBlocks: [],
			skillCatalog: [],
		});
	});
});
