import { afterEach, describe, expect, it, type Mock, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { BlobStore } from "@oh-my-pi/pi-coding-agent/session/blob-store";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	FileSessionStorage,
	type SessionStorageWriter,
	tryAcquireSessionLease,
} from "@oh-my-pi/pi-coding-agent/session/session-storage";
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

	for (const firstWriter of ["clone", "source"] as const) {
		it(`persists a shared queued tail once when the ${firstWriter} recovers first`, async () => {
			const { manager, sessionFile } = newSession("@pi-full-volume-clone-recovery-");
			manager.appendMessage(userMessage("before"));
			appendWhileFull(manager, "queued");
			const clone = manager.cloneCurrentSession({ persist: true });
			try {
				const first = firstWriter === "clone" ? clone : manager;
				const second = firstWriter === "clone" ? manager : clone;
				first.appendMessage(userMessage("first"));
				await first.flush();
				second.appendMessage(userMessage("second"));
				await second.flush();
				expect(usersOnDisk(sessionFile).sort()).toEqual(["before", "first", "queued", "second"]);
				const ids = userEntriesOnDisk(sessionFile).map(entry => entry.id);
				expect(new Set(ids).size).toBe(ids.length);
				expect(second.captureState().expectedDiskSize).toBe(fs.statSync(sessionFile).size);
				await second.rewriteEntries();
				expect(usersOnDisk(sessionFile).sort()).toEqual(["before", "first", "queued", "second"]);
			} finally {
				await clone.close();
				await manager.close();
			}
		});
	}

	for (const finish of [
		"flush",
		"flushSync",
		"newSession",
		"setSessionFile",
		"fork",
		"createBranchedSession",
	] as const) {
		it(`drains a shared queued tail before a clone ${finish} without another append`, async () => {
			const { manager, sessionFile } = newSession("@pi-full-volume-clone-drain-");
			const leaf = manager.appendMessage(userMessage("before"));
			appendWhileFull(manager, "queued");
			const clone = manager.cloneCurrentSession({ persist: true });
			try {
				switch (finish) {
					case "flush":
						await clone.flush();
						break;
					case "flushSync":
						clone.flushSync();
						break;
					case "newSession":
						await clone.newSession();
						break;
					case "setSessionFile":
						await clone.setSessionFile(sessionFile);
						break;
					case "fork":
						await clone.fork();
						break;
					case "createBranchedSession":
						clone.createBranchedSession(leaf);
						break;
				}
				expect(usersOnDisk(sessionFile)).toEqual(["before", "queued"]);
			} finally {
				await clone.close();
				await manager.close();
			}
		});
	}

	it("preserves a tail rewrite obligation through another persistent clone", async () => {
		const { manager, sessionFile } = newSession("@pi-full-volume-clone-snapshot-");
		appendWhileFull(manager, "queued");
		const clone = manager.cloneCurrentSession({ persist: true });
		const next = clone.cloneCurrentSession({ persist: true });
		try {
			await next.flush();
			expect(usersOnDisk(sessionFile)).toEqual(["queued"]);
			await manager.flush();
			await clone.flush();
			expect(usersOnDisk(sessionFile)).toEqual(["queued"]);
		} finally {
			await next.close();
			await clone.close();
			await manager.close();
		}
	});

	for (const finish of [
		"flush",
		"flushSync",
		"rewriteEntries",
		"newSession",
		"setSessionFile",
		"fork",
		"createBranchedSession",
	] as const) {
		it(`retries an abandoned queued tail before ${finish} after a failed full-volume drain`, async () => {
			const { manager, sessionFile } = newSession("@pi-full-volume-abandoned-retry-");
			const id = manager.appendCustomEntry("mutable", { value: "old" });
			appendWhileFull(manager, "queued");
			const leaf = manager.getLeafId();
			const entry = manager.getEntry(id);
			if (entry?.type !== "custom" || !leaf) throw new Error("Expected mutable entry and leaf");
			entry.data = { value: "edited" };
			const rewrites = spyOnWholeFileRewrites();
			for (const rewrite of rewrites)
				rewrite.mockImplementation(() => {
					throw fsError("ENOSPC");
				});
			try {
				await expect(manager.rewriteEntries()).rejects.toThrow("ENOSPC");
				await expect(manager.flush()).rejects.toThrow("ENOSPC");
				for (const rewrite of rewrites) rewrite.mockRestore();
				switch (finish) {
					case "flush":
						await manager.flush();
						break;
					case "flushSync":
						manager.flushSync();
						break;
					case "rewriteEntries":
						await manager.rewriteEntries();
						break;
					case "newSession":
						await manager.newSession();
						break;
					case "setSessionFile":
						await manager.setSessionFile(sessionFile);
						break;
					case "fork":
						await manager.fork();
						break;
					case "createBranchedSession":
						manager.createBranchedSession(leaf);
						break;
				}
				expect(fs.readFileSync(sessionFile, "utf8")).toContain('"value":"edited"');
				expect(usersOnDisk(sessionFile)).toEqual(["queued"]);
			} finally {
				for (const rewrite of rewrites) rewrite.mockRestore();
				await manager.close();
			}
		});
	}

	it("does not turn a lazy malformed-tail repair into an eager flush rewrite", async () => {
		const { manager, sessionFile } = newSession("@pi-full-volume-lazy-repair-");
		await manager.close();
		manager.releaseRetainedEntries();
		fs.appendFileSync(sessionFile, '{"type":"message","torn":');
		const before = fs.readFileSync(sessionFile, "utf8");
		const reopened = await SessionManager.open(sessionFile);
		try {
			await reopened.flush();
			expect(fs.readFileSync(sessionFile, "utf8")).toBe(before);
		} finally {
			await reopened.close();
			reopened.releaseRetainedEntries();
		}
	});

	for (const finish of ["flush", "close"] as const) {
		it(`retains an in-place rewrite after a queued append until ${finish} recovers`, async () => {
			const { manager, sessionFile } = newSession("@pi-full-volume-rewrite-intent-");
			const id = manager.appendCustomEntry("mutable", { value: "old" });
			appendWhileFull(manager, "queued");
			const entry = manager.getEntry(id);
			if (entry?.type !== "custom") throw new Error("Expected a custom entry");
			entry.data = { value: "edited" };
			const rewrites = spyOnWholeFileRewrites();
			for (const rewrite of rewrites)
				rewrite.mockImplementation(() => {
					throw fsError("ENOSPC");
				});
			try {
				await expect(manager.rewriteEntries()).rejects.toThrow("ENOSPC");
			} finally {
				for (const rewrite of rewrites) rewrite.mockRestore();
			}
			await manager[finish]();
			expect(fs.readFileSync(sessionFile, "utf8")).toContain('"value":"edited"');
			expect(usersOnDisk(sessionFile)).toEqual(["queued"]);
			await manager.close();
		});
	}

	it("releases an existing move destination's lease when the source tail cannot drain", async () => {
		const { manager, sessionFile } = newSession("@pi-full-volume-move-destination-lease-");
		const { manager: target, sessionFile: targetFile } = newSession("@pi-full-volume-move-target-");
		const targetId = target.getSessionId();
		await target.close();
		const destination = path.join(path.dirname(targetFile), path.basename(sessionFile));
		fs.renameSync(targetFile, destination);
		appendWhileFull(manager, "queued");
		const diskFull = spyOn(fs, "writeSync").mockImplementation(() => {
			throw fsError("ENOSPC");
		});
		try {
			for (let attempt = 0; attempt < 2; attempt++) {
				await expect(manager.moveTo(target.getCwd(), path.dirname(destination))).rejects.toThrow("ENOSPC");
				const lease = tryAcquireSessionLease(targetId);
				try {
					expect(lease).not.toBeNull();
				} finally {
					lease?.release();
				}
			}
			expect(manager.getSessionFile()).toBe(sessionFile);
			expect(usersOnDisk(destination)).toEqual([]);
		} finally {
			diskFull.mockRestore();
			await manager.close();
		}
	});

	it("sizes a small retained branch independently of a large off-branch source", async () => {
		const { manager, sessionFile } = newSession("@pi-full-volume-branch-size-");
		const leafId = manager.appendMessage(userMessage("retained"));
		manager.appendCustomEntry("off-branch", Array(16).fill("x".repeat(400 * 1024)));
		expect(fs.statSync(sessionFile).size).toBeGreaterThan(6 * 1024 * 1024);
		const volumeFull = spyOn(fs, "statfsSync").mockReturnValue(nearlyFullVolume);
		try {
			const branchedFile = manager.createBranchedSession(leafId);
			expect(branchedFile).toBeDefined();
			manager.flushSync();
			expect(branchedFile).not.toBe(sessionFile);
			expect(fs.statSync(branchedFile!).size).toBeLessThan(4096);
			expect(usersOnDisk(branchedFile!)).toEqual(["retained"]);
			expect(fs.readFileSync(branchedFile!, "utf8")).not.toContain("off-branch");
		} finally {
			volumeFull.mockRestore();
			await manager.close();
		}
	});

	it("still guards a large retained branch before serialization without changing the source", async () => {
		const { manager, sessionFile } = newSession("@pi-full-volume-large-branch-size-");
		let serializationReads = 0;
		const leafId = manager.appendCustomEntry("retained-large", {
			chunks: Array(16).fill("x".repeat(400 * 1024)),
			get marker() {
				serializationReads++;
				return true;
			},
		});
		serializationReads = 0;
		const sessionId = manager.getSessionId();
		const volumeFull = spyOn(fs, "statfsSync").mockReturnValue(nearlyFullVolume);
		try {
			expect(() => manager.createBranchedSession(leafId)).toThrow("ENOSPC");
			expect(serializationReads).toBe(0);
			expect(manager.getSessionId()).toBe(sessionId);
			expect(manager.getSessionFile()).toBe(sessionFile);
		} finally {
			volumeFull.mockRestore();
			await manager.close();
		}
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

	for (const operation of ["setSessionFile", "newSession", "fork", "createBranchedSession"] as const) {
		it(`keeps the old session and queued entries when ${operation} cannot drain a full disk`, async () => {
			const { manager, sessionFile } = newSession(`@pi-full-volume-${operation}-`);
			const sessionId = manager.getSessionId();
			const diskFull = spyOn(fs, "writeSync").mockImplementation(() => {
				throw fsError("ENOSPC");
			});
			try {
				const queuedId = manager.appendCustomEntry("must-survive", { text: "queued" });
				const changeSession = () => {
					switch (operation) {
						case "setSessionFile":
							return manager.setSessionFile(sessionFile);
						case "newSession":
							return manager.newSession();
						case "fork":
							return manager.fork();
						case "createBranchedSession":
							return manager.createBranchedSession(queuedId);
					}
				};
				if (operation === "createBranchedSession") {
					expect(changeSession).toThrow("ENOSPC");
				} else {
					await expect(changeSession()).rejects.toThrow("ENOSPC");
				}
				expect(manager.getSessionId()).toBe(sessionId);
				expect(manager.getSessionFile()).toBe(sessionFile);
				expect(manager.getEntry(queuedId)).toBeDefined();
				const competingLease = tryAcquireSessionLease(sessionId);
				try {
					expect(competingLease).toBeNull();
				} finally {
					competingLease?.release();
				}
				diskFull.mockRestore();
				manager.flushSync();
				expect(fs.readFileSync(sessionFile, "utf8")).toContain("must-survive");
				await changeSession();
			} finally {
				diskFull.mockRestore();
				await manager.close();
			}
		});
	}

	it("retains its lease and transcript after a failed close until a successful retry", async () => {
		const { manager, sessionFile } = newSession("@pi-full-volume-close-retry-");
		const queuedId = manager.appendCustomEntry("before-full");
		appendWhileFull(manager, "must-survive-close");
		const diskFull = spyOn(fs, "writeSync").mockImplementation(() => {
			throw fsError("ENOSPC");
		});
		try {
			await expect(manager.close()).rejects.toThrow("ENOSPC");
			const competingLease = tryAcquireSessionLease(manager.getSessionId());
			try {
				expect(competingLease).toBeNull();
			} finally {
				competingLease?.release();
			}
			manager.releaseRetainedEntries();
			expect(manager.getEntry(queuedId)).toBeDefined();
			diskFull.mockRestore();
			await manager.close();
			expect(usersOnDisk(sessionFile)).toEqual(["must-survive-close"]);
			const lease = tryAcquireSessionLease(manager.getSessionId());
			try {
				expect(lease).not.toBeNull();
			} finally {
				lease?.release();
			}
			manager.releaseRetainedEntries();
			expect(manager.getEntries()).toEqual([]);
		} finally {
			diskFull.mockRestore();
		}
	});

	for (const phase of ["writer close", "storage drain"] as const) {
		it(`keeps ownership and retries a failed ${phase}`, async () => {
			const { manager } = newSession("@pi-full-volume-close-failure-");
			const opening = spyOn(FileSessionStorage.prototype, "openWriter");
			manager.appendMessage(userMessage("retained"));
			const writer = opening.mock.results.at(-1)?.value as SessionStorageWriter | undefined;
			opening.mockRestore();
			if (!writer) throw new Error("Expected an open session writer");
			const failure =
				phase === "writer close"
					? spyOn(writer, "close").mockRejectedValueOnce(fsError("ENOSPC"))
					: spyOn(FileSessionStorage.prototype, "drain").mockRejectedValueOnce(fsError("ENOSPC"));
			try {
				await expect(manager.close()).rejects.toThrow("ENOSPC");
				const competingLease = tryAcquireSessionLease(manager.getSessionId());
				try {
					expect(competingLease).toBeNull();
				} finally {
					competingLease?.release();
				}
				manager.releaseRetainedEntries();
				expect(manager.getEntries().length).toBeGreaterThan(0);
				failure.mockRestore();
				await manager.close();
				const lease = tryAcquireSessionLease(manager.getSessionId());
				try {
					expect(lease).not.toBeNull();
				} finally {
					lease?.release();
				}
			} finally {
				failure.mockRestore();
			}
		});
	}

	it("updates a queued title slot before flushSync returns", async () => {
		const { manager, sessionFile } = newSession("@pi-full-volume-title-sync-");
		const diskFull = spyOn(fs, "writeSync").mockImplementation(() => {
			throw fsError("ENOSPC");
		});
		try {
			await expect(manager.setSessionName("Synchronous title", "user")).rejects.toThrow("ENOSPC");
		} finally {
			diskFull.mockRestore();
		}
		manager.flushSync();
		expect(fs.readFileSync(sessionFile, "utf8").split("\n", 1)[0]).toContain("Synchronous title");
		await manager.close();
	});

	it("guards a large fork before serializing a fresh destination", async () => {
		const { manager, sessionFile } = newSession("@pi-full-volume-fork-guard-");
		let serializationReads = 0;
		manager.appendCustomEntry("large-fork", {
			chunks: Array(16).fill("x".repeat(400 * 1024)),
			get marker() {
				serializationReads++;
				return true;
			},
		});
		serializationReads = 0;
		expect(fs.statSync(sessionFile).size).toBeGreaterThan(6 * 1024 * 1024);
		const sessionId = manager.getSessionId();
		const rewrites = spyOnWholeFileRewrites();
		const volumeFull = spyOn(fs, "statfsSync").mockReturnValue(nearlyFullVolume);
		try {
			await expect(manager.fork()).rejects.toThrow("ENOSPC");
			expect(volumeFull).toHaveBeenCalled();
			for (const rewrite of rewrites) expect(rewrite).not.toHaveBeenCalled();
			expect(manager.getSessionFile()).toBe(sessionFile);
			expect(serializationReads).toBe(0);
			expect(manager.getSessionId()).toBe(sessionId);
			volumeFull.mockRestore();
			const fork = await manager.fork();
			expect(fork?.oldSessionFile).toBe(sessionFile);
			expect(fs.statSync(fork!.newSessionFile).size).toBeGreaterThan(6 * 1024 * 1024);
		} finally {
			volumeFull.mockRestore();
			for (const rewrite of rewrites) rewrite.mockRestore();
			await manager.close();
		}
	});

	it("guards a clone rewrite using queued bytes beyond the small durable file", () => {
		let serializationReads = 0;
		const { manager, sessionFile } = newSession("@pi-full-volume-queued-size-");
		const diskFull = spyOn(fs, "writeSync").mockImplementation(() => {
			throw fsError("ENOSPC");
		});
		try {
			manager.appendCustomEntry("large-queued", {
				chunks: Array(16).fill("x".repeat(400 * 1024)),
				get marker() {
					serializationReads++;
					return true;
				},
			});
		} finally {
			diskFull.mockRestore();
		}
		expect(fs.statSync(sessionFile).size).toBeLessThan(4 * 1024 * 1024);
		const clone = manager.cloneCurrentSession({ persist: true });
		serializationReads = 0;
		const rewrites = spyOnWholeFileRewrites();
		const volumeFull = spyOn(fs, "statfsSync").mockReturnValue(nearlyFullVolume);
		try {
			clone.appendMessage(userMessage("after-clone"));
			expect(() => clone.flushSync()).toThrow("ENOSPC");
			expect(volumeFull).toHaveBeenCalled();
			for (const rewrite of rewrites) expect(rewrite).not.toHaveBeenCalled();
			expect(serializationReads).toBe(0);
			volumeFull.mockRestore();
			clone.appendMessage(userMessage("room-again"));
			clone.flushSync();
			expect(fs.readFileSync(sessionFile, "utf8")).toContain("large-queued");
			expect(usersOnDisk(sessionFile)).toEqual(["after-clone", "room-again"]);
		} finally {
			volumeFull.mockRestore();
			for (const rewrite of rewrites) rewrite.mockRestore();
		}
	});

	it("retries only the pending title slot after the queued title line landed", async () => {
		const { manager, sessionFile } = newSession("@pi-full-volume-title-slot-retry-");
		const diskFull = spyOn(fs, "writeSync").mockImplementation(() => {
			throw fsError("ENOSPC");
		});
		try {
			await expect(manager.setSessionName("Retry slot directly", "user")).rejects.toThrow("ENOSPC");
		} finally {
			diskFull.mockRestore();
		}
		const writeSync = fs.writeSync;
		const slotFull = spyOn(fs, "writeSync").mockImplementation(((...args: unknown[]) => {
			if (args[4] === 0) throw fsError("EDQUOT");
			return Reflect.apply(writeSync, fs, args);
		}) as typeof fs.writeSync);
		const rewrites = spyOnWholeFileRewrites();
		try {
			manager.appendMessage(userMessage("after-title"));
			await expect(manager.flush()).rejects.toThrow();
			slotFull.mockRestore();
			await manager.flush();
			for (const rewrite of rewrites) expect(rewrite).not.toHaveBeenCalled();
			expect(fs.readFileSync(sessionFile, "utf8").split("\n", 1)[0]).toContain("Retry slot directly");
			expect(usersOnDisk(sessionFile)).toEqual(["after-title"]);
			expect(
				fs
					.readFileSync(sessionFile, "utf8")
					.split("\n")
					.filter(line => line.includes('"type":"title_change"')),
			).toHaveLength(1);
		} finally {
			slotFull.mockRestore();
			for (const rewrite of rewrites) rewrite.mockRestore();
			await manager.close();
		}
	});

	it("probes the symlink referent filesystem before a large rewrite", async () => {
		const { manager, sessionFile } = newSession("@pi-full-volume-symlink-guard-");
		manager.appendCustomEntry("large-referent", Array(16).fill("x".repeat(400 * 1024)));
		expect(fs.statSync(sessionFile).size).toBeGreaterThan(6 * 1024 * 1024);
		await manager.close();
		const targetDir = path.join(path.dirname(sessionFile), "referent");
		fs.mkdirSync(targetDir);
		const publishDir = fs.realpathSync(targetDir);
		const target = path.join(targetDir, "session.jsonl");
		fs.renameSync(sessionFile, target);
		fs.symlinkSync(target, sessionFile);
		const reopened = await SessionManager.open(sessionFile);
		const ioError = spyOn(fs, "writeSync").mockImplementationOnce(() => {
			throw fsError("EIO");
		});
		reopened.appendMessage(userMessage("io-failed"));
		ioError.mockRestore();
		const rewrites = spyOnWholeFileRewrites();
		const volumeFull = spyOn(fs, "statfsSync").mockImplementation(((probe: fs.PathLike) => {
			return probe === publishDir ? nearlyFullVolume : { ...nearlyFullVolume, bavail: 1e9, bfree: 1e9 };
		}) as typeof fs.statfsSync);
		try {
			reopened.appendMessage(userMessage("while-full"));
			expect(() => reopened.flushSync()).toThrow();
			expect(volumeFull).toHaveBeenCalledWith(publishDir);
			for (const rewrite of rewrites) expect(rewrite).not.toHaveBeenCalled();
			volumeFull.mockRestore();
			reopened.appendMessage(userMessage("room-again"));
			reopened.flushSync();
			expect(fs.lstatSync(sessionFile).isSymbolicLink()).toBe(true);
			expect(usersOnDisk(target)).toEqual(["io-failed", "while-full", "room-again"]);
		} finally {
			volumeFull.mockRestore();
			for (const rewrite of rewrites) rewrite.mockRestore();
			await reopened.close();
		}
	});

	it("keeps a title scheduled before a synchronous append fills the disk", async () => {
		const { manager, sessionFile } = newSession("@pi-full-volume-title-race-");
		const naming = manager.setSessionName("Scheduled before full", "user");
		const diskFull = spyOn(fs, "writeSync").mockImplementation(() => {
			throw fsError("ENOSPC");
		});
		try {
			manager.appendMessage(userMessage("fills-disk"));
			await expect(naming).rejects.toThrow("ENOSPC");
		} finally {
			diskFull.mockRestore();
		}
		await manager.flush();
		await manager.close();
		const reopened = await SessionManager.open(sessionFile);
		expect(reopened.getSessionName()).toBe("Scheduled before full");
		expect(fs.readFileSync(sessionFile, "utf8").split("\n", 1)[0]).toContain("Scheduled before full");
		expect(usersOnDisk(sessionFile)).toEqual(["fills-disk"]);
		await reopened.close();
	});

	it("rolls back queued entries without writing them or throwing on a full disk", async () => {
		const { manager, sessionFile } = newSession("@pi-full-volume-rollback-");
		appendWhileFull(manager, "before-snapshot");
		const snapshot = manager.captureState();
		const diskFull = spyOn(fs, "writeSync").mockImplementation(() => {
			throw fsError("ENOSPC");
		});
		try {
			manager.appendMessage(userMessage("rolled-back"));
			await expect(manager.setSessionName("Rolled-back title", "user")).rejects.toThrow("ENOSPC");
			expect(() => manager.restoreState(snapshot)).not.toThrow();
			expect(usersOnDisk(sessionFile)).toEqual([]);
		} finally {
			diskFull.mockRestore();
		}
		manager.appendMessage(userMessage("after-rollback"));
		manager.flushSync();
		expect(usersOnDisk(sessionFile)).toEqual(["before-snapshot", "after-rollback"]);
		expect(manager.getSessionName()).toBeUndefined();
		expect(fs.readFileSync(sessionFile, "utf8")).not.toContain("rolled-back");
		await manager.close();
	});

	it("releases a discarded target session's claim when restoring a different session", async () => {
		const { manager } = newSession("@pi-full-volume-rollback-source-");
		const snapshot = manager.captureState();
		const { manager: target, sessionFile } = newSession("@pi-full-volume-rollback-target-");
		const targetId = target.getSessionId();
		await target.close();
		await manager.setSessionFile(sessionFile);
		appendWhileFull(manager, "discarded-target-entry");
		const diskFull = spyOn(fs, "writeSync").mockImplementation(() => {
			throw fsError("ENOSPC");
		});
		try {
			expect(() => manager.restoreState(snapshot)).not.toThrow();
		} finally {
			diskFull.mockRestore();
		}
		const lease = tryAcquireSessionLease(targetId);
		try {
			expect(lease).not.toBeNull();
		} finally {
			lease?.release();
		}
		expect(manager.getSessionId()).toBe(snapshot.sessionId);
		expect(usersOnDisk(sessionFile)).toEqual([]);
		await manager.close();
	});

	it("persists a queued title and required metadata rewrite after seal", async () => {
		const { manager, sessionFile } = newSession("@pi-full-volume-sealed-title-");
		const naming = manager.setSessionName("Title at shutdown", "user");
		const metadata = manager.setTaskPromptCacheKey("shutdown-key");
		manager.seal();
		await Promise.all([naming, metadata]);
		await manager.close();
		manager.releaseRetainedEntries();
		const reopened = await SessionManager.open(sessionFile);
		expect(reopened.getSessionName()).toBe("Title at shutdown");
		expect(reopened.getHeader()?.taskPromptCacheKey).toBe("shutdown-key");
		await reopened.close();
	});

	it("retries a required rewrite with an empty tail after seal and a full disk", async () => {
		const { manager, sessionFile } = newSession("@pi-full-volume-sealed-rewrite-");
		const rewrites = spyOnWholeFileRewrites();
		for (const rewrite of rewrites)
			rewrite.mockImplementation(() => {
				throw fsError("ENOSPC");
			});
		try {
			await expect(manager.setTaskPromptCacheKey("retry-shutdown")).rejects.toThrow("ENOSPC");
			manager.seal();
			await expect(manager.close()).rejects.toThrow("ENOSPC");
		} finally {
			for (const rewrite of rewrites) rewrite.mockRestore();
		}
		await manager.close();
		expect(fs.readFileSync(sessionFile, "utf8")).toContain("retry-shutdown");
		const lease = tryAcquireSessionLease(manager.getSessionId());
		try {
			expect(lease).not.toBeNull();
		} finally {
			lease?.release();
		}
	});

	it("queues an image whose blob write fills the disk and later appends without rewriting", async () => {
		const { manager, sessionFile } = newSession("@pi-full-volume-blob-tail-");
		const blobDir = TempDir.createSync("@pi-full-volume-test-blobs-");
		tempDirs.push(blobDir);
		const blobStore = new BlobStore(blobDir.path());
		const putSync = BlobStore.prototype.putSync;
		let full = true;
		const blobWrite = spyOn(BlobStore.prototype, "putSync").mockImplementation((data, options) => {
			if (full) throw fsError("ENOSPC");
			return putSync.call(blobStore, data, options);
		});
		const rewrites = spyOnWholeFileRewrites();
		try {
			manager.appendMessage({
				role: "user",
				content: [{ type: "image", data: "a".repeat(2048), mimeType: "image/png" }],
				timestamp: 1,
			});
			expect(blobWrite).toHaveBeenCalledTimes(1);
			manager.appendMessage(userMessage("behind-image"));
			expect(blobWrite).toHaveBeenCalledTimes(2);
			full = false;
			manager.flushSync();
			for (const rewrite of rewrites) expect(rewrite).not.toHaveBeenCalled();
			const users = userEntriesOnDisk(sessionFile);
			expect(users).toHaveLength(2);
			expect(users[0]?.message?.content).toEqual([
				expect.objectContaining({ type: "image", data: expect.stringContaining("blob:") }),
			]);
			expect(users[1]?.message?.content).toBe("behind-image");
		} finally {
			blobWrite.mockRestore();
			for (const rewrite of rewrites) rewrite.mockRestore();
			await manager.close();
		}
	});

	it("does not externalize images in lazy sessions or rolled-back atomic batches", async () => {
		const dir = TempDir.createSync("@pi-full-volume-deferred-blobs-");
		tempDirs.push(dir);
		const lazy = SessionManager.create(dir.path(), path.join(dir.path(), "sessions"));
		const { manager } = newSession("@pi-full-volume-atomic-blobs-");
		const blobWrite = spyOn(BlobStore.prototype, "putSync").mockImplementation(() => {
			throw fsError("ENOSPC");
		});
		const image = {
			role: "user" as const,
			content: [{ type: "image" as const, data: "a".repeat(2048), mimeType: "image/png" }],
			timestamp: 1,
		};
		try {
			lazy.appendMessage(image);
			expect(blobWrite).not.toHaveBeenCalled();
			await expect(
				manager.appendEntriesAtomically(() => {
					manager.appendMessage(image);
					throw new Error("cancel batch");
				}),
			).rejects.toThrow("cancel batch");
			expect(blobWrite).not.toHaveBeenCalled();
		} finally {
			blobWrite.mockRestore();
			await manager.close();
		}
	});

	it("recreates the complete session when a pending title slot write returns ENOENT", async () => {
		const { manager, sessionFile } = newSession("@pi-full-volume-slot-enoent-");
		const missingSlot = spyOn(FileSessionStorage.prototype, "updateSessionTitleSync").mockImplementation(() => {
			throw fsError("ENOENT");
		});
		try {
			await expect(manager.setSessionName("Recreated title", "user")).rejects.toThrow("ENOENT");
			manager.appendMessage(userMessage("after-slot-error"));
			manager.flushSync();
			expect(usersOnDisk(sessionFile)).toEqual(["after-slot-error"]);
			expect(fs.readFileSync(sessionFile, "utf8").split("\n", 1)[0]).toContain("Recreated title");
		} finally {
			missingSlot.mockRestore();
			await manager.close();
		}
	});

	it("releases the internal rename manager's lease when a full disk refuses the rename", async () => {
		const { manager, sessionFile } = newSession("@pi-full-volume-rename-lease-");
		const sessionId = manager.getSessionId();
		await manager.close();
		const diskFull = spyOn(fs, "writeSync").mockImplementation(() => {
			throw fsError("ENOSPC");
		});
		try {
			await expect(SessionManager.renameSessionTitle(sessionFile, "Refused rename")).rejects.toThrow("ENOSPC");
		} finally {
			diskFull.mockRestore();
		}
		const lease = tryAcquireSessionLease(sessionId);
		try {
			expect(lease).not.toBeNull();
		} finally {
			lease?.release();
		}
	});

	it("releases the internal relocated manager's lease when its rewrite and close fail", async () => {
		const { manager, sessionFile } = newSession("@pi-full-volume-relocate-lease-");
		const recordedCwd = manager.getCwd();
		const sessionId = manager.getSessionId();
		await manager.close();
		const destination = TempDir.createSync("@pi-full-volume-relocate-destination-");
		tempDirs.push(destination);
		const rewrites = spyOnWholeFileRewrites();
		for (const rewrite of rewrites)
			rewrite.mockImplementation(() => {
				throw fsError("ENOSPC");
			});
		try {
			await expect(
				SessionManager.openRelocated(sessionFile, recordedCwd, destination.path(), destination.path()),
			).rejects.toThrow("ENOSPC");
		} finally {
			for (const rewrite of rewrites) rewrite.mockRestore();
		}
		const lease = tryAcquireSessionLease(sessionId);
		try {
			expect(lease).not.toBeNull();
		} finally {
			lease?.release();
		}
	});

	it("retries a close whose storage drain rejected with a non-Error value", async () => {
		const { manager } = newSession("@pi-full-volume-close-non-error-");
		const drain = spyOn(FileSessionStorage.prototype, "drain").mockRejectedValueOnce("ENOSPC: rejected string");
		try {
			await expect(manager.close()).rejects.toThrow("ENOSPC");
			await manager.close();
		} finally {
			drain.mockRestore();
		}
	});

	it("guards copies of large in-memory transcripts", async () => {
		const dir = TempDir.createSync("@pi-full-volume-memory-copy-");
		tempDirs.push(dir);
		const manager = SessionManager.inMemory(dir.path());
		manager.appendCustomEntry("large-memory", Array(16).fill("x".repeat(400 * 1024)));
		const clone = manager.cloneCurrentSession({ persist: true });
		const rewrites = spyOnWholeFileRewrites();
		const volumeFull = spyOn(fs, "statfsSync").mockReturnValue(nearlyFullVolume);
		try {
			await expect(manager.persistCopy({ sessionDir: dir.path() })).rejects.toThrow("ENOSPC");
			expect(clone.captureState().prospectiveDiskSize).toBeGreaterThan(6 * 1024 * 1024);
			for (const rewrite of rewrites) expect(rewrite).not.toHaveBeenCalled();
		} finally {
			volumeFull.mockRestore();
			for (const rewrite of rewrites) rewrite.mockRestore();
		}
		const copy = await manager.persistCopy({ sessionDir: dir.path() });
		expect(fs.statSync(copy.getSessionFile()!).size).toBeGreaterThan(6 * 1024 * 1024);
		await copy.close();
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
