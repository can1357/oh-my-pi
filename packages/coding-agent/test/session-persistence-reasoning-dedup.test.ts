import { describe, expect, it } from "bun:test";
import type { AssistantMessage, ProviderPayload, Usage } from "@oh-my-pi/pi-ai";
import { BlobStore } from "@oh-my-pi/pi-coding-agent/session/blob-store";
import type { SessionMessageEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { prepareEntryForPersistence } from "@oh-my-pi/pi-coding-agent/session/session-persistence";
import { TempDir } from "@oh-my-pi/pi-utils";

const usage = (): Usage => ({
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

function reasoningItem(id: string, encryptedContent: string): Record<string, unknown> {
	return { type: "reasoning", id, encrypted_content: encryptedContent };
}

function assistantEntry(
	content: AssistantMessage["content"],
	providerPayload: ProviderPayload | undefined,
): SessionMessageEntry {
	return {
		type: "message",
		id: "entry-1",
		parentId: null,
		timestamp: new Date(0).toISOString(),
		message: {
			role: "assistant",
			content,
			api: "openai-codex-responses",
			provider: "openai-codex",
			model: "gpt-5.2-codex",
			usage: usage(),
			stopReason: "stop",
			...(providerPayload ? { providerPayload } : {}),
			timestamp: 2,
		},
	};
}

function persistedAssistant(entry: SessionMessageEntry, blobStore: BlobStore): AssistantMessage {
	const persisted = prepareEntryForPersistence(entry, blobStore);
	if (persisted.type !== "message" || persisted.message.role !== "assistant") {
		throw new Error("Expected persisted assistant message");
	}
	return persisted.message;
}

// The happy path — duplicate dropped on disk, durable copy preserved through a
// real reload — is covered end-to-end in signature-persistence.test.ts. These
// cases pin the two safety branches: never drop a signature the payload cannot
// reconstruct, and never touch messages with no replay payload at all.
describe("session reasoning-signature dedup", () => {
	it("keeps a thinkingSignature the payload does not cover", () => {
		using tempDir = TempDir.createSync("@pi-session-reasoning-keep-");
		const blobStore = new BlobStore(tempDir.path());
		const covered = reasoningItem("rs_covered", "ENC_COVERED");
		const orphanSignature = JSON.stringify(reasoningItem("rs_orphan", "ENC_ORPHAN"));

		const message = persistedAssistant(
			assistantEntry(
				[
					{ type: "thinking", thinking: "covered", thinkingSignature: JSON.stringify(covered) },
					{ type: "thinking", thinking: "orphan", thinkingSignature: orphanSignature },
				],
				{ type: "openaiResponsesHistory", provider: "openai-codex", items: [covered] },
			),
			blobStore,
		);

		const thinkingBlocks = message.content.filter(block => block.type === "thinking");
		expect(thinkingBlocks).toHaveLength(2);
		// Covered block: signature dropped. Orphan block: signature kept — its encrypted
		// reasoning is not recoverable from the payload, so dropping it would lose data.
		expect(thinkingBlocks[0]?.thinkingSignature).toBeUndefined();
		expect(thinkingBlocks[1]?.thinkingSignature).toBe(orphanSignature);
	});

	it("leaves thinkingSignatures untouched when there is no provider payload", () => {
		using tempDir = TempDir.createSync("@pi-session-reasoning-nopayload-");
		const blobStore = new BlobStore(tempDir.path());
		const signature = JSON.stringify(reasoningItem("rs_1", "ENC"));

		const message = persistedAssistant(
			assistantEntry([{ type: "thinking", thinking: "reasoning", thinkingSignature: signature }], undefined),
			blobStore,
		);

		const thinking = message.content.find(block => block.type === "thinking");
		if (thinking?.type !== "thinking") throw new Error("Expected thinking block");
		expect(thinking.thinkingSignature).toBe(signature);
	});
});

describe("session atomic reasoning persistence", () => {
	const truncationNotice = "[Session persistence truncated large content]";

	it("preserves an oversized signed thinking block and its signature verbatim", () => {
		using tempDir = TempDir.createSync("@pi-session-atomic-thinking-");
		const blobStore = new BlobStore(tempDir.path());

		const message = persistedAssistant(
			assistantEntry([{ type: "thinking", thinking: "x".repeat(600_000), thinkingSignature: "sig-abc" }], undefined),
			blobStore,
		);

		const thinking = message.content[0];
		if (thinking?.type !== "thinking") throw new Error("Expected thinking block");
		expect(thinking.thinking).toHaveLength(600_000);
		expect(thinking.thinking.endsWith(truncationNotice)).toBe(false);
		expect(thinking.thinkingSignature).toBe("sig-abc");
	});

	it("preserves an oversized redactedThinking blob verbatim", () => {
		using tempDir = TempDir.createSync("@pi-session-atomic-redacted-");
		const blobStore = new BlobStore(tempDir.path());

		const message = persistedAssistant(
			assistantEntry([{ type: "redactedThinking", data: "r".repeat(600_000) }], undefined),
			blobStore,
		);

		const redactedThinking = message.content[0];
		if (redactedThinking?.type !== "redactedThinking") throw new Error("Expected redactedThinking block");
		expect(redactedThinking.data).toHaveLength(600_000);
		expect(redactedThinking.data.endsWith(truncationNotice)).toBe(false);
	});

	it("still truncates oversized UNSIGNED thinking and text blocks", () => {
		using tempDir = TempDir.createSync("@pi-session-atomic-unsigned-");
		const blobStore = new BlobStore(tempDir.path());

		const message = persistedAssistant(
			assistantEntry(
				[
					{ type: "thinking", thinking: "y".repeat(600_000) },
					{ type: "text", text: "z".repeat(600_000) },
				],
				undefined,
			),
			blobStore,
		);

		const thinking = message.content[0];
		if (thinking?.type !== "thinking") throw new Error("Expected thinking block");
		expect(thinking.thinking.length).toBeLessThan(600_000);
		expect(thinking.thinking.endsWith(truncationNotice)).toBe(true);

		const text = message.content[1];
		if (text?.type !== "text") throw new Error("Expected text block");
		expect(text.text.length).toBeLessThan(600_000);
		expect(text.text.endsWith(truncationNotice)).toBe(true);
	});

	it("survives a full JSONL string round-trip for signed thinking", () => {
		using tempDir = TempDir.createSync("@pi-session-atomic-roundtrip-");
		const blobStore = new BlobStore(tempDir.path());
		const entry = assistantEntry(
			[{ type: "thinking", thinking: "x".repeat(600_000), thinkingSignature: "sig-abc" }],
			undefined,
		);

		const persistedEntry = prepareEntryForPersistence(entry, blobStore);
		const line = JSON.stringify(persistedEntry);
		const reparsed = JSON.parse(line);
		if (reparsed.type !== "message" || reparsed.message.role !== "assistant") {
			throw new Error("Expected reparsed assistant message");
		}

		const thinking = reparsed.message.content[0];
		if (thinking?.type !== "thinking") throw new Error("Expected thinking block");
		expect(thinking.thinking).toHaveLength(600_000);
		expect(thinking.thinking.endsWith(truncationNotice)).toBe(false);
		expect(thinking.thinkingSignature).toBe("sig-abc");
	});
});
