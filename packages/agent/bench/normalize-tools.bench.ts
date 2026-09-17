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
