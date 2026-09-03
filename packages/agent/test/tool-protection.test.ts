import { describe, expect, it } from "bun:test";
import { Tokenizer } from "@oh-my-pi/pi-agent-core";
import type { SessionMessageEntry } from "@oh-my-pi/pi-agent-core/compaction/entries";
import { DEFAULT_PRUNE_CONFIG, pruneToolOutputs } from "@oh-my-pi/pi-agent-core/compaction/pruning";
import { AGGRESSIVE_SHAKE_CONFIG, collectShakeRegions } from "@oh-my-pi/pi-agent-core/compaction/shake";
import type { AssistantMessage, TextContent, ToolResultMessage, Usage } from "@oh-my-pi/pi-ai";

const tokenizer = new Tokenizer();

function usage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function messageEntry(id: string, message: AssistantMessage | ToolResultMessage): SessionMessageEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-05-31T00:00:00.000Z",
		message,
	};
}

function assistantReadCall(toolCallId: string, path: string): SessionMessageEntry {
	return messageEntry(`assistant-${toolCallId}`, {
		role: "assistant",
		content: [{ type: "toolCall", id: toolCallId, name: "read", arguments: { path } }],
		api: "mock",
		provider: "mock",
		model: "mock-model",
		usage: usage(),
		stopReason: "toolUse",
		timestamp: 0,
	});
}

function readResult(toolCallId: string, text: string): SessionMessageEntry {
	const content: TextContent[] = [{ type: "text", text }];
	return messageEntry(`result-${toolCallId}`, {
		role: "toolResult",
		toolCallId,
		toolName: "read",
		content,
		isError: false,
		timestamp: 0,
	});
}

describe("conditional tool-result protection", () => {
	it("prunes regular read results but keeps skill:// reads", () => {
		const skillResult = readResult("skill-read", "skill read output that must remain intact");
		const fileResult = readResult("file-read", "file read output that can be pruned ".repeat(20));
		const entries = [
			assistantReadCall("skill-read", "skill://session-memory"),
			skillResult,
			assistantReadCall("file-read", "packages/agent/src/index.ts"),
			fileResult,
		];

		const result = pruneToolOutputs(entries, tokenizer, {
			...DEFAULT_PRUNE_CONFIG,
			protectTokens: 0,
			minimumSavings: 0,
		});

		expect(result.prunedCount).toBe(1);
		expect((skillResult.message as ToolResultMessage).prunedAt).toBeUndefined();
		expect((skillResult.message as ToolResultMessage).content).toEqual([
			{ type: "text", text: "skill read output that must remain intact" },
		]);
		expect(typeof (fileResult.message as ToolResultMessage).prunedAt).toBe("number");
		expect(((fileResult.message as ToolResultMessage).content[0] as TextContent).text).toStartWith(
			"[Output truncated - ",
		);
	});

	it("shakes regular read results but excludes skill:// reads", () => {
		const skillResult = readResult("skill-read", "skill read output that must not be shaken");
		const fileResult = readResult("file-read", "file read output that is eligible for shake");
		const entries = [
			assistantReadCall("skill-read", "skill://session-memory"),
			skillResult,
			assistantReadCall("file-read", "src/index.ts"),
			fileResult,
		];

		// protectTokens: 0 isolates the matcher behavior from the aggressive
		// preset's recent-tail window (covered by shake.test.ts).
		const regions = collectShakeRegions(entries, tokenizer, { ...AGGRESSIVE_SHAKE_CONFIG, protectTokens: 0 });

		expect(regions).toHaveLength(1);
		expect(regions[0]?.kind).toBe("toolResult");
		expect(regions[0]?.entry).toBe(fileResult);
	});
});
