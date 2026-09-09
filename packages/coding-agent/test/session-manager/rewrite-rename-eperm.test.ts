import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { recoverOrphanedBackups } from "@oh-my-pi/pi-coding-agent/session/session-listing";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { FileSessionStorage, MemorySessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";

class FsCodeError extends Error {
	code: string;

	constructor(code: string, message: string) {
		super(message);
		this.code = code;
	}
}

// The atomic-write + EPERM `.bak` move-aside/rollback dance lives in
// FileSessionStorage.writeTextAtomic, which calls `renameSync` for the
// guard-then-publish step so a concurrent synchronous rewrite cannot be
// overwritten between the guard and the rename. These tests inject the
// Windows-style EPERM at the sync layer used by the atomic path.
class RenameEpermOnceStorage extends FileSessionStorage {
	failNextSessionReplace = false;
	backupPath: string | undefined;

	override renameSync(source: string, target: string): void {
		if (
			this.failNextSessionReplace &&
			source.includes(".tmp") &&
			target.endsWith(".jsonl") &&
			this.existsSync(target)
		) {
			this.failNextSessionReplace = false;
			throw new FsCodeError("EPERM", `EPERM: operation not permitted, rename '${source}' -> '${target}'`);
		}
		if (source.endsWith(".jsonl") && target.endsWith(".bak")) {
			this.backupPath = target;
		}
		super.renameSync(source, target);
	}
}

describe("SessionManager rewrite EPERM replacement fallback", () => {
	let sessionDir: string;

	beforeEach(async () => {
		sessionDir = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-eperm-"));
	});

	afterEach(async () => {
		await fsp.rm(sessionDir, { recursive: true, force: true });
	});

	it("keeps the active session healthy when replacing an existing file hits EPERM", async () => {
		const storage = new RenameEpermOnceStorage();
		const session = SessionManager.create(sessionDir, sessionDir, storage);
		await session.ensureOnDisk();
		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");

		// setSessionName now overlays the title slot in place; force a full rewrite
		// (as compaction/shake do) so the tmp→jsonl replace of the existing file
		// hits EPERM and exercises the atomic-write fallback.
		await expect(session.setSessionName("renamed session", "user")).resolves.toBe(true);
		storage.failNextSessionReplace = true;
		await expect(session.rewriteEntries()).resolves.toBeUndefined();

		const rewritten = await storage.readText(sessionFile);
		expect(rewritten).toContain('"title":"renamed session"');
		const backupPath = storage.backupPath;
		if (!backupPath) throw new Error("Expected EPERM fallback to create a rollback backup");
		expect(storage.existsSync(backupPath)).toBe(false);

		session.appendMessage({ role: "user", content: "after rewrite", timestamp: Date.now() });
		await expect(session.flush()).resolves.toBeUndefined();
	});
});

describe("SessionManager rewrite EPERM rollback failure", () => {
	let sessionDir: string;

	beforeEach(async () => {
		sessionDir = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-eperm-"));
	});

	afterEach(async () => {
		await fsp.rm(sessionDir, { recursive: true, force: true });
	});

	it("preserves the original EPERM as the thrown error's cause when rollback also fails", async () => {
		class DoubleFailStorage extends FileSessionStorage {
			failureMode = false;
			tempRenameAttempts = 0;

			override renameSync(source: string, target: string): void {
				if (!this.failureMode) return super.renameSync(source, target);
				// Every temp -> target rename fails with EPERM (both the upstream attempt in
				// writeTextAtomic and the retry inside #replaceSessionFileAfterEpermSync).
				if (source.includes(".tmp") && target.endsWith(".jsonl")) {
					this.tempRenameAttempts++;
					const tag = this.tempRenameAttempts === 1 ? "original" : "retry";
					throw new FsCodeError("EPERM", `EPERM ${tag}: rename '${source}' -> '${target}'`);
				}
				// The rollback rename (backup -> target) fails with a distinct code.
				if (source.endsWith(".bak") && target.endsWith(".jsonl")) {
					throw new FsCodeError("EIO", `EIO rollback: rename '${source}' -> '${target}'`);
				}
				super.renameSync(source, target);
			}
		}

		const storage = new DoubleFailStorage();
		const session = SessionManager.create(sessionDir, sessionDir, storage);
		await session.ensureOnDisk();
		storage.failureMode = true;
		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");

		let thrown: Error | undefined;
		try {
			await session.rewriteEntries();
		} catch (err) {
			thrown = err as Error;
		}
		if (!thrown) throw new Error("Expected setSessionName to reject");
		// Message text MUST surface both the retry failure and the rollback failure.
		expect(thrown.message).toContain("rollback");
		expect(thrown.message).toContain("EIO rollback");
		expect(thrown.message).toContain("EPERM retry");
		// `cause` MUST be the original upstream EPERM that started the fallback path,
		// not the second/retry failure or the rollback failure.
		const cause = thrown.cause as Error | undefined;
		expect(cause).toBeInstanceOf(Error);
		expect(cause?.message).toContain("EPERM original");
	});
});

describe("FileSessionStorage.writeTextAtomic commitGuard cleanup", () => {
	let sessionDir: string;

	beforeEach(async () => {
		sessionDir = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-guard-cleanup-"));
	});

	afterEach(async () => {
		await fsp.rm(sessionDir, { recursive: true, force: true });
	});

	async function listTempFiles(): Promise<string[]> {
		const names = await fsp.readdir(sessionDir);
		return names.filter(name => name.endsWith(".tmp"));
	}

	it("discards the staged temp when commitGuard rejects on the direct rename path", async () => {
		const storage = new FileSessionStorage();
		const target = path.join(sessionDir, "session.jsonl");
		await storage.writeTextAtomic(target, "existing\n", { commitGuard: () => false });
		expect(await listTempFiles()).toEqual([]);
		expect(await Bun.file(target).exists()).toBe(false);
	});

	it("discards the staged temp when the EPERM move-aside fallback's commitGuard rejects", async () => {
		let epermAttempted = false;
		let guardCalls = 0;
		class EpermThenGuardStorage extends FileSessionStorage {
			override renameSync(source: string, targetPath: string): void {
				if (source.includes(".tmp") && targetPath.endsWith(".jsonl") && !epermAttempted) {
					epermAttempted = true;
					throw new FsCodeError("EPERM", `EPERM: operation not permitted, rename '${source}' -> '${targetPath}'`);
				}
				super.renameSync(source, targetPath);
			}
		}
		const storage = new EpermThenGuardStorage();
		const target = path.join(sessionDir, "session.jsonl");
		await fsp.writeFile(target, "seed\n");

		await storage.writeTextAtomic(target, "next\n", {
			commitGuard: () => {
				guardCalls += 1;
				// First call (before primary rename): pass so we hit EPERM.
				// Second call (inside EPERM fallback, after move-aside): reject.
				return guardCalls === 1;
			},
		});

		expect(epermAttempted).toBe(true);
		expect(guardCalls).toBe(2);
		expect(await listTempFiles()).toEqual([]);
		// Backup was restored, so target still holds the seed content.
		expect(await Bun.file(target).text()).toBe("seed\n");
		const backups = (await fsp.readdir(sessionDir)).filter(name => name.endsWith(".bak"));
		expect(backups).toEqual([]);
	});

	it("discards the staged temp when the ENOENT move-aside branch's commitGuard rejects", async () => {
		let epermAttempted = false;
		let guardCalls = 0;
		class EpermMissingTargetStorage extends FileSessionStorage {
			override renameSync(source: string, targetPath: string): void {
				if (source.includes(".tmp") && targetPath.endsWith(".jsonl") && !epermAttempted) {
					epermAttempted = true;
					throw new FsCodeError("EPERM", `EPERM: operation not permitted, rename '${source}' -> '${targetPath}'`);
				}
				super.renameSync(source, targetPath);
			}
		}
		const storage = new EpermMissingTargetStorage();
		const target = path.join(sessionDir, "session.jsonl");
		// Target does not exist, so the move-aside step raises ENOENT.
		await storage.writeTextAtomic(target, "next\n", {
			commitGuard: () => {
				guardCalls += 1;
				return guardCalls === 1;
			},
		});

		expect(epermAttempted).toBe(true);
		expect(guardCalls).toBe(2);
		expect(await listTempFiles()).toEqual([]);
		expect(await Bun.file(target).exists()).toBe(false);
	});
});

describe("recoverOrphanedBackups", () => {
	it("promotes an orphaned <basename>.jsonl.<snowflake>.bak back to the primary path when the primary is missing", async () => {
		const storage = new MemorySessionStorage();
		const dir = "/sessions/proj";
		const primary = `${dir}/session-abc.jsonl`;
		const backup = `${primary}.1700000000000.bak`;
		storage.writeTextSync(backup, '{"type":"session","id":"abc"}\n');

		await recoverOrphanedBackups(dir, storage);

		expect(storage.existsSync(primary)).toBe(true);
		expect(storage.existsSync(backup)).toBe(false);
		expect(await storage.readText(primary)).toBe('{"type":"session","id":"abc"}\n');
	});

	it("leaves the backup alone when the primary already exists", async () => {
		const storage = new MemorySessionStorage();
		const dir = "/sessions/proj";
		const primary = `${dir}/session-xyz.jsonl`;
		const backup = `${primary}.1700000000000.bak`;
		storage.writeTextSync(primary, '{"type":"session","id":"xyz","keep":true}\n');
		storage.writeTextSync(backup, '{"type":"session","id":"xyz","stale":true}\n');

		await recoverOrphanedBackups(dir, storage);

		expect(await storage.readText(primary)).toContain('"keep":true');
		expect(storage.existsSync(backup)).toBe(true);
	});

	it("picks the newest backup when multiple orphans exist for the same primary", async () => {
		const storage = new MemorySessionStorage();
		const dir = "/sessions/proj";
		const primary = `${dir}/session-multi.jsonl`;
		const older = `${primary}.100.bak`;
		const newer = `${primary}.200.bak`;
		storage.writeTextSync(older, "older");
		// Force the newer backup to have a strictly higher mtime so recovery is deterministic.
		await Bun.sleep(5);
		storage.writeTextSync(newer, "newer");

		await recoverOrphanedBackups(dir, storage);

		expect(storage.existsSync(primary)).toBe(true);
		expect(await storage.readText(primary)).toBe("newer");
	});
});
