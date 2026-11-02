/**
 * A debug report bundles the current session's transcript and its subagents'
 * transcripts. Under `session.storage: sql` those transcripts are rows and the
 * session's artifacts directory holds only tool artifacts, so the bundle must
 * read the transcripts through the session storage and the artifacts from
 * disk.
 *
 * Clearing the artifact cache removes old tool artifacts only. Under
 * `session.storage: file` the project directories hold the transcripts
 * themselves, so the clear must never remove a transcript, a transcript
 * sidecar (tombstone, backup, staging file), or a whole session directory.
 */
import { SQL } from "bun";
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	clearArtifactCache,
	createReportBundle,
	getArtifactCacheStats,
} from "@oh-my-pi/pi-coding-agent/debug/report-bundle";
import {
	defaultSessionStorage,
	FileSessionStorage,
	type SessionStorage,
	setDefaultSessionStorage,
} from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { SqlSessionStorage } from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import { getConfigRootDir, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const originalXdgStateHome = process.env.XDG_STATE_HOME;
const fallbackAgentDir = path.join(getConfigRootDir(), "agent");
const previous = defaultSessionStorage();
const clients: SQL[] = [];
let cleanupRoot: string | undefined;

afterEach(async () => {
	setDefaultSessionStorage(previous);
	for (const client of clients.splice(0)) await client.end();
	if (originalXdgStateHome === undefined) delete process.env.XDG_STATE_HOME;
	else process.env.XDG_STATE_HOME = originalXdgStateHome;
	if (originalAgentDir) {
		setAgentDir(originalAgentDir);
	} else {
		setAgentDir(fallbackAgentDir);
		delete process.env.PI_CODING_AGENT_DIR;
	}
	if (cleanupRoot) {
		await removeWithRetries(cleanupRoot);
		cleanupRoot = undefined;
	}
});

const backends: Array<[string, () => Promise<SessionStorage>]> = [
	["file", async () => new FileSessionStorage()],
	["sql", openSql],
];

async function openSql(): Promise<SessionStorage> {
	const client = new SQL("sqlite::memory:");
	clients.push(client);
	return SqlSessionStorage.create({ client });
}

/** A temp root whose state dir receives the report archive. */
async function reportRoot(): Promise<string> {
	cleanupRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-report-storage-"));
	const xdgStateHome = path.join(cleanupRoot, "state");
	await fs.mkdir(path.join(xdgStateHome, "omp"), { recursive: true });
	process.env.XDG_STATE_HOME = xdgStateHome;
	setAgentDir(fallbackAgentDir);
	return cleanupRoot;
}

async function archiveTexts(archivePath: string): Promise<Map<string, string>> {
	const members = await new Bun.Archive(await Bun.file(archivePath).bytes()).files();
	const texts = new Map<string, string>();
	for (const [name, file] of members) texts.set(name, await file.text());
	return texts;
}

describe("debug report bundle over the session storage", () => {
	it.each(backends)("bundles the transcript tree the %s storage holds", async (_name, open) => {
		const root = await reportRoot();
		const storage = await open();
		setDefaultSessionStorage(storage);
		const projectDir = path.join(root, "sessions", "project");
		const sessionFile = path.join(projectDir, "2026-11-02T00-00-00_CURRENT.jsonl");
		const artifactsDir = sessionFile.slice(0, -6);
		await storage.writeText(sessionFile, '{"type":"session","id":"CURRENT"}\n');
		await storage.writeText(path.join(artifactsDir, "SubTask.jsonl"), '{"type":"session","id":"SubTask"}\n');
		await storage.writeText(
			path.join(artifactsDir, "SubTask", "SubTask.Nested.jsonl"),
			'{"type":"session","id":"Nested"}\n',
		);
		await Bun.write(path.join(artifactsDir, "1.bash.log"), "tool output");
		const otherSecret = `other-session-${crypto.randomUUID()}`;
		await storage.writeText(
			path.join(projectDir, "2026-11-01T00-00-00_OTHER.jsonl"),
			`{"secret":"${otherSecret}"}\n`,
		);

		const result = await createReportBundle({ sessionFile });
		const texts = await archiveTexts(result.path);
		await fs.rm(result.path, { force: true });

		expect(texts.get("session.jsonl")).toBe('{"type":"session","id":"CURRENT"}\n');
		expect(texts.get("artifacts/SubTask.jsonl")).toBe('{"type":"session","id":"SubTask"}\n');
		expect(texts.get("artifacts/SubTask/SubTask.Nested.jsonl")).toBe('{"type":"session","id":"Nested"}\n');
		expect(texts.get("artifacts/1.bash.log")).toBe("tool output");
		expect([...texts.values()].some(text => text.includes(otherSecret))).toBe(false);
	});

	it.each(backends)(
		"clears only old tool artifacts and keeps every transcript under the %s storage",
		async (_name, open) => {
			const root = await reportRoot();
			const storage = await open();
			setDefaultSessionStorage(storage);
			const sessionsDir = path.join(root, "sessions");
			const sessionFile = path.join(sessionsDir, "project", "2026-09-01T00-00-00_OLD.jsonl");
			const artifactsDir = sessionFile.slice(0, -6);
			const transcripts = new Map([
				[sessionFile, '{"type":"session","id":"OLD"}\n'],
				[path.join(artifactsDir, "Sub.jsonl"), '{"type":"session","id":"Sub"}\n'],
				[path.join(artifactsDir, "Sub", "Sub.Nested.jsonl"), '{"type":"session","id":"Nested"}\n'],
			]);
			for (const [file, content] of transcripts) await storage.writeText(file, content);
			// Transcript sidecars are local files in every mode.
			const sidecars = [
				path.join(artifactsDir, "Sub.jsonl.tombstone"),
				path.join(artifactsDir, "Sub.jsonl.bak"),
				path.join(artifactsDir, ".Sub.jsonl.0123456789abcdef.tmp"),
			];
			for (const sidecar of sidecars) await Bun.write(sidecar, "sidecar");
			const oldArtifacts = [
				path.join(artifactsDir, "1.bash.log"),
				path.join(artifactsDir, "Sub", "2.read.log"),
				path.join(artifactsDir, "gone", "3.bash.log"),
			];
			for (const artifact of oldArtifacts) await Bun.write(artifact, "old tool output");
			// Everything so far, directories included, was last touched 40 days ago.
			const fortyDaysAgo = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
			for (const entry of await fs.readdir(sessionsDir, { recursive: true })) {
				await fs.utimes(path.join(sessionsDir, entry), fortyDaysAgo, fortyDaysAgo);
			}
			const recentArtifact = path.join(artifactsDir, "4.edit.log");
			await Bun.write(recentArtifact, "recent tool output");

			const stats = await getArtifactCacheStats(sessionsDir, 30);
			expect(stats.count).toBe(oldArtifacts.length);
			expect(stats.totalSize).toBe(oldArtifacts.length * "old tool output".length);
			const removed = await clearArtifactCache(sessionsDir, 30);

			expect(removed).toEqual({ removed: oldArtifacts.length });
			for (const [file, content] of transcripts) expect(await storage.readText(file)).toBe(content);
			for (const sidecar of sidecars) expect(await Bun.file(sidecar).text()).toBe("sidecar");
			expect(await Bun.file(recentArtifact).text()).toBe("recent tool output");
			for (const artifact of oldArtifacts) expect(await Bun.file(artifact).exists()).toBe(false);
			// A directory the clear emptied goes too.
			const goneExists = await fs.stat(path.join(artifactsDir, "gone")).then(
				() => true,
				() => false,
			);
			expect(goneExists).toBe(false);
		},
	);
});
