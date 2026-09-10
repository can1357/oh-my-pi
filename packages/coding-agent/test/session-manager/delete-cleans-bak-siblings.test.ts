import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { listSessions, recoverOrphanedBackups } from "@oh-my-pi/pi-coding-agent/session/session-listing";
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";

// #11499: deleting a session must also remove its stale
// `<basename>.jsonl.<snowflake>.bak` siblings, otherwise the next listing
// scan runs recoverOrphanedBackups and resurrects the deleted session.
describe("deleteSessionWithArtifacts cleans stale .bak siblings", () => {
	let sessionDir: string;
	let storage: FileSessionStorage;

	beforeEach(async () => {
		sessionDir = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-delete-bak-"));
		storage = new FileSessionStorage();
	});

	afterEach(async () => {
		await fsp.rm(sessionDir, { recursive: true, force: true });
	});

	it("a deleted session stays gone after the listing scan", async () => {
		const primary = path.join(sessionDir, "session-gone.jsonl");
		await storage.writeText(primary, '{"type":"session","id":"gone"}\n');
		// Stale backup left behind by a failed EPERM-rewrite unlink, as in #11499.
		await storage.writeText(`${primary}.1700000000000.bak`, '{"type":"session","id":"gone","stale":true}\n');

		await storage.deleteSessionWithArtifacts(primary);

		expect(storage.existsSync(primary)).toBe(false);
		const leftovers = (await fsp.readdir(sessionDir)).filter(name => name.endsWith(".bak"));
		expect(leftovers).toEqual([]);

		// The read path that used to resurrect the session.
		await recoverOrphanedBackups(sessionDir, storage);
		expect(storage.existsSync(primary)).toBe(false);
		expect(await listSessions(sessionDir, storage).then(s => s.map(i => i.path))).not.toContain(primary);
	});

	it("still deletes cleanly when no .bak siblings exist", async () => {
		const primary = path.join(sessionDir, "session-clean.jsonl");
		await storage.writeText(primary, '{"type":"session","id":"clean"}\n');

		await storage.deleteSessionWithArtifacts(primary);

		expect(storage.existsSync(primary)).toBe(false);
	});

	it("leaves longer-named sessions' backups alone (prefix collision)", async () => {
		const primary = path.join(sessionDir, "foo.jsonl");
		const ownBackup = `${primary}.1700000000000.bak`;
		const longerPrimary = path.join(sessionDir, "foo.jsonl.copy.jsonl");
		const longerBackup = `${longerPrimary}.1700000000001.bak`;
		await storage.writeText(primary, '{"type":"session","id":"foo"}\n');
		await storage.writeText(ownBackup, '{"type":"session","id":"foo","stale":true}\n');
		await storage.writeText(longerPrimary, '{"type":"session","id":"copy"}\n');
		await storage.writeText(longerBackup, '{"type":"session","id":"copy","stale":true}\n');

		await storage.deleteSessionWithArtifacts(primary);

		expect(storage.existsSync(primary)).toBe(false);
		expect(storage.existsSync(ownBackup)).toBe(false);
		expect(storage.existsSync(longerBackup)).toBe(true);
		expect(await storage.readText(longerPrimary)).toContain('"id":"copy"');
	});

	it("fails the delete when the backup scan fails instead of reporting success", async () => {
		// A regular file in place of the directory: readdirSync raises ENOTDIR,
		// which must propagate — only a missing directory reads as empty.
		const blocker = path.join(sessionDir, "blocker");
		await storage.writeText(blocker, "not a dir\n");

		await expect(storage.deleteSessionWithArtifacts(path.join(blocker, "ghost.jsonl"))).rejects.toThrow(
			/Failed to scan session backups/,
		);
	});

	it("tolerates a backup that vanishes mid-delete (raced promotion)", async () => {
		const primary = path.join(sessionDir, "session-raced.jsonl");
		const backup = `${primary}.1700000000000.bak`;
		await storage.writeText(primary, '{"type":"session","id":"raced"}\n');
		await storage.writeText(backup, '{"type":"session","id":"raced","stale":true}\n');

		let backupUnlinkCalls = 0;
		class RacedStorage extends FileSessionStorage {
			override async unlink(target: string): Promise<void> {
				if (target === backup) {
					backupUnlinkCalls += 1;
					const err = new Error(`ENOENT: no such file or directory, unlink '${target}'`);
					(err as NodeJS.ErrnoException).code = "ENOENT";
					throw err;
				}
				return super.unlink(target);
			}
		}

		await new RacedStorage().deleteSessionWithArtifacts(primary);

		expect(backupUnlinkCalls).toBe(1);
		expect(storage.existsSync(primary)).toBe(false);
	});
});
