/**
 * Anthropic message threads (`message-threads-2026-08-12`): a session's later
 * turns continue a server-held conversation and send only what they append.
 *
 * The client stays the source of truth: a turn continues only when its full
 * request extends the conversation the server holds and the thread's fixed
 * fields are unchanged, a refused continue replays the whole conversation in
 * the same turn, and a refused thread stops threading the session.
 */
import { afterEach, describe, expect, it, setSystemTime } from "bun:test";
import { streamAnthropic } from "@oh-my-pi/pi-ai/providers/anthropic";
import type { MessageCreateParams } from "@oh-my-pi/pi-ai/providers/anthropic-wire";
import type { AnthropicOptions } from "@oh-my-pi/pi-ai/providers/anthropic";
import type {
	AssistantMessage,
	Context,
	FetchImpl,
	Message,
	ProviderSessionState,
	TextContent,
} from "@oh-my-pi/pi-ai/types";
import { markPerCallContextMessage } from "@oh-my-pi/pi-ai/utils/block-symbols";
import { requestBodyText } from "@oh-my-pi/pi-ai/utils/request-body";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { withOfficialAnthropicEndpoint } from "./helpers";

const THREADS_BETA = "message-threads-2026-08-12";

const MODEL = buildModel({
	id: "claude-sonnet-4-6",
	name: "Claude Sonnet 4.6",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8_192,
});

const TOOLS: Context["tools"] = [
	{
		name: "lookup",
		description: "Lookup a value",
		parameters: { type: "object", properties: {}, additionalProperties: false },
	},
];

interface SentRequest {
	body: MessageCreateParams;
	betas: string[];
}

type Reply = Response | ((body: MessageCreateParams) => Response);

function sseResponse(id: string, blocks: Array<Record<string, unknown>>, stopReason: string): Response {
	const events: Array<Record<string, unknown>> = [
		{ type: "message_start", message: { id, usage: { input_tokens: 10, output_tokens: 0 } } },
	];
	blocks.forEach((block, index) => {
		if (block.type === "text") {
			events.push({ type: "content_block_start", index, content_block: { type: "text", text: "" } });
			events.push({ type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } });
		} else {
			events.push({ type: "content_block_start", index, content_block: { ...block, input: {} } });
			events.push({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: "{}" } });
		}
		events.push({ type: "content_block_stop", index });
	});
	events.push(
		{ type: "message_delta", delta: { stop_reason: stopReason }, usage: { input_tokens: 10, output_tokens: 1 } },
		{ type: "message_stop" },
	);
	const body = `${events.map(event => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}`).join("\n\n")}\n\n`;
	return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

function textResponse(id: string, text: string): Response {
	return sseResponse(id, [{ type: "text", text }], "end_turn");
}

function errorResponse(status: number, message: string, errorCode?: string): Response {
	return new Response(
		JSON.stringify({
			type: "error",
			error: {
				type: status === 404 ? "not_found_error" : "invalid_request_error",
				message,
				...(errorCode ? { details: { error_code: errorCode } } : {}),
			},
		}),
		{ status, headers: { "Content-Type": "application/json" } },
	);
}

/** Fake Messages endpoint: answers each request with the next scripted reply (default: a text reply). */
function endpoint(script: Reply[] = []) {
	const sent: SentRequest[] = [];
	let replies = 0;
	const fetch: FetchImpl = async (_input, init) => {
		const body = JSON.parse(requestBodyText(init) ?? "{}") as MessageCreateParams;
		const betas = (new Headers(init?.headers).get("anthropic-beta") ?? "").split(",").filter(Boolean);
		sent.push({ body, betas });
		const reply = script.shift() ?? textResponse(`msg_${++replies}`, `reply ${replies}`);
		return typeof reply === "function" ? reply(body) : reply;
	};
	return { fetch, sent };
}

/** One agent session: carries the transcript and the provider session state across turns. */
function session(fetch: FetchImpl, overrides: Partial<AnthropicOptions> = {}) {
	const providerSessionState = new Map<string, ProviderSessionState>();
	const messages: Message[] = [];
	let systemPrompt = ["You are a precise assistant."];
	let tools = TOOLS;
	let timestamp = 0;
	return {
		messages,
		setSystemPrompt(prompt: string[]) {
			systemPrompt = prompt;
		},
		setTools(next: Context["tools"]) {
			tools = next;
		},
		async turn(content: string | TextContent[], extra: Message[] = []): Promise<AssistantMessage> {
			messages.push({ role: "user", content, timestamp: ++timestamp });
			const reply = await streamAnthropic(
				MODEL,
				{ systemPrompt, messages: [...messages, ...extra], tools },
				{ apiKey: "sk-ant-api03-test", sessionId: "session-1", providerSessionState, fetch, ...overrides },
			).result();
			if (reply.stopReason !== "error") messages.push(reply);
			return reply;
		},
	};
}

function userTexts(body: MessageCreateParams): string[] {
	return body.messages.map(message =>
		typeof message.content === "string"
			? message.content
			: message.content.map(block => (block.type === "text" ? block.text : block.type)).join(""),
	);
}

withOfficialAnthropicEndpoint();

afterEach(() => {
	setSystemTime();
});

describe("anthropic message threads", () => {
	it("creates a thread with the full request, then sends only appended messages", async () => {
		const { fetch, sent } = endpoint();
		const chat = session(fetch);

		await chat.turn("first");
		await chat.turn("second");

		const [create, next] = sent;
		expect(create.body.thread).toEqual({ type: "create" });
		expect(create.body.system).toBeDefined();
		expect(create.body.tools).toBeDefined();
		expect(create.betas).toContain(THREADS_BETA);

		expect(next.body.thread).toEqual({ type: "continue", previous_message_id: "msg_1" });
		expect(userTexts(next.body)).toEqual(["second"]);
		// The API-key contract: the thread keeps `system` and `tools` from the create.
		expect(next.body.system).toBeUndefined();
		expect(next.body.tools).toBeUndefined();
		expect(next.betas).toContain(THREADS_BETA);
		// Betas are a fixed field: the continue carries the create's set.
		expect([...next.betas].sort()).toEqual([...create.betas].sort());
	});

	it("marks a continue's first and newest appended blocks within the thread's breakpoint limit", async () => {
		// Twelve parallel calls: the stored response plus the results run past the
		// ~20-block lookback of the newest block's breakpoint.
		const calls = Array.from({ length: 12 }, (_, n) => ({ type: "tool_use", id: `toolu_${n}`, name: "lookup" }));
		const { fetch, sent } = endpoint([textResponse("msg_1", "one"), sseResponse("msg_2", calls, "tool_use")]);
		const chat = session(fetch);

		await chat.turn("first");
		await chat.turn("fan out");
		for (const call of calls) {
			chat.messages.push({
				role: "toolResult",
				toolCallId: call.id,
				toolName: call.name,
				content: [{ type: "text", text: `result ${call.id}` }],
				isError: false,
				timestamp: 9,
			});
		}
		await chat.turn("third");

		const marked = (body: MessageCreateParams): number[] =>
			body.messages
				.flatMap(message => (typeof message.content === "string" ? [] : message.content))
				.flatMap((block, index) => ("cache_control" in block && block.cache_control ? [index] : []));
		const breakpoints = (value: unknown): number =>
			(JSON.stringify(value ?? null).match(/"cache_control":\{/g) ?? []).length;
		const [create, short, long] = sent.map(request => request.body);
		expect([short.thread?.type, long.thread?.type]).toEqual(["continue", "continue"]);
		const appended = long.messages.reduce(
			(count, message) => count + (typeof message.content === "string" ? 1 : message.content.length),
			0,
		);
		// Continue breakpoints act on their own request only: the first appended block
		// reads up to the previous request, the newest one writes this turn.
		expect(appended).toBeGreaterThan(12);
		expect(marked(long)).toEqual([0, appended - 1]);
		expect(marked(short)).toEqual([0]);
		// The create's system and tools breakpoints count again on every continue; a fifth is a 400.
		for (const body of [long, short]) {
			expect(
				breakpoints(create.system) + breakpoints(create.tools) + breakpoints(body.messages),
			).toBeLessThanOrEqual(4);
		}
	});

	it("keeps system and tools on continues for Claude Code OAuth traffic", async () => {
		const { fetch, sent } = endpoint();
		const chat = session(fetch, { apiKey: "sk-ant-oat01-test" });

		await chat.turn("first");
		await chat.turn("second");

		const next = sent[1].body;
		expect(next.thread).toEqual({ type: "continue", previous_message_id: "msg_1" });
		expect(userTexts(next)).toEqual(["second"]);
		// The billing attestation hashes each body, so it differs per request.
		const withoutAttestation = (body: MessageCreateParams) =>
			JSON.stringify(body.system).replace(/cch=[0-9a-f]{5}/g, "cch");
		expect(withoutAttestation(next)).toBe(withoutAttestation(sent[0].body));
		expect(next.tools).toEqual(sent[0].body.tools);
	});

	it("starts a new thread when earlier history or a fixed field changed", async () => {
		const { fetch, sent } = endpoint();
		const chat = session(fetch);

		await chat.turn("first");
		chat.messages[0] = { role: "user", content: "first, edited", timestamp: 1 };
		await chat.turn("second");
		chat.setTools([...(TOOLS ?? []), { ...TOOLS![0], name: "lookup_more" }]);
		await chat.turn("third");
		await chat.turn("fourth");

		expect(sent.map(request => request.body.thread?.type)).toEqual(["create", "create", "create", "continue"]);
		expect(userTexts(sent[1].body)).toEqual(["first, edited", "reply 1", "second"]);
		expect(sent[3].body.thread).toEqual({ type: "continue", previous_message_id: "msg_3" });
	});

	it("starts a new thread once the server has dropped the previous one", async () => {
		const { fetch, sent } = endpoint();
		const chat = session(fetch);

		setSystemTime(new Date("2026-11-03T10:00:00Z"));
		await chat.turn("first");
		setSystemTime(new Date("2026-11-03T10:04:00Z"));
		await chat.turn("second");
		setSystemTime(new Date("2026-11-03T10:09:00Z"));
		await chat.turn("third");

		expect(sent.map(request => request.body.thread?.type)).toEqual(["create", "continue", "create"]);
		expect(userTexts(sent[2].body)).toEqual(["first", "reply 1", "second", "reply 2", "third"]);
	});

	it("replays the full conversation in the same turn when the server refuses a continue", async () => {
		const { fetch, sent } = endpoint([
			textResponse("msg_a", "one"),
			errorResponse(404, "thread not found", "thread_not_found"),
			textResponse("msg_b", "two"),
		]);
		const chat = session(fetch);

		await chat.turn("first");
		const reply = await chat.turn("second");

		expect(reply.stopReason).toBe("stop");
		expect(reply.errorMessage).toBeUndefined();
		expect(sent.map(request => request.body.thread?.type)).toEqual(["create", "continue", "create"]);
		expect(userTexts(sent[2].body)).toEqual(["first", "one", "second"]);
		expect(sent[2].body.system).toBeDefined();
	});

	it("stops threading the session after the server refuses threads", async () => {
		const { fetch, sent } = endpoint([
			errorResponse(400, "thread: unsupported for this organization", "thread_unsupported_request"),
		]);
		const chat = session(fetch);

		const reply = await chat.turn("first");
		await chat.turn("second");

		expect(reply.stopReason).toBe("stop");
		expect(sent.map(request => request.body.thread?.type)).toEqual(["create", undefined, undefined]);
		expect(sent[1].betas).not.toContain(THREADS_BETA);
		expect(userTexts(sent[2].body)).toEqual(["first", "reply 1", "second"]);
	});

	it("disables the thread only when the unthreaded resend after an unexplained 400 succeeds", async () => {
		const { fetch, sent } = endpoint([
			textResponse("msg_a", "one"),
			errorResponse(400, "messages: unexpected field"),
		]);
		const chat = session(fetch);

		await chat.turn("first");
		const reply = await chat.turn("second");
		await chat.turn("third");

		expect(reply.stopReason).toBe("stop");
		expect(sent.map(request => request.body.thread?.type)).toEqual(["create", "continue", undefined, undefined]);
	});

	it("sends per-call requests without a thread and continues the session thread after them", async () => {
		const { fetch, sent } = endpoint();
		const chat = session(fetch);

		await chat.turn("first");
		const reminder: Message = { role: "developer", content: "per-call reminder", timestamp: 99 };
		markPerCallContextMessage(reminder);
		await chat.turn("second", [reminder]);
		await chat.turn("third");

		expect(sent.map(request => request.body.thread?.type)).toEqual(["create", undefined, "continue"]);
		expect(sent[1].betas).not.toContain(THREADS_BETA);
		expect(sent[2].body.thread).toEqual({ type: "continue", previous_message_id: "msg_1" });
		expect(userTexts(sent[2].body)).toEqual(["second", "reply 2", "third"]);
	});

	it("honors statefulResponses: false", async () => {
		const { fetch, sent } = endpoint();
		const chat = session(fetch, { statefulResponses: false });

		await chat.turn("first");
		await chat.turn("second");

		expect(sent.map(request => request.body.thread)).toEqual([undefined, undefined]);
		expect(sent.every(request => !request.betas.includes(THREADS_BETA))).toBe(true);
	});
});
