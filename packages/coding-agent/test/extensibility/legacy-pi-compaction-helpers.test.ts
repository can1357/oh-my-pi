import { describe, expect, it } from "bun:test";
import { Tokenizer } from "@oh-my-pi/pi-agent-core";
import type { Usage } from "@oh-my-pi/pi-ai";
import {
	calculateContextTokens,
	compact,
	estimateTokens,
	findCutPoint,
	type SessionEntry,
	sessionEntryToContextMessages,
	serializeConversation,
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
});

// Issue #11796: `omp install git:github.com/NVlabs/SoL-Pi` failed Bun's static
// export check because the shim never forwarded `findCutPoint`. omp's canonical
// `findCutPoint` also grew a required `Tokenizer` parameter, so the shim exposes
// an upstream-signature (tokenizer-less, 4-arg) wrapper backed by the shared
// model-agnostic tokenizer — a raw re-export would misread `startIndex` as the
// tokenizer and throw at runtime.
describe("legacy shim findCutPoint", () => {
	const entries: SessionEntry[] = [
		{
			type: "message",
			id: "a",
			parentId: null,
			timestamp: new Date(0).toISOString(),
			message: { role: "user", content: "alpha", timestamp: 0 },
		},
		{
			type: "message",
			id: "b",
			parentId: "a",
			timestamp: new Date(1000).toISOString(),
			message: { role: "user", content: "beta", timestamp: 1000 },
		},
	];

	it("accepts the upstream tokenizer-less 4-arg call shape and keeps all entries under a large budget", () => {
		const result = findCutPoint(entries, 0, entries.length, 50_000);
		// A raw re-export would pass `startIndex` (0) where the canonical helper
		// expects a Tokenizer and throw on `.countMessage`; reaching a numeric
		// cut index proves the wrapper injected the tokenizer.
		expect(result.firstKeptEntryIndex).toBe(0);
		expect(result.isSplitTurn).toBe(false);
	});
});

// Issue #11796: SoL-Pi's online-context-compact also imports
// `sessionEntryToContextMessages`, absent from omp entirely, so it would fail the
// same static check right after `findCutPoint`. The shim ports upstream Pi's
// per-entry projector.
describe("legacy shim sessionEntryToContextMessages", () => {
	it("projects a message entry to its underlying message", () => {
		const message = { role: "user" as const, content: "hi", timestamp: 0 };
		const entry: SessionEntry = {
			type: "message",
			id: "m",
			parentId: null,
			timestamp: new Date(0).toISOString(),
			message,
		};
		expect(sessionEntryToContextMessages(entry)).toEqual([message]);
	});

	it("projects a compaction entry to a single compaction-summary message", () => {
		const entry: SessionEntry = {
			type: "compaction",
			id: "c",
			parentId: null,
			timestamp: new Date(0).toISOString(),
			summary: "did stuff",
			firstKeptEntryId: "a",
			tokensBefore: 1234,
		};
		const messages = sessionEntryToContextMessages(entry);
		expect(messages).toHaveLength(1);
		expect(messages[0].role).toBe("compactionSummary");
	});

	it("yields no messages for state-only entries", () => {
		const entry: SessionEntry = {
			type: "model_change",
			id: "mc",
			parentId: null,
			timestamp: new Date(0).toISOString(),
			model: "anthropic/x",
		};
		expect(sessionEntryToContextMessages(entry)).toEqual([]);
	});
});
