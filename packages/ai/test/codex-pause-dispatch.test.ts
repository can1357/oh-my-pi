/**
 * The Codex websocket's traffic beyond `response.create` and the dispatch hold
 * (`StreamOptions.beforeDispatch`, omp's `/pause`). A live `response.steer`
 * carries new user input and can make the server start a successor response,
 * so it is held like a request; reading a successor the server already started
 * sends nothing and is not. Every socket the transport opens passes a hold
 * immediately before it, including one opened after waiting on another
 * caller's handshake, and a cancellation during that wait opens nothing.
 *
 * A hold that carries a probe (`DispatchHold.isClosed`) is read in the same
 * synchronous step as each of those sends, so a gate that closes in the
 * microtasks after the hold answered still stops it. The raw-stream observer
 * (`onSseEvent`) hears of each frame only once the socket has taken it, so
 * caller code it runs can neither close the gate on a frame it is told about
 * nor hear of one that never went out. The DeviceCheck attestation a
 * handshake or an SSE request carries is minted after the wait, so a pause
 * cannot leave a stale one on the wire.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { setCodexAttestationProvider } from "@oh-my-pi/pi-ai/providers/openai-codex-attestation";
import { prewarmOpenAICodexResponses } from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import { streamSimple } from "@oh-my-pi/pi-ai/stream";
import type {
	AssistantMessage,
	FetchImpl,
	LiveSteerClaim,
	LiveSteering,
	Model,
	ProviderSessionState,
	RawSseEvent,
	UserMessage,
} from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import * as piUtils from "@oh-my-pi/pi-utils";
import { PROBE_MAX_DEPTH, ProbedGate, resumeUntilSettled } from "./helpers/probed-gate";

const { getAgentDir, setAgentDir, TempDir } = piUtils;
const originalAgentDir = getAgentDir();
const originalWebSocket = global.WebSocket;
const USAGE = { input_tokens: 5, output_tokens: 3, total_tokens: 8, input_tokens_details: { cached_tokens: 0 } };
const SYSTEM = ["You are a helpful assistant."];

type Frame = Record<string, unknown>;

/** What happened, with the gate and the request's cancellation as they stood at that moment. */
interface Observed {
	event: string;
	paused: boolean;
	aborted: boolean;
}

/** `/pause` in miniature: the hold parks every request until resume, as `agentPauseGate` does. */
class PauseGate {
	#gate: PromiseWithResolvers<void> | undefined;

	get paused(): boolean {
		return this.#gate !== undefined;
	}

	pause(): void {
		this.#gate ??= Promise.withResolvers<void>();
	}

	resume(): void {
		this.#gate?.resolve();
		this.#gate = undefined;
	}

	/** Installed as `beforeDispatch`. */
	hold = (): Promise<void> | void => this.#gate?.promise;
}

/** Scripted Responses WebSocket. `connect` decides whether the handshake completes on its own. */
class FakeSocket {
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSING = 2;
	static readonly CLOSED = 3;
	static instances: FakeSocket[] = [];
	static sent: Frame[] = [];
	static script: {
		connect?: (socket: FakeSocket, index: number) => void;
		frame?: (frame: Frame, socket: FakeSocket) => void;
		/** True when the socket refuses `frame`: `send` throws and the frame never reaches the wire. */
		refuse?: (frame: Frame, socket: FakeSocket) => boolean;
		close?: (reason: string | undefined) => void;
	} = {};

	readyState = FakeSocket.CONNECTING;
	binaryType = "nodebuffer";
	onopen: ((event: Event) => void) | null = null;
	onmessage: ((event: MessageEvent) => void) | null = null;
	onerror: ((event: Event) => void) | null = null;
	onclose: ((event: CloseEvent) => void) | null = null;
	/** The handshake headers the transport opened this socket with. */
	headers: Record<string, string>;

	constructor(_url?: string, options?: { headers?: Record<string, string> }) {
		this.headers = options?.headers ?? {};
		FakeSocket.instances.push(this);
		const script = FakeSocket.script.connect;
		if (script) script(this, FakeSocket.instances.length);
		else this.open();
	}

	open(): void {
		queueMicrotask(() => {
			this.readyState = FakeSocket.OPEN;
			this.onopen?.(new Event("open"));
		});
	}

	/** The handshake fails before the socket opens. */
	failHandshake(): void {
		this.readyState = FakeSocket.CLOSED;
		this.onclose?.({ code: 1006, reason: "handshake failed" } as CloseEvent);
	}

	send(data: string): void {
		const frame = JSON.parse(data) as Frame;
		if (FakeSocket.script.refuse?.(frame, this)) throw new Error(`socket refused ${String(frame.type)}`);
		FakeSocket.sent.push(frame);
		FakeSocket.script.frame?.(frame, this);
	}

	close(_code?: number, reason?: string): void {
		this.readyState = FakeSocket.CLOSED;
		FakeSocket.script.close?.(reason);
	}

	/** Deliver server frames asynchronously, in order. */
	emit(...frames: Frame[]): void {
		queueMicrotask(() => {
			for (const frame of frames) this.onmessage?.({ data: JSON.stringify(frame) } as MessageEvent);
		});
	}
}

function installSocket(script: typeof FakeSocket.script): void {
	FakeSocket.instances = [];
	FakeSocket.sent = [];
	FakeSocket.script = script;
	global.WebSocket = FakeSocket as unknown as typeof WebSocket;
}

/**
 * One macrotask turn. Every send these tests guard against follows its trigger
 * through microtasks alone, so a defect has shown itself by the next turn.
 */
function nextTurn(): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setImmediate(resolve);
	return promise;
}

function createModel(): Model<"openai-codex-responses"> {
	return buildModel({
		id: "gpt-6-sol",
		name: "GPT-6 Sol",
		api: "openai-codex-responses",
		provider: "openai-codex",
		baseUrl: "https://chatgpt.com/backend-api",
		reasoning: true,
		preferWebsockets: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 272000,
		maxTokens: 128000,
	});
}

function createToken(): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
		"utf8",
	).toBase64();
	return `aaa.${payload}.bbb`;
}

function messageFrames(itemId: string, text: string): Frame[] {
	const item = { type: "message", id: itemId, role: "assistant", content: [{ type: "output_text", text }] };
	return [
		{ type: "response.output_item.added", item: { ...item, status: "in_progress", content: [] } },
		{ type: "response.output_text.delta", item_id: itemId, delta: text },
		{ type: "response.output_item.done", item: { ...item, status: "completed" } },
	];
}

function completedFrames(id: string, text: string): Frame[] {
	return [
		{ type: "response.created", response: { id } },
		...messageFrames(`msg_${id}`, text),
		{ type: "response.completed", response: { id, status: "completed", usage: USAGE } },
	];
}

/** The server's side of an accepted steer: the steered response ends and a successor starts on its own. */
function steeredFrames(): Frame[] {
	return [
		{ type: "response.steer.accepted", steer: { id: "steer_1", previous_response_id: "resp_1" } },
		{
			type: "response.incomplete",
			response: { id: "resp_1", status: "incomplete", incomplete_details: { reason: "steered" }, usage: USAGE },
		},
		...completedFrames("resp_2", "Tabs it is"),
	];
}

function untilAborted(signal: AbortSignal): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	if (signal.aborted) resolve();
	else signal.addEventListener("abort", () => resolve(), { once: true });
	return promise;
}

/** Steering the user types while a response streams: nothing is queued until `queue()`. */
function typedSteering(text: string, observe: (event: string) => void) {
	const queued = Promise.withResolvers<void>();
	let claimed = false;
	let outcome: "accepted" | "rejected" | undefined;
	const source: LiveSteering = {
		wait: signal => (claimed ? untilAborted(signal) : Promise.race([queued.promise, untilAborted(signal)])),
		claim: async (): Promise<LiveSteerClaim | undefined> => {
			if (claimed) return undefined;
			claimed = true;
			observe("claim");
			return {
				messages: [{ role: "user", content: text, timestamp: Date.now() }],
				accept: () => {
					outcome = "accepted";
				},
				reject: () => {
					outcome = "rejected";
				},
			};
		},
	};
	return { source, queue: () => queued.resolve(), claimed: () => claimed, settled: () => outcome };
}

let gate: PauseGate;
let controller: AbortController;
let observed: Observed[];
let sessions: Map<string, ProviderSessionState>;

function observe(event: string): void {
	observed.push({ event, paused: gate.paused, aborted: controller.signal.aborted });
}

function requestOptions(liveSteering?: LiveSteering) {
	return {
		apiKey: createToken(),
		sessionId: "codex-pause-dispatch",
		providerSessionState: sessions,
		signal: controller.signal,
		beforeDispatch: gate.hold,
		liveSteering,
		fetch: vi.fn(async () => {
			throw new Error("SSE fallback should not run");
		}) as FetchImpl,
	};
}

function request(messages: (UserMessage | AssistantMessage)[], liveSteering?: LiveSteering) {
	return streamSimple(createModel(), { systemPrompt: SYSTEM, messages }, requestOptions(liveSteering)).result();
}

/** A raw-stream observer (`onSseEvent`) that hands each outbound websocket frame it hears of to `heard`. */
function outboundObserver(heard: (type: string | null) => void): (event: RawSseEvent) => void {
	return event => {
		if (event.raw[0]?.startsWith(": ws →")) heard(event.event);
	};
}

const user: UserMessage = { role: "user", content: "Draft a plan", timestamp: 0 };

beforeEach(() => {
	setAgentDir(TempDir.createSync("@pi-codex-pause-").path());
	vi.spyOn(piUtils, "getInstallId").mockReturnValue("00000000-0000-4000-8000-000000000001");
	gate = new PauseGate();
	controller = new AbortController();
	observed = [];
	sessions = new Map();
});

afterEach(() => {
	gate.resume();
	for (const state of sessions.values()) state.close?.();
	setCodexAttestationProvider(undefined);
	global.WebSocket = originalWebSocket;
	setAgentDir(originalAgentDir);
	vi.restoreAllMocks();
});

describe("Codex live steering under a dispatch hold", () => {
	function scriptSteeredSocket(created: PromiseWithResolvers<void>): void {
		installSocket({
			frame: (frame, socket) => {
				observe(`send:${frame.type}`);
				if (frame.type === "response.create") {
					// Part of an answer streams; the response keeps running.
					socket.emit({ type: "response.created", response: { id: "resp_1" } }, ...messageFrames("msg_1", "Plan"));
					created.resolve();
					return;
				}
				observe("server-start:resp_2");
				socket.emit(...steeredFrames());
			},
		});
	}

	// A steer typed while the process was paused went out at once, and the
	// server started a successor response from it during the pause:
	// create(paused=false), pause, steer(paused=true), server-start(paused=true).
	it("holds a steer typed during a pause until resume, leaving it queued meanwhile", async () => {
		const created = Promise.withResolvers<void>();
		scriptSteeredSocket(created);
		const steering = typedSteering("use tabs", observe);

		const first = request([user], steering.source);
		await created.promise;
		await nextTurn();
		gate.pause();
		observe("pause");
		steering.queue();
		await nextTurn();
		observe("resume");
		gate.resume();
		const message = await first;

		expect(observed).toEqual([
			{ event: "send:response.create", paused: false, aborted: false },
			{ event: "pause", paused: true, aborted: false },
			{ event: "resume", paused: true, aborted: false },
			{ event: "claim", paused: false, aborted: false },
			{ event: "send:response.steer", paused: false, aborted: false },
			{ event: "server-start:resp_2", paused: false, aborted: false },
		]);
		expect(steering.settled()).toBe("accepted");
		expect(message.stopReason).toBe("stop");
	});

	// The held steer must not outlive the request: cancelling it ends the turn
	// without the steer, and the input stays with the caller.
	it("ends a held steer when the request is cancelled, without submitting it", async () => {
		const created = Promise.withResolvers<void>();
		scriptSteeredSocket(created);
		const steering = typedSteering("use tabs", observe);

		const first = request([user], steering.source);
		await created.promise;
		await nextTurn();
		gate.pause();
		observe("pause");
		steering.queue();
		await nextTurn();
		controller.abort(new Error("cancelled while paused"));
		observe("abort");
		const message = await first;

		expect(message.stopReason).toBe("aborted");
		expect(FakeSocket.sent.filter(frame => frame.type === "response.steer")).toEqual([]);
		expect(steering.claimed()).toBe(false);
		expect(observed).toEqual([
			{ event: "send:response.create", paused: false, aborted: false },
			{ event: "pause", paused: true, aborted: false },
			{ event: "abort", paused: true, aborted: true },
		]);
	});
});

describe("Codex websocket connects under a dispatch hold", () => {
	/**
	 * A prewarm owns the first handshake and leaves it pending; the request
	 * joins it. Resolves once the request is waiting on that handshake.
	 */
	async function joinPrewarmHandshake(): Promise<{ result: Promise<AssistantMessage>; prewarm: Promise<void> }> {
		installSocket({
			connect: (socket, index) => {
				observe(`connect:${index}`);
				if (index > 1) socket.open();
			},
			frame: (frame, socket) => {
				observe(`send:${frame.type}`);
				socket.emit(...completedFrames("resp_1", "Hi"));
			},
		});
		// A request that joins a handshake another caller started marks it with
		// `codexWs:awaitSharedHandshake` and waits on it in the same step. Its
		// attestation is minted only for a socket it opens itself, so it marks
		// nothing earlier.
		const joined = Promise.withResolvers<void>();
		const time = piUtils.logger.time as (op: string, ...rest: unknown[]) => unknown;
		vi.spyOn(piUtils.logger, "time").mockImplementation(((op: string, ...rest: unknown[]) => {
			if (op === "codexWs:awaitSharedHandshake") joined.resolve();
			return time(op, ...rest);
		}) as unknown as typeof piUtils.logger.time);
		const model = createModel();
		const prewarm = prewarmOpenAICodexResponses(model, {
			apiKey: createToken(),
			sessionId: "codex-pause-dispatch",
			providerSessionState: sessions,
		}).catch(() => {});
		while (FakeSocket.instances.length === 0) await nextTurn();
		const result = request([user]);
		await joined.promise;
		return { result, prewarm };
	}

	// The connect hold sat before the join, so the replacement socket opened
	// when the shared handshake failed went out mid-pause:
	// connect:1(paused=false), pause, connect:2(paused=true).
	it("holds the socket a request opens after the handshake it joined fails", async () => {
		const { result, prewarm } = await joinPrewarmHandshake();
		gate.pause();
		observe("pause");
		FakeSocket.instances[0]!.failHandshake();
		await nextTurn();
		observe("resume");
		gate.resume();
		const message = await result;
		await prewarm;

		expect(observed).toEqual([
			{ event: "connect:1", paused: false, aborted: false },
			{ event: "pause", paused: true, aborted: false },
			{ event: "resume", paused: true, aborted: false },
			{ event: "connect:2", paused: false, aborted: false },
			{ event: "send:response.create", paused: false, aborted: false },
		]);
		expect(message.stopReason).toBe("stop");
	});

	// A cancellation while waiting on another caller's handshake was ignored,
	// and the request opened a socket of its own once that handshake failed:
	// connect:1(aborted=false), abort, connect:2(aborted=true).
	it("fails a request cancelled while it waits on another caller's handshake, opening nothing", async () => {
		const { result, prewarm } = await joinPrewarmHandshake();
		controller.abort(new Error("cancelled while joining"));
		observe("abort");
		const message = await result;
		FakeSocket.instances[0]!.failHandshake();
		await prewarm;
		await nextTurn();

		expect(message.stopReason).toBe("aborted");
		expect(observed).toEqual([
			{ event: "connect:1", paused: false, aborted: false },
			{ event: "abort", paused: false, aborted: true },
		]);
	});

	it("fails a request cancelled while its reconnect is held, opening nothing", async () => {
		const { result, prewarm } = await joinPrewarmHandshake();
		gate.pause();
		observe("pause");
		FakeSocket.instances[0]!.failHandshake();
		await nextTurn();
		controller.abort(new Error("cancelled while paused"));
		observe("abort");
		const message = await result;
		gate.resume();
		await prewarm;
		await nextTurn();

		expect(message.stopReason).toBe("aborted");
		expect(observed).toEqual([
			{ event: "connect:1", paused: false, aborted: false },
			{ event: "pause", paused: true, aborted: false },
			{ event: "abort", paused: true, aborted: true },
		]);
	});

	// Steering the next request cannot line up with drops the socket and opens
	// another. That connect is traffic of its own and passes a hold too.
	it("holds the socket opened after discarding a steered one", async () => {
		const created = Promise.withResolvers<void>();
		const discarded = Promise.withResolvers<void>();
		installSocket({
			connect: (socket, index) => {
				observe(`connect:${index}`);
				socket.open();
			},
			frame: (frame, socket) => {
				observe(`send:${frame.type}`);
				if (frame.type === "response.steer") {
					socket.emit(...steeredFrames());
				} else if (FakeSocket.instances.length === 1) {
					socket.emit({ type: "response.created", response: { id: "resp_1" } }, ...messageFrames("msg_1", "Plan"));
					created.resolve();
				} else {
					socket.emit(...completedFrames("resp_3", "Done"));
				}
			},
			close: reason => {
				if (reason !== "steering-discard") return;
				// The pause lands as the steered socket is dropped.
				gate.pause();
				observe("pause");
				discarded.resolve();
			},
		});
		const steering = typedSteering("use tabs", observe);
		const firstRequest = request([user], steering.source);
		await created.promise;
		await nextTurn();
		steering.queue();
		const first = await firstRequest;
		expect(steering.settled()).toBe("accepted");
		observed.length = 0;

		const steerMessage: UserMessage = { role: "user", content: "use tabs", timestamp: 1 };
		const extra: UserMessage = { role: "user", content: "and spaces in YAML", timestamp: 2 };
		const second = request([user, first, steerMessage, extra]);
		await discarded.promise;
		await nextTurn();
		observe("resume");
		gate.resume();
		const message = await second;

		expect(observed).toEqual([
			{ event: "pause", paused: true, aborted: false },
			{ event: "resume", paused: true, aborted: false },
			{ event: "connect:2", paused: false, aborted: false },
			{ event: "send:response.create", paused: false, aborted: false },
		]);
		expect(message.stopReason).toBe("stop");
	});

	// A session does not prewarm while paused: its prewarm hold rejects rather
	// than wait. That fails the attempt before any socket exists and leaves
	// nothing behind for the next request to clean up.
	it("opens no socket for a prewarm whose hold rejects", async () => {
		installSocket({
			connect: (socket, index) => {
				observe(`connect:${index}`);
				socket.open();
			},
			frame: (frame, socket) => {
				observe(`send:${frame.type}`);
				socket.emit(...completedFrames("resp_1", "Hi"));
			},
		});
		gate.pause();
		const prewarm = prewarmOpenAICodexResponses(createModel(), {
			apiKey: createToken(),
			sessionId: "codex-pause-dispatch",
			providerSessionState: sessions,
			beforeDispatch: () => {
				if (gate.paused) throw new Error("connection prewarm skipped while paused");
			},
		});
		await expect(prewarm).rejects.toThrow("connection prewarm skipped while paused");
		gate.resume();
		const message = await request([user]);

		expect(message.stopReason).toBe("stop");
		expect(observed).toEqual([
			{ event: "connect:1", paused: false, aborted: false },
			{ event: "send:response.create", paused: false, aborted: false },
		]);
	});
});

function resetSessions(): void {
	for (const state of sessions.values()) state.close?.();
	sessions = new Map();
}

describe("Codex sends nothing while a probed gate reads closed", () => {
	// The hold was awaited and `response.create` sent a few microtasks later,
	// so a pause landing in between was never seen and the frame went out
	// under it.
	it("holds response.create when the gate closes after the hold answered", async () => {
		const sentWhileClosed: number[] = [];
		const heldAt: number[] = [];
		for (let depth = 1; depth <= PROBE_MAX_DEPTH; depth++) {
			resetSessions();
			const probe = new ProbedGate();
			let sent = false;
			const told: unknown[] = [];
			installSocket({
				frame: (frame, socket) => {
					if (frame.type !== "response.create") return;
					sent = true;
					if (probe.closed) sentWhileClosed.push(depth);
					socket.emit(...completedFrames("resp_1", "Hi"));
				},
			});
			// The socket is open only for the hold right before `response.create`.
			const hold = probe.holdClosingAfter(depth, () =>
				FakeSocket.instances.some(socket => socket.readyState === FakeSocket.OPEN),
			);
			const result = streamSimple(
				createModel(),
				{ systemPrompt: SYSTEM, messages: [user] },
				{ ...requestOptions(), beforeDispatch: hold, onSseEvent: outboundObserver(type => told.push(type)) },
			).result();
			const message = await resumeUntilSettled(
				result,
				probe,
				() => !sent,
				() => heldAt.push(depth),
			);
			expect(message.stopReason).toBe("stop");
			// However many rounds the barrier went, the observer heard of the one frame that went out.
			expect(told).toEqual(FakeSocket.sent.map(frame => frame.type));
		}

		expect(sentWhileClosed).toEqual([]);
		// Not vacuous: some depth closed the gate before the send and was held.
		expect(heldAt.length).toBeGreaterThan(0);
	});

	// The connect hold was awaited and the socket constructed afterwards, so a
	// pause landing in between opened a connection under it.
	it("opens no socket when the gate closes after the connect hold answered", async () => {
		const openedWhileClosed: number[] = [];
		const heldAt: number[] = [];
		for (let depth = 1; depth <= PROBE_MAX_DEPTH; depth++) {
			resetSessions();
			const probe = new ProbedGate();
			installSocket({
				connect: socket => {
					if (probe.closed) openedWhileClosed.push(depth);
					socket.open();
				},
			});
			// A prewarm asks the hold once, right before the socket it opens.
			const prewarm = prewarmOpenAICodexResponses(createModel(), {
				apiKey: createToken(),
				sessionId: "codex-pause-dispatch",
				providerSessionState: sessions,
				beforeDispatch: probe.holdClosingAfter(depth, () => true),
			});
			await resumeUntilSettled(
				prewarm,
				probe,
				() => FakeSocket.instances.length === 0,
				() => heldAt.push(depth),
			);
			expect(FakeSocket.instances).toHaveLength(1);
		}

		expect(openedWhileClosed).toEqual([]);
		expect(heldAt.length).toBeGreaterThan(0);
	});

	// The steering pump awaited the hold and submitted the steer afterwards, so
	// a pause landing in between put new user input on the wire under it.
	it("holds response.steer when the gate closes after the hold answered", async () => {
		const sentWhileClosed: number[] = [];
		const heldAt: number[] = [];
		for (let depth = 1; depth <= PROBE_MAX_DEPTH; depth++) {
			resetSessions();
			const probe = new ProbedGate();
			const created = Promise.withResolvers<void>();
			let sent = false;
			const told: unknown[] = [];
			installSocket({
				frame: (frame, socket) => {
					if (frame.type === "response.create") {
						socket.emit(
							{ type: "response.created", response: { id: "resp_1" } },
							...messageFrames("msg_1", "Plan"),
						);
						created.resolve();
						return;
					}
					sent = true;
					if (probe.closed) sentWhileClosed.push(depth);
					socket.emit(...steeredFrames());
				},
			});
			const steering = typedSteering("use tabs", () => {});
			// Claimed, the input is ready: the next hold is the steer's last one.
			const hold = probe.holdClosingAfter(depth, () => steering.claimed());
			const result = streamSimple(
				createModel(),
				{ systemPrompt: SYSTEM, messages: [user] },
				{
					...requestOptions(steering.source),
					beforeDispatch: hold,
					onSseEvent: outboundObserver(type => told.push(type)),
				},
			).result();
			await created.promise;
			await nextTurn();
			steering.queue();
			const message = await resumeUntilSettled(
				result,
				probe,
				() => !sent,
				() => heldAt.push(depth),
			);
			expect(message.stopReason).toBe("stop");
			expect(steering.settled()).toBe("accepted");
			expect(told).toEqual(FakeSocket.sent.map(frame => frame.type));
		}

		expect(sentWhileClosed).toEqual([]);
		expect(heldAt.length).toBeGreaterThan(0);
	});
});

/**
 * The raw-stream observer is caller code. Told of a frame inside the step that
 * reads the gate and sends, before the send, it could close the gate on a
 * frame that then went out anyway, and it heard of frames the socket refused.
 * Each case logs `wire:<type>` as the socket takes a frame and `told:<type>`
 * as the observer hears of one, with the gate as it stood then.
 */
describe("Codex tells the raw-stream observer of a frame only once it is on the wire", () => {
	let probe: ProbedGate;
	let log: { event: string; closed: boolean }[];

	beforeEach(() => {
		probe = new ProbedGate();
		log = [];
	});

	function record(event: string): void {
		log.push({ event, closed: probe.closed });
	}

	/** Logs each outbound frame the observer hears of, and closes the gate on hearing of `pauseOn`. */
	function pausingObserver(pauseOn?: string): (event: RawSseEvent) => void {
		return outboundObserver(type => {
			record(`told:${type}`);
			if (type === pauseOn) probe.close();
		});
	}

	function startStreaming(onSseEvent: (event: RawSseEvent) => void, liveSteering?: LiveSteering) {
		return streamSimple(
			createModel(),
			{ systemPrompt: SYSTEM, messages: [user] },
			{ ...requestOptions(liveSteering), beforeDispatch: probe.hold, onSseEvent },
		).result();
	}

	/** A socket whose first response streams until the steer it is waiting for. */
	function scriptSteerableSocket(
		created: PromiseWithResolvers<void>,
		refuse?: (frame: Frame, socket: FakeSocket) => boolean,
	): void {
		installSocket({
			refuse,
			frame: (frame, socket) => {
				record(`wire:${frame.type}`);
				if (frame.type === "response.create") {
					socket.emit({ type: "response.created", response: { id: "resp_1" } }, ...messageFrames("msg_1", "Plan"));
					created.resolve();
					return;
				}
				socket.emit(...steeredFrames());
			},
		});
	}

	// The observer heard of `response.create` before the socket took it, and
	// the pause it engaged from there did not stop the frame:
	// told(closed=false), wire(closed=true).
	it("sends response.create before an observer that pauses on it hears of it", async () => {
		installSocket({
			frame: (frame, socket) => {
				record(`wire:${frame.type}`);
				socket.emit(...completedFrames("resp_1", "Hi"));
			},
		});
		const result = startStreaming(pausingObserver("response.create"));
		const message = await resumeUntilSettled(
			result,
			probe,
			() => false,
			() => {},
		);

		expect(log).toEqual([
			{ event: "wire:response.create", closed: false },
			{ event: "told:response.create", closed: false },
		]);
		expect(message.stopReason).toBe("stop");
	});

	// The same for the steer: told(closed=false), wire(closed=true), and the
	// server accepted input sent under a closed gate.
	it("sends response.steer before an observer that pauses on it hears of it", async () => {
		const created = Promise.withResolvers<void>();
		scriptSteerableSocket(created);
		const steering = typedSteering("use tabs", () => {});
		const result = startStreaming(pausingObserver("response.steer"), steering.source);
		await created.promise;
		await nextTurn();
		steering.queue();
		const message = await resumeUntilSettled(
			result,
			probe,
			() => false,
			() => {},
		);

		expect(log).toEqual([
			{ event: "wire:response.create", closed: false },
			{ event: "told:response.create", closed: false },
			{ event: "wire:response.steer", closed: false },
			{ event: "told:response.steer", closed: false },
		]);
		expect(steering.settled()).toBe("accepted");
		expect(message.stopReason).toBe("stop");
	});

	// The observer heard of the refused first attempt as if it had gone out:
	// told, then the retry's wire and told.
	it("tells the observer nothing of a response.create the socket refused", async () => {
		let refusals = 0;
		installSocket({
			refuse: frame => frame.type === "response.create" && refusals++ === 0,
			frame: (frame, socket) => {
				record(`wire:${frame.type}`);
				socket.emit(...completedFrames("resp_1", "Hi"));
			},
		});
		const message = await startStreaming(pausingObserver());

		expect(refusals).toBe(2);
		expect(log).toEqual([
			{ event: "wire:response.create", closed: false },
			{ event: "told:response.create", closed: false },
		]);
		expect(message.stopReason).toBe("stop");
	});

	// The observer heard of a steer the socket refused, which the server never
	// saw: told:response.steer with no wire before it.
	it("tells the observer nothing of a response.steer the socket refused", async () => {
		const created = Promise.withResolvers<void>();
		scriptSteerableSocket(created, (frame, socket) => {
			if (frame.type !== "response.steer") return false;
			// The response the steer was meant for runs to its end without it.
			socket.emit({ type: "response.completed", response: { id: "resp_1", status: "completed", usage: USAGE } });
			return true;
		});
		const steering = typedSteering("use tabs", () => {});
		const result = startStreaming(pausingObserver(), steering.source);
		await created.promise;
		await nextTurn();
		steering.queue();
		const message = await result;

		expect(log).toEqual([
			{ event: "wire:response.create", closed: false },
			{ event: "told:response.create", closed: false },
		]);
		expect(steering.settled()).toBe("rejected");
		expect(message.stopReason).toBe("stop");
	});

	// Told after the send, the observer heard a reply the socket delivers
	// within `send` before the frame it answers: ← created, → create.
	it("reports a reply the socket delivers within send after the frame it answers", async () => {
		const timeline: string[] = [];
		const created = Promise.withResolvers<void>();
		installSocket({
			frame: (frame, socket) => {
				const [reply, ...rest] =
					frame.type === "response.create"
						? [{ type: "response.created", response: { id: "resp_1" } }, ...messageFrames("msg_1", "Plan")]
						: steeredFrames();
				socket.onmessage?.({ data: JSON.stringify(reply) } as MessageEvent);
				socket.emit(...rest);
				if (frame.type === "response.create") created.resolve();
			},
		});
		const steering = typedSteering("use tabs", () => {});
		const result = startStreaming(event => timeline.push(event.raw[0]!), steering.source);
		await created.promise;
		await nextTurn();
		steering.queue();
		const message = await result;

		const steer = timeline.indexOf(": ws → response.steer");
		expect(timeline.slice(0, 2)).toEqual([": ws → response.create", ": ws ← response.created"]);
		expect(steer).toBeGreaterThan(1);
		expect(timeline.slice(steer, steer + 2)).toEqual([": ws → response.steer", ": ws ← response.steer.accepted"]);
		expect(steering.settled()).toBe("accepted");
		expect(message.stopReason).toBe("stop");
	});
});

describe("Codex attestation is minted after the dispatch hold", () => {
	/**
	 * Logs each attestation as it is minted, numbered. The first one closes the
	 * gate: the pause lands right after it, so a request that minted before its
	 * hold carries that one through the whole pause.
	 */
	function attestEachMint(probe: ProbedGate, events: string[]): void {
		let mints = 0;
		setCodexAttestationProvider(async () => {
			mints += 1;
			events.push(`mint:attestation-${mints}`);
			if (mints === 1) probe.close();
			return `attestation-${mints}`;
		});
	}

	/** Runs `pending` to the end, logging each resume of the gate the first mint closed. */
	function resumeLogging<T>(pending: Promise<T>, probe: ProbedGate, events: string[]): Promise<T> {
		return resumeUntilSettled(
			pending,
			probe,
			() => true,
			() => events.push("resume"),
		);
	}

	// The attestation was minted with the handshake headers, before the
	// connect hold, and the socket opened after resume carried that one:
	// mint:attestation-1, resume, socket opened with attestation-1.
	it("opens the socket with an attestation minted after the hold", async () => {
		const probe = new ProbedGate();
		const events: string[] = [];
		attestEachMint(probe, events);
		installSocket({
			frame: (frame, socket) => {
				if (frame.type === "response.create") socket.emit(...completedFrames("resp_1", "Hi"));
			},
		});
		const result = streamSimple(
			createModel(),
			{ systemPrompt: SYSTEM, messages: [user] },
			{ ...requestOptions(), beforeDispatch: probe.hold },
		).result();
		const message = await resumeLogging(result, probe, events);

		expect(message.stopReason).toBe("stop");
		expect(FakeSocket.instances).toHaveLength(1);
		const sentWith = FakeSocket.instances[0]!.headers["x-oai-attestation"];
		expect(events).toContain("resume");
		expect(events.indexOf(`mint:${sentWith}`)).toBeGreaterThan(events.lastIndexOf("resume"));
	});

	// The SSE request built its headers, attestation included, before the
	// transport's hold, and the request sent after resume carried that one.
	it("sends the SSE request with an attestation minted after the hold", async () => {
		const probe = new ProbedGate();
		const events: string[] = [];
		attestEachMint(probe, events);
		const sentWith: (string | null)[] = [];
		const fetch: FetchImpl = async (_input, init) => {
			sentWith.push(new Headers(init?.headers).get("x-oai-attestation"));
			return new Response(sseBody(completedFrames("resp_1", "Hi")), {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		};
		const model = buildModel({ ...createModel(), preferWebsockets: false });
		const result = streamSimple(
			model,
			{ systemPrompt: SYSTEM, messages: [user] },
			{ ...requestOptions(), fetch, beforeDispatch: probe.hold },
		).result();
		const message = await resumeLogging(result, probe, events);

		expect(message.stopReason).toBe("stop");
		expect(sentWith).toHaveLength(1);
		expect(events).toContain("resume");
		expect(events.indexOf(`mint:${sentWith[0]}`)).toBeGreaterThan(events.lastIndexOf("resume"));
	});
});

function sseBody(frames: Frame[]): string {
	return frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join("");
}
