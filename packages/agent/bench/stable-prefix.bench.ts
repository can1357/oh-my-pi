/**
 * Benchmark: StablePrefix.build steady-state cost (agent finding F2).
 *
 * Before the fix, every model call ran takeSnapshot (normalizeTools over the
 * whole catalog) + computeFingerprint (JSON.stringify of every tool schema +
 * char loop), then discarded the result on fingerprint match. The identity
 * fast path returns false without any of that work when live references are
 * unchanged.
 *
 * Run: bun packages/agent/bench/stable-prefix.bench.ts
 */
import { type } from "@oh-my-pi/omptype";
import { StablePrefix } from "../src/append-only-context";
import type { AgentTool } from "../src/types";

const toolSchema = type({
	path: type("string").describe("where to read"),
	nested: type({ inner: type("string").describe("inner value") }).describe("a nested object"),
});

function makeTool(name: string): AgentTool<typeof toolSchema, { path: string }> {
	return {
		name,
		label: name,
		description: `Tool ${name} with a description that rides the fingerprint payload`,
		parameters: toolSchema,
		async execute() {
			return { content: [{ type: "text", text: "ok" }] };
		},
	};
}

const context = {
	systemPrompt: ["You are a helpful assistant.", "Be concise."],
	messages: [],
	tools: Array.from({ length: 50 }, (_, i) => makeTool(`tool-${i}`)),
};
const options = { intentTracing: true } as const;

const prefix = new StablePrefix();
if (!prefix.build(context, options)) throw new Error("first build must report changed");

const N = 1000;
const start = Bun.nanoseconds();
let changed = 0;
for (let i = 0; i < N; i++) {
	if (prefix.build(context, options)) changed++;
}
const ms = (Bun.nanoseconds() - start) / 1e6;
console.log(
	`StablePrefix.build x${N} steady-state (50 tools): ${ms.toFixed(1)}ms (${((ms / N) * 1000).toFixed(1)}us/op, changed=${changed})`,
);
if (changed !== 0) throw new Error("steady-state builds must report unchanged");
