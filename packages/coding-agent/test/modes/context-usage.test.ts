/**
 * Contract: tool schema token estimation reflects the wire JSON Schema.
 *
 * Tools authored with arktype must be counted by the JSON Schema providers
 * actually receive — not by stringifying the arktype instance's enumerable
 * internals, which massively overcounts.
 */
import { describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Tokenizer } from "@oh-my-pi/pi-agent-core";
import { arkToWireSchema } from "@oh-my-pi/pi-ai/utils/schema";
import {
	type ContextBreakdown,
	computeNonMessageBreakdown,
	computeNonMessageTokens,
	estimateToolSchemaTokens,
	renderContextUsage,
} from "@oh-my-pi/pi-coding-agent/modes/utils/context-usage";
import { applyToolProxy } from "../../src/extensibility/tool-proxy";

const tokenizer = new Tokenizer();

/** An arktype-shaped callable schema from an external arktype copy: a plain
 * function carrying `toJsonSchema`/`assert` that — unlike omptype schemas —
 * HAS `Function.prototype.bind`. */
function bindCapableSchema() {
	return Object.assign((value: unknown) => value, {
		toJsonSchema: () => ({ type: "object", properties: { a: { type: "string" } } }),
		assert: (value: unknown) => value,
	});
}

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

	it("counts a proxied bind-capable callable schema by its wire JSON Schema", () => {
		// Regression (PR #9185): applyToolProxy bound every callable property,
		// and an external-arktype Type HAS Function.prototype.bind (unlike
		// omptype), so the bound `parameters` lost its schema surface,
		// toolWireSchema returned the bare function, and the undefined
		// JSON.stringify poisoned token accounting — crashing every read-only
		// subagent at first prompt. The proxied schema must keep counting as
		// its wire JSON Schema, identical to the pre-converted equivalent.
		const schema = bindCapableSchema();
		const unwrapped = { name: "ext", description: "ext tool", parameters: schema };
		const wrapper: Record<string, unknown> = {};
		applyToolProxy(unwrapped, wrapper);
		const proxied = wrapper as { name: string; description: string; parameters: unknown };
		// The proxied tool must keep counting exactly like the unwrapped tool:
		// old code fed `undefined` into the tokenizer here and crashed.
		expect(estimateToolSchemaTokens([proxied as never], tokenizer)).toBe(
			estimateToolSchemaTokens([unwrapped as never], tokenizer),
		);
		expect(estimateToolSchemaTokens([proxied as never], tokenizer)).toBeGreaterThan(0);
	});

	it("runs the full non-message breakdown on a proxied extension tool", () => {
		// The crash frame was computeNonMessageBreakdown → estimateToolSchemaTokens
		// inside pre-prompt compaction; exercise that whole path, memo included.
		const schema = bindCapableSchema();
		const wrapper: Record<string, unknown> = {};
		applyToolProxy({ name: "ext", description: "ext tool", parameters: schema }, wrapper);
		const session = { systemPrompt: ["base"], agent: { state: { tools: [wrapper] } } };
		const breakdown = computeNonMessageBreakdown(session as never, tokenizer);
		expect(breakdown.toolsTokens).toBeGreaterThan(0);
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

	it("skips non-string name/description fragments", () => {
		const estimate = estimateToolSchemaTokens(
			[{ name: "odd", description: undefined, parameters: { type: "object" } } as never],
			tokenizer,
		);
		expect(estimate).toBeGreaterThan(0);
	});
});

/**
 * Contract: the /context panel surfaces estimated snapcompact wire savings —
 * applied swaps show "saves" figures, inactive states say why.
 */
describe("renderContextUsage snapcompact section", () => {
	const themeStub = {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	} as never;

	function breakdownWith(snapcompact: ContextBreakdown["snapcompact"]): ContextBreakdown {
		return {
			model: { id: "test-model", name: "Test Model", contextWindow: 200000 } as never,
			contextWindow: 200000,
			categories: [],
			usedTokens: 27929,
			autoCompactBufferTokens: 0,
			freeTokens: 172071,
			snapcompact,
		};
	}

	it("renders savings, skip reasons, and the wire total", () => {
		const output = renderContextUsage(
			breakdownWith({
				visionCapable: true,
				systemPrompt: {
					applied: true,
					scope: "all",
					textTokens: 9768,
					frames: 2,
					imageTokens: 6600,
					savedTokens: 3168,
				},
				toolResults: { total: 3, swapped: 0, textTokens: 0, frames: 0, imageTokens: 0, savedTokens: 0 },
				savedTokens: 3168,
			}),
			themeStub,
		);
		expect(output).toContain("Snapcompact (estimated wire savings)");
		expect(output).toContain("System prompt (all): saves ~3.2K (9.8K text → 2 frames ≈ 6.6K)");
		expect(output).toContain("Tool results: none imaged (3 in history)");
		// 27929 logical − 3168 saved ≈ 25K on the wire.
		expect(output).toContain("Next request: ~25K tokens on the wire");
	});

	it("reports text-only models as inactive", () => {
		const output = renderContextUsage(breakdownWith({ visionCapable: false, savedTokens: 0 }), themeStub);
		expect(output).toContain("Snapcompact: inactive (model has no image input)");
	});

	it("omits the section entirely when no snapcompact setting is on", () => {
		const output = renderContextUsage(breakdownWith(undefined), themeStub);
		expect(output).not.toContain("Snapcompact");
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
});

/**
 * Contract: the Skills category counts only skills actually rendered into the
 * system prompt (mirroring `buildSystemPrompt`'s filter) — hidden/explicit-only
 * skills, and every skill when the `read` tool is absent, contribute zero. The
 * System-prompt subtraction must not be inflated by unrendered skill metadata
 * and clamped to 0 (issue #6498).
 */
describe("computeNonMessageBreakdown skills filtering", () => {
	const readTool = { name: "read", description: "read files", parameters: {} };
	const hidden = { name: "hidden-skill", description: "X".repeat(4000), filePath: "/s/h.md", hide: true };
	const visible = { name: "vis", description: "small visible skill", filePath: "/s/v.md" };
	// First prompt block as rendered: only the visible skill appears.
	const renderedPrompt = "You are an agent.\nSkills:\n- vis: small visible skill\n";

	function session(tools: unknown[], skills: unknown[]) {
		return { systemPrompt: [renderedPrompt], agent: { state: { tools } }, skills } as never;
	}

	it("excludes hidden skills and does not clamp System prompt to 0", () => {
		const b = computeNonMessageBreakdown(session([readTool], [hidden, visible]), tokenizer);
		// Only the visible skill is counted, not the large hidden one.
		expect(b.skillsTokens).toBe(computeNonMessageBreakdown(session([readTool], [visible]), tokenizer).skillsTokens);
		expect(b.skillsTokens).toBeLessThan(100);
		expect(b.systemPromptTokens).toBeGreaterThan(0);
	});

	it("counts zero Skills tokens when the read tool is unavailable", () => {
		const b = computeNonMessageBreakdown(session([], [hidden, visible]), tokenizer);
		expect(b.skillsTokens).toBe(0);
		expect(b.systemPromptTokens).toBe(computeNonMessageBreakdown(session([], []), tokenizer).systemPromptTokens);
	});
});

/**
 * Contract: a tool, skill, or system-prompt section with a missing
 * (`undefined`) description/text must not crash the token estimate. Extensions
 * can contribute tools whose `description` is absent at runtime (the field is
 * typed `string` but the extension API does not enforce it); before the guard,
 * the `undefined` fragment reached the tokenizer and threw, killing every
 * subagent before its first turn (issue #9331). Each path must instead yield a
 * finite, non-negative estimate.
 */
describe("non-message estimates tolerate a missing description", () => {
	const readTool = { name: "read", description: "read files", parameters: {} };

	it("estimateToolSchemaTokens does not throw on an undefined tool description", () => {
		const tokens = estimateToolSchemaTokens(
			[{ name: "lens_tool", description: undefined, parameters: {} } as never],
			tokenizer,
		);
		expect(Number.isFinite(tokens)).toBe(true);
		expect(tokens).toBeGreaterThanOrEqual(0);
	});

	it("computeNonMessageBreakdown does not throw on an undefined skill description", () => {
		const session = {
			systemPrompt: ["You are an agent."],
			agent: { state: { tools: [readTool] } },
			skills: [{ name: "lens", description: undefined, filePath: "/s/l.md" }],
		} as never;
		const b = computeNonMessageBreakdown(session, tokenizer);
		expect(Number.isFinite(b.skillsTokens)).toBe(true);
		expect(b.skillsTokens).toBeGreaterThanOrEqual(0);
	});

	it("computeNonMessageBreakdown does not throw on an undefined system-context section", () => {
		const session = {
			systemPrompt: ["primary prompt", undefined, "trailing context"],
			agent: { state: { tools: [readTool] } },
			skills: [],
		} as never;
		const b = computeNonMessageBreakdown(session, tokenizer);
		expect(Number.isFinite(b.systemContextTokens)).toBe(true);
		expect(b.systemContextTokens).toBeGreaterThanOrEqual(0);
	});
});
