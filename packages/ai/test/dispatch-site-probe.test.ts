/**
 * The dispatch sites outside the transport fetch: the provider-dispatch
 * chokepoint, the Cursor HTTP/2 request stream and the native judge. Each one
 * awaited the caller's hold and then sent a few microtasks later, so a gate
 * that closed in between was never read again and the request went out under
 * it. Awaiting a hold proves only that it was open when it answered; a site is
 * exact only when it sends in the same synchronous step as the last read of
 * the holds' probes. These tests close a probed gate at each microtask depth
 * after the hold is asked and check that nothing reaches the wire while it
 * reads closed. The Cursor stream is also cancelled at each depth, and a
 * cancelled turn must neither open nor write it.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import http2 from "node:http2";
import { NativeJudge } from "@oh-my-pi/pi-ai";
import { registerCustomApi, unregisterCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { streamCursor } from "@oh-my-pi/pi-ai/providers/cursor";
import { stream } from "@oh-my-pi/pi-ai/stream";
import type { Api, AssistantMessage, Context, DispatchHold, Model } from "@oh-my-pi/pi-ai/types";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

/** Deep enough to reach past every microtask between a hold's answer and the send. */
const MAX_DEPTH = 24;

/** One turn of the event loop: every microtask queued before it has run. */
function loopTurn(): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setImmediate(resolve);
	return promise;
}

/** Runs `fn` `depth` microtasks from now. */
function afterMicrotasks(depth: number, fn: () => void): void {
	queueMicrotask(() => (depth <= 1 ? fn() : afterMicrotasks(depth - 1, fn)));
}

/** A gate with a probe, as `/pause` builds one: closed, its hold parks until reopened. */
function probedGate() {
	let closed = false;
	let reopened = Promise.withResolvers<void>();
	const hold: DispatchHold = () => (closed ? reopened.promise : undefined);
	hold.isClosed = () => closed;
	return {
		hold,
		get closed() {
			return closed;
		},
		close() {
			if (closed) return;
			closed = true;
			reopened = Promise.withResolvers<void>();
		},
		open() {
			closed = false;
			reopened.resolve();
		},
	};
}

/**
 * Sends one request per depth from 1 to {@link MAX_DEPTH}, each behind a probed
 * gate that closes `depth` microtasks after its hold is first asked. `send`
 * starts the request, calls `onWire` at the moment the request reaches the
 * wire, and settles once the request has finished. Returns the depths at which
 * the gate closed before the request reached the wire, and those at which the
 * request reached the wire while the gate read closed.
 */
async function closeAtEachDepth(
	send: (hold: DispatchHold, onWire: () => void) => Promise<unknown>,
): Promise<{ closedFirst: number[]; sentClosed: number[] }> {
	const closedFirst: number[] = [];
	const sentClosed: number[] = [];
	for (let depth = 1; depth <= MAX_DEPTH; depth++) {
		const gate = probedGate();
		const asked = Promise.withResolvers<void>();
		const wired = Promise.withResolvers<void>();
		let onWire = false;
		let armed = true;
		const hold: DispatchHold = () => {
			if (armed) {
				armed = false;
				asked.resolve();
				afterMicrotasks(depth, () => {
					if (!onWire) closedFirst.push(depth);
					gate.close();
				});
			}
			return gate.hold();
		};
		hold.isClosed = gate.hold.isClosed;
		const done = send(hold, () => {
			if (gate.closed) sentClosed.push(depth);
			onWire = true;
			wired.resolve();
		});
		await Promise.race([asked.promise, done]);
		// Every microtask the close is queued behind has run by the next turn, so
		// a request the gate holds has parked; reopening lets it finish.
		await loopTurn();
		gate.open();
		await Promise.race([wired.promise, done]);
		await done;
	}
	return { closedFirst, sentClosed };
}

function usage(): AssistantMessage["usage"] {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

const context: Context = { messages: [{ role: "user", content: "go", timestamp: 0 }] };

describe("the provider-dispatch chokepoint", () => {
	const SOURCE_ID = "dispatch-site-probe-test";
	const api = "dispatch-site-probe" as Api;
	const model = {
		id: "dispatch-site-probe",
		name: "Dispatch Site Probe",
		api,
		provider: "dispatch-site-probe",
		contextWindow: 1000,
		maxTokens: 100,
	} as Model<Api>;

	afterEach(() => {
		unregisterCustomApis(SOURCE_ID);
	});

	test("dispatches to the provider only while no probed gate reads closed", async () => {
		let onDispatch: (() => void) | undefined;
		registerCustomApi(
			api,
			() => {
				onDispatch?.();
				const events = new AssistantMessageEventStream();
				queueMicrotask(() =>
					events.push({
						type: "done",
						reason: "stop",
						message: {
							role: "assistant",
							content: [{ type: "text", text: "ok" }],
							api,
							provider: model.provider,
							model: model.id,
							timestamp: 0,
							stopReason: "stop",
							usage: usage(),
						},
					}),
				);
				return events;
			},
			SOURCE_ID,
		);

		const { closedFirst, sentClosed } = await closeAtEachDepth((hold, onWire) => {
			onDispatch = onWire;
			return stream(model, context, { beforeDispatch: hold }).result();
		});

		expect(sentClosed).toEqual([]);
		expect(closedFirst.length).toBeGreaterThan(0);
	});
});

describe("Cursor HTTP/2", () => {
	const model = buildModel({
		id: "cursor-dispatch-probe",
		name: "Cursor dispatch probe",
		api: "cursor-agent",
		provider: "cursor",
		baseUrl: "https://cursor.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 1_000,
	});

	/** The half of an HTTP/2 stream this fixture answers: it never replies, so only the open, its writes and its close matter. */
	type FakeStream = EventEmitter & {
		closed: boolean;
		writableEnded: boolean;
		write(): void;
		end(): void;
		close(): void;
	};

	/**
	 * An HTTP/2 session whose `request` is the wire: it reports and opens a
	 * stream that never answers, and reports every write to that stream.
	 */
	function fakeSession(onRequest: (request: FakeStream) => void, onWrite: () => void = () => {}) {
		const session = new EventEmitter();
		return Object.assign(session, {
			request(): FakeStream {
				const request: FakeStream = Object.assign(new EventEmitter(), {
					closed: false,
					writableEnded: false,
					write() {
						onWrite();
					},
					end() {
						request.writableEnded = true;
					},
					close() {
						request.closed = true;
					},
				});
				onRequest(request);
				return request;
			},
			close() {},
		});
	}

	test("opens its request stream only while no probed gate reads closed", async () => {
		let onRequest: (() => void) | undefined;
		const connect = spyOn(http2, "connect").mockImplementation((() =>
			fakeSession(() => onRequest?.())) as unknown as typeof http2.connect);
		try {
			const { closedFirst, sentClosed } = await closeAtEachDepth((hold, onWire) => {
				const abort = new AbortController();
				onRequest = () => {
					onWire();
					// The stream never answers: end the turn once its request is open.
					setImmediate(() => abort.abort());
				};
				return streamCursor(model, context, {
					apiKey: "fake",
					transport: "http2",
					beforeDispatch: hold,
					signal: abort.signal,
				}).result();
			});

			expect(sentClosed).toEqual([]);
			expect(closedFirst.length).toBeGreaterThan(0);
		} finally {
			connect.mockRestore();
		}
	});

	// The request's signal was read when the hold was asked and when it
	// answered, not when the stream opened, so a cancellation in the microtasks
	// after the answer still opened it. One landing after the open but before
	// the abort listener was added never fired that listener: the run request
	// was written after the cancellation and the stream was left open.
	test("neither opens nor writes its request once the caller cancels, and closes a stream it opened", async () => {
		const wiredCancelled: string[] = [];
		const leftOpen: number[] = [];
		const stopReasons = new Set<string>();
		let cancelledBeforeOpen = 0;
		let cancelledAfterOpen = 0;
		let connected = false;
		let onRequest: (request: FakeStream) => void = () => {};
		let onWrite: () => void = () => {};
		const connect = spyOn(http2, "connect").mockImplementation((() => {
			connected = true;
			return fakeSession(
				request => onRequest(request),
				() => onWrite(),
			);
		}) as unknown as typeof http2.connect);
		try {
			for (let depth = 1; depth <= MAX_DEPTH; depth++) {
				const abort = new AbortController();
				let opened: FakeStream | undefined;
				onRequest = request => {
					opened = request;
					if (abort.signal.aborted) wiredCancelled.push(`request at ${depth}`);
				};
				onWrite = () => {
					if (abort.signal.aborted) wiredCancelled.push(`write at ${depth}`);
				};
				connected = false;
				let armed = true;
				// Cancel `depth` microtasks after the ask Cursor makes right before
				// its stream opens, not the chokepoint's earlier one.
				const hold: DispatchHold = () => {
					if (!armed || !connected) return;
					armed = false;
					afterMicrotasks(depth, () => abort.abort(new Error(`cancelled ${depth} microtasks after the hold`)));
				};
				hold.isClosed = () => false;

				const message = await stream(model, context, {
					apiKey: "fake",
					transport: "http2",
					beforeDispatch: hold,
					signal: abort.signal,
				}).result();
				// The turn settles on the cancellation by itself; the provider's
				// own stream must not outlive it.
				for (let turn = 0; turn < 4; turn++) await loopTurn();

				stopReasons.add(message.stopReason);
				if (!opened) {
					cancelledBeforeOpen += 1;
				} else {
					cancelledAfterOpen += 1;
					if (!opened.closed) leftOpen.push(depth);
				}
			}

			expect(wiredCancelled).toEqual([]);
			expect(leftOpen).toEqual([]);
			expect([...stopReasons]).toEqual(["aborted"]);
			// Not vacuous: the sweep spans the open, cancelling on both sides of it.
			expect(cancelledBeforeOpen).toBeGreaterThan(0);
			expect(cancelledAfterOpen).toBeGreaterThan(0);
		} finally {
			connect.mockRestore();
		}
	});
});

describe("native judge", () => {
	test("sends an attempt only while no probed gate reads closed", async () => {
		let onFetch: (() => void) | undefined;
		const judge = new NativeJudge({
			apiKey: "k",
			fetch: async () => {
				onFetch?.();
				return Response.json({
					model: "jev-latest",
					answers: { urgent: { type: "noul", noul: 0.5 } },
					usage: { input_tokens: 1, output_tokens: 1 },
				});
			},
		});

		const { closedFirst, sentClosed } = await closeAtEachDepth((hold, onWire) => {
			onFetch = onWire;
			return judge.judge(
				{ state: "s", questions: { urgent: { type: "noul", instructions: "Urgent?" } } },
				{ beforeDispatch: hold },
			);
		});

		expect(sentClosed).toEqual([]);
		expect(closedFirst.length).toBeGreaterThan(0);
	});
});
