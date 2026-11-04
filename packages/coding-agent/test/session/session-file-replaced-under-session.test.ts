import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { type SessionPersistenceNotice, SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { TempDir } from "@oh-my-pi/pi-utils";

/**
 * Another program (a backup restore, a host-to-host mirror, an archiver)
 * changes the transcript of a RUNNING session under it: it renames an older
 * copy of the same journal over the path, swaps in a symlink to such a copy,
 * truncates it or removes it. The session must not keep appending to whatever
 * is at the path as if it were its journal: that leaves the entries the copy
 * lacks off disk for good and the next entry's parent missing, with nothing
 * said. It writes the whole journal back from memory and says which file
 * changed, and only once that write has landed.
 */
describe("a session whose transcript is replaced under it", () => {
	const userTurn = (content: string) => ({ role: "user" as const, content, timestamp: Date.now() });
	const userTurnsOf = (entries: readonly SessionEntry[]) =>
		entries.flatMap(entry =>
			entry.type === "message" && entry.message.role === "user" ? [entry.message.content] : [],
		);
	const allTurns = [
		"turn in the older copy",
		"turn the older copy lacks",
		"first turn after the change",
		"second turn after the change",
	];

	afterEach(() => {
		vi.restoreAllMocks();
	});

	/** A file-backed session with two turns on disk and a copy of the file as it was after the first. */
	async function liveSession(dir: string) {
		const manager = SessionManager.create(dir, dir, new FileSessionStorage());
		const notices: SessionPersistenceNotice[] = [];
		manager.onPersistenceNotice(notice => notices.push(notice));
		const failures: Error[] = [];
		manager.onPersistenceError(error => failures.push(error));
		await manager.ensureOnDisk();
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected a session file");
		manager.appendMessage(userTurn(allTurns[0]));
		const older = path.join(dir, "older-copy.jsonl");
		fs.copyFileSync(sessionFile, older);
		manager.appendMessage(userTurn(allTurns[1]));
		return { manager, sessionFile, older, written: fs.statSync(sessionFile).size, notices, failures };
	}

	/** The journal at `file`, read by a fresh manager, holds every entry `manager` has, in order, with no missing parent. */
	async function expectWholeJournal(file: string, dir: string, manager: SessionManager, turns: readonly string[]) {
		const reopened = await SessionManager.open(file, dir, new FileSessionStorage(), { suppressBreadcrumb: true });
		const onDisk = reopened.getEntries();
		expect(userTurnsOf(onDisk)).toEqual([...turns]);
		const ids = new Set(onDisk.map(entry => entry.id));
		expect(onDisk.filter(entry => entry.parentId !== null && !ids.has(entry.parentId))).toEqual([]);
		expect(onDisk.map(entry => entry.id)).toEqual(manager.getEntries().map(entry => entry.id));
	}

	it.each([
		{
			change: "an older copy renamed over the path",
			apply: (sessionFile: string, older: string) => {
				fs.copyFileSync(older, `${sessionFile}.staging`);
				fs.renameSync(`${sessionFile}.staging`, sessionFile);
			},
			readBack: (sessionFile: string) => sessionFile,
			found: (older: string): number | null | undefined => fs.statSync(older).size,
		},
		{
			// The size check alone would take it: only the file's identity tells it apart.
			// No bytes went missing by size, so it is written back without a notice.
			change: "an older copy padded to the same size renamed over the path",
			apply: (sessionFile: string, older: string) => {
				const padding = "\n".repeat(fs.statSync(sessionFile).size - fs.statSync(older).size);
				fs.writeFileSync(`${sessionFile}.staging`, fs.readFileSync(older, "utf8") + padding);
				fs.renameSync(`${sessionFile}.staging`, sessionFile);
			},
			readBack: (sessionFile: string) => sessionFile,
			found: (): number | null | undefined => undefined,
		},
		{
			change: "a symlink to an older copy renamed over the path",
			apply: (sessionFile: string, older: string) => {
				fs.symlinkSync(older, `${sessionFile}.staging`);
				fs.renameSync(`${sessionFile}.staging`, sessionFile);
			},
			// The symlink stays; the journal lands in the file it points at.
			readBack: (_sessionFile: string, older: string) => older,
			found: (older: string): number | null | undefined => fs.statSync(older).size,
		},
		{
			change: "the file removed",
			apply: (sessionFile: string) => fs.unlinkSync(sessionFile),
			readBack: (sessionFile: string) => sessionFile,
			found: (): number | null | undefined => null,
		},
		{
			// A program outside omp's publish lock acts after the size check, before the write lands.
			change: "the file removed between the size check and the write",
			apply: (sessionFile: string) => {
				const writeSync = fs.writeSync;
				let armed = true;
				vi.spyOn(fs, "writeSync").mockImplementation(((...args: Parameters<typeof fs.writeSync>) => {
					if (armed) {
						armed = false;
						fs.unlinkSync(sessionFile);
					}
					return (writeSync as (...a: Parameters<typeof fs.writeSync>) => number)(...args);
				}) as typeof fs.writeSync);
			},
			readBack: (sessionFile: string) => sessionFile,
			found: (): number | null | undefined => null,
		},
	])("writes the whole journal back after $change", async ({ apply, readBack, found }) => {
		using tempDir = TempDir.createSync("@omp-session-replaced-under-");
		const { manager, sessionFile, older, written, notices, failures } = await liveSession(tempDir.path());
		try {
			const foundBytes = found(older);
			apply(sessionFile, older);
			manager.appendMessage(userTurn(allTurns[2]));
			vi.restoreAllMocks();
			manager.appendMessage(userTurn(allTurns[3]));

			await expectWholeJournal(readBack(sessionFile, older), tempDir.path(), manager, allTurns);
			const restored: SessionPersistenceNotice[] =
				foundBytes === undefined
					? []
					: [{ reason: "restored", from: sessionFile, to: sessionFile, expectedBytes: written, foundBytes }];
			expect(notices).toEqual(restored);
			expect(failures).toEqual([]);
			expect(manager.getSessionFile()).toBe(sessionFile);
		} finally {
			await manager.close();
		}
	});

	it("moves to a sibling instead of writing over a file emptied under it", async () => {
		using tempDir = TempDir.createSync("@omp-session-emptied-under-");
		const { manager, sessionFile, notices, failures } = await liveSession(tempDir.path());
		try {
			// An empty file is not provably this session's: another writer may be filling it.
			fs.truncateSync(sessionFile, 0);
			manager.appendMessage(userTurn(allTurns[2]));
			manager.appendMessage(userTurn(allTurns[3]));

			const sibling = manager.getSessionFile();
			if (!sibling) throw new Error("Expected a session file");
			expect(sibling).not.toBe(sessionFile);
			expect(notices).toEqual([{ reason: "replaced", from: sessionFile, to: sibling }]);
			expect(fs.readFileSync(sessionFile, "utf8")).toBe("");
			const moved = await SessionManager.open(sibling, tempDir.path(), new FileSessionStorage(), {
				suppressBreadcrumb: true,
			});
			expect(userTurnsOf(moved.getEntries())).toEqual(allTurns);
			expect(failures).toEqual([]);
		} finally {
			await manager.close();
		}
	});

	/** `source`'s bytes padded with blank lines to `size`, renamed over `sessionFile`. */
	function renameOverPadded(sessionFile: string, source: string, size: number): void {
		const text = fs.readFileSync(source, "utf8");
		fs.writeFileSync(`${sessionFile}.staging`, text + "\n".repeat(size - Buffer.byteLength(text)));
		fs.renameSync(`${sessionFile}.staging`, sessionFile);
	}

	it("writes the whole journal back over a same-size older copy that lands after a full rewrite", async () => {
		using tempDir = TempDir.createSync("@omp-session-same-size-after-rewrite-");
		const { manager, sessionFile, older, notices, failures } = await liveSession(tempDir.path());
		try {
			// The rewrite closes the append writer, so the next one opens whatever is at the path.
			await manager.rewriteEntries();
			renameOverPadded(sessionFile, older, fs.statSync(sessionFile).size);
			manager.appendMessage(userTurn(allTurns[2]));
			manager.appendMessage(userTurn(allTurns[3]));

			await expectWholeJournal(sessionFile, tempDir.path(), manager, allTurns);
			expect(notices).toEqual([]);
			expect(failures).toEqual([]);
		} finally {
			await manager.close();
		}
	});

	it("leaves a foreign journal alone when it replaces the file again while the session is recovering", async () => {
		using tempDir = TempDir.createSync("@omp-session-replaced-during-recovery-");
		const { manager, sessionFile, older, notices, failures } = await liveSession(tempDir.path());
		const other = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "other"), new FileSessionStorage());
		try {
			// Header only: smaller than the older copy, so it can be padded to exactly its size.
			await other.ensureOnDisk();
			await other.close();
			const otherFile = other.getSessionFile();
			if (!otherFile) throw new Error("Expected the other session's file");

			// First failure: an older copy of this journal replaces the file.
			fs.copyFileSync(older, `${sessionFile}.staging`);
			fs.renameSync(`${sessionFile}.staging`, sessionFile);
			// Second failure, inside the recovery: right after it reads the older copy back,
			// another session's journal of the very same size replaces the file again.
			const olderSize = fs.statSync(older).size;
			expect(fs.statSync(other.getSessionFile() ?? "").size).toBeLessThan(olderSize);
			let foreignBytes: string | undefined;
			const readTextSync = FileSessionStorage.prototype.readTextSync;
			vi.spyOn(FileSessionStorage.prototype, "readTextSync").mockImplementation(
				function (this: FileSessionStorage, file) {
					const text = readTextSync.call(this, file);
					if (foreignBytes === undefined) {
						renameOverPadded(sessionFile, otherFile, olderSize);
						foreignBytes = fs.readFileSync(sessionFile, "utf8");
					}
					return text;
				},
			);
			manager.appendMessage(userTurn(allTurns[2]));
			vi.restoreAllMocks();
			manager.appendMessage(userTurn(allTurns[3]));

			// The foreign journal is untouched; this session saves elsewhere, whole.
			if (foreignBytes === undefined) throw new Error("Expected the file to be replaced during recovery");
			expect(fs.readFileSync(sessionFile, "utf8")).toBe(foreignBytes);
			const sibling = manager.getSessionFile();
			if (!sibling) throw new Error("Expected a session file");
			expect(sibling).not.toBe(sessionFile);
			expect(notices).toEqual([{ reason: "replaced", from: sessionFile, to: sibling }]);
			const moved = await SessionManager.open(sibling, tempDir.path(), new FileSessionStorage(), {
				suppressBreadcrumb: true,
			});
			expect(userTurnsOf(moved.getEntries())).toEqual(allTurns);
			expect(failures).toEqual([]);
		} finally {
			await manager.close();
		}
	});

	it("leaves another session's same-size journal alone and moves to a sibling", async () => {
		using tempDir = TempDir.createSync("@omp-session-foreign-same-size-");
		const { manager, sessionFile, notices, failures } = await liveSession(tempDir.path());
		const other = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "other"), new FileSessionStorage());
		try {
			await other.ensureOnDisk();
			other.appendMessage(userTurn("the other session's turn"));
			await other.close();
			const otherFile = other.getSessionFile();
			if (!otherFile) throw new Error("Expected the other session's file");
			renameOverPadded(sessionFile, otherFile, fs.statSync(sessionFile).size);
			const foreignBytes = fs.readFileSync(sessionFile, "utf8");
			manager.appendMessage(userTurn(allTurns[2]));
			manager.appendMessage(userTurn(allTurns[3]));

			const sibling = manager.getSessionFile();
			if (!sibling) throw new Error("Expected a session file");
			expect(notices).toEqual([{ reason: "replaced", from: sessionFile, to: sibling }]);
			expect(fs.readFileSync(sessionFile, "utf8")).toBe(foreignBytes);
			const moved = await SessionManager.open(sibling, tempDir.path(), new FileSessionStorage(), {
				suppressBreadcrumb: true,
			});
			expect(userTurnsOf(moved.getEntries())).toEqual(allTurns);
			expect(failures).toEqual([]);
		} finally {
			await manager.close();
		}
	});

	it("announces a restore of the session it switched to after an earlier one failed to restore", async () => {
		using tempDir = TempDir.createSync("@omp-session-restore-after-switch-");
		const dir = path.join(tempDir.path(), "sessions");
		fs.mkdirSync(dir);
		const { manager, sessionFile, older, notices } = await liveSession(dir);
		const otherDir = path.join(tempDir.path(), "other");
		const other = SessionManager.create(tempDir.path(), otherDir, new FileSessionStorage());
		try {
			await other.ensureOnDisk();
			other.appendMessage(userTurn("other: first"));
			const otherFile = other.getSessionFile();
			if (!otherFile) throw new Error("Expected the other session's file");
			const otherOlder = path.join(tempDir.path(), "other-older.jsonl");
			fs.copyFileSync(otherFile, otherOlder);
			other.appendMessage(userTurn("other: second"));
			await other.close();

			// The first session's write back fails, so its restore is never announced.
			fs.copyFileSync(older, `${sessionFile}.staging`);
			fs.renameSync(`${sessionFile}.staging`, sessionFile);
			const readTextSync = FileSessionStorage.prototype.readTextSync;
			vi.spyOn(FileSessionStorage.prototype, "readTextSync").mockImplementation(
				function (this: FileSessionStorage, file) {
					fs.chmodSync(dir, 0o500);
					return readTextSync.call(this, file);
				},
			);
			manager.appendMessage(userTurn(allTurns[2]));
			vi.restoreAllMocks();
			fs.chmodSync(dir, 0o700);

			await manager.setSessionFile(otherFile);
			const written = fs.statSync(otherFile).size;
			fs.copyFileSync(otherOlder, `${otherFile}.staging`);
			fs.renameSync(`${otherFile}.staging`, otherFile);
			manager.appendMessage(userTurn("other: third"));

			expect(notices).toEqual([
				{
					reason: "restored",
					from: otherFile,
					to: otherFile,
					expectedBytes: written,
					foundBytes: fs.statSync(otherOlder).size,
				},
			]);
		} finally {
			fs.chmodSync(dir, 0o700);
			await manager.close();
		}
	});

	it("writes back in place when a symlinked file's target is removed while no writer holds it", async () => {
		using tempDir = TempDir.createSync("@omp-session-link-target-gone-");
		const { manager, sessionFile, notices, failures } = await liveSession(tempDir.path());
		try {
			// The transcript is offloaded behind a symlink, then a full rewrite closes the append writer.
			const target = path.join(tempDir.path(), "offloaded.jsonl");
			fs.renameSync(sessionFile, target);
			fs.symlinkSync(target, sessionFile);
			await manager.rewriteEntries();
			const written = fs.statSync(target).size;
			fs.unlinkSync(target);

			manager.appendMessage(userTurn(allTurns[2]));
			manager.appendMessage(userTurn(allTurns[3]));

			// No empty file was conjured at the old target; the journal is whole at the session path.
			expect(fs.existsSync(target)).toBe(false);
			await expectWholeJournal(sessionFile, tempDir.path(), manager, allTurns);
			expect(notices).toEqual([
				{ reason: "restored", from: sessionFile, to: sessionFile, expectedBytes: written, foundBytes: null },
			]);
			expect(failures).toEqual([]);
		} finally {
			await manager.close();
		}
	});

	it("says restored only once the write back lands", async () => {
		using tempDir = TempDir.createSync("@omp-session-restore-fails-");
		const dir = path.join(tempDir.path(), "sessions");
		fs.mkdirSync(dir);
		const { manager, sessionFile, older, written, notices, failures } = await liveSession(dir);
		try {
			fs.copyFileSync(older, `${sessionFile}.staging`);
			fs.renameSync(`${sessionFile}.staging`, sessionFile);
			// The write back that recovery starts cannot be published: the directory turns read-only as it reads the file back.
			const readTextSync = FileSessionStorage.prototype.readTextSync;
			vi.spyOn(FileSessionStorage.prototype, "readTextSync").mockImplementation(
				function (this: FileSessionStorage, file) {
					fs.chmodSync(dir, 0o500);
					return readTextSync.call(this, file);
				},
			);
			manager.appendMessage(userTurn(allTurns[2]));
			vi.restoreAllMocks();
			fs.chmodSync(dir, 0o700);
			expect(notices).toEqual([]);
			expect(failures).toHaveLength(1);

			manager.appendMessage(userTurn(allTurns[3]));
			await expectWholeJournal(sessionFile, dir, manager, allTurns);
			expect(notices).toEqual([
				{
					reason: "restored",
					from: sessionFile,
					to: sessionFile,
					expectedBytes: written,
					foundBytes: fs.statSync(older).size,
				},
			]);
		} finally {
			fs.chmodSync(dir, 0o700);
			await manager.close();
		}
	});

	it("raises no notice when a title change and turns interleave with nothing else writing", async () => {
		using tempDir = TempDir.createSync("@omp-session-title-interleave-");
		const { manager, sessionFile, notices, failures } = await liveSession(tempDir.path());
		try {
			const titled = manager.setSessionName("A title", "user");
			await Promise.resolve();
			await Promise.resolve();
			manager.appendMessage(userTurn(allTurns[2]));
			await titled;
			manager.appendMessage(userTurn(allTurns[3]));
			await manager.flush();

			await expectWholeJournal(sessionFile, tempDir.path(), manager, allTurns);
			expect(notices).toEqual([]);
			expect(failures).toEqual([]);
		} finally {
			await manager.close();
		}
	});
});
