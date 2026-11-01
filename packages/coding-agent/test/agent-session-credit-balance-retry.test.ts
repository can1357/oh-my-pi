import { afterEach, describe, expect, it, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Model, ModelSpec } from "@oh-my-pi/pi-ai/types";
import { streamSimple } from "@oh-my-pi/pi-ai/stream";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { mockSchedulerWaitWithClock } from "./helpers/mock-scheduler-clock";

type AutoRetryStartEvent = Extract<AgentSessionEvent, { type: "auto_retry_start" }>;
type AutoRetryEndEvent = Extract<AgentSessionEvent, { type: "auto_retry_end" }>;

const CREDIT_BALANCE_MESSAGE =
	"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.";
// The HTTP 400 body Anthropic returned, byte for byte, while the balance sat at zero.
const CREDIT_BALANCE_BODY = `{"type":"error","error":{"type":"invalid_request_error","message":"${CREDIT_BALANCE_MESSAGE}"},"request_id":"req_011CgbLuqzvWZWRDTHtaVVMj"}`;
// The session spaces credit-balance retries 30 s apart; ten retries (the
// default `retry.maxRetries`) wait 5 minutes in all.
const CREDIT_BALANCE_RETRY_DELAY_MS = 30_000;

function jsonResponse(status: number, body: string): Response {
	return new Response(body, { status, headers: { "content-type": "application/json" } });
}

function anthropicError(status: number, type: string, message: string): Response {
	return jsonResponse(status, JSON.stringify({ type: "error", error: { type, message }, request_id: "req_test" }));
}

function sseResponse(frames: Array<[event: string, data: unknown]>): Response {
	return new Response(frames.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(""), {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

const MESSAGE_START: [string, unknown] = [
	"message_start",
	{
		type: "message_start",
		message: {
			id: "msg_local",
			type: "message",
			role: "assistant",
			content: [],
			usage: { input_tokens: 12, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
		},
	},
];

function recoveredResponse(): Response {
	return sseResponse([
		MESSAGE_START,
		["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
		[
			"content_block_delta",
			{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Recovered" } },
		],
		["content_block_stop", { type: "content_block_stop", index: 0 }],
		[
			"message_delta",
			{
				type: "message_delta",
				delta: { stop_reason: "end_turn" },
				usage: { input_tokens: 12, output_tokens: 4, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
			},
		],
		["message_stop", { type: "message_stop" }],
	]);
}

// The in-stream form seen in the same outage: a 200 whose stream had begun
// thinking, then an `error` event carrying the same rejection.
function creditBalanceStreamResponse(): Response {
	return sseResponse([
		MESSAGE_START,
		[
			"content_block_start",
			{ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
		],
		[
			"content_block_delta",
			{ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Reading the file" } },
		],
		["error", { type: "error", error: { type: "invalid_request_error", message: CREDIT_BALANCE_MESSAGE } }],
	]);
}

function model(baseUrl: string): Model<"anthropic-messages"> {
	return buildModel({
		api: "anthropic-messages",
		name: "Local Anthropic Test",
		id: "claude-local-test",
		provider: "anthropic",
		baseUrl,
		contextWindow: 200_000,
		maxTokens: 8192,
		input: ["text"],
		reasoning: false,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	} satisfies ModelSpec<"anthropic-messages">);
}

interface Harness {
	requests: number;
	session: AgentSession;
	retryStarts: AutoRetryStartEvent[];
	retryEnds: AutoRetryEndEvent[];
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
	vi.restoreAllMocks();
});

async function runTurn(respond: (requestNumber: number) => Response): Promise<Harness> {
	const harness = { requests: 0, retryStarts: [], retryEnds: [] } as unknown as Harness;
	const server = Bun.serve({
		port: 0,
		fetch: async request => {
			await request.text();
			harness.requests++;
			return respond(harness.requests);
		},
	});
	const tempDir = TempDir.createSync("@pi-credit-balance-retry-");
	const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
	authStorage.keys.setRuntime("anthropic", "local-test-key");
	const agent = new Agent({
		getApiKey: () => "local-test-key",
		initialState: {
			model: model(server.url.toString().replace(/\/$/, "")),
			systemPrompt: ["Test"],
			tools: [],
			messages: [],
		},
		streamFn: streamSimple,
	});
	// Retry settings stay at their defaults: the bound under test is the one a
	// user gets without configuring anything.
	const settings = Settings.isolated({ "compaction.enabled": false });
	const session = new AgentSession({
		agent,
		sessionManager: SessionManager.inMemory(),
		settings,
		modelRegistry: new ModelRegistry(authStorage, tempDir.join("models.yml"), { settings }),
	});
	harness.session = session;
	cleanups.push(async () => {
		await session.dispose();
		authStorage.close();
		server.stop(true);
		tempDir.removeSync();
	});
	session.subscribe(event => {
		if (event.type === "auto_retry_start") harness.retryStarts.push(event);
		if (event.type === "auto_retry_end") harness.retryEnds.push(event);
	});
	// Advance the monotonic clock with each backoff instead of sleeping it.
	mockSchedulerWaitWithClock();

	await session.prompt("Summarize the repository");
	await session.waitForIdle();
	return harness;
}

function lastAssistant(session: AgentSession): AssistantMessage {
	const message = session.agent.state.messages.at(-1);
	if (message?.role !== "assistant") throw new Error("Expected a trailing assistant message");
	return message as AssistantMessage;
}

describe("Anthropic credit-balance rejection", () => {
	it("waits out a credit-balance 400 and finishes the turn once credit is back", async () => {
		const harness = await runTurn(n => (n === 1 ? jsonResponse(400, CREDIT_BALANCE_BODY) : recoveredResponse()));

		expect(harness.requests).toBe(2);
		expect(harness.retryStarts).toHaveLength(1);
		expect(harness.retryStarts[0]).toMatchObject({ attempt: 1, delayMs: CREDIT_BALANCE_RETRY_DELAY_MS });
		expect(harness.retryStarts[0]!.errorMessage).toContain(CREDIT_BALANCE_MESSAGE);
		const final = lastAssistant(harness.session);
		expect(final.stopReason).toBe("stop");
		expect(final.content).toContainEqual({ type: "text", text: "Recovered" });
	});

	it("waits out the same rejection when the stream reports it after a 200", async () => {
		const harness = await runTurn(n => (n === 1 ? creditBalanceStreamResponse() : recoveredResponse()));

		expect(harness.requests).toBe(2);
		expect(harness.retryStarts).toHaveLength(1);
		expect(harness.retryStarts[0]).toMatchObject({ attempt: 1, delayMs: CREDIT_BALANCE_RETRY_DELAY_MS });
		expect(harness.retryStarts[0]!.errorMessage).toContain(CREDIT_BALANCE_MESSAGE);
		const final = lastAssistant(harness.session);
		expect(final.stopReason).toBe("stop");
		expect(final.content).toContainEqual({ type: "text", text: "Recovered" });
	});

	it("gives up after five minutes of retries and surfaces the provider's rejection", async () => {
		const harness = await runTurn(() => jsonResponse(400, CREDIT_BALANCE_BODY));

		// One request, then the ten retries the default budget allows.
		expect(harness.requests).toBe(11);
		expect(harness.retryStarts.map(event => event.delayMs)).toEqual(Array(10).fill(CREDIT_BALANCE_RETRY_DELAY_MS));
		expect(harness.retryStarts.reduce((total, event) => total + event.delayMs, 0)).toBe(5 * 60_000);
		expect(harness.retryEnds).toHaveLength(1);
		expect(harness.retryEnds[0]).toMatchObject({ success: false, attempt: 10 });
		expect(harness.retryEnds[0]!.finalError).toBe(`400 ${CREDIT_BALANCE_BODY}`);
		const final = lastAssistant(harness.session);
		expect(final.stopReason).toBe("error");
		expect(final.errorMessage).toBe(`Retry budget exhausted after 10 retries: 400 ${CREDIT_BALANCE_BODY}`);
	});

	it.each([
		// A 400 of another type carrying the same sentence.
		["another error type", "billing_error", CREDIT_BALANCE_MESSAGE],
		// A malformed request: the same type, another message.
		["another message", "invalid_request_error", "messages: text content blocks must be non-empty"],
		// The sentence quoted inside another rejection rather than leading it.
		[
			"the sentence quoted mid-message",
			"invalid_request_error",
			`messages.0.content.0.text: unexpected value: ${CREDIT_BALANCE_MESSAGE}`,
		],
	])("fails at once on a 400 with %s", async (_label, type, message) => {
		const harness = await runTurn(() => anthropicError(400, type, message));

		expect(harness.requests).toBe(1);
		expect(harness.retryStarts).toEqual([]);
		const final = lastAssistant(harness.session);
		expect(final.stopReason).toBe("error");
		expect(final.errorMessage).toContain(message);
	});
});
