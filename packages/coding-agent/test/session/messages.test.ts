import { describe, expect, it } from "bun:test";
import { type AgentMessage, filterProviderReplayMessages } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import {
	buildReplanTitleContext,
	buildTitleDriftTurns,
	type CustomMessage,
	convertMessagesForContextView,
	convertToLlm,
	dedupeEphemeralReply,
	INTERRUPTED_THINKING_MESSAGE_TYPE,
	replaceLlmImagesWithText,
	SKILL_PROMPT_MESSAGE_TYPE,
	type SkillPromptDetails,
	stripImagesFromMessage,
	wrapSteeringForModel,
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
	it("keeps auto-applied skill prompts and other custom messages as developer turns", () => {
		const [autoSkill, otherCustom] = convertToLlm([
			customMessage(SKILL_PROMPT_MESSAGE_TYPE, "agent"),
			customMessage("extension-note", "user"),
		]);

		expect(autoSkill?.role).toBe("developer");
		expect(otherCustom?.role).toBe("developer");
	});

	it("replays tool calls saved under an xd:// alias by their bare device name", () => {
		const saved = {
			...abortedAssistant([{ type: "toolCall", id: "call_1|fc_1", name: "xd://recall", arguments: { q: "x" } }]),
			stopReason: "toolUse",
		} satisfies AssistantMessage;
		const [assistant, result] = convertToLlm([
			saved,
			{
				role: "toolResult",
				toolCallId: "call_1|fc_1",
				toolName: "xd://recall",
				content: [{ type: "text", text: "remembered" }],
				isError: false,
				timestamp: 2,
			},
		]);

		expect(assistant?.role === "assistant" && assistant.content).toEqual([
			{ type: "toolCall", id: "call_1|fc_1", name: "recall", arguments: { q: "x" } },
		]);
		expect(result?.role === "toolResult" && [result.toolCallId, result.toolName]).toEqual(["call_1|fc_1", "recall"]);
		// Persisted history stays untouched; only the provider view is canonical.
		expect(saved.content[0]).toMatchObject({ name: "xd://recall" });
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

describe("convertMessagesForContextView", () => {
	it("shows the model envelope for user steering without wrapping the production path twice", () => {
		const source: AgentMessage = {
			role: "user",
			content: "Use the revised plan",
			steering: true,
			timestamp: 1,
		};
		const messages = [source];
		const wrapped = wrapSteeringForModel(messages);
		const production = convertToLlm(wrapped);
		const viewed = convertMessagesForContextView(messages);

		expect(viewed.map(entry => entry.message)).toEqual(production);
		expect(viewed[0]).toMatchObject({ sourceIndex: 0, convertedIndex: 0 });
		const content = production[0].content;
		if (typeof content !== "string") throw new Error("Expected string steering content");
		expect(content).toContain("Use the revised plan");
		expect(content.match(/<system-notice>/g)).toHaveLength(1);
		// Callers that skip `wrapSteeringForModel` (compaction serialization, side requests) keep the raw text.
		expect(convertToLlm(messages)[0].content).toBe("Use the revised plan");
		expect(convertToLlm(wrapSteeringForModel(wrapped))).toEqual(production);
		expect(convertMessagesForContextView(wrapped).map(entry => entry.message)).toEqual(production);
		expect(source).toEqual({
			role: "user",
			content: "Use the revised plan",
			steering: true,
			timestamp: 1,
		});
	});

	it("maps source indices across omitted messages and image-bearing splits", () => {
		const image = { type: "image" as const, data: "aaaa", mimeType: "image/png" };
		const messages: AgentMessage[] = [
			userMessage("question", 1),
			{
				role: "bashExecution",
				command: "private",
				output: "",
				exitCode: 0,
				cancelled: false,
				truncated: false,
				excludeFromContext: true,
				timestamp: 2,
			},
			{
				role: "fileMention",
				files: [
					{ path: "notes.txt", content: "notes" },
					{ path: "picture.png", content: "", image },
				],
				timestamp: 3,
			},
			{
				...customMessage("extension-note", "agent"),
				content: [{ type: "text", text: "attachment" }, image],
			},
			settledAssistant("answer"),
		];

		const converted = convertMessagesForContextView(messages);
		expect(
			converted.map(({ sourceIndex, convertedIndex, message }) => [sourceIndex, convertedIndex, message.role]),
		).toEqual([
			[0, 0, "user"],
			[2, 1, "developer"],
			[2, 2, "user"],
			[3, 3, "developer"],
			[3, 4, "user"],
			[4, 5, "assistant"],
		]);
		expect(converted.map(entry => entry.message)).toEqual(convertToLlm(messages));
		for (const index of [2, 4]) {
			const content = converted[index].message.content;
			expect(Array.isArray(content) && content.some(block => block.type === "image")).toBe(true);
		}
		expect(convertMessagesForContextView([])).toEqual([]);
	});

	it("omits provider refusals the send path drops, keeping source indices of later messages", () => {
		const refusal: AssistantMessage = {
			...settledAssistant("refused output"),
			stopReason: "error",
			stopDetails: { type: "refusal" },
		};
		const messages: AgentMessage[] = [userMessage("question", 1), refusal, userMessage("again", 3)];

		const converted = convertMessagesForContextView(messages);
		expect(converted.map(({ sourceIndex, convertedIndex }) => [sourceIndex, convertedIndex])).toEqual([
			[0, 0],
			[2, 1],
		]);
		expect(converted.map(entry => entry.message)).toEqual(filterProviderReplayMessages(convertToLlm(messages)));
	});

	it("honors neighboring continuity markers without replacing either production cache", () => {
		const assistant = abortedAssistant([
			{ type: "text", text: "partial answer" },
			{ type: "thinking", thinking: "unfinished" },
		]);
		const messages: AgentMessage[] = [userMessage("question", 1), assistant];
		const production = convertToLlm(messages);
		const viewed = convertMessagesForContextView([messages[0], assistant, interruptedThinkingContinuity()]);
		const viewedAssistant = viewed[1].message;
		expect(viewedAssistant.role === "assistant" && viewedAssistant.content.map(block => block.type)).toEqual([
			"text",
		]);
		expect(viewed.map(entry => entry.sourceIndex)).toEqual([0, 1, 2]);
		expect(viewed.map(entry => entry.convertedIndex)).toEqual([0, 1, 2]);
		expect(convertToLlm(messages)).toBe(production);
		// A different outer history must still reuse the original per-message fragment.
		expect(convertToLlm([...messages])[1]).toBe(production[1]);
		const originalAssistant = production[1];
		expect(originalAssistant.role === "assistant" && originalAssistant.content.map(block => block.type)).toEqual([
			"text",
			"thinking",
		]);

		const withContinuity: AgentMessage[] = [assistant, interruptedThinkingContinuity()];
		const strippedProduction = convertToLlm(withContinuity);
		const withoutContinuity = convertMessagesForContextView([assistant])[0].message;
		expect(withoutContinuity.role === "assistant" && withoutContinuity.content.map(block => block.type)).toEqual([
			"text",
			"thinking",
		]);
		expect(convertToLlm(withContinuity)).toBe(strippedProduction);
		expect(convertToLlm([...withContinuity])[0]).toBe(strippedProduction[0]);
	});
});

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

describe("buildTitleDriftTurns", () => {
	it("keeps the newest operator prompts and replies, oldest first, within the window, skipping aborted replies", () => {
		const turns = buildTitleDriftTurns([
			userMessage("fix parser recovery", 1),
			settledAssistant("x".repeat(1000)),
			userMessage("now draft the release notes", 2),
			abortedAssistant([{ type: "text", text: "half a reply" }]),
			settledAssistant("y".repeat(1000)),
			userMessage("publish them", 3),
			settledAssistant(`Published.${"z".repeat(1500)}`),
		]);

		expect(turns).toEqual([
			{ role: "user", text: "now draft the release notes" },
			{ role: "assistant", text: "y".repeat(1000) },
			{ role: "user", text: "publish them" },
			{ role: "assistant", text: `Published.${"z".repeat(990)}` },
		]);
	});

	it("leads with the latest operator prompt, still within the window, when a long tool loop fills it", () => {
		const turns = buildTitleDriftTurns([
			userMessage("fix parser recovery", 1),
			userMessage("now draft the release notes", 2),
			settledAssistant("p".repeat(1000)),
			settledAssistant("q".repeat(1000)),
			settledAssistant("r".repeat(1000)),
			settledAssistant("s".repeat(1000)),
		]);

		expect(turns.map(turn => turn.text[0])).toEqual(["n", "r", "s"]);
		expect(turns[0]).toEqual({ role: "user", text: "now draft the release notes" });
		expect(turns.reduce((chars, turn) => chars + turn.text.length, 0)).toBeLessThanOrEqual(3000);
	});
});

describe("dedupeEphemeralReply", () => {
	const long = Array.from({ length: 200 }, (_, i) => `Paragraph ${i}: the answer keeps going.`).join("\n\n");

	it("cuts a side reply to 4 KiB by default", () => {
		const reply = dedupeEphemeralReply(long);
		expect(Buffer.byteLength(reply, "utf8")).toBeLessThanOrEqual(4096);
		expect(reply.endsWith("[…truncated]")).toBe(true);
	});

	it("keeps a long answer whole under an unbounded cap while still collapsing a repeat loop", () => {
		expect(dedupeEphemeralReply(long, Number.POSITIVE_INFINITY)).toBe(long);
		const looping = `${long}\n${"again\n".repeat(50)}done`;
		expect(dedupeEphemeralReply(looping, Number.POSITIVE_INFINITY)).toBe(`${long}\nagain\n[…50×]\ndone`);
	});

	it("drops a multi-byte character that straddles the byte budget instead of splitting it", () => {
		const suffix = "\n[…truncated]";
		const budget = Buffer.byteLength(suffix, "utf8") + 11;
		for (const wide of ["€", "😀"]) {
			const reply = dedupeEphemeralReply(`${"a".repeat(10)}${wide}${"b".repeat(40)}`, budget);
			expect(reply).toBe(`${"a".repeat(10)}${suffix}`);
			expect(Buffer.byteLength(reply, "utf8")).toBeLessThanOrEqual(budget);
		}
		expect(dedupeEphemeralReply(`${"a".repeat(8)}😀${"b".repeat(40)}`, budget + 1)).toBe(
			`${"a".repeat(8)}😀${suffix}`,
		);
	});
});
