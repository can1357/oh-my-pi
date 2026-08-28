import { describe, expect, it } from "bun:test";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import {
	IndexedSessionStorage,
	type SessionStorageBackend,
} from "@oh-my-pi/pi-coding-agent/session/indexed-session-storage";
import {
	SessionManager,
	SessionPersistenceIndeterminateError,
} from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	MemorySessionStorage,
	type SessionStorageWriter,
	type WriteTextAtomicOptions,
} from "@oh-my-pi/pi-coding-agent/session/session-storage";
import type { SessionTitleUpdate } from "@oh-my-pi/pi-coding-agent/session/session-title-slot";

interface DetachableWriter extends SessionStorageWriter {
	detach(): void;
}

class DetachingRewriteStorage extends MemorySessionStorage {
	readonly detachedLines: string[] = [];
	readonly rewriteStarted = Promise.withResolvers<void>();
	readonly allowRewrite = Promise.withResolvers<void>();
	pausedRewrites = 0;
	guardRejections = 0;
	readonly #writers = new Set<DetachableWriter>();

	override openWriter(
		path: string,
		options?: { flags?: "a" | "w"; onError?: (err: Error) => void },
	): SessionStorageWriter {
		const inner = super.openWriter(path, options);
		const writers = this.#writers;
		const detachedLines = this.detachedLines;
		let detached = false;
		const writer: DetachableWriter = {
			async append(line: string): Promise<void> {
				if (detached) {
					detachedLines.push(line);
					return;
				}
				await inner.append(line);
			},
			async flush(): Promise<void> {
				await inner.flush();
			},
			isOpen(): boolean {
				const open = inner.isOpen();
				return open;
			},
			async close(): Promise<void> {
				writers.delete(writer);
				await inner.close();
			},
			getError(): Error | undefined {
				const error = inner.getError();
				return error;
			},
			detach(): void {
				if (detached) return;
				detached = true;
			},
		};
		writers.add(writer);
		return writer;
	}

	override async writeTextAtomic(path: string, content: string, options?: WriteTextAtomicOptions): Promise<void> {
		this.pausedRewrites++;
		this.rewriteStarted.resolve();
		await this.allowRewrite.promise;
		if (options?.commitGuard && !options.commitGuard()) {
			this.guardRejections++;
			return;
		}
		for (const writer of this.#writers) writer.detach();
		this.writeTextSync(path, content);
	}
}

class CloseGatedRewriteStorage extends MemorySessionStorage {
	readonly closeStarted = Promise.withResolvers<void>();
	readonly allowClose = Promise.withResolvers<void>();
	readonly writeStarted = Promise.withResolvers<void>();
	readonly allowWrite = Promise.withResolvers<void>();
	readonly detachedLines: string[] = [];
	writerOpens = 0;
	guardRejections = 0;
	readonly #detachables = new Set<DetachableWriter>();

	override openWriter(
		path: string,
		options?: { flags?: "a" | "w"; onError?: (err: Error) => void },
	): SessionStorageWriter {
		this.writerOpens++;
		const inner = super.openWriter(path, options);
		const closeStarted = this.closeStarted;
		const allowClose = this.allowClose;
		const detachedLines = this.detachedLines;
		const detachables = this.#detachables;
		let detached = false;
		const writer: DetachableWriter = {
			async append(line: string): Promise<void> {
				if (detached) {
					detachedLines.push(line);
					return;
				}
				await inner.append(line);
			},
			async flush(): Promise<void> {
				await inner.flush();
			},
			isOpen(): boolean {
				return inner.isOpen();
			},
			async close(): Promise<void> {
				closeStarted.resolve();
				await allowClose.promise;
				detachables.delete(writer);
				await inner.close();
			},
			getError(): Error | undefined {
				return inner.getError();
			},
			detach(): void {
				detached = true;
			},
		};
		detachables.add(writer);
		return writer;
	}

	override async writeTextAtomic(path: string, content: string, options?: WriteTextAtomicOptions): Promise<void> {
		this.writeStarted.resolve();
		await this.allowWrite.promise;
		if (options?.commitGuard && !options.commitGuard()) {
			this.guardRejections++;
			return;
		}
		// Emulate the Windows post-EPERM fallback: writers opened against the
		// pre-replacement target end up attached to the moved-aside file after
		// this call returns, so their future appends are detached from `path`.
		for (const w of this.#detachables) w.detach();
		this.writeTextSync(path, content);
	}
}

describe("SessionManager atomic rewrite race", () => {
	it("keeps post-compaction appends on the current JSONL path", async () => {
		const storage = new DetachingRewriteStorage();
		const sessionManager = SessionManager.create("/cwd", "/sessions", storage);
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected built-in anthropic model");

		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "seed response" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		});
		await sessionManager.flush();
		sessionManager.appendMessage({ role: "user", content: "before compaction", timestamp: Date.now() });
		await sessionManager.flush();

		const firstKeptEntryId = sessionManager.getBranch()[0]?.id;
		if (!firstKeptEntryId) throw new Error("Expected seeded branch entry");
		sessionManager.appendCompaction("older summary", "older", firstKeptEntryId, 100);
		await sessionManager.flush();
		sessionManager.appendCompaction("newer summary", "newer", firstKeptEntryId, 80);
		// Kick off a full-file rewrite that parks inside the fake storage until released.
		const rewritePublished = sessionManager.rewriteEntries();
		await storage.rewriteStarted.promise;

		sessionManager.appendMessage({ role: "user", content: "during rewrite prompt", timestamp: Date.now() });
		sessionManager.appendCustomMessageEntry("during_rewrite_custom", "during rewrite custom", false);
		sessionManager.appendCustomEntry("session_exit", { reason: "dispose", kind: "normal" });
		const titlePersisted = sessionManager.setSessionName("Post rewrite title", "user", "test");

		storage.allowRewrite.resolve();
		await rewritePublished;
		await titlePersisted;
		await sessionManager.flush();
		sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: "toolu_after_rewrite",
			toolName: "bash",
			content: [{ type: "text", text: "after rewrite tool" }],
			isError: false,
			timestamp: Date.now(),
		});
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "after rewrite assistant" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		});
		await sessionManager.close();

		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");
		const content = await storage.readText(sessionFile);
		const [titleSlot] = content.split("\n");
		expect(JSON.parse(titleSlot ?? "{}")).toMatchObject({
			type: "title",
			title: "Post rewrite title",
			source: "user",
		});
		expect(content).toContain("newer summary");
		expect(content).toContain("during rewrite prompt");
		expect(content).toContain("during rewrite custom");
		expect(content).toContain('"customType":"session_exit"');
		expect(content).toContain('"type":"title_change"');
		expect(content).toContain("after rewrite tool");
		expect(content).toContain("after rewrite assistant");
		expect(storage.detachedLines).toEqual([]);

		const reloaded = await SessionManager.open(sessionFile, "/sessions", storage, {
			initialCwd: "/cwd",
			suppressBreadcrumb: true,
		});
		const branch = reloaded.getBranch();
		expect(branch.some(entry => entry.type === "compaction" && entry.summary === "newer summary")).toBe(true);
		expect(
			branch.some(
				entry =>
					entry.type === "message" &&
					entry.message.role === "user" &&
					entry.message.content === "during rewrite prompt",
			),
		).toBe(true);
		expect(
			branch.some(
				entry =>
					entry.type === "message" &&
					entry.message.role === "assistant" &&
					entry.message.content.some(part => part.type === "text" && part.text === "after rewrite assistant"),
			),
		).toBe(true);
		expect(reloaded.getSessionName()).toBe("Post rewrite title");
	});

	it("flushSync during an in-flight atomic rewrite durably publishes the exit record", async () => {
		const storage = new DetachingRewriteStorage();
		const sessionManager = SessionManager.create("/cwd", "/sessions", storage);
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected built-in anthropic model");

		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "seed response" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		});
		await sessionManager.flush();
		sessionManager.appendMessage({ role: "user", content: "before compaction", timestamp: Date.now() });
		await sessionManager.flush();

		const firstKeptEntryId = sessionManager.getBranch()[0]?.id;
		if (!firstKeptEntryId) throw new Error("Expected seeded branch entry");
		sessionManager.appendCompaction("older summary", "older", firstKeptEntryId, 100);
		await sessionManager.flush();
		sessionManager.appendCompaction("newer summary", "newer", firstKeptEntryId, 80);
		// Kick off a full-file rewrite that parks inside the fake storage until we
		// release it.
		const rewritePublished = sessionManager.rewriteEntries();
		await storage.rewriteStarted.promise;

		// Simulate a Ctrl+C teardown: append a session_exit custom entry (fenced
		// because the atomic rewrite is active) and flushSync it.
		sessionManager.appendCustomEntry("session_exit", { reason: "sigterm", kind: "signal" });
		sessionManager.flushSync();

		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");
		const afterFlush = await storage.readText(sessionFile);
		expect(afterFlush).toContain('"customType":"session_exit"');
		expect(afterFlush).toContain("newer summary");

		// Release the in-flight atomic rewrite. Its commitGuard MUST reject the
		// stale body serialized before flushSync bumped the disk epoch; otherwise
		// the async publish would overwrite the durable exit record.
		storage.allowRewrite.resolve();
		await rewritePublished;

		const afterRelease = await storage.readText(sessionFile);
		expect(afterRelease).toContain('"customType":"session_exit"');
		expect(afterRelease).toContain("newer summary");
		expect(storage.guardRejections).toBeGreaterThanOrEqual(1);
		expect(storage.detachedLines).toEqual([]);
	});
});

describe("SessionManager atomic rewrite fence spans writer.close()", () => {
	it("blocks a fresh writer from opening while an in-flight rewrite awaits writer.close()", async () => {
		const storage = new CloseGatedRewriteStorage();
		const sessionManager = SessionManager.create("/cwd", "/sessions", storage);
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected built-in anthropic model");

		// Seed an assistant message so the session materializes on disk without
		// opening a persistent writer (cold-path #rewriteSynchronously).
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "seed response" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		});
		await sessionManager.flush();
		// Second append takes the hot path and opens a persistent writer that
		// the atomic rewrite task must close before publishing the replacement.
		sessionManager.appendMessage({ role: "user", content: "before rewrite", timestamp: Date.now() });
		await sessionManager.flush();
		const opensBeforeRewrite = storage.writerOpens;
		expect(opensBeforeRewrite).toBeGreaterThan(0);

		// Schedule an atomic rewrite; the task opens by closing the current
		// writer, which parks on the fake's close gate. The fence must be active
		// throughout the entire close-yield window so no fresh writer opens.
		const rewrite = sessionManager.rewriteEntries();
		await storage.closeStarted.promise;

		sessionManager.appendMessage({ role: "user", content: "during close", timestamp: Date.now() });
		sessionManager.appendCustomEntry("during_close_custom", { reason: "guard" });
		// First fenced append supersedes the in-flight atomic with a synchronous
		// full-body rewrite (software-crash durable before return). That bumps
		// `#diskEpoch`, so a second append may open a hot-path writer against the
		// already-published body; the abandoned atomic's commitGuard must still
		// refuse to clobber it, and nothing may land on a detached handle.
		const sessionFileMid = sessionManager.getSessionFile();
		if (!sessionFileMid) throw new Error("Expected session file");
		const midContent = await storage.readText(sessionFileMid);
		expect(midContent).toContain("during close");
		expect(midContent).toContain('"customType":"during_close_custom"');

		storage.allowClose.resolve();
		storage.allowWrite.resolve();
		await rewrite;
		await sessionManager.flush();

		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");
		const content = await storage.readText(sessionFile);
		expect(content).toContain("during close");
		expect(content).toContain('"customType":"during_close_custom"');
		// Superseding rewrite may finish before the paused atomic reaches its
		// commitGuard; either way the fenced entries must remain and no append
		// may land on a detached handle.
		expect(storage.detachedLines).toEqual([]);
	});
});

class TitleFallbackPausingStorage extends MemorySessionStorage {
	readonly writeStarted = Promise.withResolvers<void>();
	readonly allowWrite = Promise.withResolvers<void>();
	writeTextAtomicCalls = 0;
	failNextUpdateTitle = false;

	override async updateSessionTitle(path: string, update: SessionTitleUpdate): Promise<void> {
		if (this.failNextUpdateTitle) {
			this.failNextUpdateTitle = false;
			throw new Error("updateSessionTitle forced failure");
		}
		return super.updateSessionTitle(path, update);
	}

	override async writeTextAtomic(path: string, content: string, options?: WriteTextAtomicOptions): Promise<void> {
		this.writeTextAtomicCalls += 1;
		this.writeStarted.resolve();
		await this.allowWrite.promise;
		if (options?.commitGuard && !options.commitGuard()) return;
		this.writeTextSync(path, content);
	}
}

describe("SessionManager title-change fallback fenced-append durability", () => {
	it("loops on the dirty flag so fenced appends during the fallback rewrite persist", async () => {
		const storage = new TitleFallbackPausingStorage();
		const sessionManager = SessionManager.create("/cwd", "/sessions", storage);
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected built-in anthropic model");

		// Materialize the session on disk with a title slot present so a later
		// setSessionName takes the append-then-updateSessionTitle try branch
		// instead of the up-front #rewriteAtomically fallback.
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "seed response" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		});
		await sessionManager.flush();
		await sessionManager.setSessionName("initial title", "user", "seed");
		await sessionManager.flush();
		expect(storage.writeTextAtomicCalls).toBe(0);

		// Force the try branch to fail so the catch runs the atomic-rewrite loop.
		storage.failNextUpdateTitle = true;
		const rename = sessionManager.setSessionName("second title", "user", "test");
		await storage.writeStarted.promise;

		// Fenced appends during the paused fallback rewrite supersede the atomic
		// with a synchronous full-body rewrite, so they are on disk before the
		// paused publish resumes. The abandoned atomic's body must not clobber
		// them when released.
		sessionManager.appendMessage({
			role: "user",
			content: "during title fallback",
			timestamp: Date.now(),
		});
		sessionManager.appendCustomEntry("during_title_fallback_custom", { reason: "test" });

		const sessionFileMid = sessionManager.getSessionFile();
		if (!sessionFileMid) throw new Error("Expected session file");
		const midContent = await storage.readText(sessionFileMid);
		expect(midContent).toContain("during title fallback");
		expect(midContent).toContain('"customType":"during_title_fallback_custom"');

		storage.allowWrite.resolve();
		await rename;
		await sessionManager.flush();

		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");
		const content = await storage.readText(sessionFile);
		expect(content).toContain('"title":"second title"');
		expect(content).toContain("during title fallback");
		expect(content).toContain('"customType":"during_title_fallback_custom"');
		// At least the failed title path's atomic fallback ran once; fenced
		// appends may have superseded it via writeTextSync without a second
		// atomic pass.
		expect(storage.writeTextAtomicCalls).toBeGreaterThanOrEqual(1);
	});
});

describe("SessionManager fence relaxes when flushSync supersedes the atomic rewrite", () => {
	it("routes post-flushSync appends onto the hot path so they land on disk before close()", async () => {
		const storage = new DetachingRewriteStorage();
		const sessionManager = SessionManager.create("/cwd", "/sessions", storage);
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected built-in anthropic model");

		// Materialize a session on disk so subsequent rewrites are meaningful.
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "seed response" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		});
		await sessionManager.flush();
		sessionManager.appendMessage({ role: "user", content: "before rewrite", timestamp: Date.now() });
		await sessionManager.flush();

		// Schedule an atomic rewrite that parks inside writeTextAtomic.
		const rewrite = sessionManager.rewriteEntries();
		await storage.rewriteStarted.promise;

		// (1) Append X1 while the fence epoch is still current: fenced into memory
		// and captured by flushSync's #fileBody() below.
		sessionManager.appendCustomEntry("during_active_atomic", { data: "X1" });

		// (2) flushSync supersedes the pending atomic (bumps #diskEpoch) and
		// publishes a synchronous body containing X1.
		sessionManager.flushSync();

		// (3) Post-flushSync append MUST take the hot path: pre-fix, the fence
		// stayed active and this entry was only marked dirty, then dropped when
		// the pending atomic returned false and close() published nothing.
		sessionManager.appendMessage({
			role: "user",
			content: "post_flush_sync_prompt",
			timestamp: Date.now(),
		});
		sessionManager.appendCustomEntry("post_flush_sync_custom", { data: "X2" });

		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");
		const midFlight = await storage.readText(sessionFile);
		expect(midFlight).toContain('"customType":"during_active_atomic"');
		expect(midFlight).toContain("post_flush_sync_prompt");
		expect(midFlight).toContain('"customType":"post_flush_sync_custom"');

		// Release the paused atomic rewrite. Its commitGuard MUST reject — a
		// stale publish now would clobber the hot-path appends written above.
		storage.allowRewrite.resolve();
		await rewrite;
		await sessionManager.close();

		const afterClose = await storage.readText(sessionFile);
		expect(afterClose).toContain('"customType":"during_active_atomic"');
		expect(afterClose).toContain("post_flush_sync_prompt");
		expect(afterClose).toContain('"customType":"post_flush_sync_custom"');
		expect(storage.guardRejections).toBeGreaterThanOrEqual(1);
		expect(storage.detachedLines).toEqual([]);
	});
});

interface PauseHandle {
	started: PromiseWithResolvers<void>;
	allow: PromiseWithResolvers<void>;
}

class SequencedRewriteStorage extends MemorySessionStorage {
	readonly detachedLines: string[] = [];
	readonly pauses: PauseHandle[] = [];
	guardRejections = 0;
	writerOpens = 0;
	pauseCount = 0;
	#calls = 0;
	readonly #writers = new Set<DetachableWriter>();

	override openWriter(
		path: string,
		options?: { flags?: "a" | "w"; onError?: (err: Error) => void },
	): SessionStorageWriter {
		this.writerOpens++;
		const inner = super.openWriter(path, options);
		const writers = this.#writers;
		const detachedLines = this.detachedLines;
		let detached = false;
		const writer: DetachableWriter = {
			async append(line: string): Promise<void> {
				if (detached) {
					detachedLines.push(line);
					return;
				}
				await inner.append(line);
			},
			async flush(): Promise<void> {
				await inner.flush();
			},
			isOpen(): boolean {
				return inner.isOpen();
			},
			async close(): Promise<void> {
				writers.delete(writer);
				await inner.close();
			},
			getError(): Error | undefined {
				return inner.getError();
			},
			detach(): void {
				detached = true;
			},
		};
		writers.add(writer);
		return writer;
	}

	override async writeTextAtomic(path: string, content: string, options?: WriteTextAtomicOptions): Promise<void> {
		const index = this.#calls++;
		if (index < this.pauseCount) {
			const pause: PauseHandle = {
				started: Promise.withResolvers<void>(),
				allow: Promise.withResolvers<void>(),
			};
			this.pauses.push(pause);
			pause.started.resolve();
			await pause.allow.promise;
		}
		if (options?.commitGuard && !options.commitGuard()) {
			this.guardRejections++;
			return;
		}
		for (const w of this.#writers) w.detach();
		this.writeTextSync(path, content);
	}
}

describe("SessionManager fence handoff across superseded rewrites", () => {
	it("preserves the newer fence when a stale rewrite unwinds after flushSync", async () => {
		const storage = new SequencedRewriteStorage();
		storage.pauseCount = 2;
		const sessionManager = SessionManager.create("/cwd", "/sessions", storage);
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected built-in anthropic model");

		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "seed response" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		});
		await sessionManager.flush();
		sessionManager.appendMessage({ role: "user", content: "before rewrite", timestamp: Date.now() });
		await sessionManager.flush();
		expect(storage.writerOpens).toBeGreaterThan(0);

		// Stale rewrite parks at pauses[0]. Fence epoch = 0.
		const stale = sessionManager.rewriteEntries();
		while (storage.pauses.length < 1) await Promise.resolve();
		await storage.pauses[0].started.promise;

		// A fenced append flips fileIsCurrent so flushSync actually publishes,
		// bumping the epoch to 1 with the fenced entry captured in the body.
		sessionManager.appendCustomEntry("during_stale", { data: "X1" });
		sessionManager.flushSync();

		// Newer rewrite scheduled at epoch=1. Parks at pauses[1]. Fence epoch = 1.
		const newer = sessionManager.rewriteEntries();
		while (storage.pauses.length < 2) await Promise.resolve();
		await storage.pauses[1].started.promise;

		const opensBeforeUnwind = storage.writerOpens;

		// Release the stale rewrite. Its `finally` MUST NOT clear the newer
		// fence — pre-fix an unconditional reset stranded the newer rewrite's
		// epoch bookkeeping so subsequent appends took the hot path and were
		// then detached by the newer publish.
		storage.pauses[0].allow.resolve();
		for (let i = 0; i < 20; i++) await Promise.resolve();

		// Sync append during the newer rewrite: MUST still be fenced.
		sessionManager.appendCustomEntry("during_newer", { data: "X2" });
		expect(storage.writerOpens).toBe(opensBeforeUnwind);

		// Release the newer rewrite. Its dirty-loop second iteration is not
		// paused (pauseCount=2) and captures X2 into the published body.
		storage.pauses[1].allow.resolve();

		await stale;
		await newer;
		await sessionManager.close();

		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");
		const content = await storage.readText(sessionFile);
		expect(content).toContain('"customType":"during_stale"');
		expect(content).toContain('"customType":"during_newer"');
		expect(storage.guardRejections).toBeGreaterThanOrEqual(1);
		expect(storage.detachedLines).toEqual([]);
	});
});

interface AtomicFailureHandle {
	started: Promise<void>;
	release: () => void;
}

class GatedAtomicFailureStorage extends MemorySessionStorage {
	#nextFailure:
		| {
				error: Error;
				started: ReturnType<typeof Promise.withResolvers<void>>;
				release: ReturnType<typeof Promise.withResolvers<void>>;
		  }
		| undefined;

	failNextAtomicWrite(error: Error): AtomicFailureHandle {
		if (this.#nextFailure) throw new Error("Atomic failure already armed");
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		this.#nextFailure = { error, started, release };
		return { started: started.promise, release: release.resolve };
	}

	override async writeTextAtomic(path: string, content: string, options?: WriteTextAtomicOptions): Promise<void> {
		const failure = this.#nextFailure;
		if (!failure) {
			await super.writeTextAtomic(path, content, options);
			return;
		}
		this.#nextFailure = undefined;
		failure.started.resolve();
		await failure.release.promise;
		throw failure.error;
	}
}

class ScriptedAtomicFailureStorage extends MemorySessionStorage {
	readonly behaviors: Array<{ commit: boolean; error: Error }> = [];

	override async writeTextAtomic(path: string, content: string, options?: WriteTextAtomicOptions): Promise<void> {
		const behavior = this.behaviors.shift();
		if (!behavior) {
			await super.writeTextAtomic(path, content, options);
			return;
		}
		if (behavior.commit) await super.writeTextAtomic(path, content, options);
		throw behavior.error;
	}
}

describe("SessionManager atomic entry batches", () => {
	it("restores the exact active branch when an atomic batch publish fails", async () => {
		const storage = new GatedAtomicFailureStorage();
		const manager = SessionManager.create("/cwd", "/sessions", storage);
		const rootId = manager.appendCustomEntry("root");
		manager.appendCustomEntry("abandoned-tail");
		await manager.ensureOnDisk();
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");
		manager.branch(rootId);
		const before = await storage.readText(sessionFile);
		const failure = storage.failNextAtomicWrite(new Error("batch publish failed"));
		const commit = manager.appendEntriesAtomically(() => manager.appendCustomEntry("staged-terminal"));
		await failure.started;
		failure.release();

		await expect(commit).rejects.toThrow("batch publish failed");
		expect(manager.getBranch().map(entry => entry.id)).toEqual([rootId]);
		expect(
			manager.getEntries().some(entry => entry.type === "custom" && entry.customType === "staged-terminal"),
		).toBe(false);
		expect(await storage.readText(sessionFile)).toBe(before);

		await manager.appendEntriesAtomically(() => manager.appendCustomEntry("committed-terminal"));
		expect(manager.getBranch().at(-1)).toMatchObject({ type: "custom", customType: "committed-terminal" });
		await manager.close();
	});

	it("reparents and durably preserves a concurrent append when the staged batch rolls back", async () => {
		const storage = new GatedAtomicFailureStorage();
		const manager = SessionManager.create("/cwd", "/sessions", storage);
		const rootId = manager.appendCustomEntry("root");
		await manager.ensureOnDisk();
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");
		const notifiedIds: string[] = [];
		manager.onEntryAppended = entry => notifiedIds.push(entry.id);
		const failure = storage.failNextAtomicWrite(new Error("batch publish failed"));
		let stagedId = "";
		const commit = manager.appendEntriesAtomically(() => {
			stagedId = manager.appendCustomEntry("staged-terminal");
		});
		await failure.started;
		const concurrentId = manager.appendCustomEntry("concurrent-survivor");
		failure.release();

		await expect(commit).rejects.toThrow("batch publish failed");
		expect(manager.getEntries().some(entry => entry.id === stagedId)).toBe(false);
		expect(manager.getEntries().find(entry => entry.id === concurrentId)?.parentId).toBe(rootId);
		expect(manager.getBranch().at(-1)?.id).toBe(concurrentId);
		expect(notifiedIds).toEqual([concurrentId]);

		const content = await storage.readText(sessionFile);
		expect(content).not.toContain('"customType":"staged-terminal"');
		expect(content).toContain('"customType":"concurrent-survivor"');
		await manager.close();
	});

	it("repairs authoritative rollback after commit-then-throw, including a rejecting repair acknowledgement", async () => {
		const storage = new ScriptedAtomicFailureStorage();
		const manager = SessionManager.create("/cwd", "/sessions", storage);
		manager.appendCustomEntry("root");
		await manager.ensureOnDisk();
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");
		const before = await storage.readText(sessionFile);
		storage.behaviors.push(
			{ commit: true, error: new Error("batch committed but acknowledgement failed") },
			{ commit: true, error: new Error("repair committed but acknowledgement failed") },
		);

		await expect(manager.appendEntriesAtomically(() => manager.appendCustomEntry("staged-terminal"))).rejects.toThrow(
			"batch committed but acknowledgement failed",
		);

		expect(await storage.readText(sessionFile)).toBe(before);
		expect(
			manager.getEntries().some(entry => entry.type === "custom" && entry.customType === "staged-terminal"),
		).toBe(false);
		await manager.appendEntriesAtomically(() => manager.appendCustomEntry("retry-terminal"));
		expect(await storage.readText(sessionFile)).toContain('"customType":"retry-terminal"');
		await manager.close();
	});

	it("reserves concurrent atomic batches FIFO before their first await", async () => {
		const storage = new GatedAtomicFailureStorage();
		const manager = SessionManager.create("/cwd", "/sessions", storage);
		manager.appendCustomEntry("root");
		await manager.ensureOnDisk();
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");
		const failure = storage.failNextAtomicWrite(new Error("first batch failed"));
		const first = manager.appendEntriesAtomically(() => manager.appendCustomEntry("batch-a"));
		await failure.started;
		let secondCallbackRan = false;
		const second = manager.appendEntriesAtomically(() => {
			secondCallbackRan = true;
			return manager.appendCustomEntry("batch-b");
		});
		await Promise.resolve();
		expect(secondCallbackRan).toBe(false);
		failure.release();

		await expect(first).rejects.toThrow("first batch failed");
		await second;
		expect(secondCallbackRan).toBe(true);
		const content = await storage.readText(sessionFile);
		expect(content).not.toContain('"customType":"batch-a"');
		expect(content).toContain('"customType":"batch-b"');
		await manager.close();
	});

	it("latches a typed indeterminate error when rollback repair cannot be verified", async () => {
		const storage = new ScriptedAtomicFailureStorage();
		const manager = SessionManager.create("/cwd", "/sessions", storage);
		manager.appendCustomEntry("root");
		await manager.ensureOnDisk();
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");
		storage.behaviors.push(
			{ commit: true, error: new Error("batch committed but acknowledgement failed") },
			{ commit: false, error: new Error("authoritative repair failed before commit") },
		);

		const failure = await manager
			.appendEntriesAtomically(() => manager.appendCustomEntry("possibly-durable-terminal"))
			.catch(error => error);

		expect(failure).toBeInstanceOf(SessionPersistenceIndeterminateError);
		expect((failure as SessionPersistenceIndeterminateError).errors).toHaveLength(3);
		expect(await storage.readText(sessionFile)).toContain('"customType":"possibly-durable-terminal"');
		expect(
			manager
				.getEntries()
				.some(entry => entry.type === "custom" && entry.customType === "possibly-durable-terminal"),
		).toBe(false);
		await expect(manager.flush()).rejects.toBeInstanceOf(SessionPersistenceIndeterminateError);

		await manager.recoverPersistenceFromCurrentState();
		expect(await storage.readText(sessionFile)).not.toContain('"customType":"possibly-durable-terminal"');
		await manager.close();
	});
});

class CommitThenThrowIndexedBackend implements SessionStorageBackend {
	content: string | null = null;
	readonly atomicWriteStarted = Promise.withResolvers<void>();
	readonly releaseAtomicWrite = Promise.withResolvers<void>();
	readonly newerWriteFinished = Promise.withResolvers<void>();
	#writeCount = 0;
	#atomicWriteFailed = false;

	async init(): Promise<void> {}

	async loadIndex(): Promise<[]> {
		return [];
	}

	async readFull(): Promise<string | null> {
		if (this.#atomicWriteFailed) await this.newerWriteFinished.promise;
		return this.content;
	}

	async readSlices(): Promise<[string, string]> {
		return [this.content ?? "", this.content ?? ""];
	}

	async writeFull(_path: string, content: string): Promise<void> {
		this.#writeCount++;
		if (this.#writeCount === 2) {
			this.atomicWriteStarted.resolve();
			await this.releaseAtomicWrite.promise;
			this.content = content;
			this.#atomicWriteFailed = true;
			throw new Error("atomic write committed but acknowledgement failed");
		}
		this.content = content;
		if (this.#writeCount === 3) this.newerWriteFinished.resolve();
	}

	async append(_path: string, line: string): Promise<void> {
		this.content = (this.content ?? "") + line;
	}

	async updateSessionTitle(): Promise<void> {}

	async truncate(): Promise<void> {
		this.content = "";
	}

	async remove(): Promise<void> {
		this.content = null;
	}

	async move(): Promise<void> {}
}

describe("IndexedSessionStorage atomic readback", () => {
	it("preserves a newer synchronous takeover when failed-write readback sees its body", async () => {
		const backend = new CommitThenThrowIndexedBackend();
		const storage = new IndexedSessionStorage(backend);
		const sessionPath = "/sessions/current.jsonl";
		const newerBody = "newer-body-that-is-long";
		await storage.initialize();
		await storage.writeText(sessionPath, "old");

		const failure = storage.writeTextAtomic(sessionPath, "atomic-body").catch(error => error);
		await backend.atomicWriteStarted.promise;
		storage.writeTextSync(sessionPath, newerBody);
		backend.releaseAtomicWrite.resolve();

		expect(await failure).toMatchObject({ message: "atomic write committed but acknowledgement failed" });
		await storage.drain();
		expect(await storage.readText(sessionPath)).toBe(newerBody);
		expect(storage.statSync(sessionPath).size).toBe(Buffer.byteLength(newerBody));
	});
});
