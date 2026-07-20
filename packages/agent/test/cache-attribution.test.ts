import { describe, expect, test } from "bun:test";
import type { Context, Model, Usage } from "@pk-nerdsaver-ai/pi-ai";
import { CacheAttributionTracker, type CacheTraceEvent } from "../src/cache-attribution";
import type { AgentMessage } from "../src/types";

const model = { provider: "anthropic", id: "claude-test" } as Model;
const otherModel = { provider: "anthropic", id: "claude-other" } as Model;

function userMessage(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: Date.now() } as AgentMessage;
}

function makeContext(overrides?: Partial<Context>): Context {
	return {
		systemPrompt: ["stable system prompt"],
		messages: [],
		tools: [{ name: "bash", description: "run a command", parameters: { type: "object" } } as never],
		...overrides,
	};
}

function usage(prompt: number, cacheRead: number, cacheWrite = 0): Usage {
	const input = prompt - cacheRead - cacheWrite;
	return {
		input,
		output: 10,
		cacheRead,
		cacheWrite,
		totalTokens: prompt + 10,
	} as Usage;
}

function respond(tracker: CacheAttributionTracker, u: Usage): CacheTraceEvent | undefined {
	return tracker.observeUsage({ usage: u, stopReason: "stop" });
}

describe("CacheAttributionTracker", () => {
	test("first request produces a trace with no break", () => {
		const tracker = new CacheAttributionTracker();
		tracker.observeRequest([userMessage("hi")], makeContext(), model);
		const trace = respond(tracker, usage(2000, 0, 2000));
		expect(trace).toBeDefined();
		expect(trace?.broke).toBe(false);
		expect(trace?.previousPromptTokens).toBeUndefined();
	});

	test("stable prefix with growing history is a hit, not a break", () => {
		const tracker = new CacheAttributionTracker();
		const first = userMessage("hi");
		tracker.observeRequest([first], makeContext(), model);
		respond(tracker, usage(2000, 0, 2000));

		// Same objects + one appended message: pure append.
		const second = userMessage("more");
		tracker.observeRequest([first, second], makeContext(), model);
		const trace = respond(tracker, usage(2400, 2000, 400));
		expect(trace?.broke).toBe(false);
		expect(trace?.causes).toEqual([]);
		expect(trace?.hitRatio).toBe(1);
	});

	test("system prompt change is detected and attributed on a break", () => {
		const tracker = new CacheAttributionTracker();
		const first = userMessage("hi");
		tracker.observeRequest([first], makeContext(), model);
		respond(tracker, usage(2000, 0, 2000));

		tracker.observeRequest([first], makeContext({ systemPrompt: ["different prompt"] }), model);
		const trace = respond(tracker, usage(2000, 0, 2000));
		expect(trace?.broke).toBe(true);
		expect(trace?.causes).toEqual(["system-prompt-change"]);
	});

	test("tool list reorder is detected", () => {
		const tracker = new CacheAttributionTracker();
		const toolA = { name: "a", description: "a", parameters: {} } as never;
		const toolB = { name: "b", description: "b", parameters: {} } as never;
		const first = userMessage("hi");
		tracker.observeRequest([first], makeContext({ tools: [toolA, toolB] }), model);
		respond(tracker, usage(2000, 0, 2000));

		tracker.observeRequest([first], makeContext({ tools: [toolB, toolA] }), model);
		const trace = respond(tracker, usage(2000, 0, 2000));
		expect(trace?.broke).toBe(true);
		expect(trace?.causes).toEqual(["tool-list-change"]);
	});

	test("history rewrite is detected with divergence index and host reason", () => {
		const tracker = new CacheAttributionTracker();
		const a = userMessage("a");
		const b = userMessage("b");
		const c = userMessage("c");
		tracker.observeRequest([a, b, c], makeContext(), model);
		respond(tracker, usage(3000, 0, 3000));

		// b replaced by a pruned placeholder (new object) — host declares why.
		tracker.noteHistoryRewrite("prune");
		const bPruned = userMessage("[Uneventful result elided]");
		tracker.observeRequest([a, bPruned, c], makeContext(), model);
		const trace = respond(tracker, usage(3000, 500, 2500));
		expect(trace?.broke).toBe(true);
		expect(trace?.causes).toEqual(["history-rewrite"]);
		expect(trace?.rewriteReason).toBe("prune");
		expect(trace?.firstDivergence).toBe(1);
	});

	test("model change is detected", () => {
		const tracker = new CacheAttributionTracker();
		const first = userMessage("hi");
		tracker.observeRequest([first], makeContext(), model);
		respond(tracker, usage(2000, 0, 2000));

		tracker.observeRequest([first], makeContext(), otherModel);
		const trace = respond(tracker, usage(2000, 0, 2000));
		expect(trace?.broke).toBe(true);
		expect(trace?.causes).toEqual(["model-change"]);
	});

	test("break with no harness-side change attributes provider-side", () => {
		const tracker = new CacheAttributionTracker();
		const first = userMessage("hi");
		tracker.observeRequest([first], makeContext(), model);
		respond(tracker, usage(2000, 0, 2000));

		// Identical request, but the provider returned no cache read (TTL expiry).
		tracker.observeRequest([first], makeContext(), model);
		const trace = respond(tracker, usage(2000, 0, 2000));
		expect(trace?.broke).toBe(true);
		expect(trace?.causes).toEqual(["provider-side"]);
	});

	test("providers that never report cache usage produce no breaks", () => {
		const tracker = new CacheAttributionTracker();
		const first = userMessage("hi");
		tracker.observeRequest([first], makeContext(), model);
		respond(tracker, usage(2000, 0, 0));
		tracker.observeRequest([first], makeContext(), model);
		const trace = respond(tracker, usage(2000, 0, 0));
		expect(trace?.broke).toBe(false);
		expect(tracker.stats().cachingObserved).toBe(false);
		expect(tracker.stats().breaks).toBe(0);
	});

	test("stats aggregate hit rate and break causes", () => {
		const tracker = new CacheAttributionTracker();
		const first = userMessage("hi");
		tracker.observeRequest([first], makeContext(), model);
		respond(tracker, usage(2000, 0, 2000));
		tracker.observeRequest([first], makeContext(), model);
		respond(tracker, usage(2000, 2000, 0));
		tracker.observeRequest([first], makeContext({ systemPrompt: ["changed"] }), model);
		respond(tracker, usage(2000, 0, 2000));

		const stats = tracker.stats();
		expect(stats.requests).toBe(3);
		expect(stats.promptTokens).toBe(6000);
		expect(stats.cacheReadTokens).toBe(2000);
		expect(stats.breaks).toBe(1);
		expect(stats.breaksByCause["system-prompt-change"]).toBe(1);
		expect(stats.hitRate).toBeCloseTo(2000 / 6000);
	});

	test("truncated history counts as a rewrite at the cut index", () => {
		const tracker = new CacheAttributionTracker();
		const a = userMessage("a");
		const b = userMessage("b");
		tracker.observeRequest([a, b], makeContext(), model);
		respond(tracker, usage(2000, 0, 2000));

		tracker.observeRequest([a], makeContext(), model);
		const trace = respond(tracker, usage(1500, 200, 1300));
		expect(trace?.causes).toEqual(["history-rewrite"]);
		expect(trace?.firstDivergence).toBe(1);
	});
});
