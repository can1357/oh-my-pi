import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { ImageContent, TextContent, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { buildSessionData } from "@oh-my-pi/pi-coding-agent/export/html";
import type { ExtensionRunner, TreePreparation } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { isBlobRef } from "@oh-my-pi/pi-coding-agent/session/blob-store";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { getAgentDir, getBlobsDir, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";

const usage = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** Base64 large enough that persistence moves it to the blob store. */
function pngData(fill: number): string {
	return Buffer.alloc(4096, fill).toString("base64");
}

/** One read call whose result carries `data` as an image; returns the result entry id. */
function appendImageRead(sm: SessionManager, callId: string, data: string, text = callId): string {
	sm.appendMessage({
		role: "assistant",
		content: [{ type: "toolCall", id: callId, name: "read", arguments: {} }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test",
		usage,
		stopReason: "toolUse",
		timestamp: 0,
	});
	return sm.appendMessage({
		role: "toolResult",
		toolCallId: callId,
		toolName: "read",
		content: [
			{ type: "text", text },
			{ type: "image", data, mimeType: "image/png" },
		],
		isError: false,
		timestamp: 0,
	});
}

/** An image read, then a compaction that keeps only what follows it. Returns the compacted read's id. */
function appendCompactedImageRead(sm: SessionManager, data: string): string {
	sm.appendMessage({ role: "user", content: "old turn", timestamp: 0 });
	const compactedId = appendImageRead(sm, "old", data);
	const keptId = sm.appendMessage({ role: "user", content: "kept turn", timestamp: 0 });
	sm.appendCompaction("summary", undefined, keptId, 100);
	return compactedId;
}

function imageOf(entry: SessionEntry | undefined): string | undefined {
	if (entry?.type !== "message" || entry.message.role !== "toolResult") return undefined;
	return entry.message.content.find((part): part is ImageContent => part.type === "image")?.data;
}

function textOf(entry: SessionEntry | undefined): string | undefined {
	if (entry?.type !== "message" || entry.message.role !== "toolResult") return undefined;
	return entry.message.content.find((part): part is TextContent => part.type === "text")?.text;
}

function contextImages(sm: SessionManager, options?: { transcript?: boolean }): string[] {
	return sm
		.buildSessionContext(options)
		.messages.filter((message): message is ToolResultMessage => message.role === "toolResult")
		.flatMap(message => message.content.filter((part): part is ImageContent => part.type === "image"))
		.map(part => part.data);
}

describe("images in compacted session history", () => {
	let tempDir: TempDir;
	let previousAgentDir: string;
	let sessionDir: string;

	beforeEach(() => {
		tempDir = TempDir.createSync("@omp-compacted-images-");
		previousAgentDir = getAgentDir();
		setAgentDir(path.join(tempDir.path(), "agent"));
		sessionDir = path.join(tempDir.path(), "sessions");
	});

	afterEach(() => {
		setAgentDir(previousAgentDir);
		tempDir.removeSync();
	});

	it("resumes with compacted images as blob refs while every reader still gets the bytes", async () => {
		const oldImage = pngData(1);
		const newImage = pngData(2);
		const writer = SessionManager.create(tempDir.path(), sessionDir);
		const compactedId = appendCompactedImageRead(writer, oldImage);
		appendImageRead(writer, "new", newImage);
		await writer.flush();

		const sm = await SessionManager.open(writer.getSessionFile()!, sessionDir);

		expect(isBlobRef(imageOf(sm.getEntry(compactedId))!)).toBe(true);
		expect(contextImages(sm)).toEqual([newImage]);
		expect(contextImages(sm, { transcript: true })).toEqual([oldImage, newImage]);
		expect(imageOf(buildSessionData(sm).entries.find(entry => entry.id === compactedId))).toBe(oldImage);
		expect(imageOf(sm.withInlineImages(sm.getEntries()).find(entry => entry.id === compactedId))).toBe(oldImage);

		// Branching back makes compacted history the model context again; maintenance
		// passes read the branch's entries directly, so they must carry bytes.
		sm.branch(compactedId);
		expect(contextImages(sm)).toEqual([oldImage]);
		expect(imageOf(sm.getBranch().at(-1))).toBe(oldImage);
	});

	it("externalizes images a live compaction leaves behind without changing the session file", async () => {
		const oldImage = pngData(3);
		const sm = SessionManager.create(tempDir.path(), sessionDir);
		sm.appendMessage({ role: "user", content: "start", timestamp: 0 });
		const compactedId = appendImageRead(sm, "old", oldImage);
		const compactedEntry = sm.getEntry(compactedId);
		const keptId = sm.appendMessage({ role: "user", content: "kept turn", timestamp: 0 });
		await sm.flush();
		const file = sm.getSessionFile()!;

		sm.appendCompaction("summary", undefined, keptId, 100);
		await sm.flush();
		const afterCompaction = await Bun.file(file).bytes();

		// Same entry object: holders of branch views see the externalized form.
		expect(sm.getEntry(compactedId)).toBe(compactedEntry);
		expect(isBlobRef(imageOf(compactedEntry)!)).toBe(true);

		await sm.rewriteEntries();
		expect(await Bun.file(file).bytes()).toEqual(afterCompaction);

		const leafId = sm.getLeafId()!;
		sm.branch(compactedId);
		expect(contextImages(sm)).toEqual([oldImage]);
		expect(imageOf(compactedEntry)).toBe(oldImage);

		// Returning to the compacted branch drops the bytes the detour inlined.
		sm.branch(leafId);
		expect(isBlobRef(imageOf(compactedEntry)!)).toBe(true);
		expect(contextImages(sm, { transcript: true })).toEqual([oldImage]);
	});

	it("keeps a live entry's non-image fields when its images move to blob refs", async () => {
		// Persistence truncates text this long; the live entry must not be.
		const longText = "x".repeat(600_000);
		const sm = SessionManager.create(tempDir.path(), sessionDir);
		sm.appendMessage({ role: "user", content: "start", timestamp: 0 });
		const compactedId = appendImageRead(sm, "old", pngData(6), longText);
		const keptId = sm.appendMessage({ role: "user", content: "kept turn", timestamp: 0 });
		await sm.flush();

		sm.appendCompaction("summary", undefined, keptId, 100);
		await sm.flush();
		const file = sm.getSessionFile()!;
		const afterCompaction = await Bun.file(file).bytes();

		expect(isBlobRef(imageOf(sm.getEntry(compactedId))!)).toBe(true);
		expect(textOf(sm.getEntry(compactedId))).toBe(longText);

		await sm.rewriteEntries();
		expect(await Bun.file(file).bytes()).toEqual(afterCompaction);
	});

	it("hands session_before_tree the image bytes of an abandoned branch that reaches into compacted history", async () => {
		const oldImage = pngData(7);
		const sm = SessionManager.create(tempDir.path(), sessionDir);
		const startId = sm.appendMessage({ role: "user", content: "start", timestamp: 0 });
		const compactedId = appendImageRead(sm, "old", oldImage);
		const keptId = sm.appendMessage({ role: "user", content: "kept turn", timestamp: 0 });
		sm.appendCompaction("summary", undefined, keptId, 100);
		const leafId = sm.getLeafId()!;
		sm.branch(startId);
		const siblingId = sm.appendMessage({ role: "user", content: "other path", timestamp: 0 });
		sm.branch(leafId);
		await sm.flush();
		expect(isBlobRef(imageOf(sm.getEntry(compactedId))!)).toBe(true);

		const preparations: TreePreparation[] = [];
		const extensionRunner = {
			hasHandlers: (eventType: string) => eventType === "session_before_tree",
			emit: async (event: { type: string; preparation?: TreePreparation }) => {
				if (event.preparation) preparations.push(event.preparation);
				return { cancel: true };
			},
		} as unknown as ExtensionRunner;
		const session = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: {
					model: getBundledModel("anthropic", "claude-sonnet-4-5")!,
					systemPrompt: ["test"],
					tools: [],
				},
			}),
			sessionManager: sm,
			settings: Settings.isolated(),
			modelRegistry: {} as never,
			extensionRunner,
		});
		try {
			expect((await session.navigateTree(siblingId)).cancelled).toBe(true);
		} finally {
			await session.dispose();
		}

		expect(preparations).toHaveLength(1);
		const summarized = preparations[0]!.entriesToSummarize.find(entry => entry.id === compactedId);
		expect(imageOf(summarized)).toBe(oldImage);
	});

	it("keeps compacted images inline when the session is not persisted", async () => {
		const oldImage = pngData(4);
		const sm = SessionManager.inMemory(tempDir.path());
		const compactedId = appendCompactedImageRead(sm, oldImage);

		expect(imageOf(sm.getEntry(compactedId))).toBe(oldImage);
		expect(await fs.readdir(getBlobsDir()).catch(() => [])).toEqual([]);
	});

	it("keeps images behind a provider-native compaction inline, since another provider re-summarizes them", async () => {
		const oldImage = pngData(5);
		const writer = SessionManager.create(tempDir.path(), sessionDir);
		writer.appendMessage({ role: "user", content: "old turn", timestamp: 0 });
		const behindNativeId = appendImageRead(writer, "old", oldImage);
		const keptId = writer.appendMessage({ role: "user", content: "kept turn", timestamp: 0 });
		writer.appendCompaction("(native)", undefined, keptId, 100, {
			preserveData: { openaiRemoteCompaction: { provider: "openai", replacementHistory: [] } },
		});
		await writer.flush();
		expect(imageOf(writer.getEntry(behindNativeId))).toBe(oldImage);

		const sm = await SessionManager.open(writer.getSessionFile()!, sessionDir);
		expect(imageOf(sm.getEntry(behindNativeId))).toBe(oldImage);
	});
});
