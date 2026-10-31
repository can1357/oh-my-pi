/**
 * `StreamOptions.beforeDispatch`: the hold a caller puts on every request this
 * layer puts on the wire. It runs at the provider-dispatch chokepoint
 * (`withProviderInFlightLimit`), after the credential, any command-backed
 * headers and the in-flight slot, and before the transport — the retries this
 * layer makes itself (thinking-loop re-sample, rotated credential) pass
 * through it, and a throw from it fails that attempt instead of hanging.
 */
import { afterEach, describe, expect, setSystemTime, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import { clearCustomApis, registerCustomApi, unregisterCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import * as duoWorkflow from "@oh-my-pi/pi-ai/providers/gitlab-duo-workflow";
import { createMockModel, type MockContent, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import {
	__providerInFlightForTesting,
	completeSimple,
	RESOLVED_CREDENTIAL_REUSE_MS,
	stream,
	streamSimple,
} from "@oh-my-pi/pi-ai/stream";
import type {
	Api,
	AssistantMessage,
	Context,
	FetchImpl,
	Model,
	ModelSpec,
	SimpleStreamOptions,
	TransportWrapper,
	Usage,
} from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { armPreResponseTimeout } from "@oh-my-pi/pi-ai/utils/idle-iterator";
import * as requestDebug from "@oh-my-pi/pi-ai/utils/request-debug";
import { MAX_DISPATCH_HOLD_PASSES } from "@oh-my-pi/pi-ai/utils/dispatch-hold";
import { transportFetch, withoutDispatchHold } from "@oh-my-pi/pi-ai/utils/transport-fetch";

const SOURCE_ID = "before-dispatch-test";
const API = "before-dispatch-test" as Api;

function context(): Context {
	return { systemPrompt: [], messages: [{ role: "user", content: "go", timestamp: 0 }] };
}

/** A degenerate near-duplicate reasoning loop: what the thinking-loop guard re-samples. */
function loopResponse(): { content: MockContent[] } {
	const variants = [
		"I am now verifying the test module to guarantee there are no compile errors and the code is completely safe.",
		"I am now verifying the test module once more to ensure there are no compile errors and the code stays completely safe.",
		"I am now re-verifying the test module to confirm there are no compile errors and the code remains completely safe.",
	];
	const paragraphs: string[] = [];
	for (let i = 0; i < 12; i++) paragraphs.push(variants[i % variants.length]!);
	return { content: [{ type: "thinking", thinking: paragraphs.join("\n\n") }] };
}

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

function reply(): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "ok" }],
		api: API,
		provider: "test-provider",
		model: "test-model",
		timestamp: 1,
		stopReason: "stop",
		usage: usage(),
	};
}

function authError(): Error & { status: number } {
	return Object.assign(new Error("401 authentication_error"), { status: 401 });
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

/**
 * One turn of the event loop: what makes a hold *park* rather than answer at
 * once, with no wall-clock delay.
 */
function loopTurn(): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setImmediate(resolve);
	return promise;
}

let limiterRoot: string | undefined;

afterEach(async () => {
	unregisterCustomApis(SOURCE_ID);
	clearCustomApis();
	__providerInFlightForTesting.setRoot(undefined);
	__providerInFlightForTesting.setWaitObserver(undefined);
	if (limiterRoot !== undefined) {
		await fs.rm(limiterRoot, { recursive: true, force: true });
		limiterRoot = undefined;
	}
});

describe("beforeDispatch", () => {
	test("runs after command-backed headers resolve and before the transport", async () => {
		const order: string[] = [];
		registerCustomApi(
			API,
			() => {
				order.push("dispatch");
				const stream = new AssistantMessageEventStream();
				const message = reply();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: message });
					stream.push({ type: "done", reason: "stop", message });
				});
				return stream;
			},
			SOURCE_ID,
		);
		const headerModel = {
			...model(),
			resolveHeaders: async () => {
				order.push("headers");
				return { "x-test": "1" };
			},
		} as Model<Api>;

		const message = await streamSimple(headerModel, context(), {
			beforeDispatch: () => {
				order.push("hold");
			},
		}).result();

		expect(message.content).toEqual([{ type: "text", text: "ok" }]);
		expect(order).toEqual(["headers", "hold", "dispatch"]);
	});

	test("runs after the in-flight slot is acquired, not before the wait", async () => {
		limiterRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-before-dispatch-"));
		__providerInFlightForTesting.setRoot(limiterRoot);
		registerMockApi();
		const firstStarted = Promise.withResolvers<void>();
		const releaseFirst = Promise.withResolvers<void>();
		let calls = 0;
		const mock = createMockModel({
			provider: "tests",
			handler: async () => {
				calls += 1;
				if (calls === 1) {
					firstStarted.resolve();
					await releaseFirst.promise;
				}
				return { content: [`reply ${calls}`] };
			},
		});

		const first = streamSimple(mock.model, context(), { maxInFlightRequests: { tests: 1 } });
		const firstResult = first.result();
		await firstStarted.promise;

		let holds = 0;
		const waiting = Promise.withResolvers<void>();
		__providerInFlightForTesting.setWaitObserver(provider => {
			if (provider === "tests") waiting.resolve();
		});
		const second = streamSimple(mock.model, context(), {
			maxInFlightRequests: { tests: 1 },
			beforeDispatch: () => {
				holds += 1;
			},
		});
		await waiting.promise;

		// The slot wait is an await of this layer's own: the hold must follow it.
		expect(holds).toBe(0);

		releaseFirst.resolve();
		await Promise.all([firstResult, second.result()]);
		expect(holds).toBe(1);
		expect(calls).toBe(2);
	});

	test("holds a thinking-loop re-sample until the hold resolves", async () => {
		registerMockApi();
		const waitSpy = spyOn(scheduler, "wait").mockResolvedValue(undefined);
		try {
			const mock = createMockModel({ provider: "openrouter", id: "google/gemini-3.5-flash" });
			for (let i = 0; i < 4; i++) mock.push(loopResponse());
			const held = Promise.withResolvers<void>();
			let holds = 0;

			const result = completeSimple(mock.model, context(), {
				beforeDispatch: async () => {
					holds += 1;
					if (holds === 2) await held.promise;
				},
			});
			await Bun.sleep(5);

			// One sample taken, the guard wants another, and the hold has it.
			expect(holds).toBe(2);
			expect(mock.calls).toHaveLength(1);

			held.resolve();
			const message = await result;
			expect(mock.calls).toHaveLength(3);
			expect(holds).toBe(3); // one per dispatch, re-samples included
			expect(message.stopReason).toBe("error");
		} finally {
			waitSpy.mockRestore();
		}
	});

	test("holds an attempt with a rotated credential until the hold resolves", async () => {
		const keys: unknown[] = [];
		registerCustomApi(
			API,
			(_model: Model<Api>, _context: Context, options?: SimpleStreamOptions) => {
				keys.push(options?.apiKey);
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					if (keys.length === 1) {
						stream.fail(authError());
						return;
					}
					const message = reply();
					stream.push({ type: "start", partial: message });
					stream.push({ type: "done", reason: "stop", message });
				});
				return stream;
			},
			SOURCE_ID,
		);
		const held = Promise.withResolvers<void>();
		let holds = 0;

		const stream = streamSimple(model(), context(), {
			apiKey: async ctx => (ctx.error === undefined ? "old-key" : "refresh-key"),
			beforeDispatch: async () => {
				holds += 1;
				if (holds === 2) await held.promise;
			},
		});
		const drained = (async () => {
			for await (const _event of stream) {
				// drain
			}
			return stream.result();
		})();
		await Bun.sleep(5);

		// The 401 rotated a key; that second attempt waits on the hold.
		expect(holds).toBe(2);
		expect(keys).toEqual(["old-key"]);

		held.resolve();
		const message = await drained;
		expect(keys).toEqual(["old-key", "refresh-key"]);
		expect(message.content).toEqual([{ type: "text", text: "ok" }]);
	});

	test("fails the attempt when the hold throws, instead of leaving the stream open", async () => {
		registerCustomApi(
			API,
			() => {
				throw new Error("the transport must never be reached");
			},
			SOURCE_ID,
		);

		const stream = streamSimple(model(), context(), {
			apiKey: async () => "old-key",
			beforeDispatch: () => {
				throw new Error("held and refused");
			},
		});
		const settled = await Promise.race([
			stream.result().then(
				message => message.errorMessage ?? "resolved",
				(error: unknown) => (error instanceof Error ? error.message : String(error)),
			),
			Bun.sleep(1_000).then(() => "hung"),
		]);

		expect(settled).toBe("held and refused");
	});

	// `gitlab-duo-agent` dispatched outside `withProviderInFlightLimit` and
	// healed leaked thinking itself, so it was the one request on the wire the
	// chokepoint never saw.
	test("holds the gitlab-duo-agent dispatch, which bypassed the chokepoint", async () => {
		const order: string[] = [];
		const duoSpy = spyOn(duoWorkflow, "streamGitLabDuoWorkflow").mockImplementation((() => {
			order.push("dispatch");
			const events = new AssistantMessageEventStream();
			queueMicrotask(() => {
				events.push({ type: "start", partial: reply() });
				events.push({ type: "done", reason: "stop", message: reply() });
			});
			return events;
		}) as never);
		try {
			const duoModel = {
				...model(),
				api: "gitlab-duo-agent" as Api,
				provider: "gitlab-duo-agent",
			} as Model<Api>;
			const stream = streamSimple(duoModel, context(), {
				apiKey: "duo-token",
				beforeDispatch: () => {
					order.push("hold");
				},
			});
			await stream.result();
		} finally {
			duoSpy.mockRestore();
		}

		expect(order).toEqual(["hold", "dispatch"]);
	});

	// Every other test here takes a custom, mock or GitLab branch, none of which
	// goes through `mapOptionsForApi`; an ordinary provider does, and the hold
	// has to survive that mapping.
	test("survives the option mapping an ordinary provider goes through", async () => {
		const order: string[] = [];
		const anthropic = buildModel({
			id: "claude-test",
			name: "Claude Test",
			api: "anthropic-messages",
			provider: "anthropic",
			baseUrl: "https://api.anthropic.com",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1_000,
			maxTokens: 16,
		} satisfies ModelSpec<"anthropic-messages">);

		await streamSimple(anthropic, context(), {
			apiKey: "test-key",
			maxHttpAttempts: 1,
			fetch: async () => {
				order.push("request");
				return new Response("{}", { status: 400 });
			},
			beforeDispatch: () => {
				order.push("hold");
			},
		}).result();

		// Twice before the one request: the dispatch chokepoint, then the
		// transport wrapper that also covers the attempts after this one.
		expect(order).toEqual(["hold", "hold", "request"]);
	});

	// The chokepoint hold covers the attempt the stream layer makes; the
	// transport's own retries happen after it, and each is another paid request.
	test("holds every transport attempt, not only the first", async () => {
		const order: string[] = [];
		const anthropic = buildModel({
			id: "claude-retry",
			name: "Claude Retry",
			api: "anthropic-messages",
			provider: "anthropic",
			baseUrl: "https://api.anthropic.com",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1_000,
			maxTokens: 16,
		} satisfies ModelSpec<"anthropic-messages">);
		let attempts = 0;

		await streamSimple(anthropic, context(), {
			apiKey: "test-key",
			maxHttpAttempts: 2,
			maxRetryDelayMs: 1,
			fetch: async () => {
				attempts += 1;
				order.push(`request-${attempts}`);
				return new Response("{}", { status: attempts === 1 ? 529 : 400 });
			},
			beforeDispatch: () => {
				order.push("hold");
			},
		}).result();

		// The chokepoint's hold, then one per HTTP attempt.
		expect(order).toEqual(["hold", "hold", "request-1", "hold", "request-2"]);
	});

	// The hold lives in the one transport wrapper, so re-entering it (the auth
	// retry does, and `streamSimple` re-enters `stream`) must not add a second
	// layer: that would hold twice and, under `PI_REQ_DEBUG`, capture twice.
	test("adds one transport layer, holding once per attempt", async () => {
		const calls: string[] = [];
		const base = (async () => {
			calls.push("request");
			return new Response("{}", { status: 200 });
		}) satisfies FetchImpl;
		const hold = () => {
			calls.push("hold");
		};
		const once = transportFetch(model(), base, hold);
		expect(transportFetch(model(), once, hold)).toBe(once);

		await once("https://example.invalid/v1/messages", { method: "POST" });

		expect(calls).toEqual(["hold", "request"]);
	});

	// An indefinite hold is legitimate (`/pause` holds until a human resumes);
	// an indefinite hold after the caller cancelled is not: the request stayed
	// parked forever, keeping its provider in-flight permit with it.
	test("ends a hold that never resolves when the caller aborts", async () => {
		let dispatches = 0;
		registerCustomApi(
			API,
			() => {
				dispatches += 1;
				const events = new AssistantMessageEventStream();
				queueMicrotask(() => events.push({ type: "done", reason: "stop", message: reply() }));
				return events;
			},
			SOURCE_ID,
		);
		const held = Promise.withResolvers<void>();
		const entered = Promise.withResolvers<void>();
		const abort = new AbortController();

		const result = streamSimple(model(), context(), {
			signal: abort.signal,
			beforeDispatch: () => {
				entered.resolve();
				return held.promise;
			},
		}).result();
		await entered.promise;
		abort.abort(new Error("cancelled"));

		const settled = await Promise.race([
			result.then(
				() => "resolved",
				(error: unknown) => (error instanceof Error ? error.message : String(error)),
			),
			Bun.sleep(1_000).then(() => "still held"),
		]);

		expect(settled).toBe("cancelled");
		expect(dispatches).toBe(0);
		held.resolve();
	});

	// A key the hold outlived is resolved again inside the barrier, once the
	// hold answers. That refresh was awaited, not raced: cancelled while the
	// resolver was still pending, the request stayed parked, and kept its
	// provider in-flight permit, until the resolver settled.
	test("ends a credential refresh that never settles when the caller aborts, and frees its in-flight permit", async () => {
		limiterRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-before-dispatch-"));
		__providerInFlightForTesting.setRoot(limiterRoot);
		let dispatches = 0;
		registerCustomApi(
			API,
			() => {
				dispatches += 1;
				const events = new AssistantMessageEventStream();
				queueMicrotask(() => events.push({ type: "done", reason: "stop", message: reply() }));
				return events;
			},
			SOURCE_ID,
		);
		const limit = { [model().provider]: 1 };
		const start = Date.parse("2026-10-30T10:00:00Z");
		setSystemTime(new Date(start));
		try {
			const parked = Promise.withResolvers<void>();
			const held = Promise.withResolvers<void>();
			const refreshing = Promise.withResolvers<void>();
			const refreshed = Promise.withResolvers<string>();
			const abort = new AbortController();
			let resolves = 0;

			const result = streamSimple(model(), context(), {
				signal: abort.signal,
				maxInFlightRequests: limit,
				apiKey: () => {
					resolves += 1;
					if (resolves === 1) return "old-key";
					refreshing.resolve();
					return refreshed.promise;
				},
				beforeDispatch: () => {
					parked.resolve();
					return held.promise;
				},
			}).result();
			await parked.promise;
			setSystemTime(new Date(start + RESOLVED_CREDENTIAL_REUSE_MS + 1));
			held.resolve();
			await refreshing.promise;
			abort.abort(new Error("cancelled"));

			await expect(result).rejects.toThrow("cancelled");
			expect(dispatches).toBe(0);

			// The permit went with the cancellation: the next request under the
			// same cap of one goes out while the refresh is still pending.
			const next = await streamSimple(model(), context(), { maxInFlightRequests: limit }).result();
			expect(next.stopReason).toBe("stop");
			expect(dispatches).toBe(1);
			refreshed.resolve("new-key");
		} finally {
			setSystemTime();
		}
	});

	// `PI_REQ_DEBUG` dumps the request body to disk between the hold and the
	// wire. Dumping after the hold made the hold not the last step: a pause
	// engaged during the dump still reached the provider.
	test("finishes request-debug preparation before the final hold", async () => {
		const sentWhileHeld: boolean[] = [];
		const gate = { closed: false };
		const resumed = Promise.withResolvers<void>();
		const debugEnabled = spyOn(requestDebug, "isRequestDebugEnabled").mockReturnValue(true);
		const debugSession = spyOn(requestDebug, "createFetchRequestDebugSession").mockImplementation(async () => {
			// The dump is slow enough to span a pause the caller engages.
			gate.closed = true;
			return {
				id: 1,
				requestPath: "unused",
				responsePath: "unused",
				openResponseLog: async () => ({ write() {}, async close() {} }),
				wrapResponse: async (response: Response) => response,
			};
		});
		try {
			const fetch = transportFetch(
				model(),
				async () => {
					sentWhileHeld.push(gate.closed);
					return new Response("{}", { status: 200 });
				},
				() => {
					if (!gate.closed) return;
					queueMicrotask(() => {
						gate.closed = false;
						resumed.resolve();
					});
					return resumed.promise;
				},
			);

			await fetch("https://example.invalid/v1/messages", { method: "POST" });
		} finally {
			debugEnabled.mockRestore();
			debugSession.mockRestore();
		}

		expect(sentWhileHeld).toEqual([false]);
	});

	// Re-stamping dropped a hold the built fetch did not already carry, so a
	// caller that gated an existing transport got an ungated one back.
	test("takes on a hold the stamped fetch does not carry, without a second layer", async () => {
		const calls: string[] = [];
		const base = (async () => {
			calls.push("request");
			return new Response("{}", { status: 200 });
		}) satisfies FetchImpl;
		const first = () => {
			calls.push("first");
		};
		const second = () => {
			calls.push("second");
		};
		const once = transportFetch(model(), base, first);
		const twice = transportFetch(model(), once, second);

		expect(twice).not.toBe(once);
		await twice("https://example.invalid/v1/messages", { method: "POST" });
		// Both holds, and still exactly one transport layer around `base`.
		expect(calls).toEqual(["first", "second", "request"]);

		calls.length = 0;
		expect(transportFetch(model(), twice, second)).toBe(twice);
		expect(transportFetch(model(), twice, first)).toBe(twice);
		await twice("https://example.invalid/v1/messages", { method: "POST" });
		expect(calls).toEqual(["first", "second", "request"]);
	});

	// Cursor builds its payload after the chokepoint hold and then sent through
	// a fetch of its own, so a pause engaged during the build reached Cursor and
	// the caller's transport (proxy, CA bundle, PI_REQ_DEBUG) was skipped too.
	test("sends Cursor's HTTP/1 run request through the caller's held transport", async () => {
		const sentWhileHeld: boolean[] = [];
		const gate = { closed: false };
		const resumed = Promise.withResolvers<void>();
		const forbidden: typeof fetch = Object.assign(
			async () => {
				throw new Error("Cursor must not bypass the caller's transport");
			},
			{ preconnect: () => {} },
		);
		const globalFetch = spyOn(globalThis, "fetch").mockImplementation(forbidden);
		try {
			const cursor = buildModel({
				id: "claude-sonnet-4",
				name: "Cursor Hold",
				api: "cursor-agent",
				provider: "cursor",
				baseUrl: "http://127.0.0.1:9876",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 200_000,
				maxTokens: 1_000,
			} satisfies ModelSpec<"cursor-agent">);

			await stream(cursor, context(), {
				apiKey: "cursor-token",
				transport: "http1",
				fetch: async () => {
					sentWhileHeld.push(gate.closed);
					return new Response("{}", { status: 400 });
				},
				// The request payload is built after the chokepoint hold.
				onPayload: () => {
					gate.closed = true;
				},
				beforeDispatch: () => {
					if (!gate.closed) return;
					queueMicrotask(() => {
						gate.closed = false;
						resumed.resolve();
					});
					return resumed.promise;
				},
			}).result();
		} finally {
			globalFetch.mockRestore();
		}

		expect(sentWhileHeld.length).toBeGreaterThan(0);
		expect(sentWhileHeld.every(held => !held)).toBe(true);
	});

	// Codex's websocket handshake happens after the chokepoint hold, and
	// `response.create` — the frame the provider bills — went out without
	// consulting the gate again.
	test("holds Codex's websocket request until after the handshake", async () => {
		const sends: string[] = [];
		const gate = { closed: false };
		const resumed = Promise.withResolvers<void>();
		class HandshakePausingSocket {
			static CONNECTING = 0;
			static OPEN = 1;
			static CLOSED = 3;
			readyState = 0;
			binaryType = "nodebuffer";
			onopen: ((event: Event) => void) | null = null;
			onmessage: ((event: MessageEvent) => void) | null = null;
			onerror: ((event: Event) => void) | null = null;
			onclose: ((event: Event) => void) | null = null;
			constructor() {
				// The gate closes while the socket is still connecting.
				gate.closed = true;
				queueMicrotask(() => {
					this.readyState = 1;
					this.onopen?.(new Event("open"));
				});
			}
			send(data: string): void {
				const frame: unknown = JSON.parse(data);
				const type = frame && typeof frame === "object" && "type" in frame ? String(frame.type) : "unknown";
				sends.push(`${type}:held=${gate.closed}`);
				queueMicrotask(() =>
					this.onmessage?.(
						new MessageEvent("message", {
							data: JSON.stringify({
								type: "response.completed",
								response: {
									id: "resp_hold",
									status: "completed",
									output: [],
									usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 },
								},
							}),
						}),
					),
				);
			}
			close(): void {
				this.readyState = 3;
			}
		}
		const originalWebSocket = globalThis.WebSocket;
		globalThis.WebSocket = HandshakePausingSocket as unknown as typeof WebSocket;
		try {
			const codex = buildModel({
				id: "gpt-5.4-mini",
				name: "Codex Hold",
				api: "openai-codex-responses",
				provider: "codex-proxy",
				baseUrl: "http://127.0.0.1:2455/backend-api/codex",
				preferWebsockets: true,
				reasoning: true,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 272_000,
				maxTokens: 128_000,
			} satisfies ModelSpec<"openai-codex-responses">);

			await streamSimple(codex, context(), {
				apiKey: "codex-token",
				sessionId: "before-dispatch-ws",
				providerSessionState: new Map(),
				beforeDispatch: () => {
					if (!gate.closed) return;
					queueMicrotask(() => {
						gate.closed = false;
						resumed.resolve();
					});
					return resumed.promise;
				},
			}).result();
		} finally {
			globalThis.WebSocket = originalWebSocket;
		}

		expect(sends).toEqual(["response.create:held=false"]);
	});

	// Opening the socket is traffic of its own, and the chokepoint hold runs
	// before Codex awaits its attestation header and builds its headers: a
	// pause landing in that window used to connect anyway.
	test("holds Codex's websocket connect, not only its request", async () => {
		const events: string[] = [];
		const gate = { closed: false };
		const resumed = Promise.withResolvers<void>();
		let holds = 0;
		class ConnectRecordingSocket {
			static CONNECTING = 0;
			static OPEN = 1;
			static CLOSED = 3;
			readyState = 0;
			binaryType = "nodebuffer";
			onopen: ((event: Event) => void) | null = null;
			onmessage: ((event: MessageEvent) => void) | null = null;
			onerror: ((event: Event) => void) | null = null;
			onclose: ((event: Event) => void) | null = null;
			constructor() {
				events.push(`connect:held=${gate.closed}`);
				queueMicrotask(() => {
					this.readyState = 1;
					this.onopen?.(new Event("open"));
				});
			}
			send(): void {
				events.push(`send:held=${gate.closed}`);
				queueMicrotask(() =>
					this.onmessage?.(
						new MessageEvent("message", {
							data: JSON.stringify({
								type: "response.completed",
								response: {
									id: "resp_connect_hold",
									status: "completed",
									output: [],
									usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 },
								},
							}),
						}),
					),
				);
			}
			close(): void {
				this.readyState = 3;
			}
		}
		const originalWebSocket = globalThis.WebSocket;
		globalThis.WebSocket = ConnectRecordingSocket as unknown as typeof WebSocket;
		try {
			const codex = buildModel({
				id: "gpt-5.4-mini",
				name: "Codex Connect Hold",
				api: "openai-codex-responses",
				provider: "codex-proxy",
				baseUrl: "http://127.0.0.1:2455/backend-api/codex",
				preferWebsockets: true,
				reasoning: true,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 272_000,
				maxTokens: 128_000,
			} satisfies ModelSpec<"openai-codex-responses">);

			await streamSimple(codex, context(), {
				apiKey: "codex-token",
				sessionId: "before-dispatch-ws-connect",
				providerSessionState: new Map(),
				beforeDispatch: () => {
					holds += 1;
					// The pause lands right after the chokepoint hold released,
					// while Codex is still resolving its attestation header.
					if (holds === 1) {
						gate.closed = true;
						return;
					}
					if (!gate.closed) return;
					queueMicrotask(() => {
						gate.closed = false;
						resumed.resolve();
					});
					return resumed.promise;
				},
			}).result();
		} finally {
			globalThis.WebSocket = originalWebSocket;
		}

		expect(events).toEqual(["connect:held=false", "send:held=false"]);
	});

	// A pre-response deadline bounds how long the provider may take to answer.
	// Armed where the request is built, it also counted the hold, so resuming a
	// pause longer than the deadline failed the request with `TimeoutError`
	// instead of sending it. Real time is the contract here, hence the timers.
	test("does not charge a dispatch hold to the pre-response deadline", async () => {
		const holdMs = 60;
		const deadlineMs = 25;
		let abortedAtWire: boolean | undefined;
		const watchdog = armPreResponseTimeout(undefined, deadlineMs);
		const fetch = transportFetch(
			model(),
			async (_input, init) => {
				abortedAtWire = init?.signal?.aborted ?? false;
				return new Response("{}", { status: 200 });
			},
			() => Bun.sleep(holdMs),
		);

		const response = await fetch("https://example.invalid/v1/messages", {
			method: "POST",
			signal: watchdog.signal,
		});
		watchdog.clear();

		expect(abortedAtWire).toBe(false);
		expect(response.status).toBe(200);
	});

	// A caller that has to answer a provider SDK's own retry loop needs to see
	// each attempt and its response; a hold cannot express that. The wrapper
	// composes onto an already-built transport the same way a hold does, and
	// without a second layer: one debug capture per attempt that goes out.
	test("takes on a transport wrapper the stamped fetch does not carry, without a second layer", async () => {
		const calls: string[] = [];
		const debugCaptures: string[] = [];
		const debugEnabled = spyOn(requestDebug, "isRequestDebugEnabled").mockReturnValue(true);
		const debugSession = spyOn(requestDebug, "createFetchRequestDebugSession").mockImplementation(async input => {
			debugCaptures.push(String(input));
			return {
				id: debugCaptures.length,
				requestPath: "unused",
				responsePath: "unused",
				openResponseLog: async () => ({ write() {}, async close() {} }),
				wrapResponse: async (response: Response) => response,
			};
		});
		try {
			const base = (async () => {
				calls.push("request");
				return new Response("{}", { status: 200 });
			}) satisfies FetchImpl;
			const hold = () => {
				calls.push("hold");
			};
			// Per-request state: the first attempt goes out, later ones are
			// declined before anything of the transport's own runs.
			let attempts = 0;
			let declined = 0;
			const wrap: TransportWrapper = inner => async (input, init) => {
				attempts += 1;
				if (attempts > 1) {
					declined += 1;
					throw new Error("retry declined");
				}
				return inner(input, init);
			};

			const once = transportFetch(model(), base, hold);
			const observed = transportFetch(model(), once, hold, wrap);
			expect(observed).not.toBe(once);
			// Supplying the same wrapper again changes nothing.
			expect(transportFetch(model(), observed, hold, wrap)).toBe(observed);

			const response = await observed("https://example.invalid/v1/messages", { method: "POST" });
			expect(response.status).toBe(200);
			await expect(observed("https://example.invalid/v1/messages", { method: "POST" })).rejects.toThrow(
				"retry declined",
			);

			// One hold and one request for the attempt that went out, nothing for
			// the declined one, and exactly one debug capture — one layer.
			expect(calls).toEqual(["hold", "request"]);
			expect(debugCaptures).toHaveLength(1);
			expect(declined).toBe(1);
		} finally {
			debugEnabled.mockRestore();
			debugSession.mockRestore();
		}
	});

	// Two holds were awaited one after the other, so a first hold that closed
	// again while the second still waited was never asked again: the request
	// went out under a gate that was closed at the time it was sent. The wait
	// need not turn the event loop: a second hold that answers late, in the
	// very microtasks in which the first closes again, leaves the first answer
	// as stale as one that parked.
	for (const { waits, between } of [
		{ waits: "parks", between: loopTurn },
		{ waits: "answers late", between: async () => {} },
	]) {
		test(`asks the first hold again when it closes while the second ${waits}`, async () => {
			const calls: string[] = [];
			const sentWhileClosed: boolean[] = [];
			const gate = { closed: false };
			const reopened = Promise.withResolvers<void>();
			const reasked = Promise.withResolvers<void>();
			const entered = Promise.withResolvers<void>();
			const held = Promise.withResolvers<void>();
			const first = () => {
				calls.push("first");
				if (!gate.closed) return;
				reasked.resolve();
				return reopened.promise;
			};
			const second = () => {
				calls.push("second");
				entered.resolve();
				return held.promise;
			};
			const base = (async () => {
				calls.push("request");
				sentWhileClosed.push(gate.closed);
				return new Response("{}", { status: 200 });
			}) satisfies FetchImpl;
			const fetch = transportFetch(model(), transportFetch(model(), base, first), second);

			const sent = fetch("https://example.invalid/v1/messages", { method: "POST" });
			await entered.promise;
			await between();
			gate.closed = true;
			held.resolve();
			// Either the request goes out past the re-closed first hold, or the
			// first hold is asked again and parks the request.
			await Promise.race([reasked.promise, sent]);
			expect(sentWhileClosed).toEqual([]);

			gate.closed = false;
			reopened.resolve();
			await sent;
			expect(sentWhileClosed).toEqual([false]);
			expect(calls).toEqual(["first", "second", "first", "second", "request"]);
		});
	}

	// A hold written as an `async` function that awaits anything on its way to
	// answering is late every time it is asked, open or not. That costs one
	// confirming pass; failing it like a hold that parks every time would fail
	// every request it gates alongside another hold.
	test("sends after one confirming pass when a later hold always answers late", async () => {
		const calls: string[] = [];
		const base = (async () => {
			calls.push("request");
			return new Response("{}", { status: 200 });
		}) satisfies FetchImpl;
		const first = () => {
			calls.push("first");
		};
		const second = async () => {
			calls.push("second");
			await Promise.resolve();
		};
		const fetch = transportFetch(model(), transportFetch(model(), base, first), second);

		await fetch("https://example.invalid/v1/messages", { method: "POST" });

		expect(calls).toEqual(["first", "second", "first", "second", "request"]);
	});

	// Only a hold that parks behind another makes the ones before it stale; the
	// first hold has nothing before it, so however long it parks each hold is
	// asked once, the same as a single hold.
	test("asks each hold once when only the first one parks", async () => {
		const calls: string[] = [];
		const base = (async () => {
			calls.push("request");
			return new Response("{}", { status: 200 });
		}) satisfies FetchImpl;
		const first = async () => {
			calls.push("first");
			await loopTurn();
		};
		const second = () => {
			calls.push("second");
		};
		const fetch = transportFetch(model(), transportFetch(model(), base, first), second);

		await fetch("https://example.invalid/v1/messages", { method: "POST" });

		expect(calls).toEqual(["first", "second", "request"]);
	});

	// A hold that parks every time it is asked can never be shown open at the
	// same moment as another hold. Sending anyway would send under a gate
	// nobody verified, and re-checking forever would never send at all.
	test("fails the attempt when a later hold parks on every call", async () => {
		let paced = 0;
		let requests = 0;
		const base = (async () => {
			requests += 1;
			return new Response("{}", { status: 200 });
		}) satisfies FetchImpl;
		const pacer = async () => {
			paced += 1;
			await loopTurn();
		};
		const fetch = transportFetch(
			model(),
			transportFetch(model(), base, () => {}),
			pacer,
		);

		await expect(fetch("https://example.invalid/v1/messages", { method: "POST" })).rejects.toThrow(
			"did not open together",
		);
		expect(requests).toBe(0);
		expect(paced).toBe(MAX_DISPATCH_HOLD_PASSES);
	});

	// A wrapper is per-request state. Adding a hold rebuilt the transport and the
	// wrapper with it, so the request got a fresh wrapper that had counted none
	// of its attempts: a budget of two let a third attempt out.
	test("gates a wrapper-carrying transport in place instead of rebuilding its wrapper", async () => {
		const calls: string[] = [];
		let builds = 0;
		const wrap: TransportWrapper = inner => {
			builds += 1;
			let attempts = 0;
			return async (input, init) => {
				attempts += 1;
				if (attempts > 2) throw new Error("attempt budget spent");
				return inner(input, init);
			};
		};
		const base = (async () => {
			calls.push("request");
			return new Response("{}", { status: 200 });
		}) satisfies FetchImpl;
		const hold = () => {
			calls.push("hold");
		};
		const observed = transportFetch(model(), base, undefined, wrap);
		await observed("https://example.invalid/v1/messages", { method: "POST" });

		const held = transportFetch(model(), observed, hold);
		expect(held).toBe(observed);
		expect(builds).toBe(1);
		await held("https://example.invalid/v1/messages", { method: "POST" });
		await expect(held("https://example.invalid/v1/messages", { method: "POST" })).rejects.toThrow(
			"attempt budget spent",
		);

		expect(calls).toEqual(["request", "hold", "request"]);
	});

	// A wrapper added to a transport that already carries one rebuilt it the
	// same way, constructing the first wrapper again. The later wrapper goes
	// outside the live build instead, in the order a rebuild would put it.
	test("layers a later wrapper outside a wrapper-carrying transport without rebuilding it", async () => {
		const calls: string[] = [];
		const builds: string[] = [];
		const wrapper =
			(name: string): TransportWrapper =>
			inner => {
				builds.push(name);
				return async (input, init) => {
					calls.push(name);
					return inner(input, init);
				};
			};
		const first = wrapper("first");
		const second = wrapper("second");
		const base = (async () => {
			calls.push("request");
			return new Response("{}", { status: 200 });
		}) satisfies FetchImpl;
		const hold = () => {
			calls.push("hold");
		};

		const once = transportFetch(model(), base, hold, first);
		const twice = transportFetch(model(), once, hold, second);
		expect(twice).not.toBe(once);
		expect(transportFetch(model(), twice, hold, second)).toBe(twice);
		expect(transportFetch(model(), twice, hold, first)).toBe(twice);
		await twice("https://example.invalid/v1/messages", { method: "POST" });

		expect(builds).toEqual(["first", "second"]);
		expect(calls).toEqual(["second", "first", "hold", "request"]);
	});

	// A hold joins a wrapper-carrying build in place, so that build cannot
	// stand in for its own unheld transport even while it has no hold yet: the
	// cleanup traffic handed it would be held by a hold added afterwards, and
	// would run through the inference request's wrapper.
	test("keeps cleanup traffic unheld when a hold later joins a wrapper-carrying transport", async () => {
		const calls: string[] = [];
		const base = (async () => {
			calls.push("request");
			return new Response("{}", { status: 200 });
		}) satisfies FetchImpl;
		const wrap: TransportWrapper = inner => async (input, init) => {
			calls.push("wrap");
			return inner(input, init);
		};
		const hold = () => {
			calls.push("hold");
		};
		const observed = transportFetch(model(), base, undefined, wrap);
		const cleanup = withoutDispatchHold(observed);

		expect(transportFetch(model(), observed, hold)).toBe(observed);
		expect(withoutDispatchHold(observed)).toBe(cleanup);
		// The cleanup transport is not live: a hold given for it builds a new
		// transport rather than gating the cleanup one.
		expect(transportFetch(model(), cleanup, hold)).not.toBe(cleanup);

		await cleanup("https://example.invalid/v1/workflows/1", { method: "PATCH" });
		expect(calls).toEqual(["request"]);
		calls.length = 0;
		await observed("https://example.invalid/v1/messages", { method: "POST" });
		expect(calls).toEqual(["wrap", "hold", "request"]);
	});
});
