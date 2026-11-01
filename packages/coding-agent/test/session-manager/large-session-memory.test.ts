import { afterEach, describe, expect, it } from "bun:test";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { listSessions } from "@oh-my-pi/pi-coding-agent/session/session-listing";
import { loadEntriesFromFile } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	FileSessionStorage,
	MemorySessionStorage,
	type WriteTextAtomicOptions,
} from "@oh-my-pi/pi-coding-agent/session/session-storage";
import * as snapcompact from "@oh-my-pi/snapcompact";

class CountingMemorySessionStorage extends MemorySessionStorage {
	writeTextSyncCalls = 0;

	override writeTextSync(filePath: string, content: string): void {
		this.writeTextSyncCalls++;
		super.writeTextSync(filePath, content);
	}
}

function matchingCrc32Suffix(prefix: Uint8Array, targetCrc: number): Uint8Array {
	const prefixCrc = Bun.hash.crc32(prefix);
	const zeroSuffix = new Uint8Array(4);
	const zeroCrc = Bun.hash.crc32(zeroSuffix, prefixCrc) >>> 0;
	const targetDelta = (targetCrc ^ zeroCrc) >>> 0;
	const rows = Array.from({ length: 32 }, (_, outputBit) => {
		let coefficients = 0;
		for (let inputBit = 0; inputBit < 32; inputBit++) {
			const probe = new Uint8Array(4);
			probe[inputBit >>> 3] = 1 << (inputBit & 7);
			const effect = (Bun.hash.crc32(probe, prefixCrc) ^ zeroCrc) >>> 0;
			coefficients |= ((effect >>> outputBit) & 1) << inputBit;
		}
		return { coefficients: coefficients >>> 0, result: (targetDelta >>> outputBit) & 1 };
	});

	for (let column = 0; column < 32; column++) {
		const pivot = rows.findIndex((row, rowIndex) => rowIndex >= column && ((row.coefficients >>> column) & 1) === 1);
		if (pivot === -1) throw new Error("Expected CRC32 suffix matrix to be invertible");
		[rows[column], rows[pivot]] = [rows[pivot]!, rows[column]!];
		for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
			if (rowIndex === column || ((rows[rowIndex]!.coefficients >>> column) & 1) === 0) continue;
			rows[rowIndex]!.coefficients = (rows[rowIndex]!.coefficients ^ rows[column]!.coefficients) >>> 0;
			rows[rowIndex]!.result ^= rows[column]!.result;
		}
	}

	const suffix = new Uint8Array(4);
	for (let bit = 0; bit < 32; bit++) {
		if (rows[bit]!.result === 1) suffix[bit >>> 3] |= 1 << (bit & 7);
	}
	return suffix;
}

function sameLengthCrc32Collision(body: Uint8Array): Uint8Array {
	if (body.byteLength < 5) throw new Error("Expected enough bytes for a distinct CRC32 collision");
	const collision = Uint8Array.from(body);
	collision[0] ^= 1;
	collision.set(matchingCrc32Suffix(collision.subarray(0, -4), Bun.hash.crc32(body)), collision.byteLength - 4);
	if (
		collision.byteLength !== body.byteLength ||
		Bun.hash.crc32(collision) !== Bun.hash.crc32(body) ||
		collision.every((byte, index) => byte === body[index])
	) {
		throw new Error("Expected a different body with the same length and CRC32");
	}
	return collision;
}

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

class AcknowledgementLossStorage extends FileSessionStorage {
	failNextPublish = false;
	corruptNextPublishedBody = false;
	prefixNextPublishedBodyWithBom = false;
	publishedCrcCollision = false;
	publishedBomPrefixedBody = false;
	readTextCalls = 0;

	override async writeLinesAtomic(
		path: string,
		lines: Iterable<string>,
		options?: WriteTextAtomicOptions,
	): Promise<void> {
		await super.writeLinesAtomic(path, lines, options);
		if (!this.failNextPublish) return;
		if (this.corruptNextPublishedBody) {
			const published = await fsp.readFile(path);
			const collision = sameLengthCrc32Collision(published);
			this.publishedCrcCollision =
				collision.byteLength === published.byteLength &&
				Bun.hash.crc32(collision) === Bun.hash.crc32(published) &&
				!collision.every((byte, index) => byte === published[index]);
			await fsp.writeFile(path, collision);
		}
		if (this.prefixNextPublishedBodyWithBom) {
			const published = await fsp.readFile(path);
			await fsp.writeFile(path, Buffer.concat([UTF8_BOM, published]));
			const persisted = await fsp.readFile(path);
			this.publishedBomPrefixedBody =
				persisted.subarray(0, UTF8_BOM.byteLength).equals(UTF8_BOM) &&
				persisted.subarray(UTF8_BOM.byteLength).equals(published);
		}
		throw new Error("simulated acknowledgement loss");
	}

	override async readText(path: string): Promise<string> {
		this.readTextCalls++;
		if (this.failNextPublish) throw new Error("full read would materialize the session");
		return super.readText(path);
	}
}

class UnreadableAfterFailedPublishStorage extends MemorySessionStorage {
	failNextPublish = false;

	override async writeTextAtomic(path: string, content: string, options?: WriteTextAtomicOptions): Promise<void> {
		if (!this.failNextPublish) return super.writeTextAtomic(path, content, options);
		throw new Error("simulated publish failure");
	}

	override readText(path: string): Promise<string> {
		if (this.failNextPublish) return Promise.reject(new Error("simulated readback failure"));
		return super.readText(path);
	}
}

function makeAssistantMessage(text: string) {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected built-in anthropic model to exist");
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop" as const,
		timestamp: 2,
	};
}

describe("large session memory guards", () => {
	const tempDirs: string[] = [];

	afterEach(async () => {
		await Promise.all(tempDirs.map(dir => fsp.rm(dir, { recursive: true, force: true })));
		tempDirs.length = 0;
	});

	it("does not rewrite an already-current session during sync flush", () => {
		const storage = new CountingMemorySessionStorage();
		const session = SessionManager.create("/work", "/sessions", storage);
		session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		session.appendMessage(makeAssistantMessage("hi"));

		storage.writeTextSyncCalls = 0;
		session.flushSync();

		expect(storage.writeTextSyncCalls).toBe(0);
	});

	it("keeps a published rewrite durable when its acknowledgment is lost without materializing the session", async () => {
		const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "pi-rewrite-ack-loss-"));
		tempDirs.push(dir);
		const storage = new AcknowledgementLossStorage();
		const session = SessionManager.create(dir, path.join(dir, "sessions"), storage);
		await session.ensureOnDisk();
		// 1- to 4-byte UTF-8 code points spanning many 64 KiB comparison windows and stream chunks.
		session.appendMessage(makeAssistantMessage(`a${"aé中😀".repeat(20_000)}`));

		storage.failNextPublish = true;
		await expect(session.rewriteEntries()).resolves.toBeUndefined();

		expect(storage.readTextCalls).toBe(0);
		expect(session.captureState().onDisk).toBe(true);
		await session.close();
	});

	it("rejects a same-length CRC32 collision after an acknowledgement loss", async () => {
		const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "pi-rewrite-ack-collision-"));
		tempDirs.push(dir);
		const storage = new AcknowledgementLossStorage();
		const session = SessionManager.create(dir, path.join(dir, "sessions"), storage);
		await session.ensureOnDisk();
		session.appendMessage(makeAssistantMessage("persisted before acknowledgement loss"));

		storage.failNextPublish = true;
		storage.corruptNextPublishedBody = true;
		await expect(session.rewriteEntries()).rejects.toThrow("simulated acknowledgement loss");

		expect(storage.publishedCrcCollision).toBe(true);
		expect(storage.readTextCalls).toBe(0);
	});

	it("rejects a byte-order-mark-prefixed body after an acknowledgement loss", async () => {
		const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "pi-rewrite-ack-bom-"));
		tempDirs.push(dir);
		const storage = new AcknowledgementLossStorage();
		const session = SessionManager.create(dir, path.join(dir, "sessions"), storage);
		await session.ensureOnDisk();
		session.appendMessage(makeAssistantMessage("persisted before acknowledgement loss"));

		storage.failNextPublish = true;
		storage.prefixNextPublishedBodyWithBom = true;
		await expect(session.rewriteEntries()).rejects.toThrow("simulated acknowledgement loss");

		expect(storage.publishedBomPrefixedBody).toBe(true);
		expect(storage.readTextCalls).toBe(0);
	});

	it("reports the publish error when a failed acknowledgement cannot be read back", async () => {
		const storage = new UnreadableAfterFailedPublishStorage();
		const session = SessionManager.create("/work", "/sessions", storage);
		await session.ensureOnDisk();
		session.appendMessage(makeAssistantMessage("persisted before the failed publish"));

		storage.failNextPublish = true;
		await expect(session.rewriteEntries()).rejects.toThrow("simulated publish failure");
	});

	it("elides superseded compactions only in the forward transcript", async () => {
		const storage = new CountingMemorySessionStorage();
		const session = SessionManager.create("/work", "/sessions", storage);
		const firstKeptEntryId = session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		session.appendMessage(makeAssistantMessage("hi"));

		const firstSummary = `first-${"x".repeat(4096)}`;
		const secondSummary = `second-${"y".repeat(4096)}`;
		const archivedFrame = btoa("archived frame");
		const replacementHistory = [
			{ type: "message", role: "user", content: [{ type: "input_text", text: "Preserved user" }] },
		];
		const firstPreserve = {
			openaiRemoteCompaction: { provider: "openai", replacementHistory },
			[snapcompact.PRESERVE_KEY]: {
				frames: [{ data: archivedFrame, mimeType: "image/png", cols: 10, rows: 10, chars: 14 }],
				totalChars: 14,
				truncatedChars: 0,
				textHead: "archived",
				textTail: "frame",
			},
		};
		const firstCompactionId = session.appendCompaction(firstSummary, undefined, firstKeptEntryId, 1000, {
			preserveData: firstPreserve,
		});
		const rewindId = session.appendMessage({ role: "user", content: "between compactions", timestamp: 3 });
		session.appendCompaction(secondSummary, undefined, rewindId, 2000);
		await session.flush();

		const firstCompaction = session.getEntry(firstCompactionId);
		if (firstCompaction?.type !== "compaction") throw new Error("Expected first compaction");
		expect(firstCompaction.summary).toBe(firstSummary);
		expect(firstCompaction.preserveData).toEqual(firstPreserve);

		const transcriptCompactions = session
			.buildSessionContext({ transcript: true })
			.messages.filter(message => message.role === "compactionSummary");
		const supersededDisplay = transcriptCompactions[0];
		if (supersededDisplay?.role !== "compactionSummary") throw new Error("Expected superseded transcript compaction");
		expect(supersededDisplay.summary).toContain("Superseded compaction");
		expect((supersededDisplay.blocks ?? []).some(block => block.type === "image")).toBeFalse();

		session.branch(rewindId);
		const rewoundSummary = session.buildSessionContext().messages[0];
		if (rewoundSummary?.role !== "compactionSummary") throw new Error("Expected rewound compaction summary");
		expect(rewoundSummary.summary).toBe(firstSummary);
		expect(rewoundSummary.providerPayload).toEqual({
			type: "openaiResponsesHistory",
			provider: "openai",
			items: replacementHistory,
		});
		expect(rewoundSummary.blocks?.find(block => block.type === "image")).toMatchObject({ data: archivedFrame });

		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");
		const persisted = await storage.readText(sessionFile);
		expect(persisted).toContain(firstSummary);
		expect(persisted).toContain(archivedFrame);
		expect(persisted).toContain(secondSummary);
	});

	it("streams large session files without discarding historical compactions", async () => {
		const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-large-session-"));
		tempDirs.push(tempDir);
		const sessionFile = path.join(tempDir, "large.jsonl");
		const oldSummary = `old-${"x".repeat(5 * 1024 * 1024)}`;
		const latestSummary = `latest-${"y".repeat(5 * 1024 * 1024)}`;
		const lines = [
			{ type: "session", version: 3, id: "sess", timestamp: "2026-01-01T00:00:00.000Z", cwd: tempDir },
			{
				type: "message",
				id: "u1",
				parentId: null,
				timestamp: "2026-01-01T00:00:01.000Z",
				message: { role: "user", content: "hi", timestamp: 1 },
			},
			{
				type: "compaction",
				id: "c1",
				parentId: "u1",
				timestamp: "2026-01-01T00:00:02.000Z",
				summary: oldSummary,
				firstKeptEntryId: "u1",
				tokensBefore: 1000,
				preserveData: { stale: true },
			},
			{
				type: "message",
				id: "a1",
				parentId: "c1",
				timestamp: "2026-01-01T00:00:03.000Z",
				message: makeAssistantMessage("hello"),
			},
			{
				type: "compaction",
				id: "c2",
				parentId: "a1",
				timestamp: "2026-01-01T00:00:04.000Z",
				summary: latestSummary,
				firstKeptEntryId: "a1",
				tokensBefore: 1000,
			},
		].map(entry => `${JSON.stringify(entry)}\n`);
		await fsp.writeFile(sessionFile, lines.join(""));

		const entries = await loadEntriesFromFile(sessionFile);
		const compactions = entries.filter(entry => entry.type === "compaction");

		expect(compactions).toHaveLength(2);
		expect(compactions[0]?.summary).toBe(oldSummary);
		expect(compactions[0]?.preserveData).toEqual({ stale: true });
		expect(compactions[1]?.summary).toBe(latestSummary);
	});

	it("preserves sibling-branch compactions when a newer compaction lands on another branch", async () => {
		const storage = new CountingMemorySessionStorage();
		const session = SessionManager.create("/work", "/sessions", storage);
		const rootId = session.appendMessage({ role: "user", content: "shared root", timestamp: 1 });
		session.appendMessage(makeAssistantMessage("root reply"));

		const branchACompactionSummary = `branch-a-${"x".repeat(1024)}`;
		const branchAPreserve = { openaiRemoteCompaction: { provider: "anthropic", replacementHistory: [] } };
		session.appendCompaction(branchACompactionSummary, undefined, rootId, 1000, {
			preserveData: branchAPreserve,
		});
		const branchACompactionId = session.getLeafId();
		if (!branchACompactionId) throw new Error("Expected branch A compaction id");

		session.branch(rootId);
		session.appendMessage(makeAssistantMessage("branch B reply"));
		const branchBCompactionSummary = `branch-b-${"y".repeat(1024)}`;
		session.appendCompaction(branchBCompactionSummary, undefined, rootId, 1000);

		const branchACompaction = session.getEntry(branchACompactionId);
		if (branchACompaction?.type !== "compaction") throw new Error("Expected sibling compaction entry");
		expect(branchACompaction.summary).toBe(branchACompactionSummary);
		expect(branchACompaction.preserveData).toEqual(branchAPreserve);

		const branchBCompactions = session
			.getEntries()
			.filter(entry => entry.type === "compaction" && entry.summary === branchBCompactionSummary);
		expect(branchBCompactions).toHaveLength(1);
	});

	it("preserves loaded compactions on every branch", async () => {
		const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-branch-load-"));
		tempDirs.push(tempDir);
		const sessionFile = path.join(tempDir, "branched.jsonl");
		const branchASummary = `branch-a-${"x".repeat(1024)}`;
		const branchBOldSummary = `branch-b-old-${"y".repeat(1024)}`;
		const branchBNewSummary = `branch-b-new-${"z".repeat(1024)}`;
		const lines = [
			{ type: "session", version: 3, id: "sess", timestamp: "2026-01-01T00:00:00.000Z", cwd: tempDir },
			{
				type: "message",
				id: "u1",
				parentId: null,
				timestamp: "2026-01-01T00:00:01.000Z",
				message: { role: "user", content: "shared", timestamp: 1 },
			},
			{
				type: "compaction",
				id: "ca",
				parentId: "u1",
				timestamp: "2026-01-01T00:00:02.000Z",
				summary: branchASummary,
				firstKeptEntryId: "u1",
				tokensBefore: 1000,
				preserveData: { openaiRemoteCompaction: { provider: "anthropic", replacementHistory: [] } },
			},
			{
				type: "compaction",
				id: "cb1",
				parentId: "u1",
				timestamp: "2026-01-01T00:00:03.000Z",
				summary: branchBOldSummary,
				firstKeptEntryId: "u1",
				tokensBefore: 1000,
				preserveData: { stale: true },
			},
			{
				type: "message",
				id: "a1",
				parentId: "cb1",
				timestamp: "2026-01-01T00:00:04.000Z",
				message: makeAssistantMessage("branch b reply"),
			},
			{
				type: "compaction",
				id: "cb2",
				parentId: "a1",
				timestamp: "2026-01-01T00:00:05.000Z",
				summary: branchBNewSummary,
				firstKeptEntryId: "a1",
				tokensBefore: 1000,
			},
		].map(entry => `${JSON.stringify(entry)}\n`);
		await fsp.writeFile(sessionFile, lines.join(""));

		const entries = await loadEntriesFromFile(sessionFile);
		const byId = new Map(entries.map(entry => [(entry as { id?: string }).id, entry] as const));
		const branchA = byId.get("ca");
		const branchBOld = byId.get("cb1");
		const branchBNew = byId.get("cb2");
		if (branchA?.type !== "compaction" || branchBOld?.type !== "compaction" || branchBNew?.type !== "compaction") {
			throw new Error("Expected compaction entries");
		}

		expect(branchA.summary).toBe(branchASummary);
		expect(branchA.preserveData).toBeDefined();
		expect(branchBOld.summary).toBe(branchBOldSummary);
		expect(branchBOld.preserveData).toEqual({ stale: true });
		expect(branchBNew.summary).toBe(branchBNewSummary);
	});

	it("uses developer prefix text when a fork has no early user message", async () => {
		const storage = new MemorySessionStorage();
		const sessionDir = "/sessions/project";
		const sessionFile = `${sessionDir}/fork.jsonl`;
		const lines = [
			{ type: "session", version: 3, id: "fork", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/work" },
			{
				type: "message",
				id: "d1",
				parentId: null,
				timestamp: "2026-01-01T00:00:01.000Z",
				message: { role: "developer", content: "Plan fork context", timestamp: 1 },
			},
		].map(entry => `${JSON.stringify(entry)}\n`);
		storage.writeTextSync(sessionFile, lines.join(""));

		const sessions = await listSessions(sessionDir, storage);

		expect(sessions).toHaveLength(1);
		expect(sessions[0]?.firstMessage).toBe("Plan fork context");
	});
});
