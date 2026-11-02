/**
 * "Clear artifact cache" (debug menu) removes old tool artifacts and nothing
 * else: never a transcript, a subagent transcript, a transcript sidecar (kill
 * tombstone, backup, gc archive) or a session/project directory, whichever
 * storage holds the transcripts. It once removed every project directory whose
 * own mtime was old, transcripts included.
 */
import { SQL } from "bun";
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { clearArtifactCache, getArtifactCacheStats } from "@oh-my-pi/pi-coding-agent/debug/report-bundle";
import { FileSessionStorage, type SessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { SqlSessionStorage } from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import { TempDir } from "@oh-my-pi/pi-utils";

const DAY_MS = 24 * 60 * 60 * 1000;
const clients: SQL[] = [];
let tempDir: TempDir | undefined;

afterEach(async () => {
	for (const client of clients.splice(0)) await client.end();
	tempDir?.removeSync();
	tempDir = undefined;
});

function transcript(id: string): string {
	return `${JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-09-01T00:00:00.000Z", cwd: "/p" })}\n`;
}

/** Set the mtime of `target` and every path under it to `days` ago. */
async function age(target: string, days: number): Promise<void> {
	const when = new Date(Date.now() - days * DAY_MS);
	const stat = await fs.lstat(target);
	if (stat.isDirectory()) {
		for (const entry of await fs.readdir(target)) await age(path.join(target, entry), days);
	}
	await fs.utimes(target, when, when);
}

async function exists(file: string): Promise<boolean> {
	try {
		await fs.lstat(file);
		return true;
	} catch {
		return false;
	}
}

for (const kind of ["file", "sql"] as const) {
	describe(`clear artifact cache on ${kind} storage`, () => {
		test("removes only artifacts older than the cutoff from a 40-day-old project", async () => {
			tempDir = TempDir.createSync(`@omp-artifact-clear-${kind}-`);
			const sessionsDir = tempDir.join("sessions");
			const projectDir = path.join(sessionsDir, "--project--");
			const session = path.join(projectDir, "2026-09-01_root.jsonl");
			const artifactsDir = session.slice(0, -".jsonl".length);
			const child = path.join(artifactsDir, "Worker.jsonl");
			const grandchild = path.join(artifactsDir, "Worker", "Worker.Helper.jsonl");
			const tombstone = `${child}.tombstone`;
			const backup = `${session}.bak`;
			const archive = path.join(artifactsDir, "Worker", "Old.jsonl.gz");
			const rootLog = path.join(artifactsDir, "1.bash.log");
			const nestedLog = path.join(artifactsDir, "Worker", "2.read.log");
			const freshLog = path.join(artifactsDir, "3.bash.log");

			let storage: SessionStorage;
			if (kind === "file") {
				storage = new FileSessionStorage();
			} else {
				const client = new SQL(`sqlite:${tempDir.join("sessions.db")}`);
				clients.push(client);
				storage = await SqlSessionStorage.create({ client });
			}
			for (const [file, id] of [
				[session, "root"],
				[child, "worker"],
				[grandchild, "helper"],
			] as const) {
				await storage.writeText(file, transcript(id));
			}
			await storage.drain();
			await fs.mkdir(path.join(artifactsDir, "Worker"), { recursive: true });
			await Bun.write(tombstone, "");
			await Bun.write(backup, transcript("root"));
			await Bun.write(archive, "gz");
			await Bun.write(rootLog, "old tool output");
			await Bun.write(nestedLog, "old nested tool output");
			await age(sessionsDir, 40);
			await Bun.write(freshLog, "new tool output");

			const stats = await getArtifactCacheStats(sessionsDir, 30);
			const cleared = await clearArtifactCache(sessionsDir, 30);

			// Transcripts first: losing one is the data-loss failure this guards.
			for (const [file, id] of [
				[session, "root"],
				[child, "worker"],
				[grandchild, "helper"],
			] as const) {
				expect(await storage.readText(file)).toBe(transcript(id));
			}
			for (const kept of [tombstone, backup, archive, freshLog, artifactsDir, projectDir]) {
				expect(await exists(kept)).toBe(true);
			}
			expect(await exists(rootLog)).toBe(false);
			expect(await exists(nestedLog)).toBe(false);
			expect(stats.count).toBe(2);
			expect(cleared).toEqual({ removed: 2 });
		});

		test("removes the directories it emptied inside the artifacts tree, not the session directory", async () => {
			tempDir = TempDir.createSync(`@omp-artifact-clear-dirs-${kind}-`);
			const sessionsDir = tempDir.join("sessions");
			const artifactsDir = path.join(sessionsDir, "--project--", "2026-09-01_root");
			const nested = path.join(artifactsDir, "Worker", "deep");
			await Bun.write(path.join(nested, "1.bash.log"), "old");
			await age(sessionsDir, 40);

			expect(await clearArtifactCache(sessionsDir, 30)).toEqual({ removed: 1 });
			expect(await exists(path.join(artifactsDir, "Worker"))).toBe(false);
			expect(await exists(artifactsDir)).toBe(true);
		});
	});
}
