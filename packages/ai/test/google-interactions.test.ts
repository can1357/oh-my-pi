import { describe, expect, it } from "bun:test";
import { Effort } from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { streamGoogleInteractions } from "@oh-my-pi/pi-ai/providers/google-interactions";
import { streamSimple } from "@oh-my-pi/pi-ai/stream";
import type { AssistantMessage, AssistantMessageEvent, Context, FetchImpl, Model, Tool } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Type } from "@sinclair/typebox";

// Gemini Interactions (per-user quota) contract, against frames captured from
// the live endpoint (signatures truncated, still valid base64).

const SIG_CALL = "Et4CCtsCAWkUfROH5SxXBgsP";
const SIG_ANSWER = "EsMBCsABAWkUfRNJH9c/xHGI";
const SIG_SUMMARY = "Es8KCswKAWkUfRNkTU24eSaE";
const PNG = "iVBORw0KGgo=";

function hostModel(id: string): Model<"google-interactions"> {
	return buildModel({
		id,
		name: id,
		api: "google-interactions",
		provider: "gemini-host",
		baseUrl: "https://generativelanguage.googleapis.com/v1beta",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_048_576,
		maxTokens: 65_536,
	});
}

const hydrogen = hostModel("gemini-4-hydrogen");
const flashLite = hostModel("gemini-3.5-flash-lite");

const readFile: Tool = {
	name: "read_file",
	description: "Reads a workspace file.",
	parameters: Type.Object({ path: Type.String() }),
};

function frame(type: string, data: Record<string, unknown>): string {
	return `event: ${type}\ndata: ${JSON.stringify({ ...data, event_type: type })}\n\n`;
}

const created = frame("interaction.created", {
	interaction: { id: "", status: "in_progress", object: "interaction", model: "gemini-4-hydrogen" },
});
const statusUpdate = frame("interaction.status_update", { interaction_id: "", status: "in_progress" });
const done = "event: done\ndata: [DONE]\n\n";

function completed(status: string, usage: Record<string, number>): string {
	return frame("interaction.completed", { interaction: { id: "", status, usage, object: "interaction" } });
}

/** Turn 1 as captured: a signature-only thought, then a streamed function call. */
const TOOL_CALL_TURN = [
	created,
	statusUpdate,
	frame("step.start", { index: 0, step: { type: "thought" } }),
	frame("step.delta", { index: 0, delta: { signature: SIG_CALL, type: "thought_signature" } }),
	frame("step.stop", { index: 0 }),
	frame("step.start", {
		index: 1,
		step: { id: "call_14541487277061560791", type: "function_call", name: "read_file", arguments: {} },
	}),
	frame("step.delta", { index: 1, delta: { arguments: '{"path":"src/auth.py"}', type: "arguments_delta" } }),
	frame("step.stop", { index: 1 }),
	completed("requires_action", {
		total_tokens: 184,
		total_input_tokens: 110,
		total_cached_tokens: 0,
		total_output_tokens: 26,
		total_thought_tokens: 48,
	}),
	done,
].join("");

/** Thinking at `high`: a summary, its signature, then the answer. */
const SUMMARY_TURN = [
	created,
	frame("step.start", { index: 0, step: { type: "thought" } }),
	frame("step.delta", {
		index: 0,
		delta: { content: { text: "**Listing Prime Numbers**\n\n", type: "text" }, type: "thought_summary" },
	}),
	frame("step.delta", { index: 0, delta: { signature: SIG_SUMMARY, type: "thought_signature" } }),
	frame("step.stop", { index: 0 }),
	frame("step.start", { index: 1, step: { type: "model_output" } }),
	frame("step.delta", { index: 1, delta: { text: "17", type: "text" } }),
	frame("step.stop", { index: 1 }),
	completed("completed", {
		total_tokens: 602,
		total_input_tokens: 50,
		total_cached_tokens: 20,
		total_output_tokens: 6,
		total_thought_tokens: 546,
	}),
	done,
].join("");

function sse(body: string, status = 200): Response {
	return new Response(body, { status, headers: { "content-type": "text/event-stream" } });
}

function jsonError(status: number, message: string, code: string, headers?: Record<string, string>): Response {
	return new Response(JSON.stringify({ error: { message, code } }), {
		status,
		headers: { "content-type": "application/json", ...headers },
	});
}

interface Captured {
	bodies: Record<string, unknown>[];
	headers: Headers[];
}

function scripted(responses: (() => Response)[]): { fetch: FetchImpl; captured: Captured } {
	const captured: Captured = { bodies: [], headers: [] };
	const fetch: FetchImpl = async (_input, init) => {
		captured.bodies.push(JSON.parse(String(init?.body)));
		captured.headers.push(new Headers(init?.headers));
		const next = responses[Math.min(captured.bodies.length - 1, responses.length - 1)];
		return next();
	};
	return { fetch, captured };
}

const userTurn: Context = {
	messages: [{ role: "user", content: "What is in src/auth.py?", timestamp: 1 }],
	tools: [readFile],
};

async function drain(stream: AsyncIterable<AssistantMessageEvent>): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(event);
	return events;
}

describe("Gemini Interactions request", () => {
	it("replays mixed history as ordered steps: own signed thoughts, foreign calls unsigned-safe, images", async () => {
		const ownTurn: AssistantMessage = {
			role: "assistant",
			api: "google-interactions",
			provider: "gemini-host",
			model: "gemini-4-hydrogen",
			content: [
				{ type: "thinking", thinking: "Reading the file first.", thinkingSignature: SIG_CALL },
				{ type: "toolCall", id: "call_1", name: "read_file", arguments: { path: "src/auth.py" } },
			],
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: 2,
		};
		const foreignTurn: AssistantMessage = {
			...ownTurn,
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-opus-5-5",
			content: [
				{ type: "thinking", thinking: "Check the screenshot.", thinkingSignature: "anthropic-sig" },
				{ type: "toolCall", id: "toolu_2", name: "read_file", arguments: { path: "shot.png" } },
			],
			timestamp: 4,
		};
		const context: Context = {
			systemPrompt: ["You are a software engineering agent."],
			tools: [readFile],
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "Look at this" },
						{ type: "image", mimeType: "image/png", data: PNG },
					],
					timestamp: 1,
				},
				ownTurn,
				{
					role: "toolResult",
					toolCallId: "call_1",
					toolName: "read_file",
					content: [{ type: "text", text: "def f(): ..." }],
					isError: false,
					timestamp: 3,
				},
				foreignTurn,
				{
					role: "toolResult",
					toolCallId: "toolu_2",
					toolName: "read_file",
					content: [
						{ type: "text", text: "binary file" },
						{ type: "image", mimeType: "image/png", data: PNG },
					],
					isError: true,
					timestamp: 5,
				},
			],
		};
		const { fetch, captured } = scripted([() => sse(SUMMARY_TURN)]);

		await streamSimple(hydrogen, context, {
			apiKey: "ya29.token",
			fetch,
			reasoning: Effort.High,
			temperature: 0.2,
			topP: 0.9,
			toolChoice: { type: "tool", name: "read_file" },
		}).result();

		const body = captured.bodies[0]!;
		expect(body.model).toBe("gemini-4-hydrogen");
		expect(body.store).toBe(false);
		expect(body.stream).toBe(true);
		expect(body.system_instruction).toBe("You are a software engineering agent.");
		// Sampling knobs are never sent; tool_choice lives inside generation_config;
		// no caller cap means no max_output_tokens.
		expect(body.temperature).toBeUndefined();
		expect(body.top_p).toBeUndefined();
		expect(body.tool_choice).toBeUndefined();
		expect(body.generation_config).toEqual({
			thinking_level: "high",
			thinking_summaries: "auto",
			tool_choice: { allowed_tools: { mode: "any", tools: ["read_file"] } },
		});
		expect(body.tools).toEqual([
			{
				type: "function",
				name: "read_file",
				description: "Reads a workspace file.",
				parameters: expect.objectContaining({ type: "object", required: ["path"] }),
			},
		]);
		const input = body.input as Record<string, unknown>[];
		expect(input[0]).toEqual({
			type: "user_input",
			content: [
				{ type: "text", text: "Look at this" },
				{ type: "image", mime_type: "image/png", data: PNG },
			],
		});
		// Own turn: the signed thought replays ahead of the call it signs; the call carries no sentinel.
		expect(input[1]).toEqual({
			type: "thought",
			signature: SIG_CALL,
			summary: [{ type: "text", text: "Reading the file first." }],
		});
		expect(input[2]).toEqual({
			type: "function_call",
			id: "call_1",
			name: "read_file",
			arguments: { path: "src/auth.py" },
		});
		expect(input[3]).toEqual({
			type: "function_result",
			call_id: "call_1",
			name: "read_file",
			result: "def f(): ...",
			is_error: false,
		});
		// Foreign turn: its thinking becomes text (never a thought step), its call gets the skip sentinel.
		expect(input[4]).toMatchObject({ type: "model_output" });
		expect(JSON.stringify(input[4])).toContain("Check the screenshot.");
		expect(input[5]).toMatchObject({
			type: "function_call",
			name: "read_file",
			signature: "skip_thought_signature_validator",
		});
		expect(input[6]).toMatchObject({
			type: "function_result",
			name: "read_file",
			is_error: true,
			result: [
				{ type: "text", text: "binary file" },
				{ type: "image", mime_type: "image/png", data: PNG },
			],
		});
		expect(input).toHaveLength(7);
		expect(captured.headers[0]!.get("authorization")).toBe("Bearer ya29.token");
		expect(captured.headers[0]!.get("user-agent")).toMatch(/^omp\//);
	});

	it("keeps omp's User-Agent when caller headers try to replace it", async () => {
		const { fetch, captured } = scripted([() => sse(SUMMARY_TURN)]);

		await streamGoogleInteractions(hydrogen, userTurn, {
			apiKey: "k",
			fetch,
			headers: { "User-Agent": "spoofed/1.0" },
		}).result();

		expect(captured.headers[0]!.get("user-agent")).toMatch(/^omp\/\d/);
	});

	it("maps reasoning-off to the model's lowest level and forwards an explicit output cap", async () => {
		const { fetch, captured } = scripted([() => sse(SUMMARY_TURN)]);

		await streamSimple(flashLite, userTurn, { apiKey: "k", fetch, disableReasoning: true, maxTokens: 4096 }).result();

		expect(captured.bodies[0]!.generation_config).toEqual({
			thinking_level: "minimal",
			thinking_summaries: "auto",
			max_output_tokens: 4096,
		});
	});
});

describe("Gemini Interactions stream", () => {
	it("folds a signed thought and a streamed call into a tool-use turn whose replay keeps the signature", async () => {
		const first = scripted([() => sse(TOOL_CALL_TURN)]);
		const stream = streamGoogleInteractions(hydrogen, userTurn, {
			apiKey: "k",
			fetch: first.fetch,
			thinkingLevel: Effort.Low,
		});
		const events = await drain(stream);
		const message = await stream.result();

		expect(message.stopReason).toBe("toolUse");
		expect(message.content).toEqual([
			{ type: "thinking", thinking: "", thinkingSignature: SIG_CALL, summary: true },
			{ type: "toolCall", id: "call_14541487277061560791", name: "read_file", arguments: { path: "src/auth.py" } },
		]);
		expect(events.filter(event => event.type === "toolcall_delta").map(event => event.delta)).toEqual([
			'{"path":"src/auth.py"}',
		]);
		expect(message.usage).toMatchObject({
			input: 110,
			output: 74,
			cacheRead: 0,
			totalTokens: 184,
			reasoningTokens: 48,
		});

		const second = scripted([() => sse(SUMMARY_TURN)]);
		await streamGoogleInteractions(
			hydrogen,
			{
				...userTurn,
				messages: [
					...userTurn.messages,
					message,
					{
						role: "toolResult",
						toolCallId: "call_14541487277061560791",
						toolName: "read_file",
						content: [{ type: "text", text: "ok" }],
						isError: false,
						timestamp: 3,
					},
				],
			},
			{ apiKey: "k", fetch: second.fetch, thinkingLevel: Effort.Low },
		).result();
		expect((second.captured.bodies[0]!.input as unknown[]).slice(1, 3)).toEqual([
			{ type: "thought", signature: SIG_CALL },
			{
				type: "function_call",
				id: "call_14541487277061560791",
				name: "read_file",
				arguments: { path: "src/auth.py" },
			},
		]);
	});

	it("streams a thought summary as thinking and ends a completed answer as stop with cached usage", async () => {
		const { fetch } = scripted([() => sse(SUMMARY_TURN)]);
		const stream = streamGoogleInteractions(hydrogen, userTurn, { apiKey: "k", fetch, thinkingLevel: Effort.High });
		const events = await drain(stream);
		const message = await stream.result();

		expect(events.filter(event => event.type === "thinking_delta").map(event => event.delta)).toEqual([
			"**Listing Prime Numbers**\n\n",
		]);
		expect(message.content).toEqual([
			{ type: "thinking", thinking: "**Listing Prime Numbers**\n\n", thinkingSignature: SIG_SUMMARY, summary: true },
			{ type: "text", text: "17" },
		]);
		expect(message.stopReason).toBe("stop");
		expect(message.usage).toMatchObject({ input: 30, cacheRead: 20, output: 552 });
	});

	it("maps an incomplete interaction to a length stop", async () => {
		const truncated = SUMMARY_TURN.replace('"status":"completed"', '"status":"incomplete"');
		const { fetch } = scripted([() => sse(truncated)]);

		const message = await streamGoogleInteractions(hydrogen, userTurn, { apiKey: "k", fetch }).result();

		expect(message.stopReason).toBe("length");
	});

	it("fails a stream that ends before interaction.completed instead of returning a truncated success", async () => {
		const interrupted = TOOL_CALL_TURN.slice(0, TOOL_CALL_TURN.indexOf("event: interaction.completed"));
		const { fetch, captured } = scripted([() => sse(interrupted)]);

		const message = await streamGoogleInteractions(hydrogen, userTurn, {
			apiKey: "k",
			fetch,
			providerRetryWait: async () => {},
		}).result();

		expect(message.stopReason).toBe("error");
		expect(AIError.retriable(message.errorId)).toBe(true);
		// Output already streamed (the call's arguments), so the transport does not replay it.
		expect(captured.bodies).toHaveLength(1);
	});

	it("surfaces an in-stream error frame and a failed interaction as errors", async () => {
		const errorFrame = `${created}event: error\ndata: ${JSON.stringify({
			error: {
				message: "Function call is missing a thought_signature in functionCall parts.",
				code: "invalid_request",
			},
			event_type: "error",
		})}\n\n`;
		const failed = SUMMARY_TURN.replace('"status":"completed"', '"status":"failed"');

		const errored = await streamGoogleInteractions(hydrogen, userTurn, {
			apiKey: "k",
			fetch: scripted([() => sse(errorFrame)]).fetch,
			providerRetryWait: async () => {},
		}).result();
		const failedTurn = await streamGoogleInteractions(hydrogen, userTurn, {
			apiKey: "k",
			fetch: scripted([() => sse(failed)]).fetch,
		}).result();

		expect(errored.stopReason).toBe("error");
		expect(errored.errorMessage).toContain("missing a thought_signature");
		expect(failedTurn.stopReason).toBe("error");
		expect(failedTurn.errorMessage).toContain("failed");
	});
});

describe("Gemini Interactions errors", () => {
	const noWait = { providerRetryWait: async () => {} };

	it("reads an SSE-framed rejection body and denies only the named model", async () => {
		const body = `event: error\ndata: ${JSON.stringify({
			error: {
				message: "Model gemini-4-argon is not supported for per-user quota requests.",
				code: "invalid_request",
			},
			event_type: "error",
		})}\n\n`;
		const argon = hostModel("gemini-4-argon");
		const { fetch } = scripted([
			() => new Response(body, { status: 400, headers: { "content-type": "application/json" } }),
		]);

		const message = await streamGoogleInteractions(argon, userTurn, { apiKey: "k", fetch, ...noWait }).result();
		const error = new AIError.ProviderHttpError(message.errorMessage ?? "", message.errorStatus ?? 0);

		expect(message.errorMessage).toBe(
			"Gemini API error (400 invalid_request): Model gemini-4-argon is not supported for per-user quota requests.",
		);
		expect(AIError.isModelEntitlementDenial(error, "gemini-host", "gemini-4-argon")).toBe(true);
		expect(AIError.isModelEntitlementDenial(error, "gemini-host", "gemini-4-hydrogen")).toBe(false);
	});

	it("pauses on a daily cap: one request, a reset time, no upgrade link, and a credential-level quota", async () => {
		const { fetch, captured } = scripted([
			() =>
				jsonError(
					429,
					"Rate limit exceeded for model gemini-4-hydrogen (tokens per day). Please retry in 5h18m24s or upgrade your tier at https://ai.dev/rate-limit.",
					"too_many_requests",
					{ "retry-after": "19104" },
				),
		]);

		const message = await streamGoogleInteractions(hydrogen, userTurn, { apiKey: "k", fetch, ...noWait }).result();
		const error = new AIError.ProviderHttpError(message.errorMessage ?? "", 429);

		expect(captured.bodies).toHaveLength(1);
		expect(message.errorMessage).toContain("resets in 5h18m");
		expect(message.errorMessage).not.toContain("ai.dev/rate-limit");
		expect(AIError.isUsageLimit(error)).toBe(true);
		expect(AIError.isProviderRetryableError(error)).toBe(false);
	});

	it("treats a zero daily allowance as a model refusal rather than a quota that resets", async () => {
		const { fetch } = scripted([
			() =>
				jsonError(
					429,
					"Rate limit exceeded for model gemini-4-neon (limit: 0 tokens per day). Please upgrade your tier at https://ai.dev/rate-limit.",
					"too_many_requests",
				),
		]);
		const neon = hostModel("gemini-4-neon");

		const message = await streamGoogleInteractions(neon, userTurn, { apiKey: "k", fetch, ...noWait }).result();
		const error = new AIError.ProviderHttpError(message.errorMessage ?? "", 429);

		expect(AIError.isModelEntitlementDenial(error, "gemini-host", "gemini-4-neon")).toBe(true);
	});

	it("keeps a per-minute 429 transient and retries it in the transport", async () => {
		const { fetch, captured } = scripted([
			() => jsonError(429, "Too many requests, please slow down.", "too_many_requests", { "retry-after": "0" }),
			() => sse(SUMMARY_TURN),
		]);

		const message = await streamGoogleInteractions(hydrogen, userTurn, { apiKey: "k", fetch, ...noWait }).result();

		expect(captured.bodies).toHaveLength(2);
		expect(message.stopReason).toBe("stop");
	});

	it.each([
		[
			"SERVICE_DISABLED",
			JSON.stringify({
				error: {
					code: 403,
					message: "Generative Language API has not been used in project 1234 before or it is disabled.",
					status: "PERMISSION_DENIED",
					details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "SERVICE_DISABLED" }],
				},
			}),
		],
		[
			"an unauthorized OAuth client",
			JSON.stringify({ error: { code: 403, message: "The OAuth client is not authorized to use this API." } }),
		],
	])("treats %s as the OAuth client being off: one request, no refresh or rotation", async (_, body) => {
		const { fetch, captured } = scripted([
			() => new Response(body, { status: 403, headers: { "content-type": "application/json" } }),
		]);

		const message = await streamGoogleInteractions(hydrogen, userTurn, { apiKey: "k", fetch, ...noWait }).result();

		expect(captured.bodies).toHaveLength(1);
		expect(message.errorMessage).toContain("Google has turned off Gemini access for this sign-in");
		expect(message.errorMessage).toContain("signing in again will not help");
		expect(AIError.isAuthRetryableError(message)).toBe(false);
		expect(AIError.isAuthRetryableError(new AIError.ProviderHttpError(message.errorMessage ?? "", 403))).toBe(false);
		expect(AIError.isAccountPolicyError(message)).toBe(false);
	});

	it("spends exactly the transport's two retries on a persistent 503 and forbids any later replay", async () => {
		const { fetch, captured } = scripted([() => jsonError(503, "The model is overloaded.", "unavailable")]);

		const message = await streamGoogleInteractions(hydrogen, userTurn, {
			apiKey: "k",
			fetch,
			maxRetryDelayMs: 0,
			...noWait,
		}).result();

		expect(captured.bodies).toHaveLength(3);
		expect(message.errorStatus).toBe(503);
		expect(AIError.is(AIError.classifyMessage(message), AIError.Flag.RetriesExhausted)).toBe(true);
		expect(AIError.retriable(AIError.classifyMessage(message))).toBe(false);
	});

	it("waits out the first-use permission propagation 403 on the same credential", async () => {
		const { fetch, captured } = scripted([
			() =>
				jsonError(
					403,
					"Caller does not have required permission to use project mimetic-rope-tkpm1. Grant the caller the roles/serviceusage.serviceUsageConsumer role. Propagation of the new permission may take a few minutes.",
					"permission_denied",
				),
			() => sse(SUMMARY_TURN),
		]);
		const waits: number[] = [];

		const message = await streamGoogleInteractions(hydrogen, userTurn, {
			apiKey: "k",
			fetch,
			providerRetryWait: async delayMs => {
				waits.push(delayMs);
			},
		}).result();

		expect(message.stopReason).toBe("stop");
		expect(captured.bodies).toHaveLength(2);
		expect(waits).toHaveLength(1);
	});
});
