/**
 * Benchmark: normalizeTools parameters identity stability (agent findings F1/F2).
 *
 * Before the fix, every normalizeTools call minted a fresh parameters object
 * via injectIntentIntoSchema, defeating stamp-keyed downstream memos. After
 * the fix, the injected object is memoized per input schema identity, so the
 * second call with the same tool array reuses parameters by reference.
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

const first = normalizeTools(tools, { injectIntent: true });
const second = normalizeTools(tools, { injectIntent: true });
let stable = 0;
for (let i = 0; i < tools.length; i++) {
	if (first?.[i]?.parameters === second?.[i]?.parameters) stable++;
}
console.log(`parameters identity stable across calls: ${stable}/${tools.length}`);
if (stable !== tools.length) throw new Error("injection memo miss: parameters identity churns per call");

const N = 200;
const start = Bun.nanoseconds();
for (let i = 0; i < N; i++) normalizeTools(tools, { injectIntent: true });
const ms = (Bun.nanoseconds() - start) / 1e6;
console.log(`normalizeTools x${N} (50 tools): ${ms.toFixed(1)}ms (${((ms / N) * 1000).toFixed(1)}us/op)`);
