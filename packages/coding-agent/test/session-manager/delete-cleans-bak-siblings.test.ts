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
});
