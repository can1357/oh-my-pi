import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import {
	AgentClientMessageSchema,
	type AgentServerMessage,
	AgentServerMessageSchema,
	BidiAppendRequestSchema,
	ExecServerMessageSchema,
	InteractionUpdateSchema,
	ReadArgsSchema,
	TextDeltaUpdateSchema,
	TurnEndedUpdateSchema,
} from "@oh-my-pi/pi-catalog/discovery/cursor-proto";
import { create, fromBinary, toBinary } from "@oh-my-pi/pi-catalog/discovery/protobuf";
import { stream } from "../src/stream";
import type { AssistantMessage, FetchImpl, Model } from "../src/types";
import type { AssistantMessageEventStream } from "../src/utils/event-stream";

/**
 * Round 3 of the PR #17399 review (R3-4): over Cursor's HTTP/1 transport each
 * client frame is its own BidiAppend request, and each one waits on the
 * caller's dispatch hold. A pause that lands while a tool runs parks the
 * tool's result there. The server cannot answer a result it never received,
 * so the silence that follows is ours, yet the stream watchdog read it as a
 * provider stall and failed a healthy turn. Heartbeats take the same path,
 * and they must stay unable to keep a silent provider alive.
 *
 * Fake timers (Bun fakes `setTimeout`, `setInterval` and `Date`) drive the
 * watchdog and the 5 s heartbeat; the real `setImmediate` lets the async
 * chains between them run.
 */

const realSetImmediate = globalThis.setImmediate;
const BUDGET_MS = 1_000;

/** Lets every pending async chain run to its next timer or I/O wait. */
async function settle(): Promise<void> {
	for (let round = 0; round < 25; round++) {
		const { promise, resolve } = Promise.withResolvers<void>();
		realSetImmediate(resolve);
		await promise;
	}
}

/**
 * Lets the async chains run, without moving the fake clock, until `ready`
 * holds. A cold module load takes real time that `settle` alone does not
 * wait out, and advancing the clock before the turn has started tests nothing.
 */
async function settleUntil(ready: () => boolean): Promise<void> {
	const deadline = Bun.nanoseconds() + 5e9;
	while (!ready() && Bun.nanoseconds() < deadline) await settle();
	expect(ready()).toBe(true);
}

/** A `/pause` gate: while closed, every hold parks until it opens. */
function pauseGate() {
	let gate: PromiseWithResolvers<void> | undefined;
	let parks = 0;
	return {
		hold: (): Promise<void> | undefined => {
			if (!gate) return undefined;
			parks++;
			return gate.promise;
		},
		close: () => {
			gate ??= Promise.withResolvers<void>();
		},
		open: () => {
			gate?.resolve();
			gate = undefined;
		},
		get parks() {
			return parks;
		},
	};
}

function frame(message: AgentServerMessage["message"]): Uint8Array {
	const data = toBinary(AgentServerMessageSchema, create(AgentServerMessageSchema, { message }));
	const out = new Uint8Array(5 + data.length);
	new DataView(out.buffer).setUint32(1, data.length, false);
	out.set(data, 5);
	return out;
}

const textDelta = (text: string) =>
	frame({
		case: "interactionUpdate",
		value: create(InteractionUpdateSchema, {
			message: { case: "textDelta", value: create(TextDeltaUpdateSchema, { text }) },
		}),
	});

const turnEnded = () =>
	frame({
		case: "interactionUpdate",
		value: create(InteractionUpdateSchema, {
			message: { case: "turnEnded", value: create(TurnEndedUpdateSchema, {}) },
		}),
	});

const readRequest = () =>
	frame({
		case: "execServerMessage",
		value: create(ExecServerMessageSchema, {
			id: 1,
			execId: "exec-held",
			message: {
				case: "readArgs",
				value: create(ReadArgsSchema, { path: "/tmp/fixture", toolCallId: "call-read" }),
			},
		}),
	});

const model: Model<"cursor-agent"> = buildModel({
	id: "cursor-pause-fixture",
	name: "Cursor pause fixture",
	api: "cursor-agent",
	provider: "cursor",
	baseUrl: "http://cursor.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 1_000,
});

/**
 * A Cursor server behind HTTP/1: RunSSE streams what `onAppend` enqueues, and
 * every BidiAppend that reaches the wire is recorded by the case it carries.
 */
function cursorServer(
	onAppend: (messageCase: string, controller: ReadableStreamDefaultController<Uint8Array>) => void,
): { fetch: FetchImpl; wire: string[] } {
	const wire: string[] = [];
	let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
	const fetch: FetchImpl = async (input, init) => {
		const signal = init?.signal;
		if (String(input).endsWith("/RunSSE")) {
			return new Response(
				new ReadableStream<Uint8Array>({
					start(c) {
						controller = c;
						signal?.addEventListener("abort", () => c.error(signal.reason), { once: true });
					},
				}),
			);
		}
		const append = fromBinary(BidiAppendRequestSchema, init?.body as Uint8Array);
		const messageCase = fromBinary(AgentClientMessageSchema, append.dataBinary).message.case ?? "";
		wire.push(messageCase);
		if (controller) onAppend(messageCase, controller);
		return new Response(null, { status: 200 });
	};
	return { fetch, wire };
}

function track(response: AssistantMessageEventStream) {
	let settled: AssistantMessage | undefined;
	void response.result().then(message => {
		settled = message;
	});
	return {
		get settled() {
			return settled;
		},
	};
}

describe("Cursor HTTP/1: a pause holding an append", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("does not read a held tool result as a provider stall, and finishes the turn on resume", async () => {
		const pause = pauseGate();
		const server = cursorServer((messageCase, controller) => {
			if (messageCase === "runRequest") {
				controller.enqueue(textDelta("Reading"));
				controller.enqueue(readRequest());
			} else if (messageCase === "execClientMessage") {
				controller.enqueue(turnEnded());
				controller.close();
			}
		});
		const tracked = track(
			stream(
				model,
				{ messages: [{ role: "user", content: "read it", timestamp: 0 }] },
				{
					apiKey: "fake",
					transport: "http1",
					streamFirstEventTimeoutMs: BUDGET_MS,
					streamIdleTimeoutMs: BUDGET_MS,
					fetch: server.fetch,
					beforeDispatch: pause.hold,
					execHandlers: {
						async read(args) {
							// The pause lands while the tool runs, so its result is the
							// first thing the gate holds.
							pause.close();
							return {
								role: "toolResult",
								toolCallId: args.toolCallId,
								toolName: "read",
								content: [{ type: "text", text: "contents" }],
								isError: false,
								timestamp: 0,
							};
						},
					},
				},
			),
		);

		// The tool ran and its result is parked at the hold.
		await settleUntil(() => pause.parks === 1);
		// Thirty idle budgets, six heartbeat periods.
		for (let step = 0; step < 30; step++) {
			vi.advanceTimersByTime(BUDGET_MS);
			await settle();
		}
		expect(tracked.settled).toBeUndefined();
		expect(server.wire).toEqual(["runRequest"]);
		// The result, and one heartbeat: later heartbeats are not queued behind it.
		expect(pause.parks).toBe(2);

		pause.open();
		for (let step = 0; step < 5 && !tracked.settled; step++) {
			vi.advanceTimersByTime(10);
			await settle();
		}
		expect(tracked.settled?.stopReason).toBe("stop");
		expect(tracked.settled?.errorMessage).toBeUndefined();
		expect(server.wire.filter(messageCase => messageCase !== "clientHeartbeat")).toEqual([
			"runRequest",
			"execClientMessage",
		]);
		expect(server.wire.filter(messageCase => messageCase === "clientHeartbeat")).toHaveLength(1);
	});

	for (const paused of [false, true]) {
		it(`still times out a silent provider that only gets heartbeats${paused ? ", held by a pause" : ""}`, async () => {
			// An idle budget long enough for two heartbeats to fall inside it: if
			// either restarted the watchdog, the stall would be caught only after
			// the second heartbeat plus a whole budget.
			const idleMs = 12_000;
			const pause = pauseGate();
			const server = cursorServer((messageCase, controller) => {
				if (messageCase !== "runRequest") return;
				controller.enqueue(textDelta("Thinking"));
				if (paused) pause.close();
			});
			const tracked = track(
				stream(
					model,
					{ messages: [{ role: "user", content: "hello", timestamp: 0 }] },
					{
						apiKey: "fake",
						transport: "http1",
						streamFirstEventTimeoutMs: idleMs,
						streamIdleTimeoutMs: idleMs,
						fetch: server.fetch,
						beforeDispatch: pause.hold,
					},
				),
			);
			await settleUntil(() => server.wire.length === 1);
			let elapsedMs = 0;
			while (!tracked.settled && elapsedMs < 3 * idleMs) {
				vi.advanceTimersByTime(BUDGET_MS);
				elapsedMs += BUDGET_MS;
				await settle();
			}
			pause.open();

			expect(tracked.settled?.stopReason).toBe("error");
			expect(tracked.settled?.errorMessage).toContain("stalled");
			expect(elapsedMs).toBeLessThanOrEqual(idleMs + BUDGET_MS);
			if (paused) {
				expect(pause.parks).toBe(1);
				expect(server.wire).toEqual(["runRequest"]);
			} else {
				expect(server.wire).toEqual(["runRequest", "clientHeartbeat", "clientHeartbeat"]);
			}
		});
	}
});
