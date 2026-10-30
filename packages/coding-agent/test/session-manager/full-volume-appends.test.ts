import { afterEach, describe, expect, it, type Mock, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { FileSessionStorage, tryAcquireSessionLease } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { TempDir } from "@oh-my-pi/pi-utils";

const tempDirs: TempDir[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => dir.remove()));
});

function newSession(prefix: string): { manager: SessionManager; sessionFile: string } {
	const dir = TempDir.createSync(prefix);
	tempDirs.push(dir);
	const manager = SessionManager.create(dir.path(), path.join(dir.path(), "sessions"));
	manager.appendMessage(assistantMessage("seed"));
	const sessionFile = manager.getSessionFile();
	if (!sessionFile) throw new Error("Expected a session file");
	return { manager, sessionFile };
}

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

function userMessage(content: string) {
	return { role: "user" as const, content, timestamp: Date.now() };
}

type DiskEntry = {
	type?: string;
	id?: string;
	parentId?: string | null;
	message?: { role?: string; content?: unknown };
};

/** User message entries on disk, in file order. */
function userEntriesOnDisk(sessionFile: string): DiskEntry[] {
	return fs
		.readFileSync(sessionFile, "utf8")
		.split("\n")
		.filter(Boolean)
		.map(line => JSON.parse(line) as DiskEntry)
		.filter(entry => entry.type === "message" && entry.message?.role === "user");
}

/** User message texts on disk, in file order. */
function usersOnDisk(sessionFile: string): unknown[] {
	return userEntriesOnDisk(sessionFile).map(entry => entry.message?.content);
}

/** Append one user message while the volume refuses every write. */
function appendWhileFull(manager: SessionManager, text: string): void {
	const diskFull = spyOn(fs, "writeSync").mockImplementation(() => {
		throw fsError("ENOSPC");
	});
	try {
		manager.appendMessage(userMessage(text));
	} finally {
		diskFull.mockRestore();
	}
}

/** statfs of a volume with one free block, for root and everyone else. */
const nearlyFullVolume = { bavail: 1, bfree: 1, bsize: 4096 } as unknown as fs.StatsFs;

function fsError(code: string): Error {
	return Object.assign(new Error(`${code}: simulated`), { code });
}

/** Every way the file backend replaces a whole session file. */
function spyOnWholeFileRewrites(): Mock<(...args: never[]) => unknown>[] {
	return [
		spyOn(FileSessionStorage.prototype, "writeLinesSync"),
		spyOn(FileSessionStorage.prototype, "writeTextSync"),
		spyOn(FileSessionStorage.prototype, "writeLinesAtomic"),
		spyOn(FileSessionStorage.prototype, "writeTextAtomic"),
	] as unknown as Mock<(...args: never[]) => unknown>[];
}

describe("session persistence on a full volume", () => {
	it("appends the entries a full disk refused, in order, once there is room, without rewriting the file", () => {
		const { manager, sessionFile } = newSession("@pi-full-volume-tail-");
		manager.appendMessage(userMessage("before"));
		const savedBeforeFull = fs.readFileSync(sessionFile, "utf8");

		const rewrites = spyOnWholeFileRewrites();
		const diskFull = spyOn(fs, "writeSync").mockImplementation(() => {
			throw fsError("ENOSPC");
		});
		try {
			for (const text of ["full-1", "full-2", "full-3"]) manager.appendMessage(userMessage(text));
			// Each refused line was rolled back: the file holds exactly what it held before the disk filled.
			expect(fs.readFileSync(sessionFile, "utf8")).toBe(savedBeforeFull);
			expect(() => manager.flushSync()).toThrow("ENOSPC");

			diskFull.mockRestore();
			manager.appendMessage(userMessage("after"));
			expect(() => manager.flushSync()).not.toThrow();

			expect(usersOnDisk(sessionFile)).toEqual(["before", "full-1", "full-2", "full-3", "after"]);
			for (const rewrite of rewrites) expect(rewrite).not.toHaveBeenCalled();
		} finally {
			diskFull.mockRestore();
			for (const rewrite of rewrites) rewrite.mockRestore();
		}
	});

	it("refuses a whole-file rewrite the volume cannot hold, then rewrites once there is room", () => {
		const { manager, sessionFile } = newSession("@pi-full-volume-guard-");
		// Only a session past a few MiB is worth guarding; smaller rewrites are left to the write itself.
		// Long message text is cut to about 500 KB on disk, so it takes several to pass 4 MiB.
		for (let i = 0; i < 12; i++) manager.appendMessage(assistantMessage("x".repeat(512 * 1024)));
		manager.appendMessage(userMessage("before"));

		// A failure that is not about space leaves the file needing a whole-file rewrite.
		const ioError = spyOn(fs, "writeSync").mockImplementationOnce(() => {
			throw fsError("EIO");
		});
		manager.appendMessage(userMessage("io-failed"));
		ioError.mockRestore();

		const rewrites = spyOnWholeFileRewrites();
		const volumeFull = spyOn(fs, "statfsSync").mockReturnValue(nearlyFullVolume);
		try {
			manager.appendMessage(userMessage("while-full"));
			for (const rewrite of rewrites) expect(rewrite).not.toHaveBeenCalled();
			expect(() => manager.flushSync()).toThrow();
			expect(usersOnDisk(sessionFile)).toEqual(["before"]);

			volumeFull.mockRestore();
			manager.appendMessage(userMessage("room-again"));
			manager.flushSync();
			expect(usersOnDisk(sessionFile)).toEqual(["before", "io-failed", "while-full", "room-again"]);
		} finally {
			volumeFull.mockRestore();
			for (const rewrite of rewrites) rewrite.mockRestore();
		}
	});

	it("lands a queued line at flushSync once there is room, with no later append", () => {
		const { manager, sessionFile } = newSession("@pi-full-volume-flush-");
		manager.appendMessage(userMessage("before"));
		appendWhileFull(manager, "last-of-turn");

		expect(() => manager.flushSync()).not.toThrow();
		expect(usersOnDisk(sessionFile)).toEqual(["before", "last-of-turn"]);
	});

	it("lands a queued line when a sealed session closes", async () => {
		const { manager, sessionFile } = newSession("@pi-full-volume-close-");
		manager.appendMessage(userMessage("before"));
		appendWhileFull(manager, "last-of-turn");

		manager.seal();
		await manager.close();
		expect(usersOnDisk(sessionFile)).toEqual(["before", "last-of-turn"]);
	});

	it("keeps queued lines and their parent chain in a clone taken while they wait", () => {
		const { manager, sessionFile } = newSession("@pi-full-volume-clone-");
		manager.appendMessage(userMessage("before"));
		appendWhileFull(manager, "queued");

		const clone = manager.cloneCurrentSession({ persist: true });
		clone.appendMessage(userMessage("from-clone"));
		clone.flushSync();

		const users = userEntriesOnDisk(sessionFile);
		expect(users.map(entry => entry.message?.content)).toEqual(["before", "queued", "from-clone"]);
		expect(users[2]?.parentId).toBe(users[1]?.id);
	});

	it("queues a title change made while the disk is full and lands it, title slot included, without a rewrite", async () => {
		const { manager, sessionFile } = newSession("@pi-full-volume-title-");
		manager.appendMessage(userMessage("before"));
		appendWhileFull(manager, "queued");

		const rewrites = spyOnWholeFileRewrites();
		const diskFull = spyOn(fs, "writeSync").mockImplementation(() => {
			throw fsError("ENOSPC");
		});
		try {
			await expect(manager.setSessionName("Full disk topic", "user")).rejects.toThrow("ENOSPC");
			diskFull.mockRestore();

			manager.appendMessage(userMessage("after"));
			await manager.flush();
			for (const rewrite of rewrites) expect(rewrite).not.toHaveBeenCalled();
		} finally {
			diskFull.mockRestore();
			for (const rewrite of rewrites) rewrite.mockRestore();
		}

		expect(usersOnDisk(sessionFile)).toEqual(["before", "queued", "after"]);
		const reopened = await SessionManager.open(sessionFile);
		expect(reopened.getSessionName()).toBe("Full disk topic");
		expect(fs.readFileSync(sessionFile, "utf8").split("\n", 1)[0]).toContain("Full disk topic");
	});

	it("keeps an older session file without a title slot readable and titled when its title changes on a full disk", async () => {
		const { manager, sessionFile } = newSession("@pi-full-volume-slotless-");
		manager.appendMessage(userMessage("before"));
		await manager.close();
		// Older session files start with the header: they have no fixed-width title slot line.
		fs.writeFileSync(sessionFile, fs.readFileSync(sessionFile, "utf8").split("\n").slice(1).join("\n"));

		const older = await SessionManager.open(sessionFile);
		appendWhileFull(older, "queued");
		const diskFull = spyOn(fs, "writeSync").mockImplementation(() => {
			throw fsError("ENOSPC");
		});
		const rewritesRefused = spyOnWholeFileRewrites();
		for (const rewrite of rewritesRefused) {
			rewrite.mockImplementation(() => {
				throw fsError("ENOSPC");
			});
		}
		try {
			await expect(older.setSessionName("Older file topic", "user")).rejects.toThrow("ENOSPC");
		} finally {
			diskFull.mockRestore();
			for (const rewrite of rewritesRefused) rewrite.mockRestore();
		}
		older.appendMessage(userMessage("after"));
		await older.flush();
		await older.close();

		expect(usersOnDisk(sessionFile)).toEqual(["before", "queued", "after"]);
		const reopened = await SessionManager.open(sessionFile);
		expect(reopened.getSessionName()).toBe("Older file topic");
	});

	it("gives up the session's ownership lease when a close without seal lands queued lines", async () => {
		const { manager, sessionFile } = newSession("@pi-full-volume-lease-");
		manager.appendMessage(userMessage("before"));
		appendWhileFull(manager, "queued");

		await manager.close();
		expect(usersOnDisk(sessionFile)).toEqual(["before", "queued"]);
		const lease = tryAcquireSessionLease(manager.getSessionId());
		try {
			expect(lease).not.toBeNull();
		} finally {
			lease?.release();
		}
	});

	it("does not refuse a small session's whole-file write on a nearly full volume", () => {
		const volumeFull = spyOn(fs, "statfsSync").mockReturnValue(nearlyFullVolume);
		try {
			const { manager, sessionFile } = newSession("@pi-full-volume-small-");
			manager.appendMessage(userMessage("first"));
			expect(() => manager.flushSync()).not.toThrow();
			expect(usersOnDisk(sessionFile)).toEqual(["first"]);
		} finally {
			volumeFull.mockRestore();
		}
	});
});
