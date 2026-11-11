import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import {
	IndexedSessionStorage,
	type SessionStorageBackend,
	type SessionStorageIndexEntry,
} from "@oh-my-pi/pi-coding-agent/session/indexed-session-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	FileSessionStorage,
	MemorySessionStorage,
	type SessionStorageWriter,
	SessionWriteConflictError,
	type WriteTextAtomicOptions,
} from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { parseJsonlLenient, TempDir } from "@oh-my-pi/pi-utils";

const tempDirs: TempDir[] = [];

function makeTempDir(prefix: string): string {
	const dir = TempDir.createSync(prefix);
	tempDirs.push(dir);
	return dir.path();
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => dir.remove()));
});

function assistantMessage(text: string) {
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
		timestamp: Date.now(),
	};
}

function toolResultMessage(toolCallId: string, toolName: string, text: string) {
	return {
		role: "toolResult" as const,
		toolCallId,
		toolName,
		content: [{ type: "text" as const, text }],
		isError: false,
		timestamp: Date.now(),
	};
}

function readJsonl(file: string): Array<Record<string, unknown>> {
	return fs
		.readFileSync(file, "utf8")
		.trimEnd()
		.split("\n")
		.filter(Boolean)
		.map(line => JSON.parse(line) as Record<string, unknown>)
		.filter(entry => entry.type !== "title");
}

function messageRole(entry: Record<string, unknown>): string | undefined {
	const message = entry.message;
	if (!message || typeof message !== "object") return undefined;
	if (!("role" in message) || typeof message.role !== "string") return undefined;
	return message.role;
}

function messageContent(entry: Record<string, unknown>): unknown {
	const message = entry.message;
	if (!message || typeof message !== "object") return undefined;
	if (!("content" in message)) return undefined;
	return message.content;
}

function entryKind(entry: Record<string, unknown>): string {
	if (entry.type === "message") return messageRole(entry) ?? "message";
	if (entry.type === "custom") {
		return `custom:${typeof entry.customType === "string" ? entry.customType : ""}`;
	}
	return typeof entry.type === "string" ? entry.type : "unknown";
}

describe("SessionManager JSONL software-crash durability", () => {
	it("makes completed entries visible on disk without a microtask or flush", () => {
		const cwd = makeTempDir("@pi-immediate-cwd-");
		const sessionDir = path.join(cwd, "sessions");
		const manager = SessionManager.create(cwd, sessionDir);
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persisted session file path");

		manager.appendMessage({ role: "user", content: "queued before assistant", timestamp: Date.now() });
		expect(fs.existsSync(sessionFile)).toBe(false);

		// First assistant materializes the file via the synchronous rewrite path.
		manager.appendMessage(assistantMessage("hello"));
		expect(fs.existsSync(sessionFile)).toBe(true);

		let entries = readJsonl(sessionFile);
		expect(entries).toHaveLength(3);
		expect(messageRole(entries[1] ?? {})).toBe("user");
		expect(messageRole(entries[2] ?? {})).toBe("assistant");

		// Hot-path appends must land in the OS page cache before the call returns.
		// A software crash (SIGKILL / OOM / hard abort) after append and before the
		// next event-loop turn must not drop them.
		manager.appendMessage({ role: "user", content: "written immediately", timestamp: Date.now() });
		entries = readJsonl(sessionFile);
		expect(entries).toHaveLength(4);
		expect(messageRole(entries[3] ?? {})).toBe("user");
		expect(messageContent(entries[3] ?? {})).toBe("written immediately");

		manager.appendMessage(assistantMessage("second turn"));
		manager.appendCustomEntry("tool_execution_start", {
			toolCallId: "call-1",
			toolName: "bash",
			args: { command: "echo hi" },
		});
		manager.appendMessage(toolResultMessage("call-1", "bash", "hi"));

		entries = readJsonl(sessionFile);
		expect(entries.map(entryKind)).toEqual([
			"session",
			"user",
			"assistant",
			"user",
			"assistant",
			"custom:tool_execution_start",
			"toolResult",
		]);
	});

	it("reopens post-checkpoint user/assistant/tool events after a crash-equivalent snapshot", async () => {
		const cwd = makeTempDir("@pi-crash-reopen-cwd-");
		const sessionDir = path.join(cwd, "sessions");
		const manager = SessionManager.create(cwd, sessionDir);
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persisted session file path");

		// Durable checkpoint: materialize, then snapshot bytes.
		manager.appendMessage({ role: "user", content: "checkpoint user", timestamp: Date.now() });
		manager.appendMessage(assistantMessage("checkpoint assistant"));
		const checkpointBytes = fs.readFileSync(sessionFile);
		const checkpointKinds = parseJsonlLenient<Record<string, unknown>>(checkpointBytes.toString("utf8"))
			.filter(entry => entry.type !== "title")
			.map(entryKind);
		expect(checkpointKinds).toEqual(["session", "user", "assistant"]);

		// Completed events after the checkpoint — no flushSync, no await, no close.
		manager.appendMessage({ role: "user", content: "post-checkpoint user", timestamp: Date.now() });
		manager.appendMessage(assistantMessage("post-checkpoint assistant"));
		manager.appendCustomEntry("tool_execution_start", {
			toolCallId: "call-post",
			toolName: "read",
			args: { path: "README.md" },
		});
		manager.appendMessage(toolResultMessage("call-post", "read", "# readme"));

		// Crash equivalent: only bytes already on disk survive. Copy without yielding
		// to microtasks and reopen from that snapshot in a fresh manager.
		const crashPath = path.join(cwd, "crashed-session.jsonl");
		fs.writeFileSync(crashPath, fs.readFileSync(sessionFile));

		const reopened = await SessionManager.open(crashPath);
		const reopenedKinds = reopened.getEntries().map(entry => {
			if (entry.type === "message") return entry.message.role;
			if (entry.type === "custom") return `custom:${entry.customType}`;
			return entry.type;
		});
		expect(reopenedKinds).toEqual([
			"user",
			"assistant",
			"user",
			"assistant",
			"custom:tool_execution_start",
			"toolResult",
		]);

		const postUser = reopened
			.getEntries()
			.find(
				entry =>
					entry.type === "message" &&
					entry.message.role === "user" &&
					entry.message.content === "post-checkpoint user",
			);
		expect(postUser).toBeDefined();
		const toolResult = reopened
			.getEntries()
			.find(
				entry =>
					entry.type === "message" &&
					entry.message.role === "toolResult" &&
					entry.message.toolCallId === "call-post",
			);
		expect(toolResult).toBeDefined();
	});

	it("rewrites a malformed resumed tail before appending another entry", async () => {
		const cwd = makeTempDir("@pi-malformed-tail-cwd-");
		const manager = SessionManager.create(cwd, path.join(cwd, "sessions"));
		manager.appendMessage(assistantMessage("seed"));
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");
		await manager.close();

		fs.appendFileSync(sessionFile, '{"type":"message","id":"torn","message":{"role":"user","content":"lost');
		const resumed = await SessionManager.open(sessionFile);
		resumed.appendMessage({ role: "user", content: "after resume", timestamp: Date.now() });

		const entries = readJsonl(sessionFile);
		expect(entries.map(entryKind)).toEqual(["session", "assistant", "user"]);
		expect(messageContent(entries[2] ?? {})).toBe("after resume");
		await resumed.close();
	});

	it("rejects a corrupt session header without overwriting recoverable transcript bytes", async () => {
		const cwd = makeTempDir("@pi-corrupt-header-cwd-");
		const sessionFile = path.join(cwd, "corrupt-session.jsonl");
		const original = [
			"{broken header",
			JSON.stringify({
				type: "message",
				id: "m1",
				parentId: null,
				timestamp: "2026-08-27T00:00:00.000Z",
				message: { role: "user", content: "recover me", timestamp: 0 },
			}),
			"",
		].join("\n");
		fs.writeFileSync(sessionFile, original);
		const originalBytes = fs.readFileSync(sessionFile);

		await expect(SessionManager.open(sessionFile, undefined, undefined, { initialCwd: cwd })).rejects.toThrow(
			"session header is missing or malformed",
		);
		expect(fs.readFileSync(sessionFile)).toEqual(originalBytes);
	});

	it("keeps pre-assistant sessions out of history during shutdown", async () => {
		const cwd = makeTempDir("@pi-empty-session-cwd-");
		const sessionDir = path.join(cwd, "sessions");
		const manager = SessionManager.create(cwd, sessionDir);
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persisted session file path");

		manager.flushSync();
		await manager.close();

		expect(fs.existsSync(sessionFile)).toBe(false);
		expect(await SessionManager.list(cwd, sessionDir)).toHaveLength(0);

		manager.appendMessage({ role: "user", content: "queued before assistant", timestamp: Date.now() });
		manager.flushSync();

		expect(fs.existsSync(sessionFile)).toBe(false);
		expect(await SessionManager.list(cwd, sessionDir)).toHaveLength(0);
	});

	it("lets explicit rewrites materialize pre-assistant entries", async () => {
		const cwd = makeTempDir("@pi-explicit-rewrite-cwd-");
		const sessionDir = path.join(cwd, "sessions");
		const manager = SessionManager.create(cwd, sessionDir);
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persisted session file path");

		manager.appendMessage({ role: "user", content: "persist me", timestamp: Date.now() });
		await manager.rewriteEntries();

		expect(fs.existsSync(sessionFile)).toBe(true);
		const entries = readJsonl(sessionFile);
		expect(entries).toHaveLength(2);
		expect(messageRole(entries[1] ?? {})).toBe("user");
		expect(messageContent(entries[1] ?? {})).toBe("persist me");
	});

	it("makes fenced appends durable while an atomic rewrite is paused", async () => {
		// H1: in-place atomic fence used to mark entries dirty and return without
		// writing. A crash before the paused publish resumed lost every fenced
		// completed event. Superseding with #rewriteSynchronously must put them
		// on disk before append returns, and the abandoned atomic must not clobber.
		class PausedRewriteStorage extends MemorySessionStorage {
			readonly rewriteStarted = Promise.withResolvers<void>();
			readonly allowRewrite = Promise.withResolvers<void>();
			guardRejections = 0;

			override async writeTextAtomic(
				filePath: string,
				content: string,
				options?: WriteTextAtomicOptions,
			): Promise<void> {
				this.rewriteStarted.resolve();
				await this.allowRewrite.promise;
				if (options?.commitGuard && !options.commitGuard()) {
					this.guardRejections++;
					return;
				}
				this.writeTextSync(filePath, content);
			}
		}

		const storage = new PausedRewriteStorage();
		const manager = SessionManager.create("/cwd", "/sessions", storage);
		manager.appendMessage(assistantMessage("seed"));
		await manager.flush();
		manager.appendMessage({ role: "user", content: "checkpoint", timestamp: Date.now() });
		await manager.flush();

		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");

		const rewrite = manager.rewriteEntries();
		await storage.rewriteStarted.promise;

		manager.appendMessage({ role: "user", content: "fenced-user", timestamp: Date.now() });
		manager.appendMessage(assistantMessage("fenced-assistant"));
		manager.appendCustomEntry("tool_execution_start", {
			toolCallId: "fenced-call",
			toolName: "bash",
		});
		manager.appendMessage(toolResultMessage("fenced-call", "bash", "hi"));

		// Crash-equivalent while the atomic is still paused: only storage bytes survive.
		const crashKinds = parseJsonlLenient<Record<string, unknown>>(await storage.readText(sessionFile))
			.filter(entry => entry.type !== "title")
			.map(entryKind);
		expect(crashKinds).toEqual([
			"session",
			"assistant",
			"user",
			"user",
			"assistant",
			"custom:tool_execution_start",
			"toolResult",
		]);

		storage.allowRewrite.resolve();
		await rewrite;
		await manager.flush();

		const afterKinds = parseJsonlLenient<Record<string, unknown>>(await storage.readText(sessionFile))
			.filter(entry => entry.type !== "title")
			.map(entryKind);
		// Fenced events remain after the paused atomic settles (commitGuard may
		// reject a stale body, or a superseding rewrite already owns the file).
		expect(afterKinds).toEqual(crashKinds);
	});

	it("alerts once and retries all in-memory entries after a transient write failure", () => {
		const cwd = makeTempDir("@pi-write-fail-cwd-");
		const sessionDir = path.join(cwd, "sessions");
		const manager = SessionManager.create(cwd, sessionDir);
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");

		manager.appendMessage(assistantMessage("seed"));
		manager.appendMessage({ role: "user", content: "ok-user", timestamp: Date.now() });

		const writeSpy = spyOn(fs, "writeSync").mockImplementation(() => {
			throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
		});
		const failures: Error[] = [];
		manager.onPersistenceError(error => {
			failures.push(error);
		});

		try {
			expect(() =>
				manager.appendMessage({ role: "user", content: "failed-user", timestamp: Date.now() }),
			).not.toThrow();
			expect(() => manager.flushSync()).toThrow("ENOSPC");
			expect(failures).toHaveLength(1);

			writeSpy.mockRestore();
			expect(() =>
				manager.appendMessage({ role: "user", content: "recovered-user", timestamp: Date.now() }),
			).not.toThrow();
			expect(() => manager.flushSync()).not.toThrow();

			const users = readJsonl(sessionFile)
				.filter(entry => entry.type === "message" && messageRole(entry) === "user")
				.map(entry => messageContent(entry));
			expect(users).toEqual(["ok-user", "failed-user", "recovered-user"]);
			expect(failures).toHaveLength(1);
		} finally {
			writeSpy.mockRestore();
		}
	});

	it("reparents metadata children and keeps billed usage when durably discarding an entry", async () => {
		const cwd = makeTempDir("@pi-discard-metadata-cwd-");
		const sessionDir = path.join(cwd, "sessions");
		const manager = SessionManager.create(cwd, sessionDir);
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persisted session file path");

		const priorId = manager.appendMessage(assistantMessage("prior turn"));
		const discarded = assistantMessage("");
		const discardedId = manager.appendMessage(discarded);
		const serviceTierId = manager.appendServiceTierChange(null);
		const usageBefore = manager.getUsageStatistics();
		await manager.discardEntryDurably(discardedId);
		await manager.close();

		const reloaded = await SessionManager.open(sessionFile, sessionDir);
		const branch = reloaded.getBranch();
		expect(branch.some(entry => entry.id === discardedId)).toBe(false);
		expect(branch).toContainEqual(expect.objectContaining({ id: serviceTierId, parentId: priorId }));
		expect(branch.some(entry => entry.type === "model_usage")).toBe(false);
		expect(reloaded.getEntries()).toContainEqual(
			expect.objectContaining({
				type: "model_usage",
				parentId: serviceTierId,
				provider: discarded.provider,
				model: discarded.model,
				usage: discarded.usage,
			}),
		);
		expect(branch.at(-1)).toMatchObject({
			type: "branch_summary",
			summary: "",
			details: { kind: "discarded-entry-branch", discardedEntryId: discardedId },
			parentId: serviceTierId,
		});
		expect(reloaded.getUsageStatistics()).toEqual(usageBefore);
		await reloaded.close();
	});

	it("persists a branch marker when a discarded entry has content children", async () => {
		const cwd = makeTempDir("@pi-discard-content-cwd-");
		const sessionDir = path.join(cwd, "sessions");
		const manager = SessionManager.create(cwd, sessionDir);
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persisted session file path");

		const priorId = manager.appendMessage(assistantMessage("prior turn"));
		const discardedId = manager.appendMessage(assistantMessage(""));
		const contentChildId = manager.appendMessage({
			role: "user",
			content: "preserve off branch",
			timestamp: Date.now(),
		});
		await manager.discardEntryDurably(discardedId);
		await manager.close();

		const reloaded = await SessionManager.open(sessionFile, sessionDir);
		const branch = reloaded.getBranch();
		expect(reloaded.getEntries()).toContainEqual(expect.objectContaining({ id: discardedId }));
		expect(reloaded.getEntries()).toContainEqual(expect.objectContaining({ id: contentChildId }));
		expect(branch.some(entry => entry.id === discardedId || entry.id === contentChildId)).toBe(false);
		expect(branch.at(-1)).toMatchObject({
			type: "branch_summary",
			summary: "",
			details: { kind: "discarded-entry-branch", discardedEntryId: discardedId },
			parentId: priorId,
		});
		await reloaded.close();
	});

	it("coalesces withAppendBatch hot-path entries into one appendSync call while preserving leaf chaining, hooks, and failure recovery", async () => {
		const cwd = makeTempDir("@pi-batch-persist-cwd-");
		const sessionDir = path.join(cwd, "sessions");
		const storage = new FileSessionStorage();
		let appendSyncCalls = 0;
		const openWriter = storage.openWriter.bind(storage);
		spyOn(storage, "openWriter").mockImplementation((target, options) => {
			const writer = openWriter(target, options);
			const origAppendSync = writer.appendSync?.bind(writer);
			if (origAppendSync) {
				writer.appendSync = (line: string) => {
					appendSyncCalls++;
					origAppendSync(line);
				};
			}
			return writer;
		});

		const manager = SessionManager.create(cwd, sessionDir, storage);
		const seedId = manager.appendMessage(assistantMessage("seed"));
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");

		const notifiedIds: string[] = [];
		manager.onEntryAppended = entry => {
			// Hook must observe the batch already persisted on disk.
			expect(fs.existsSync(sessionFile)).toBe(true);
			notifiedIds.push(entry.id);
		};

		const observedLeaves: Array<string | null> = [];
		const batchIds = manager.withAppendBatch(() => {
			const id1 = manager.appendMessage(assistantMessage("turn reply"));
			observedLeaves.push(manager.getLeafId());
			const id2 = manager.appendMessage(toolResultMessage("c1", "bash", "out-1"));
			observedLeaves.push(manager.getLeafId());
			const id3 = manager.appendMessage(toolResultMessage("c2", "bash", "out-2"));
			observedLeaves.push(manager.getLeafId());
			return [id1, id2, id3];
		});

		expect(appendSyncCalls).toBe(1);
		expect(observedLeaves).toEqual(batchIds);
		expect(notifiedIds).toEqual(batchIds);

		// Simulate a mid-batch ENOSPC on the next batch, then verify recovery rewrites all retained entries.
		const sizeBeforeFail = fs.statSync(sessionFile).size;
		const writeSpy = spyOn(fs, "writeSync")
			.mockImplementationOnce(() => {
				fs.appendFileSync(sessionFile, '{"partial":');
				return 11;
			})
			.mockImplementation(() => {
				throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
			});

		let failedBatchIds: string[] = [];
		try {
			failedBatchIds = manager.withAppendBatch(() => [
				manager.appendMessage(toolResultMessage("c3", "bash", "out-3")),
				manager.appendMessage(toolResultMessage("c4", "bash", "out-4")),
			]);
			expect(fs.statSync(sessionFile).size).toBe(sizeBeforeFail);
			expect(() => manager.flushSync()).toThrow("ENOSPC");
		} finally {
			writeSpy.mockRestore();
		}

		const tailId = manager.appendMessage({ role: "user", content: "after recovery", timestamp: Date.now() });
		await manager.close();

		const reloaded = await SessionManager.open(sessionFile, sessionDir);
		const branch = reloaded.getBranch();
		expect(branch.map(entry => entry.id)).toEqual([seedId, ...batchIds, ...failedBatchIds, tailId]);
		expect(branch.map(entry => entry.parentId)).toEqual([
			null,
			seedId,
			batchIds[0],
			batchIds[1],
			batchIds[2],
			failedBatchIds[0],
			failedBatchIds[1],
		]);
		await reloaded.close();
	});

	it("flushes staged withAppendBatch entries to the original session before createBranchedSession switches files", async () => {
		const cwd = makeTempDir("@pi-batch-branch-cwd-");
		const sessionDir = path.join(cwd, "sessions");
		const manager = SessionManager.create(cwd, sessionDir);
		const seedId = manager.appendMessage(assistantMessage("seed"));
		const originalSessionFile = manager.getSessionFile();
		if (!originalSessionFile) throw new Error("Expected original session file");

		let stagedId = "";
		let branchedSessionFile: string | undefined;
		let postBranchId = "";
		manager.withAppendBatch(() => {
			stagedId = manager.appendMessage({ role: "user", content: "staged on original", timestamp: Date.now() });
			branchedSessionFile = manager.createBranchedSession(seedId);
			postBranchId = manager.appendMessage({ role: "user", content: "after branch", timestamp: Date.now() });
		});
		if (!branchedSessionFile) throw new Error("Expected branched session file");
		expect(branchedSessionFile).not.toBe(originalSessionFile);
		await manager.close();

		// Regression failure mode: staged entries drained on exit landed on the new branched session file.
		const originalReloaded = await SessionManager.open(originalSessionFile, sessionDir);
		expect(originalReloaded.getBranch().map(entry => entry.id)).toEqual([seedId, stagedId]);
		await originalReloaded.close();

		const branchedReloaded = await SessionManager.open(branchedSessionFile, sessionDir);
		expect(branchedReloaded.getBranch().map(entry => entry.id)).toEqual([seedId, postBranchId]);
		await branchedReloaded.close();
	});

	it("persists and notifies reentrant appends triggered from onEntryAppended during withAppendBatch", async () => {
		const cwd = makeTempDir("@pi-batch-reentrant-cwd-");
		const sessionDir = path.join(cwd, "sessions");
		const manager = SessionManager.create(cwd, sessionDir);
		const seedId = manager.appendMessage(assistantMessage("seed"));
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");

		const notifiedIds: string[] = [];
		let reentrantId = "";
		manager.onEntryAppended = entry => {
			notifiedIds.push(entry.id);
			if (!reentrantId) {
				reentrantId = manager.appendCustomEntry("hook-followup", { triggeredBy: entry.id });
			}
		};

		const [firstId, secondId] = manager.withAppendBatch(() => [
			manager.appendMessage({ role: "user", content: "first", timestamp: Date.now() }),
			manager.appendMessage(assistantMessage("second")),
		]);
		await manager.close();

		// Regression failure mode: clearing #appendBatch in finally dropped reentrant hook appends without persisting or notifying them.
		expect(reentrantId).not.toBe("");
		expect(notifiedIds).toEqual([firstId, secondId, reentrantId]);

		const reloaded = await SessionManager.open(sessionFile, sessionDir);
		expect(reloaded.getBranch().map(entry => entry.id)).toEqual([seedId, firstId, secondId, reentrantId]);
		await reloaded.close();
	});

	it("advances expectedDiskSize per confirmed line on indexed writers when a later batched append fails", async () => {
		const files = new Map<string, string>();
		const mtimes = new Map<string, number>();
		let mtime = 1;
		let failSecondAppend = false;
		let appendCount = 0;
		const backend: SessionStorageBackend = {
			async init(): Promise<void> {},
			async loadIndex(): Promise<SessionStorageIndexEntry[]> {
				return [...files].map(([filePath, content]) => ({
					path: filePath,
					size: Buffer.byteLength(content, "utf8"),
					mtimeMs: mtimes.get(filePath) ?? 0,
				}));
			},
			async readFull(filePath: string): Promise<string | null> {
				return files.get(filePath) ?? null;
			},
			async readSlices(filePath: string, prefixBytes: number, suffixBytes: number): Promise<[string, string]> {
				const bytes = Buffer.from(files.get(filePath) ?? "", "utf8");
				return [
					bytes.subarray(0, prefixBytes).toString("utf8"),
					suffixBytes > 0 ? bytes.subarray(Math.max(0, bytes.length - suffixBytes)).toString("utf8") : "",
				];
			},
			async append(filePath: string, line: string): Promise<void> {
				appendCount++;
				if (failSecondAppend && appendCount === 2) {
					throw new Error("indexed backend transient failure");
				}
				files.set(filePath, (files.get(filePath) ?? "") + line);
				mtimes.set(filePath, mtime++);
			},
			async writeFull(
				filePath: string,
				content: string,
				mtimeMs: number,
				_title?: unknown,
				expectedSize?: number | null,
			): Promise<void> {
				const current = files.get(filePath) ?? null;
				const actualSize = current === null ? null : Buffer.byteLength(current, "utf8");
				if (expectedSize !== undefined && actualSize !== expectedSize) {
					throw new SessionWriteConflictError(filePath, expectedSize, actualSize);
				}
				files.set(filePath, content);
				mtimes.set(filePath, mtimeMs);
			},
			async updateSessionTitle(filePath: string, _title: unknown, mtimeMs: number): Promise<void> {
				mtimes.set(filePath, mtimeMs);
			},
			async truncate(filePath: string, mtimeMs: number): Promise<void> {
				files.set(filePath, "");
				mtimes.set(filePath, mtimeMs);
			},
			async remove(paths: string[]): Promise<void> {
				for (const filePath of paths) {
					files.delete(filePath);
					mtimes.delete(filePath);
				}
			},
			async move(src: string, dst: string, mtimeMs: number): Promise<void> {
				const content = files.get(src);
				if (content === undefined) throw new Error(`ENOENT: ${src}`);
				files.delete(src);
				files.set(dst, content);
				mtimes.set(dst, mtimeMs);
			},
		};

		const storage = new IndexedSessionStorage(backend);
		await storage.initialize();
		const manager = SessionManager.create("/cwd", "/sessions/indexed", storage);
		const seedId = manager.appendMessage(assistantMessage("seed"));
		await manager.flush();
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");

		const sizeBeforeBatch = Buffer.byteLength(files.get(sessionFile) ?? "", "utf8");
		failSecondAppend = true;
		appendCount = 0;
		const [firstBatchId, secondBatchId] = manager.withAppendBatch(() => [
			manager.appendMessage(toolResultMessage("c1", "bash", "ok-prefix")),
			manager.appendMessage(toolResultMessage("c2", "bash", "fails-remote")),
		]);

		await expect(manager.flush()).rejects.toThrow("indexed backend transient failure");
		await storage.drain().catch(() => {});
		const sizeAfterFirstAppend = Buffer.byteLength(files.get(sessionFile) ?? "", "utf8");
		// Regression failure mode: all-or-nothing batch confirmation left expectedDiskSize at sizeBeforeBatch,
		// causing the recovery writeFull CAS check to fail with SessionWriteConflictError.
		expect(sizeAfterFirstAppend).toBeGreaterThan(sizeBeforeBatch);
		expect(manager.captureState().expectedDiskSize).toBe(sizeAfterFirstAppend);

		failSecondAppend = false;
		const recoveredId = manager.appendMessage({ role: "user", content: "recover", timestamp: Date.now() });
		await manager.flush();
		await manager.close();

		const reloaded = await SessionManager.open(sessionFile, "/sessions/indexed", storage);
		expect(reloaded.getBranch().map(entry => entry.id)).toEqual([seedId, firstBatchId, secondBatchId, recoveredId]);
		await reloaded.close();
	});

	it("preserves journal and leaf order on async-only writers when a synchronous append follows withAppendBatch", async () => {
		class AsyncOnlyFileSessionStorage extends FileSessionStorage {
			override openWriter(
				filePath: string,
				options?: { flags?: "a" | "w"; onError?: (err: Error) => void },
			): SessionStorageWriter {
				const inner = super.openWriter(filePath, options);
				return {
					append: line => inner.append(line),
					flush: () => inner.flush(),
					isOpen: () => inner.isOpen(),
					close: () => inner.close(),
					getError: () => inner.getError(),
				};
			}
		}

		const cwd = makeTempDir("@pi-async-only-batch-order-");
		const sessionDir = path.join(cwd, "sessions");
		const storage = new AsyncOnlyFileSessionStorage();
		const manager = SessionManager.create(cwd, sessionDir, storage);

		const seedId = manager.appendMessage(assistantMessage("seed"));
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");

		// Regression failure mode: deferring line B behind line A's Promise let synchronous
		// post-batch append C write A, C, B on disk, leaving B as the reopened leaf and hiding C.
		const [idA, idB] = manager.withAppendBatch(() => [
			manager.appendMessage(toolResultMessage("c1", "bash", "entry-A")),
			manager.appendMessage(toolResultMessage("c2", "bash", "entry-B")),
		]);
		const idC = manager.appendMessage({ role: "user", content: "entry-C", timestamp: Date.now() });

		await manager.flush();
		expect(manager.captureState().expectedDiskSize).toBe(fs.statSync(sessionFile).size);
		await manager.close();

		const diskRecords = parseJsonlLenient<Record<string, unknown>>(fs.readFileSync(sessionFile, "utf8"));
		const diskEntryIds = diskRecords
			.filter(record => record.type !== "session" && typeof record.id === "string")
			.map(record => record.id);
		expect(diskEntryIds).toEqual([seedId, idA, idB, idC]);

		const reopened = await SessionManager.open(sessionFile, sessionDir);
		expect(reopened.getLeafId()).toBe(idC);
		expect(reopened.getBranch().map(entry => entry.id)).toEqual([seedId, idA, idB, idC]);
		await reopened.close();
	});

	it.each(["flushSync", "captureState"] as const)(
		"preserves [A, B, C] notification and replica leaf order when onEntryAppended(A) appends C and calls %s",
		async reentrantAction => {
			const cwd = makeTempDir(`@pi-batch-reentrant-order-${reentrantAction}-`);
			const sessionDir = path.join(cwd, "sessions");
			const manager = SessionManager.create(cwd, sessionDir);
			const replica = SessionManager.inMemory(cwd);

			let seedRecorded = false;
			manager.onEntryAppended = entry => {
				if (!seedRecorded) {
					seedRecorded = true;
					replica.ingestReplicatedEntry(structuredClone(entry));
				}
			};
			const seedId = manager.appendMessage(assistantMessage("seed"));
			const sessionFile = manager.getSessionFile();
			if (!sessionFile) throw new Error("Expected session file");

			const notifiedIds: string[] = [];
			let idC = "";
			let diskIdsInsideCallback: unknown[] = [];
			let capturedIdsInsideCallback: string[] | undefined;

			manager.onEntryAppended = entry => {
				notifiedIds.push(entry.id);
				replica.ingestReplicatedEntry(structuredClone(entry));
				if (notifiedIds.length === 1) {
					idC = manager.appendCustomEntry("hook-followup", { triggeredBy: entry.id });
					if (reentrantAction === "flushSync") {
						manager.flushSync();
					} else {
						capturedIdsInsideCallback = manager.captureState().entries.map(item => item.id);
					}
					const diskRecords = parseJsonlLenient<Record<string, unknown>>(fs.readFileSync(sessionFile, "utf8"));
					diskIdsInsideCallback = diskRecords
						.filter(record => record.type !== "session" && typeof record.id === "string")
						.map(record => record.id);
				}
			};

			// Regression failure mode: nested #drainAppendBatch() inside flushSync()/captureState()
			// notified C before the outer loop reached B, delivering [A, C, B] so replica leaf stayed at B.
			const [idA, idB] = manager.withAppendBatch(() => [
				manager.appendMessage({ role: "user", content: "entry-A", timestamp: 1001 }),
				manager.appendMessage(assistantMessage("entry-B")),
			]);
			await manager.close();

			expect(idC).not.toBe("");
			expect(diskIdsInsideCallback).toEqual([seedId, idA, idB, idC]);
			if (capturedIdsInsideCallback) {
				expect(capturedIdsInsideCallback).toEqual([seedId, idA, idB, idC]);
			}
			expect(notifiedIds).toEqual([idA, idB, idC]);
			expect(replica.getLeafId()).toBe(idC);
			expect(replica.getBranch().map(entry => entry.id)).toEqual([seedId, idA, idB, idC]);
		},
	);

	it("preserves [A, B, C] notification and replica leaf order when a synchronous rewrite flushes [A, B] and onEntryAppended(A) appends C with flushSync", async () => {
		const cwd = makeTempDir("@pi-rewrite-reentrant-order-");
		const sessionDir = path.join(cwd, "sessions");
		const manager = SessionManager.create(cwd, sessionDir);
		const replica = SessionManager.inMemory(cwd);

		const notifiedIds: string[] = [];
		let idC = "";
		let diskIdsInsideCallback: unknown[] = [];

		manager.onEntryAppended = entry => {
			notifiedIds.push(entry.id);
			replica.ingestReplicatedEntry(structuredClone(entry));
			if (notifiedIds.length === 1) {
				idC = manager.appendCustomEntry("rewrite-hook-followup", { triggeredBy: entry.id });
				manager.flushSync();
				const sessionFile = manager.getSessionFile();
				if (!sessionFile) throw new Error("Expected materialized session file");
				const diskRecords = parseJsonlLenient<Record<string, unknown>>(fs.readFileSync(sessionFile, "utf8"));
				diskIdsInsideCallback = diskRecords
					.filter(record => record.type !== "session" && typeof record.id === "string")
					.map(record => record.id);
			}
		};

		// Cold session (!#fileIsCurrent) forces [A, B] through #rewriteSynchronously() before notifications fire.
		const [idA, idB] = manager.withAppendBatch(() => {
			const first = manager.appendMessage(assistantMessage("cold-A"));
			const second = manager.appendMessage(toolResultMessage("c1", "bash", "cold-B"));
			manager.flushSync();
			return [first, second];
		});
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");
		await manager.close();

		expect(idC).not.toBe("");
		expect(diskIdsInsideCallback).toEqual([idA, idB, idC]);
		expect(notifiedIds).toEqual([idA, idB, idC]);
		expect(replica.getLeafId()).toBe(idC);
		expect(replica.getBranch().map(entry => entry.id)).toEqual([idA, idB, idC]);

		const reopened = await SessionManager.open(sessionFile, sessionDir);
		expect(reopened.getLeafId()).toBe(idC);
		expect(reopened.getBranch().map(entry => entry.id)).toEqual([idA, idB, idC]);
		await reopened.close();
	});

	it("preserves [A, B, C] notification and replica leaf order when appendEntriesAtomically notifies [A, B] and onEntryAppended(A) appends C", async () => {
		const cwd = makeTempDir("@pi-atomic-batch-reentrant-order-");
		const sessionDir = path.join(cwd, "sessions");
		const manager = SessionManager.create(cwd, sessionDir);
		const replica = SessionManager.inMemory(cwd);

		let seedRecorded = false;
		manager.onEntryAppended = entry => {
			if (!seedRecorded) {
				seedRecorded = true;
				replica.ingestReplicatedEntry(structuredClone(entry));
			}
		};
		const seedId = manager.appendMessage(assistantMessage("seed"));

		const notifiedIds: string[] = [];
		let idC = "";
		manager.onEntryAppended = entry => {
			notifiedIds.push(entry.id);
			replica.ingestReplicatedEntry(structuredClone(entry));
			if (notifiedIds.length === 1) {
				idC = manager.appendCustomEntry("atomic-hook-followup", { triggeredBy: entry.id });
			}
		};

		const [idA, idB] = await manager.appendEntriesAtomically(() => [
			manager.appendMessage({ role: "user", content: "atomic-A", timestamp: 2001 }),
			manager.appendMessage(assistantMessage("atomic-B")),
		]);
		await manager.close();

		expect(idC).not.toBe("");
		expect(notifiedIds).toEqual([idA, idB, idC]);
		expect(replica.getLeafId()).toBe(idC);
		expect(replica.getBranch().map(entry => entry.id)).toEqual([seedId, idA, idB, idC]);
	});

	it("drains a staged cold-session assistant message before setSessionName inserts or notifies the title entry", async () => {
		const cwd = makeTempDir("@pi-cold-batch-title-order-");
		const sessionDir = path.join(cwd, "sessions");
		const manager = SessionManager.create(cwd, sessionDir);
		const replica = SessionManager.inMemory(cwd);

		const notifiedTypes: string[] = [];
		const notifiedIds: string[] = [];
		manager.onEntryAppended = entry => {
			notifiedTypes.push(entry.type);
			notifiedIds.push(entry.id);
			replica.ingestReplicatedEntry(structuredClone(entry));
		};

		// Regression failure mode: setSessionName() inserted and notified title_change before
		// draining the staged first assistant message, delivering [title_change, message] (leaving
		// replica leaf at M) and writing title_change twice on disk (initial rewrite + hot append).
		let renamePromise: Promise<boolean> | undefined;
		const idM = manager.withAppendBatch(() => {
			const messageId = manager.appendMessage(assistantMessage("first assistant"));
			renamePromise = manager.setSessionName("Batch Title");
			return messageId;
		});
		expect(await renamePromise).toBe(true);
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected materialized session file");
		await manager.close();

		expect(notifiedTypes).toEqual(["message", "title_change"]);
		expect(notifiedIds[0]).toBe(idM);
		const titleEntryId = notifiedIds[1];
		if (!titleEntryId) throw new Error("Expected title_change notification");

		const diskRecords = parseJsonlLenient<Record<string, unknown>>(fs.readFileSync(sessionFile, "utf8"));
		const diskEntryIds = diskRecords
			.filter(record => record.type !== "session" && typeof record.id === "string")
			.map(record => record.id);
		expect(diskEntryIds).toEqual([idM, titleEntryId]);

		expect(replica.getLeafId()).toBe(titleEntryId);
		expect(replica.getBranch().map(entry => entry.id)).toEqual([idM, titleEntryId]);

		const reopened = await SessionManager.open(sessionFile, sessionDir);
		expect(reopened.getSessionName()).toBe("Batch Title");
		expect(reopened.getLeafId()).toBe(titleEntryId);
		expect(reopened.getBranch().map(entry => entry.id)).toEqual([idM, titleEntryId]);
		await reopened.close();
	});

	it("drains a staged message on a warm session before setSessionName inserts or notifies the title entry", async () => {
		const cwd = makeTempDir("@pi-warm-batch-title-order-");
		const sessionDir = path.join(cwd, "sessions");
		const manager = SessionManager.create(cwd, sessionDir);
		const replica = SessionManager.inMemory(cwd);

		let seedRecorded = false;
		manager.onEntryAppended = entry => {
			if (!seedRecorded) {
				seedRecorded = true;
				replica.ingestReplicatedEntry(structuredClone(entry));
			}
		};
		const seedId = manager.appendMessage(assistantMessage("seed"));
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");

		const notifiedTypes: string[] = [];
		const notifiedIds: string[] = [];
		manager.onEntryAppended = entry => {
			notifiedTypes.push(entry.type);
			notifiedIds.push(entry.id);
			replica.ingestReplicatedEntry(structuredClone(entry));
		};

		let renamePromise: Promise<boolean> | undefined;
		const idM = manager.withAppendBatch(() => {
			const messageId = manager.appendMessage({
				role: "user",
				content: "warm staged message",
				timestamp: 3001,
			});
			renamePromise = manager.setSessionName("Warm Title", "user");
			return messageId;
		});
		expect(await renamePromise).toBe(true);
		await manager.close();

		expect(notifiedTypes).toEqual(["message", "title_change"]);
		expect(notifiedIds[0]).toBe(idM);
		const titleEntryId = notifiedIds[1];
		if (!titleEntryId) throw new Error("Expected title_change notification");

		const diskRecords = parseJsonlLenient<Record<string, unknown>>(fs.readFileSync(sessionFile, "utf8"));
		const diskEntryIds = diskRecords
			.filter(record => record.type !== "session" && typeof record.id === "string")
			.map(record => record.id);
		expect(diskEntryIds).toEqual([seedId, idM, titleEntryId]);

		expect(replica.getLeafId()).toBe(titleEntryId);
		expect(replica.getBranch().map(entry => entry.id)).toEqual([seedId, idM, titleEntryId]);

		const reopened = await SessionManager.open(sessionFile, sessionDir);
		expect(reopened.getSessionName()).toBe("Warm Title");
		expect(reopened.getLeafId()).toBe(titleEntryId);
		expect(reopened.getBranch().map(entry => entry.id)).toEqual([seedId, idM, titleEntryId]);
		await reopened.close();
	});
});
