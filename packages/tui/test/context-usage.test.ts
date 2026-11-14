/**
 * Contract: tool schema token estimation reflects the wire JSON Schema.
 *
 * Tools authored with arktype must be counted by the JSON Schema providers
 * actually receive — not by stringifying the arktype instance's enumerable
 * internals, which massively overcounts.
 */
import { describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { Model, ModelSpec } from "@oh-my-pi/pi-catalog/types";
import { Tokenizer } from "@oh-my-pi/pi-agent-core";
import { normalizeTools } from "@oh-my-pi/pi-agent-core/agent-loop";
import {
	compactionContextTokens,
	DEFAULT_COMPACTION_SETTINGS,
	shouldCompact,
} from "@oh-my-pi/pi-agent-core/compaction";
import { arkToWireSchema } from "@oh-my-pi/pi-ai/utils/schema";
import {
	type NonMessageTokenSource,
	computeNonMessageBreakdown,
	computeNonMessageTokens,
	estimateToolSchemaTokens,
	getToolSchemaMetadataRevision,
	invalidateToolSchemaMetadata,
} from "../src/status-line/context-usage";

const tokenizer = new Tokenizer();

describe("estimateToolSchemaTokens", () => {
	it("counts arktype tool schemas by their wire JSON Schema, not arktype internals", () => {
		const parameters = type({
			"query /** search query */": "string",
			"limit?": "number",
		});
		const arktypeEstimate = estimateToolSchemaTokens(
			[{ name: "web_search", description: "Searches the web.", parameters } as never],
			tokenizer,
		);
		const wireEstimate = estimateToolSchemaTokens(
			[{ name: "web_search", description: "Searches the web.", parameters: arkToWireSchema(parameters) } as never],
			tokenizer,
		);
		expect(arktypeEstimate).toBe(wireEstimate);
	});

	it("skips a parameters value that stringifies to undefined, counting exactly name + description", () => {
		// A plain function is neither an arktype schema nor JSON-serializable:
		// the independent unserializable-schema fallback must skip it while the
		// tool's own strings still contribute their exact token share.
		const estimate = estimateToolSchemaTokens(
			[{ name: "odd", description: "odd tool", parameters: function bareSchema() {} } as never],
			tokenizer,
		);
		expect(estimate).toBe(estimateToolSchemaTokens([{ name: "odd", description: "odd tool" } as never], tokenizer));
	});

	it("counts rendered examples, which the agent loop appends to the wire description", () => {
		const tool = { name: "grep", description: "Search files.", parameters: { type: "object" } };
		const examples = [{ caption: "Find TODOs", call: { pattern: "TODO", path: "src" } }];
		const without = estimateToolSchemaTokens([tool as never], tokenizer);
		const withExamples = estimateToolSchemaTokens([{ ...tool, examples } as never], tokenizer);
		expect(withExamples).toBeGreaterThan(without);
	});

	it("skips non-string name/description fragments", () => {
		const estimate = estimateToolSchemaTokens(
			[{ name: "odd", description: undefined, parameters: { type: "object" } } as never],
			tokenizer,
		);
		expect(estimate).toBeGreaterThan(0);
	});

	it("does not reread dynamic metadata until its explicit revision changes", () => {
		let description = "short";
		let reads = 0;
		const tool = {
			name: "dynamic",
			get description() {
				reads++;
				return description;
			},
			parameters: {},
		};
		const tools = [tool];
		const first = estimateToolSchemaTokens(tools, tokenizer);
		expect(reads).toBe(1);
		expect(estimateToolSchemaTokens(tools, tokenizer)).toBe(first);
		expect(reads).toBe(1);

		description = "a substantially longer dynamic description after a live policy update";
		invalidateToolSchemaMetadata(tools);
		expect(getToolSchemaMetadataRevision(tools)).toBe(1);
		expect(estimateToolSchemaTokens(tools, tokenizer)).toBeGreaterThan(first);
		expect(reads).toBe(2);
	});

	it("separates array, tokenizer, source-revision, and prune-mode cache keys", () => {
		let reads = 0;
		const tool = {
			name: "dynamic",
			get description() {
				reads++;
				return "metadata";
			},
			parameters: {},
		};
		const tools = [tool];
		estimateToolSchemaTokens(tools, tokenizer, { sourceRevision: 1 });
		estimateToolSchemaTokens(tools, tokenizer, { sourceRevision: 1 });
		expect(reads).toBe(1);

		estimateToolSchemaTokens(tools, tokenizer, { sourceRevision: 2 });
		expect(reads).toBe(2);
		estimateToolSchemaTokens([...tools], tokenizer, { sourceRevision: 2 });
		expect(reads).toBe(3);
		estimateToolSchemaTokens(tools, new Tokenizer(), { sourceRevision: 2 });
		expect(reads).toBe(4);
		const full = estimateToolSchemaTokens(tools, tokenizer, { sourceRevision: 2 });
		expect(estimateToolSchemaTokens(tools, tokenizer, { sourceRevision: 2, pruneDescriptions: true })).toBeLessThan(
			full,
		);
	});
});

describe("pruned tool description accounting", () => {
	// With the catalog inlined into the system prompt, normalizeTools ships each
	// tool as its name plus the description-stripped schema. Counting the full
	// specs again double-counts every description (issue #17329).
	const tools = [
		{
			name: "grep",
			description: `Search files by regex. ${"Supports globs, context lines, and multiline patterns. ".repeat(20)}`,
			parameters: type({
				"pattern /** regular expression to search for */": "string",
				"path? /** file or directory to search */": "string",
			}),
			examples: [{ caption: "Find TODOs", call: { pattern: "TODO", path: "src" } }],
		},
	];
	const prunedWireTokens = tokenizer.countTokens(
		(normalizeTools(tools as never, { injectIntent: false, pruneDescriptions: true }) ?? []).flatMap(tool =>
			[tool.name, tool.description, JSON.stringify(tool.parameters)].filter(part => part !== ""),
		),
	);

	it("counts the pruned wire specs while the agent prunes, and the full specs otherwise", () => {
		const systemPrompt = ["You are an assistant."];
		let prune = true;
		const agent = { state: { tools }, prunesToolDescriptions: () => prune };
		const session: NonMessageTokenSource = { systemPrompt, agent };
		const pruned = computeNonMessageBreakdown(session, tokenizer).toolsTokens;
		expect(pruned).toBe(prunedWireTokens);
		expect(computeNonMessageTokens(session, tokenizer)).toBe(tokenizer.countTokens(systemPrompt) + pruned);

		// A model or dialect switch flips pruning on the live agent without replacing the roster.
		prune = false;
		const full = computeNonMessageBreakdown(session, tokenizer).toolsTokens;
		expect(full).toBe(estimateToolSchemaTokens(tools as never, tokenizer));
		expect(full).toBeGreaterThan(pruned);
		expect(computeNonMessageTokens(session, tokenizer)).toBe(tokenizer.countTokens(systemPrompt) + full);
	});
});

describe("deferred tool schema accounting", () => {
	it("does not let Cursor's server-side MCP catalog force compaction below provider usage", () => {
		const spec: ModelSpec<"anthropic-messages"> = {
			id: "claude-opus-5-5",
			name: "Claude Opus",
			api: "anthropic-messages",
			provider: "anthropic",
			baseUrl: "https://api.anthropic.com",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 100_000,
			maxTokens: 8192,
		};
		const directModel = buildModel(spec);
		const cursorModel = buildModel({ ...spec, api: "cursor-agent", provider: "cursor" });
		const tools = Array.from({ length: 200 }, (_, index) => ({
			name: `mcp__service__tool_${index}`,
			description: `Search records ${"search account records with detailed query filters and output metadata ".repeat(110)}`,
			parameters: type({ query: "string" }),
		}));
		const systemPrompt = ["You are an assistant."];
		const session: NonMessageTokenSource & { model: Model } = {
			model: directModel,
			systemPrompt,
			agent: { state: { tools } },
		};
		const direct = computeNonMessageTokens(session, tokenizer);
		expect(shouldCompact(compactionContextTokens(9000, direct), 100_000, DEFAULT_COMPACTION_SETTINGS)).toBe(true);

		session.model = cursorModel;
		const cursor = computeNonMessageTokens(session, tokenizer);
		expect(cursor).toBe(tokenizer.countTokens(systemPrompt));
		expect(computeNonMessageBreakdown(session, tokenizer).toolsTokens).toBe(0);
		expect(shouldCompact(compactionContextTokens(9000, cursor), 100_000, DEFAULT_COMPACTION_SETTINGS)).toBe(false);

		session.model = directModel;
		expect(computeNonMessageTokens(session, tokenizer)).toBe(direct);
	});
});

/**
 * Contract: the non-message token totals reflect the CURRENT system prompt,
 * tools, and skills — including after they change via reference replacement
 * (the setSystemPrompt/setTools pattern), and stay stable while those inputs
 * hold the same identity. The memo must never serve a stale value for changed
 * inputs.
 */
describe("computeNonMessageTokens / computeNonMessageBreakdown memoization", () => {
	function makeSession(systemPrompt: string[], tools: unknown[] = [], skills: unknown[] = []) {
		return { systemPrompt, agent: { state: { tools } }, skills };
	}

	it("recomputes when the system prompt reference changes and caches otherwise", () => {
		const session = makeSession(["system prompt alpha"]);
		const first = computeNonMessageTokens(session as never, tokenizer);
		// Same inputs (identical refs) → cached, identical value.
		expect(computeNonMessageTokens(session as never, tokenizer)).toBe(first);
		// Replace the system prompt reference (mirrors setSystemPrompt).
		session.systemPrompt = ["system prompt beta with more tokens than alpha"];
		const afterChange = computeNonMessageTokens(session as never, tokenizer);
		expect(afterChange).toBeGreaterThan(first);
		// Cached on the new inputs.
		expect(computeNonMessageTokens(session as never, tokenizer)).toBe(afterChange);
	});

	it("recomputes the breakdown when the tools reference changes", () => {
		const session = makeSession(["base"], []);
		const before = computeNonMessageBreakdown(session as never, tokenizer);
		expect(before.toolsTokens).toBe(0);
		// New tools array reference (mirrors setTools).
		session.agent.state.tools = [{ name: "search", description: "search the web", parameters: {} }];
		const after = computeNonMessageBreakdown(session as never, tokenizer);
		expect(after.toolsTokens).toBeGreaterThan(0);
		// Cached on the new tools.
		expect(computeNonMessageBreakdown(session as never, tokenizer).toolsTokens).toBe(after.toolsTokens);
	});

	it("shares one cache entry so tokens and breakdown invalidate together", () => {
		const session = makeSession(["shared prompt"]);
		const tokens = computeNonMessageTokens(session as never, tokenizer);
		const breakdown = computeNonMessageBreakdown(session as never, tokenizer);
		// Changing the system prompt ref must invalidate BOTH fields, not just
		// the one most recently touched.
		session.systemPrompt = ["shared prompt but longer now to shift the count"];
		expect(computeNonMessageTokens(session as never, tokenizer)).not.toBe(tokens);
		expect(computeNonMessageBreakdown(session as never, tokenizer).systemPromptTokens).not.toBe(
			breakdown.systemPromptTokens,
		);
	});

	it("invalidates settings-backed dynamic descriptions on the settings revision", () => {
		let description = "short";
		const tool = {
			name: "dynamic",
			get description() {
				return description;
			},
			parameters: {},
		};
		const session = {
			...makeSession(["base"], [tool]),
			settings: { revision: 1, get: () => true },
		};
		const first = computeNonMessageBreakdown(session as never, tokenizer, session.settings.revision).toolsTokens;
		description = "a longer settings-backed description after a live update";
		session.settings.revision++;
		expect(
			computeNonMessageBreakdown(session as never, tokenizer, session.settings.revision).toolsTokens,
		).toBeGreaterThan(first);
	});
});

/**
 * Contract: Skills and Instruction files count exactly the source ranges the prompt build recorded,
 * through the same attribution `/context` uses; a source whose block changed after the build is
 * counted with its block instead.
 */
describe("computeNonMessageBreakdown prompt sources", () => {
	const skillLine = "- vis: small visible skill";
	const file = '<file path="/r/AGENTS.md">\nRules\n</file>';
	const blocks = [`You are an agent.\n${skillLine}\nEnd.`, `Context:\n${file}`];
	const systemPromptSources = {
		blocks,
		sources: [
			{ id: "skill-0", kind: "skills" as const, label: "vis", block: 0, start: 18, end: 18 + skillLine.length },
			{
				id: "instruction-0",
				kind: "instruction-files" as const,
				label: "/r/AGENTS.md",
				block: 1,
				start: 9,
				end: 9 + file.length,
			},
		],
	};
	const session = (systemPrompt: string[]) =>
		({ systemPrompt, agent: { state: { tools: [] } }, systemPromptSources }) as never;

	it("counts recorded sources apart from their blocks", () => {
		const b = computeNonMessageBreakdown(session(blocks), tokenizer);
		expect(b).toMatchObject({
			skillsTokens: tokenizer.countTokens(skillLine),
			instructionFilesTokens: tokenizer.countTokens(file),
			systemPromptTokens: tokenizer.countTokens("You are an agent.\n\nEnd."),
			systemContextTokens: tokenizer.countTokens("Context:\n"),
		});
	});

	it("counts a source with its block once that block changed after the build", () => {
		const changed = [`${blocks[0]}\nhook addition`, blocks[1]!];
		const b = computeNonMessageBreakdown(session(changed), tokenizer);
		expect(b.skillsTokens).toBe(0);
		expect(b.systemPromptTokens).toBe(tokenizer.countTokens(changed[0]!));
		expect(b.instructionFilesTokens).toBe(tokenizer.countTokens(file));
	});
});

/**
 * Contract: a tool or system-prompt section with a missing (`undefined`) description/text must not
 * crash the token estimate. Extensions can contribute tools whose `description` is absent at runtime
 * (the field is typed `string` but the extension API does not enforce it); before the guard, the
 * `undefined` fragment reached the tokenizer and threw, killing every subagent before its first turn
 * (issue #9331). Each path must instead yield a finite, non-negative estimate.
 */
describe("non-message estimates tolerate a missing description", () => {
	const readTool = { name: "read", description: "read files", parameters: {} };

	it("computeNonMessageBreakdown does not throw on an undefined system-context section", () => {
		const session = {
			systemPrompt: ["primary prompt", undefined, "trailing context"],
			agent: { state: { tools: [readTool] } },
		} as never;
		const b = computeNonMessageBreakdown(session, tokenizer);
		expect(Number.isFinite(b.systemContextTokens)).toBe(true);
		expect(b.systemContextTokens).toBeGreaterThanOrEqual(0);
	});
});
