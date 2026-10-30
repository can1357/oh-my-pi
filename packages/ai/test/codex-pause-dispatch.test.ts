/**
 * The Codex websocket's traffic beyond `response.create` and the dispatch hold
 * (`StreamOptions.beforeDispatch`, omp's `/pause`). A live `response.steer`
 * carries new user input and can make the server start a successor response,
 * so it is held like a request; reading a successor the server already started
 * sends nothing and is not. Every socket the transport opens passes a hold
 * immediately before it, including one opened after waiting on another
 * caller's handshake, and a cancellation during that wait opens nothing.
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
	UserMessage,
} from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import * as piUtils from "@oh-my-pi/pi-utils";

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
		close?: (reason: string | undefined) => void;
	} = {};

	readyState = FakeSocket.CONNECTING;
	binaryType = "nodebuffer";
	onopen: ((event: Event) => void) | null = null;
	onmessage: ((event: MessageEvent) => void) | null = null;
	onerror: ((event: Event) => void) | null = null;
	onclose: ((event: CloseEvent) => void) | null = null;

	constructor() {
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
		// The request resolves its attestation header immediately before it
		// joins the pending handshake; nothing after that awaits a timer.
		let attestations = 0;
		const requestAttesting = Promise.withResolvers<void>();
		setCodexAttestationProvider(async () => {
			attestations += 1;
			if (attestations === 2) requestAttesting.resolve();
			return undefined;
		});
		const model = createModel();
		const prewarm = prewarmOpenAICodexResponses(model, {
			apiKey: createToken(),
			sessionId: "codex-pause-dispatch",
			providerSessionState: sessions,
		}).catch(() => {});
		while (FakeSocket.instances.length === 0) await nextTurn();
		const result = request([user]);
		await requestAttesting.promise;
		await nextTurn();
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
