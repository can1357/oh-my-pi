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
class Backend implements SessionStorageBackend {
	readonly files = new Map<string, string>();
	appendGate: Promise<void> | undefined;
	readonly appendStarted = Promise.withResolvers<void>();
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
async function fixture(kind: Kind) {
	const dir = TempDir.createSync("@pi-async-title-debt-");
	dirs.push(dir);
	const root = dir.path(),
		sessionDir = path.join(root, "sessions"),
		workspace = path.join(root, "workspace");
	fs.mkdirSync(workspace);
	const backend = new Backend();
	let storage: SessionStorage = kind === "memory" ? new MemorySessionStorage() : new FileSessionStorage();
	if (kind === "indexed") {
		const indexed = new IndexedSessionStorage(backend);
		await indexed.initialize();
		storage = indexed;
	}
	const manager = SessionManager.create(root, sessionDir, storage);
	manager.appendMessage(makeAssistantMessage());
	await manager.flush();
	return { manager, storage, backend, root, sessionDir, workspace };
}
type SavedRecord = {
	type: string;
	id?: string;
	title?: string;
	cwd?: string;
	taskPromptCacheKey?: string;
	additionalDirectories?: string[];
	message?: { role: string };
};
async function records(storage: SessionStorage, file: string) {
	return (await storage.readText(file))
		.split("\n")
		.filter(Boolean)
		.map(line => JSON.parse(line) as SavedRecord);
}
function pauseTitle(storage: SessionStorage) {
	const entered = Promise.withResolvers<void>(),
		gate = Promise.withResolvers<void>();
	const original = storage.updateSessionTitle.bind(storage);
	let first = true;
	const spy = spyOn(storage, "updateSessionTitle").mockImplementation(async (file, update) => {
		if (first) {
			first = false;
			entered.resolve();
			await gate.promise;
		}
		await original(file, update);
	});
	return { entered: entered.promise, release: () => gate.resolve(), restore: () => spy.mockRestore() };
}
const mutations = ["task-key", "add-workspace", "remove-workspace", "set-workspaces", "second-title"] as const;
type Mutation = (typeof mutations)[number];
function mutate(manager: SessionManager, mutation: Mutation, workspace: string) {
	switch (mutation) {
		case "task-key":
			return manager.setTaskPromptCacheKey("must-survive-seal");
		case "add-workspace":
			return manager.addWorkspaceDirectory(workspace);
		case "remove-workspace":
			return manager.removeWorkspaceDirectory(workspace);
		case "set-workspaces":
			return manager.setAdditionalDirectories([workspace]);
		case "second-title":
			return manager.setSessionName("latest", "user");
	}
}
function assertMutation(saved: SavedRecord[], mutation: Mutation, workspace: string) {
	const header = saved.find(entry => entry.type === "session");
	switch (mutation) {
		case "task-key":
			expect(header?.taskPromptCacheKey).toBe("must-survive-seal");
			break;
		case "add-workspace":
		case "set-workspaces":
			expect(header?.additionalDirectories).toEqual([workspace]);
			break;
		case "remove-workspace":
			expect(header?.additionalDirectories ?? []).toEqual([]);
			break;
		case "second-title":
			expect(saved[0].title).toBe("latest");
			expect(saved.some(entry => entry.type === "title_change" && entry.title === "latest")).toBe(true);
			break;
	}
}
for (const kind of kinds)
	describe(kind, () => {
		it("keeps ordinary appends hot while a title slot update is pending", async () => {
			const { manager, storage } = await fixture(kind);
			const gate = pauseTitle(storage);
			const naming = manager.setSessionName("first", "user");
			await gate.entered;
			const id = manager.appendCustomEntry("during-title", { value: 1 });
			manager.appendMessage({ role: "user", content: "during title", timestamp: Date.now() });
			try {
				gate.release();
				await naming;
				await manager.flush();
				manager.seal();
				await manager.close();
				const saved = await records(storage, manager.getSessionFile()!);
				expect(saved.filter(entry => entry.id === id)).toHaveLength(1);
				expect(saved.some(entry => entry.type === "message" && entry.message?.role === "user")).toBe(true);
				expect(saved[0].title).toBe("first");
			} finally {
				gate.release();
				await naming.catch(() => {});
				await manager.close().catch(() => {});
				gate.restore();
				manager.releaseRetainedEntries();
			}
		});
		for (const mutation of mutations) {
			it(`preserves ${mutation} queued behind an in-flight title update when sealed`, async () => {
				const { manager, storage, workspace } = await fixture(kind);
				if (mutation === "remove-workspace") await manager.addWorkspaceDirectory(workspace);
				const gate = pauseTitle(storage);
				const naming = manager.setSessionName("first", "user");
				await gate.entered;
				const changing = mutate(manager, mutation, workspace);
				try {
					gate.release();
					await naming;
					manager.seal();
					await changing;
					await manager.close();
					assertMutation(await records(storage, manager.getSessionFile()!), mutation, workspace);
				} finally {
					gate.release();
					await naming.catch(() => {});
					await changing.catch(() => {});
					await manager.close().catch(() => {});
					gate.restore();
					manager.releaseRetainedEntries();
				}
			});
		}
		for (const empty of ["missing", "zero-byte"] as const) {
			it(`materializes a ${empty} explicit session after seal skips its first publish`, async () => {
				const { manager, storage, sessionDir } = await fixture(kind);
				const file = path.join(sessionDir, "explicit.jsonl");
				if (empty === "zero-byte") await storage.writeTextAtomic(file, "");
				const original = storage.writeTextAtomic.bind(storage);
				let first = true;
				const spy = spyOn(storage, "writeTextAtomic").mockImplementation(async (target, text, options) => {
					if (target === file && first) {
						first = false;
						manager.seal();
					}
					return original(target, text, options);
				});
				try {
					await manager.setSessionFile(file);
					expect(manager.captureState().onDisk).toBe(false);
					expect(manager.captureState().needsRewrite).toBe(true);
					const id = manager.getSessionId();
					await manager.close();
					const header = (await records(storage, file)).find(entry => entry.type === "session");
					expect(header?.id).toBe(id);
					expect(header?.cwd).toBe(manager.getCwd());
				} finally {
					await manager.close().catch(() => {});
					spy.mockRestore();
					manager.releaseRetainedEntries();
				}
			});
		}
	});
it("does not rewrite against the Indexed backend's optimistic size during a title append", async () => {
	const { manager, storage, backend } = await fixture("indexed");
	const gate = Promise.withResolvers<void>();
	backend.appendGate = gate.promise;
	const naming = manager.setSessionName("first", "user");
	await backend.appendStarted.promise;
	const id = manager.appendCustomEntry("during-append", { value: 1 });
	manager.appendMessage({ role: "user", content: "during backend append", timestamp: Date.now() });
	try {
		gate.resolve();
		await naming;
		await manager.flush();
		manager.seal();
		await manager.close();
		const saved = await records(storage, manager.getSessionFile()!);
		expect(saved.filter(entry => entry.id === id)).toHaveLength(1);
		expect(saved[0].title).toBe("first");
	} finally {
		gate.resolve();
		await naming.catch(() => {});
		await manager.close().catch(() => {});
		manager.releaseRetainedEntries();
	}
});
for (const kind of kinds)
	it(`${kind} repairs an older in-flight title after a synchronous flush saves a newer title`, async () => {
		const { manager, storage } = await fixture(kind);
		const gate = pauseTitle(storage);
		const first = manager.setSessionName("first", "user");
		await gate.entered;
		const latest = manager.setSessionName("latest", "user");
		try {
			manager.flushSync();
			await storage.drain();
			gate.release();
			await first;
			await latest;
			await manager.flush();
			expect((await records(storage, manager.getSessionFile()!))[0].title).toBe("latest");
			expect(
				(await records(storage, manager.getSessionFile()!)).filter(
					entry => entry.type === "title_change" && entry.title === "latest",
				),
			).toHaveLength(1);
			manager.seal();
			await manager.close();
			expect((await records(storage, manager.getSessionFile()!))[0].title).toBe("latest");
		} finally {
			gate.release();
			await first.catch(() => {});
			await latest.catch(() => {});
			await manager.close().catch(() => {});
			gate.restore();
			manager.releaseRetainedEntries();
		}
	});
for (const mutation of mutations)
	it(`keeps Indexed appends ordered with ${mutation} behind a pending title append`, async () => {
		const { manager, storage, backend, workspace } = await fixture("indexed");
		if (mutation === "remove-workspace") await manager.addWorkspaceDirectory(workspace);
		const gate = Promise.withResolvers<void>();
		backend.appendGate = gate.promise;
		const naming = manager.setSessionName("first", "user");
		await backend.appendStarted.promise;
		const changing = mutate(manager, mutation, workspace);
		const id = manager.appendCustomEntry("during-header-and-title", { value: 1 });
		try {
			gate.resolve();
			await naming;
			await changing;
			await manager.flush();
			manager.seal();
			await manager.close();
			const saved = await records(storage, manager.getSessionFile()!);
			expect(saved.filter(entry => entry.id === id)).toHaveLength(1);
			assertMutation(saved, mutation, workspace);
		} finally {
			gate.resolve();
			await naming.catch(() => {});
			await changing.catch(() => {});
			await manager.close().catch(() => {});
			manager.releaseRetainedEntries();
		}
	});
