import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as path from "node:path";
import {
	IndexedSessionStorage,
	type SessionStorageBackend,
} from "@oh-my-pi/pi-coding-agent/session/indexed-session-storage";
import { closeSessionIndex, lookupSessionTitle } from "@oh-my-pi/pi-coding-agent/session/session-index";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { FileSessionStorage, SessionWriteConflictError } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { overlayTitleSlotContent, type SessionTitleUpdate } from "@oh-my-pi/pi-coding-agent/session/session-title-slot";
import { getConfigRootDir, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { makeAssistantMessage } from "./helpers";

class Backend implements SessionStorageBackend {
	readonly files = new Map<string, string>();
	heldFile: string | undefined;
	appendGate: Promise<void> | undefined;
	appendFailure: Error | undefined;
	readonly started = Promise.withResolvers<void>();
	fullGate: Promise<void> | undefined;
	fullFailure: Error | undefined;
	readonly fullStarted = Promise.withResolvers<void>();
	async init() {}
	async loadIndex() {
		return [...this.files].map(([path, text]) => ({ path, size: Buffer.byteLength(text), mtimeMs: 0 }));
	}
	async readFull(file: string) {
		return this.files.get(file) ?? null;
	}
	async readSlices(file: string, prefix: number, suffix: number): Promise<[string, string]> {
		const bytes = Buffer.from(this.files.get(file) ?? "");
		return [
			bytes.subarray(0, prefix).toString(),
			suffix ? bytes.subarray(Math.max(0, bytes.length - suffix)).toString() : "",
		];
	}
	async append(file: string, text: string) {
		if (file === this.heldFile && this.appendGate) {
			this.started.resolve();
			await this.appendGate;
			if (this.appendFailure) throw this.appendFailure;
		}
		this.files.set(file, (this.files.get(file) ?? "") + text);
	}
	async writeFull(file: string, text: string, _mtime: number, _title?: SessionTitleUpdate, expected?: number | null) {
		if (file === this.heldFile && this.fullGate) {
			this.fullStarted.resolve();
			await this.fullGate;
			if (this.fullFailure) throw this.fullFailure;
		}
		const current = this.files.get(file),
			size = current === undefined ? null : Buffer.byteLength(current);
		if (expected !== undefined && expected !== size) throw new SessionWriteConflictError(file, expected, size);
		this.files.set(file, text);
	}
	async updateSessionTitle(file: string, title: SessionTitleUpdate) {
		this.files.set(file, overlayTitleSlotContent(this.files.get(file)!, title));
	}
	async truncate(file: string) {
		this.files.set(file, "");
	}
	async remove(files: string[]) {
		for (const file of files) this.files.delete(file);
	}
	async move(from: string, to: string) {
		const text = this.files.get(from);
		if (text === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
		this.files.delete(from);
		this.files.set(to, text);
	}
}
function user(content: string) {
	return { role: "user" as const, content, timestamp: Date.now() };
}
function assistant(text: string) {
	return { ...makeAssistantMessage(), content: [{ type: "text" as const, text }] };
}
let dir: TempDir;
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const fallbackAgentDir = path.join(getConfigRootDir(), "agent");
beforeEach(() => {
	dir = TempDir.createSync("@pi-writer-state-");
	setAgentDir(path.join(dir.path(), "agent"));
});
afterEach(async () => {
	closeSessionIndex();
	setAgentDir(originalAgentDir ?? fallbackAgentDir);
	if (!originalAgentDir) delete process.env.PI_CODING_AGENT_DIR;
	await dir.remove();
});
async function fixture() {
	const backend = new Backend(),
		storage = new IndexedSessionStorage(backend);
	await storage.initialize();
	const sessionDir = path.join(dir.path(), "sessions");
	const manager = SessionManager.create(dir.path(), sessionDir, storage);
	const ids = [manager.appendMessage(user("seed request")), manager.appendMessage(assistant("seed answer"))];
	await manager.flush();
	return { backend, storage, sessionDir, manager, ids };
}
async function tick() {
	for (let i = 0; i < 64; i++) await Promise.resolve();
}
function hold(f: Awaited<ReturnType<typeof fixture>>, fail: boolean) {
	const gate = Promise.withResolvers<void>();
	f.backend.heldFile = f.manager.getSessionFile();
	f.backend.appendGate = gate.promise;
	if (fail) f.backend.appendFailure = new Error("obsolete append failed");
	return gate;
}
async function assertReopened(
	f: Awaited<ReturnType<typeof fixture>>,
	file: string,
	ids: string[],
	title?: string,
	titleSource?: "auto" | "user",
) {
	const physical = f.backend.files
		.get(file)!
		.split("\n")
		.filter(Boolean)
		.map(line => JSON.parse(line) as { type: string; id?: string; parentId?: string | null });
	const actual = physical.filter(entry => entry.type !== "session" && entry.id !== undefined);
	expect(new Set(actual.map(entry => entry.id)).size).toBe(actual.length);
	expect(new Set(actual.map(entry => entry.id))).toEqual(new Set(ids));
	const seen = new Set<string>();
	for (const entry of actual) {
		if (entry.parentId) expect(seen.has(entry.parentId)).toBe(true);
		seen.add(entry.id!);
	}
	const storage = new IndexedSessionStorage(f.backend);
	await storage.initialize();
	const reader = await SessionManager.open(file, f.sessionDir, storage);
	try {
		expect(new Set(reader.getEntries().map(entry => entry.id))).toEqual(new Set(ids));
		expect(reader.getSessionName()).toBe(title);
		if (titleSource) expect(reader.captureState().titleSource).toBe(titleSource);
	} finally {
		await reader.close();
		reader.releaseRetainedEntries();
	}
}

describe("deferred writer callbacks belong to their session state", () => {
	for (const kind of ["message", "title"] as const)
		for (const fail of [false, true]) {
			it(`materializes a synchronous branch while an old ${kind} append ${fail ? "fails" : "succeeds"}`, async () => {
				const f = await fixture(),
					oldFile = f.manager.getSessionFile()!,
					gate = hold(f, fail);
				const oldResult =
					kind === "title"
						? f.manager.setSessionName("Old source title", "user").catch(error => error)
						: Promise.resolve(f.manager.appendMessage(user("old source tail")));
				await f.backend.started.promise;
				const branchFile = f.manager.createBranchedSession(f.ids[1])!;
				const existsImmediately = f.storage.existsSync(branchFile);
				gate.resolve();
				await oldResult;
				await tick();
				expect(branchFile).not.toBe(oldFile);
				expect(existsImmediately).toBe(true);
				await f.manager.flush();
				const state = f.manager.captureState();
				expect(state.onDisk).toBe(true);
				expect(state.needsRewrite).toBe(false);
				expect(state.expectedDiskSize).toBe(Buffer.byteLength(f.backend.files.get(branchFile)!));
				expect(f.manager.getEntries().map(entry => entry.id)).toEqual(f.ids);
				await assertReopened(
					f,
					branchFile,
					f.ids,
					kind === "title" ? "Old source title" : undefined,
					kind === "title" ? "user" : undefined,
				);
				await f.manager.close();
			});
			it(`restores a durable snapshot while an obsolete ${kind} append ${fail ? "fails" : "succeeds"}`, async () => {
				const f = await fixture(),
					snapshot = f.manager.captureState();
				await f.manager.newSession();
				f.manager.appendMessage(user("temporary request"));
				f.manager.appendMessage(assistant("temporary reply"));
				await f.manager.flush();
				const gate = hold(f, fail);
				const oldResult =
					kind === "title"
						? f.manager.setSessionName("Temporary title", "user").catch(error => error)
						: Promise.resolve(f.manager.appendMessage(user("temporary pending tail")));
				await f.backend.started.promise;
				f.manager.restoreState(snapshot);
				const restored = f.manager.captureState();
				gate.resolve();
				await oldResult;
				await tick();
				expect(restored.onDisk).toBe(true);
				expect(restored.needsRewrite).toBe(false);
				expect(restored.tailRewritePending).toBe(false);
				expect(f.manager.captureState().expectedDiskSize).toBe(snapshot.expectedDiskSize);
				expect(f.manager.captureState().onDisk).toBe(true);
				expect(f.manager.getSessionName()).toBeUndefined();
				const next = f.manager.appendMessage(user("surviving current append"));
				await f.manager.flush();
				await assertReopened(f, snapshot.sessionFile!, [...f.ids, next]);
				await f.manager.close();
			});
		}
	for (const fail of [false, true])
		it(`does not apply an obsolete atomic rewrite ${fail ? "failure" : "confirmation"} to a restored snapshot`, async () => {
			const f = await fixture(),
				snapshot = f.manager.captureState();
			await f.manager.newSession();
			f.manager.appendMessage(user("temporary"));
			f.manager.appendMessage(assistant("temporary answer"));
			await f.manager.flush();
			const gate = hold(f, false);
			f.manager.appendMessage(user("temporary pending"));
			await f.backend.started.promise;
			const clone = f.manager.cloneCurrentSession({ persist: true });
			const syncPublishes = spyOn(f.storage, "writeTextSync");
			const fullGate = Promise.withResolvers<void>();
			f.backend.fullGate = fullGate.promise;
			if (fail) f.backend.fullFailure = new Error("obsolete full publish failed");
			const flushing = f.manager.flush().then(
				() => undefined,
				error => error,
			);
			gate.resolve();
			await f.backend.fullStarted.promise;
			f.manager.restoreState(snapshot);
			const next = f.manager.appendMessage(user("current during old atomic publish"));
			await f.manager.flush();
			const currentBytes = f.manager.captureState().expectedDiskSize;
			fullGate.resolve();
			await flushing;
			await tick();
			expect(syncPublishes.mock.calls.filter(([file]) => file === snapshot.sessionFile)).toHaveLength(0);
			const restored = f.manager.captureState();
			expect(restored.expectedDiskSize).toBe(currentBytes);
			expect(restored.onDisk).toBe(true);
			expect(restored.needsRewrite).toBe(false);
			await assertReopened(f, snapshot.sessionFile!, [...f.ids, next]);
			f.backend.fullFailure = undefined;
			await clone.close();
			await f.manager.close();
		});
	for (const fail of [false, true])
		it(`does not attach an old writer or release a new claim when an obsolete close ${fail ? "fails" : "succeeds"}`, async () => {
			class Storage extends FileSessionStorage {
				readonly claims = new Set<string>();
				heldFile: string | undefined;
				readonly gate = Promise.withResolvers<void>();
				readonly started = Promise.withResolvers<void>();
				failed = false;
				override claimSession(id: string, file: string) {
					const release = super.claimSession(id, file);
					if (!release) return release;
					this.claims.add(id);
					return () => {
						this.claims.delete(id);
						release();
					};
				}
				override openWriter(file: string, options?: Parameters<FileSessionStorage["openWriter"]>[1]) {
					const writer = super.openWriter(file, options),
						close = writer.close.bind(writer);
					writer.close = async () => {
						if (file === this.heldFile) {
							this.started.resolve();
							await this.gate.promise;
							if (fail && !this.failed) {
								this.failed = true;
								throw new Error("obsolete close failed");
							}
						}
						await close();
					};
					return writer;
				}
			}
			const storage = new Storage(),
				sessionDir = path.join(dir.path(), "sessions"),
				manager = SessionManager.create(dir.path(), sessionDir, storage);
			const ids = [manager.appendMessage(user("retained")), manager.appendMessage(assistant("retained answer"))];
			await manager.flush();
			const snapshot = manager.captureState();
			await manager.newSession();
			manager.appendMessage(user("obsolete"));
			manager.appendMessage(assistant("obsolete answer"));
			await manager.flush();
			storage.heldFile = manager.getSessionFile();
			const closing = manager.close().then(
				() => undefined,
				error => error,
			);
			await storage.started.promise;
			manager.restoreState(snapshot);
			let next: string | undefined;
			if (!fail) {
				next = manager.appendMessage(user("current claim must survive old close"));
				await manager.flush();
			}
			storage.gate.resolve();
			const oldResult = await closing;
			if (fail) {
				expect(oldResult).toBeInstanceOf(Error);
				next = manager.appendMessage(user("current append must not reuse old writer"));
				await manager.flush();
			}
			expect(storage.claims.has(snapshot.sessionId)).toBe(true);
			const reader = await SessionManager.open(snapshot.sessionFile!, sessionDir, new FileSessionStorage());
			try {
				expect(reader.getEntries().map(entry => entry.id)).toEqual([...ids, next!]);
			} finally {
				await reader.close();
				reader.releaseRetainedEntries();
			}
			await manager.close();
			expect(storage.claims.has(snapshot.sessionId)).toBe(false);
		});
	it("records a File title under its original ID after restore and never notifies the replacement", async () => {
		class Storage extends FileSessionStorage {
			gate: Promise<void> | undefined;
			readonly started = Promise.withResolvers<void>();
			override async drain() {
				if (this.gate) {
					this.started.resolve();
					await this.gate;
				}
				await super.drain();
			}
		}
		const storage = new Storage(),
			sessionDir = path.join(dir.path(), "sessions");
		const manager = SessionManager.create(dir.path(), sessionDir, storage);
		manager.appendMessage(user("first"));
		manager.appendMessage(assistant("first reply"));
		await manager.flush();
		const snapshot = manager.captureState();
		await manager.newSession();
		manager.appendMessage(user("second"));
		manager.appendMessage(assistant("second reply"));
		await manager.flush();
		const originalId = manager.getSessionId();
		const gate = Promise.withResolvers<void>();
		storage.gate = gate.promise;
		const notifications: string[] = [];
		manager.onSessionNameChanged(() => notifications.push(manager.getSessionId()));
		const naming = manager.setSessionName("Original session only", "user");
		await storage.started.promise;
		manager.restoreState(snapshot);
		gate.resolve();
		await naming;
		expect(lookupSessionTitle(snapshot.sessionId)).toBeUndefined();
		expect(lookupSessionTitle(originalId)).toBe("Original session only");
		expect(notifications).toEqual([]);
		expect(manager.getSessionName()).toBeUndefined();
		await manager.close();
	});
});

describe("real Indexed persistent clones reconcile on the async disk queue", () => {
	for (const cloneWhen of ["before", "during"] as const)
		for (const publish of ["flush", "flushSync"] as const) {
			it(`accepts a clone ${publish} created ${cloneWhen} an original pending title`, async () => {
				const f = await fixture(),
					gate = hold(f, false);
				let clone = cloneWhen === "before" ? f.manager.cloneCurrentSession({ persist: true }) : undefined;
				const naming = f.manager.setSessionName("Original pending title", "user");
				await f.backend.started.promise;
				clone ??= f.manager.cloneCurrentSession({ persist: true });
				const extra = clone.appendMessage(user("clone request"));
				let syncError: unknown;
				try {
					if (publish === "flushSync") clone.flushSync();
				} catch (error) {
					syncError = error;
				}
				const publishing = clone.flush().then(
					() => undefined,
					error => error,
				);
				await tick();
				gate.resolve();
				await naming;
				const result = await publishing;
				expect(syncError).toBeUndefined();
				expect(result).toBeUndefined();
				await f.manager.flush();
				expect(clone.captureState().onDisk).toBe(true);
				expect(clone.getSessionName()).toBe("Original pending title");
				const ids = [...f.manager.getEntries().map(entry => entry.id)];
				expect(ids).toContain(extra);
				await assertReopened(f, f.manager.getSessionFile()!, ids, "Original pending title", "user");
				await clone.close();
				await f.manager.close();
			});
		}
	for (const source of ["auto", "user"] as const)
		for (const timestamp of ["2020-01-01T00:00:00.000Z", "2000-01-01T00:00:00.000Z"]) {
			it(`folds adopted ${source} title metadata in physical order at ${timestamp}`, async () => {
				const f = await fixture(),
					clock = spyOn(Date.prototype, "toISOString").mockReturnValue("2020-01-01T00:00:00.000Z");
				let clone: SessionManager;
				try {
					await f.manager.setSessionName("Initial title", "auto");
					clone = f.manager.cloneCurrentSession({ persist: true });
					clock.mockReturnValue(timestamp);
					await f.manager.setSessionName("Foreign newest title", source);
				} finally {
					clock.mockRestore();
				}
				const extra = clone.appendMessage(user("clone post-rename request"));
				await clone.flush();
				expect(clone.getSessionName()).toBe("Foreign newest title");
				expect(clone.captureState().titleSource).toBe(source);
				expect(clone.captureState().titleUpdatedAt).toBe(timestamp);
				await f.manager.flush();
				const ids = f.manager.getEntries().map(entry => entry.id);
				expect(ids).toContain(extra);
				await assertReopened(f, clone.getSessionFile()!, ids, "Foreign newest title", source);
				await clone.close();
				await f.manager.close();
			});
		}
	it("preserves a newer local title after adopting a foreign title and reopening", async () => {
		const f = await fixture();
		await f.manager.setSessionName("Initial title", "auto");
		const clone = f.manager.cloneCurrentSession({ persist: true });
		await f.manager.setSessionName("Foreign older title", "auto");
		await clone.setSessionName("Local latest title", "user");
		expect(clone.getSessionName()).toBe("Local latest title");
		expect(clone.captureState().titleSource).toBe("user");
		await f.manager.flush();
		await assertReopened(
			f,
			clone.getSessionFile()!,
			clone.getEntries().map(entry => entry.id),
			"Local latest title",
			"user",
		);
		await clone.close();
		await f.manager.close();
	});
});
