import { afterEach, describe, expect, it, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Model, ModelSpec } from "@oh-my-pi/pi-ai/types";
import { streamSimple } from "@oh-my-pi/pi-ai/stream";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { runPrintMode } from "@oh-my-pi/pi-coding-agent/modes/print-mode";
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
const CREDIT_BALANCE_EMBEDDED_DIAGNOSTIC = `Invalid tool schema. Offending schema: {"error":{"type":"invalid_request_error","message":"${CREDIT_BALANCE_MESSAGE}"}}`;
const CREDIT_BALANCE_NON_ENVELOPE_BODY = `{"error":{"type":"invalid_request_error","message":"${CREDIT_BALANCE_MESSAGE}"}}`;
// The session waits at least five minutes across the default ten retries and
// jitters each wait above that floor so sessions do not retry in lockstep.
const CREDIT_BALANCE_MIN_RETRY_DELAY_MS = 30_000;
const CREDIT_BALANCE_MAX_RETRY_DELAY_MS = 37_500;

function jsonResponse(status: number, body: string, headers: Record<string, string> = {}): Response {
	return new Response(body, {
		status,
		headers: { "content-type": "application/json", ...headers },
	});
}

function textResponse(status: number, body: string): Response {
	return new Response(body, { status, headers: { "content-type": "text/plain" } });
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

async function createHarness(respond: (requestNumber: number) => Response, maxDelayMs?: number): Promise<Harness> {
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
	const settings = Settings.isolated({
		"compaction.enabled": false,
		...(maxDelayMs === undefined ? {} : { "retry.maxDelayMs": maxDelayMs }),
	});
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
	return harness;
}

async function runTurn(respond: (requestNumber: number) => Response): Promise<Harness> {
	const harness = await createHarness(respond);
	// Advance the monotonic clock with each backoff instead of sleeping it.
	mockSchedulerWaitWithClock();
	await harness.session.prompt("Summarize the repository");
	await harness.session.waitForIdle();
	return harness;
}

function lastAssistant(session: AgentSession): AssistantMessage {
	const message = session.agent.state.messages.at(-1);
	if (message?.role !== "assistant") throw new Error("Expected a trailing assistant message");
	return message as AssistantMessage;
}

function expectCreditBalanceRetryDelay(delayMs: number): void {
	expect(delayMs).toBeGreaterThanOrEqual(CREDIT_BALANCE_MIN_RETRY_DELAY_MS);
	expect(delayMs).toBeLessThanOrEqual(CREDIT_BALANCE_MAX_RETRY_DELAY_MS);
}

describe("Anthropic credit-balance rejection", () => {
	it("waits out a credit-balance 400 and finishes the turn once credit is back", async () => {
		const harness = await runTurn(n => (n === 1 ? jsonResponse(400, CREDIT_BALANCE_BODY) : recoveredResponse()));

		expect(harness.requests).toBe(2);
		expect(harness.retryStarts).toHaveLength(1);
		expect(harness.retryStarts[0]).toMatchObject({ attempt: 1 });
		expectCreditBalanceRetryDelay(harness.retryStarts[0]!.delayMs);
		const final = lastAssistant(harness.session);
		expect(final.stopReason).toBe("stop");
		expect(final.content).toContainEqual({ type: "text", text: "Recovered" });
	});

	it("waits out the same rejection when the stream reports it after a 200", async () => {
		const harness = await runTurn(n => (n === 1 ? creditBalanceStreamResponse() : recoveredResponse()));

		expect(harness.requests).toBe(2);
		expect(harness.retryStarts).toHaveLength(1);
		expect(harness.retryStarts[0]).toMatchObject({ attempt: 1 });
		expectCreditBalanceRetryDelay(harness.retryStarts[0]!.delayMs);
		const final = lastAssistant(harness.session);
		expect(final.stopReason).toBe("stop");
		expect(final.content).toContainEqual({ type: "text", text: "Recovered" });
	});

	it("jitters the wait above the 30-second floor so sessions do not retry in lockstep", async () => {
		const harness = await createHarness(n =>
			n === 1 ? jsonResponse(400, CREDIT_BALANCE_BODY) : recoveredResponse(),
		);
		mockSchedulerWaitWithClock();
		vi.spyOn(Math, "random").mockReturnValue(0.5);
		await harness.session.prompt("Summarize the repository");
		await harness.session.waitForIdle();

		expect(harness.requests).toBe(2);
		expect(harness.retryStarts).toHaveLength(1);
		expect(harness.retryStarts[0]).toMatchObject({ attempt: 1, delayMs: 33_750 });
	});

	it("keeps the credit retry within a max delay equal to its 30-second floor", async () => {
		const harness = await createHarness(
			n => (n === 1 ? jsonResponse(400, CREDIT_BALANCE_BODY) : recoveredResponse()),
			30_000,
		);
		mockSchedulerWaitWithClock();
		vi.spyOn(Math, "random").mockReturnValue(0.5);
		await harness.session.prompt("Summarize the repository");
		await harness.session.waitForIdle();

		expect(harness.requests).toBe(2);
		expect(harness.retryStarts).toHaveLength(1);
		expect(harness.retryStarts[0]).toMatchObject({ attempt: 1, delayMs: 30_000 });
	});

	it("adds jitter after a provider hint without retrying before it", async () => {
		const harness = await createHarness(
			n => (n === 1 ? jsonResponse(400, CREDIT_BALANCE_BODY, { "retry-after-ms": "60000" }) : recoveredResponse()),
			100_000,
		);
		mockSchedulerWaitWithClock();
		vi.spyOn(Math, "random").mockReturnValue(0.5);
		await harness.session.prompt("Summarize the repository");
		await harness.session.waitForIdle();

		expect(harness.requests).toBe(2);
		expect(harness.retryStarts).toHaveLength(1);
		expect(harness.retryStarts[0]).toMatchObject({ attempt: 1, delayMs: 63_750 });
	});

	it("prints the terminal-style wait notice on stderr without adding it to stdout", async () => {
		const harness = await createHarness(n =>
			n === 1 ? jsonResponse(400, CREDIT_BALANCE_BODY) : recoveredResponse(),
		);
		mockSchedulerWaitWithClock();
		const stdout: string[] = [];
		const stderr: string[] = [];
		vi.spyOn(process.stdout, "write").mockImplementation((...args: unknown[]) => {
			stdout.push(String(args[0]));
			const callback = args.at(-1);
			if (typeof callback === "function") (callback as (error?: Error | null) => void)(null);
			return true;
		});
		vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
			stderr.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
			return true;
		});

		expect(await runPrintMode(harness.session, { mode: "text", initialMessage: "Summarize the repository" })).toBe(0);

		expect(stderr.join("")).toContain("Retrying (1/10) in ");
		expect(stderr.join("")).toContain(`400 ${CREDIT_BALANCE_MESSAGE}`);
		expect(stdout.join("")).toContain("Recovered");
		expect(stdout.join("")).not.toContain("Retrying");
	});

	it("gives up after five minutes of retries and surfaces the provider's rejection", async () => {
		const harness = await runTurn(() => jsonResponse(400, CREDIT_BALANCE_BODY));

		// One request, then the ten retries the default budget allows.
		expect(harness.requests).toBe(11);
		expect(harness.retryStarts).toHaveLength(10);
		for (const event of harness.retryStarts) expectCreditBalanceRetryDelay(event.delayMs);
		const totalDelayMs = harness.retryStarts.reduce((total, event) => total + event.delayMs, 0);
		expect(totalDelayMs).toBeGreaterThanOrEqual(5 * 60_000);
		expect(totalDelayMs).toBeLessThanOrEqual(6.25 * 60_000);
		expect(harness.retryEnds).toHaveLength(1);
		expect(harness.retryEnds[0]).toMatchObject({ success: false, attempt: 10 });
		expect(harness.retryEnds[0]!.finalError).toBe(`400 ${CREDIT_BALANCE_BODY}`);
		const final = lastAssistant(harness.session);
		expect(final.stopReason).toBe("error");
		expect(final.errorMessage).toBe(`Retry budget exhausted after 10 retries: 400 ${CREDIT_BALANCE_BODY}`);
	});

	it.each([
		// A 400 of another type carrying the same sentence.
		[
			"another error type",
			() => anthropicError(400, "billing_error", CREDIT_BALANCE_MESSAGE),
			CREDIT_BALANCE_MESSAGE,
		],
		// A malformed request: the same type, another message.
		[
			"another message",
			() => anthropicError(400, "invalid_request_error", "messages: text content blocks must be non-empty"),
			"messages: text content blocks must be non-empty",
		],
		// The sentence quoted inside another rejection rather than leading it.
		[
			"the sentence quoted mid-message",
			() =>
				anthropicError(
					400,
					"invalid_request_error",
					`messages.0.content.0.text: unexpected value: ${CREDIT_BALANCE_MESSAGE}`,
				),
			CREDIT_BALANCE_MESSAGE,
		],
		// Plaintext diagnostics can quote a JSON example but are not provider envelopes.
		[
			"a plaintext diagnostic that embeds an envelope",
			() => textResponse(400, CREDIT_BALANCE_EMBEDDED_DIAGNOSTIC),
			CREDIT_BALANCE_EMBEDDED_DIAGNOSTIC,
		],
		// JSON without the provider envelope wrapper is not an Anthropic error response.
		[
			"a JSON body that is not an envelope",
			() => jsonResponse(400, CREDIT_BALANCE_NON_ENVELOPE_BODY),
			CREDIT_BALANCE_NON_ENVELOPE_BODY,
		],
		// A non-JSON body that begins with the sentence has no structured envelope.
		["a plaintext credit sentence", () => textResponse(400, CREDIT_BALANCE_MESSAGE), CREDIT_BALANCE_MESSAGE],
	])("fails at once on a 400 with %s", async (_label, response, expectedMessage) => {
		const harness = await runTurn(() => response());

		expect(harness.requests).toBe(1);
		expect(harness.retryStarts).toEqual([]);
		const final = lastAssistant(harness.session);
		expect(final.stopReason).toBe("error");
		expect(final.errorMessage).toContain(expectedMessage);
	});
});
