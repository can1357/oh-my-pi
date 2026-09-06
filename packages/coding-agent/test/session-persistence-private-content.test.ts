import { describe, expect, it } from "bun:test";
import type { AssistantMessage, ToolResultMessage, Usage } from "@oh-my-pi/pi-ai";
import { BlobStore } from "@oh-my-pi/pi-coding-agent/session/blob-store";
import type { SessionMessageEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { prepareEntryForPersistence } from "@oh-my-pi/pi-coding-agent/session/session-persistence";
import { TempDir } from "@oh-my-pi/pi-utils";

const CIPHERTEXT = `gAAAA${"Z".repeat(900_000)}`;

const usage = (): Usage => ({
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

function entry(message: AssistantMessage | ToolResultMessage): SessionMessageEntry {
	return { type: "message", id: "entry-1", parentId: null, timestamp: new Date(0).toISOString(), message };
}

function persist(message: AssistantMessage | ToolResultMessage): AssistantMessage | ToolResultMessage {
	using tempDir = TempDir.createSync("@pi-session-private-persist-");
	const persisted = prepareEntryForPersistence(entry(message), new BlobStore(tempDir.path()));
	if (persisted.type !== "message") throw new Error("Expected a persisted message entry");
	return persisted.message as AssistantMessage | ToolResultMessage;
}

describe("private Codex payload persistence", () => {
	it("keeps an oversized encrypted tool result verbatim", () => {
		const persisted = persist({
			role: "toolResult",
			toolCallId: "call_notes",
			toolName: "notes.read_file",
			modelOnly: true,
			content: [{ type: "encrypted", encryptedContent: CIPHERTEXT }],
			isError: false,
			timestamp: 1,
		});
		if (persisted.role !== "toolResult") throw new Error("Expected a tool result");
		expect(persisted.content).toEqual([{ type: "encrypted", encryptedContent: CIPHERTEXT }]);
	});

	it("keeps oversized encrypted arguments of a model-only call verbatim", () => {
		const persisted = persist({
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "call_notes",
					name: "notes.write_file",
					namespace: "notes",
					modelOnly: true,
					arguments: { path: "checkpoint", text: CIPHERTEXT },
				},
			],
			api: "openai-codex-responses",
			provider: "openai-codex",
			model: "gpt-6-astra",
			usage: usage(),
			stopReason: "toolUse",
			timestamp: 2,
		});
		if (persisted.role !== "assistant") throw new Error("Expected an assistant message");
		const call = persisted.content[0];
		if (call?.type !== "toolCall") throw new Error("Expected a tool call block");
		expect(call.arguments).toEqual({ path: "checkpoint", text: CIPHERTEXT });
	});

	it("still truncates a public oversized tool result", () => {
		const persisted = persist({
			role: "toolResult",
			toolCallId: "call_read",
			toolName: "read",
			content: [{ type: "text", text: "x".repeat(900_000) }],
			isError: false,
			timestamp: 1,
		});
		if (persisted.role !== "toolResult") throw new Error("Expected a tool result");
		const block = persisted.content[0];
		if (block?.type !== "text") throw new Error("Expected a text block");
		expect(block.text.length).toBeLessThan(900_000);
		expect(block.text).toContain("[Session persistence truncated large content]");
	});
});
