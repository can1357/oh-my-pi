import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { SessionManager, SessionMoveRefusedError } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { writeTerminalBreadcrumb } from "@oh-my-pi/pi-coding-agent/session/session-paths";
import { FileSessionStorage, type WriteTextAtomicOptions } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { TempDir, getConfigRootDir, setAgentDir } from "@oh-my-pi/pi-utils";
import { makeAssistantMessage } from "./helpers";

const dirs: TempDir[] = [];
afterEach(async () => {
	await Promise.all(dirs.splice(0).map(dir => dir.remove()));
});

function tempDir(): string {
	const dir = TempDir.createSync("@pi-lifecycle-cleanup-");
	dirs.push(dir);
	return dir.path();
}

function diskFull(): Error {
	return Object.assign(new Error("ENOSPC: simulated lifecycle failure"), { code: "ENOSPC" });
}

class TrackingStorage extends FileSessionStorage {
	readonly held = new Set<string>();
	failWrites = false;
	deniedId: string | undefined;

	override claimSession(id: string, file: string): (() => void) | null {
		if (id === this.deniedId) return null;
		const release = super.claimSession(id, file);
		if (!release) return release;
		this.held.add(id);
		return () => {
			this.held.delete(id);
			release();
		};
	}

	override writeLinesSync(...args: Parameters<FileSessionStorage["writeLinesSync"]>): void {
		if (this.failWrites) throw diskFull();
		super.writeLinesSync(...args);
	}

	override async writeLinesAtomic(
		file: string,
		lines: readonly string[],
		options?: WriteTextAtomicOptions,
	): Promise<void> {
		if (this.failWrites) throw diskFull();
		await super.writeLinesAtomic(file, lines, options);
	}
}

function seed(storage = new TrackingStorage()): { manager: SessionManager; file: string; storage: TrackingStorage } {
	const root = tempDir();
	const manager = SessionManager.create(root, path.join(root, "sessions"), storage);
	manager.appendMessage(makeAssistantMessage());
	const file = manager.getSessionFile();
	if (!file) throw new Error("Expected persisted session");
	return { manager, file, storage };
}

function diskEntries(file: string): Array<{ type: string; id: string; message?: { content: unknown } }> {
	return fs
		.readFileSync(file, "utf8")
		.split("\n")
		.filter(Boolean)
		.map(line => JSON.parse(line));
}

describe("sealed close conflict recovery", () => {
	for (const conflict of ["unlink", "foreign-append", "replacement"] as const) {
		it(`finishes a sealed metadata rewrite after ${conflict}`, async () => {
			const { manager, file, storage } = seed();
			await manager.flush();
			const before = fs.readFileSync(file, "utf8");
			const naming = manager.setTaskPromptCacheKey("sealed-conflict-key");
			manager.seal();
			await naming;
			let replacement: string | undefined;
			if (conflict === "unlink") fs.unlinkSync(file);
			else if (conflict === "foreign-append") {
				fs.appendFileSync(
					file,
					`${JSON.stringify({ type: "message", id: "foreign", parentId: manager.getLeafId(), timestamp: new Date().toISOString(), message: { role: "user", content: "foreign durable message", timestamp: 1 } })}\n`,
				);
			} else {
				replacement = before.replace(manager.getSessionId(), "replacement-session");
				fs.writeFileSync(file, replacement);
			}
			try {
				await manager.close();
				const target = manager.getSessionFile();
				if (!target) throw new Error("Expected recovery file");
				expect(fs.readFileSync(target, "utf8")).toContain("sealed-conflict-key");
				if (conflict === "foreign-append")
					expect(diskEntries(target).some(entry => entry.id === "foreign")).toBe(true);
				if (replacement) {
					expect(target).not.toBe(file);
					expect(fs.readFileSync(file, "utf8")).toBe(replacement);
				}
				expect(storage.held.size).toBe(0);
			} finally {
				await manager.close().catch(() => {});
			}
		});
	}

	it("checks ownership before a sealed deferred close publishes", async () => {
		class DeferredStorage extends TrackingStorage {
			readonly defersSyncPublish = true;
		}
		const storage = new DeferredStorage();
		const { manager: original, file } = seed(storage);
		await original.flush();
		await original.close();
		const before = fs.readFileSync(file, "utf8");
		const manager = await SessionManager.open(file, undefined, storage);
		storage.deniedId = manager.getSessionId();
		const naming = manager.setTaskPromptCacheKey("deferred-shutdown-key");
		manager.seal();
		await naming;
		try {
			await manager.close();
			expect(manager.getSessionFile()).not.toBe(file);
			expect(fs.readFileSync(file, "utf8")).toBe(before);
			expect(fs.readFileSync(manager.getSessionFile()!, "utf8")).toContain("deferred-shutdown-key");
			expect(storage.held.size).toBe(0);
		} finally {
			await manager.close().catch(() => {});
		}
	});
});

describe("unreturned session manager cleanup", () => {
	for (const operation of ["persistCopy", "forkFrom"] as const) {
		it(`releases ownership when ${operation} fails and close also fails`, async () => {
			const { manager: source, file } = seed();
			await source.flush();
			await source.close();
			const storage = new TrackingStorage();
			storage.failWrites = true;
			try {
				const result =
					operation === "persistCopy"
						? source.persistCopy({ sessionDir: tempDir(), suppressBreadcrumb: true }, storage)
						: SessionManager.forkFrom(file, tempDir(), tempDir(), storage, {
								copyArtifacts: false,
								suppressBreadcrumb: true,
							});
				await expect(result).rejects.toThrow("ENOSPC");
				expect(storage.held.size).toBe(0);
			} finally {
				storage.failWrites = false;
			}
		});
	}

	for (const refused of [false, true]) {
		it(`disposes a failed continueRecent manager when move is ${refused ? "refused and close fails" : "out of space"}`, async () => {
			const root = tempDir();
			const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
			const oldPane = process.env.TMUX_PANE;
			setAgentDir(path.join(root, "agent"));
			process.env.TMUX_PANE = "%lifecycle-failure";
			const oldCwd = path.join(root, "old-project");
			const cwd = path.join(root, "moved-project");
			fs.mkdirSync(oldCwd);
			const source = SessionManager.create(oldCwd);
			source.appendMessage(makeAssistantMessage());
			await source.flush();
			await source.close();
			source.releaseRetainedEntries();
			const file = source.getSessionFile()!;
			writeTerminalBreadcrumb(oldCwd, file);
			fs.renameSync(oldCwd, cwd);
			const storage = new TrackingStorage();
			const readers: number[] = [];
			const closed = new Set<number>();
			const openSync = fs.openSync;
			const closeSync = fs.closeSync;
			const openSpy = spyOn(fs, "openSync").mockImplementation((...args: Parameters<typeof fs.openSync>) => {
				const fd = openSync(...args);
				if (String(args[0]) === file && args[1] === "r") {
					readers.push(fd);
					closed.delete(fd);
				}
				return fd;
			});
			const closeSpy = spyOn(fs, "closeSync").mockImplementation(fd => {
				closed.add(fd);
				return closeSync(fd);
			});
			const moveSpy = refused
				? spyOn(SessionManager.prototype, "moveTo").mockImplementation(async function (this: SessionManager) {
						await this.setTaskPromptCacheKey("claimed-before-refusal");
						storage.failWrites = true;
						await this.setTaskPromptCacheKey("failed-before-refusal").catch(() => {});
						throw new SessionMoveRefusedError("simulated move refusal");
					})
				: undefined;
			if (!refused) storage.failWrites = true;
			let resumed: SessionManager | undefined;
			try {
				if (refused) resumed = await SessionManager.continueRecent(cwd, undefined, storage);
				else await expect(SessionManager.continueRecent(cwd, undefined, storage)).rejects.toThrow("ENOSPC");
				expect(storage.held.size).toBe(0);
				expect(readers.every(fd => closed.has(fd))).toBe(true);
			} finally {
				moveSpy?.mockRestore();
				openSpy.mockRestore();
				closeSpy.mockRestore();
				storage.failWrites = false;
				await resumed?.close();
				resumed?.releaseRetainedEntries();
				setAgentDir(oldAgentDir ?? path.join(getConfigRootDir(), "agent"));
				if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
				if (oldPane === undefined) delete process.env.TMUX_PANE;
				else process.env.TMUX_PANE = oldPane;
			}
		});
	}
});
