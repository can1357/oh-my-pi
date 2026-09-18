import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import {
	AGGRESSIVE_SHAKE_CONFIG,
	collectShakeRegions,
	convertMessageToLlm,
	DEFAULT_COMPACTION_SETTINGS,
	DEFAULT_PRUNE_CONFIG,
	invalidateMessageCache,
	prepareBranchEntries,
	prepareCompaction,
	projectToolHistoryMessage,
	pruneToolOutputs,
	type SessionEntry,
} from "@oh-my-pi/pi-agent-core/compaction";
import { Tokenizer } from "@oh-my-pi/pi-agent-core/tokenizer";
import type { AssistantMessage, ImageContent, ToolResultMessage, Usage } from "@oh-my-pi/pi-ai";

const usage: Usage = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const image: ImageContent = {
	type: "image",
	data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB",
	mimeType: "image/png",
};

function assistant(content: AssistantMessage["content"], timestamp: number): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "mock",
		provider: "mock",
		model: "mock-model",
		usage,
		stopReason: "toolUse",
		timestamp,
	};
}

function result(
	id: string,
	text: string,
	timestamp: number,
	options: Pick<ToolResultMessage, "contextOmitted" | "prunedAt"> = {},
): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: "read",
		content: [{ type: "text", text }],
		isError: false,
		timestamp,
		...options,
	};
}

function messageEntry(id: string, parentId: string | null, message: AgentMessage): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: new Date(message.timestamp).toISOString(),
		message,
	};
}

function toolCallIds(message: AgentMessage | undefined): string[] {
	if (message?.role !== "assistant") return [];
	return message.content.flatMap(block => (block.type === "toolCall" ? [block.id] : []));
}

describe("native tool-history omission projection", () => {
	test("removes only marked pairs while preserving text, images, and safe visible reasoning", () => {
		const source = assistant(
			[
				{ type: "thinking", thinking: "visible reasoning", thinkingSignature: "signed-reasoning" },
				{ type: "redactedThinking", data: "opaque-reasoning" },
				{ type: "text", text: "prefix\nexact retained text\nsuffix" },
				image,
				{ type: "toolCall", id: "keep-a", name: "read", arguments: { path: "a.txt" } },
				{
					type: "toolCall",
					id: "drop",
					name: "read",
					arguments: { path: "secret.txt" },
					contextOmitted: true,
				},
				{ type: "toolCall", id: "keep-b", name: "read", arguments: { path: "b.txt" } },
			],
			20,
		);

		const projected = projectToolHistoryMessage(source);
		expect(projected).not.toBe(source);
		expect(toolCallIds(projected)).toEqual(["keep-a", "keep-b"]);
		if (projected?.role !== "assistant") throw new Error("Expected projected assistant");
		expect(projected.content.find(block => block.type === "toolCall" && block.id === "keep-a")).toBe(
			source.content[4],
		);
		expect(projected.content.find(block => block.type === "text")).toEqual({
			type: "text",
			text: "prefix\nexact retained text\nsuffix",
		});
		expect(projected.content.find(block => block.type === "image")).toBe(image);
		expect(projected.content.some(block => block.type === "redactedThinking")).toBe(false);
		expect(projected.content.find(block => block.type === "thinking")).toEqual({
			type: "thinking",
			thinking: "visible reasoning",
			thinkingSignature: undefined,
		});
		expect(convertMessageToLlm(source)).toEqual(projected);
		const omittedResult = result("drop", "full retained journal body", 21, {
			contextOmitted: true,
			prunedAt: 500,
		});
		expect(projectToolHistoryMessage(omittedResult)).toBeUndefined();
		expect(convertMessageToLlm(omittedResult)).toBeUndefined();
		expect(source.content.some(block => block.type === "redactedThinking")).toBe(true);
	});

	test("drops emptied assistants and preserves identity when no marker applies", () => {
		const omittedOnly = assistant(
			[
				{ type: "redactedThinking", data: "opaque" },
				{ type: "toolCall", id: "drop", name: "read", arguments: {}, contextOmitted: true },
			],
			1,
		);
		const unchanged = assistant(
			[
				{ type: "text", text: "untouched" },
				{ type: "toolCall", id: "keep", name: "read", arguments: {} },
			],
			2,
		);
		const unchangedResult = result("keep", "untouched result", 3);
		const multimodalResult: ToolResultMessage = {
			...unchangedResult,
			content: [{ type: "text", text: "screenshot" }, image],
		};

		expect(projectToolHistoryMessage(omittedOnly)).toBeUndefined();
		expect(projectToolHistoryMessage(unchanged)).toBe(unchanged);
		expect(projectToolHistoryMessage(unchangedResult)).toBe(unchangedResult);
		expect(projectToolHistoryMessage(multimodalResult)).toBe(multimodalResult);
		expect(convertMessageToLlm(multimodalResult)?.content).toEqual([{ type: "text", text: "screenshot" }, image]);
	});

	test("token estimates follow projected content after owner invalidation", () => {
		const tokenizer = new Tokenizer();
		const callOnly = assistant([{ type: "toolCall", id: "drop", name: "read", arguments: { path: "large.txt" } }], 1);
		const toolResult = result("drop", "large output ".repeat(2_000), 2);
		expect(tokenizer.countMessage(callOnly)).toBeGreaterThan(0);
		expect(tokenizer.countMessage(toolResult as AgentMessage)).toBeGreaterThan(0);

		const call = callOnly.content[0];
		if (call.type !== "toolCall") throw new Error("Expected tool call");
		call.contextOmitted = true;
		toolResult.contextOmitted = true;
		toolResult.prunedAt = 500;
		invalidateMessageCache(callOnly);
		invalidateMessageCache(toolResult as AgentMessage);

		expect(tokenizer.countMessage(callOnly)).toBe(0);
		expect(tokenizer.countMessage(toolResult as AgentMessage)).toBe(0);
	});

	test("existing prune and shake collectors ignore already omitted results", () => {
		const tokenizer = new Tokenizer();
		const omitted = result("drop", "large retained output ".repeat(2_000), 2, {
			contextOmitted: true,
			prunedAt: 500,
		});
		const entry = messageEntry("result-drop", null, omitted);

		expect(
			pruneToolOutputs([entry], tokenizer, {
				...DEFAULT_PRUNE_CONFIG,
				protectTokens: 0,
				minimumSavings: 0,
			}),
		).toEqual({ prunedCount: 0, tokensSaved: 0 });
		expect(
			collectShakeRegions([entry], tokenizer, {
				...AGGRESSIVE_SHAKE_CONFIG,
				protectTokens: 0,
				minSavings: 0,
			}),
		).toEqual([]);
		expect(omitted.content).toEqual([{ type: "text", text: "large retained output ".repeat(2_000) }]);
	});
});

describe("omission projection at raw-history boundaries", () => {
	const oldUser: AgentMessage = { role: "user", content: `required constraint\n${"x".repeat(20_000)}`, timestamp: 10 };
	const calls = assistant(
		[
			{ type: "text", text: "retained assistant text" },
			{ type: "toolCall", id: "keep-a", name: "read", arguments: { path: "a.txt" } },
			{
				type: "toolCall",
				id: "drop",
				name: "read",
				arguments: { path: "secret.txt" },
				contextOmitted: true,
			},
			{ type: "toolCall", id: "keep-b", name: "read", arguments: { path: "b.txt" } },
		],
		20,
	);
	const droppedResult = result("drop", "omitted result body", 22, { contextOmitted: true, prunedAt: 500 });
	const recentUser: AgentMessage = { role: "user", content: "continue", timestamp: 30 };
	const recentAssistant = assistant([{ type: "text", text: "recent answer" }], 40);
	const entries: SessionEntry[] = [
		messageEntry("user-old", null, oldUser),
		messageEntry("assistant-tools", "user-old", calls),
		messageEntry("result-a", "assistant-tools", result("keep-a", "result a", 21)),
		messageEntry("result-drop", "result-a", droppedResult),
		messageEntry("result-b", "result-drop", result("keep-b", "result b", 23)),
		messageEntry("user-recent", "result-b", recentUser),
		messageEntry("assistant-recent", "user-recent", recentAssistant),
	];

	test("compaction preparation keeps source anchors while excluding marked content", () => {
		const originalIds = entries.map(entry => entry.id);
		const preparation = prepareCompaction(entries, {
			...DEFAULT_COMPACTION_SETTINGS,
			keepRecentTokens: 8,
		});
		if (!preparation) throw new Error("Expected compaction preparation");
		const prepared = [
			...preparation.messagesToSummarize,
			...preparation.turnPrefixMessages,
			...preparation.recentMessages,
		];

		expect(prepared.some(message => message.role === "toolResult" && message.toolCallId === "drop")).toBe(false);
		expect(prepared.flatMap(toolCallIds)).not.toContain("drop");
		expect(prepared.flatMap(toolCallIds)).toEqual(expect.arrayContaining(["keep-a", "keep-b"]));
		expect(entries.map(entry => entry.id)).toEqual(originalIds);
		expect(entries.some(entry => entry.id === preparation.firstKeptEntryId)).toBe(true);
		expect(oldUser.role === "user" ? oldUser.historyRewriteAt : undefined).toBeUndefined();
		const firstUser = prepared.find(message => message.role === "user");
		expect(firstUser?.role === "user" ? firstUser.historyRewriteAt : undefined).toBe(500);
		expect(droppedResult.content).toEqual([{ type: "text", text: "omitted result body" }]);
	});

	test("branch preparation excludes marked pairs without changing journal messages", () => {
		const branch = prepareBranchEntries(entries, new Tokenizer());
		expect(branch.messages.some(message => message.role === "toolResult" && message.toolCallId === "drop")).toBe(
			false,
		);
		expect(branch.messages.flatMap(toolCallIds)).not.toContain("drop");
		expect([...branch.fileOps.read]).toEqual(expect.arrayContaining(["a.txt", "b.txt"]));
		expect([...branch.fileOps.read]).not.toContain("secret.txt");
		const branchFirstUser = branch.messages.find(message => message.role === "user");
		expect(branchFirstUser?.role === "user" ? branchFirstUser.historyRewriteAt : undefined).toBe(500);
		expect(droppedResult.contextOmitted).toBe(true);
		expect(droppedResult.content).toEqual([{ type: "text", text: "omitted result body" }]);
		expect(oldUser.role === "user" ? oldUser.historyRewriteAt : undefined).toBeUndefined();
	});
});
