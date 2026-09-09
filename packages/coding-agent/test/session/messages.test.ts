import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import {
	buildReplanTitleContext,
	type CustomMessage,
	convertToLlm,
	INTERRUPTED_THINKING_MESSAGE_TYPE,
	replaceLlmImagesWithText,
	SKILL_PROMPT_MESSAGE_TYPE,
	type SkillPromptDetails,
	stripImagesFromMessage,
} from "../../src/session/messages";

function customMessage(customType: string, attribution: "agent" | "user"): CustomMessage<SkillPromptDetails> {
	return {
		role: "custom",
		customType,
		content: "Use this skill.",
		display: true,
		details: { name: "atomic-commit", path: "/tmp/SKILL.md", lineCount: 1 },
		attribution,
		timestamp: 1,
	};
}

const interruptedUsage: AssistantMessage["usage"] = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function abortedAssistant(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: interruptedUsage,
		stopReason: "aborted",
		timestamp: 1,
	};
}

function interruptedThinkingContinuity(): CustomMessage {
	return {
		role: "custom",
		customType: INTERRUPTED_THINKING_MESSAGE_TYPE,
		content: "preserved reasoning",
		display: false,
		attribution: "agent",
		timestamp: 2,
	};
}

describe("convertToLlm", () => {
	it("presents user-invoked skill prompts as user turns", () => {
		const [message] = convertToLlm([customMessage(SKILL_PROMPT_MESSAGE_TYPE, "user")]);

		expect(message?.role).toBe("user");
		if (message?.role !== "user") {
			throw new Error(`Expected user role, received ${message?.role ?? "none"}`);
		}
		expect(message.attribution).toBe("user");
	});

	it("keeps auto-applied skill prompts and other custom messages as developer turns", () => {
		const [autoSkill, otherCustom] = convertToLlm([
			customMessage(SKILL_PROMPT_MESSAGE_TYPE, "agent"),
			customMessage("extension-note", "user"),
		]);

		expect(autoSkill?.role).toBe("developer");
		expect(otherCustom?.role).toBe("developer");
	});

	it("strips the demoted trailing thinking run from the assistant LLM view when its continuity message follows", () => {
		const messages: AgentMessage[] = [
			abortedAssistant([
				{ type: "text", text: "partial answer" },
				{ type: "thinking", thinking: "interrupted reasoning" },
			]),
			interruptedThinkingContinuity(),
		];

		const llm = convertToLlm(messages);
		const assistant = llm.find(entry => entry.role === "assistant");
		expect(Array.isArray(assistant?.content) && assistant.content.map(block => block.type)).toEqual(["text"]);
		expect(llm.some(entry => entry.role === "developer")).toBe(true);
	});

	it("keeps trailing thinking on the assistant LLM view when no continuity message follows", () => {
		const messages: AgentMessage[] = [
			abortedAssistant([
				{ type: "text", text: "partial answer" },
				{ type: "thinking", thinking: "interrupted reasoning" },
			]),
		];

		const llm = convertToLlm(messages);
		const assistant = llm.find(entry => entry.role === "assistant");
		expect(Array.isArray(assistant?.content) && assistant.content.map(block => block.type)).toEqual([
			"text",
			"thinking",
		]);
	});

	it("keeps a signed (complete) trailing thinking block in the assistant LLM view even with a continuity message", () => {
		const messages: AgentMessage[] = [
			abortedAssistant([
				{ type: "text", text: "partial answer" },
				{ type: "thinking", thinking: "complete reasoning", thinkingSignature: "sig" },
			]),
			interruptedThinkingContinuity(),
		];

		const llm = convertToLlm(messages);
		const assistant = llm.find(entry => entry.role === "assistant");
		expect(Array.isArray(assistant?.content) && assistant.content.map(block => block.type)).toEqual([
			"text",
			"thinking",
		]);
	});
});

function settledAssistant(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 100,
			output: 20,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 120,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
	};
}

function userMessage(text: string, timestamp: number): AgentMessage {
	return { role: "user", content: text, attribution: "user", timestamp } as AgentMessage;
}

describe("convertToLlm caching", () => {
	it("reuses each history's outer array after another history converts", () => {
		const messages: AgentMessage[] = [userMessage("hello", 1), settledAssistant("hi")];
		const first = convertToLlm(messages);
		convertToLlm([userMessage("other", 2)]);
		const second = convertToLlm(messages);
		expect(second).toBe(first);
	});

	it("reuses the unchanged prefix output on append-only growth", () => {
		const messages: AgentMessage[] = [userMessage("one", 1), settledAssistant("reply one")];
		const first = convertToLlm(messages);
		messages.push(userMessage("two", 2));
		const grown = convertToLlm(messages);
		// New outer array (no held-result aliasing), but the converted prefix is
		// byte-identical and the appended turn is present.
		expect(grown).not.toBe(first);
		expect(grown.length).toBe(first.length + 1);
		expect(grown.slice(0, first.length)).toEqual(first);
		expect(grown[grown.length - 1]?.role).toBe("user");
	});

	it("recomputes the boundary assistant when a following interrupted-thinking marker appears on growth", () => {
		const messages: AgentMessage[] = [
			abortedAssistant([
				{ type: "text", text: "partial answer" },
				{ type: "thinking", thinking: "interrupted reasoning" },
			]),
		];
		const before = convertToLlm(messages);
		const beforeAssistant = before.find(entry => entry.role === "assistant");
		expect(Array.isArray(beforeAssistant?.content) && beforeAssistant.content.map(b => b.type)).toEqual([
			"text",
			"thinking",
		]);

		// Append the continuity marker on the same array: the assistant is now the
		// boundary message and its LLM view must drop the trailing thinking run.
		messages.push(interruptedThinkingContinuity());
		const after = convertToLlm(messages);
		const afterAssistant = after.find(entry => entry.role === "assistant");
		expect(Array.isArray(afterAssistant?.content) && afterAssistant.content.map(b => b.type)).toEqual(["text"]);
	});

	it("recomputes a message after strip-images invalidates its cache", () => {
		const withImage: AgentMessage = {
			role: "user",
			content: [
				{ type: "text", text: "look" },
				{ type: "image", data: "aaaa", mimeType: "image/png" },
			],
			attribution: "user",
			timestamp: 1,
		};
		const messages: AgentMessage[] = [withImage];
		const before = convertToLlm(messages);
		const beforeUser = before.find(entry => entry.role === "user");
		expect(Array.isArray(beforeUser?.content) && beforeUser.content.some(b => b.type === "image")).toBe(true);

		// Mutate in place through the owner seam, which must invalidate the cache.
		stripImagesFromMessage(withImage);
		const after = convertToLlm(messages);
		const afterUser = after.find(entry => entry.role === "user");
		expect(Array.isArray(afterUser?.content) && afterUser.content.some(b => b.type === "image")).toBe(false);
	});
});

describe("replaceLlmImagesWithText", () => {
	it("replaces image blocks in user, developer, and tool-result messages with the placeholder", () => {
		const converted = convertToLlm([
			{
				role: "user",
				content: [
					{ type: "text", text: "look" },
					{ type: "image", data: "aaaa", mimeType: "image/png" },
				],
				attribution: "user",
				timestamp: 1,
			},
			{
				role: "toolResult",
				toolCallId: "c1",
				toolName: "read",
				content: [{ type: "image", data: "bbbb", mimeType: "image/png" }],
				isError: false,
				timestamp: 2,
			},
		]);

		const scrubbed = replaceLlmImagesWithText(converted, "[image omitted]");

		expect(scrubbed).not.toBe(converted);
		const types = scrubbed.flatMap(m => (Array.isArray(m.content) ? m.content.map(b => b.type) : []));
		expect(types).not.toContain("image");
		const user = scrubbed.find(m => m.role === "user");
		expect(Array.isArray(user?.content) && user.content.map(b => (b.type === "text" ? b.text : b.type))).toEqual([
			"look",
			"[image omitted]",
		]);
		const toolResult = scrubbed.find(m => m.role === "toolResult");
		expect(Array.isArray(toolResult?.content) && toolResult.content).toEqual([
			{ type: "text", text: "[image omitted]" },
		]);
	});

	it("collapses consecutive image blocks into a single placeholder", () => {
		const converted = convertToLlm([
			{
				role: "user",
				content: [
					{ type: "image", data: "aaaa", mimeType: "image/png" },
					{ type: "image", data: "bbbb", mimeType: "image/png" },
				],
				attribution: "user",
				timestamp: 1,
			},
		]);

		const scrubbed = replaceLlmImagesWithText(converted, "[image omitted]");
		const user = scrubbed.find(m => m.role === "user");
		expect(Array.isArray(user?.content) && user.content).toEqual([{ type: "text", text: "[image omitted]" }]);
	});

	it("returns the same array reference when there are no image blocks", () => {
		const converted = convertToLlm([
			{ role: "user", content: [{ type: "text", text: "hi" }], attribution: "user", timestamp: 1 },
		]);

		expect(replaceLlmImagesWithText(converted, "[image omitted]")).toBe(converted);
	});
});

describe("buildReplanTitleContext", () => {
	it("titles a user skill invocation from skill args, not the expanded skill body", () => {
		const skill: CustomMessage<SkillPromptDetails> = {
			role: "custom",
			customType: SKILL_PROMPT_MESSAGE_TYPE,
			content:
				'[IMPORTANT: User invoked the "implement" skill]\n\nImplement the work described by the user.\n\nUse this skill.',
			display: true,
			details: {
				name: "implement",
				path: "/tmp/implement/SKILL.md",
				args: "issues/07-manual-llm.md 创建临时工作树实现",
				lineCount: 20,
			},
			attribution: "user",
			timestamp: 1,
		};
		const context = buildReplanTitleContext([skill, settledAssistant("先读 implement 技能、ticket 07")]);

		expect(context).toContain("07-manual-llm.md");
		expect(context).toContain("ticket 07");
		expect(context).not.toContain("Use this skill.");
		expect(context).not.toContain("IMPORTANT");
	});

	it("does not feed an autoloaded skill prompt into title context", () => {
		const skill = customMessage(SKILL_PROMPT_MESSAGE_TYPE, "agent");
		skill.details = { name: "atomic-commit", path: "/tmp/SKILL.md", lineCount: 1, args: "issues/07-manual-llm.md" };

		expect(buildReplanTitleContext([skill])).toBe("");
	});

	it("prefers the operator /skill chip over persisted name and args", () => {
		const skill: CustomMessage<SkillPromptDetails> = {
			role: "custom",
			customType: SKILL_PROMPT_MESSAGE_TYPE,
			content: "Use this skill.",
			display: true,
			details: {
				name: "implement",
				path: "/tmp/implement/SKILL.md",
				args: "issues/07-manual-llm.md",
				lineCount: 1,
				__queueChipText: "/skill:implement issues/08-app-settings.md",
			},
			attribution: "user",
			timestamp: 1,
		};
		const context = buildReplanTitleContext([skill]);

		expect(context).toContain("08-app-settings.md");
		expect(context).not.toContain("07-manual-llm.md");
	});
});
