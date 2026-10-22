/**
 * Benchmark: normalizeTools steady-state cost with intent injection.
 *
 * Injected parameters are memoized per input schema identity, so repeated
 * calls over the same tool array should reuse wire schemas by reference
 * (contract pinned in test/normalize-tools-prune.test.ts).
 *
 * Run: bun packages/agent/bench/normalize-tools.bench.ts
 */
import { type } from "@oh-my-pi/omptype";
import { normalizeTools } from "../src/agent-loop";
import type { AgentTool } from "../src/types";

const toolSchema = type({
	path: type("string").describe("where to read"),
	nested: type({ inner: type("string").describe("inner value") }).describe("a nested object"),
});

function makeTool(name: string): AgentTool<typeof toolSchema, { path: string }> {
	return {
		name,
		label: name,
		description: "top-level tool description",
		parameters: toolSchema,
		async execute() {
			return { content: [{ type: "text", text: "ok" }] };
		},
	};
}

const tools = Array.from({ length: 50 }, (_, i) => makeTool(`tool-${i}`));

normalizeTools(tools, { injectIntent: true }); // warmup: populate schema memos

const N = 200;
const start = Bun.nanoseconds();
for (let i = 0; i < N; i++) normalizeTools(tools, { injectIntent: true });
const ms = (Bun.nanoseconds() - start) / 1e6;
console.log(`normalizeTools x${N} (50 tools): ${ms.toFixed(1)}ms (${((ms / N) * 1000).toFixed(1)}us/op)`);

/**
 * The same measurement over a tool whose schema declares `patternProperties`.
 * Deciding whether a schema owns the intent field walks the schema graph, and a
 * `patternProperties` entry makes that walk test a regex per pattern.
 */
const patternToolSchema: Record<string, unknown> = {
	type: "object",
	properties: { path: { type: "string" } },
	required: ["path"],
	additionalProperties: false,
	patternProperties: { "^x-": { type: "string" }, "^y-": { type: "string" }, "^z-": { type: "string" } },
};
const patternTools = Array.from({ length: 50 }, (_, i) => ({
	name: `tool-${i}`,
	label: `tool-${i}`,
	description: `Tool tool-${i} with a description that rides the fingerprint payload`,
	parameters: patternToolSchema,
	async execute() {
		return { content: [{ type: "text", text: "ok" }] };
	},
}));

normalizeTools(patternTools as never, { injectIntent: true }); // warmup
const patternStart = Bun.nanoseconds();
for (let i = 0; i < N; i++) normalizeTools(patternTools as never, { injectIntent: true });
const patternMs = (Bun.nanoseconds() - patternStart) / 1e6;
console.log(
	`normalizeTools x${N} (50 tools, patternProperties): ${patternMs.toFixed(1)}ms (${((patternMs / N) * 1000).toFixed(1)}us/op)`,
);

/**
 * The production shape: 50 tools, each with its OWN schema object (tools never
 * share a schema), each carrying several properties, a nested object, an array
 * and `patternProperties`. This is the case the memo has to earn its keep on —
 * one walk per distinct schema, then reuse for every later model call.
 */
function realisticSchema(index: number): Record<string, unknown> {
	return {
		type: "object",
		properties: {
			path: { type: "string", description: `file to read ${index}` },
			offset: { type: "number" },
			limit: { type: "number" },
			encoding: { type: "string", enum: ["utf8", "latin1"] },
			flags: { type: "array", items: { type: "string" } },
			nested: { type: "object", properties: { deep: { type: "string" }, count: { type: "number" } } },
			other: { type: "string" },
		},
		required: ["path"],
		additionalProperties: false,
		patternProperties: { "^x-": { type: "string" }, "^y-": { type: "string" }, "^z-": { type: "string" } },
	};
}

const realisticTools = Array.from({ length: 50 }, (_, i) => ({
	name: `tool-${i}`,
	label: `tool-${i}`,
	description: `Tool tool-${i} with a description that rides the fingerprint payload`,
	parameters: realisticSchema(i),
	async execute() {
		return { content: [{ type: "text", text: "ok" }] };
	},
}));

normalizeTools(realisticTools as never, { injectIntent: true }); // warmup
const realisticStart = Bun.nanoseconds();
for (let i = 0; i < N; i++) normalizeTools(realisticTools as never, { injectIntent: true });
const realisticMs = (Bun.nanoseconds() - realisticStart) / 1e6;
console.log(
	`normalizeTools x${N} (50 distinct tool schemas): ${realisticMs.toFixed(1)}ms (${((realisticMs / N) * 1000).toFixed(1)}us/op)`,
);
