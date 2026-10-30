import { afterEach, beforeEach, describe, expect, it, setSystemTime, vi } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getAgentDir, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { stream, streamSimple } from "../src/stream";
import type {
	Api,
	AssistantMessage,
	AssistantMessageEvent,
	Context,
	FetchImpl,
	ModelSpec,
	OptionsForApi,
	SimpleStreamOptions,
} from "../src/types";
import { armPreResponseTimeout, preResponseGuard } from "../src/utils/idle-iterator";

/**
 * The first-event budget is one budget from the wire to the first stream
 * event, and response headers do not renew it (see `armPreResponseTimeout`).
 *
 * The PR #17399 round-3 review measured the split this file pins: with a
 * 1,000 ms budget, headers at 600 ms and no body event, Bedrock, Google,
 * Vertex and Ollama gave the request up 1,000 ms after the wire, while
 * Anthropic, OpenAI completions and responses and Azure gave it up at
 * 1,600 ms, because their body iterator started a fresh budget at headers.
 * pi-native, Gemini CLI and Codex's SSE transport had the same two-stage shape.
 *
 * Each case replays that shape with fake timers (Bun fakes `setTimeout` and
 * `Date`; the real `setImmediate` lets the async chains between timers run),
 * once straight to the wire and once after a pause far longer than the
 * budget, and checks the request is given up exactly one budget after it went
 * out. The providers that hand their body iterator the remainder also get a
 * control: a first event that arrives inside the one budget still streams to
 * completion, so the remainder never undercuts the budget.
 */

const realSetImmediate = globalThis.setImmediate;
const BUDGET_MS = 1_000;
const HEADERS_AT_MS = 600;

/** Lets every pending async chain run to its next timer or I/O wait. */
async function settle(): Promise<void> {
	for (let round = 0; round < 30; round++) {
		const { promise, resolve } = Promise.withResolvers<void>();
		realSetImmediate(resolve);
		await promise;
	}
}

interface Pause {
	hold: () => Promise<void> | undefined;
	parked: Promise<void>;
	release: () => void;
}

/** `/pause` engaged after the first `passes` holds: every later hold parks until `release`. */
function pauseAfter(passes: number): Pause {
	let calls = 0;
	let open = false;
	const parked = Promise.withResolvers<void>();
	const gate = Promise.withResolvers<void>();
	return {
		hold: () => {
			calls++;
			if (open || calls <= passes) return undefined;
			parked.resolve();
			return gate.promise;
		},
		parked: parked.promise,
		release: () => {
			open = true;
			gate.resolve();
		},
	};
}

/** Settles only by rejecting when `signal` aborts. */
function stall(signal: AbortSignal | null | undefined): Promise<never> {
	const pending = Promise.withResolvers<never>();
	if (signal?.aborted) pending.reject(signal.reason);
	signal?.addEventListener("abort", () => pending.reject(signal.reason), { once: true });
	return pending.promise;
}

interface Endpoint {
	fetch: FetchImpl;
	wired: Promise<void>;
	readonly requests: number;
	/** Fake-clock milliseconds from the wire until the request's signal aborted or its body was cancelled. */
	readonly gaveUpAfter: number | undefined;
	sendHeaders: () => void;
	sendBody: (text: string) => void;
}

/**
 * A provider endpoint whose first inference request reaches the wire, sends
 * headers when told and a body when told. Later requests (a provider's own
 * retries) never answer; only the first is measured.
 */
function endpoint(): Endpoint {
	const wired = Promise.withResolvers<void>();
	const headers = Promise.withResolvers<void>();
	let body: ReadableStreamDefaultController<Uint8Array> | undefined;
	let wiredAt = 0;
	let gaveUpAfter: number | undefined;
	let requests = 0;
	const giveUp = (): void => {
		gaveUpAfter ??= Date.now() - wiredAt;
	};
	const fetch: FetchImpl = async (_input, init) => {
		const signal = init?.signal;
		if (++requests > 1) return stall(signal);
		wiredAt = Date.now();
		signal?.addEventListener("abort", giveUp, { once: true });
		wired.resolve();
		await Promise.race([headers.promise, stall(signal)]);
		return new Response(
			new ReadableStream<Uint8Array>({
				start(controller) {
					body = controller;
					signal?.addEventListener("abort", () => controller.error(signal.reason), { once: true });
				},
				cancel: giveUp,
			}),
			{ status: 200, headers: { "content-type": "text/event-stream" } },
		);
	};
	return {
		fetch,
		wired: wired.promise,
		get requests() {
			return requests;
		},
		get gaveUpAfter() {
			return gaveUpAfter;
		},
		sendHeaders: () => headers.resolve(),
		sendBody: (text: string) => {
			body?.enqueue(new TextEncoder().encode(text));
			body?.close();
		},
	};
}

/** How a stream ended: its final message, or the error its `result()` rejected with (pi-native fails that way). */
type Settled = Pick<AssistantMessage, "stopReason" | "errorMessage" | "content">;

interface Tracked {
	readonly settled: Settled | undefined;
}

function track(response: AsyncIterable<AssistantMessageEvent> & { result(): Promise<AssistantMessage> }): Tracked {
	let settled: Settled | undefined;
	void response.result().then(
		message => {
			settled = message;
		},
		(error: unknown) => {
			settled = {
				stopReason: "error",
				errorMessage: error instanceof Error ? error.message : String(error),
				content: [],
			};
		},
	);
	return {
		get settled() {
			return settled;
		},
	};
}

/** Advances the clock a budget at a time until the stream settles, so retries and backoffs can play out. */
async function advanceUntilSettled(tracked: Tracked): Promise<void> {
	for (let step = 0; step < 40 && !tracked.settled; step++) {
		vi.advanceTimersByTime(BUDGET_MS);
		await settle();
	}
}

const common = {
	name: "first-event budget fixture",
	reasoning: false,
	input: ["text" as const],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 1_000,
};
const context: Context = { systemPrompt: ["test"], messages: [{ role: "user", content: "hi", timestamp: 0 }] };

function sse(events: unknown[], named = false): string {
	return events
		.map(event => {
			if (typeof event === "string") return `data: ${event}\n\n`;
			const data = JSON.stringify(event);
			if (named && typeof event === "object" && event !== null && "type" in event) {
				return `event: ${String(event.type)}\ndata: ${data}\n\n`;
			}
			return `data: ${data}\n\n`;
		})
		.join("");
}

const ON_TIME = "on time";

const responsesBody = sse([
	{ type: "response.created", response: { id: "resp_on_time" } },
	{
		type: "response.output_item.added",
		item: { type: "message", id: "msg_on_time", role: "assistant", status: "in_progress", content: [] },
	},
	{ type: "response.content_part.added", part: { type: "output_text", text: "" } },
	{ type: "response.output_text.delta", delta: ON_TIME },
	{
		type: "response.output_item.done",
		item: {
			type: "message",
			id: "msg_on_time",
			role: "assistant",
			status: "completed",
			content: [{ type: "output_text", text: ON_TIME }],
		},
	},
	{
		type: "response.completed",
		response: {
			id: "resp_on_time",
			status: "completed",
			usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7, input_tokens_details: { cached_tokens: 0 } },
		},
	},
]);

const piNativeMessage: AssistantMessage = {
	role: "assistant",
	content: [{ type: "text", text: ON_TIME }],
	api: "anthropic-messages",
	provider: "anthropic",
	model: "claude-sonnet-4-5",
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "stop",
	timestamp: 0,
};

interface BudgetCase {
	name: string;
	spec: ModelSpec<Api>;
	options: Record<string, unknown>;
	/** The model's transport is only honoured by `streamSimple` (pi-native). */
	simple?: true;
	/** A complete body whose first event is the stream's first progress; providers handing their iterator the remainder. */
	onTimeBody?: string;
}

const cases: BudgetCase[] = [
	{
		name: "Bedrock",
		spec: {
			...common,
			id: "amazon.nova-lite-v1:0",
			api: "bedrock-converse-stream",
			provider: "amazon-bedrock",
			baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
		},
		options: { bearerToken: "fake" },
	},
	{
		name: "Google",
		spec: {
			...common,
			id: "gemini-3-flash",
			api: "google-generative-ai",
			provider: "google",
			baseUrl: "https://generativelanguage.example/v1beta",
		},
		options: { apiKey: "fake" },
	},
	{
		name: "Google Vertex",
		spec: {
			...common,
			id: "gemini-2.5-flash",
			api: "google-vertex",
			provider: "google-vertex",
			baseUrl: "https://vertex.example",
		},
		options: { apiKey: "fake", project: "p", location: "us-central1" },
	},
	{
		name: "Ollama",
		spec: {
			...common,
			id: "llama-local",
			api: "ollama-chat",
			provider: "ollama",
			baseUrl: "http://127.0.0.1:11434",
		},
		options: { apiKey: "fake" },
	},
	{
		name: "Anthropic",
		spec: {
			...common,
			id: "claude-sonnet-4-5",
			api: "anthropic-messages",
			provider: "anthropic",
			baseUrl: "https://api.anthropic.example",
		},
		options: { apiKey: "fake" },
		onTimeBody: sse(
			[
				{
					type: "message_start",
					message: {
						id: "msg_on_time",
						usage: {
							input_tokens: 5,
							output_tokens: 0,
							cache_read_input_tokens: 0,
							cache_creation_input_tokens: 0,
						},
					},
				},
				{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
				{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: ON_TIME } },
				{ type: "content_block_stop", index: 0 },
				{
					type: "message_delta",
					delta: { stop_reason: "end_turn" },
					usage: { input_tokens: 5, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
				},
				{ type: "message_stop" },
			],
			true,
		),
	},
	{
		name: "OpenAI completions",
		spec: {
			...common,
			id: "gpt-4o-mini",
			api: "openai-completions",
			provider: "openai",
			baseUrl: "https://api.openai.example/v1",
		},
		options: { apiKey: "fake" },
		onTimeBody: sse([
			{
				id: "chatcmpl-on-time",
				object: "chat.completion.chunk",
				created: 0,
				model: "gpt-4o-mini",
				choices: [{ index: 0, delta: { content: ON_TIME } }],
			},
			{
				id: "chatcmpl-on-time",
				object: "chat.completion.chunk",
				created: 0,
				model: "gpt-4o-mini",
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
				usage: {
					prompt_tokens: 5,
					completion_tokens: 2,
					total_tokens: 7,
					prompt_tokens_details: { cached_tokens: 0 },
				},
			},
			"[DONE]",
		]),
	},
	{
		name: "OpenAI responses",
		spec: {
			...common,
			id: "gpt-4o-mini",
			api: "openai-responses",
			provider: "openai",
			baseUrl: "https://api.openai.example/v1",
		},
		options: { apiKey: "fake" },
		onTimeBody: responsesBody,
	},
	{
		name: "Azure OpenAI responses",
		spec: {
			...common,
			id: "gpt-4o-mini",
			api: "azure-openai-responses",
			provider: "azure-openai-responses",
			baseUrl: "https://budget.openai.azure.com/openai/v1",
		},
		options: { apiKey: "fake" },
		onTimeBody: responsesBody,
	},
	{
		name: "pi-native",
		spec: {
			...common,
			id: "claude-sonnet-4-5",
			api: "anthropic-messages",
			provider: "anthropic",
			baseUrl: "http://llm-gateway.example:4000",
			transport: "pi-native",
		} as ModelSpec<Api>,
		options: { apiKey: "fake" },
		simple: true,
		onTimeBody: sse([
			{ type: "start", partial: { ...piNativeMessage, content: [] } },
			{ type: "text_delta", contentIndex: 0, delta: ON_TIME, partial: piNativeMessage },
			{ type: "done", reason: "stop", message: piNativeMessage },
			"[DONE]",
		]),
	},
	{
		name: "Gemini CLI",
		spec: {
			...common,
			id: "gemini-2.5-flash",
			api: "google-gemini-cli",
			provider: "google-gemini-cli",
			baseUrl: "https://cloudcode.example",
		},
		options: { apiKey: JSON.stringify({ token: "token", projectId: "proj-123" }) },
		onTimeBody: sse([
			{ response: { candidates: [{ content: { parts: [{ text: ON_TIME }] }, finishReason: "STOP" }] } },
		]),
	},
	{
		name: "Codex SSE",
		spec: {
			...common,
			id: "gpt-5.3-codex-spark",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			preferWebsockets: false,
		} as ModelSpec<Api>,
		options: {
			apiKey: `aaa.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } })).toBase64()}.bbb`,
		},
		onTimeBody: responsesBody,
	},
];

function start(entry: BudgetCase, server: Endpoint, hold?: Pause["hold"]): Tracked {
	const model = buildModel(entry.spec);
	const options = {
		...entry.options,
		streamFirstEventTimeoutMs: BUDGET_MS,
		streamIdleTimeoutMs: BUDGET_MS,
		maxHttpAttempts: 1,
		maxRetryDelayMs: 1,
		providerRetryWait: async () => {},
		beforeDispatch: hold,
		fetch: server.fetch,
	};
	return track(
		entry.simple
			? streamSimple(model, context, options as SimpleStreamOptions)
			: stream(model, context, options as OptionsForApi<Api>),
	);
}

/** Parks the request on a pause well past the budget, then releases it to the wire. */
async function pauseThenRelease(pause: Pause, server: Endpoint): Promise<void> {
	await pause.parked;
	vi.advanceTimersByTime(BUDGET_MS * 20);
	await settle();
	expect(server.requests).toBe(0);
	pause.release();
}

describe("one first-event budget from the wire, whatever the headers do", () => {
	const originalAgentDir = getAgentDir();
	beforeEach(() => {
		// Codex keeps per-session state under the agent dir.
		setAgentDir(TempDir.createSync("@pi-first-event-budget-").path());
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
		setAgentDir(originalAgentDir);
	});

	for (const entry of cases) {
		for (const paused of [false, true]) {
			const when = paused ? "after a pause" : "straight to the wire";
			it(`${entry.name}, ${when}: headers at ${HEADERS_AT_MS} ms leave the first event the rest of the budget, not a new one`, async () => {
				const server = endpoint();
				const pause = paused ? pauseAfter(1) : undefined;
				const tracked = start(entry, server, pause?.hold);
				if (pause) await pauseThenRelease(pause, server);

				await server.wired;
				await settle();
				vi.advanceTimersByTime(HEADERS_AT_MS);
				server.sendHeaders();
				await settle();
				vi.advanceTimersByTime(BUDGET_MS - HEADERS_AT_MS - 1);
				await settle();
				expect(server.gaveUpAfter).toBeUndefined();
				expect(tracked.settled).toBeUndefined();

				vi.advanceTimersByTime(1);
				await settle();
				expect(server.gaveUpAfter).toBe(BUDGET_MS);

				await advanceUntilSettled(tracked);
				expect(tracked.settled?.stopReason).toBe("error");
				expect(tracked.settled?.errorMessage).toMatch(/first event|timed out/i);
			});
		}
	}

	for (const entry of cases) {
		const onTimeBody = entry.onTimeBody;
		if (!onTimeBody) continue;
		it(`${entry.name}: a first event just inside the one budget still streams to completion`, async () => {
			const server = endpoint();
			const pause = pauseAfter(1);
			const tracked = start(entry, server, pause.hold);
			await pauseThenRelease(pause, server);

			await server.wired;
			await settle();
			vi.advanceTimersByTime(HEADERS_AT_MS);
			server.sendHeaders();
			await settle();
			vi.advanceTimersByTime(BUDGET_MS - HEADERS_AT_MS - 10);
			await settle();
			server.sendBody(onTimeBody);
			await settle();

			await advanceUntilSettled(tracked);
			expect(server.gaveUpAfter).toBeUndefined();
			expect(tracked.settled?.errorMessage).toBeUndefined();
			expect(tracked.settled?.stopReason).toBe("stop");
			expect(tracked.settled?.content).toEqual([expect.objectContaining({ type: "text", text: ON_TIME })]);
		});
	}
});

describe("armPreResponseTimeout remaining budget", () => {
	afterEach(() => {
		vi.useRealTimers();
		setSystemTime();
	});

	it("reports what the wire spent at headers, never the held time, and stops counting once cleared", () => {
		vi.useFakeTimers();
		const guard = armPreResponseTimeout(undefined, BUDGET_MS);
		const budget = preResponseGuard(guard.signal);
		budget?.suspend();
		vi.advanceTimersByTime(BUDGET_MS * 20);
		budget?.resume();
		vi.advanceTimersByTime(HEADERS_AT_MS);
		expect(guard.remaining()).toBe(BUDGET_MS - HEADERS_AT_MS);
		guard.clear();
		vi.advanceTimersByTime(BUDGET_MS * 5);
		expect(guard.remaining()).toBe(BUDGET_MS - HEADERS_AT_MS);
		expect(guard.signal?.aborted).toBe(false);
	});

	it("leaves a positive remainder when the budget ran out in the turn the headers arrived", () => {
		vi.useFakeTimers();
		const guard = armPreResponseTimeout(undefined, BUDGET_MS);
		// The clock passes the deadline before the timer that would fire at it runs.
		setSystemTime(new Date(Date.now() + BUDGET_MS + 50));
		guard.clear();
		// Zero would read as "no first-event watchdog" to the iterator.
		expect(guard.remaining()).toBe(1);
	});

	it("has no remainder when no budget is armed", () => {
		expect(armPreResponseTimeout(undefined, undefined).remaining()).toBeUndefined();
		expect(armPreResponseTimeout(undefined, 0).remaining()).toBeUndefined();
	});
});
