import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import type { AssistantMessage, AssistantMessageEvent, SimpleStreamOptions, Usage } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import type { Model } from "@oh-my-pi/pi-catalog/types";
import {
	CacheWarmer,
	type CacheWarmerDeps,
	type CacheWarmStream,
	getCacheWarmingDelayMs,
	getPromptCacheTtlMs,
	isReplayable,
} from "../src/session/cache-warmer";

const SHORT_DELAY_MS = 4.5 * 60_000; // 90% of the 300s short tier
const LONG_DELAY_MS = 54 * 60_000; // 90% of the 3600s long tier
const PROMPT_TOKENS = 100_000;

function makeModel(): Model {
	return buildModel({
		id: "claude-sonnet-5",
		name: "Claude Sonnet 5",
		api: "anthropic-messages",
		provider: "anthropic",
		// The official endpoint is what enables the 1h tier for OAuth seats.
		baseUrl: "https://api.anthropic.com",
		reasoning: true,
		input: ["text"],
		cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
		promptCache: { short: 300, long: 3600 },
		contextWindow: 200_000,
		maxTokens: 8_192,
	});
}

function makeUsage(tokens: Partial<Pick<Usage, "cacheRead" | "cacheWrite" | "output" | "cttl">>): Usage {
	const usage: Usage = {
		input: 1,
		output: tokens.output ?? 0,
		cacheRead: tokens.cacheRead ?? 0,
		cacheWrite: tokens.cacheWrite ?? 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		...(tokens.cttl ? { cttl: tokens.cttl } : {}),
	};
	usage.totalTokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
	return usage;
}

function makeMessage(usage: Usage, stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
	return {
		role: "assistant",
		timestamp: Date.now(),
		content: [],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-5",
		usage,
		stopReason,
	};
}

type ReplayScript =
	/** Envelope carries `usage`, then the model starts generating (the warmer cuts it off). */
	| { kind: "generate"; usage: Usage }
	/** The replay completes without generating (e.g. a one-token cap on a non-thinking model). */
	| { kind: "done"; usage: Usage }
	/** The provider rejects the replay. */
	| { kind: "error" };

interface ReplayRecord {
	options?: SimpleStreamOptions;
	/** Event types the warmer actually consumed before it stopped reading. */
	consumed: AssistantMessageEvent["type"][];
	cutOff: boolean;
}

/** A provider event stream that honors the replay's abort signal like a real stream. */
function scriptedStream(script: ReplayScript, record: ReplayRecord): CacheWarmStream {
	const signal = record.options?.signal;
	const events: AssistantMessageEvent[] = [];
	let final: AssistantMessage;
	if (script.kind === "error") {
		final = makeMessage(makeUsage({}), "error");
		events.push({ type: "error", reason: "error", error: final });
	} else {
		const partial = makeMessage(script.usage);
		events.push({ type: "start", partial });
		if (script.kind === "generate") {
			events.push({ type: "thinking_start", contentIndex: 0, partial });
			events.push({ type: "thinking_delta", contentIndex: 0, delta: "more thinking", partial });
		}
		final = script.kind === "done" ? partial : makeMessage(script.usage, "aborted");
		if (script.kind === "done") events.push({ type: "done", reason: "stop", message: final });
	}
	return {
		async *[Symbol.asyncIterator]() {
			try {
				for (const event of events) {
					if (signal?.aborted) return;
					record.consumed.push(event.type);
					yield event;
				}
			} finally {
				record.cutOff = signal?.aborted === true;
			}
		},
		result: () => Promise.resolve(final),
	};
}

interface Harness {
	warmer: CacheWarmer;
	replays: ReplayRecord[];
	script: ReplayScript;
	promptTokens: number;
	mode: "off" | "streaming" | "idle";
	current: boolean;
	warmed: Array<{ message: AssistantMessage; extensionOverride: boolean }>;
}

function harness(overrides: Partial<CacheWarmerDeps> = {}): Harness {
	const state: Omit<Harness, "warmer"> = {
		replays: [],
		script: { kind: "generate", usage: makeUsage({ cacheRead: PROMPT_TOKENS }) },
		promptTokens: PROMPT_TOKENS,
		mode: "idle",
		current: true,
		warmed: [],
	};
	const warmer = new CacheWarmer({
		stream: (_model, _context, options) => {
			const record: ReplayRecord = { options, consumed: [], cutOff: false };
			state.replays.push(record);
			return scriptedStream(state.script, record);
		},
		getPromptTokens: () => state.promptTokens,
		getMode: () => state.mode,
		...overrides,
	});
	warmer.onWarmed = (message, extensionOverride) => {
		state.warmed.push({ message, extensionOverride });
	};
	return Object.assign(state, { warmer });
}

/** Drains pending promise continuations after firing fake timers (no real time). */
async function drain(): Promise<void> {
	for (let i = 0; i < 100; i++) await Promise.resolve();
}

function start(h: Harness, options: SimpleStreamOptions = {}): void {
	h.warmer.start({ model: makeModel(), context: { messages: [] }, options }, () => h.current);
}

async function advance(ms: number): Promise<void> {
	vi.advanceTimersByTime(ms);
	await drain();
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

	test("reads the tier matching the request retention and the OAuth default", () => {
		// PI_CACHE_RETENTION feeds the default tier; scrub it so the
		// undefined-options assertions hold on any developer/CI environment.
		const savedRetention = process.env.PI_CACHE_RETENTION;
		delete process.env.PI_CACHE_RETENTION;
		try {
			const model = makeModel();
			expect(getPromptCacheTtlMs(model, { cacheRetention: "short" })).toBe(300_000);
			expect(getPromptCacheTtlMs(model, { cacheRetention: "long" })).toBe(3_600_000);
			expect(getPromptCacheTtlMs(model, undefined)).toBe(300_000);
			// OAuth seats default to the 1h tier, but an explicit retention still wins.
			expect(getPromptCacheTtlMs(model, undefined, true)).toBe(3_600_000);
			expect(getPromptCacheTtlMs(model, { cacheRetention: "short" }, true)).toBe(300_000);
		} finally {
			if (savedRetention !== undefined) process.env.PI_CACHE_RETENTION = savedRetention;
		}
	});

	test("never warms without a declared lifetime or with caching off", () => {
		const model = makeModel();
		model.promptCache = undefined;
		expect(getPromptCacheTtlMs(model, undefined)).toBeUndefined();
		expect(getPromptCacheTtlMs(makeModel(), { cacheRetention: "none" })).toBeUndefined();
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
		delete process.env.PI_CACHE_RETENTION;
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	test("cuts the replay off at the first generated block and re-arms on a cache hit", async () => {
		const h = harness();
		start(h);
		expect(h.warmer.status.state).toBe("scheduled");
		await advance(SHORT_DELAY_MS);
		expect(h.replays).toHaveLength(1);
		expect(h.replays[0]?.options?.maxTokens).toBe(1);
		// The replay's signal is aborted at `thinking_start`; the delta after it is never read.
		expect(h.replays[0]?.cutOff).toBe(true);
		expect(h.replays[0]?.consumed).toEqual(["start", "thinking_start"]);
		expect(h.warmed).toHaveLength(1);
		expect(h.warmed[0]?.message.usage.cacheRead).toBe(PROMPT_TOKENS);
		expect(h.warmed[0]?.message.usage.cost.total).toBeGreaterThan(0);
		expect(h.warmer.status.state).toBe("scheduled");
		await advance(SHORT_DELAY_MS);
		expect(h.replays).toHaveLength(2);
	});

	test("stops after a refresh that re-wrote the prefix instead of reading it", async () => {
		const h = harness();
		h.script = { kind: "done", usage: makeUsage({ cacheWrite: PROMPT_TOKENS, output: 1 }) };
		start(h);
		await advance(SHORT_DELAY_MS);
		expect(h.replays).toHaveLength(1);
		// The paid miss is still recorded.
		expect(h.warmed).toHaveLength(1);
		expect(h.warmer.status).toMatchObject({ state: "inactive", reason: "refresh missed the cache" });
		await advance(SHORT_DELAY_MS * 4);
		expect(h.replays).toHaveLength(1);
	});

	test("stops after a failed refresh instead of retrying every interval", async () => {
		const rejected = harness();
		rejected.script = { kind: "error" };
		start(rejected);
		await advance(SHORT_DELAY_MS);
		expect(rejected.warmer.status).toMatchObject({ state: "inactive", reason: "refresh failed" });

		const thrown = harness({
			stream: () => {
				throw new Error("network down");
			},
		});
		start(thrown);
		await advance(SHORT_DELAY_MS);
		expect(thrown.warmer.status).toMatchObject({ state: "inactive", reason: "refresh failed" });
	});

	test("stops with the below-threshold reason for a tiny context", async () => {
		const h = harness();
		h.promptTokens = 1_000;
		start(h);
		await advance(SHORT_DELAY_MS);
		expect(h.replays).toHaveLength(0);
		expect(h.warmer.status).toMatchObject({ state: "inactive", reason: "expected savings below threshold" });
	});

	test("idle phase uses a continuation probability", async () => {
		const h = harness();
		start(h);
		// The first refresh passes the $0.05 floor at probability 1 (streaming);
		// once the agent settles, 15% continuation drops the savings below it.
		await advance(SHORT_DELAY_MS);
		expect(h.replays).toHaveLength(1);
		h.warmer.onAgentSettled();
		await advance(SHORT_DELAY_MS);
		const status = h.warmer.status;
		expect(status).toMatchObject({ state: "inactive", reason: "expected savings below threshold" });
		expect(status.decision?.continuationProbability).toBe(0.15);
	});

	test("idle warming stops at the 30-minute safety limit", async () => {
		const forced = harness({ decide: () => Promise.resolve("warm") });
		start(forced);
		forced.warmer.onAgentSettled();
		for (let minute = 0; minute < 40; minute++) await advance(60_000);
		expect(forced.replays.length).toBeGreaterThan(0);
		expect(forced.warmer.status).toMatchObject({ state: "inactive", reason: "30-minute idle safety limit reached" });
	});

	test("warms a 1h entry during an active run but not after it settles", async () => {
		const running = harness();
		start(running, { cacheRetention: "long" });
		await advance(LONG_DELAY_MS);
		expect(running.replays).toHaveLength(1);

		const settled = harness({ decide: () => Promise.resolve("warm") });
		start(settled, { cacheRetention: "long" });
		settled.warmer.onAgentSettled();
		expect(settled.warmer.status).toMatchObject({
			state: "inactive",
			reason: "cache entry outlives the 30-minute idle window",
		});
	});

	test("adopts the 1h tier the provider reports writing for a resolver-keyed request", async () => {
		const h = harness();
		// A rotating credential arrives as a resolver, so the tier cannot be read
		// off the key; the schedule starts on the short tier.
		start(h, { apiKey: () => "resolved-at-request-time" });
		expect(h.warmer.status.nextWarmAt).toBe(Date.now() + SHORT_DELAY_MS);
		h.warmer.onResponse(makeMessage(makeUsage({ cacheWrite: 500, cttl: { ephemeral1h: 500 } })));
		expect(h.warmer.status.nextWarmAt).toBe(Date.now() + LONG_DELAY_MS);
		await advance(SHORT_DELAY_MS);
		expect(h.replays).toHaveLength(0);
		// A settled 1h run no longer idle-warms every 4.5 minutes.
		h.warmer.onAgentSettled();
		expect(h.warmer.status.reason).toBe("cache entry outlives the 30-minute idle window");
	});

	test("streaming mode stops when the agent settles", () => {
		const h = harness();
		h.mode = "streaming";
		start(h);
		h.warmer.onAgentSettled();
		expect(h.warmer.status).toMatchObject({ state: "inactive", reason: "agent run settled" });
	});

	test("stops when the context changes", async () => {
		const h = harness();
		start(h);
		h.current = false;
		await advance(SHORT_DELAY_MS);
		expect(h.replays).toHaveLength(0);
		expect(h.warmer.status).toMatchObject({ state: "inactive", reason: "conversation context changed" });
	});

	test("extensions can stop a refresh and force one past the threshold", async () => {
		const stopped = harness({ decide: () => Promise.resolve("stop") });
		start(stopped);
		await advance(SHORT_DELAY_MS);
		expect(stopped.replays).toHaveLength(0);
		expect(stopped.warmer.status).toMatchObject({
			state: "inactive",
			reason: "stopped by extension",
			extensionOverride: true,
		});

		const forced = harness({ decide: () => Promise.resolve("warm") });
		forced.promptTokens = 1_000;
		start(forced);
		await advance(SHORT_DELAY_MS);
		expect(forced.replays).toHaveLength(1);
		expect(forced.warmed[0]?.extensionOverride).toBe(true);
	});

	test("extension failures and slow answers fall back to the warmer's own decision", async () => {
		const failing = harness({ decide: () => Promise.reject(new Error("extension blew up")) });
		start(failing);
		await advance(SHORT_DELAY_MS);
		expect(failing.replays).toHaveLength(1);

		const slow = harness({ decide: () => Promise.withResolvers<"warm">().promise });
		start(slow);
		await advance(SHORT_DELAY_MS);
		expect(slow.replays).toHaveLength(0);
		await advance(2_000);
		expect(slow.replays).toHaveLength(1);
	});

	test("mode off refuses to arm", () => {
		const h = harness();
		h.mode = "off";
		start(h);
		expect(h.warmer.status).toMatchObject({ state: "inactive", reason: "cache warming disabled" });
	});
});
