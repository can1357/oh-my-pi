import { afterEach, describe, expect, test } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	type CustomStreamSimpleFn,
	clearCustomApis,
	getCustomApi,
	registerCustomApi,
} from "@oh-my-pi/pi-ai/api-registry";
import type { AdmittedWorkKind, ProviderCallGate } from "@oh-my-pi/pi-ai/auth/provider-gate";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { __providerInFlightForTesting, complete, stream, streamSimple } from "@oh-my-pi/pi-ai/stream";
import type {
	Api,
	AssistantMessage,
	AssistantMessageEvent,
	Context,
	Model,
	SimpleStreamOptions,
	ToolCall,
} from "@oh-my-pi/pi-ai/types";
import { getStreamingPartialJson, setStreamingPartialJson } from "@oh-my-pi/pi-ai/utils/block-symbols";
import { AssistantMessageEventStream, EventStream } from "@oh-my-pi/pi-ai/utils/event-stream";

/** The session whose work is running, as the extension loader keeps it: an async-local store
 *  entered by every admitted call. */
const sessionScope = new AsyncLocalStorage<object>();

interface SessionGate extends ProviderCallGate {
	retired: boolean;
	/** Whether the caller is running as this session's work. */
	readonly inside: boolean;
	/** Whether work this gate admitted still holds the session open, as its disposal sees it. */
	readonly holding: boolean;
	/** Settles once nothing this gate admitted holds the session open. */
	released(): Promise<void>;
}

/** What a `stream` call's product reports through `result()`, asked as the extension runtime asks
 *  it; a product without one is refused, as the runtime refuses it. */
function reportedCompletion(produced: unknown): Promise<unknown> {
	const result: unknown =
		typeof produced === "object" && produced !== null ? Reflect.get(produced, "result") : undefined;
	if (typeof result !== "function") throw new Error("Extension stream reported no completion");
	return Promise.resolve(Reflect.apply(result, produced, []));
}

/** A session's gate, holding the session open as the extension runtime does: a `stream` call until
 *  what its product reports through `result()` settles, any other call until a promise it returned
 *  settles. */
function sessionGate(): SessionGate {
	const session = {};
	const held = new Set<Promise<void>>();
	const hold = (work: Promise<unknown>): void => {
		const settled = work.then(
			() => {},
			() => {},
		);
		held.add(settled);
		void settled.finally(() => held.delete(settled));
	};
	const gate: SessionGate = {
		retired: false,
		run<R>(call: () => R, kind?: AdmittedWorkKind): R {
			if (gate.retired) throw new Error("gate retired");
			return sessionScope.run(session, () => {
				const produced = call();
				if (kind === "stream") hold(reportedCompletion(produced));
				else if (produced instanceof Promise) hold(produced);
				return produced;
			});
		},
		get inside() {
			return sessionScope.getStore() === session;
		},
		get holding() {
			return held.size > 0;
		},
		async released() {
			while (held.size > 0) await Promise.all(held);
		},
	};
	return gate;
}

/** Whether the caller runs as `gate`'s work; for the host's own API, whether any session's. */
function insideOf(gate: SessionGate | undefined): boolean {
	return gate ? gate.inside : sessionScope.getStore() !== undefined;
}

const API = "iteration-admission-api";
const SOURCE = "iteration-admission-test";

function context(): Context {
	return { systemPrompt: [], messages: [{ role: "user", content: "hi", timestamp: 0 }] };
}

function modelFor(overrides: Partial<Model<Api>> = {}): Model<Api> {
	return {
		...createMockModel({ provider: "tests", baseUrl: "https://example.invalid" }).model,
		api: API,
		...overrides,
	};
}

/** Where the caller used to hold the producer itself: an official endpoint skips the healer, and
 *  without the loop guard or an in-flight limit nothing else consumes the producer first. */
const BARE_MODEL_OVERRIDES = { compat: { officialEndpoint: true } } as Partial<Model<Api>>;
const BARE_OPTIONS: SimpleStreamOptions = { apiKey: "key", loopGuard: { enabled: false } };

function reply(model: Model<Api>, text: string, stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
	return {
		role: "assistant",
		content: stopReason === "stop" ? [{ type: "text", text }] : [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		...(stopReason === "stop" ? {} : { errorMessage: text }),
		timestamp: 0,
	};
}

/** A genuine `AssistantMessageEventStream` whose async iterator the extension wrote. The body
 *  records whether it runs as `gate`'s work when it starts, after `step` (when given; awaited
 *  between the first event and the terminal one), and in its `finally`, which then calls
 *  `onFinally`. */
function authoredIteratorReply(
	gate: SessionGate | undefined,
	records: string[],
	produced: AssistantMessageEventStream[],
	step?: () => Promise<void>,
	onFinally?: () => void,
): CustomStreamSimpleFn {
	return model => {
		const output = new AssistantMessageEventStream();
		produced.push(output);
		const message = reply(model, "authored");
		output[Symbol.asyncIterator] = async function* () {
			try {
				records.push(`body:${insideOf(gate)}`);
				yield { type: "start", partial: message };
				if (step) {
					await step();
					records.push(`resumed:${insideOf(gate)}`);
				}
				// Settles the genuine stream's own result as well.
				output.push({ type: "done", reason: "stop", message });
				yield { type: "done", reason: "stop", message };
			} finally {
				records.push(`finally:${insideOf(gate)}`);
				onFinally?.();
			}
		};
		return output;
	};
}

async function drain(events: AsyncIterable<AssistantMessageEvent>): Promise<string[]> {
	const types: string[] = [];
	for await (const event of events) types.push(event.type);
	return types;
}

type Settled = { ok: true; value: unknown } | { ok: false; error: unknown };

async function settle(promise: PromiseLike<unknown>): Promise<Settled> {
	try {
		return { ok: true, value: await promise };
	} catch (error) {
		return { ok: false, error };
	}
}

let limiterRoot: string | undefined;

afterEach(async () => {
	clearCustomApis();
	__providerInFlightForTesting.setRoot(undefined);
	if (limiterRoot !== undefined) {
		await fs.rm(limiterRoot, { recursive: true, force: true });
		limiterRoot = undefined;
	}
});

type Route = (model: Model<Api>) => Promise<AssistantMessage>;

/** Every public route by which the host consumes a custom API's stream. */
const routes: Array<[string, Route]> = [
	["streamSimple", async model => streamSimple(model, context(), { apiKey: "key" }).result()],
	[
		"streamSimple, drained by the caller",
		async model => {
			const response = streamSimple(model, context(), { apiKey: "key" });
			await drain(response);
			return response.result();
		},
	],
	[
		"streamSimple without the loop guard",
		async model => streamSimple(model, context(), { apiKey: "key", loopGuard: { enabled: false } }).result(),
	],
	[
		"streamSimple to an official endpoint without the loop guard, drained by the caller",
		async model => {
			const response = streamSimple({ ...model, ...BARE_MODEL_OVERRIDES }, context(), BARE_OPTIONS);
			await drain(response);
			return response.result();
		},
	],
	[
		"streamSimple under an in-flight limit",
		async model => {
			limiterRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-iteration-admission-"));
			__providerInFlightForTesting.setRoot(limiterRoot);
			return streamSimple(model, context(), { apiKey: "key", maxInFlightRequests: { tests: 1 } }).result();
		},
	],
	[
		"streamSimple with an API key resolver",
		async model => streamSimple(model, context(), { apiKey: () => "resolved" }).result(),
	],
	[
		"streamSimple with resolved model headers",
		async model => streamSimple({ ...model, resolveHeaders: async () => ({ "x-h": "v" }) }, context()).result(),
	],
	["stream", async model => stream(model, context(), { apiKey: "key" }).result()],
	["complete", async model => complete(model, context(), { apiKey: "key" })],
];

describe("a custom API stream's authored iterator", () => {
	test.each(routes)("%s: runs as the registering session's work", async (_name, route) => {
		const gate = sessionGate();
		const records: string[] = [];
		const produced: AssistantMessageEventStream[] = [];
		registerCustomApi(API, authoredIteratorReply(gate, records, produced), SOURCE, undefined, gate);

		const message = await route(modelFor());

		expect(message.content).toEqual([{ type: "text", text: "authored" }]);
		expect(produced).toHaveLength(1);
		expect(records).toEqual(["body:true", "finally:true"]);
	});

	test.each(routes)("%s: a host registration's stream is iterated exactly as before", async (_name, route) => {
		const records: string[] = [];
		const produced: AssistantMessageEventStream[] = [];
		registerCustomApi(API, authoredIteratorReply(undefined, records, produced), SOURCE);

		const message = await route(modelFor());

		expect(message.content).toEqual([{ type: "text", text: "authored" }]);
		expect(produced).toHaveLength(1);
		// No session is entered for the host's own API.
		expect(records).toEqual(["body:false", "finally:false"]);
	});

	test("retiring the session while its stream is consumed neither refuses nor disowns the rest", async () => {
		const gate = sessionGate();
		const records: string[] = [];
		const produced: AssistantMessageEventStream[] = [];
		const paused = Promise.withResolvers<void>();
		const resume = Promise.withResolvers<void>();
		registerCustomApi(
			API,
			authoredIteratorReply(gate, records, produced, async () => {
				paused.resolve();
				await resume.promise;
			}),
			SOURCE,
			undefined,
			gate,
		);

		const response = streamSimple(modelFor(), context(), { apiKey: "key" });
		await paused.promise;
		// Disposal releases the session before it waits for this stream: the stream already
		// running is what it drains, so it is not refused part-way.
		gate.retired = true;
		resume.resolve();
		const message = await response.result();

		expect(message.content).toEqual([{ type: "text", text: "authored" }]);
		// Owned through the producer's terminal, including the return() that ends its iterator.
		expect(records).toEqual(["body:true", "resumed:true", "finally:true"]);
	});
});

describe("the stream the host consumes for a session's producer", () => {
	type Scenario = (output: AssistantMessageEventStream, model: Model<Api>) => Promise<void>;
	const scenarios: Array<[string, Scenario, string[]]> = [
		[
			"done",
			async (output, model) => {
				output.push({ type: "start", partial: reply(model, "x") });
				await Promise.resolve();
				output.push({ type: "done", reason: "stop", message: reply(model, "x") });
			},
			["start", "done"],
		],
		[
			"an error event",
			async (output, model) => {
				output.push({ type: "start", partial: reply(model, "x") });
				await Promise.resolve();
				output.push({ type: "error", reason: "error", error: reply(model, "boom", "error") });
			},
			["start", "error"],
		],
		[
			"a failed producer",
			async (output, model) => {
				output.push({ type: "start", partial: reply(model, "x") });
				await Promise.resolve();
				output.fail(new Error("producer failed"));
			},
			["start"],
		],
		[
			"end(result) without a terminal event",
			async (output, model) => {
				output.push({ type: "start", partial: reply(model, "x") });
				await Promise.resolve();
				output.end(reply(model, "ended"));
			},
			["start"],
		],
		[
			"end() without a result",
			async (output, model) => {
				output.push({ type: "start", partial: reply(model, "x") });
				await Promise.resolve();
				output.end();
			},
			["start"],
		],
	];

	for (const owner of ["host", "session"] as const) {
		test.each(scenarios)(
			`${owner}: %s reaches the caller exactly as the producer reports it`,
			async (_n, run, types) => {
				const gate = owner === "session" ? sessionGate() : undefined;
				const produced: AssistantMessageEventStream[] = [];
				registerCustomApi(
					API,
					model => {
						const output = new AssistantMessageEventStream();
						produced.push(output);
						void run(output, model);
						return output;
					},
					SOURCE,
					undefined,
					gate,
				);

				const response = streamSimple({ ...modelFor(), ...BARE_MODEL_OVERRIDES }, context(), BARE_OPTIONS);
				const seen: string[] = [];
				const iteration = await settle(
					(async () => {
						for await (const event of response) seen.push(event.type);
					})(),
				);
				const callerResult = await settle(response.result());
				const producerResult = await settle(produced[0]!.result());

				expect(seen).toEqual(types);
				// The same rejection, by identity, as the producer's own result. The same value: the
				// producer's own for the host's API, and for a session's a host copy equal to it, so that
				// nothing the caller reads afterwards is the session's object.
				expect(callerResult.ok).toBe(producerResult.ok);
				if (callerResult.ok && producerResult.ok) {
					if (owner === "host") expect(callerResult.value).toBe(producerResult.value);
					else {
						expect(callerResult.value).not.toBe(producerResult.value);
						expect(callerResult.value).toEqual(producerResult.value);
					}
				}
				if (!callerResult.ok && !producerResult.ok) expect(callerResult.error).toBe(producerResult.error);
				// A failed producer throws its own error into the caller's iteration.
				if (!iteration.ok && !producerResult.ok) expect(iteration.error).toBe(producerResult.error);
				expect(iteration.ok).toBe(_n !== "a failed producer");
				// Only a session's producer is consumed through a host stream.
				if (owner === "host") expect(response).toBe(produced[0]!);
				else expect(response).not.toBe(produced[0]!);
			},
		);
	}

	test.each([
		["with an official endpoint, no loop guard and no in-flight limit", BARE_MODEL_OVERRIDES, BARE_OPTIONS],
		["by default", {}, { apiKey: "key" }],
	] as const)("a caller that aborts mid-stream %s still stops the producer", async (_n, overrides, options) => {
		const gate = sessionGate();
		const records: string[] = [];
		registerCustomApi(
			API,
			(model, _context, producerOptions) => {
				const output = new AssistantMessageEventStream();
				output.push({ type: "start", partial: reply(model, "x") });
				producerOptions?.signal?.addEventListener(
					"abort",
					() => {
						records.push(`aborted:${gate.inside}`);
						output.push({ type: "error", reason: "aborted", error: reply(model, "aborted", "aborted") });
					},
					{ once: true },
				);
				return output;
			},
			SOURCE,
			undefined,
			gate,
		);

		const controller = new AbortController();
		const response = streamSimple({ ...modelFor(), ...overrides }, context(), {
			...options,
			signal: controller.signal,
		});
		const seen: string[] = [];
		let seenInTheAbortTurn: string[] = [];
		for await (const event of response) {
			seen.push(event.type);
			if (event.type === "start") {
				controller.abort();
				seenInTheAbortTurn = [...records];
			}
		}
		const message = await response.result();

		// The producer's listener ran inside `abort()`, in the same turn, as the session's work.
		expect(seenInTheAbortTurn).toEqual(["aborted:true"]);
		expect(records).toEqual(["aborted:true"]);
		expect(seen).toEqual(["start", "error"]);
		expect(message.stopReason).toBe("aborted");
	});

	test.each([
		["with an official endpoint, no loop guard and no in-flight limit", BARE_MODEL_OVERRIDES, BARE_OPTIONS],
		["by default", {}, { apiKey: "key" }],
	] as const)(
		"a caller that stops early %s does not hang, and the producer finishes owned",
		async (_n, overrides, options) => {
			const gate = sessionGate();
			const records: string[] = [];
			const produced: AssistantMessageEventStream[] = [];
			const resume = Promise.withResolvers<void>();
			const finished = Promise.withResolvers<void>();
			registerCustomApi(
				API,
				authoredIteratorReply(gate, records, produced, () => resume.promise, finished.resolve),
				SOURCE,
				undefined,
				gate,
			);

			const response = streamSimple({ ...modelFor(), ...overrides }, context(), options);
			for await (const event of response) {
				if (event.type === "start") break;
			}
			resume.resolve();
			const message = await response.result();

			expect(message.content).toEqual([{ type: "text", text: "authored" }]);
			// The result settles at the producer's terminal; its iterator's return() follows it.
			await finished.promise;
			expect(records).toEqual(["body:true", "resumed:true", "finally:true"]);
		},
	);

	test("forwards the producer's local work while its stream lasts, asked as the session's work", async () => {
		const gate = sessionGate();
		const records: string[] = [];
		const localWork = Promise.withResolvers<void>();
		const finish = Promise.withResolvers<void>();
		const ownGetter = Object.getOwnPropertyDescriptor(EventStream.prototype, "hasPendingLocalWork")?.get;
		if (!ownGetter) throw new Error("EventStream.hasPendingLocalWork getter missing");
		registerCustomApi(
			API,
			model => {
				const output = new AssistantMessageEventStream();
				Object.defineProperty(output, "hasPendingLocalWork", {
					get() {
						records.push(`localWork:${gate.inside}`);
						return ownGetter.call(output);
					},
				});
				output.push({ type: "start", partial: reply(model, "x") });
				void output.trackLocalWork(localWork.promise);
				void finish.promise.then(() => output.push({ type: "done", reason: "stop", message: reply(model, "x") }));
				return output;
			},
			SOURCE,
			undefined,
			gate,
		);

		const response = streamSimple({ ...modelFor(), ...BARE_MODEL_OVERRIDES }, context(), BARE_OPTIONS);
		expect(response.hasPendingLocalWork).toBe(true);
		localWork.resolve();
		await Promise.resolve();
		await Promise.resolve();
		expect(response.hasPendingLocalWork).toBe(false);
		finish.resolve();
		await response.result();
		// The consumer detaches after its last step, a few microtasks after the terminal: flush them.
		const flushed = Promise.withResolvers<void>();
		setImmediate(flushed.resolve);
		await flushed.promise;
		// Detached once the producer's stream is over: the author's getter is not asked again.
		expect(response.hasPendingLocalWork).toBe(false);
		expect(records).toEqual(["localWork:true", "localWork:true"]);
	});

	/** A session's producer counting the calls to its `result()`. It ends with a terminal event, or
	 *  with `end(result)` and none. */
	function countingProducer(ending: "terminal" | "end", calls: { result: number }): CustomStreamSimpleFn {
		return model => {
			const output = new AssistantMessageEventStream();
			const ownResult = output.result.bind(output);
			output.result = () => {
				calls.result++;
				return ownResult();
			};
			queueMicrotask(() => {
				if (ending === "terminal") output.push({ type: "done", reason: "stop", message: reply(model, "ended") });
				else output.end(reply(model, "ended"));
			});
			return output;
		};
	}

	test.each(["terminal", "end"] as const)(
		"ending with %s, the producer's result() is called once: one answer serves the session's hold and the caller",
		async ending => {
			const gate = sessionGate();
			const calls = { result: 0 };
			registerCustomApi(API, countingProducer(ending, calls), SOURCE, undefined, gate);

			const response = streamSimple({ ...modelFor(), ...BARE_MODEL_OVERRIDES }, context(), BARE_OPTIONS);
			await drain(response);
			expect((await response.result()).content).toEqual([{ type: "text", text: "ended" }]);
			await gate.released();

			expect(calls.result).toBe(1);
		},
	);

	test("a host registration's view hands back its producer itself", () => {
		const produced: AssistantMessageEventStream[] = [];
		registerCustomApi(API, authoredIteratorReply(undefined, [], produced), SOURCE);

		expect(getCustomApi(API)!.streamSimple(modelFor(), context())).toBe(produced[0]!);
	});

	test("with an official endpoint, no loop guard and no in-flight limit, a host registration's stream is the caller's own", async () => {
		const records: string[] = [];
		const produced: AssistantMessageEventStream[] = [];
		registerCustomApi(API, authoredIteratorReply(undefined, records, produced), SOURCE);

		const response = streamSimple({ ...modelFor(), ...BARE_MODEL_OVERRIDES }, context(), BARE_OPTIONS);

		expect(response).toBe(produced[0]!);
		expect(await drain(response)).toEqual(["start", "done"]);
		expect(records).toEqual(["body:false", "finally:false"]);
	});
});

/** Settles after the microtasks queued so far, and the ones they queue, have run. */
async function nextTurn(): Promise<void> {
	const turned = Promise.withResolvers<void>();
	setImmediate(turned.resolve);
	await turned.promise;
}

/** `signal` with its abort listeners counted as they are added and removed. */
function countListeners(signal: AbortSignal): Set<unknown> {
	const listening = new Set<unknown>();
	const add = signal.addEventListener.bind(signal);
	const remove = signal.removeEventListener.bind(signal);
	signal.addEventListener = (...args: Parameters<typeof add>) => {
		if (args[0] === "abort") listening.add(args[1]);
		add(...args);
	};
	signal.removeEventListener = (...args: Parameters<typeof remove>) => {
		if (args[0] === "abort") listening.delete(args[1]);
		remove(...args);
	};
	return listening;
}

describe("how long a session's stream holds the session open", () => {
	/** A genuine stream whose authored iterator yields its terminal and then, in an asynchronous
	 *  `finally`, waits for `finish`; `entered` settles when that `finally` starts. */
	function heldFinallyReply(gate: SessionGate, records: string[], entered: () => void, finish: Promise<void>) {
		return ((model: Model<Api>) => {
			const output = new AssistantMessageEventStream();
			const message = reply(model, "authored");
			output[Symbol.asyncIterator] = async function* () {
				try {
					output.push({ type: "done", reason: "stop", message });
					yield { type: "done", reason: "stop", message };
				} finally {
					records.push(`finally:${gate.inside}`);
					entered();
					await finish;
					records.push(`closed:${gate.inside}`);
				}
			};
			return output;
		}) satisfies CustomStreamSimpleFn;
	}

	test.each([
		["with an official endpoint, no loop guard and no in-flight limit", BARE_MODEL_OVERRIDES, BARE_OPTIONS],
		["by default", {}, { apiKey: "key" }],
	] as const)(
		"%s: through the authored iterator's asynchronous finally, which the host's close starts",
		async (_n, overrides, options) => {
			const gate = sessionGate();
			const records: string[] = [];
			const entered = Promise.withResolvers<void>();
			const finish = Promise.withResolvers<void>();
			registerCustomApi(
				API,
				heldFinallyReply(gate, records, entered.resolve, finish.promise),
				SOURCE,
				undefined,
				gate,
			);

			const response = streamSimple({ ...modelFor(), ...overrides }, context(), options);
			await response.result();
			await entered.promise;
			await nextTurn();
			const heldDuringFinally = gate.holding;
			finish.resolve();
			await gate.released();

			expect(heldDuringFinally).toBe(true);
			expect(records).toEqual(["finally:true", "closed:true"]);
		},
	);

	test("lets go of the caller's signal when, and only when, it stops holding the session", async () => {
		const gate = sessionGate();
		const entered = Promise.withResolvers<void>();
		const finish = Promise.withResolvers<void>();
		registerCustomApi(API, heldFinallyReply(gate, [], entered.resolve, finish.promise), SOURCE, undefined, gate);
		const controller = new AbortController();
		const listening = countListeners(controller.signal);

		const response = streamSimple({ ...modelFor(), ...BARE_MODEL_OVERRIDES }, context(), {
			...BARE_OPTIONS,
			signal: controller.signal,
		});
		await response.result();
		await entered.promise;
		await nextTurn();
		const duringFinally = { listening: listening.size, holding: gate.holding };
		finish.resolve();
		await gate.released();
		await nextTurn();

		expect(duringFinally).toEqual({ listening: 1, holding: true });
		expect({ listening: listening.size, holding: gate.holding }).toEqual({ listening: 0, holding: false });
	});

	test("a stream taken from the registry directly is consumed, and lets go of the caller's signal at its producer's terminal", async () => {
		const gate = sessionGate();
		registerCustomApi(
			API,
			model => {
				const output = new AssistantMessageEventStream();
				queueMicrotask(() => output.push({ type: "done", reason: "stop", message: reply(model, "x") }));
				return output;
			},
			SOURCE,
			undefined,
			gate,
		);
		const controller = new AbortController();
		const listening = countListeners(controller.signal);

		const response = getCustomApi(API)!.streamSimple(modelFor(), context(), { signal: controller.signal });
		await response.result();
		await gate.released();
		await nextTurn();

		expect({ listening: listening.size, holding: gate.holding }).toEqual({ listening: 0, holding: false });
	});

	test("until the producer's own reported result settles, even after its iterator's terminal", async () => {
		const gate = sessionGate();
		const produced: AssistantMessageEventStream[] = [];
		registerCustomApi(
			API,
			model => {
				const output = new AssistantMessageEventStream();
				produced.push(output);
				const message = reply(model, "authored");
				// The iterator yields a terminal its stream has not reported: `result()` is still open.
				output[Symbol.asyncIterator] = async function* () {
					yield { type: "done", reason: "stop", message };
				};
				return output;
			},
			SOURCE,
			undefined,
			gate,
		);

		const response = streamSimple({ ...modelFor(), ...BARE_MODEL_OVERRIDES }, context(), BARE_OPTIONS);
		await response.result();
		await nextTurn();
		const heldBeforeReport = gate.holding;
		produced[0]!.end(reply(modelFor(), "reported"));
		await gate.released();

		expect(heldBeforeReport).toBe(true);
		expect(gate.holding).toBe(false);
	});
});

describe("the signal a custom API's producer is called with", () => {
	interface SignalSight {
		aborted: boolean;
		reason: unknown;
		thrown: unknown;
		inside: boolean;
	}

	function sight(signal: AbortSignal, gate: SessionGate | undefined): SignalSight {
		let thrown: unknown;
		try {
			signal.throwIfAborted();
		} catch (error) {
			thrown = error;
		}
		return { aborted: signal.aborted, reason: signal.reason, thrown, inside: insideOf(gate) };
	}

	/** A producer that records what its signal says when it is called and when it aborts. */
	function watchingProducer(
		gate: SessionGate | undefined,
		calls: SignalSight[],
		aborts: SignalSight[],
		signals: AbortSignal[],
	) {
		return ((model, _context, options) => {
			const output = new AssistantMessageEventStream();
			const signal = options?.signal;
			if (!signal) throw new Error("producer called without a signal");
			signals.push(signal);
			calls.push(sight(signal, gate));
			if (signal.aborted) {
				output.push({ type: "error", reason: "aborted", error: reply(model, "aborted", "aborted") });
				return output;
			}
			output.push({ type: "start", partial: reply(model, "x") });
			signal.addEventListener(
				"abort",
				() => {
					aborts.push(sight(signal, gate));
					output.push({ type: "error", reason: "aborted", error: reply(model, "aborted", "aborted") });
				},
				{ once: true },
			);
			return output;
		}) satisfies CustomStreamSimpleFn;
	}

	const routes = [
		["with an official endpoint, no loop guard and no in-flight limit", BARE_MODEL_OVERRIDES, BARE_OPTIONS],
		["by default", {}, { apiKey: "key" }],
	] as const;

	test.each(routes)(
		"%s: a caller's signal already aborted reaches the producer aborted, with its reason",
		async (_n, overrides, options) => {
			const gate = sessionGate();
			const calls: SignalSight[] = [];
			registerCustomApi(API, watchingProducer(gate, calls, [], []), SOURCE, undefined, gate);
			const controller = new AbortController();
			const reason = new Error("caller gave up");
			controller.abort(reason);

			const message = await streamSimple({ ...modelFor(), ...overrides }, context(), {
				...options,
				signal: controller.signal,
			}).result();

			expect(calls).toEqual([{ aborted: true, reason, thrown: reason, inside: true }]);
			expect(calls[0]!.reason).toBe(reason);
			expect(calls[0]!.thrown).toBe(reason);
			expect(message.stopReason).toBe("aborted");
		},
	);

	test.each(routes)(
		"%s: a later abort reaches the producer in the same turn, with its reason, as the session's work",
		async (_n, overrides, options) => {
			const gate = sessionGate();
			const calls: SignalSight[] = [];
			const aborts: SignalSight[] = [];
			registerCustomApi(API, watchingProducer(gate, calls, aborts, []), SOURCE, undefined, gate);
			const controller = new AbortController();
			const reason = new Error("caller gave up");

			const response = streamSimple({ ...modelFor(), ...overrides }, context(), {
				...options,
				signal: controller.signal,
			});
			controller.abort(reason);
			const abortsInTheAbortTurn = aborts.length;
			const message = await response.result();

			expect(calls).toEqual([{ aborted: false, reason: undefined, thrown: undefined, inside: true }]);
			expect(abortsInTheAbortTurn).toBe(1);
			expect(aborts).toEqual([{ aborted: true, reason, thrown: reason, inside: true }]);
			expect(aborts[0]!.reason).toBe(reason);
			expect(aborts[0]!.thrown).toBe(reason);
			expect(message.stopReason).toBe("aborted");
		},
	);

	test("a host registration's producer is called with the caller's own signal", async () => {
		const signals: AbortSignal[] = [];
		registerCustomApi(API, watchingProducer(undefined, [], [], signals), SOURCE);
		const controller = new AbortController();

		const response = streamSimple({ ...modelFor(), ...BARE_MODEL_OVERRIDES }, context(), {
			...BARE_OPTIONS,
			signal: controller.signal,
		});
		controller.abort();
		await response.result();

		expect(signals).toHaveLength(1);
		expect(signals[0]).toBe(controller.signal);
	});

	test("a long-lived caller signal keeps no listener once each request is over", async () => {
		const gate = sessionGate();
		const controller = new AbortController();
		const signal = controller.signal;
		const listening = new Set<unknown>();
		const add = signal.addEventListener.bind(signal);
		const remove = signal.removeEventListener.bind(signal);
		signal.addEventListener = (...args: Parameters<typeof add>) => {
			if (args[0] === "abort") listening.add(args[1]);
			add(...args);
		};
		signal.removeEventListener = (...args: Parameters<typeof remove>) => {
			if (args[0] === "abort") listening.delete(args[1]);
			remove(...args);
		};
		let outcome: "done" | "fail" | "throw" = "done";
		registerCustomApi(
			API,
			model => {
				if (outcome === "throw") throw new Error("producer threw");
				const output = new AssistantMessageEventStream();
				queueMicrotask(() => {
					if (outcome === "fail") output.fail(new Error("producer failed"));
					else output.push({ type: "done", reason: "stop", message: reply(model, "x") });
				});
				return output;
			},
			SOURCE,
			undefined,
			gate,
		);
		const flush = async () => {
			const flushed = Promise.withResolvers<void>();
			setImmediate(flushed.resolve);
			await flushed.promise;
		};

		const open: number[] = [];
		for (const next of ["done", "fail", "throw", "done", "fail", "throw"] as const) {
			outcome = next;
			try {
				await settle(
					streamSimple({ ...modelFor(), ...BARE_MODEL_OVERRIDES }, context(), {
						...BARE_OPTIONS,
						signal,
					}).result(),
				);
			} catch {
				// The producer that throws fails the call itself.
			}
			await flush();
			open.push(listening.size);
		}

		expect(open).toEqual([0, 0, 0, 0, 0, 0]);
	});
});

type Built = { message: AssistantMessage; events: AssistantMessageEvent[] };

describe("what a session's stream carries reaches the host as a copy taken inside its admission", () => {
	/** Makes `field` of `target` a getter that answers `authored` when it is read as `gate`'s work and
	 *  `substitute` otherwise, recording whether each read was inside. */
	function twoFaced<T extends object>(target: T, field: string, gate: SessionGate, reads: boolean[]): T {
		Object.defineProperty(target, field, {
			get() {
				reads.push(gate.inside);
				return gate.inside ? "authored" : "substitute";
			},
			enumerable: true,
			configurable: true,
		});
		return target;
	}

	/** A message whose first text block's `text` is {@link twoFaced}. */
	function twoFacedReply(model: Model<Api>, gate: SessionGate, reads: boolean[]): AssistantMessage {
		const message = reply(model, "unused");
		twoFaced(message.content[0]!, "text", gate, reads);
		return message;
	}

	/** A producer whose authored iterator yields the built events and whose `result()` answers the
	 *  built message, both built per call. */
	function producing(build: (model: Model<Api>) => Built, produced: Built[] = []): CustomStreamSimpleFn {
		return model => {
			const output = new AssistantMessageEventStream();
			const built = build(model);
			produced.push(built);
			output.result = async () => built.message;
			output[Symbol.asyncIterator] = async function* () {
				yield* built.events;
			};
			return output;
		};
	}

	test.each(routes)("%s: a terminal event's message is the one read inside", async (_name, route) => {
		const gate = sessionGate();
		const reads: boolean[] = [];
		registerCustomApi(
			API,
			producing(model => {
				const message = twoFacedReply(model, gate, reads);
				return { message, events: [{ type: "done", reason: "stop", message }] };
			}),
			SOURCE,
			undefined,
			gate,
		);

		const message = await route(modelFor());
		await gate.released();
		gate.retired = true;

		expect(JSON.stringify(message)).toContain('"text":"authored"');
		expect(JSON.stringify(message)).not.toContain("substitute");
		expect(reads.length).toBeGreaterThan(0);
		expect(reads.every(inside => inside)).toBe(true);
	});

	test.each(routes)("%s: a result reported with no terminal event is the one read inside", async (_name, route) => {
		const gate = sessionGate();
		const reads: boolean[] = [];
		registerCustomApi(
			API,
			producing(model => ({ message: twoFacedReply(model, gate, reads), events: [] })),
			SOURCE,
			undefined,
			gate,
		);

		const message = await route(modelFor());
		await gate.released();
		gate.retired = true;

		expect(JSON.stringify(message)).toContain('"text":"authored"');
		expect(JSON.stringify(message)).not.toContain("substitute");
		expect(reads.length).toBeGreaterThan(0);
		expect(reads.every(inside => inside)).toBe(true);
	});

	test("each delta event, its partial included, is the one read inside", async () => {
		const gate = sessionGate();
		const reads: boolean[] = [];
		registerCustomApi(
			API,
			producing(model => {
				const message = twoFacedReply(model, gate, reads);
				const delta = twoFaced(
					{ type: "text_delta", contentIndex: 0, delta: "unused", partial: message } as AssistantMessageEvent,
					"delta",
					gate,
					reads,
				);
				return { message, events: [delta, { type: "done", reason: "stop", message }] };
			}),
			SOURCE,
			undefined,
			gate,
		);

		const response = getCustomApi(API)!.streamSimple(modelFor(), context());
		await gate.released();
		gate.retired = true;
		const events: AssistantMessageEvent[] = [];
		for await (const event of response) events.push(event);
		const message = await response.result();

		expect(JSON.parse(JSON.stringify({ events, message }))).toMatchObject({
			events: [
				{ type: "text_delta", delta: "authored", partial: { content: [{ type: "text", text: "authored" }] } },
				{ type: "done", message: { content: [{ type: "text", text: "authored" }] } },
			],
			message: { content: [{ type: "text", text: "authored" }] },
		});
		expect(reads.length).toBeGreaterThan(0);
		expect(reads.every(inside => inside)).toBe(true);
	});

	test("an error event's message is the one read inside", async () => {
		const gate = sessionGate();
		const reads: boolean[] = [];
		registerCustomApi(
			API,
			producing(model => {
				const message = twoFaced(reply(model, "unused", "error"), "errorMessage", gate, reads);
				return { message, events: [{ type: "error", reason: "error", error: message }] };
			}),
			SOURCE,
			undefined,
			gate,
		);

		const response = getCustomApi(API)!.streamSimple(modelFor(), context());
		await gate.released();
		gate.retired = true;
		const events: AssistantMessageEvent[] = [];
		for await (const event of response) events.push(event);
		const message = await response.result();

		expect(events).toHaveLength(1);
		expect(JSON.stringify({ events, message })).not.toContain("substitute");
		expect(message.errorMessage).toBe("authored");
		expect(reads.length).toBeGreaterThan(0);
		expect(reads.every(inside => inside)).toBe(true);
	});

	test("a tool call's streamed argument JSON, keyed by a symbol, is copied with its block", async () => {
		const gate = sessionGate();
		registerCustomApi(
			API,
			producing(model => {
				const message = reply(model, "x");
				const toolCall: ToolCall = { type: "toolCall", id: "call", name: "tool", arguments: { a: 1 } };
				setStreamingPartialJson(toolCall, '{"a":1');
				message.content = [toolCall];
				return {
					message,
					events: [
						{ type: "toolcall_delta", contentIndex: 0, delta: '{"a":1', partial: message },
						{ type: "toolcall_end", contentIndex: 0, toolCall, partial: message },
						{ type: "done", reason: "toolUse", message },
					],
				};
			}),
			SOURCE,
			undefined,
			gate,
		);

		const events: AssistantMessageEvent[] = [];
		for await (const event of getCustomApi(API)!.streamSimple(modelFor(), context())) events.push(event);

		const [delta, end] = events;
		if (delta?.type !== "toolcall_delta" || end?.type !== "toolcall_end") throw new Error("events out of order");
		expect(getStreamingPartialJson(delta.partial.content[0] as ToolCall)).toBe('{"a":1');
		// One event's copy keeps that event's aliases: the tool call it ends is the block in its partial.
		expect(end.toolCall).toBe(end.partial.content[0] as ToolCall);
		expect(end.toolCall.arguments).toEqual({ a: 1 });
	});

	test.each([
		[
			"an event's message",
			(message: AssistantMessage): AssistantMessageEvent[] => [{ type: "done", reason: "stop", message }],
			'Custom API "iteration-admission-api": events[0].message.content[0].text is a function, but it must be data.',
		],
		[
			"a reported result",
			(): AssistantMessageEvent[] => [],
			'Custom API "iteration-admission-api": result().content[0].text is a function, but it must be data.',
		],
	] as const)("a function where data belongs in %s is refused, naming where", async (_n, events, expected) => {
		const gate = sessionGate();
		const called: boolean[] = [];
		registerCustomApi(
			API,
			producing(model => {
				const message = reply(model, "x");
				// A function where the block's text belongs, which the type cannot express.
				Reflect.set(message.content[0]!, "text", () => called.push(true));
				return { message, events: events(message) };
			}),
			SOURCE,
			undefined,
			gate,
		);

		const outcome = await settle(getCustomApi(API)!.streamSimple(modelFor(), context()).result());

		expect(outcome.ok).toBe(false);
		if (!outcome.ok) expect((outcome.error as Error).message).toStartWith(expected);
		expect(called).toEqual([]);
	});

	test("an event or content block of a type no variant has is copied as data", async () => {
		const gate = sessionGate();
		const produced: Built[] = [];
		registerCustomApi(
			API,
			producing(model => {
				const message = reply(model, "x");
				// Shapes outside the types, which the host forwarded before and still forwards.
				const block = { type: "custom_block", detail: { k: "v" } };
				message.content.push(block as unknown as AssistantMessage["content"][number]);
				const progress = { type: "custom_progress", detail: { n: 1 } };
				return {
					message,
					events: [progress as unknown as AssistantMessageEvent, { type: "done", reason: "stop", message }],
				};
			}, produced),
			SOURCE,
			undefined,
			gate,
		);

		const events: AssistantMessageEvent[] = [];
		for await (const event of getCustomApi(API)!.streamSimple(modelFor(), context())) events.push(event);

		const [progress, done] = events;
		const authored = produced[0]!.events[0]!;
		expect(progress).toEqual(authored);
		expect(progress).not.toBe(authored);
		expect(Reflect.get(progress!, "detail")).not.toBe(Reflect.get(authored, "detail"));
		if (done?.type !== "done") throw new Error("expected the terminal event");
		// A block outside the content types, so read as what it is to the type system: unknown.
		const block: unknown = done.message.content[1];
		expect(block).toEqual({ type: "custom_block", detail: { k: "v" } });
		expect(block).not.toBe(produced[0]!.message.content[1]);
	});

	test("a host registration's events and result reach the caller as the producer's own", async () => {
		const produced: Built[] = [];
		const reads: boolean[] = [];
		registerCustomApi(
			API,
			producing(model => {
				const message = twoFacedReply(model, sessionGate(), reads);
				const delta: AssistantMessageEvent = { type: "text_delta", contentIndex: 0, delta: "d", partial: message };
				return { message, events: [delta, { type: "done", reason: "stop", message }] };
			}, produced),
			SOURCE,
		);

		const response = getCustomApi(API)!.streamSimple(modelFor(), context());
		const events: AssistantMessageEvent[] = [];
		for await (const event of response) events.push(event);
		const message = await response.result();

		expect(produced).toHaveLength(1);
		// The very objects the producer yielded and reported, which the registry never read.
		expect(events).toHaveLength(2);
		expect(events[0]).toBe(produced[0]!.events[0]!);
		expect(events[1]).toBe(produced[0]!.events[1]!);
		expect(message).toBe(produced[0]!.message);
		expect(reads).toEqual([]);
	});
});
