/**
 * The dispatch sites in this package: the main loop's own hold, which every
 * main-loop request carries, and the remote-compaction requests, which fetch
 * on their own. Awaiting a hold proves only that it was open when it
 * answered; a gate can close in any microtask between that answer and the
 * send. A site is exact only when it sends in the same synchronous step as
 * the last read of the holds' probes, and a hold is exact only when it has a
 * probe to read. These tests close the gate at each microtask depth after the
 * hold is asked and check that nothing reaches the wire while it reads closed.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { agentLoop, agentPauseGate } from "@oh-my-pi/pi-agent-core";
import {
	buildCompactionV2Request,
	requestCompactionV2Streaming,
	requestOpenAiRemoteCompaction,
	requestRemoteCompaction,
} from "@oh-my-pi/pi-agent-core/compaction/openai";
import type { AgentMessage, StreamFn } from "@oh-my-pi/pi-agent-core/types";
import type { DispatchHold, Message, Model } from "@oh-my-pi/pi-ai";
import { NO_AUTH_SENTINEL } from "@oh-my-pi/pi-ai/auth-retry";
import { clearAwsCredentialCache } from "@oh-my-pi/pi-ai/providers/aws-credentials";
import { setCodexAttestationProvider } from "@oh-my-pi/pi-ai/providers/openai-codex-attestation";
import { dispatchWhenOpen } from "@oh-my-pi/pi-ai/utils/dispatch-hold";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { transportFetch } from "@oh-my-pi/pi-ai/utils/transport-fetch";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { createUserMessage } from "./helpers";

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

/** A gate a test closes and opens; `hold` is what the request's caller hands it. */
interface Gate {
	readonly hold: DispatchHold;
	readonly closed: boolean;
	close(): void;
	open(): void;
}

/** A gate with a probe, as `/pause` builds one: closed, its hold parks until reopened. */
function probedGate(): Gate {
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
 * The process-wide `/pause` gate. The main loop reads it itself, so the
 * caller's hold it is handed is a plain function that holds nothing.
 */
function processGate(): Gate {
	return {
		hold: () => {},
		get closed() {
			return agentPauseGate.paused;
		},
		close: () => {
			agentPauseGate.pause();
		},
		open: () => {
			agentPauseGate.resume();
		},
	};
}

/**
 * Sends one request per depth from 1 to {@link MAX_DEPTH}, each with a fresh
 * gate that closes `depth` microtasks after the caller's hold is first asked.
 * `send` starts the request with that hold, calls `onWire` at the moment the
 * request reaches the wire, and settles once the request has finished.
 * Returns the depths at which the gate closed before the request reached the
 * wire, and those at which the request reached the wire while the gate read
 * closed.
 */
async function closeAtEachDepth(
	makeGate: () => Gate,
	send: (hold: DispatchHold, onWire: () => void) => Promise<unknown>,
): Promise<{ closedFirst: number[]; sentClosed: number[] }> {
	const closedFirst: number[] = [];
	const sentClosed: number[] = [];
	for (let depth = 1; depth <= MAX_DEPTH; depth++) {
		const gate = makeGate();
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
		if (gate.hold.isClosed) hold.isClosed = gate.hold.isClosed;
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

const ENDPOINT = "https://example.invalid/v1/messages";

const model = buildModel({
	id: "dispatch-site-probe",
	name: "Dispatch Site Probe",
	api: "openai-responses",
	provider: "dispatch-site-probe",
	baseUrl: "https://example.invalid/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1_000,
	maxTokens: 100,
}) as Model;

function finished(): AssistantMessageEventStream {
	const events = new AssistantMessageEventStream();
	events.push({
		type: "done",
		reason: "stop",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			timestamp: 0,
			stopReason: "stop",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		},
	});
	return events;
}

function runLoop(beforeDispatch: DispatchHold, streamFn: StreamFn, signal?: AbortSignal) {
	return agentLoop(
		[createUserMessage("hi")],
		{ systemPrompt: ["Test"], messages: [], tools: [] },
		{
			model,
			convertToLlm: (messages: AgentMessage[]) =>
				messages.filter(m => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[],
			beforeDispatch,
		},
		signal,
		streamFn,
	).result();
}

describe("the main loop's dispatch hold", () => {
	afterEach(() => {
		// The gate is process-global: never leak an engaged pause into other files.
		agentPauseGate.resume();
	});

	// The loop's hold was a plain function, so the transport could only await
	// it: a `/pause` that engaged after it answered never stopped the request.
	test("is read at the wire: no request goes out while `/pause` is engaged", async () => {
		const { closedFirst, sentClosed } = await closeAtEachDepth(processGate, (hold, onWire) =>
			runLoop(hold, async (_model, _context, options) => {
				const fetch = transportFetch(
					model,
					async () => {
						onWire();
						return new Response("{}");
					},
					options?.beforeDispatch,
				);
				await fetch(ENDPOINT, { method: "POST", signal: options?.signal });
				return finished();
			}),
		);

		expect(sentClosed).toEqual([]);
		expect(closedFirst.length).toBeGreaterThan(0);
	});

	/** Runs a turn and keeps the hold it handed the provider, and the request's signal. */
	async function captureHold(abort: AbortController): Promise<DispatchHold> {
		let captured: DispatchHold | undefined;
		await runLoop(
			() => {},
			(_model, _context, options) => {
				captured = options?.beforeDispatch;
				return finished();
			},
			abort.signal,
		);
		if (!captured) throw new Error("the loop handed the provider no dispatch hold");
		return captured;
	}

	// Its probe reads the request's signal, so a hold that answered once the
	// request was cancelled would be asked again without end, and one that
	// answered with no probe let the cancelled request go out.
	test("rejects with the request's abort reason when the request was cancelled", async () => {
		const abort = new AbortController();
		const hold = await captureHold(abort);
		const reason = new Error("cancelled before dispatch");
		abort.abort(reason);
		let sent = 0;

		await expect(dispatchWhenOpen(hold, undefined, () => sent++)).rejects.toBe(reason);
		expect(sent).toBe(0);
	});

	test("rejects with the request's abort reason when the request is cancelled while paused", async () => {
		const abort = new AbortController();
		const hold = await captureHold(abort);
		const reason = new Error("cancelled while paused");
		agentPauseGate.pause();
		let sent = 0;

		const pending = dispatchWhenOpen(hold, undefined, () => sent++);
		await loopTurn();
		abort.abort(reason);

		await expect(pending).rejects.toBe(reason);
		expect(sent).toBe(0);
	});
});

const compactionModel = buildModel({
	id: "gpt-5",
	name: "GPT-5",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 400_000,
	maxTokens: 128_000,
	remoteCompaction: {
		enabled: true,
		v2StreamingEnabled: true,
		v2Endpoint: "https://compact.example/v1/responses",
		model: "gpt-5-compact",
	},
}) as Model<"openai-responses">;

const mantleModel = buildModel({
	id: "openai.gpt-6-sol",
	name: "Mantle GPT",
	api: "openai-responses",
	provider: "bedrock-mantle",
	baseUrl: "https://bedrock-mantle.{region}.api.aws/openai/v1",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 400_000,
	maxTokens: 128_000,
}) as Model<"openai-responses">;

const userItem = { type: "message", role: "user", content: [{ type: "input_text", text: "real user" }] };

function compactionStream(): Response {
	const events = [
		{ type: "response.output_item.done", output_index: 0, item: { type: "compaction", encrypted_content: "enc" } },
		{ type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
	];
	const body = events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
	return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

const AWS_ENV: Record<string, string | undefined> = {
	AWS_REGION: "us-west-2",
	AWS_DEFAULT_REGION: undefined,
	AWS_PROFILE: undefined,
	AWS_BEARER_TOKEN_BEDROCK: undefined,
	AWS_ACCESS_KEY_ID: "AKIDEXAMPLE",
	AWS_SECRET_ACCESS_KEY: "secret",
	AWS_SESSION_TOKEN: undefined,
	AWS_CONFIG_FILE: "/nonexistent/aws-config",
	AWS_SHARED_CREDENTIALS_FILE: "/nonexistent/aws-credentials",
	AWS_EC2_METADATA_DISABLED: "true",
};

/** Runs `fn` with static AWS credentials, so a Mantle request is SigV4-signed. */
async function withAwsCredentials<T>(fn: () => Promise<T>): Promise<T> {
	const previous = Object.fromEntries(Object.keys(AWS_ENV).map(key => [key, Bun.env[key]]));
	try {
		for (const [key, value] of Object.entries(AWS_ENV)) {
			if (value === undefined) delete Bun.env[key];
			else Bun.env[key] = value;
		}
		clearAwsCredentialCache();
		return await fn();
	} finally {
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete Bun.env[key];
			else Bun.env[key] = value;
		}
		clearAwsCredentialCache();
	}
}

describe("remote compaction sends only while no probed gate reads closed", () => {
	test("generic remote endpoint", async () => {
		const { closedFirst, sentClosed } = await closeAtEachDepth(probedGate, (hold, onWire) =>
			requestRemoteCompaction(
				"https://compaction.example.test/summarize",
				{ systemPrompt: "summarize", prompt: "hello", maxTokens: 1024 },
				undefined,
				{
					beforeDispatch: hold,
					fetch: async () => {
						onWire();
						return Response.json({ summary: "summary" });
					},
				},
			),
		);

		expect(sentClosed).toEqual([]);
		expect(closedFirst.length).toBeGreaterThan(0);
	});

	test("OpenAI Responses compaction (V1)", async () => {
		const { closedFirst, sentClosed } = await closeAtEachDepth(probedGate, (hold, onWire) =>
			requestOpenAiRemoteCompaction(compactionModel, "test-key", [userItem], "compact", undefined, {
				beforeDispatch: hold,
				fetch: async () => {
					onWire();
					return Response.json({ output: [{ type: "compaction_summary", summary: "compact" }] });
				},
			}),
		);

		expect(sentClosed).toEqual([]);
		expect(closedFirst.length).toBeGreaterThan(0);
	});

	test("streaming compaction (V2)", async () => {
		const request = buildCompactionV2Request(compactionModel, [userItem], "instructions", { sessionId: "s" });
		const { closedFirst, sentClosed } = await closeAtEachDepth(probedGate, (hold, onWire) =>
			requestCompactionV2Streaming(compactionModel, "test-key", request, undefined, {
				beforeDispatch: hold,
				fetch: async () => {
					onWire();
					return compactionStream();
				},
			}),
		);

		expect(sentClosed).toEqual([]);
		expect(closedFirst.length).toBeGreaterThan(0);
	});

	// Bedrock's route signs the request on its way to the wire, so the send
	// is no longer one synchronous call: the hold has to be read again where
	// the signed request leaves.
	test("OpenAI Responses compaction (V1) on Bedrock Mantle, signed", async () => {
		const { closedFirst, sentClosed } = await withAwsCredentials(() =>
			closeAtEachDepth(probedGate, (hold, onWire) =>
				requestOpenAiRemoteCompaction(mantleModel, NO_AUTH_SENTINEL, [userItem], "compact", undefined, {
					beforeDispatch: hold,
					fetch: async () => {
						onWire();
						return Response.json({ output: [{ type: "compaction_summary", summary: "compact" }] });
					},
				}),
			),
		);

		expect(sentClosed).toEqual([]);
		expect(closedFirst.length).toBeGreaterThan(0);
	});

	test("streaming compaction (V2) on Bedrock Mantle, signed", async () => {
		const request = buildCompactionV2Request(mantleModel, [userItem], "instructions");
		const { closedFirst, sentClosed } = await withAwsCredentials(() =>
			closeAtEachDepth(probedGate, (hold, onWire) =>
				requestCompactionV2Streaming(mantleModel, NO_AUTH_SENTINEL, request, undefined, {
					beforeDispatch: hold,
					fetch: async () => {
						onWire();
						return compactionStream();
					},
				}),
			),
		);

		expect(sentClosed).toEqual([]);
		expect(closedFirst.length).toBeGreaterThan(0);
	});
});

/**
 * Bedrock's signed route re-reads the hold in its transport, after the
 * compaction armed its timeout. A pause that engaged in between parked the
 * request there with that clock running, so a pause longer than the timeout
 * failed the compaction instead of sending it on resume. Each depth closes
 * the gate a little later after the hold is first asked and keeps it closed
 * past the timeout.
 */
describe("a Bedrock compaction held where it leaves is not failed by its own timeout", () => {
	const TIMEOUT_MS = 40;
	const HELD_MS = 120;

	/** Sends one compaction per depth; returns how each ended and how many attempts V2 retried. */
	async function holdPastTimeoutAtEachDepth(
		send: (hold: DispatchHold, retried: () => void) => Promise<unknown>,
	): Promise<{ outcomes: string[]; retries: number }> {
		const outcomes: string[] = [];
		let retries = 0;
		await withAwsCredentials(async () => {
			for (let depth = 1; depth <= MAX_DEPTH; depth++) {
				const gate = probedGate();
				let armed = true;
				const hold: DispatchHold = () => {
					if (armed) {
						armed = false;
						afterMicrotasks(depth, () => gate.close());
					}
					return gate.hold();
				};
				hold.isClosed = gate.hold.isClosed;
				const ended = send(hold, () => retries++).then(
					() => "sent",
					(error: unknown) => (error instanceof Error ? error.name : String(error)),
				);
				// Real time: the timeout this guards against was `AbortSignal.timeout`,
				// which runs on the platform clock that fake timers do not drive.
				await Bun.sleep(HELD_MS);
				gate.open();
				outcomes.push(await ended);
			}
		});
		return { outcomes, retries };
	}

	test("OpenAI Responses compaction (V1)", async () => {
		const { outcomes } = await holdPastTimeoutAtEachDepth(hold =>
			requestOpenAiRemoteCompaction(mantleModel, NO_AUTH_SENTINEL, [userItem], "compact", undefined, {
				beforeDispatch: hold,
				timeoutMs: TIMEOUT_MS,
				fetch: async () => Response.json({ output: [{ type: "compaction_summary", summary: "compact" }] }),
			}),
		);

		expect(outcomes.filter(outcome => outcome !== "sent")).toEqual([]);
	});

	test("streaming compaction (V2)", async () => {
		const request = buildCompactionV2Request(mantleModel, [userItem], "instructions");
		const { outcomes, retries } = await holdPastTimeoutAtEachDepth((hold, retried) =>
			requestCompactionV2Streaming(mantleModel, NO_AUTH_SENTINEL, request, undefined, {
				beforeDispatch: hold,
				timeoutMs: TIMEOUT_MS,
				// A timed-out attempt is retried, which would hide the failure.
				retryWait: async () => retried(),
				fetch: async () => compactionStream(),
			}),
		);

		expect(outcomes.filter(outcome => outcome !== "sent")).toEqual([]);
		expect(retries).toBe(0);
	});
});

/**
 * The Codex compaction request minted its DeviceCheck attestation before its
 * hold, so a request parked by `/pause` went out on resume with an
 * attestation minted before the pause. The attestation is ephemeral and must
 * be minted after the hold.
 */
describe("Codex compaction mints its attestation after the hold", () => {
	const codexModel = buildModel({
		id: "gpt-5",
		name: "GPT-5 Codex",
		api: "openai-responses",
		provider: "openai-codex",
		baseUrl: "https://chatgpt.example/backend-api",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 400_000,
		maxTokens: 128_000,
	}) as Model<"openai-responses">;
	const codexToken = `header.${Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-test" } }),
	).toString("base64url")}.signature`;

	afterEach(() => {
		setCodexAttestationProvider(undefined);
	});

	/** Mints `attestation-N` on each ask, logging it; `onMint` runs with the count. */
	function attestEachMint(events: string[], onMint?: (mints: number) => void): void {
		let mints = 0;
		setCodexAttestationProvider(async () => {
			mints += 1;
			events.push(`mint:attestation-${mints}`);
			onMint?.(mints);
			return `attestation-${mints}`;
		});
	}

	function compactCodex(hold: DispatchHold, events: string[]): Promise<unknown> {
		return requestOpenAiRemoteCompaction(codexModel, codexToken, [userItem], "compact", undefined, {
			beforeDispatch: hold,
			fetch: async (_input, init) => {
				events.push(`wire:${new Headers(init?.headers).get("x-oai-attestation")}`);
				return Response.json({ output: [{ type: "compaction_summary", summary: "compact" }] });
			},
		});
	}

	// The pause engages as the first attestation is minted.
	test("a pause after the first mint sends one minted after the resume", async () => {
		const gate = probedGate();
		const events: string[] = [];
		attestEachMint(events, mints => mints === 1 && gate.close());
		const pending = compactCodex(gate.hold, events);

		// A cold load of the Codex module takes real time before the first mint.
		const deadline = Bun.nanoseconds() + 5e9;
		while (!events.includes("mint:attestation-1") && Bun.nanoseconds() < deadline) await loopTurn();
		for (let turn = 0; turn < 5; turn++) await loopTurn();
		events.push("resume");
		gate.open();
		await pending;

		expect(events).toEqual(["mint:attestation-1", "resume", "mint:attestation-2", "wire:attestation-2"]);
	});

	test("with no pause it mints once", async () => {
		const gate = probedGate();
		const events: string[] = [];
		attestEachMint(events);

		await compactCodex(gate.hold, events);

		expect(events).toEqual(["mint:attestation-1", "wire:attestation-1"]);
	});
});
