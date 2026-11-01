import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	IndexedSessionStorage,
	type SessionStorageBackend,
} from "@oh-my-pi/pi-coding-agent/session/indexed-session-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	FileSessionStorage,
	MemorySessionStorage,
	SessionWriteConflictError,
	type SessionStorage,
} from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { overlayTitleSlotContent, type SessionTitleUpdate } from "@oh-my-pi/pi-coding-agent/session/session-title-slot";
import { TempDir } from "@oh-my-pi/pi-utils";
import { makeAssistantMessage } from "./helpers";

const dirs: TempDir[] = [];
afterEach(async () => {
	await Promise.all(dirs.splice(0).map(dir => dir.remove()));
});
const kinds = ["file", "memory", "indexed"] as const;
type Kind = (typeof kinds)[number];

// Exercise the real Indexed writer, optimistic index and per-path backend queue.
class Backend implements SessionStorageBackend {
	readonly files = new Map<string, string>();
	appendGate: Promise<void> | undefined;
	readonly appendStarted = Promise.withResolvers<void>();
	fullWrites = 0;
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
		if (this.appendGate) {
			this.appendStarted.resolve();
			await this.appendGate;
		}
		this.files.set(file, (this.files.get(file) ?? "") + text);
	}
	async writeFull(file: string, text: string, _mtime: number, _title?: SessionTitleUpdate, expected?: number | null) {
		const current = this.files.get(file);
		const size = current === undefined ? null : Buffer.byteLength(current);
		if (expected !== undefined && size !== expected) throw new SessionWriteConflictError(file, expected, size);
		this.fullWrites++;
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
const initialContext = [user("original request"), assistant("original answer")];
async function fixture(kind: Kind) {
	const dir = TempDir.createSync("@pi-ordered-title-");
	dirs.push(dir);
	const root = dir.path(),
		sessionDir = path.join(root, "sessions");
	const backend = new Backend();
	let storage: SessionStorage = kind === "memory" ? new MemorySessionStorage() : new FileSessionStorage();
	if (kind === "indexed") {
		const indexed = new IndexedSessionStorage(backend);
		await indexed.initialize();
		storage = indexed;
	}
	const manager = SessionManager.create(root, sessionDir, storage);
	const initialIds = initialContext.map(message => manager.appendMessage(structuredClone(message)));
	await manager.flush();
	return { kind, manager, storage, backend, sessionDir, initialIds };
}
interface Fixture {
	kind: Kind;
	manager: SessionManager;
	storage: SessionStorage;
	backend: Backend;
	sessionDir: string;
	initialIds: string[];
}
type JournalEntry = { type: string; id?: string; parentId?: string | null; title?: string };
async function durableText(f: Fixture, file: string) {
	return f.kind === "indexed" ? f.backend.files.get(file)! : f.storage.readText(file);
}
function journal(text: string) {
	return text
		.split("\n")
		.filter(Boolean)
		.map(line => JSON.parse(line) as JournalEntry);
}
function assertOrdered(text: string, ids: string[]) {
	const entries = journal(text).filter(entry => entry.type !== "session" && entry.id !== undefined);
	expect(entries.map(entry => entry.id)).toEqual(ids);
	const seen = new Set<string>();
	for (const entry of entries) {
		if (entry.parentId) expect(seen.has(entry.parentId)).toBe(true);
		expect(seen.has(entry.id!)).toBe(false);
		seen.add(entry.id!);
	}
}
async function reopen(f: Fixture, file = f.manager.getSessionFile()!) {
	let storage = f.storage;
	if (f.kind === "indexed") {
		const indexed = new IndexedSessionStorage(f.backend);
		await indexed.initialize();
		storage = indexed;
	} else if (f.kind === "file") storage = new FileSessionStorage();
	return SessionManager.open(file, f.sessionDir, storage);
}
async function assertReopened(
	f: Fixture,
	ids: string[],
	title: string,
	context: ReturnType<SessionManager["buildSessionContext"]>["messages"],
) {
	const file = f.manager.getSessionFile()!;
	assertOrdered(await durableText(f, file), ids);
	const reader = await reopen(f);
	try {
		expect(reader.getLeafEntry()?.id).toBe(ids.at(-1));
		expect(reader.getBranch().map(entry => entry.id)).toEqual(ids);
		expect(reader.buildSessionContext().messages).toEqual(context);
		expect(reader.getSessionName()).toBe(title);
	} finally {
		await reader.close();
		reader.releaseRetainedEntries();
	}
}
function assertCurrent(manager: SessionManager) {
	expect(manager.captureState().onDisk).toBe(true);
	expect(manager.captureState().needsRewrite).toBe(false);
}
async function microtasks() {
	// Bounded: the replacement ordered append path never needs to enter the old slot API.
	for (let i = 0; i < 64; i++) await Promise.resolve();
}
function delayOldSlot(storage: SessionStorage, isClosed = () => false) {
	const gate = Promise.withResolvers<void>();
	const original = storage.updateSessionTitle.bind(storage);
	let first = true,
		afterClose = 0;
	const spy = spyOn(storage, "updateSessionTitle").mockImplementation(async (file, update) => {
		if (first) {
			first = false;
			await gate.promise;
		}
		if (isClosed()) afterClose++;
		await original(file, update);
	});
	return { spy, release: () => gate.resolve(), afterClose: () => afterClose };
}

for (const kind of kinds)
	describe(`${kind} ordered title journal`, () => {
		for (const queuedFlush of [false, true])
			it(`reopens the complete following turn with earlier queued flush=${queuedFlush}`, async () => {
				const f = await fixture(kind);
				const { manager, storage } = f;
				const gate = Promise.withResolvers<void>(),
					entered = Promise.withResolvers<void>();
				const drain = storage.drain.bind(storage);
				let first = true;
				const paused = spyOn(storage, "drain").mockImplementation(async () => {
					if (queuedFlush && first) {
						first = false;
						entered.resolve();
						await gate.promise;
					}
					await drain();
				});
				const earlier = queuedFlush ? manager.flush() : Promise.resolve();
				if (queuedFlush) await entered.promise;
				const naming = manager.setSessionName("ordered auto title", "auto");
				const nextUser = user("follow-up request"),
					nextAssistant = assistant("follow-up answer");
				manager.appendMessage(nextUser);
				const leaf = manager.appendMessage(nextAssistant);
				const ids = manager.getEntries().map(entry => entry.id);
				try {
					gate.resolve();
					await earlier;
					await naming;
					await manager.flush();
					assertCurrent(manager);
					manager.seal();
					await manager.close();
					await assertReopened(f, ids, "ordered auto title", [...initialContext, nextUser, nextAssistant]);
					expect(ids.at(-1)).toBe(leaf);
				} finally {
					gate.resolve();
					await earlier.catch(() => {});
					await naming.catch(() => {});
					paused.mockRestore();
					await manager.close().catch(() => {});
					manager.releaseRetainedEntries();
				}
			});

		it("overlaps names without rewriting an otherwise current journal", async () => {
			const f = await fixture(kind);
			const { manager, storage } = f;
			await manager.setSessionName("initial", "user");
			await manager.flush();
			const rewrites = [
				spyOn(storage, "writeLinesSync"),
				spyOn(storage, "writeLinesAtomic"),
				spyOn(storage, "writeTextSync"),
				spyOn(storage, "writeTextAtomic"),
			];
			const slot = delayOldSlot(storage);
			const first = manager.setSessionName("first", "auto");
			await microtasks();
			const latest = manager.setSessionName("latest", "user");
			const nextUser = user("after overlapping names"),
				nextAssistant = assistant("still on the active branch");
			manager.appendMessage(nextUser);
			manager.appendMessage(nextAssistant);
			const ids = manager.getEntries().map(entry => entry.id);
			try {
				slot.release();
				await first;
				await latest;
				await manager.flush();
				manager.seal();
				await manager.close();
				for (const rewrite of rewrites) expect(rewrite).not.toHaveBeenCalled();
				await assertReopened(f, ids, "latest", [...initialContext, nextUser, nextAssistant]);
			} finally {
				slot.release();
				await first.catch(() => {});
				await latest.catch(() => {});
				for (const rewrite of rewrites) rewrite.mockRestore();
				slot.spy.mockRestore();
				await manager.close().catch(() => {});
				manager.releaseRetainedEntries();
			}
		});
	});

for (const phase of ["before-schedule", "during-append"] as const)
	it(`Indexed preserves an edited entry ${phase} of a title append`, async () => {
		const f = await fixture("indexed");
		const { manager, backend } = f;
		const gate = Promise.withResolvers<void>();
		backend.appendGate = gate.promise;
		const naming = manager.setSessionName("edited conversation", "user");
		if (phase === "during-append") await backend.appendStarted.promise;
		const entry = manager.getEntry(f.initialIds[0]);
		if (entry?.type !== "message" || entry.message.role !== "user") throw new Error("Expected original user entry");
		const edited = { ...entry.message, content: "edited original request" };
		entry.message = edited;
		// Upstream announces in-place edits through its existing awaited rewrite API.
		const changing = manager.rewriteEntries();
		const nextUser = user("after edit"),
			nextAssistant = assistant("edit survived");
		manager.appendMessage(nextUser);
		manager.appendMessage(nextAssistant);
		const ids = manager.getEntries().map(entry => entry.id);
		try {
			gate.resolve();
			await naming;
			await changing;
			await manager.flush();
			assertCurrent(manager);
			manager.seal();
			await manager.close();
			await assertReopened(f, ids, "edited conversation", [edited, initialContext[1], nextUser, nextAssistant]);
		} finally {
			gate.resolve();
			await naming.catch(() => {});
			await changing.catch(() => {});
			await manager.close().catch(() => {});
			manager.releaseRetainedEntries();
		}
	});

for (const phase of ["before-schedule", "during-append"] as const)
	it(`Indexed keeps a persistent clone meaningful ${phase} of a title append`, async () => {
		const f = await fixture("indexed");
		const { manager, backend } = f;
		const gate = Promise.withResolvers<void>();
		backend.appendGate = gate.promise;
		const naming = manager.setSessionName("cloned conversation", "user");
		if (phase === "during-append") await backend.appendStarted.promise;
		const clone = manager.cloneCurrentSession({ persist: true });
		clone.restoreState(clone.captureState());
		const cloneIds = clone.getEntries().map(entry => entry.id);
		const nextUser = user("source after clone"),
			nextAssistant = assistant("durable source answer");
		manager.appendMessage(nextUser);
		manager.appendMessage(nextAssistant);
		const ids = manager.getEntries().map(entry => entry.id);
		try {
			gate.resolve();
			await naming;
			await manager.flush();
			assertCurrent(manager);
			clone.seal();
			await clone.close();
			assertCurrent(clone);
			manager.seal();
			await manager.close();
			await assertReopened(f, ids, "cloned conversation", [...initialContext, nextUser, nextAssistant]);
			const cloneFile = clone.getSessionFile()!;
			const savedIds = journal(await durableText(f, cloneFile))
				.filter(entry => entry.type !== "session" && entry.id)
				.map(entry => entry.id);
			expect(new Set(savedIds).size).toBe(savedIds.length);
			const reader = await reopen(f, cloneFile);
			try {
				for (const id of cloneIds) expect(reader.getEntry(id)).toEqual(clone.getEntry(id));
				expect(reader.buildSessionContext().messages.slice(0, 2)).toEqual(initialContext);
				expect(reader.getSessionName()).toBe("cloned conversation");
			} finally {
				await reader.close();
				reader.releaseRetainedEntries();
			}
			clone.releaseRetainedEntries();
			expect(clone.getEntries()).toEqual([]);
		} finally {
			gate.resolve();
			await naming.catch(() => {});
			await clone.close().catch(() => {});
			clone.releaseRetainedEntries();
			await manager.close().catch(() => {});
			manager.releaseRetainedEntries();
		}
	});

it("Indexed flushSync during a real in-flight title append does not self-conflict", async () => {
	const f = await fixture("indexed");
	const { manager, backend } = f;
	const gate = Promise.withResolvers<void>();
	backend.appendGate = gate.promise;
	const naming = manager.setSessionName("interrupt-safe title", "auto");
	await backend.appendStarted.promise;
	const nextUser = user("turn during append"),
		nextAssistant = assistant("survives interrupt flush");
	try {
		expect(() => manager.flushSync()).not.toThrow();
		manager.appendMessage(nextUser);
		manager.appendMessage(nextAssistant);
		const ids = manager.getEntries().map(entry => entry.id);
		gate.resolve();
		await naming;
		await manager.flush();
		assertCurrent(manager);
		manager.seal();
		await manager.close();
		await assertReopened(f, ids, "interrupt-safe title", [...initialContext, nextUser, nextAssistant]);
	} finally {
		gate.resolve();
		await naming.catch(() => {});
		await manager.close().catch(() => {});
		manager.releaseRetainedEntries();
	}
});

for (const kind of ["memory", "file"] as const)
	it(`${kind} never publishes a delayed live title slot after synchronous rewrite and sealed close`, async () => {
		const f = await fixture(kind);
		const { manager, storage } = f;
		let closed = false;
		const slot = delayOldSlot(storage, () => closed);
		const first = manager.setSessionName("first", "auto");
		await microtasks();
		const latest = manager.setSessionName("latest", "user");
		// Force a real synchronous body rewrite without depending on a branch-only edit API.
		const snapshot = manager.captureState();
		manager.restoreState({ ...snapshot, onDisk: false, needsRewrite: true, tailRewritePending: true });
		const ids = manager.getEntries().map(entry => entry.id);
		let closing: Promise<void> | undefined;
		try {
			manager.flushSync();
			await storage.drain();
			manager.seal();
			closing = manager.close().then(() => {
				closed = true;
			});
			await microtasks();
			// Always release, even when the new mechanism never calls updateSessionTitle.
			slot.release();
			await closing;
			await first;
			await latest;
			expect(slot.afterClose()).toBe(0);
			expect(slot.spy).not.toHaveBeenCalled();
			const text = await durableText(f, manager.getSessionFile()!);
			expect(journal(text)[0].title).toBe("latest");
			expect(journal(text).find(entry => entry.type === "session")?.title).toBe("latest");
			await assertReopened(f, ids, "latest", initialContext);
		} finally {
			slot.release();
			await closing?.catch(() => {});
			await first.catch(() => {});
			await latest.catch(() => {});
			slot.spy.mockRestore();
			await manager.close().catch(() => {});
			manager.releaseRetainedEntries();
		}
	});

for (const finish of ["rewrite", "recover", "sealed-close"] as const)
	it(`Indexed clears restored tail rewrite debt after confirmed ${finish}`, async () => {
		const f = await fixture("indexed");
		const { manager, backend } = f;
		await manager.setSessionName("restored title", "user");
		await manager.flush();
		const snapshot = manager.captureState();
		manager.restoreState({
			...snapshot,
			header: { ...snapshot.header, taskPromptCacheKey: "restored-header" },
			onDisk: false,
			needsRewrite: true,
			tailRewritePending: true,
		});
		const ids = manager.getEntries().map(entry => entry.id),
			writes = backend.fullWrites;
		try {
			expect(manager.captureState().tailRewritePending).toBe(true);
			if (finish === "rewrite") await manager.rewriteEntries();
			else if (finish === "recover") await manager.recoverPersistenceFromCurrentState();
			else manager.seal();
			if (finish !== "sealed-close") {
				expect(backend.fullWrites).toBeGreaterThan(writes);
				expect(manager.captureState().tailRewritePending).toBe(false);
				assertCurrent(manager);
				manager.seal();
			}
			await manager.close();
			expect(backend.fullWrites).toBeGreaterThan(writes);
			expect(manager.captureState().tailRewritePending).toBe(false);
			assertCurrent(manager);
			manager.releaseRetainedEntries();
			expect(manager.getEntries()).toEqual([]);
			expect(manager.getBranch()).toEqual([]);
			expect(manager.getEntry(f.initialIds[0])).toBeUndefined();
			expect(manager.getLeafEntry()).toBeUndefined();
			await assertReopened(f, ids, "restored title", initialContext);
			const reader = await reopen(f);
			try {
				expect(reader.getHeader()?.taskPromptCacheKey).toBe("restored-header");
			} finally {
				await reader.close();
				reader.releaseRetainedEntries();
			}
		} finally {
			await manager.close().catch(() => {});
			manager.releaseRetainedEntries();
		}
	});

for (const repair of ["malformed", "migrated"] as const)
	for (const sealed of [false, true])
		it(`Indexed read-only ${repair} close preserves bytes with sealed=${sealed}`, async () => {
			const f = await fixture("indexed");
			const file = f.manager.getSessionFile()!;
			await f.manager.close();
			f.manager.releaseRetainedEntries();
			const original = f.backend.files.get(file)!;
			const text =
				repair === "malformed"
					? `${original}{"type":"message","torn":`
					: original.replace('"version":3', '"version":2');
			f.backend.files.set(file, text);
			const writes = f.backend.fullWrites;
			const reader = await reopen(f);
			try {
				expect(reader.captureState().needsRewrite).toBe(true);
				if (sealed) reader.seal();
				await reader.close();
				expect(f.backend.files.get(file)).toBe(text);
				expect(f.backend.fullWrites).toBe(writes);
				expect(reader.buildSessionContext().messages).toEqual(initialContext);
				reader.releaseRetainedEntries();
				expect(reader.getEntries()).toEqual([]);
				expect(reader.getEntry(f.initialIds[0])).toBeUndefined();
			} finally {
				await reader.close().catch(() => {});
				reader.releaseRetainedEntries();
			}
		});
