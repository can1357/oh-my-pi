import { describe, expect, it, spyOn } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Tokenizer } from "@oh-my-pi/pi-agent-core";
import { normalizeTools } from "@oh-my-pi/pi-agent-core/agent-loop";
import type { Model } from "@oh-my-pi/pi-ai";
import {
	computeContextUsageDetails,
	computeNonMessageBreakdown,
	estimateToolSchemaTokens,
	invalidateToolSchemaMetadata,
	toolSchemaFragments,
} from "@oh-my-pi/pi-coding-agent/session/context-usage";
import { applyToolProxy } from "../../src/extensibility/tool-proxy";

const tokenizer = new Tokenizer();

/** External arktype copies expose bind on callable schemas, unlike omptype. */
function bindCapableSchema() {
	return Object.assign((value: unknown) => value, {
		toJsonSchema: () => ({ type: "object", properties: { a: { type: "string" } } }),
		assert: (value: unknown) => value,
	});
}

describe("extension tool context accounting", () => {
	it("counts a proxied bind-capable callable schema by its wire JSON Schema", () => {
		// Binding the schema loses its wire surface and once poisoned token accounting.
		const schema = bindCapableSchema();
		const unwrapped = { name: "ext", description: "ext tool", parameters: schema };
		const wrapper: Record<string, unknown> = {};
		applyToolProxy(unwrapped, wrapper);
		const proxied = wrapper as { name: string; description: string; parameters: unknown };
		expect(estimateToolSchemaTokens([proxied as never], tokenizer)).toBe(
			estimateToolSchemaTokens([unwrapped as never], tokenizer),
		);
		expect(estimateToolSchemaTokens([proxied as never], tokenizer)).toBeGreaterThan(0);
	});

	it("reuses identical wire bytes across rosters and revisions but re-reads live metadata", () => {
		const counter = new Tokenizer();
		const count = spyOn(counter, "countTokens");
		let description = "first";
		let parameters = { type: "string" };
		const examples = [{ call: { value: "one" } }];
		const tool = {
			name: "ext",
			get description() {
				return description;
			},
			get parameters() {
				return parameters;
			},
			examples,
		};
		const roster = [tool];
		const estimate = (revision: number, tools = roster, pruneDescriptions = false) =>
			estimateToolSchemaTokens(tools, counter, { sourceRevision: revision, pruneDescriptions });

		const original = estimate(0);
		expect(estimate(1)).toBe(original);
		expect(estimate(1, [...roster])).toBe(original);
		expect(count).toHaveBeenCalledTimes(1);

		description = "a longer live description";
		expect(estimate(2)).toBe(tokenizer.countTokens(toolSchemaFragments(tool).fragments));
		examples[0]!.call.value = "a longer example inside the same array";
		invalidateToolSchemaMetadata(roster);
		expect(estimate(2)).toBe(tokenizer.countTokens(toolSchemaFragments(tool).fragments));
		parameters = { type: "number" };
		expect(estimate(3)).toBe(tokenizer.countTokens(toolSchemaFragments(tool).fragments));
		expect(estimate(3, roster, true)).toBe(
			tokenizer.countTokens(toolSchemaFragments(tool, { pruneDescriptions: true }).fragments),
		);
		expect(count).toHaveBeenCalledTimes(5);
	});

	it("runs the full non-message breakdown on a proxied extension tool", () => {
		const schema = bindCapableSchema();
		const wrapper: Record<string, unknown> = {};
		applyToolProxy({ name: "ext", description: "ext tool", parameters: schema }, wrapper);
		const session = { systemPrompt: ["base"], agent: { state: { tools: [wrapper] } } };
		const breakdown = computeNonMessageBreakdown(session as never, tokenizer);
		expect(breakdown.toolsTokens).toBeGreaterThan(0);
	});
});

describe("computeContextUsageDetails", () => {
	it("omits deferred tool schemas and refreshes details when the model policy changes", () => {
		const tools = [{ name: "read", description: "Read files.", parameters: { type: "object" } }];
		const skillLine = "- visible: Visible skill.";
		const blocks = [`You are an agent.\n${skillLine}\nEnd.`];
		const systemPromptSources = {
			blocks,
			sources: [
				{
					id: "skill-0",
					kind: "skills" as const,
					label: "visible",
					block: 0,
					start: 18,
					end: 18 + skillLine.length,
				},
			],
		};
		const session = {
			model: { toolSchemasInContext: false } as Model,
			agent: { tokenizer, state: { tools } },
			systemPrompt: blocks,
			systemPromptSources,
		};

		const deferred = computeContextUsageDetails(session);
		expect(deferred.tools).toEqual([]);
		expect(deferred.skills).toEqual([{ name: "visible", tokens: tokenizer.countTokens(skillLine) }]);

		session.model = { toolSchemasInContext: true } as Model;
		const inline = computeContextUsageDetails(session);
		expect(inline.tools).toEqual([{ name: "read", tokens: estimateToolSchemaTokens(tools, tokenizer) }]);
		// A source whose block changed after the build stays in System Prompt, like the Skills category.
		expect(computeContextUsageDetails({ ...session, systemPrompt: [`${blocks[0]}\nhook`] }).skills).toEqual([]);
	});

	it("refreshes per-tool details when effective pruning changes without replacing the roster", () => {
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
		let prune = true;
		const model = { toolSchemasInContext: true } as Model;
		const session = {
			model,
			agent: {
				tokenizer,
				state: { tools: tools as never },
				prunesToolDescriptions: (requestedModel: Model | undefined) => {
					expect(requestedModel).toBe(model);
					return prune;
				},
			},
		};
		expect(computeContextUsageDetails(session).tools).toEqual([{ name: "grep", tokens: prunedWireTokens }]);

		// Owned dialects retain descriptions even when the raw prune setting is enabled.
		prune = false;
		const full = computeContextUsageDetails(session).tools;
		expect(full[0]!.tokens).toBeGreaterThan(prunedWireTokens);

		prune = true;
		expect(computeContextUsageDetails(session).tools).toEqual([{ name: "grep", tokens: prunedWireTokens }]);
	});
});
