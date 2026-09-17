/**
 * Benchmark: getSessionStats walk fusion (coding-agent finding 6).
 *
 * Compares 4-pass role counting + per-assistant filter allocation against the
 * fused single pass. Uses synthetic settled histories of N messages.
 *
 * Run: bun packages/coding-agent/bench/session-stats.bench.ts
 */
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { Usage } from "@oh-my-pi/pi-ai";

function usage(): Usage {
	return {
		input: 10,
		output: 20,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 30,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function buildHistory(n: number): AgentMessage[] {
	const out: AgentMessage[] = [];
	for (let i = 0; i < n; i += 3) {
		out.push({ role: "user", content: `q${i}`, timestamp: Date.now() } as AgentMessage);
		out.push({
			role: "assistant",
			content: [
				{ type: "text", text: `a${i}` },
				{ type: "toolCall", id: `c${i}`, name: "read", arguments: { path: "x" } },
			],
			usage: usage(),
			timestamp: Date.now(),
		} as unknown as AgentMessage);
		out.push({ role: "toolResult", toolCallId: `c${i}`, toolName: "read", content: "ok" } as unknown as AgentMessage);
	}
	return out;
}

// Legacy shape: 3 filter passes + per-assistant filter alloc.
function legacy(messages: AgentMessage[]): number {
	const users = messages.filter(m => m.role === "user").length;
	const assistants = messages.filter(m => m.role === "assistant").length;
	const results = messages.filter(m => m.role === "toolResult").length;
	let calls = 0;
	for (const m of messages) {
		if (m.role === "assistant") calls += m.content.filter(c => c.type === "toolCall").length;
	}
	return users + assistants + results + calls;
}

// Fused shape: single pass, no transient arrays.
function fused(messages: AgentMessage[]): number {
	let users = 0;
	let assistants = 0;
	let results = 0;
	let calls = 0;
	for (const m of messages) {
		if (m.role === "user") users++;
		else if (m.role === "toolResult") results++;
		else if (m.role === "assistant") {
			assistants++;
			for (const c of m.content) if (c.type === "toolCall") calls++;
		}
	}
	return users + assistants + results + calls;
}

const N = 2000;
const history = buildHistory(N);
if (legacy(history) !== fused(history)) throw new Error("count mismatch");

const ITERS = 1000;
let start = Bun.nanoseconds();
for (let i = 0; i < ITERS; i++) legacy(history);
const legacyMs = (Bun.nanoseconds() - start) / 1e6;

start = Bun.nanoseconds();
for (let i = 0; i < ITERS; i++) fused(history);
const fusedMs = (Bun.nanoseconds() - start) / 1e6;

console.log(`history: ${history.length} messages, ${ITERS} iterations`);
console.log(`legacy 4-pass: ${legacyMs.toFixed(1)}ms total (${(legacyMs / ITERS).toFixed(4)}ms/op)`);
console.log(`fused 1-pass:  ${fusedMs.toFixed(1)}ms total (${(fusedMs / ITERS).toFixed(4)}ms/op)`);
console.log(`speedup: ${(legacyMs / fusedMs).toFixed(2)}x`);
