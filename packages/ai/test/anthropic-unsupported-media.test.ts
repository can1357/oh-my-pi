import { describe, expect, it } from "bun:test";
import { convertAnthropicMessages, streamAnthropic } from "@oh-my-pi/pi-ai/providers/anthropic";
import type {
	AssistantMessage,
	DeveloperMessage,
	Message,
	ToolResultMessage,
	UserMessage,
} from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

// Claude reads JPEG, PNG, GIF and WebP only. A video, PDF or HEIC attached to the
// turn being answered must fail the request, not reach the model as a text stub
// it answers as if nothing were attached.

const MODEL = buildModel({
	id: "claude-haiku-5-5",
	name: "Claude Haiku 5.5",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: false,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8192,
});

let clock = 1;

function withAttachment(mimeType: string): UserMessage {
	return {
		role: "user",
		content: [
			{ type: "text", text: "what happens in this clip?" },
			{ type: "image", data: "AAAAIGZ0eXBpc29t", mimeType },
		],
		timestamp: clock++,
	};
}

function answer(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: MODEL.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: clock++,
	};
}

const followUp = (): UserMessage => ({ role: "user", content: "never mind, summarize the plan", timestamp: clock++ });

/** A `/guided-goal` kickoff: a synthetic, agent-attributed prompt carrying the user's pasted images. */
function kickoffWithAttachment(mimeType: string): DeveloperMessage {
	return {
		role: "developer",
		content: [
			{ type: "text", text: "interview the user about their goal" },
			{ type: "image", data: "AAAAIGZ0eXBpc29t", mimeType },
		],
		attribution: "agent",
		synthetic: true,
		timestamp: clock++,
	};
}

const reminder = (): DeveloperMessage => ({
	role: "developer",
	content: "<system-reminder>todo list updated</system-reminder>",
	attribution: "agent",
	timestamp: clock++,
});

function failedReply(): AssistantMessage {
	return { ...answer(""), content: [], stopReason: "error", errorMessage: "image/heic attachments are not supported" };
}

/** The stub history keeps for such an attachment: unchanged bytes, so replayed prefixes still match. */
const omitted = (mimeType: string) => ({
	type: "text" as const,
	text: `[unsupported image: ${mimeType}]`,
});

const rejection = (mimeType: string) => `${mimeType} attachments are not supported here`;

describe("anthropic media Claude cannot read", () => {
	it.each(["video/mp4", "application/pdf", "image/heic"])("fails the turn that attached %s", mimeType => {
		expect(() => convertAnthropicMessages([withAttachment(mimeType)], MODEL, false)).toThrow(rejection(mimeType));
	});

	it("still sends the image types Claude reads", () => {
		const params = convertAnthropicMessages([withAttachment("image/jpg")], MODEL, false);
		expect(params.at(-1)?.content).toContainEqual({
			type: "image",
			source: { type: "base64", media_type: "image/jpeg", data: "AAAAIGZ0eXBpc29t" },
		});
	});

	it("keeps an answered turn's attachment as a note instead of failing every later request", () => {
		const params = convertAnthropicMessages(
			[withAttachment("video/mp4"), answer("I can't see a video."), followUp()],
			MODEL,
			false,
		);
		expect(params[0]?.content).toContainEqual(omitted("video/mp4"));
	});

	it("fails a guided-goal kickoff that attached HEIC, first turn or later", () => {
		expect(() => convertAnthropicMessages([kickoffWithAttachment("image/heic")], MODEL, false)).toThrow(
			rejection("image/heic"),
		);
		expect(() =>
			convertAnthropicMessages([followUp(), answer("ok"), kickoffWithAttachment("image/heic")], MODEL, false),
		).toThrow(rejection("image/heic"));
	});

	it("still fails the user's turn when a reminder follows it", () => {
		expect(() => convertAnthropicMessages([withAttachment("image/heic"), reminder()], MODEL, false)).toThrow(
			rejection("image/heic"),
		);
	});

	it("lets the continue shortcut recover after the rejected turn", () => {
		const resume: DeveloperMessage = {
			role: "developer",
			content: "continue",
			attribution: "agent",
			synthetic: true,
			userInitiated: true,
			timestamp: clock++,
		};
		const params = convertAnthropicMessages([withAttachment("image/heic"), failedReply(), resume], MODEL, false);
		expect(params[0]?.content).toContainEqual(omitted("image/heic"));
	});

	it("never fails a compaction request on an attachment", () => {
		const params = convertAnthropicMessages([withAttachment("video/mp4")], MODEL, false, {
			compactionRequest: { filesDueBefore: 0 },
		});
		expect(params[0]?.content).toContainEqual(omitted("video/mp4"));
	});

	it("notes a tool result's attachment instead of failing the turn", () => {
		const call: AssistantMessage = {
			...answer(""),
			content: [{ type: "toolCall", id: "toolu_1", name: "read", arguments: {} }],
			stopReason: "toolUse",
		};
		const result: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "toolu_1",
			toolName: "read",
			content: [{ type: "image", data: "AAAAIGZ0eXBpc29t", mimeType: "video/mp4" }],
			isError: false,
			timestamp: clock++,
		};
		const params = convertAnthropicMessages([followUp(), call, result], MODEL, false);
		expect(params.at(-1)?.content).toContainEqual(
			expect.objectContaining({ type: "tool_result", content: [omitted("video/mp4")] }),
		);
	});

	it("reports the rejection as a stream error without sending a request", async () => {
		let sent = false;
		const message = await streamAnthropic(
			MODEL,
			{ messages: [withAttachment("video/mp4")] satisfies Message[] },
			{
				apiKey: "sk-ant-api-test",
				fetch: async () => {
					sent = true;
					return Response.json(
						{ type: "error", error: { type: "invalid_request_error", message: "unexpected request" } },
						{ status: 400 },
					);
				},
			},
		).result();
		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toContain(rejection("video/mp4"));
		expect(sent).toBe(false);
	});
});
