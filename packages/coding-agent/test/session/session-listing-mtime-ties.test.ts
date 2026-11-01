import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	findMostRecentNonEmptySession,
	isEmptySession,
	listSessions,
} from "@oh-my-pi/pi-coding-agent/session/session-listing";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	FileSessionStorage,
	MemorySessionStorage,
	type SessionStorageStat,
} from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { getConfigRootDir, setAgentDir } from "@oh-my-pi/pi-utils";

const olderCreation = "2026-01-01T00:00:00.000Z";
const newerCreation = "2026-02-01T00:00:00.000Z";

class ObservedFileStorage extends FileSessionStorage {
	readonly scans: string[] = [];
	override readTextSlices(file: string, prefix: number, suffix: number): Promise<[string, string]> {
		this.scans.push(file);
		return super.readTextSlices(file, prefix, suffix);
	}
}

class ObservedMemoryStorage extends MemorySessionStorage {
	readonly scans: string[] = [];
	readonly mtimes = new Map<string, number>();
	override statSync(file: string): SessionStorageStat {
		const stat = super.statSync(file);
		const mtimeMs = this.mtimes.get(file) ?? stat.mtimeMs;
		return { ...stat, mtimeMs, mtime: new Date(mtimeMs) };
	}
	override readTextSlices(file: string, prefix: number, suffix: number): Promise<[string, string]> {
		this.scans.push(file);
		return super.readTextSlices(file, prefix, suffix);
	}
}

for (const backend of ["File", "Memory"] as const) {
	describe(`session listing mtime ties (${backend})`, () => {
		let root: string;
		let sessionDir: string;
		let storage: ObservedFileStorage | ObservedMemoryStorage;
		const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

		beforeEach(() => {
			root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-listing-mtime-ties-"));
			sessionDir = path.join(root, "sessions");
			setAgentDir(path.join(root, "agent"));
			storage = backend === "File" ? new ObservedFileStorage() : new ObservedMemoryStorage();
		});
		afterEach(() => {
			setAgentDir(originalAgentDir ?? path.join(getConfigRootDir(), "agent"));
			if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			fs.rmSync(root, { recursive: true, force: true });
		});

		async function write(name: string, created: string, mtimeMs: number, useful = true): Promise<string> {
			const file = path.join(sessionDir, `${name}.jsonl`);
			const records: unknown[] = [{ type: "session", version: 3, id: name, cwd: root, timestamp: created }];
			if (useful) {
				records.push({
					type: "message",
					id: `${name}-user`,
					parentId: null,
					timestamp: created,
					message: { role: "user", content: `Useful prompt for ${name}`, timestamp: 1 },
				});
			}
			await storage.writeText(file, `${records.map(record => JSON.stringify(record)).join("\n")}\n`);
			if (storage instanceof ObservedMemoryStorage) storage.mtimes.set(file, mtimeMs);
			else fs.utimesSync(file, new Date(mtimeMs), new Date(mtimeMs));
			return file;
		}

		it("--continue scans every winning-mtime candidate and uses creation time before path without reading older journals", async () => {
			const older = await write("older-journal", newerCreation, 1000);
			const firstByPath = await write("z-older-creation", olderCreation, 2000);
			const winner = await write("a-newer-creation", newerCreation, 2000);
			const tiedEmpty = await write("m-tied-empty", newerCreation, 2000, false);
			const newerEmpty = await write("newer-empty", newerCreation, 3000, false);

			expect(await findMostRecentNonEmptySession(sessionDir, storage)).toBe(winner);
			expect(storage.scans).toEqual([newerEmpty, firstByPath, tiedEmpty, winner]);
			expect(storage.scans).not.toContain(older);
			const listed = await listSessions(sessionDir, storage);
			expect(listed.find(session => !isEmptySession(session))?.path).toBe(winner);
			const continued = await SessionManager.continueRecent(root, sessionDir, storage);
			try {
				expect(continued.getSessionFile()).toBe(winner);
			} finally {
				await continued.close();
			}
		});

		it("--continue breaks equal creation times by descending path, independent of discovery order", async () => {
			const older = await write("older-journal", newerCreation, 1000);
			const firstDiscovered = await write("a-useful", newerCreation, 2000);
			const winner = await write("z-useful", newerCreation, 2000);
			const empty = await write("m-empty", newerCreation, 2000, false);

			expect(await findMostRecentNonEmptySession(sessionDir, storage)).toBe(winner);
			expect(storage.scans).toEqual([winner, empty, firstDiscovered]);
			expect(storage.scans).not.toContain(older);
			const listed = await listSessions(sessionDir, storage);
			expect(listed.find(session => !isEmptySession(session))?.path).toBe(winner);
		});

		it("recovers orphaned backups before choosing the tied cohort and leaves older journals unscanned", async () => {
			const older = await write("older-journal", newerCreation, 1000);
			const firstByPath = await write("z-older-creation", olderCreation, 2000);
			const recovered = await write("a-recovered", newerCreation, 2000);
			const backup = `${recovered}.12345.bak`;
			await storage.rename(recovered, backup);
			if (storage instanceof ObservedMemoryStorage) {
				storage.mtimes.delete(recovered);
				storage.mtimes.set(backup, 2000);
				storage.mtimes.set(recovered, 2000);
			}

			expect(await findMostRecentNonEmptySession(sessionDir, storage)).toBe(recovered);
			expect(storage.existsSync(recovered)).toBe(true);
			expect(storage.existsSync(backup)).toBe(false);
			expect(storage.scans).toEqual([firstByPath, recovered]);
			expect(storage.scans).not.toContain(older);
		});
	});
}
