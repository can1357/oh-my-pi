import { describe, expect, it } from "bun:test";
import { type AgentMessage, filterProviderReplayMessages } from "@oh-my-pi/pi-agent-core";
import type { ImageContent, Message, TextContent } from "@oh-my-pi/pi-ai";
import { inferCopilotInitiator } from "@oh-my-pi/pi-ai/providers/github-copilot-headers";
import {
	convertToLlm,
	SKILL_PROMPT_MESSAGE_TYPE,
	wrapSteeringForModel,
} from "@oh-my-pi/pi-coding-agent/session/messages";
import { COLLAB_PROMPT_MESSAGE_TYPE } from "@oh-my-pi/pi-wire";

function expectAttribution(message: Message | undefined, expected: "user" | "agent" | undefined): void {
	expect(message).toBeDefined();
	if (!message) return;
	if (message.role === "assistant") {
		throw new Error("Assistant messages do not expose attribution");
	}
	expect(message.attribution).toBe(expected);
}

describe("convertToLlm compaction summary", () => {
	it("appends snapcompact frames as image blocks after the summary text", () => {
		// Regression: the live session uses THIS converter (not agent-core's
		// defaultConvertToLlm). Dropping the frames here silently severs the
		// archive from the provider request — the model sees a summary that
		// references attached frames that never arrive.
		const images: ImageContent[] = [
			{ type: "image", data: "ZmFrZQ==", mimeType: "image/png" },
			{ type: "image", data: "ZmFrZTI=", mimeType: "image/png" },
		];
		const messages: AgentMessage[] = [
			{
				role: "compactionSummary",
				summary: "the film archive",
				tokensBefore: 1000,
				images,
				timestamp: Date.now(),
			},
		];

		const converted = convertToLlm(messages);

		expect(converted).toHaveLength(1);
		expect(converted[0]?.role).toBe("user");
		const content = converted[0]?.content as Array<TextContent | ImageContent>;
		expect(content).toHaveLength(3);
		expect(content[0].type).toBe("text");
		expect((content[0] as TextContent).text).toContain("the film archive");
		expect(content[1]).toEqual(images[0]);
		expect(content[2]).toEqual(images[1]);
	});

	it("emits text-only content when no frames are archived", () => {
		const messages: AgentMessage[] = [
			{ role: "compactionSummary", summary: "plain summary", tokensBefore: 1000, timestamp: Date.now() },
		];
		const converted = convertToLlm(messages);
		expect(converted[0]).toBeDefined();
		expect((converted[0]!.content as unknown[]).length).toBe(1);
	});
});

describe("assistant refusal replay policy", () => {
	it("preserves API-level Anthropic refusals for summaries but drops them from provider replay", () => {
		const messages: AgentMessage[] = [
			{ role: "user", content: [{ type: "text", text: "trigger" }], timestamp: 1 },
			{
				role: "assistant",
				content: [{ type: "text", text: "I can't assist with that request." }],
				stopReason: "error",
				stopDetails: { type: "refusal", category: "bio", explanation: "policy refusal" },
				errorMessage: "Refusal (bio): policy refusal",
				api: "anthropic",
				provider: "anthropic",
				model: "claude-opus-4",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				timestamp: 2,
			},
			{ role: "user", content: [{ type: "text", text: "recover" }], timestamp: 3 },
		];

		const converted = convertToLlm(messages);

		expect(converted.map(message => message.role)).toEqual(["user", "assistant", "user"]);
		expect(JSON.stringify(converted)).toContain("Refusal (bio)");

		const replayed = filterProviderReplayMessages(converted);
		expect(replayed.map(message => message.role)).toEqual(["user", "user"]);
		expect(JSON.stringify(replayed)).not.toContain("Refusal (bio)");
	});
});

describe("convertToLlm custom message mapping", () => {
	it("maps custom messages to developer role with explicit agent attribution", () => {
		const messages: AgentMessage[] = [
			{
				role: "custom",
				customType: "async-result",
				content: "Background task completed",
				display: true,
				attribution: "agent",
				timestamp: Date.now(),
			},
		];

		const converted = convertToLlm(messages);

		expect(converted).toHaveLength(1);
		expect(converted[0]?.role).toBe("developer");
		expectAttribution(converted[0], "agent");
		expect(inferCopilotInitiator(converted)).toBe("agent");
	});

	it("maps legacy custom messages to developer role", () => {
		const messages: AgentMessage[] = [
			{
				role: "custom",
				customType: "skill-prompt",
				content: "Run this skill with my arguments",
				display: true,
				timestamp: Date.now(),
			},
		];

		const converted = convertToLlm(messages);

		expect(converted).toHaveLength(1);
		expect(converted[0]?.role).toBe("developer");
		expectAttribution(converted[0], undefined);
		expect(inferCopilotInitiator(converted)).toBe("agent");
	});

	it("uses explicit agent attribution for custom messages", () => {
		const messages: AgentMessage[] = [
			{
				role: "custom",
				customType: "agent-reminder",
				content: "Read file",
				display: false,
				attribution: "agent",
				timestamp: Date.now(),
			},
		];

		const converted = convertToLlm(messages);

		expect(converted).toHaveLength(1);
		expect(converted[0]?.role).toBe("developer");
		expectAttribution(converted[0], "agent");
		expect(inferCopilotInitiator(converted)).toBe("agent");
	});

	it("maps file mention reminders to developer role", () => {
		const messages: AgentMessage[] = [
			{
				role: "fileMention",
				files: [{ path: "src/config.ts", content: "export const config = {};" }],
				timestamp: Date.now(),
			},
		];

		const converted = convertToLlm(messages);

		expect(converted).toHaveLength(1);
		expect(converted[0]?.role).toBe("developer");
		expectAttribution(converted[0], "user");
		if (converted[0]?.role !== "developer" || !Array.isArray(converted[0].content)) {
			throw new Error("Expected developer array content");
		}
		const text = converted[0].content.find(content => content.type === "text")?.text ?? "";
		expect(text).toContain('<file path="src/config.ts">');
		expect(text).toContain("export const config = {};");
	});

	it("splits mixed text + image file mentions into developer + user messages (#3443)", () => {
		// `developer` (and `system`) Responses messages reject `input_image` with
		// `Invalid value: 'input_image'. Supported values are: 'input_text'.`
		// `generateFileMentionMessages` packs every `@…` into one `fileMention`,
		// so a `@notes.md @diagram.png` turn would have demoted the text payload
		// to `user` (losing the instruction-priority intent) before #3443; now the
		// text-only file stays on `developer` and only the image file rides as `user`.
		const image: ImageContent = { type: "image", data: "aGVsbG8=", mimeType: "image/png" };
		const messages: AgentMessage[] = [
			{
				role: "fileMention",
				files: [
					{ path: "notes/log.txt", content: "alpha\n", lineCount: 1 },
					{ path: "diagram.png", content: "", image },
				],
				timestamp: Date.now(),
			},
		];

		const converted = convertToLlm(messages);

		expect(converted).toHaveLength(2);

		const dev = converted[0];
		expect(dev?.role).toBe("developer");
		expectAttribution(dev, "user");
		if (dev?.role !== "developer" || !Array.isArray(dev.content)) {
			throw new Error("Expected developer array content for text mention");
		}
		const devText = dev.content.find(content => content.type === "text")?.text ?? "";
		expect(devText).toContain('<file path="notes/log.txt">');
		expect(devText).toContain("alpha");
		expect(devText).not.toContain('<file path="diagram.png">');
		expect(dev.content.some(content => content.type === "image")).toBe(false);

		const user = converted[1];
		expect(user?.role).toBe("user");
		expectAttribution(user, "user");
		if (user?.role !== "user" || !Array.isArray(user.content)) {
			throw new Error("Expected user array content for image mention");
		}
		const userText = user.content.find(content => content.type === "text")?.text ?? "";
		expect(userText).toContain('<file path="diagram.png">');
		expect(userText).not.toContain('<file path="notes/log.txt">');
		expect(user.content.filter(content => content.type === "image")).toEqual([image]);
	});

	it("emits a user-only message when every mention is an image (#3443)", () => {
		const image: ImageContent = { type: "image", data: "aGVsbG8=", mimeType: "image/png" };
		const messages: AgentMessage[] = [
			{
				role: "fileMention",
				files: [{ path: "screenshot.png", content: "", image }],
				timestamp: Date.now(),
			},
		];

		const converted = convertToLlm(messages);

		expect(converted).toHaveLength(1);
		expect(converted[0]?.role).toBe("user");
		if (converted[0]?.role !== "user" || !Array.isArray(converted[0].content)) {
			throw new Error("Expected user array content");
		}
		expect(converted[0].content.filter(content => content.type === "image")).toEqual([image]);
	});

	it("keeps non-skill user-attributed custom messages on the developer role", () => {
		const messages: AgentMessage[] = [
			{
				role: "custom",
				customType: "ultrathink-notice",
				content: "User requested deeper reasoning",
				display: true,
				attribution: "user",
				timestamp: Date.now(),
			},
		];

		const converted = convertToLlm(messages);

		expect(converted).toHaveLength(1);
		expect(converted[0]?.role).toBe("developer");
		expectAttribution(converted[0], "user");
		expect(inferCopilotInitiator(converted)).toBe("user");
	});

	it("maps user-invoked skill prompts to the user role", () => {
		const messages: AgentMessage[] = [
			{
				role: "custom",
				customType: SKILL_PROMPT_MESSAGE_TYPE,
				content: "Run this skill with my arguments",
				display: true,
				attribution: "user",
				timestamp: Date.now(),
			},
		];

		const converted = convertToLlm(messages);

		expect(converted).toHaveLength(1);
		expect(converted[0]?.role).toBe("user");
		expectAttribution(converted[0], "user");
		expect(inferCopilotInitiator(converted)).toBe("user");
		if (converted[0]?.role !== "user" || !Array.isArray(converted[0].content)) {
			throw new Error("Expected user array content");
		}
		const text = converted[0].content.find(content => content.type === "text")?.text ?? "";
		expect(text).toContain("Run this skill with my arguments");
	});

	it("keeps user-invoked skill prompt images in the user message", () => {
		const image: ImageContent = { type: "image", data: "c2tpbGw=", mimeType: "image/png" };
		const messages: AgentMessage[] = [
			{
				role: "custom",
				customType: SKILL_PROMPT_MESSAGE_TYPE,
				content: [{ type: "text", text: "Skill body" }, image],
				display: true,
				attribution: "user",
				timestamp: Date.now(),
			},
		];

		const converted = convertToLlm(messages);

		expect(converted).toHaveLength(1);
		expect(converted[0]?.role).toBe("user");
		expectAttribution(converted[0], "user");
		if (converted[0]?.role !== "user" || !Array.isArray(converted[0].content)) {
			throw new Error("Expected user skill content");
		}
		expect(converted[0].content).toEqual([{ type: "text", text: "Skill body" }, image]);
	});

	it("routes non-user custom-message images through a user message", () => {
		const image: ImageContent = { type: "image", data: "YWR2aXNvcg==", mimeType: "image/png" };
		const messages: AgentMessage[] = [
			{
				role: "custom",
				customType: "advisor",
				content: [{ type: "text", text: "Advisor body" }, image],
				display: true,
				attribution: "agent",
				timestamp: Date.now(),
			},
		];

		const converted = convertToLlm(messages);

		expect(converted.map(message => message.role)).toEqual(["developer", "user"]);
		expectAttribution(converted[0], "agent");
		expectAttribution(converted[1], "agent");
		if (converted[0]?.role !== "developer" || !Array.isArray(converted[0].content)) {
			throw new Error("Expected developer custom text");
		}
		expect(converted[0].content).toEqual([{ type: "text", text: "Advisor body" }]);
		if (converted[1]?.role !== "user" || !Array.isArray(converted[1].content)) {
			throw new Error("Expected user custom images");
		}
		expect(converted[1].content.filter(content => content.type === "image")).toEqual([image]);
	});
});

function getUserText(message: AgentMessage | undefined): string {
	expect(message).toBeDefined();
	if (message?.role !== "user") {
		throw new Error("Expected user message");
	}
	if (typeof message.content === "string") {
		return message.content;
	}
	const text = message.content.find(content => content.type === "text");
	if (!text) {
		throw new Error("Expected text content");
	}
	return text.text;
}

describe("wrapSteeringForModel", () => {
	it("wraps trailing steering text for the model without escaping user code", () => {
		const rawText = "Use <tag> & keep it literal";
		const message: AgentMessage = {
			role: "user",
			content: [{ type: "text", text: rawText }],
			steering: true,
			timestamp: 1,
		};
		const messages = [message];

		const wrapped = wrapSteeringForModel(messages);

		expect(wrapped).not.toBe(messages);
		expect(wrapped[0]).not.toBe(message);
		expect(message.content).toEqual([{ type: "text", text: rawText }]);
		const wrappedText = getUserText(wrapped[0]);
		expect(wrappedText).toContain("<system-notice>");
		expect(wrappedText).not.toContain("<message>");
		expect(wrappedText).toContain("Use <tag> & keep it literal");
		expect(wrappedText).not.toContain("&lt;tag&gt;");
		expect(wrappedText).not.toContain("&amp;");
	});

	it("presents user-attributed collab prompts as wrapped user turns on every conversion path", () => {
		const message: AgentMessage = {
			role: "custom",
			customType: COLLAB_PROMPT_MESSAGE_TYPE,
			content: "Reply with exactly PONG",
			display: true,
			details: { from: "guest" },
			attribution: "user",
			timestamp: 1,
		};

		const directlyConverted = convertToLlm([message]);
		const wrapped = wrapSteeringForModel([message]);
		const primaryProviderMessages = convertToLlm(wrapped);

		expect(directlyConverted).toHaveLength(1);
		expect(directlyConverted[0]?.role).toBe("user");
		expect(getUserText(directlyConverted[0])).toContain("<system-notice>");
		expect(getUserText(directlyConverted[0])).toContain("Reply with exactly PONG");
		expect(wrapped[0]?.role).toBe("user");
		expect(getUserText(wrapped[0])).toContain("<system-notice>");
		expect(getUserText(wrapped[0])).toContain("Reply with exactly PONG");
		expect(primaryProviderMessages).toHaveLength(1);
		expect(primaryProviderMessages[0]?.role).toBe("user");
		expect(message).toMatchObject({
			role: "custom",
			details: { from: "guest" },
		});
	});

	it("wraps buried steering messages too so wire bytes stay stable across turns", () => {
		const buried: AgentMessage = {
			role: "user",
			content: "old steer",
			steering: true,
			timestamp: 1,
		};
		const later: AgentMessage = { role: "user", content: "later", timestamp: 2 };
		const messages = [buried, later];

		const wrapped = wrapSteeringForModel(messages);

		// Buried steer is rewritten (enveloped) just like a trailing one, so its wire
		// bytes are identical whether it is the tail (turn N) or buried (turn N+1) —
		// the cached prefix stays valid instead of busting on the turn after a steer.
		expect(wrapped).not.toBe(messages);
		expect(wrapped[0]).not.toBe(buried);
		expect(getUserText(wrapped[0])).toContain("<system-notice>");
		expect(getUserText(wrapped[0])).toContain("old steer");
		// Non-steering trailing message is untouched, and the persisted steer is not mutated.
		expect(wrapped[1]).toBe(later);
		expect(buried.content).toBe("old steer");
	});

	it("leaves trailing user messages without the steering marker unchanged", () => {
		const message: AgentMessage = { role: "user", content: "plain user", timestamp: 1 };
		const messages = [message];

		const wrapped = wrapSteeringForModel(messages);

		expect(wrapped).toBe(messages);
		expect(wrapped[0]).toBe(message);
	});

	it("preserves images after the wrapped steering text", () => {
		const image: ImageContent = { type: "image", data: "abc123", mimeType: "image/png" };
		const message: AgentMessage = {
			role: "user",
			content: [{ type: "text", text: "look at this" }, image],
			steering: true,
			timestamp: 1,
		};

		const wrapped = wrapSteeringForModel([message]);

		const wrappedMessage = wrapped[0];
		if (wrappedMessage?.role !== "user" || typeof wrappedMessage.content === "string") {
			throw new Error("Expected user array content");
		}
		expect(wrappedMessage.content[0]?.type).toBe("text");
		expect(wrappedMessage.content[1]).toBe(image);
	});

	it("wraps every message in the trailing steering run", () => {
		const first: AgentMessage = { role: "user", content: "first steer", steering: true, timestamp: 1 };
		const second: AgentMessage = { role: "user", content: "second steer", steering: true, timestamp: 2 };
		const messages = [first, second];

		const wrapped = wrapSteeringForModel(messages);

		expect(wrapped).not.toBe(messages);
		expect(wrapped[0]).not.toBe(first);
		expect(wrapped[1]).not.toBe(second);
		expect(getUserText(wrapped[0])).toContain("first steer");
		expect(getUserText(wrapped[1])).toContain("second steer");
	});
});
