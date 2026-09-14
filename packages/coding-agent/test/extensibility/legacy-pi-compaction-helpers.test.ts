import { describe, expect, it } from "bun:test";
import { Tokenizer } from "@oh-my-pi/pi-agent-core";
import type { Usage } from "@oh-my-pi/pi-ai";
import {
	calculateContextTokens,
	compact,
	estimateTokens,
	findCutPoint,
	serializeConversation,
	sessionEntryToContextMessages,
} from "@oh-my-pi/pi-coding-agent/extensibility/legacy-pi-coding-agent-shim";

// Issue #6583: pi extensions import `estimateTokens` from
// `@earendil-works/pi-coding-agent`, which aliases to this shim. Legacy pi
// re-exported it from the coding-agent package root (via
// `./core/compaction/index.ts`); the core API has since become
// `Tokenizer.countMessage`, so the shim now defines a compat wrapper that keeps
// the legacy export surface — a named import must not throw Bun's static
// "Export named X not found" during plugin validation (e.g.
// `omp plugin install pi-blackhole`). This pins the export through the public
// package specifier.
describe("legacy shim compaction helpers", () => {
	it("exports estimateTokens as a callable token estimator", () => {
		expect(typeof estimateTokens).toBe("function");
		const tokens = estimateTokens({ role: "user", content: "hello world", timestamp: Date.now() }, new Tokenizer());
		expect(tokens).toBeGreaterThan(0);
	});

	it("counts tokens without a tokenizer argument (the legacy pi call shape)", () => {
		const tokens = estimateTokens({ role: "user", content: "hello world", timestamp: Date.now() });
		expect(tokens).toBeGreaterThan(0);
	});

	// Issue #7174: `compact` (same `@oh-my-pi/pi-agent-core/compaction` module as
	// `estimateTokens`) was likewise absent from the shim surface, so
	// `omp plugin install npm:pi-claude-bridge` failed with "Export named
	// 'compact' not found". Pin the callable re-export.
	it("re-exports compact as a callable function", () => {
		expect(typeof compact).toBe("function");
	});
	// Issue #7403: `serializeConversation` is another package-root compaction
	// helper used by pi-openai-server-compaction. Its absence prevented the
	// extension from passing static validation.
	it("re-exports serializeConversation with legacy transcript formatting", () => {
		const serialized = serializeConversation([{ role: "user", content: "summarize this", timestamp: 0 }]);
		expect(serialized).toBe("[User]: summarize this");
	});

	// Issue #10278: `calculateContextTokens` is another package-root compaction
	// helper (same `@oh-my-pi/pi-agent-core/compaction` module) used by
	// pi-blackhole. Its absence made `omp plugin install pi-blackhole` fail Bun's
	// static "Export named 'calculateContextTokens' not found" check.
	it("re-exports calculateContextTokens with its usage-sizing behavior", () => {
		expect(typeof calculateContextTokens).toBe("function");
		const usage: Usage = {
			input: 10,
			output: 5,
			cacheRead: 100,
			cacheWrite: 0,
			totalTokens: 115,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		expect(calculateContextTokens(usage)).toBe(115);
	});

	// SoL-Pi's online-context-compact imports `findCutPoint` with the legacy
	// 4-arg shape (no leading tokenizer) and `sessionEntryToContextMessages`
	// from the package root. Their absence made the whole sol-pi extension fail
	// to load ("Export named 'findCutPoint' not found").
	it("exposes findCutPoint with the legacy 4-arg signature", () => {
		expect(typeof findCutPoint).toBe("function");
		const entries = [
			{
				type: "message",
				id: "a",
				parentId: null,
				timestamp: "0",
				message: { role: "user", content: "one", timestamp: 0 },
			},
			{
				type: "message",
				id: "b",
				parentId: "a",
				timestamp: "0",
				message: { role: "assistant", content: "two", timestamp: 0 },
			},
		] as never[];
		const cut = findCutPoint(entries, 0, entries.length, 1);
		expect(cut).toHaveProperty("firstKeptEntryIndex");
		expect(cut).toHaveProperty("turnStartIndex");
		expect(cut).toHaveProperty("isSplitTurn");
	});

	it("converts session entries to context messages with upstream semantics", () => {
		expect(typeof sessionEntryToContextMessages).toBe("function");
		const message = sessionEntryToContextMessages({
			type: "message",
			id: "a",
			parentId: null,
			timestamp: "0",
			message: { role: "user", content: "hi", timestamp: 0 },
		} as never);
		expect(message).toHaveLength(1);
		expect((message[0] as { role: string }).role).toBe("user");

		// Null-content messages normalize to an empty content array (old/hand-edited sessions).
		const repaired = sessionEntryToContextMessages({
			type: "message",
			id: "b",
			parentId: "a",
			timestamp: "0",
			message: { role: "assistant", content: null, timestamp: 0 },
		} as never);
		expect(repaired).toHaveLength(1);
		expect((repaired[0] as { content: unknown[] }).content).toEqual([]);

		// Compaction entries surface as compaction-summary messages; markers produce none.
		const compaction = sessionEntryToContextMessages({
			type: "compaction",
			id: "c",
			parentId: "b",
			timestamp: "0",
			summary: "summary text",
			tokensBefore: 100,
		} as never);
		expect(compaction).toHaveLength(1);
		expect((compaction[0] as { role: string }).role).toBe("compactionSummary");

		expect(
			sessionEntryToContextMessages({ type: "label", id: "d", parentId: "c", timestamp: "0", label: "x" } as never),
		).toEqual([]);
	});
});
