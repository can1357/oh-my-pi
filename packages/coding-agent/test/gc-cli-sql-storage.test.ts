/**
 * `omp gc` while `session.storage: sql` keeps transcripts as database rows.
 * A phase may delete only what the configured storage proves dead: the files
 * on disk can veto a deletion, never authorize one. Phases that work only on
 * session files on disk refuse, and say so.
 */
import { SQL } from "bun";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { collectGcErrors, runGcCommand } from "@oh-my-pi/pi-coding-agent/cli/gc-cli";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { SqlSessionStorage } from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import {
	getBlobsDir,
	getCustomSessionFilesDir,
	getSessionsDir,
	getTerminalSessionsDir,
	hashPath,
} from "@oh-my-pi/pi-utils";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";

let root: string;
let client: SQL | undefined;
let storage: SqlSessionStorage;
let settingsState: SettingsTestState | undefined;
let stdoutSpy: { mockRestore(): void } | undefined;

beforeEach(async () => {
	settingsState = beginSettingsTest();
	delete process.env.OMP_SESSION_STORAGE;
	delete process.env.OMP_SESSION_SQL_DSN_FILE;
	root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gc-sql-"));
	stdoutSpy = spyOn(process.stdout, "write").mockImplementation(() => true);
	const url = `sqlite:${path.join(root, "sessions.db")}`;
	const dsnFile = path.join(root, "session.dsn");
	await Bun.write(dsnFile, url);
	await Bun.write(
		path.join(root, "config.yml"),
		["session:", "  storage: sql", "  sql:", `    dsnFile: ${dsnFile}`, ""].join("\n"),
	);
	client = new SQL(url);
	storage = await SqlSessionStorage.create({ client });
});

afterEach(async () => {
	stdoutSpy?.mockRestore();
	stdoutSpy = undefined;
	await client?.end();
	client = undefined;
	restoreSettingsTestState(settingsState);
	settingsState = undefined;
	AgentStorage.close();
	await fs.rm(root, { recursive: true, force: true });
});

function hashFor(label: string): string {
	return new Bun.SHA256().update(label).digest("hex");
}

function transcript(id: string, text: string): string {
	return `${[
		JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-10-01T00:00:00.000Z", cwd: root }),
		JSON.stringify({
			type: "message",
			id: "m1",
			parentId: null,
			timestamp: "2026-10-01T00:00:01.000Z",
			message: { role: "user", content: text, timestamp: 1 },
		}),
	].join("\n")}\n`;
}

async function agedBlob(label: string): Promise<string> {
	const blob = path.join(getBlobsDir(root), hashFor(label));
	await Bun.write(blob, label);
	const old = new Date(Date.now() - 86_400_000);
	await fs.utimes(blob, old, old);
	return blob;
}

async function agedFile(file: string, content: string): Promise<string> {
	await Bun.write(file, content);
	const old = new Date(Date.now() - 3 * 86_400_000);
	await fs.utimes(file, old, old);
	return file;
}

describe("omp gc --blobs under session.storage: sql", () => {
	const parent = () => path.join(getSessionsDir(root), "project", "2026-10-01_root.jsonl");
	// Each row is a transcript position the file scan cannot prove unreferenced.
	const placements: Array<[string, () => string]> = [
		["a subagent transcript", () => `${parent().slice(0, -6)}/Worker.jsonl`],
		["a grandchild transcript", () => `${parent().slice(0, -6)}/Worker/Worker.Helper.jsonl`],
		["a custom --session path outside the sessions root", () => path.join(root, "custom", "session.jsonl")],
	];

	for (const [where, key] of placements) {
		test(`--apply keeps a blob referenced only by ${where}`, async () => {
			const referenced = await agedBlob(`ref:${where}`);
			const orphan = await agedBlob(`orphan:${where}`);
			await storage.writeText(parent(), transcript("root", "no blob here"));
			await storage.writeText(key(), transcript("ref", `blob:sha256:${hashFor(`ref:${where}`)}`));

			const result = await runGcCommand({ flags: { agentDir: root, blobs: true, apply: true } });

			expect(await Bun.file(referenced).exists()).toBe(true);
			// The sweep still runs: the unreferenced blob goes.
			expect(await Bun.file(orphan).exists()).toBe(false);
			expect(result.blobs).toMatchObject({ referenced: 1, deleted: 1, errors: [] });
		});
	}

	test("--apply keeps a blob referenced by a SQL row whose path also names a stale local file", async () => {
		const referenced = await agedBlob("shadowed");
		const file = parent();
		await storage.writeText(file, transcript("root", `blob:sha256:${hashFor("shadowed")}`));
		// A copy left on disk from before the switch to sql, without the reference.
		await Bun.write(file, transcript("root", "stale local copy"));

		const result = await runGcCommand({ flags: { agentDir: root, blobs: true, apply: true } });

		expect(await Bun.file(referenced).exists()).toBe(true);
		expect(result.blobs).toMatchObject({ referenced: 1, deleted: 0 });
	});

	test("--apply keeps a blob referenced by a registered custom session that has no local file", async () => {
		const referenced = await agedBlob("registered");
		const file = path.join(root, "elsewhere", "registered.jsonl");
		await storage.writeText(file, transcript("custom", `blob:sha256:${hashFor("registered")}`));
		await Bun.write(path.join(getCustomSessionFilesDir(root), hashPath(file)), file);

		await runGcCommand({ flags: { agentDir: root, blobs: true, apply: true } });

		expect(await Bun.file(referenced).exists()).toBe(true);
	});
});

describe("omp gc --stale under session.storage: sql", () => {
	test("--apply keeps pointers to SQL rows and prunes pointers whose session is gone everywhere", async () => {
		const project = path.join(getSessionsDir(root), "project");
		const live = path.join(project, "live.jsonl");
		const gone = path.join(project, "gone.jsonl");
		await storage.writeText(live, transcript("live", "still here"));
		const markers = getCustomSessionFilesDir(root);
		const crumbs = getTerminalSessionsDir(root);
		const liveMarker = await agedFile(path.join(markers, "live"), live);
		const goneMarker = await agedFile(path.join(markers, "gone"), gone);
		const liveCrumb = await agedFile(path.join(crumbs, "tty-live"), `${project}\n${live}\n`);
		const goneCrumb = await agedFile(path.join(crumbs, "tty-gone"), `${project}\n${gone}\n`);

		const result = await runGcCommand({
			flags: { agentDir: root, stale: true, staleRetainNewest: 20, staleRetainDays: 30, apply: true },
		});

		expect(result.stale).toMatchObject({ danglingMarkers: 1, staleBreadcrumbs: 1, deleted: 2, errors: [] });
		expect(await Bun.file(liveMarker).exists()).toBe(true);
		expect(await Bun.file(liveCrumb).exists()).toBe(true);
		expect(await Bun.file(goneMarker).exists()).toBe(false);
		expect(await Bun.file(goneCrumb).exists()).toBe(false);
	});
});

describe("omp gc disk-only phases under session.storage: sql", () => {
	async function coldLocalSession(): Promise<{ file: string; bytes: Uint8Array }> {
		const file = path.join(getSessionsDir(root), "project", "cold.jsonl");
		await Bun.write(
			file,
			`${transcript("cold", "old")}${JSON.stringify({ type: "message", message: { role: "assistant", content: [] } })}\n`,
		);
		const old = new Date(Date.now() - 90 * 86_400_000);
		await fs.utimes(file, old, old);
		return { file, bytes: await Bun.file(file).bytes() };
	}

	for (const phase of ["archive", "compress"] as const) {
		test(`--${phase} --apply refuses, names the storage, and leaves session files alone`, async () => {
			const { file, bytes } = await coldLocalSession();

			const result = await runGcCommand({
				flags: {
					agentDir: root,
					...(phase === "archive" ? { archive: true } : { compress: true }),
					apply: true,
					coldArchiveAfterDays: 0,
					retainNewestGlobal: 0,
					retainNewestPerCwd: 0,
					compressAfterDays: 0,
				},
			});

			expect(result[phase]).toBeUndefined();
			expect(result.refused).toEqual([
				{ phase, requested: true, reason: expect.stringContaining("unavailable with session.storage: sql") },
			]);
			expect(collectGcErrors(result)).toEqual([
				expect.stringContaining(`${phase}: unavailable with session.storage: sql`),
			]);
			expect(await Bun.file(file).bytes()).toEqual(new Uint8Array(bytes));
			expect(await Bun.file(path.join(root, "archive")).exists()).toBe(false);
		});
	}

	test("an unqualified run reports the archive phase as not run without failing", async () => {
		const { file, bytes } = await coldLocalSession();

		const result = await runGcCommand({ flags: { agentDir: root, apply: true } });

		expect(result.refused).toEqual([{ phase: "archive", requested: false, reason: expect.any(String) }]);
		expect(collectGcErrors(result)).toEqual([]);
		expect(await Bun.file(file).bytes()).toEqual(new Uint8Array(bytes));
	});
});
