import { describe, expect, it } from "bun:test";
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
 * or removes the file. The session must not keep appending to whatever is at
 * the path as if it were its journal: that leaves the entries the copy lacks
 * off disk for good and the next entry's parent missing, with nothing said.
 * It writes the whole journal back from memory and says which file changed.
 */
describe("a session whose transcript is replaced under it", () => {
	const userTurn = (content: string) => ({ role: "user" as const, content, timestamp: Date.now() });
	const userTurnsOf = (entries: readonly SessionEntry[]) =>
		entries.flatMap(entry =>
			entry.type === "message" && entry.message.role === "user" ? [entry.message.content] : [],
		);

	it.each([
		{
			change: "an older copy renamed over the path",
			apply: (sessionFile: string, older: string) => {
				const staged = `${sessionFile}.restore-staging`;
				fs.copyFileSync(older, staged);
				fs.renameSync(staged, sessionFile);
			},
			readBack: (sessionFile: string) => sessionFile,
			found: (older: string): number | null => fs.statSync(older).size,
		},
		{
			change: "a symlink to an older copy renamed over the path",
			apply: (sessionFile: string, older: string) => {
				const link = `${sessionFile}.link-staging`;
				fs.symlinkSync(older, link);
				fs.renameSync(link, sessionFile);
			},
			// The symlink stays; the journal lands in the file it points at.
			readBack: (_sessionFile: string, older: string) => older,
			found: (older: string): number | null => fs.statSync(older).size,
		},
		{
			change: "the file removed",
			apply: (sessionFile: string) => fs.unlinkSync(sessionFile),
			readBack: (sessionFile: string) => sessionFile,
			found: (): number | null => null,
		},
		{
			// An empty file holds nothing of anyone's: it is written over, not left for a sibling.
			change: "the file truncated to nothing",
			apply: (sessionFile: string) => fs.truncateSync(sessionFile, 0),
			readBack: (sessionFile: string) => sessionFile,
			found: (): number | null => 0,
		},
	])("writes the whole journal back and says so after $change", async ({ apply, readBack, found }) => {
		using tempDir = TempDir.createSync("@omp-session-replaced-under-");
		const manager = SessionManager.create(tempDir.path(), tempDir.path(), new FileSessionStorage());
		const notices: SessionPersistenceNotice[] = [];
		manager.onPersistenceNotice(notice => notices.push(notice));
		const failures: Error[] = [];
		manager.onPersistenceError(error => failures.push(error));
		try {
			await manager.ensureOnDisk();
			const sessionFile = manager.getSessionFile();
			if (!sessionFile) throw new Error("Expected a session file");
			manager.appendMessage(userTurn("turn in the older copy"));
			const older = path.join(tempDir.path(), "older-copy.jsonl");
			fs.copyFileSync(sessionFile, older);
			manager.appendMessage(userTurn("turn the older copy lacks"));
			const written = fs.statSync(sessionFile).size;
			const foundBytes = found(older);

			apply(sessionFile, older);
			manager.appendMessage(userTurn("first turn after the change"));
			manager.appendMessage(userTurn("second turn after the change"));

			const reopened = await SessionManager.open(
				readBack(sessionFile, older),
				tempDir.path(),
				new FileSessionStorage(),
				{
					suppressBreadcrumb: true,
				},
			);
			const onDisk = reopened.getEntries();
			expect(userTurnsOf(onDisk)).toEqual([
				"turn in the older copy",
				"turn the older copy lacks",
				"first turn after the change",
				"second turn after the change",
			]);
			const ids = new Set(onDisk.map(entry => entry.id));
			expect(onDisk.filter(entry => entry.parentId !== null && !ids.has(entry.parentId))).toEqual([]);
			expect(onDisk.map(entry => entry.id)).toEqual(manager.getEntries().map(entry => entry.id));
			expect(notices).toEqual([
				{ reason: "restored", from: sessionFile, to: sessionFile, expectedBytes: written, foundBytes },
			]);
			expect(failures).toEqual([]);
			expect(manager.getSessionFile()).toBe(sessionFile);
		} finally {
			await manager.close();
		}
	});
});
