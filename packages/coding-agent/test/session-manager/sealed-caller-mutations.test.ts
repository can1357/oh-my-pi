import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { parse } from "@babel/parser";
import traverse from "@babel/traverse";
import type { ClassDeclaration, ClassMethod, ClassPrivateMethod } from "@babel/types";
import { createOpenAIResponsesHistoryPayload } from "@oh-my-pi/pi-ai/utils";
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
	type WriteTextAtomicOptions,
} from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { overlayTitleSlotContent, type SessionTitleUpdate } from "@oh-my-pi/pi-coding-agent/session/session-title-slot";
import { TempDir } from "@oh-my-pi/pi-utils";
import { makeAssistantMessage } from "./helpers";

const dirs: TempDir[] = [];
afterEach(async () => {
	await Promise.all(dirs.splice(0).map(dir => dir.remove()));
});
const kinds = ["malformed", "migrated", "sanitized", "no-title-slot", "memory", "indexed"] as const;
type Kind = (typeof kinds)[number];
class Backend implements SessionStorageBackend {
	readonly files = new Map<string, string>();
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
	const dir = TempDir.createSync("@pi-sealed-caller-mutation-");
	dirs.push(dir);
	const cwdA = path.join(dir.path(), "a"),
		cwdB = path.join(dir.path(), "b"),
		sessionDir = path.join(dir.path(), "sessions");
	fs.mkdirSync(cwdA);
	fs.mkdirSync(cwdB);
	let storage: SessionStorage = kind === "memory" ? new MemorySessionStorage() : new FileSessionStorage();
	if (kind === "indexed") {
		const indexed = new IndexedSessionStorage(new Backend());
		await indexed.initialize();
		storage = indexed;
	}
	let manager = SessionManager.create(cwdA, sessionDir, storage);
	manager.appendMessage(
		kind === "sanitized"
			? {
					...makeAssistantMessage(),
					api: "openai-responses",
					provider: "github-copilot",
					model: "fixture",
					providerPayload: createOpenAIResponsesHistoryPayload("github-copilot", [
						{ type: "reasoning", encrypted_content: "old" },
					]),
				}
			: makeAssistantMessage(),
	);
	await manager.flush();
	const file = manager.getSessionFile()!;
	await manager.close();
	manager.releaseRetainedEntries();
	let text = await storage.readText(file);
	if (kind === "malformed") text += '{"type":"message","torn":';
	if (kind === "migrated") text = text.replace('"version":3', '"version":2');
	if (kind === "no-title-slot") text = text.split("\n").slice(1).join("\n");
	if (kind === "malformed" || kind === "migrated" || kind === "no-title-slot")
		await storage.writeTextAtomic(file, text);
	manager = await SessionManager.open(file, sessionDir, storage);
	return { manager, storage, file, cwdA, cwdB, sessionDir };
}
async function records(storage: SessionStorage, file: string) {
	return (await storage.readText(file))
		.split("\n")
		.filter(Boolean)
		.map(line => JSON.parse(line));
}
function captureBeforeSeal(manager: SessionManager) {
	const state = manager.captureState();
	manager.seal();
	return state;
}

for (const kind of kinds) {
	it(`preserves sealed title rewrite for ${kind}`, async () => {
		const { manager, storage, file } = await fixture(kind);
		const naming = manager.setSessionName("Title at shutdown", "user");
		manager.seal();
		try {
			await naming;
			await manager.close();
			const journal = await records(storage, file);
			const reader = await SessionManager.open(file, undefined, storage);
			try {
				expect(reader.getSessionName()).toBe("Title at shutdown");
			} finally {
				await reader.close();
				reader.releaseRetainedEntries();
			}
			expect(journal.some(entry => entry.type === "title_change" && entry.title === "Title at shutdown")).toBe(true);
		} finally {
			await manager.close();
			manager.releaseRetainedEntries();
		}
	});
	it(`preserves sealed moveTo header rewrite for ${kind}`, async () => {
		const { manager, storage, file, cwdB, sessionDir } = await fixture(kind);
		const header = manager.getHeader()!;
		let cwd = header.cwd;
		const reached = Promise.withResolvers<ReturnType<SessionManager["captureState"]>>();
		Object.defineProperty(header, "cwd", {
			enumerable: true,
			configurable: true,
			get: () => cwd,
			set: value => {
				cwd = value;
				queueMicrotask(() => reached.resolve(captureBeforeSeal(manager)));
			},
		});
		const moving = manager.moveTo(cwdB, sessionDir);
		try {
			const pending = await reached.promise;
			await moving;
			await manager.close();
			expect((await records(storage, file)).find(entry => entry.type === "session").cwd).toBe(cwdB);
			expect(pending.onDisk).toBe(false);
			expect(pending.needsRewrite).toBe(true);
		} finally {
			await moving;
			await manager.close();
			manager.releaseRetainedEntries();
		}
	});
	it(`preserves sealed rollbackMove snapshot rewrite for ${kind}`, async () => {
		const { manager, storage, file, cwdA, cwdB, sessionDir } = await fixture(kind);
		const snapshot = manager.captureState();
		await manager.moveTo(cwdB, sessionDir);
		await manager.setTaskPromptCacheKey("moved-key");
		const reached = Promise.withResolvers<ReturnType<SessionManager["captureState"]>>();
		const restore = manager.restoreState.bind(manager);
		const interception = spyOn(manager, "restoreState").mockImplementation(state => {
			restore(state);
			queueMicrotask(() => reached.resolve(captureBeforeSeal(manager)));
		});
		const rollingBack = manager.rollbackMove(snapshot);
		try {
			const pending = await reached.promise;
			await rollingBack;
			await manager.close();
			const header = (await records(storage, file)).find(entry => entry.type === "session");
			expect(header.cwd).toBe(cwdA);
			expect(header.taskPromptCacheKey).toBeUndefined();
			expect(pending.onDisk).toBe(false);
			expect(pending.needsRewrite).toBe(true);
		} finally {
			interception.mockRestore();
			await rollingBack;
			await manager.close();
			manager.releaseRetainedEntries();
		}
	});
}

class ObservedStorage extends MemorySessionStorage {
	beforePersistence: (() => void) | undefined;
	atomicGate: Promise<void> | undefined;
	readonly atomicStarted = Promise.withResolvers<void>();
	override async writeTextAtomic(file: string, text: string, options?: WriteTextAtomicOptions) {
		this.beforePersistence?.();
		if (this.atomicGate) {
			this.atomicStarted.resolve();
			await this.atomicGate;
		}
		await super.writeTextAtomic(file, text, options);
	}
}
it("preserves a newer entry rewrite queued after an unawaited title through seal", async () => {
	const dir = TempDir.createSync("@pi-title-revision-");
	dirs.push(dir);
	const storage = new ObservedStorage();
	const manager = SessionManager.create(dir.path(), path.join(dir.path(), "sessions"), storage);
	manager.appendMessage(makeAssistantMessage());
	const id = manager.appendCustomEntry("mutable", { value: "old" });
	await manager.flush();
	const naming = manager.setSessionName("first", "user");
	const entry = manager.getEntry(id);
	if (entry?.type !== "custom") throw new Error("Expected custom entry");
	entry.data = { value: "new" };
	const atomic = Promise.withResolvers<void>();
	storage.atomicGate = atomic.promise;
	const rewriting = manager.rewriteEntries();
	try {
		await storage.atomicStarted.promise;
		expect(manager.captureState().onDisk).toBe(false);
		expect(manager.captureState().needsRewrite).toBe(true);
		manager.seal();
		atomic.resolve();
		await rewriting;
		await naming;
		await manager.close();
		expect((await records(storage, manager.getSessionFile()!)).find(item => item.id === id).data).toEqual({
			value: "new",
		});
	} finally {
		atomic.resolve();
		await naming;
		await rewriting;
		await manager.close();
		manager.releaseRetainedEntries();
	}
});

const sweep = [
	"setSessionName",
	"setTaskPromptCacheKey",
	"addWorkspaceDirectory",
	"removeWorkspaceDirectory",
	"setAdditionalDirectories",
	"rewriteEntries",
	"appendEntriesAtomically",
	"fork",
	"moveTo",
	"rollbackMove",
	"ensureOnDisk",
	"newSession",
	"setSessionFileMissing",
	"recoverPersistenceFromCurrentState",
] as const;
describe("caller mutation persistence-boundary sweep", () => {
	for (const method of sweep)
		it(`${method} preserves its journal at the persistence boundary`, async () => {
			const dir = TempDir.createSync("@pi-mutation-sweep-");
			dirs.push(dir);
			const storage = new ObservedStorage();
			const cwdA = dir.path(),
				cwdB = path.join(cwdA, "b"),
				sessionDir = path.join(cwdA, "sessions"),
				extra = path.join(cwdA, "extra");
			fs.mkdirSync(cwdB);
			const manager = SessionManager.create(cwdA, sessionDir, storage);
			if (method !== "ensureOnDisk") {
				manager.appendMessage(makeAssistantMessage());
				await manager.flush();
			}
			if (method === "removeWorkspaceDirectory") await manager.addWorkspaceDirectory(extra);
			const snapshot = manager.captureState();
			if (method === "rollbackMove") await manager.moveTo(cwdB, sessionDir);
			const observations: ReturnType<SessionManager["captureState"]>[] = [];
			storage.beforePersistence = () => observations.push(manager.captureState());
			try {
				switch (method) {
					case "setSessionName":
						await manager.setSessionName("sweep", "user");
						break;
					case "setTaskPromptCacheKey":
						await manager.setTaskPromptCacheKey("sweep");
						break;
					case "addWorkspaceDirectory":
						await manager.addWorkspaceDirectory(extra);
						break;
					case "removeWorkspaceDirectory":
						await manager.removeWorkspaceDirectory(extra);
						break;
					case "setAdditionalDirectories":
						await manager.setAdditionalDirectories([extra]);
						break;
					case "rewriteEntries":
						await manager.rewriteEntries();
						break;
					case "appendEntriesAtomically":
						await manager.appendEntriesAtomically(() => manager.appendCustomEntry("sweep"));
						break;
					case "fork":
						await manager.fork();
						break;
					case "moveTo":
						await manager.moveTo(cwdB, sessionDir);
						break;
					case "rollbackMove":
						await manager.rollbackMove(snapshot);
						break;
					case "ensureOnDisk":
						await manager.ensureOnDisk();
						break;
					case "newSession":
						await manager.newSession();
						break;
					case "setSessionFileMissing":
						await manager.setSessionFile(path.join(sessionDir, "missing.jsonl"));
						break;
					case "recoverPersistenceFromCurrentState":
						await manager.recoverPersistenceFromCurrentState();
						break;
				}
				if (method === "setSessionName") {
					expect(
						(await records(storage, manager.getSessionFile()!)).some(
							entry => entry.type === "title_change" && entry.title === "sweep",
						),
					).toBe(true);
				} else {
					expect(observations.length).toBeGreaterThan(0);
					for (const observation of observations) expect(observation.onDisk).toBe(false);
				}
			} finally {
				storage.beforePersistence = undefined;
				await manager.close();
				manager.releaseRetainedEntries();
			}
		});
});
it("keeps the complete async mutation audit roster synchronized with SessionManager", () => {
	const source = fs.readFileSync(new URL("../../src/session/session-manager.ts", import.meta.url), "utf8");
	const file = parse(source, { sourceType: "module", plugins: ["typescript"] });
	let found: ClassDeclaration | undefined;
	traverse(file, {
		ClassDeclaration(location) {
			if (location.node.id?.name === "SessionManager") {
				found = location.node;
				location.stop();
			}
		},
	});
	const declaration = found;
	if (!declaration) throw new Error("Expected SessionManager class");
	const methods = declaration.body.body.filter(
		(member): member is ClassMethod | ClassPrivateMethod =>
			member.type === "ClassMethod" || member.type === "ClassPrivateMethod",
	);
	const name = (method: ClassMethod | ClassPrivateMethod) =>
		method.key.type === "PrivateName"
			? `#${method.key.id.name}`
			: method.key.type === "Identifier"
				? method.key.name
				: source.slice(method.key.start!, method.key.end!);
	function callers(target: string) {
		return methods
			.filter(method => {
				let calls = false;
				traverse(method.body, {
					noScope: true,
					AwaitExpression(location) {
						const call = location.node.argument;
						if (call.type !== "CallExpression" || call.callee.type !== "MemberExpression") return;
						const key = call.callee.property;
						if (key.type === "PrivateName" && `#${key.id.name}` === target) calls = true;
					},
				});
				return calls;
			})
			.map(name)
			.sort();
	}
	expect(callers("#rewriteAtomically")).toEqual(
		[
			"#appendEntriesAtomicallyLocked",
			"#persistWorkspaceDirectoriesChange",
			"#setSessionFile",
			"ensureOnDisk",
			"flush",
			"fork",
			"forkFrom",
			"moveTo",
			"persistCopy",
			"rewriteEntries",
			"rollbackMove",
			"setTaskPromptCacheKey",
		].sort(),
	);
	expect(callers("#scheduleDiskWork")).toEqual(
		["#drainAndCloseWriter", "#rewriteAtomically", "close", "flush"].sort(),
	);
	const current = declaration.body.body.find(
		member => member.type === "ClassPrivateProperty" && member.key.id.name === "fileIsCurrent",
	);
	expect(
		current?.type === "ClassPrivateProperty" &&
			current.value?.type === "BooleanLiteral" &&
			current.value.value === false,
	).toBe(true);
	for (const methodName of ["persistCopy", "forkFrom"]) {
		const method = methods.find(member => name(member) === methodName)!;
		const text = source.slice(method.body.start!, method.body.end!);
		expect(text).toContain("new SessionManager(");
		expect(text).not.toMatch(/manager\.#fileIsCurrent\s*=\s*true/);
	}
});
it("persists the file title as an ordinary append before yielding without a full rewrite", async () => {
	const { manager, storage, file } = await fixture("malformed");
	await manager.rewriteEntries();
	const sync = spyOn(storage as FileSessionStorage, "writeLinesSync");
	const atomic = spyOn(storage as FileSessionStorage, "writeLinesAtomic");
	const naming = manager.setSessionName("fast path", "user");
	const pending = manager.captureState();
	try {
		expect(pending.onDisk).toBe(true);
		expect(pending.needsRewrite).toBe(false);
		manager.seal();
		await naming;
		await manager.close();
		expect(
			(await records(storage, file)).some(entry => entry.type === "title_change" && entry.title === "fast path"),
		).toBe(true);
		expect(sync).not.toHaveBeenCalled();
		expect(atomic).not.toHaveBeenCalled();
	} finally {
		sync.mockRestore();
		atomic.mockRestore();
		await manager.close();
		manager.releaseRetainedEntries();
	}
});
