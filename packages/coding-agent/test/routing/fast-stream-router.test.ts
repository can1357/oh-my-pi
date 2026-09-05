import { describe, expect, it } from "bun:test";
import type { AssistantMessage, AssistantMessageEvent, Model, SimpleStreamOptions } from "@pk-nerdsaver-ai/pi-ai";
import { AssistantMessageEventStream } from "@pk-nerdsaver-ai/pi-ai/utils/event-stream";
import { createEmptyUsage, FastStreamRouter, type StreamFunction } from "../../src/routing/fast-stream-router";
import { ModelPoolManager } from "../../src/routing/pool-manager";
import type { ResolvedModelPool } from "../../src/routing/types";

function model(provider: string): Model {
	return {
		id: "shared",
		name: "Shared",
		provider,
		api: "openai-completions",
		baseUrl: `https://${provider}.invalid/v1`,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
		reasoning: false,
		input: ["text"],
		compat: undefined,
	};
}
const primary = model("routing-primary");
const secondary = model("routing-secondary");
const pool: ResolvedModelPool = {
	id: "shared",
	name: "Shared",
	strategy: "affinity-fallback",
	candidates: [primary, secondary],
};

function message(target: Model, overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: target.api,
		provider: target.provider,
		model: target.id,
		timestamp: Date.now(),
		usage: createEmptyUsage(),
		stopReason: "stop",
		...overrides,
	};
}
function success(target: Model): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	stream.push({ type: "start", partial: message(target) });
	stream.push({ type: "done", reason: "stop", message: message(target) });
	stream.end();
	return stream;
}
function failure(target: Model, errorStatus = 429, withStart = true): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	if (withStart) stream.push({ type: "start", partial: message(target) });
	stream.push({
		type: "error",
		reason: "error",
		error: message(target, { stopReason: "error", errorStatus, errorMessage: "Upstream rejected request" }),
	});
	stream.end();
	return stream;
}
async function collect(stream: AssistantMessageEventStream) {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(event);
	return { events, result: await stream.result() };
}

describe("FastStreamRouter", () => {
	it.each([0, 1])("preserves the direct stream and caller options without a routable pool", async candidateCount => {
		const configuredPool = candidateCount === 0 ? null : { ...pool, candidates: [primary] };
		const manager = new ModelPoolManager({ enabled: true });
		const router = new FastStreamRouter(manager, () => {
			throw new Error("unexpected credential lookup");
		});
		const options = { apiKey: "primary-key", headers: { Authorization: "Bearer primary-header" } };
		const direct = success(primary);
		const output = router.streamWithRouting(
			primary,
			{ messages: [] },
			options,
			configuredPool,
			(target, _ctx, opts) => {
				expect(target).toBe(primary);
				expect(opts).toBe(options);
				return direct;
			},
		);
		expect(output).toBe(direct);
		expect((await collect(output)).result.stopReason).toBe("stop");
	});

	it("ignores a supplied pool when the master switch is off", async () => {
		const manager = new ModelPoolManager({ enabled: false });
		manager.markFailure(primary, new Error("429 Too Many Requests"));
		const router = new FastStreamRouter(manager, () => {
			throw new Error("unexpected credential lookup");
		});
		const tried: Model[] = [];
		const output = router.streamWithRouting(primary, { messages: [] }, undefined, pool, target => {
			tried.push(target);
			return success(target);
		});
		expect((await collect(output)).result.provider).toBe(primary.provider);
		expect(tried).toEqual([primary]);
	});

	it.each([429, 503])("fails over on a streamed %s after an empty start event", async errorStatus => {
		const manager = new ModelPoolManager({ enabled: true });
		const router = new FastStreamRouter(manager, () => "candidate-key");
		const tried: Model[] = [];
		const output = router.streamWithRouting(primary, { messages: [] }, undefined, pool, target => {
			tried.push(target);
			return target === primary ? failure(target, errorStatus) : success(target);
		});
		const { events, result } = await collect(output);
		expect(tried).toEqual([primary, secondary]);
		expect(events.map(event => event.type)).toEqual(["start", "done"]);
		expect(events[0]).toMatchObject({ partial: { provider: secondary.provider } });
		expect(result.provider).toBe(secondary.provider);
		expect(result.stopReason).toBe("stop");
		expect(manager.getHealthSnapshot().get(`${primary.provider}/${primary.id}`)?.consecutiveFailures).toBe(1);
	});

	it("fails over on a message-only capacity error with no start event", async () => {
		const router = new FastStreamRouter(new ModelPoolManager({ enabled: true }), () => "candidate-key");
		const output = router.streamWithRouting(primary, { messages: [] }, undefined, pool, target => {
			if (target === secondary) return success(target);
			const stream = new AssistantMessageEventStream();
			stream.push({
				type: "error",
				reason: "error",
				error: message(target, { stopReason: "error", errorMessage: "429 Too Many Requests" }),
			});
			return stream;
		});
		expect((await collect(output)).result.provider).toBe(secondary.provider);
	});

	it.each(["throw", "reject"])("fails over on pre-output %s errors", async mode => {
		const router = new FastStreamRouter(new ModelPoolManager({ enabled: true }), () => "candidate-key");
		const output = router.streamWithRouting(primary, { messages: [] }, undefined, pool, target => {
			if (target === secondary) return success(target);
			const error = Object.assign(new Error("Service unavailable"), { status: 503 });
			if (mode === "throw") throw error;
			const stream = new AssistantMessageEventStream();
			stream.push({ type: "start", partial: message(target) });
			stream.fail(error);
			return stream;
		});
		expect((await collect(output)).result.provider).toBe(secondary.provider);
	});

	it.each(["text_start", "thinking_start", "toolcall_start"] as const)("does not replay after %s", async type => {
		const manager = new ModelPoolManager({ enabled: true });
		manager.markFailure(primary, new Error("prior failure"), 0);
		const router = new FastStreamRouter(manager, () => "candidate-key");
		const tried: Model[] = [];
		const output = router.streamWithRouting(primary, { messages: [] }, undefined, pool, target => {
			tried.push(target);
			const stream = new AssistantMessageEventStream();
			stream.push({ type: "start", partial: message(target) });
			stream.push({ type, contentIndex: 0, partial: message(target) });
			stream.push({
				type: "error",
				reason: "error",
				error: message(target, { stopReason: "error", errorStatus: 429, errorMessage: "Capacity exhausted" }),
			});
			return stream;
		});
		const { result, events } = await collect(output);
		expect(tried).toEqual([primary]);
		expect(events.map(event => event.type)).toEqual(["start", type, "error"]);
		expect(result.errorStatus).toBe(429);
		// Setup events must not clear the failure history.
		expect(manager.getHealthSnapshot().get(`${primary.provider}/${primary.id}`)?.consecutiveFailures).toBe(2);
	});

	it.each([400, 401, 403])("preserves non-retryable %s errors without fallback or cooldown", async errorStatus => {
		const manager = new ModelPoolManager({ enabled: true });
		const router = new FastStreamRouter(manager, () => "candidate-key");
		const tried: Model[] = [];
		const output = router.streamWithRouting(primary, { messages: [] }, undefined, pool, target => {
			tried.push(target);
			return failure(target, errorStatus);
		});
		const { result } = await collect(output);
		expect(tried).toEqual([primary]);
		expect(result.errorStatus).toBe(errorStatus);
		expect(manager.getHealthSnapshot().size).toBe(0);
	});

	it.each(["pre-abort", "between-attempts", "event", "throw"])(
		"does not fail over on cancellation: %s",
		async mode => {
			const controller = new AbortController();
			const manager = new ModelPoolManager({ enabled: true });
			const router = new FastStreamRouter(manager, () => "candidate-key");
			const tried: Model[] = [];
			if (mode === "pre-abort") controller.abort();
			const output = router.streamWithRouting(
				primary,
				{ messages: [] },
				{ signal: controller.signal },
				pool,
				target => {
					tried.push(target);
					if (mode === "throw") throw new DOMException("Aborted while overloaded", "AbortError");
					if (mode === "between-attempts") {
						controller.abort();
						return failure(target);
					}
					const stream = new AssistantMessageEventStream();
					stream.push({
						type: "error",
						reason: "aborted",
						error: message(target, { stopReason: "aborted", errorStatus: 429, errorMessage: "Aborted" }),
					});
					return stream;
				},
			);
			expect((await collect(output)).result.stopReason).toBe("aborted");
			expect(tried).toEqual(mode === "pre-abort" ? [] : [primary]);
			expect(manager.getHealthSnapshot().size).toBe(0);
		},
	);

	it("settles exhaustion with the last provider error and its original metadata", async () => {
		const router = new FastStreamRouter(new ModelPoolManager({ enabled: true }), () => "candidate-key");
		const { events, result } = await collect(
			router.streamWithRouting(primary, { messages: [] }, undefined, pool, target => failure(target, 503)),
		);
		expect(events.map(event => event.type)).toEqual(["error"]);
		expect(result.provider).toBe(secondary.provider);
		expect(result.errorStatus).toBe(503);
	});

	it("accepts result-only transports and clears health only on completion", async () => {
		const manager = new ModelPoolManager({ enabled: true });
		manager.markFailure(primary, new Error("old failure"), 0);
		const router = new FastStreamRouter(manager, () => "candidate-key");
		const output = router.streamWithRouting(primary, { messages: [] }, undefined, pool, target => {
			const stream = new AssistantMessageEventStream();
			stream.end(message(target));
			return stream;
		});
		expect((await collect(output)).result.stopReason).toBe("stop");
		expect(manager.getHealthSnapshot().get(`${primary.provider}/${primary.id}`)?.consecutiveFailures).toBe(0);
	});

	it("settles an empty malformed stream without hanging", async () => {
		const router = new FastStreamRouter(new ModelPoolManager({ enabled: true }), () => "candidate-key");
		const output = router.streamWithRouting(primary, { messages: [] }, undefined, pool, () => {
			const stream = new AssistantMessageEventStream();
			stream.end();
			return stream;
		});
		expect((await collect(output)).result.errorMessage).toContain("without a final result");
	});

	it.each(["static", "resolver"])(
		"rebinds %s credentials and drops original headers on an initially selected sibling",
		async mode => {
			const manager = new ModelPoolManager({ enabled: true });
			manager.markFailure(primary, new Error("429 Too Many Requests"));
			const requestedKey = mode === "static" ? "FAKE_PRIMARY_KEY" : () => "FAKE_PRIMARY_KEY";
			const siblingKey = () => "FAKE_SECONDARY_KEY";
			const lookedUp: Model[] = [];
			const router = new FastStreamRouter(manager, target => {
				lookedUp.push(target);
				return siblingKey;
			});
			const controller = new AbortController();
			const options: SimpleStreamOptions = {
				apiKey: requestedKey,
				headers: { Authorization: "Bearer FAKE_PRIMARY_HEADER", "X-Secret": "primary" },
				metadata: { account: "primary" },
				signal: controller.signal,
				sessionId: "session",
				promptCacheKey: "cache",
				temperature: 0.2,
			};
			let received: SimpleStreamOptions | undefined;
			const dispatch: StreamFunction = (target, _context, opts) => {
				received = opts;
				return success(target);
			};
			expect(
				(await collect(router.streamWithRouting(primary, { messages: [] }, options, pool, dispatch))).result
					.provider,
			).toBe(secondary.provider);
			expect(lookedUp).toEqual([secondary]);
			expect(received?.apiKey).toBe(siblingKey);
			expect(received?.headers).toBeUndefined();
			expect(received?.metadata).toBeUndefined();
			expect(received?.signal).toBe(controller.signal);
			expect(received?.sessionId).toBe("session");
			expect(received?.promptCacheKey).toBe("cache");
			expect(received?.temperature).toBe(0.2);
			expect(options.apiKey).toBe(requestedKey);
			expect(options.headers?.["X-Secret"]).toBe("primary");
		},
	);
});

it("preserves requested credentials before rebinding on failover", async () => {
	const options: SimpleStreamOptions = { apiKey: "PRIMARY_KEY", headers: { "X-Primary": "private" } };
	const lookedUp: Model[] = [];
	const router = new FastStreamRouter(new ModelPoolManager({ enabled: true }), target => {
		lookedUp.push(target);
		return "SECONDARY_KEY";
	});
	const tried: Model[] = [];
	const output = router.streamWithRouting(primary, { messages: [] }, options, pool, (target, _context, opts) => {
		tried.push(target);
		if (target === primary) {
			expect(opts).toBe(options);
			return failure(target);
		}
		expect(opts?.apiKey).toBe("SECONDARY_KEY");
		expect(opts?.headers).toBeUndefined();
		return success(target);
	});
	expect((await collect(output)).result.provider).toBe(secondary.provider);
	expect(tried).toEqual([primary, secondary]);
	expect(lookedUp).toEqual([secondary]);
});
