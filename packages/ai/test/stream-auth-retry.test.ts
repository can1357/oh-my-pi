import { afterEach, describe, expect, it } from "bun:test";
import type { ApiKeyResolveContext } from "@pk-nerdsaver-ai/pi-ai";
import { registerCustomApi, unregisterCustomApis } from "@pk-nerdsaver-ai/pi-ai";
import { streamSimple } from "@pk-nerdsaver-ai/pi-ai/stream";
import type { Api, AssistantMessage, Context, Model, SimpleStreamOptions, Usage } from "@pk-nerdsaver-ai/pi-ai/types";
import { AssistantMessageEventStream } from "@pk-nerdsaver-ai/pi-ai/utils/event-stream";

const SOURCE_ID = "stream-auth-retry-test";
const API = "stream-auth-retry-test" as Api;

function usage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function assistant(content: string[] = []): AssistantMessage {
	return {
		role: "assistant",
		content: content.map(text => ({ type: "text" as const, text })),
		api: API,
		provider: "test-provider",
		model: "test-model",
		timestamp: 1,
		stopReason: "stop",
		usage: usage(),
	};
}

function assistantError(errorMessage: string, errorStatus?: number): AssistantMessage {
	return { ...assistant(), stopReason: "error", errorMessage, errorStatus };
}

function authError(): Error & { status: number } {
	return Object.assign(new Error("401 authentication_error"), { status: 401 });
}

function usageLimitError(): Error & { status: number } {
	return Object.assign(new Error("You have hit your ChatGPT usage limit (pro plan). Try again in ~158 min."), {
		status: 429,
	});
}

function googleResourceExhaustedMessage(): string {
	return "Google API error (429): Resource exhausted. Please try again later.";
}

function model(): Model<Api> {
	return {
		id: "test-model",
		name: "Test Model",
		api: API,
		provider: "test-provider",
		contextWindow: 1000,
		maxTokens: 100,
	} as Model<Api>;
}

const context: Context = {
	systemPrompt: [],
	messages: [{ role: "user", content: "hello", timestamp: 1 }],
};

/** Records the static key each inner attempt actually received. */
function pushKey(keys: unknown[], options?: SimpleStreamOptions): void {
	keys.push(options?.apiKey);
}

function ok(stream: AssistantMessageEventStream): void {
	const message = assistant(["ok"]);
	stream.push({ type: "start", partial: message });
	stream.push({ type: "done", reason: "stop", message });
}

describe("streamSimple resolver auth retry", () => {
	afterEach(() => {
		unregisterCustomApis(SOURCE_ID);
	});

	it("retries with a refreshed key when a 401 is thrown before the first event", async () => {
		const keys: unknown[] = [];
		const contexts: ApiKeyResolveContext[] = [];
		registerCustomApi(
			API,
			(_model: Model<Api>, _context: Context, options?: SimpleStreamOptions) => {
				pushKey(keys, options);
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => (keys.length === 1 ? stream.fail(authError()) : ok(stream)));
				return stream;
			},
			SOURCE_ID,
		);

		const stream = streamSimple(model(), context, {
			apiKey: async ctx => {
				contexts.push(ctx);
				return ctx.error === undefined ? "old-key" : ctx.lastChance ? "switch-key" : "refresh-key";
			},
		});
		for await (const _event of stream) {
			// drain
		}

		expect((await stream.result()).content).toEqual([{ type: "text", text: "ok" }]);
		// Initial resolve, then step (b) refresh-same — the switch step is never reached.
		expect(keys).toEqual(["old-key", "refresh-key"]);
		expect(keys.every(key => typeof key === "string")).toBe(true);
		expect(contexts.map(ctx => ({ lastChance: ctx.lastChance, hasError: ctx.error !== undefined }))).toEqual([
			{ lastChance: false, hasError: false },
			{ lastChance: false, hasError: true },
		]);
		expect((contexts[1]?.error as { status?: number }).status).toBe(401);
	});

	it("buffers the start event and retries on a 401 error event before content", async () => {
		const keys: unknown[] = [];
		const eventTypes: string[] = [];
		registerCustomApi(
			API,
			(_model: Model<Api>, _context: Context, options?: SimpleStreamOptions) => {
				pushKey(keys, options);
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					if (keys.length === 1) {
						stream.push({ type: "start", partial: assistant() });
						stream.push({
							type: "error",
							reason: "error",
							error: assistantError(
								'Error: 401\n{"type":"error","error":{"type":"authentication_error","message":"Invalid authentication credentials"}}',
							),
						});
						return;
					}
					ok(stream);
				});
				return stream;
			},
			SOURCE_ID,
		);

		const stream = streamSimple(model(), context, {
			apiKey: async ctx => (ctx.error === undefined ? "old-key" : "new-key"),
		});
		for await (const event of stream) {
			eventTypes.push(event.type);
		}

		expect((await stream.result()).content).toEqual([{ type: "text", text: "ok" }]);
		expect(keys).toEqual(["old-key", "new-key"]);
		// The buffered `start` of the failed attempt must not leak — the user
		// sees exactly one clean start/done pair.
		expect(eventTypes).toEqual(["start", "done"]);
	});

	it("retries on a 401 carried only via errorStatus", async () => {
		const keys: unknown[] = [];
		registerCustomApi(
			API,
			(_model: Model<Api>, _context: Context, options?: SimpleStreamOptions) => {
				pushKey(keys, options);
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					if (keys.length === 1) {
						stream.push({ type: "start", partial: assistant() });
						stream.push({
							type: "error",
							reason: "error",
							error: assistantError(
								'{"type":"error","error":{"type":"authentication_error","message":"Invalid authentication credentials"}}',
								401,
							),
						});
						return;
					}
					ok(stream);
				});
				return stream;
			},
			SOURCE_ID,
		);

		const stream = streamSimple(model(), context, {
			apiKey: async ctx => (ctx.error === undefined ? "old-key" : "new-key"),
		});
		for await (const _event of stream) {
			// drain
		}

		expect((await stream.result()).content).toEqual([{ type: "text", text: "ok" }]);
		expect(keys).toEqual(["old-key", "new-key"]);
	});

	it("does not retry after replay-unsafe content has been emitted", async () => {
		let retryResolves = 0;
		const failure = authError();
		registerCustomApi(
			API,
			() => {
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: assistant() });
					stream.push({ type: "text_start", contentIndex: 0, partial: assistant([""]) });
					stream.fail(failure);
				});
				return stream;
			},
			SOURCE_ID,
		);

		const stream = streamSimple(model(), context, {
			apiKey: async ctx => {
				if (ctx.error !== undefined) retryResolves += 1;
				return ctx.error === undefined ? "old-key" : "new-key";
			},
		});

		let caught: unknown;
		try {
			for await (const _event of stream) {
				// drain
			}
		} catch (error) {
			caught = error;
		}

		expect(caught).toBe(failure);
		// The resolver is never asked for a retry key once a replay-unsafe event shipped.
		expect(retryResolves).toBe(0);
	});

	it("escalates refresh-same then switch in order (2-retry ordering)", async () => {
		const keys: unknown[] = [];
		registerCustomApi(
			API,
			(_model: Model<Api>, _context: Context, options?: SimpleStreamOptions) => {
				pushKey(keys, options);
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => (options?.apiKey === "switch-key" ? ok(stream) : stream.fail(authError())));
				return stream;
			},
			SOURCE_ID,
		);

		const stream = streamSimple(model(), context, {
			apiKey: async ctx => (ctx.error === undefined ? "old-key" : ctx.lastChance ? "switch-key" : "refresh-key"),
		});
		for await (const _event of stream) {
			// drain
		}

		expect((await stream.result()).content).toEqual([{ type: "text", text: "ok" }]);
		expect(keys).toEqual(["old-key", "refresh-key", "switch-key"]);
	});

	it("skips the refresh-same step when the resolver returns an unchanged key", async () => {
		const keys: unknown[] = [];
		registerCustomApi(
			API,
			(_model: Model<Api>, _context: Context, options?: SimpleStreamOptions) => {
				pushKey(keys, options);
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => (options?.apiKey === "switch-key" ? ok(stream) : stream.fail(authError())));
				return stream;
			},
			SOURCE_ID,
		);

		const stream = streamSimple(model(), context, {
			// refresh-same yields the same failing key → that attempt is skipped.
			apiKey: async ctx => (ctx.error === undefined ? "old-key" : ctx.lastChance ? "switch-key" : "old-key"),
		});
		for await (const _event of stream) {
			// drain
		}

		expect((await stream.result()).content).toEqual([{ type: "text", text: "ok" }]);
		expect(keys).toEqual(["old-key", "switch-key"]);
	});

	it("retries a thrown usage-limit error and passes the cause to the resolver", async () => {
		const keys: unknown[] = [];
		const errors: unknown[] = [];
		registerCustomApi(
			API,
			(_model: Model<Api>, _context: Context, options?: SimpleStreamOptions) => {
				pushKey(keys, options);
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => (keys.length === 1 ? stream.fail(usageLimitError()) : ok(stream)));
				return stream;
			},
			SOURCE_ID,
		);

		const stream = streamSimple(model(), context, {
			apiKey: async ctx => {
				if (ctx.error !== undefined) errors.push(ctx.error);
				return ctx.error === undefined ? "old-key" : "new-key";
			},
		});
		for await (const _event of stream) {
			// drain
		}

		expect((await stream.result()).content).toEqual([{ type: "text", text: "ok" }]);
		expect(keys).toEqual(["old-key", "new-key"]);
		expect(errors).toHaveLength(1);
		// The cause carries the original 429 so the resolver can branch usage-limit vs 401.
		expect((errors[0] as { status?: number }).status).toBe(429);
		expect((errors[0] as Error).message).toMatch(/usage limit/i);
	});

	it("retries a usage-limit error event before content", async () => {
		const keys: unknown[] = [];
		registerCustomApi(
			API,
			(_model: Model<Api>, _context: Context, options?: SimpleStreamOptions) => {
				pushKey(keys, options);
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					if (keys.length === 1) {
						stream.push({ type: "start", partial: assistant() });
						stream.push({
							type: "error",
							reason: "error",
							error: assistantError("You have hit your ChatGPT usage limit (pro plan). Try again in ~158 min."),
						});
						return;
					}
					ok(stream);
				});
				return stream;
			},
			SOURCE_ID,
		);

		const stream = streamSimple(model(), context, {
			apiKey: async ctx => (ctx.error === undefined ? "old-key" : "new-key"),
		});
		for await (const _event of stream) {
			// drain
		}

		expect((await stream.result()).content).toEqual([{ type: "text", text: "ok" }]);
		expect(keys).toEqual(["old-key", "new-key"]);
	});

	it("rotates before emitting content for Codex quota payloads", async () => {
		const payloads: Array<{ message: string; status?: number }> = [
			{ message: "429", status: 429 },
			{ message: '{"error":{"code":"insufficient_quota","message":"quota exhausted"}}' },
			{ message: '{"error":{"code":"usage_limit_exceeded","message":"usage limit exceeded"}}' },
			{ message: '{"error":{"code":"usage_limit_reached","message":"usage limit reached"}}' },
		];
		let activePayload = payloads[0]!;
		let keys: unknown[] = [];
		registerCustomApi(
			API,
			(_model: Model<Api>, _context: Context, options?: SimpleStreamOptions) => {
				pushKey(keys, options);
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					if (options?.apiKey === "credential-B") {
						ok(stream);
						return;
					}
					stream.push({ type: "start", partial: assistant() });
					stream.push({
						type: "error",
						reason: "error",
						error: assistantError(activePayload.message, activePayload.status),
					});
				});
				return stream;
			},
			SOURCE_ID,
		);

		for (const payload of payloads) {
			activePayload = payload;
			keys = [];
			const eventTypes: string[] = [];
			const retryContexts: ApiKeyResolveContext[] = [];
			const stream = streamSimple(model(), context, {
				apiKey: async ctx => {
					if (ctx.error !== undefined) retryContexts.push(ctx);
					return ctx.error === undefined ? "credential-A" : ctx.lastChance ? "credential-B" : "credential-A";
				},
			});
			for await (const event of stream) {
				eventTypes.push(event.type);
			}

			expect((await stream.result()).content).toEqual([{ type: "text", text: "ok" }]);
			expect(keys).toEqual(["credential-A", "credential-B"]);
			expect(eventTypes).toEqual(["start", "done"]);
			expect(retryContexts.map(ctx => ctx.lastChance)).toEqual([false, true]);
		}
	});

	it("does not rotate or refresh on informative transient 429 bodies", async () => {
		const transient429Bodies = [
			"Cloud Code Assist API error (429): Too many requests",
			"Please retry in 5s",
			"Service overloaded 529",
		];
		let active = transient429Bodies[0]!;
		const keys: unknown[] = [];
		const retryResolves: ApiKeyResolveContext[] = [];
		registerCustomApi(
			API,
			(_model: Model<Api>, _context: Context, options?: SimpleStreamOptions) => {
				pushKey(keys, options);
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: assistant() });
					stream.push({
						type: "error",
						reason: "error",
						error: assistantError(active, 429),
					});
				});
				return stream;
			},
			SOURCE_ID,
		);

		for (const body of transient429Bodies) {
			active = body;
			keys.length = 0;
			retryResolves.length = 0;
			const eventTypes: string[] = [];
			const stream = streamSimple(model(), context, {
				apiKey: async ctx => {
					if (ctx.error !== undefined) retryResolves.push(ctx);
					return ctx.error === undefined ? "credential-A" : "credential-B";
				},
			});

			for await (const event of stream) {
				eventTypes.push(event.type);
			}
			const result = await stream.result();

			// The provider's own retry/backoff layer owns these — the auth
			// retry loop must NOT capture, refresh, or burn a sibling.
			expect(retryResolves).toEqual([]);
			expect(keys).toEqual(["credential-A"]);
			expect(eventTypes).toEqual(["start", "error"]);
			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toContain(body);
		}
	});

	it("rotates on the exact Google Resource exhausted 429 error before content", async () => {
		const keys: unknown[] = [];
		const retryContexts: ApiKeyResolveContext[] = [];
		registerCustomApi(
			API,
			(_model: Model<Api>, _context: Context, options?: SimpleStreamOptions) => {
				pushKey(keys, options);
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					if (options?.apiKey === "next-key") {
						ok(stream);
						return;
					}
					stream.push({ type: "start", partial: assistant() });
					stream.push({
						type: "error",
						reason: "error",
						error: assistantError(googleResourceExhaustedMessage(), 429),
					});
				});
				return stream;
			},
			SOURCE_ID,
		);

		const stream = streamSimple(model(), context, {
			apiKey: async ctx => {
				if (ctx.error !== undefined) retryContexts.push(ctx);
				return ctx.error === undefined ? "old-key" : ctx.lastChance ? "next-key" : "old-key";
			},
		});
		for await (const _event of stream) {
			// drain
		}

		expect((await stream.result()).content).toEqual([{ type: "text", text: "ok" }]);
		expect(keys).toEqual(["old-key", "next-key"]);
		expect(retryContexts.map(ctx => ({ lastChance: ctx.lastChance, hasError: ctx.error !== undefined }))).toEqual([
			{ lastChance: false, hasError: true },
			{ lastChance: true, hasError: true },
		]);
		expect((retryContexts[1]?.error as Error).message).toContain("Resource exhausted");
	});

	it("surfaces the original error when the resolver declines every retry", async () => {
		const keys: unknown[] = [];
		const original = usageLimitError();
		registerCustomApi(
			API,
			(_model: Model<Api>, _context: Context, options?: SimpleStreamOptions) => {
				pushKey(keys, options);
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => stream.fail(original));
				return stream;
			},
			SOURCE_ID,
		);

		const stream = streamSimple(model(), context, {
			// Decline all retries: no sibling credential to rotate to.
			apiKey: async ctx => (ctx.error === undefined ? "old-key" : undefined),
		});

		let caught: unknown;
		try {
			for await (const _event of stream) {
				// drain
			}
		} catch (error) {
			caught = error;
		}

		expect(caught).toBe(original);
		expect(keys).toEqual(["old-key"]);
	});

	it("fails the stream when the initial resolve yields no key", async () => {
		let attempts = 0;
		registerCustomApi(
			API,
			() => {
				attempts += 1;
				return new AssistantMessageEventStream();
			},
			SOURCE_ID,
		);

		const stream = streamSimple(model(), context, { apiKey: async () => undefined });

		let caught: unknown;
		try {
			for await (const _event of stream) {
				// drain
			}
		} catch (error) {
			caught = error;
		}

		expect((caught as Error).message).toMatch(/No API key for provider/);
		expect(attempts).toBe(0);
	});
});
