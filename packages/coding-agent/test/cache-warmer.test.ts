import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import type { AssistantMessage, SimpleStreamOptions } from "@oh-my-pi/pi-ai";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { Model } from "@oh-my-pi/pi-catalog/types";
import {
	CacheWarmer,
	type CacheWarmerDeps,
	getCacheWarmingDelayMs,
	getPromptCacheTtlMs,
	isReplayable,
} from "../src/session/cache-warmer";

const SONNET_5M_DELAY_MS = 4.5 * 60_000; // 90% of the 300s short tier

function makeModel(): Model {
	return buildModel({
		id: "claude-sonnet-5",
		name: "Claude Sonnet 5",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://example.invalid",
		reasoning: true,
		input: ["text"],
		cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
		promptCache: { short: 300, long: 3600 },
		contextWindow: 200_000,
		maxTokens: 8_192,
	});
}

function makeMessage(overrides: Partial<Omit<AssistantMessage, "timestamp">> = {}): AssistantMessage {
	return {
		role: "assistant",
		timestamp: Date.now(),
		content: [],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-5",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		...overrides,
	};
}

interface Harness {
	warmer: CacheWarmer;
	streamCalls: Array<{ model: Model; options?: SimpleStreamOptions }>;
	promptTokens: number;
	mode: "off" | "streaming" | "idle";
	current: boolean;
	warmed: Array<{ message: AssistantMessage; extensionOverride: boolean }>;
}

function harness(overrides: Partial<CacheWarmerDeps> = {}): Harness {
	const h = {} as Harness;
	h.streamCalls = [];
	h.warmed = [];
	h.promptTokens = 100_000;
	h.mode = "idle";
	h.current = true;
	const deps: CacheWarmerDeps = {
		stream: (model, _context, options) => {
			h.streamCalls.push({ model, options });
			const message = makeMessage();
			return { result: () => Promise.resolve(message) };
		},
		getPromptTokens: () => h.promptTokens,
		getMode: () => h.mode,
		...overrides,
	};
	h.warmer = new CacheWarmer(deps);
	h.warmer.onWarmed = (message, extensionOverride) => {
		h.warmed.push({ message, extensionOverride });
	};
	return h;
}

/** Drains pending promise continuations after firing fake timers (no real time). */
function drain(): Promise<void> {
	return Promise.resolve().then(async () => {
		for (let i = 0; i < 100; i++) await Promise.resolve();
	});
}

function start(h: Harness): void {
	h.warmer.start({ model: makeModel(), context: { messages: [] }, options: {} }, () => h.current);
}

describe("cache warming scheduling math", () => {
	test("schedules at 90% of the TTL with a ten-second margin", () => {
		expect(getCacheWarmingDelayMs(300_000)).toBe(270_000);
		expect(getCacheWarmingDelayMs(3600_000)).toBe(3_240_000);
	});

	test("clamps to at least one millisecond and refuses tiny lifetimes", () => {
		expect(getCacheWarmingDelayMs(10_001)).toBe(1);
		expect(getCacheWarmingDelayMs(10_000)).toBeUndefined();
		expect(getCacheWarmingDelayMs(5_000)).toBeUndefined();
	});

	test("reads the tier matching the request retention", () => {
		// PI_CACHE_RETENTION feeds the default tier; scrub it so the
		// undefined-options assertions hold on any developer/CI environment.
		const savedRetention = process.env.PI_CACHE_RETENTION;
		delete process.env.PI_CACHE_RETENTION;
		try {
			const model = makeModel();
			expect(getPromptCacheTtlMs(model, { cacheRetention: "short" })).toBe(300_000);
			expect(getPromptCacheTtlMs(model, { cacheRetention: "long" })).toBe(3_600_000);
			expect(getPromptCacheTtlMs(model, undefined)).toBe(300_000);
		} finally {
			if (savedRetention !== undefined) process.env.PI_CACHE_RETENTION = savedRetention;
		}
	});

	test("never warms without a declared lifetime or with caching off", () => {
		const model = makeModel();
		model.promptCache = undefined;
		expect(getPromptCacheTtlMs(model, undefined)).toBeUndefined();
		expect(getPromptCacheTtlMs(model, { cacheRetention: "none" })).toBeUndefined();
	});

	test("skips budget-based Anthropic thinking but allows adaptive thinking and other providers", () => {
		const model = makeModel();
		model.thinking = { mode: "anthropic-budget-effort", efforts: [Effort.High] };
		expect(isReplayable(model, { reasoning: Effort.High })).toBe(false);
		model.thinking = { mode: "anthropic-adaptive", efforts: [Effort.High] };
		expect(isReplayable(model, { reasoning: Effort.High })).toBe(true);
		expect(isReplayable(model, { reasoning: Effort.High, forceReasoningOff: true })).toBe(true);
		expect(isReplayable(model, undefined)).toBe(true);
		const openai = buildModel({
			id: "gpt-5.4",
			name: "GPT-5.4",
			api: "openai-responses",
			provider: "openai",
			baseUrl: "https://example.invalid",
			reasoning: true,
			input: ["text"],
			cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 },
			contextWindow: 100_000,
			maxTokens: 4_000,
		});
		expect(isReplayable(openai, { reasoning: Effort.High })).toBe(true);
	});
});

describe("cache warmer lifecycle", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	test("fires one refresh per armed interval and records warmed usage", async () => {
		const h = harness();
		start(h);
		expect(h.warmer.status.state).toBe("scheduled");
		vi.advanceTimersByTime(SONNET_5M_DELAY_MS);
		await drain();
		expect(h.streamCalls).toHaveLength(1);
		expect(h.streamCalls[0]?.options?.maxTokens).toBe(1);
		expect(h.warmed).toHaveLength(1);
		expect(h.warmer.status.state).toBe("scheduled");
	});

	test("stops with the below-threshold reason for a tiny context", async () => {
		const h = harness();
		h.promptTokens = 1_000;
		start(h);
		vi.advanceTimersByTime(SONNET_5M_DELAY_MS);
		await drain();
		expect(h.streamCalls).toHaveLength(0);
		const status = h.warmer.status;
		expect(status.state).toBe("inactive");
		expect(status.reason).toBe("expected savings below threshold");
	});

	test("idle phase uses a continuation probability and enforces the 30-minute window", async () => {
		const h = harness();
		start(h);
		// The first refresh passes the $0.05 floor at probability 1 (streaming);
		// once the agent settles, 15% continuation drops the savings below it.
		vi.advanceTimersByTime(SONNET_5M_DELAY_MS);
		await drain();
		expect(h.streamCalls).toHaveLength(1);
		h.warmer.onAgentSettled();
		vi.advanceTimersByTime(SONNET_5M_DELAY_MS);
		await drain();
		const status = h.warmer.status;
		expect(status.state).toBe("inactive");
		expect(status.reason).toBe("expected savings below threshold");
		expect(status.decision?.continuationProbability).toBe(0.15);
	});

	test("idle warming stops at the 30-minute safety limit", async () => {
		const h = harness();
		start(h);
		h.warmer.onAgentSettled();
		// Keep answering the economics floor by overriding the decision to warm:
		// the run should still die on the fixed startedAt-based window.
		const forced = harness({ decide: () => Promise.resolve("warm") });
		forced.warmer.start({ model: makeModel(), context: { messages: [] }, options: {} }, () => forced.current);
		forced.warmer.onAgentSettled();
		let fired = 0;
		for (let minute = 0; minute < 40; minute++) {
			vi.advanceTimersByTime(60_000);
			await drain();
			fired = forced.streamCalls.length;
		}
		expect(fired).toBeGreaterThan(0);
		expect(forced.warmer.status).toMatchObject({ state: "inactive", reason: "30-minute idle safety limit reached" });
		expect(h.warmer.status.state).toBe("inactive");
	});

	test("streaming mode stops when the agent settles", async () => {
		const h = harness();
		h.mode = "streaming";
		start(h);
		h.warmer.onAgentSettled();
		const status = h.warmer.status;
		expect(status.state).toBe("inactive");
		expect(status.reason).toBe("agent run settled");
	});

	test("stops when the context changes", async () => {
		const h = harness();
		start(h);
		h.current = false;
		vi.advanceTimersByTime(SONNET_5M_DELAY_MS);
		await drain();
		expect(h.streamCalls).toHaveLength(0);
		expect(h.warmer.status).toMatchObject({ state: "inactive", reason: "conversation context changed" });
	});

	test("extensions can stop a refresh and force one past the threshold", async () => {
		const stopped = harness({ decide: () => Promise.resolve("stop") });
		start(stopped);
		vi.advanceTimersByTime(SONNET_5M_DELAY_MS);
		await drain();
		expect(stopped.streamCalls).toHaveLength(0);
		expect(stopped.warmer.status).toMatchObject({
			state: "inactive",
			reason: "stopped by extension",
			extensionOverride: true,
		});

		const forced = harness({ decide: () => Promise.resolve("warm") });
		forced.promptTokens = 1_000;
		start(forced);
		vi.advanceTimersByTime(SONNET_5M_DELAY_MS);
		await drain();
		expect(forced.streamCalls).toHaveLength(1);
		expect(forced.warmed).toHaveLength(1);
	});

	test("extension failures fall back to the warmer's own decision", async () => {
		const h = harness({ decide: () => Promise.reject(new Error("extension blew up")) });
		start(h);
		vi.advanceTimersByTime(SONNET_5M_DELAY_MS);
		await drain();
		expect(h.streamCalls).toHaveLength(1);
	});

	test("a failed warm request is swallowed and warming re-arms", async () => {
		const h = harness({
			stream: () => {
				throw new Error("network down");
			},
		});
		start(h);
		vi.advanceTimersByTime(SONNET_5M_DELAY_MS);
		await drain();
		// Refresh threw, but the run stays armed for the next interval.
		expect(h.warmer.status.state).toBe("scheduled");
	});

	test("mode off refuses to arm", () => {
		const h = harness();
		h.mode = "off";
		start(h);
		expect(h.warmer.status).toMatchObject({ state: "inactive", reason: "cache warming disabled" });
	});
});
