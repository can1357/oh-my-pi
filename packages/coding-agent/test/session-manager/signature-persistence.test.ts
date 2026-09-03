import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AssistantMessage, ImageContent } from "@oh-my-pi/pi-ai";
import type { SessionMessageEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { getBlobsDir, TempDir } from "@oh-my-pi/pi-utils";

function isAssistantSessionEntry(entry: unknown): entry is SessionMessageEntry & { message: AssistantMessage } {
	return (
		typeof entry === "object" &&
		entry !== null &&
		"type" in entry &&
		entry.type === "message" &&
		"message" in entry &&
		typeof entry.message === "object" &&
		entry.message !== null &&
		"role" in entry.message &&
		entry.message.role === "assistant"
	);
}

function getAssistantMessage(session: SessionManager): AssistantMessage {
	const assistantEntry = session.getEntries().find(isAssistantSessionEntry);
	if (!assistantEntry) throw new Error("Expected assistant message");
	return assistantEntry.message;
}

describe("SessionManager signature persistence", () => {
	it("externalizes provider image data URLs and restores preserved history payloads across reload", async () => {
		using tempDir = TempDir.createSync("@pi-session-provider-image-persistence-");
		const session = SessionManager.create(tempDir.path(), tempDir.path());
		const largeImageUrl = `data:image/png;base64,${"a".repeat(600_000)}`;

		session.appendMessage({
			role: "user",
			content: "look at this",
			providerPayload: {
				type: "openaiResponsesHistory",
				provider: "openai-codex",
				items: [
					{
						type: "message",
						role: "user",
						content: [
							{ type: "input_text", text: "look at this" },
							{ type: "input_image", detail: "auto", image_url: largeImageUrl },
						],
					},
				],
			},
			timestamp: 1,
		});
		session.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "done" }],
			api: "openai-codex-responses",
			provider: "openai-codex",
			model: "gpt-5.4",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 2,
		});
		await session.flush();

		const expectedBlobHash = new Bun.SHA256().update(Buffer.from(largeImageUrl, "utf8")).digest("hex");
		const persistedBlob = await fs.readFile(path.join(getBlobsDir(), expectedBlobHash), "utf8");
		expect(persistedBlob).toBe(largeImageUrl);

		const reloaded = await SessionManager.open(session.getSessionFile()!);
		const reloadedUserEntry = reloaded
			.getEntries()
			.find(entry => entry.type === "message" && entry.message.role === "user");
		if (reloadedUserEntry?.type !== "message" || reloadedUserEntry.message.role !== "user") {
			throw new Error("Expected user message");
		}

		expect(reloadedUserEntry.message.providerPayload).toEqual({
			type: "openaiResponsesHistory",
			provider: "openai-codex",
			items: [
				{
					type: "message",
					role: "user",
					content: [
						{ type: "input_text", text: "look at this" },
						{ type: "input_image", detail: "auto", image_url: largeImageUrl },
					],
				},
			],
		});
	});

	it("externalizes and restores tool result image blocks across reload", async () => {
		using tempDir = TempDir.createSync("@pi-session-tool-image-persistence-");
		const session = SessionManager.create(tempDir.path(), tempDir.path());
		const contentImage: ImageContent = {
			type: "image",
			data: Buffer.from("read-image-payload".repeat(100)).toString("base64"),
			mimeType: "image/png",
		};
		const detailImage: ImageContent = {
			type: "image",
			data: Buffer.from("eval-detail-image-payload".repeat(100)).toString("base64"),
			mimeType: "image/png",
		};

		session.appendMessage({
			role: "assistant",
			content: [{ type: "toolCall", id: "tool_image", name: "eval", arguments: {} }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: 1,
		} satisfies AssistantMessage);
		session.appendMessage({
			role: "toolResult",
			toolCallId: "tool_image",
			toolName: "eval",
			content: [{ type: "text", text: "displayed image" }, contentImage],
			details: { images: [detailImage] },
			isError: false,
			timestamp: 2,
		});
		await session.flush();

		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected persisted session file");
		const rawSession = await fs.readFile(sessionFile, "utf8");
		expect(rawSession).not.toContain(contentImage.data);
		expect(rawSession).not.toContain(detailImage.data);

		const contentHash = new Bun.SHA256().update(Buffer.from(contentImage.data, "base64")).digest("hex");
		const detailHash = new Bun.SHA256().update(Buffer.from(detailImage.data, "base64")).digest("hex");
		await expect(fs.readFile(path.join(getBlobsDir(), contentHash))).resolves.toBeDefined();
		await expect(fs.readFile(path.join(getBlobsDir(), detailHash))).resolves.toBeDefined();

		const reloaded = await SessionManager.open(sessionFile);
		const reloadedToolEntry = reloaded
			.getEntries()
			.find(entry => entry.type === "message" && entry.message.role === "toolResult");
		if (reloadedToolEntry?.type !== "message" || reloadedToolEntry.message.role !== "toolResult") {
			throw new Error("Expected tool result message");
		}

		expect(reloadedToolEntry.message.content).toEqual([{ type: "text", text: "displayed image" }, contentImage]);
		expect((reloadedToolEntry.message.details as { images?: ImageContent[] }).images).toEqual([detailImage]);
	});

	it("rehydrates assistant replay metadata in memory without rewriting the session file", async () => {
		using tempDir = TempDir.createSync("@pi-session-rehydrate-persistence-");
		const session = SessionManager.create(tempDir.path(), tempDir.path());
		const providerPayload = {
			type: "openaiResponsesHistory" as const,
			provider: "openai",
			items: [
				{ type: "reasoning", encrypted_content: "enc_stale" },
				{
					type: "message",
					role: "assistant",
					status: "completed",
					id: "msg_stale_snapshot",
					content: [{ type: "output_text", text: "done" }],
				},
			],
		};

		session.appendMessage({ role: "user", content: "continue", timestamp: 1 });
		session.appendMessage({
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "reasoning", thinkingSignature: JSON.stringify(providerPayload.items[0]) },
				{ type: "text", text: "done" },
			],
			api: "openai-responses",
			provider: "github-copilot",
			model: "gpt-5-mini",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			providerPayload,
			timestamp: 2,
		} satisfies AssistantMessage);
		await session.flush();

		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected persisted session file");
		const persistedBefore = await fs.readFile(sessionFile, "utf8");
		const initialMtimeMs = (await fs.stat(sessionFile)).mtimeMs;
		await session.close();

		const reloaded = await SessionManager.open(sessionFile);
		const assistant = getAssistantMessage(reloaded);

		// GitHub Copilot rejects replayed assistant-side native history on a warmed
		// session, so its replay metadata is stripped in memory after rehydration.
		expect(assistant.providerPayload).toBeUndefined();
		const thinking = assistant.content[0];
		expect(thinking).toMatchObject({ type: "thinking", thinking: "reasoning" });
		if (thinking?.type !== "thinking") throw new Error("Expected thinking block");
		expect(thinking.thinkingSignature).toBeUndefined();
		expect(await fs.readFile(sessionFile, "utf8")).toBe(persistedBefore);
		expect((await fs.stat(sessionFile)).mtimeMs).toBe(initialMtimeMs);
		await reloaded.close();
	}, 15_000);

	it("drops a reasoning signature duplicated by the provider payload and keeps the payload on reload", async () => {
		using tempDir = TempDir.createSync("@pi-session-reasoning-dedup-e2e-");
		const session = SessionManager.create(tempDir.path(), tempDir.path());
		// >MAX_PERSIST_CHARS: regresses persistence truncating providerPayload reasoning items.
		const encrypted = `ENCRYPTED_REASONING_BLOB_UNIQUE_TOKEN_${"E".repeat(600_000)}`;
		const reasoning = { type: "reasoning", id: "rs_1", encrypted_content: encrypted };

		session.appendMessage({ role: "user", content: "continue", timestamp: 1 });
		session.appendMessage({
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "reasoning", thinkingSignature: JSON.stringify(reasoning) },
				{ type: "text", text: "done" },
			],
			api: "openai-codex-responses",
			provider: "openai-codex",
			model: "gpt-5.2-codex",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			providerPayload: { type: "openaiResponsesHistory", provider: "openai-codex", items: [reasoning] },
			timestamp: 2,
		} satisfies AssistantMessage);
		await session.flush();

		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected persisted session file");
		// The encrypted blob was stored twice (thinkingSignature + providerPayload);
		// persistence drops the signature copy, so the session file carries it once.
		const onDisk = await fs.readFile(sessionFile, "utf8");
		expect(onDisk.split(encrypted).length - 1).toBe(1);
		await session.close();

		const reloaded = await SessionManager.open(sessionFile);
		const assistant = getAssistantMessage(reloaded);
		const thinking = assistant.content.find(block => block.type === "thinking");
		if (thinking?.type !== "thinking") throw new Error("Expected thinking block");
		expect(thinking.thinkingSignature).toBeUndefined();
		// openai-codex (non-Copilot) keeps the replay payload, so the encrypted reasoning
		// stays recoverable for native-history replay / remote compaction.
		expect(assistant.providerPayload?.type).toBe("openaiResponsesHistory");
		const items = assistant.providerPayload?.type === "openaiResponsesHistory" ? assistant.providerPayload.items : [];
		expect(items[0]?.encrypted_content).toBe(encrypted);
		await reloaded.close();
	}, 15_000);

	it("preserves oversized Anthropic server-tool results byte-for-byte across reload", async () => {
		using tempDir = TempDir.createSync("@pi-session-anthropic-server-tool-persistence-");
		const session = SessionManager.create(tempDir.path(), tempDir.path());
		const oversizedPayload = "W".repeat(600_000);
		const serverToolContent: AssistantMessage["content"] = [
			{
				type: "anthropicServerTool",
				block: {
					type: "server_tool_use",
					id: "srvtoolu_web_search",
					name: "web_search",
					input: { query: "current UTC date" },
				},
			},
			{
				type: "anthropicServerTool",
				block: {
					type: "web_search_tool_result",
					tool_use_id: "srvtoolu_web_search",
					content: [{ type: "web_search_result", encrypted_content: `ENCRYPTED_WEB_SEARCH_${oversizedPayload}` }],
				},
			},
			{
				type: "anthropicServerTool",
				block: {
					type: "server_tool_use",
					id: "srvtoolu_tool_search",
					name: "tool_search_tool_bm25",
					input: { query: "read" },
				},
			},
			{
				type: "anthropicServerTool",
				block: {
					type: "tool_search_tool_result",
					tool_use_id: "srvtoolu_tool_search",
					content: {
						type: "tool_search_tool_search_result",
						tool_references: [{ type: "tool_reference", tool_name: `READ_TOOL_${oversizedPayload}` }],
					},
				},
			},
		];

		session.appendMessage({
			role: "assistant",
			content: serverToolContent,
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-opus",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 1,
		});
		await session.flush();
		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected persisted session file");
		await session.close();

		const reloaded = await SessionManager.open(sessionFile);
		expect(getAssistantMessage(reloaded).content).toEqual(serverToolContent);
		await reloaded.close();
	}, 15_000);
});
