/**
 * Anthropic advisor tool (`advisor_20260301`, beta `advisor-tool-2026-03-01`).
 *
 * Contracts:
 *   • The tool rides only on a pairing the catalog accepts for the request's
 *     model, with its beta; any other pairing sends neither.
 *   • Streamed advisor blocks persist as replayable server-tool history and
 *     replay verbatim, with the beta, even after the advisor is turned off.
 *   • A pending advisor call (`pause_turn`) resumes as the last message when
 *     the tool rides, and is dropped when it does not (the API rejects it).
 *   • Advisor sub-inference tokens are priced at the advisor model's rates.
 */
import { describe, expect, it } from "bun:test";
import { streamAnthropic } from "@oh-my-pi/pi-ai/providers/anthropic";
import type { AssistantMessage, Context, Model } from "@oh-my-pi/pi-ai/types";
import { requestBodyText } from "@oh-my-pi/pi-ai/utils/request-body";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { withOfficialAnthropicEndpoint } from "./helpers";

const ADVISOR_BETA = "advisor-tool-2026-03-01";

function anthropicModel(id: string, cost: Model["cost"]): Model<"anthropic-messages"> {
	return buildModel({
		id,
		name: id,
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning: true,
		input: ["text"],
		cost,
		contextWindow: 1_000_000,
		maxTokens: 128_000,
	});
}

const opus = anthropicModel("claude-opus-5-5", { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 });
const fable = anthropicModel("claude-fable-5-2", { input: 8, output: 40, cacheRead: 0.2, cacheWrite: 10 });

const userTurn: Context["messages"][number] = { role: "user", content: "Refactor the parser.", timestamp: 1 };

function assistantTurn(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"] = "stop") {
	return {
		role: "assistant",
		content,
		timestamp: 2,
		provider: "anthropic",
		model: opus.id,
		api: "anthropic-messages",
		stopReason,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	} satisfies AssistantMessage;
}

const advisorCall = { type: "server_tool_use", id: "srvtoolu_adv1", name: "advisor", input: {} } as const;
const advisorResult = {
	type: "advisor_tool_result",
	tool_use_id: "srvtoolu_adv1",
	content: { type: "advisor_redacted_result", encrypted_content: "EqQBCkYIBRgC" },
} as const;

type Captured = { beta: string[]; payload: Record<string, unknown>; message: AssistantMessage };

async function capture(
	model: Model<"anthropic-messages">,
	messages: Context["messages"],
	options: Parameters<typeof streamAnthropic>[2] = {},
	events?: Record<string, unknown>[],
): Promise<Captured> {
	let beta: string[] = [];
	let payload: Record<string, unknown> = {};
	const fetchMock: typeof fetch = Object.assign(
		async (_input: string | URL | Request, init?: RequestInit) => {
			beta = (new Headers(init?.headers).get("anthropic-beta") ?? "").split(",").map(value => value.trim());
			payload = JSON.parse(requestBodyText(init) ?? "{}");
			if (events) {
				return new Response(
					events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
					{ headers: { "content-type": "text/event-stream" } },
				);
			}
			return new Response(
				JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "x" } }),
				{
					status: 400,
					headers: { "content-type": "application/json" },
				},
			);
		},
		{ preconnect: fetch.preconnect },
	);
	const message = await streamAnthropic(
		model,
		{ systemPrompt: ["Be precise."], messages },
		{ apiKey: "sk-ant-test", ...options, fetch: fetchMock },
	).result();
	return { beta, payload, message };
}

function wireTools(payload: Record<string, unknown>): Record<string, unknown>[] {
	return (payload.tools as Record<string, unknown>[] | undefined) ?? [];
}

/** Wire messages without prompt-cache breakpoints, which ride on whichever block ends the tail. */
function wireMessages(payload: Record<string, unknown>): { role: string; content: unknown }[] {
	return JSON.parse(JSON.stringify(payload.messages), (key, value) => (key === "cache_control" ? undefined : value));
}

describe("anthropic advisor tool", () => {
	withOfficialAnthropicEndpoint();

	it("attaches the tool and beta when the catalog accepts the pairing", async () => {
		const { beta, payload } = await capture(opus, [userTurn], { advisor: { model: "fable" } });

		expect(beta).toContain(ADVISOR_BETA);
		expect(wireTools(payload).at(-1)).toEqual({
			type: "advisor_20260301",
			name: "advisor",
			model: "claude-fable-5-2",
		});
	});

	it("sends neither tool nor beta for a pairing the API would reject", async () => {
		// Fable 5.2 accepts only Fable/Mythos 5.2 advisors.
		const { beta, payload } = await capture(fable, [userTurn], { advisor: { model: "opus" } });

		expect(beta).not.toContain(ADVISOR_BETA);
		expect(wireTools(payload).some(tool => tool.type === "advisor_20260301")).toBe(false);
	});

	it("persists streamed advisor blocks and replays them verbatim after the advisor is turned off", async () => {
		const streamed = await capture(opus, [userTurn], { advisor: { model: "fable" } }, [
			{ type: "message_start", message: { id: "msg_1", model: opus.id, usage: { input_tokens: 10 } } },
			{ type: "content_block_start", index: 0, content_block: advisorCall },
			{ type: "content_block_stop", index: 0 },
			{ type: "content_block_start", index: 1, content_block: advisorResult },
			{ type: "content_block_stop", index: 1 },
			{ type: "content_block_start", index: 2, content_block: { type: "text", text: "" } },
			{ type: "content_block_delta", index: 2, delta: { type: "text_delta", text: "Plan set." } },
			{ type: "content_block_stop", index: 2 },
			{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } },
			{ type: "message_stop" },
		]);
		expect(streamed.message.stopReason).toBe("stop");
		expect(JSON.parse(JSON.stringify(streamed.message.content))).toEqual([
			{ type: "anthropicServerTool", block: advisorCall },
			{ type: "anthropicServerTool", block: advisorResult },
			{ type: "text", text: "Plan set." },
		]);

		const replay = await capture(opus, [
			userTurn,
			streamed.message,
			{ role: "user", content: "Continue with tests.", timestamp: 3 },
		]);
		expect(replay.beta).toContain(ADVISOR_BETA);
		expect(wireTools(replay.payload).some(tool => tool.type === "advisor_20260301")).toBe(false);
		expect(wireMessages(replay.payload)[1]).toEqual({
			role: "assistant",
			content: [advisorCall, advisorResult, { type: "text", text: "Plan set." }],
		});
	});

	it("resumes a turn paused on a pending advisor call when the tool rides", async () => {
		const paused = assistantTurn([
			{ type: "text", text: "Checking." },
			{ type: "anthropicServerTool", block: advisorCall },
		]);

		const { payload } = await capture(opus, [userTurn, paused], { advisor: { model: "fable" } });

		const messages = wireMessages(payload);
		expect(messages.at(-1)).toEqual({
			role: "assistant",
			content: [{ type: "text", text: "Checking." }, advisorCall],
		});
	});

	it("drops a pending advisor call when the request carries no advisor tool", async () => {
		const paused = assistantTurn([
			{ type: "text", text: "Checking." },
			{ type: "anthropicServerTool", block: advisorCall },
		]);

		const { payload } = await capture(opus, [userTurn, paused]);

		const messages = wireMessages(payload);
		expect(messages[1]).toEqual({ role: "assistant", content: [{ type: "text", text: "Checking." }] });
		expect(messages.at(-1)?.role).toBe("user");
	});

	it("prices the advisor sub-inference at the advisor model's rates", async () => {
		const { message } = await capture(opus, [userTurn], { advisor: { model: "fable" } }, [
			{ type: "message_start", message: { id: "msg_2", model: opus.id, usage: { input_tokens: 0 } } },
			{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
			{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Done." } },
			{ type: "content_block_stop", index: 0 },
			{
				type: "message_delta",
				delta: { stop_reason: "end_turn" },
				usage: {
					input_tokens: 2000,
					output_tokens: 400,
					cache_read_input_tokens: 0,
					cache_creation_input_tokens: 0,
					iterations: [
						{ type: "message", input_tokens: 1000, output_tokens: 100 },
						{ type: "advisor_message", model: "claude-fable-5-2", input_tokens: 1200, output_tokens: 600 },
						{ type: "message", input_tokens: 1000, output_tokens: 300 },
					],
				},
			},
			{ type: "message_stop" },
		]);

		// Executor (Opus 5.5): 2000 in × $5/M + 400 out × $25/M.
		// Advisor (Fable 5.2, bundled rates): 1200 in × $8/M + 600 out × $40/M.
		expect(message.usage.input).toBe(2000);
		expect(message.usage.output).toBe(400);
		expect(message.usage.cost.input).toBeCloseTo(0.01 + 0.0096, 10);
		expect(message.usage.cost.output).toBeCloseTo(0.01 + 0.024, 10);
	});
});
