import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, mock, onTestFinished, spyOn, test } from "bun:test";
import { randomBytes } from "node:crypto";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import {
	GC_AUTO_COMPRESS_INTERVAL_MS,
	GC_AUTO_COMPRESS_LOG,
	scheduleGcAutoCompress,
} from "@oh-my-pi/pi-coding-agent/cli/gc-auto-compress";
import { collectGcErrors, type GcResult, runGcCommand } from "@oh-my-pi/pi-coding-agent/cli/gc-cli";
import * as gcCompress from "@oh-my-pi/pi-coding-agent/cli/gc-compress";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { BlobStore, blobStagingPath } from "@oh-my-pi/pi-coding-agent/session/blob-store";
import * as libc from "@oh-my-pi/pi-coding-agent/session/libc";
import * as openFileHolders from "@oh-my-pi/pi-coding-agent/session/open-file-holders";
import * as regularFile from "@oh-my-pi/pi-coding-agent/session/regular-file";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { FileSessionStorage, sessionStagingPath } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import {
	getAgentDir,
	getBlobsDir,
	getCustomSessionFilesDir,
	getHistoryDbPath,
	getSessionsDir,
	getTerminalSessionsDir,
	hashPath,
	setAgentDir,
	setProjectDir,
} from "@oh-my-pi/pi-utils";
import { runCli } from "../src/cli";
import { leaveDeadGcLock } from "./helpers/gc-lock-fixture";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";
import { getXattr, setXattr } from "./helpers/xattr";

let root: string;
let writes: string[] = [];
let stderrWrites: string[] = [];
let settingsState: SettingsTestState | undefined;
const originalExitCode = process.exitCode;
// A session's lease is an abstract socket named by its id, and on Linux that
// name is shared by the whole machine; gc takes the lease of every session
// it archives or reclaims, subagent sessions included. Every session id
// these tests write starts with a part made fresh for each test, so another
// run of this file, or an earlier test still finishing in this one, does not
// hold the lease a test needs.
let testPrefix = "";
const sessionId = (name: string): string => `${testPrefix}-${name}`;

beforeEach(async () => {
	testPrefix = randomBytes(4).toString("hex");
	settingsState = beginSettingsTest();
	root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gc-"));
	writes = [];
	stderrWrites = [];
	process.exitCode = 0;
	spyOn(process.stdout, "write").mockImplementation(chunk => {
		writes.push(String(chunk));
		return true;
	});
	spyOn(process.stderr, "write").mockImplementation(chunk => {
		stderrWrites.push(String(chunk));
		return true;
	});
});

afterEach(async () => {
	// A test that times out is abandoned, not stopped, and restores its own
	// spies only when its body ends, inside the next test, whose `spyOn` on
	// the same function would take that spy over and recurse. Every spy goes
	// here, before the next test starts.
	mock.restore();
	process.exitCode = originalExitCode;
	restoreSettingsTestState(settingsState);
	settingsState = undefined;
	// gc and Settings.init open agent.db under root; Windows cannot delete an open file.
	AgentStorage.close();
	await fs.rm(root, { recursive: true, force: true });
});

function hashFor(label: string): string {
	return new Bun.SHA256().update(label).digest("hex");
}

/** A positional read, as gc calls it on a descriptor: into `buffer` at `offset`, `length` bytes from `position`. */
type PositionalRead = (
	buffer: Uint8Array,
	offset: number,
	length: number,
	position: number | null,
) => Promise<{ bytesRead: number; buffer: Uint8Array }>;

/**
 * Every descriptor gc opens on a path in `files` reads through what `wrap`
 * makes of its own read: gc reads a file only through a descriptor it has
 * checked, so that is where a test shapes what a read returns.
 */
function readsThrough(files: ReadonlySet<string>, wrap: (read: PositionalRead) => PositionalRead) {
	const realOpen = fs.open;
	return spyOn(fs, "open").mockImplementation((async (target: string, ...rest: unknown[]) => {
		const handle = await (realOpen as (...args: unknown[]) => Promise<fs.FileHandle>)(target, ...rest);
		if (files.has(String(target))) {
			const read = handle.read.bind(handle) as unknown as PositionalRead;
			handle.read = wrap(read) as unknown as typeof handle.read;
		}
		return handle;
	}) as typeof fs.open);
}

async function writeSession(
	agentDir: string,
	project: string,
	id: string,
	status: "complete" | "pending" | "interrupted",
	options: { blobRef?: string; ageDays?: number; filename?: string } = {},
): Promise<string> {
	const sessionDir = path.join(getSessionsDir(agentDir), project);
	await fs.mkdir(sessionDir, { recursive: true });
	const file = path.join(sessionDir, `${options.filename ?? id}.jsonl`);
	const lines = [
		JSON.stringify({
			type: "session",
			version: 3,
			id: sessionId(id),
			timestamp: "2026-01-01T00:00:00.000Z",
			cwd: "/tmp",
		}),
	];
	if (options.blobRef) {
		lines.push(JSON.stringify({ type: "message", message: { role: "user", content: options.blobRef } }));
	}
	if (status === "complete") {
		lines.push(JSON.stringify({ type: "message", message: { role: "assistant", content: [] } }));
	} else if (status === "pending") {
		lines.push(JSON.stringify({ type: "message", message: { role: "user", content: "waiting" } }));
	} else {
		lines.push(
			JSON.stringify({
				type: "message",
				message: { role: "assistant", content: [{ type: "toolCall", id: "tool-1" }] },
			}),
		);
	}
	await Bun.write(file, `${lines.join("\n")}\n`);
	if (options.ageDays !== undefined) {
		const ts = new Date(Date.now() - options.ageDays * 86_400_000);
		await fs.utimes(file, ts, ts);
	}
	return file;
}

async function writeBlob(agentDir: string, hash: string, content: string): Promise<string> {
	const file = path.join(getBlobsDir(agentDir), hash);
	await fs.mkdir(path.dirname(file), { recursive: true });
	await Bun.write(file, content);
	return file;
}

async function agePath(file: string, ageDays = 1): Promise<void> {
	const ts = new Date(Date.now() - ageDays * 86_400_000);
	await fs.utimes(file, ts, ts);
}

async function writeConfig(agentDir: string, body: string): Promise<void> {
	await fs.mkdir(agentDir, { recursive: true });
	await Bun.write(path.join(agentDir, "config.yml"), body);
}

async function writeProjectConfig(projectDir: string, body: string): Promise<void> {
	const configDir = path.join(projectDir, ".omp");
	await fs.mkdir(configDir, { recursive: true });
	await Bun.write(path.join(configDir, "config.yml"), body);
}

describe("runGcCommand blob sweep", () => {
	test("uses the active configured agent dir when --agent-dir is omitted", async () => {
		const originalAgentDir = getAgentDir();
		try {
			setAgentDir(root);
			await agePath(await writeBlob(root, hashFor("orphan"), "orphan"));

			const result = await runGcCommand({ flags: { blobs: true } });

			expect(result.agentDir).toBe(root);
			expect(result.blobs?.wouldDelete).toBe(1);
		} finally {
			setAgentDir(originalAgentDir);
		}
	});

	test("dry-run reports unreferenced blobs without deleting them", async () => {
		const hash = hashFor("orphan");
		const blob = await writeBlob(root, hash, "orphan");
		await agePath(blob);

		const result = await runGcCommand({ flags: { agentDir: root, blobs: true } });

		expect(result.blobs?.wouldDelete).toBe(1);
		expect(result.blobs?.deleted).toBe(0);
		expect(await Bun.file(blob).exists()).toBe(true);
	});

	test("--apply deletes unreferenced blobs and keeps referenced blobs", async () => {
		const orphanHash = hashFor("orphan");
		const referencedHash = hashFor("referenced");
		const orphan = await writeBlob(root, orphanHash, "orphan");
		const referenced = await writeBlob(root, referencedHash, "referenced");
		await agePath(orphan);
		await agePath(referenced);
		await writeSession(root, "project", "session-1", "complete", {
			blobRef: `blob:sha256:${referencedHash}`,
		});

		const result = await runGcCommand({ flags: { agentDir: root, blobs: true, apply: true } });

		expect(result.blobs?.wouldDelete).toBe(1);
		expect(result.blobs?.deleted).toBe(1);
		expect(await Bun.file(orphan).exists()).toBe(false);
		expect(await Bun.file(referenced).exists()).toBe(true);
	});

	test("--apply keeps fresh unreferenced blobs out of sweep candidates", async () => {
		const blob = await writeBlob(root, hashFor("fresh-orphan"), "fresh");

		const result = await runGcCommand({ flags: { agentDir: root, blobs: true, apply: true } });

		expect(result.blobs?.wouldDelete).toBe(0);
		expect(result.blobs?.deleted).toBe(0);
		expect(await Bun.file(blob).exists()).toBe(true);
	});

	test("--apply keeps a blob reused after the sweep scanned it as an old orphan", async () => {
		const data = "reused-after-scan";
		const blob = await writeBlob(root, hashFor(data), data);
		await agePath(blob);
		const store = new BlobStore(getBlobsDir(root));
		// A session reuses the blob (refreshing its mtime) after gc took its
		// candidate snapshot, right before gc first moves or removes it, and
		// before the new reference reaches a session file.
		let reused = false;
		const reuseBeforeRemoval = async (target: unknown) => {
			if (reused || String(target) !== blob) return;
			reused = true;
			await store.put(Buffer.from(data));
		};
		const rename = fs.rename.bind(fs);
		const unlink = fs.unlink.bind(fs);
		const renameSpy = spyOn(fs, "rename").mockImplementation(async (source, destination) => {
			await reuseBeforeRemoval(source);
			await rename(source, destination);
		});
		const unlinkSpy = spyOn(fs, "unlink").mockImplementation(async target => {
			await reuseBeforeRemoval(target);
			await unlink(target);
		});
		let result: GcResult;
		try {
			result = await runGcCommand({ flags: { agentDir: root, blobs: true, apply: true } });
		} finally {
			renameSpy.mockRestore();
			unlinkSpy.mockRestore();
		}

		expect(reused).toBe(true);
		expect(result.blobs?.deleted).toBe(0);
		expect(result.blobs?.wouldDelete).toBe(0);
		expect(await Bun.file(blob).text()).toBe(data);
	});

	test("--apply keeps a blob reused while the sweep is deleting it", async () => {
		const data = "reused-during-delete";
		const hash = hashFor(data);
		const blob = await writeBlob(root, hash, data);
		await agePath(blob);
		const store = new BlobStore(getBlobsDir(root));
		const unlink = fs.unlink.bind(fs);
		let reused = false;
		const unlinkSpy = spyOn(fs, "unlink").mockImplementation(async target => {
			if (!reused && path.basename(String(target)).includes(hash)) {
				reused = true;
				await store.put(Buffer.from(data));
			}
			await unlink(target);
		});
		try {
			await runGcCommand({ flags: { agentDir: root, blobs: true, apply: true } });
		} finally {
			unlinkSpy.mockRestore();
		}

		expect(reused).toBe(true);
		expect(await Bun.file(blob).text()).toBe(data);
	});

	test("--apply removes staging files abandoned by interrupted blob writes", async () => {
		const blobDir = getBlobsDir(root);
		await fs.mkdir(blobDir, { recursive: true });
		const abandoned = blobStagingPath(path.join(blobDir, `${hashFor("abandoned")}.png`));
		const inFlight = blobStagingPath(path.join(blobDir, hashFor("in-flight")));
		await Bun.write(abandoned, "partial");
		await agePath(abandoned);
		await Bun.write(inFlight, "partial");

		const result = await runGcCommand({ flags: { agentDir: root, blobs: true, apply: true } });

		expect(result.blobs?.deleted).toBe(1);
		expect(await Bun.file(abandoned).exists()).toBe(false);
		expect(await Bun.file(inFlight).exists()).toBe(true);
	});

	test("--apply scans recoverable session backups before deleting blobs", async () => {
		const referencedHash = hashFor("backup-reference");
		const referenced = await writeBlob(root, referencedHash, "referenced");
		await agePath(referenced);
		const sessionDir = path.join(getSessionsDir(root), "project");
		await fs.mkdir(sessionDir, { recursive: true });
		await Bun.write(
			path.join(sessionDir, "lost.jsonl.1234567890.bak"),
			[
				JSON.stringify({
					type: "session",
					version: 3,
					id: sessionId("lost"),
					timestamp: "2026-01-01T00:00:00.000Z",
				}),
				JSON.stringify({ type: "message", message: { role: "user", content: `blob:sha256:${referencedHash}` } }),
				"",
			].join("\n"),
		);

		const result = await runGcCommand({ flags: { agentDir: root, blobs: true, apply: true } });

		expect(result.blobs?.referenced).toBe(1);
		expect(result.blobs?.wouldDelete).toBe(0);
		expect(result.blobs?.deleted).toBe(0);
		expect(await Bun.file(referenced).exists()).toBe(true);
	});

	test("--apply resolves breadcrumbed relative session paths from their recorded cwd", async () => {
		const referencedHash = hashFor("custom-dir-reference");
		const orphanHash = hashFor("custom-dir-orphan");
		const referenced = await writeBlob(root, referencedHash, "referenced");
		const orphan = await writeBlob(root, orphanHash, "orphan");
		await agePath(referenced);
		await agePath(orphan);

		// A relative --session-dir transcript stored outside the managed roots.
		const projectDir = path.join(root, "project");
		const externalDir = path.join(projectDir, ".omp-sessions");
		await fs.mkdir(externalDir, { recursive: true });
		const externalFile = path.join(externalDir, "work.jsonl");
		await Bun.write(
			externalFile,
			[
				JSON.stringify({
					type: "session",
					version: 3,
					id: sessionId("work"),
					timestamp: "2026-01-01T00:00:00.000Z",
				}),
				JSON.stringify({ type: "message", message: { role: "user", content: `blob:sha256:${referencedHash}` } }),
				"",
			].join("\n"),
		);
		// GC runs from another cwd, so resolving the relative path from process.cwd()
		// would miss this transcript and delete its blob.
		const crumbDir = getTerminalSessionsDir(root);
		await fs.mkdir(crumbDir, { recursive: true });
		await Bun.write(path.join(crumbDir, "tty-1"), `${projectDir}\n.omp-sessions/work.jsonl\n`);

		const result = await runGcCommand({ flags: { agentDir: root, blobs: true, apply: true } });

		expect(result.blobs?.referenced).toBe(1);
		expect(result.blobs?.deleted).toBe(1);
		expect(await Bun.file(referenced).exists()).toBe(true);
		expect(await Bun.file(orphan).exists()).toBe(false);
	});

	test("--apply scans an exact extensionless session file after its breadcrumb is overwritten", async () => {
		const referencedHash = hashFor("registry-reference");
		const orphanHash = hashFor("registry-orphan");
		const referenced = await writeBlob(root, referencedHash, "referenced");
		const orphan = await writeBlob(root, orphanHash, "orphan");
		await agePath(referenced);
		await agePath(orphan);

		// An extensionless --session transcript whose terminal breadcrumb was
		// overwritten by a later session is invisible to the root-scan globs.
		const externalDir = path.join(root, "external-sessions");
		await fs.mkdir(externalDir, { recursive: true });
		const externalFile = path.join(externalDir, "work");
		await Bun.write(
			externalFile,
			[
				JSON.stringify({
					type: "session",
					version: 3,
					id: sessionId("work"),
					timestamp: "2026-01-01T00:00:00.000Z",
				}),
				JSON.stringify({ type: "message", message: { role: "user", content: `blob:sha256:${referencedHash}` } }),
				"",
			].join("\n"),
		);
		// Only the persistent registry records the exact file — no terminal breadcrumb exists.
		const registryDir = getCustomSessionFilesDir(root);
		await fs.mkdir(registryDir, { recursive: true });
		await Bun.write(path.join(registryDir, "session-1"), externalFile);

		const result = await runGcCommand({ flags: { agentDir: root, blobs: true, apply: true } });

		expect(result.blobs?.referenced).toBe(1);
		expect(result.blobs?.deleted).toBe(1);
		expect(await Bun.file(referenced).exists()).toBe(true);
		expect(await Bun.file(orphan).exists()).toBe(false);
	});

	test("--apply keeps a blob referenced only by a session under another agent dir's managed root", async () => {
		const referencedHash = hashFor("other-agent-dir-reference");
		const referenced = await writeBlob(root, referencedHash, "referenced");
		await agePath(referenced);
		const cwd = path.join(root, "project");
		await fs.mkdir(cwd, { recursive: true });
		const originalAgentDir = getAgentDir();
		setAgentDir(root);
		try {
			// An SDK manager rooted in another agent dir's sessions still writes its
			// blobs to this agent dir's store, whose gc never scans that root.
			const manager = SessionManager.create(
				cwd,
				SessionManager.getDefaultSessionDir(cwd, path.join(root, "other-agent")),
			);
			const sessionFile = manager.getSessionFile();
			await manager.close();
			if (!sessionFile) throw new Error("Expected a persisted session file");
			await Bun.write(
				sessionFile,
				[
					JSON.stringify({
						type: "session",
						version: 3,
						id: sessionId("other"),
						timestamp: "2026-01-01T00:00:00.000Z",
					}),
					JSON.stringify({ type: "message", message: { role: "user", content: `blob:sha256:${referencedHash}` } }),
					"",
				].join("\n"),
			);
			// The terminal has since moved on to another session.
			await fs.rm(getTerminalSessionsDir(root), { recursive: true, force: true });

			const result = await runGcCommand({ flags: { agentDir: root, blobs: true, apply: true } });

			expect(result.blobs?.referenced).toBe(1);
			expect(result.blobs?.deleted).toBe(0);
			expect(await Bun.file(referenced).exists()).toBe(true);
		} finally {
			setAgentDir(originalAgentDir);
		}
	});

	test("keeps raw blob references split across chunks in journals, archives, and backups", async () => {
		const sessionDir = path.join(getSessionsDir(root), "project");
		const archiveDir = path.join(root, "archive", "sessions", "project");
		const activeHash = hashFor("active-chunks");
		const archivedHash = hashFor("archived-chunks");
		const backupHash = hashFor("backup-chunks");
		const orphanHash = hashFor("not-a-reference");
		const active = await writeBlob(root, activeHash, "active");
		const archived = await writeBlob(root, archivedHash, "archived");
		const backup = await writeBlob(root, backupHash, "backup");
		const orphan = await writeBlob(root, orphanHash, "orphan");
		for (const file of [active, archived, backup, orphan]) await agePath(file);
		const encoder = new TextEncoder();
		const journals = new Map<string, Uint8Array<ArrayBuffer>>([
			[path.join(sessionDir, "active.jsonl"), encoder.encode(`malformed "blob:sha256:${activeHash}`)],
			[
				path.join(archiveDir, "archived.jsonl.gz"),
				gzipSync(`${" ".repeat(16 * 1024 - 20)}blob:sha256:${archivedHash}\ninvalid tail`),
			],
			[
				path.join(sessionDir, "lost.jsonl.1234567890.bak"),
				encoder.encode(`broken BLOB:SHA256:${backupHash.toUpperCase()}\r\nblob:sha256:${orphanHash}x`),
			],
		]);
		for (const [file, bytes] of journals) await Bun.write(file, bytes);
		// gc reads a journal through a descriptor it has checked holds a regular
		// file; each read through one of these hands back seven bytes at most,
		// so every reference is split across reads somewhere.
		let shaped = 0;
		const readSpy = readsThrough(new Set(journals.keys()), read => (buffer, offset, length, position) => {
			shaped += 1;
			return read(buffer, offset, Math.min(length, 7), position);
		});
		let result: GcResult;
		try {
			result = await runGcCommand({ flags: { agentDir: root, blobs: true, apply: true } });
		} finally {
			readSpy.mockRestore();
		}

		// Many short reads, not one per journal: the split really happened.
		expect(shaped).toBeGreaterThan(journals.size * 2);
		expect(result.blobs?.referenced).toBe(3);
		expect(result.blobs?.deleted).toBe(1);
		for (const file of [active, archived, backup]) expect(await Bun.file(file).exists()).toBe(true);
		expect(await Bun.file(orphan).exists()).toBe(false);
	});

	test("aborts blob deletion when a gzip archive fails after yielding valid references", async () => {
		const hash = hashFor("partial-archive-reference");
		const referenced = await writeBlob(root, hash, "referenced");
		const orphan = await writeBlob(root, hashFor("partial-archive-orphan"), "orphan");
		await agePath(referenced);
		await agePath(orphan);
		const archive = path.join(root, "archive", "sessions", "project", "broken.jsonl.gz");
		const bytes = gzipSync(`blob:sha256:${hash}\n${"{}\n".repeat(12 * 1024)}`);
		await Bun.write(archive, bytes.subarray(0, -4));

		await expect(runGcCommand({ flags: { agentDir: root, blobs: true, apply: true } })).rejects.toThrow();

		expect(await Bun.file(referenced).exists()).toBe(true);
		expect(await Bun.file(orphan).exists()).toBe(true);
		expect(await Bun.file(path.join(root, "gc.lock")).exists()).toBe(false);
	});

	// A reclaim moves the live transcript and its tree into the archive by
	// rename, under names that are not `*.jsonl.gz`; a turn the original
	// carries that its archived copy does not — written after the copy was
	// made — keeps its blobs there too.
	test("keeps blobs only a reclaimed transcript or a transcript in a reclaimed tree references", async () => {
		const session = await writeSession(root, "project", "reclaim-me", "complete", { ageDays: 90 });
		const child = path.join(session.slice(0, -".jsonl".length), "child.jsonl");
		const childLines = [
			{ type: "session", version: 3, id: sessionId("child"), timestamp: "2026-01-01T00:00:00.000Z", cwd: "/tmp" },
			{ type: "message", message: { role: "assistant", content: [] } },
		];
		await Bun.write(child, `${childLines.map(line => JSON.stringify(line)).join("\n")}\n`);
		await agePath(child, 90);
		await agePath(path.dirname(child), 90);
		const archived = await runGcCommand({
			flags: {
				agentDir: root,
				archive: true,
				apply: true,
				coldArchiveAfterDays: 0,
				retainNewestGlobal: 0,
				retainNewestPerCwd: 0,
			},
		});
		expect(archived.archive).toMatchObject({ archived: 1, errors: [] });
		const archiveFile = path.join(root, "archive", "sessions", "project", "reclaim-me.jsonl.gz");
		const reclaimed = await runGcCommand({
			flags: { agentDir: root, reclaim: archiveFile, apply: true, forwardOnly: true },
		});
		expect(reclaimed.reclaim).toMatchObject({ reclaimed: 1, errors: [] });
		const stem = path.join(root, "archive", "reclaimed", "project", "reclaim-me", "reclaim-me");
		const transcriptHash = hashFor("only-in-reclaimed-transcript");
		const childHash = hashFor("only-in-reclaimed-tree");
		const orphanHash = hashFor("referenced-nowhere");
		await fs.appendFile(`${stem}.jsonl`, `blob:sha256:${transcriptHash}\n`);
		await fs.appendFile(path.join(stem, "child.jsonl"), `blob:sha256:${childHash}\n`);
		const blobs = [
			await writeBlob(root, transcriptHash, "transcript"),
			await writeBlob(root, childHash, "child"),
			await writeBlob(root, orphanHash, "orphan"),
		];
		for (const blob of blobs) await agePath(blob);

		const result = await runGcCommand({ flags: { agentDir: root, blobs: true, apply: true } });

		expect(result.blobs?.errors).toEqual([]);
		expect(await Bun.file(blobs[0]).exists()).toBe(true);
		expect(await Bun.file(blobs[1]).exists()).toBe(true);
		expect(await Bun.file(blobs[2]).exists()).toBe(false);
	});

	test("aborts blob deletion when a journal read fails after a complete record", async () => {
		const orphan = await writeBlob(root, hashFor("read-error-orphan"), "orphan");
		await agePath(orphan);
		const session = await writeSession(root, "project", "read-error", "complete");
		// The first read hands back the whole journal; the next one fails.
		const readSpy = readsThrough(new Set([session]), read => {
			let reads = 0;
			return async (buffer, offset, length, position) => {
				reads += 1;
				if (reads > 1) throw Object.assign(new Error("journal read failed"), { code: "EIO" });
				return await read(buffer, offset, length, position);
			};
		});
		try {
			await expect(runGcCommand({ flags: { agentDir: root, blobs: true, apply: true } })).rejects.toThrow(
				"journal read failed",
			);
		} finally {
			readSpy.mockRestore();
		}

		expect(await Bun.file(orphan).exists()).toBe(true);
		expect(await Bun.file(path.join(root, "gc.lock")).exists()).toBe(false);
	});

	test("uses configured gc selectors and retention defaults", async () => {
		await agePath(await writeBlob(root, hashFor("orphan"), "orphan"));
		await writeSession(root, "project", "archive-me", "complete", { ageDays: 10 });
		await writeConfig(
			root,
			[
				"gc:",
				"  blobs: false",
				"  archive: true",
				"  wal: false",
				"  coldArchiveAfterDays: 7",
				"  retainNewestGlobal: 0",
				"  retainNewestPerCwd: 0",
				"",
			].join("\n"),
		);

		const result = await runGcCommand({ flags: { agentDir: root, apply: true, forwardOnly: true } });

		expect(result.blobs).toBeUndefined();
		expect(result.wal).toBeUndefined();
		expect(result.archive?.archived).toBe(1);
		expect(await Bun.file(path.join(root, "archive", "sessions", "project", "archive-me.jsonl.gz")).exists()).toBe(
			true,
		);
	});

	test("--apply loads gc config from each requested agent dir", async () => {
		const initializedAgentDir = path.join(root, "initialized-agent");
		const targetAgentDir = path.join(root, "target-agent");
		await writeConfig(
			initializedAgentDir,
			["gc:", "  blobs: false", "  archive: false", "  wal: false", ""].join("\n"),
		);
		await Settings.init({ agentDir: initializedAgentDir });
		await writeSession(targetAgentDir, "project", "archive-me", "complete", { ageDays: 10 });
		await writeConfig(
			targetAgentDir,
			[
				"gc:",
				"  blobs: false",
				"  archive: true",
				"  wal: false",
				"  coldArchiveAfterDays: 7",
				"  retainNewestGlobal: 0",
				"  retainNewestPerCwd: 0",
				"",
			].join("\n"),
		);

		const result = await runGcCommand({ flags: { agentDir: targetAgentDir, apply: true, forwardOnly: true } });

		expect(result.blobs).toBeUndefined();
		expect(result.wal).toBeUndefined();
		expect(result.archive?.archived).toBe(1);
		expect(
			await Bun.file(path.join(targetAgentDir, "archive", "sessions", "project", "archive-me.jsonl.gz")).exists(),
		).toBe(true);
	});

	test("invalid configured archive age falls back to schema default", async () => {
		const session = await writeSession(root, "project", "too-new", "complete", { ageDays: 1 });
		await writeConfig(
			root,
			[
				"gc:",
				"  blobs: false",
				"  archive: true",
				"  wal: false",
				"  coldArchiveAfterDays: nope",
				"  retainNewestGlobal: 0",
				"  retainNewestPerCwd: 0",
				"",
			].join("\n"),
		);

		const result = await runGcCommand({ flags: { agentDir: root, apply: true, forwardOnly: true } });

		expect(result.archive?.wouldArchive).toBe(0);
		expect(result.archive?.archived).toBe(0);
		expect(await Bun.file(session).exists()).toBe(true);
	});

	test("invalid configured retention counts fall back to schema defaults", async () => {
		const session = await writeSession(root, "project", "kept-by-default", "complete", { ageDays: 90 });
		await writeConfig(
			root,
			[
				"gc:",
				"  blobs: false",
				"  archive: true",
				"  wal: false",
				"  coldArchiveAfterDays: 0",
				"  retainNewestGlobal: nope",
				"  retainNewestPerCwd: nope",
				"",
			].join("\n"),
		);

		const result = await runGcCommand({ flags: { agentDir: root, apply: true, forwardOnly: true } });

		expect(result.archive?.keptNewestGlobal).toBe(1);
		expect(result.archive?.archived).toBe(0);
		expect(await Bun.file(session).exists()).toBe(true);
	});

	test("explicit selectors override disabled gc config", async () => {
		const blob = await writeBlob(root, hashFor("orphan"), "orphan");
		await agePath(blob);
		await writeConfig(root, ["gc:", "  blobs: false", "  archive: false", "  wal: false", ""].join("\n"));

		const result = await runGcCommand({ flags: { agentDir: root, blobs: true, apply: true } });

		expect(result.blobs?.deleted).toBe(1);
		expect(result.archive).toBeUndefined();
		expect(result.wal).toBeUndefined();
		expect(await Bun.file(blob).exists()).toBe(false);
	});

	test("dry-run reads gc config without initializing settings storage", async () => {
		await writeSession(root, "project", "archive-me", "complete", { ageDays: 10 });
		await writeConfig(
			root,
			[
				"gc:",
				"  blobs: false",
				"  archive: true",
				"  wal: false",
				"  coldArchiveAfterDays: 7",
				"  retainNewestGlobal: 0",
				"  retainNewestPerCwd: 0",
				"",
			].join("\n"),
		);

		const result = await runGcCommand({ flags: { agentDir: root } });

		expect(result.blobs).toBeUndefined();
		expect(result.archive?.wouldArchive).toBe(1);
		expect(result.archive?.archived).toBe(0);
		expect(result.wal).toBeUndefined();
		expect(await Bun.file(path.join(root, "agent.db")).exists()).toBe(false);
		expect(await Bun.file(path.join(root, "settings.json.bak")).exists()).toBe(false);
	});

	test("dry-run merges project gc settings like apply without initializing settings storage", async () => {
		const projectRoot = path.join(root, "project-root");
		await fs.mkdir(projectRoot, { recursive: true });
		setProjectDir(projectRoot);
		await writeSession(root, "project", "archive-me", "complete", { ageDays: 10 });
		await writeConfig(
			root,
			[
				"gc:",
				"  blobs: false",
				"  archive: false",
				"  wal: false",
				"  coldArchiveAfterDays: 30",
				"  retainNewestGlobal: 1",
				"  retainNewestPerCwd: 1",
				"",
			].join("\n"),
		);
		await writeProjectConfig(
			projectRoot,
			[
				"gc:",
				"  archive: true",
				"  coldArchiveAfterDays: 7",
				"  retainNewestGlobal: 0",
				"  retainNewestPerCwd: 0",
				"",
			].join("\n"),
		);

		const dryRun = await runGcCommand({ flags: { agentDir: root } });

		expect(dryRun.blobs).toBeUndefined();
		expect(dryRun.archive?.wouldArchive).toBe(1);
		expect(dryRun.archive?.archived).toBe(0);
		expect(dryRun.wal).toBeUndefined();
		expect(await Bun.file(path.join(root, "agent.db")).exists()).toBe(false);
		expect(await Bun.file(path.join(root, "settings.json.bak")).exists()).toBe(false);

		const applied = await runGcCommand({ flags: { agentDir: root, apply: true, forwardOnly: true } });

		expect(applied.archive?.archived).toBe(1);
	});

	// A writing settings load migrates a legacy agent directory on the way in:
	// it renames `settings.json` onto `settings.json.bak`, replacing a backup
	// already there, and creates `config.yml` and `agent.db`. A review lost a
	// backup's only copy to each of these runs: four exited 0, and the last
	// stopped at a lock it did not own, saying nothing was done.
	for (const [label, phases, lockHeld] of [
		["the configured phases", {}, false],
		["--archive", { archive: true }, false],
		["--stale", { stale: true }, false],
		["--compress", { compress: true }, false],
		["a lock somebody else holds", {}, true],
	] as const) {
		test(`--apply with ${label} reads a legacy settings.json and leaves it, and its backup, as they are`, async () => {
			const legacy = path.join(root, "settings.json");
			const backup = path.join(root, "settings.json.bak");
			// Every phase off, where the schema turns blobs and wal on: a run that
			// read nothing would sweep both.
			await Bun.write(legacy, JSON.stringify({ gc: { blobs: false, wal: false, stale: false, archive: false } }));
			await Bun.write(backup, "ONLY ORIGINAL BACKUP");
			const backupBefore = await fs.stat(backup);
			if (lockHeld) await Bun.write(path.join(root, "gc.lock"), "NOT A GC LOCK: KEEP MY FILE");

			const run = runGcCommand({ flags: { agentDir: root, apply: true, ...phases } });
			if (lockHeld) {
				await expect(run).rejects.toThrow("nothing was done");
			} else {
				const result = await run;
				expect(result.blobs).toBeUndefined();
				expect(result.wal).toBeUndefined();
			}

			expect(await Bun.file(backup).text()).toBe("ONLY ORIGINAL BACKUP");
			expect((await fs.stat(backup)).ino).toBe(backupBefore.ino);
			expect(await Bun.file(legacy).exists()).toBe(true);
			expect(await Bun.file(path.join(root, "config.yml")).exists()).toBe(false);
			expect(await Bun.file(path.join(root, "agent.db")).exists()).toBe(false);
		});
	}
});

describe("runGcCommand history checkpoint", () => {
	test("dry-run reports WAL checkpoint without truncating it", async () => {
		const dbPath = getHistoryDbPath(root);
		await fs.mkdir(path.dirname(dbPath), { recursive: true });
		const db = new Database(dbPath);
		db.run("PRAGMA journal_mode=WAL");
		db.run("CREATE TABLE history (id INTEGER PRIMARY KEY, prompt TEXT)");
		db.run("INSERT INTO history (prompt) VALUES ('hello')");
		const walPath = `${dbPath}-wal`;
		const walBytes = (await fs.stat(walPath)).size;

		const result = await runGcCommand({ flags: { agentDir: root, wal: true } });
		const afterBytes = (await fs.stat(walPath)).size;
		db.close();

		expect(result.wal?.wouldCheckpoint).toBe(true);
		expect(result.wal?.checkpointed).toBe(false);
		expect(result.wal?.walBytes).toBeGreaterThan(0);
		expect(afterBytes).toBe(walBytes);
	});

	test("--apply checkpoints history WAL", async () => {
		const dbPath = getHistoryDbPath(root);
		await fs.mkdir(path.dirname(dbPath), { recursive: true });
		const db = new Database(dbPath);
		db.run("PRAGMA journal_mode=WAL");
		db.run("CREATE TABLE history (id INTEGER PRIMARY KEY, prompt TEXT)");
		db.run("INSERT INTO history (prompt) VALUES ('hello')");
		db.close();

		const result = await runGcCommand({ flags: { agentDir: root, wal: true, apply: true } });

		expect(result.wal?.checkpointed).toBe(true);
		expect(result.wal?.walBytes).toBe(0);
		// gc holds the last connection, so closing it after the TRUNCATE checkpoint deletes the WAL.
		// Bun on macOS uses Apple's system SQLite, which persists the (truncated) WAL file instead.
		if (process.platform === "darwin") {
			expect((await fs.stat(`${dbPath}-wal`)).size).toBe(0);
		} else {
			expect(await Bun.file(`${dbPath}-wal`).exists()).toBe(false);
		}
	});

	test("--apply propagates WAL checkpoint failures and releases the gc lock", async () => {
		// A regular file SQLite opens and then fails on: the failure is its own,
		// past gc's look at the name.
		const dbPath = getHistoryDbPath(root);
		await fs.mkdir(path.dirname(dbPath), { recursive: true });
		await Bun.write(dbPath, "NOT A DATABASE, ".repeat(64));

		await expect(runGcCommand({ flags: { agentDir: root, wal: true, apply: true } })).rejects.toThrow(
			"file is not a database",
		);

		expect(await Bun.file(path.join(root, "gc.lock")).exists()).toBe(false);
	});

	test("--apply refuses a history database that is not a regular file, and releases the gc lock", async () => {
		// What SQLite used to be handed and fail on with "unable to open
		// database file" is now refused before it opens anything, by name.
		const dbPath = getHistoryDbPath(root);
		await fs.mkdir(dbPath, { recursive: true });

		await expect(runGcCommand({ flags: { agentDir: root, wal: true, apply: true } })).rejects.toThrow(
			`${dbPath} is a directory, not a regular file, so it was not read`,
		);

		expect(await Bun.file(path.join(root, "gc.lock")).exists()).toBe(false);
	});

	test("--apply reports busy WAL checkpoints and releases the gc lock", async () => {
		const dbPath = getHistoryDbPath(root);
		await fs.mkdir(path.dirname(dbPath), { recursive: true });
		const writer = new Database(dbPath);
		const reader = new Database(dbPath);
		try {
			writer.run("PRAGMA journal_mode=WAL");
			writer.run("CREATE TABLE history (id INTEGER PRIMARY KEY, prompt TEXT)");
			writer.run("INSERT INTO history (prompt) VALUES ('before-reader')");
			reader.run("PRAGMA journal_mode=WAL");
			reader.run("BEGIN");
			reader.query("SELECT * FROM history").all();
			writer.run("INSERT INTO history (prompt) VALUES ('after-reader')");

			await expect(runGcCommand({ flags: { agentDir: root, wal: true, apply: true } })).rejects.toThrow(
				`WAL checkpoint failed for ${dbPath}: busy=1`,
			);

			expect(await Bun.file(path.join(root, "gc.lock")).exists()).toBe(false);
		} finally {
			try {
				reader.run("COMMIT");
			} catch {}
			reader.close();
			writer.close();
		}
	}, 10_000);
});

describe("runGcCommand session staging", () => {
	test("leaves every staging-shaped file in the sessions tree alone, aged or not", async () => {
		const live = await writeSession(root, "project", "live", "pending");
		const abandoned = sessionStagingPath(live);
		const inFlight = sessionStagingPath(live);
		// Subagent transcripts nest inside the parent's artifacts directory.
		const nestedAbandoned = sessionStagingPath(path.join(live.slice(0, -".jsonl".length), "0-sub.jsonl"));
		// An extensionless `--session` transcript outside the sessions tree, known only to the registry.
		const externalDir = path.join(root, "external-sessions");
		const externalFile = path.join(externalDir, "work");
		await Bun.write(externalFile, "{}\n");
		await Bun.write(path.join(getCustomSessionFilesDir(root), "session-1"), externalFile);
		const externalAbandoned = sessionStagingPath(externalFile);
		const unrelated = path.join(externalDir, ".notes.0123456789abcdef.tmp");
		// Names a killed session writer could have left, and names anybody
		// could have chosen — with its only bytes inside. Nothing records
		// which, so none of them is the archive phase's to delete.
		for (const file of [abandoned, nestedAbandoned, externalAbandoned, unrelated]) {
			await Bun.write(file, "ONLY COPY");
			await agePath(file);
		}
		await Bun.write(inFlight, "ONLY COPY");

		const applied = await runGcCommand({ flags: { agentDir: root, archive: true, forwardOnly: true, apply: true } });

		expect(applied.archive?.errors).toEqual([]);
		for (const kept of [live, abandoned, nestedAbandoned, externalAbandoned, unrelated, inFlight, externalFile]) {
			expect(await Bun.file(kept).exists()).toBe(true);
		}
	});

	test("leaves staging-shaped files in the archive alone when no run recorded staging them", async () => {
		const archiveSessions = path.join(root, "archive", "sessions", "project");
		await fs.mkdir(archiveSessions, { recursive: true });
		// Names a killed writer could have left, and names anybody could have
		// chosen. Nothing records which, and the archive may hold the only
		// copy of what is in them, so none of them is the archive phase's to
		// delete.
		const legacyShape = path.join(archiveSessions, "killed.jsonl.gz.4242.1700000000000.tmp");
		const linkedTarget = path.join(root, "elsewhere", "linked-project");
		await fs.mkdir(linkedTarget, { recursive: true });
		await fs.symlink(linkedTarget, path.join(root, "archive", "sessions", "linked-project"));
		const stagingShape = sessionStagingPath(path.join(linkedTarget, "killed-too.jsonl.gz"));
		const humanNote = path.join(archiveSessions, ".human-note.0123456789abcdef.tmp");
		for (const file of [legacyShape, stagingShape, humanNote]) {
			await Bun.write(file, "UNIQUE BYTES");
			await agePath(file);
		}
		const cold = await writeSession(root, "project", "cold", "complete", { ageDays: 90 });

		const result = await runGcCommand({
			flags: {
				agentDir: root,
				archive: true,
				forwardOnly: true,
				coldArchiveAfterDays: 30,
				retainNewestGlobal: 0,
				retainNewestPerCwd: 0,
				apply: true,
			},
		});

		expect(result.archive).toMatchObject({ archived: 1, errors: [] });
		for (const file of [legacyShape, stagingShape, humanNote])
			expect(await Bun.file(file).text()).toBe("UNIQUE BYTES");
		// The same run staged and published its own archive through that directory.
		expect(await Bun.file(path.join(archiveSessions, "cold.jsonl.gz")).exists()).toBe(true);
		// Archiving copies and keeps the live copy; `--reclaim` gives it up.
		expect(await Bun.file(cold).exists()).toBe(true);
	});
});

describe("runGcCommand cold-session archive", () => {
	test("archives old completed sessions while honoring keep-count and active-status skips", async () => {
		const archiveMe = await writeSession(root, "project", "archive-me", "complete", { ageDays: 90 });
		// 60d keeps keep-recent cold-eligible (>30d cutoff) yet unambiguously newer than
		// archive-me's 90d, so retainNewestGlobal:1 deterministically protects it regardless
		// of readdir order when two sessions would otherwise share an mtime millisecond.
		const keepRecent = await writeSession(root, "project", "keep-recent", "complete", { ageDays: 60 });
		const pending = await writeSession(root, "project", "pending", "pending", { ageDays: 90 });
		const interrupted = await writeSession(root, "project", "interrupted", "interrupted", { ageDays: 90 });
		await fs.mkdir(archiveMe.slice(0, -".jsonl".length), { recursive: true });
		await Bun.write(path.join(archiveMe.slice(0, -".jsonl".length), "0.bash.log"), "artifact");
		const original = await Bun.file(archiveMe).bytes();

		const result = await runGcCommand({
			flags: {
				agentDir: root,
				archive: true,
				forwardOnly: true,
				coldArchiveAfterDays: 30,
				retainNewestGlobal: 1,
				retainNewestPerCwd: 0,
				apply: true,
			},
		});
		const archived = path.join(root, "archive", "sessions", "project", "archive-me.jsonl.gz");

		expect(result.archive?.archived).toBe(1);
		expect(result.archive?.skippedActive).toBe(2);
		expect(await Bun.file(archiveMe).exists()).toBe(true);
		expect(await Bun.file(archived).exists()).toBe(true);
		expect(new Uint8Array(gunzipSync(await Bun.file(archived).bytes()))).toEqual(original);
		expect(await Bun.file(path.join(archived.slice(0, -".jsonl.gz".length), "0.bash.log")).exists()).toBe(true);
		expect(await Bun.file(keepRecent).exists()).toBe(true);
		expect(await Bun.file(pending).exists()).toBe(true);
		expect(await Bun.file(interrupted).exists()).toBe(true);
	});

	test("keeps the source journal when compression encounters a read error", async () => {
		const session = await writeSession(root, "project", "compression-error", "complete", { ageDays: 90 });
		const original = await Bun.file(session).bytes();
		const archiveDir = path.join(root, "archive", "sessions", "project");
		// The archive reads the transcript through one descriptor; the failure
		// comes from that descriptor, past the first chunk.
		const realOpen = fs.open;
		const openSpy = spyOn(fs, "open").mockImplementation((async (target: string, ...rest: unknown[]) => {
			const handle = await (realOpen as (...args: unknown[]) => Promise<fs.FileHandle>)(target, ...rest);
			if (String(target) === session) {
				const read = handle.read.bind(handle) as (...args: unknown[]) => Promise<unknown>;
				handle.read = (async (...args: unknown[]) => {
					if (typeof args[3] === "number" && args[3] > 0) throw new Error("compression read failed");
					return await read(...args);
				}) as typeof handle.read;
			}
			return handle;
		}) as typeof fs.open);
		let result: GcResult;
		try {
			result = await runGcCommand({
				flags: {
					agentDir: root,
					archive: true,
					forwardOnly: true,
					apply: true,
					coldArchiveAfterDays: 0,
					retainNewestGlobal: 0,
					retainNewestPerCwd: 0,
				},
			});
		} finally {
			openSpy.mockRestore();
		}

		expect(result.archive?.archived).toBe(0);
		expect(result.archive?.errors).toEqual([`${session}: compression read failed`]);
		expect(await Bun.file(session).bytes()).toEqual(original);
		expect(await fs.readdir(archiveDir)).toEqual([]);
		expect(await Bun.file(path.join(root, "gc.lock")).exists()).toBe(false);
	});

	test("keeps the live session whole when copying its artifacts fails", async () => {
		const session = await writeSession(root, "project", "rollback", "complete");
		const header = JSON.stringify({
			type: "session",
			version: 3,
			id: sessionId("rollback"),
			timestamp: "2026-01-01T00:00:00.000Z",
			cwd: "/tmp",
		});
		const message = JSON.stringify({
			type: "message",
			message: { role: "assistant", content: [{ type: "text", text: "界".repeat(8 * 1024) }] },
		});
		const original = new TextEncoder().encode(`${header}\r\n${message}`);
		await Bun.write(session, original);
		await agePath(session, 90);
		const artifacts = session.slice(0, -".jsonl".length);
		await Bun.write(path.join(artifacts, "0.bash.log"), "retained artifact");
		const archiveDir = path.join(root, "archive", "sessions", "project");
		const realOpen = fs.open;
		const cpSpy = spyOn(fs, "open").mockImplementation((async (target: string, ...rest: unknown[]) => {
			const handle = await (realOpen as (...args: unknown[]) => Promise<fs.FileHandle>)(target, ...rest);
			if (!String(target).includes(".tmp/") || !String(target).includes("0.bash.log")) return handle;
			handle.write = (async () => {
				throw new Error("artifact move failed");
			}) as typeof handle.write;
			return handle;
		}) as typeof fs.open);
		let result: GcResult;
		try {
			result = await runGcCommand({
				flags: {
					agentDir: root,
					archive: true,
					forwardOnly: true,
					apply: true,
					coldArchiveAfterDays: 0,
					retainNewestGlobal: 0,
					retainNewestPerCwd: 0,
				},
			});
		} finally {
			cpSpy.mockRestore();
		}

		const archivedTree = path.join(archiveDir, "rollback");
		expect(result.archive?.archived).toBe(0);
		expect(result.archive?.errors).toEqual([
			`${session}: artifact move failed; the directory this run made in the archive was left, emptied of what it put there: ${archivedTree}`,
		]);
		// Nothing is given up by archiving, so a failure part-way leaves the
		// live session exactly as it was and a partial archive beside it for a
		// later run to supersede: the transcript, and the directory it made for
		// the tree, empty — no look after a `mkdir` tells the directory it made
		// from one put at its name, so it removes neither.
		expect(await Bun.file(session).bytes()).toEqual(original);
		expect(await Bun.file(path.join(artifacts, "0.bash.log")).text()).toBe("retained artifact");
		expect((await fs.readdir(archiveDir)).sort()).toEqual(["rollback", "rollback.jsonl.gz"]);
		expect(await fs.readdir(archivedTree)).toEqual([]);
		expect((await fs.readdir(path.dirname(session))).sort()).toEqual(["rollback", "rollback.jsonl"]);
	});

	test("skips archiving parent sessions with live nested sessions", async () => {
		const parent = await writeSession(root, "project", "parent", "complete", { ageDays: 90 });
		const artifactsDir = parent.slice(0, -".jsonl".length);
		const nested = path.join(artifactsDir, "Tan-nested.jsonl");
		await fs.mkdir(artifactsDir, { recursive: true });
		await Bun.write(
			nested,
			[
				JSON.stringify({
					type: "session",
					version: 3,
					id: sessionId("Tan-nested"),
					timestamp: "2026-01-01T00:00:00.000Z",
				}),
				JSON.stringify({ type: "message", message: { role: "user", content: "waiting" } }),
				"",
			].join("\n"),
		);
		await agePath(nested, 90);

		const result = await runGcCommand({
			flags: {
				agentDir: root,
				archive: true,
				forwardOnly: true,
				coldArchiveAfterDays: 30,
				retainNewestGlobal: 0,
				retainNewestPerCwd: 0,
				apply: true,
			},
		});

		expect(result.archive?.skippedActive).toBe(1);
		expect(result.archive?.archived).toBe(0);
		expect(await Bun.file(parent).exists()).toBe(true);
		expect(await Bun.file(nested).exists()).toBe(true);
		expect(await Bun.file(path.join(root, "archive", "sessions", "project", "parent.jsonl.gz")).exists()).toBe(false);
	});

	test("keeps every prompt-history, title and stats row for a session it only archived", async () => {
		const session = await writeSession(root, "project", "archive-me", "complete", { ageDays: 90 });
		const historyDbPath = getHistoryDbPath(root);
		await fs.mkdir(path.dirname(historyDbPath), { recursive: true });
		const history = new Database(historyDbPath);
		history.run("CREATE TABLE history (id INTEGER PRIMARY KEY AUTOINCREMENT, prompt TEXT NOT NULL, session_id TEXT)");
		history.run("CREATE VIRTUAL TABLE history_fts USING fts5(prompt, content='history', content_rowid='id')");
		history.run("INSERT INTO history (prompt, session_id) VALUES ('archived prompt', 'archive-me')");
		history.run("INSERT INTO history_fts(history_fts) VALUES('rebuild')");
		history.run("CREATE TABLE session_titles (session_id TEXT PRIMARY KEY, title TEXT NOT NULL)");
		history.run("INSERT INTO session_titles (session_id, title) VALUES ('archive-me', 'archived title')");
		history.close();
		const statsDbPath = path.join(root, "stats.db");
		const statsTables = ["messages", "user_messages", "tool_calls", "file_offsets"] as const;
		const stats = new Database(statsDbPath);
		for (const table of statsTables) {
			stats.run(`CREATE TABLE ${table} (session_file TEXT NOT NULL)`);
			stats.query(`INSERT INTO ${table} (session_file) VALUES (?)`).run(session);
		}
		stats.close();

		const result = await runGcCommand({
			flags: {
				agentDir: root,
				archive: true,
				forwardOnly: true,
				coldArchiveAfterDays: 30,
				retainNewestGlobal: 0,
				retainNewestPerCwd: 0,
				apply: true,
			},
		});

		const historyCheck = new Database(historyDbPath);
		const historyRows = historyCheck.query("SELECT session_id FROM history").all();
		const ftsRows = historyCheck
			.query("SELECT h.session_id FROM history_fts f JOIN history h ON h.id = f.rowid")
			.all();
		const titleRows = historyCheck.query("SELECT session_id FROM session_titles").all();
		historyCheck.close();
		const statsCheck = new Database(statsDbPath);
		const statsRows = Object.fromEntries(
			statsTables.map(table => [table, statsCheck.query(`SELECT session_file FROM ${table}`).all()]),
		);
		statsCheck.close();

		expect(result.archive?.archived).toBe(1);
		expect(result.archive?.errors).toEqual([]);
		expect(await Bun.file(session).exists()).toBe(true);
		expect(await Bun.file(path.join(root, "archive", "sessions", "project", "archive-me.jsonl.gz")).exists()).toBe(
			true,
		);
		expect(historyRows).toEqual([{ session_id: "archive-me" }]);
		expect(ftsRows).toEqual([{ session_id: "archive-me" }]);
		expect(titleRows).toEqual([{ session_id: "archive-me" }]);
		expect(statsRows).toEqual(Object.fromEntries(statsTables.map(table => [table, [{ session_file: session }]])));
	});

	test("CLI returns nonzero status when apply records GC errors", async () => {
		const session = await writeSession(root, "project", "archive-me", "complete", { ageDays: 90 });
		const artifacts = session.slice(0, -".jsonl".length);
		await Bun.write(path.join(artifacts, "0.bash.log"), "artifact");
		const realOpen = fs.open;
		const cpSpy = spyOn(fs, "open").mockImplementation((async (target: string, ...rest: unknown[]) => {
			const handle = await (realOpen as (...args: unknown[]) => Promise<fs.FileHandle>)(target, ...rest);
			if (!String(target).includes(".tmp/")) return handle;
			handle.write = (async () => {
				throw new Error("artifact move failed");
			}) as typeof handle.write;
			return handle;
		}) as typeof fs.open);
		try {
			await runCli([
				"gc",
				"--agent-dir",
				root,
				"--archive",
				"--forward-only",
				"--cold-archive-after-days",
				"30",
				"--retain-newest-global",
				"0",
				"--retain-newest-per-cwd",
				"0",
				"--apply",
			]);
		} finally {
			cpSpy.mockRestore();
		}

		const stderr = stderrWrites.join("");
		expect(process.exitCode).toBe(1);
		expect(stderr).toContain("GC completed with 1 error:");
		expect(stderr).toContain(`archive: ${session}: artifact move failed`);
	});
	test("CLI parses --reclaim, gates it behind --forward-only and refuses to mix it with a phase", async () => {
		const session = await writeSession(root, "project", "archive-me", "complete", { ageDays: 90 });
		const archived = path.join(root, "archive", "sessions", "project", "archive-me.jsonl.gz");
		await runCli([
			"gc",
			"--agent-dir",
			root,
			"--archive",
			"--cold-archive-after-days",
			"30",
			"--retain-newest-global",
			"0",
			"--retain-newest-per-cwd",
			"0",
			"--apply",
		]);
		expect(await Bun.file(archived).exists()).toBe(true);
		expect(await Bun.file(session).exists()).toBe(true);

		// Named but unacknowledged: the one-way flag belongs to the step that
		// gives the live copy up, and nothing is given up without it. The gate
		// runs in `resolveOptions`, before the gc lock, so it refuses the run
		// rather than reporting an error from inside one.
		await expect(runCli(["gc", "--agent-dir", root, "--reclaim", "archive-me", "--apply"])).rejects.toThrow(
			"--forward-only",
		);
		expect(await Bun.file(session).exists()).toBe(true);

		await expect(
			runCli(["gc", "--agent-dir", root, "--reclaim", "archive-me", "--blobs", "--apply", "--forward-only"]),
		).rejects.toThrow("--reclaim runs alone");
		expect(await Bun.file(session).exists()).toBe(true);

		stderrWrites.length = 0;
		process.exitCode = 0;
		await runCli(["gc", "--agent-dir", root, "--reclaim", "archive-me", "--apply", "--forward-only"]);
		expect(stderrWrites.join("")).toBe("");
		expect(await Bun.file(session).exists()).toBe(false);
		expect(await Bun.file(archived).exists()).toBe(true);
	});

	test("does not archive fresh completed sessions that may still be live", async () => {
		const session = await writeSession(root, "project", "fresh-complete", "complete");

		const result = await runGcCommand({
			flags: {
				agentDir: root,
				archive: true,
				forwardOnly: true,
				coldArchiveAfterDays: 0,
				retainNewestGlobal: 0,
				retainNewestPerCwd: 0,
				apply: true,
			},
		});

		expect(result.archive?.archived).toBe(0);
		expect(result.archive?.skippedActive).toBe(1);
		expect(await Bun.file(session).exists()).toBe(true);
	});

	test("dry-run does not recover orphaned session backups", async () => {
		const sessionDir = path.join(getSessionsDir(root), "project");
		await fs.mkdir(sessionDir, { recursive: true });
		const primary = path.join(sessionDir, "lost.jsonl");
		const backup = path.join(sessionDir, "lost.jsonl.1234567890.bak");
		await Bun.write(
			backup,
			`${JSON.stringify({ type: "session", version: 3, id: sessionId("lost"), timestamp: "2026-01-01T00:00:00.000Z" })}\n`,
		);

		const result = await runGcCommand({ flags: { agentDir: root, archive: true } });

		expect(result.archive?.scanned).toBe(0);
		expect(await Bun.file(backup).exists()).toBe(true);
		expect(await Bun.file(primary).exists()).toBe(false);
	});

	test("sweeps blobs only after scanning references in compressed archived sessions", async () => {
		const referencedHash = hashFor("archived-reference");
		const referenced = await writeBlob(root, referencedHash, "referenced");
		await writeBlob(root, hashFor("orphan"), "orphan");
		await agePath(path.join(getBlobsDir(root), hashFor("orphan")));
		await writeSession(root, "project", "archive-me", "complete", {
			ageDays: 90,
			blobRef: `blob:sha256:${referencedHash}`,
		});

		await runGcCommand({
			flags: {
				agentDir: root,
				archive: true,
				forwardOnly: true,
				coldArchiveAfterDays: 30,
				retainNewestGlobal: 0,
				retainNewestPerCwd: 0,
				apply: true,
			},
		});
		const result = await runGcCommand({ flags: { agentDir: root, blobs: true, apply: true } });

		expect(result.blobs?.wouldDelete).toBe(1);
		expect(await Bun.file(referenced).exists()).toBe(true);
	});
});

describe("runGcCommand lock handling", () => {
	test("refuses an active gc lock", async () => {
		const lockPath = path.join(root, "gc.lock");
		await Bun.write(lockPath, `${process.pid}\n${new Date().toISOString()}\n`);

		await expect(runGcCommand({ flags: { agentDir: root, blobs: true } })).rejects.toThrow(
			`GC already running: ${lockPath}`,
		);
		expect(await Bun.file(lockPath).exists()).toBe(true);
	});

	test("a preview leaves a stale gc lock where it is, and applying breaks it", async () => {
		const lockPath = path.join(root, "gc.lock");
		// What a gc run killed while it held the lock leaves, random value and all.
		await leaveDeadGcLock(root);
		const left = await Bun.file(lockPath).text();
		const blob = await writeBlob(root, hashFor("orphan"), "orphan");
		await agePath(blob);

		// A preview writes nothing, the lock included.
		const preview = await runGcCommand({ flags: { agentDir: root, blobs: true } });
		expect(preview.blobs?.wouldDelete).toBe(1);
		expect(await Bun.file(lockPath).text()).toBe(left);

		const applied = await runGcCommand({ flags: { agentDir: root, blobs: true, apply: true } });
		expect(applied.blobs?.deleted).toBe(1);
		expect(await Bun.file(lockPath).exists()).toBe(false);
	});

	test("keeps a stale gc lock that carries no random value, and says to move it aside", async () => {
		const lockPath = path.join(root, "gc.lock");
		// What earlier versions write: a pid no process holds, and a start time.
		await Bun.write(lockPath, "999999999\n2026-01-01T00:00:00.000Z\n");

		await expect(runGcCommand({ flags: { agentDir: root, blobs: true } })).rejects.toThrow(
			`${lockPath} looks like a lock an earlier version of gc took`,
		);
		expect(await Bun.file(lockPath).text()).toBe("999999999\n2026-01-01T00:00:00.000Z\n");
	});

	test("does not break gc locks while stale-lock takeover is already in progress", async () => {
		const lockPath = path.join(root, "gc.lock");
		const breakerPath = `${lockPath}.break`;
		await Bun.write(lockPath, "999999999\n2026-01-01T00:00:00.000Z\n");
		await Bun.write(breakerPath, `${process.pid}\n${new Date().toISOString()}\n`);

		await expect(runGcCommand({ flags: { agentDir: root, blobs: true } })).rejects.toThrow(
			`GC already running: ${lockPath}`,
		);
		expect(await Bun.file(lockPath).exists()).toBe(true);
		expect(await Bun.file(breakerPath).exists()).toBe(true);
	});

	// A lock left by a run that is gone, which cannot be removed, is not a
	// running gc: a review failed its removal with `EIO`, and made the lock's
	// directory read-only, and every command said "GC already running" with
	// the holder dead.
	for (const how of ["its removal fails with EIO", "its removal fails with EACCES"] as const) {
		test(`a stale gc lock that cannot be removed because ${how} is reported as that, not as a running gc`, async () => {
			const lockPath = path.join(root, "gc.lock");
			await leaveDeadGcLock(root);
			const left = await Bun.file(lockPath).text();
			const realUnlink = fs.unlink;
			spyOn(fs, "unlink").mockImplementation(async file => {
				if (String(file) === lockPath) {
					const code = how === "its removal fails with EIO" ? "EIO" : "EACCES";
					throw Object.assign(new Error(`${code}: injected lock removal`), { code });
				}
				return await realUnlink(file);
			});
			try {
				const refused = runGcCommand({ flags: { agentDir: root, blobs: true, apply: true } });
				await expect(refused).rejects.toThrow(
					`was left by a gc run that is no longer running, and it could not be removed (${how === "its removal fails with EIO" ? "EIO" : "EACCES"}: injected lock removal)`,
				);
				await expect(refused).rejects.not.toThrow("GC already running");
				expect(await Bun.file(lockPath).text()).toBe(left);
			} finally {
				mock.restore();
				await fs.chmod(root, 0o700);
			}
		});
	}

	// A completed run that cannot remove its own lock says so: left behind,
	// the lock names this process, and the next command refuses. A review
	// saw a completed archive report no errors and leave it.
	test("a run that cannot remove its own gc lock reports it in its result", async () => {
		const lockPath = path.join(root, "gc.lock");
		const realUnlink = fs.unlink;
		spyOn(fs, "unlink").mockImplementation(async file => {
			if (String(file) === lockPath) throw Object.assign(new Error("EIO: injected lock release"), { code: "EIO" });
			return await realUnlink(file);
		});
		try {
			const result = await runGcCommand({ flags: { agentDir: root, blobs: true, apply: true, json: true } });
			mock.restore();

			expect(result.lockNotReleased?.join("\n")).toContain("EIO: injected lock release");
			expect(collectGcErrors(result).join("\n")).toContain("lock: ");
			expect(await Bun.file(lockPath).exists()).toBe(true);
		} finally {
			mock.restore();
			await fs.rm(lockPath, { force: true });
		}
	});
});

describe("runGcCommand stale state", () => {
	const staleFlags = { stale: true, staleRetainNewest: 20, staleRetainDays: 30 };

	async function writeAged(dir: string, name: string, content: string, ageDays?: number): Promise<string> {
		const file = path.join(dir, name);
		await Bun.write(file, content);
		if (ageDays !== undefined) await agePath(file, ageDays);
		return file;
	}

	test("prunes dangling session markers and gone-session breadcrumbs only with --apply, keeping live and fresh-lazy ones", async () => {
		const projectDir = path.join(root, "project");
		const liveSession = path.join(projectDir, "live.jsonl");
		await Bun.write(liveSession, "{}\n");
		const goneSession = path.join(projectDir, "deleted.jsonl");
		const markers = getCustomSessionFilesDir(root);
		const crumbs = getTerminalSessionsDir(root);
		const danglingMarker = await writeAged(markers, "dangling", goneSession, 2);
		const liveMarker = await writeAged(markers, "live", liveSession, 2);
		// A lazy session records its marker before the transcript exists.
		const lazyMarker = await writeAged(markers, "lazy", path.join(projectDir, "lazy.jsonl"));
		const goneCrumb = await writeAged(crumbs, "tty-gone", `${projectDir}\ndeleted.jsonl\n`, 2);
		const liveCrumb = await writeAged(crumbs, "tty-live", `${projectDir}\n${liveSession}\n`, 2);
		// A fresh `/new` boundary is honored by `--continue` before its transcript
		// exists, however long the terminal idles.
		const freshCrumb = await writeAged(crumbs, "tty-fresh", `${projectDir}\nlazy.jsonl\nfresh\n`, 2);

		const dryRun = await runGcCommand({ flags: { agentDir: root, ...staleFlags } });
		expect(dryRun.stale).toMatchObject({ danglingMarkers: 1, staleBreadcrumbs: 1, wouldDelete: 2, deleted: 0 });
		expect(await Bun.file(danglingMarker).exists()).toBe(true);
		expect(await Bun.file(goneCrumb).exists()).toBe(true);

		const applied = await runGcCommand({ flags: { agentDir: root, ...staleFlags, apply: true } });
		expect(applied.stale).toMatchObject({ wouldDelete: 2, deleted: 2, errors: [] });
		expect(await Bun.file(danglingMarker).exists()).toBe(false);
		expect(await Bun.file(goneCrumb).exists()).toBe(false);
		for (const kept of [liveMarker, lazyMarker, liveCrumb, freshCrumb]) {
			expect(await Bun.file(kept).exists()).toBe(true);
		}
	});

	test("--apply expires reports and collab replicas beyond both the newest-count and age limits", async () => {
		// A custom agent dir named `agent` owns its parent as config root.
		const agentDir = path.join(root, "agent");
		const reportsDir = path.join(root, "reports");
		const collabDir = path.join(root, "collab");
		const newestReport = await writeAged(reportsDir, "omp-report-newest.tar.gz", "r", 10);
		const youngReport = await writeAged(reportsDir, "omp-report-young.tar.gz", "r", 20);
		const oldReports = [
			await writeAged(reportsDir, "omp-report-old.tar.gz", "r", 40),
			await writeAged(reportsDir, "omp-report-older.tar.gz", "r", 50),
		];
		const unrelated = await writeAged(reportsDir, "notes.txt", "keep", 100);
		const liveReplica = await writeAged(collabDir, "room-live.jsonl", "{}\n", 1);
		const oldReplica = await writeAged(collabDir, "room-old.jsonl", "{}\n", 60);
		const oldReplicaArtifact = await writeAged(path.join(collabDir, "room-old"), "1.bash.log", "out");
		const oldReplicaMarker = await writeAged(getCustomSessionFilesDir(agentDir), hashPath(oldReplica), oldReplica);

		const result = await runGcCommand({
			flags: { agentDir, stale: true, staleRetainNewest: 1, staleRetainDays: 30, apply: true },
		});

		expect(result.stale).toMatchObject({ expiredReports: 2, expiredReplicas: 1, deleted: 3, errors: [] });
		for (const removed of [...oldReports, oldReplica, oldReplicaArtifact, oldReplicaMarker]) {
			expect(await Bun.file(removed).exists()).toBe(false);
		}
		for (const kept of [newestReport, youngReport, unrelated, liveReplica]) {
			expect(await Bun.file(kept).exists()).toBe(true);
		}
	});

	test("--apply keeps old collab replicas a terminal resumes or a running guest holds open", async () => {
		const agentDir = path.join(root, "agent");
		const collabDir = path.join(root, "collab");
		const resumed = await writeAged(collabDir, "room-resumed.jsonl", "{}\n", 60);
		// Unique per run: the lease is machine-wide, so a fixed id would contend
		// with the same test running concurrently elsewhere.
		const heldId = Bun.randomUUIDv7();
		const held = await writeAged(
			collabDir,
			"room-held.jsonl",
			`${JSON.stringify({ type: "session", id: heldId, timestamp: new Date().toISOString(), cwd: root })}\n`,
			60,
		);
		const idle = await writeAged(collabDir, "room-idle.jsonl", "{}\n", 60);
		// `--continue` in this terminal reopens the replica it last switched to.
		await writeAged(getTerminalSessionsDir(agentDir), "tty-guest", `${root}\n${resumed}\n`);
		// A live guest writing its replica holds the session's ownership lease.
		const release = new FileSessionStorage().claimSession(heldId, held);
		if (!release) throw new Error("Expected to claim the replica lease");
		let result: GcResult;
		try {
			result = await runGcCommand({
				flags: { agentDir, stale: true, staleRetainNewest: 0, staleRetainDays: 30, apply: true },
			});
		} finally {
			release();
		}

		expect(result.stale).toMatchObject({ expiredReplicas: 1, deleted: 1, errors: [] });
		expect(await Bun.file(idle).exists()).toBe(false);
		expect(await Bun.file(resumed).exists()).toBe(true);
		expect(await Bun.file(held).exists()).toBe(true);
	});

	test("an unqualified run leaves stale state alone unless gc.stale is enabled", async () => {
		await writeConfig(root, ["gc:", "  blobs: false", "  archive: false", "  wal: false", ""].join("\n"));

		const unqualified = await runGcCommand({ flags: { agentDir: root } });
		expect(unqualified.stale).toBeUndefined();

		await writeConfig(
			root,
			["gc:", "  blobs: false", "  archive: false", "  wal: false", "  stale: true", ""].join("\n"),
		);
		const enabled = await runGcCommand({ flags: { agentDir: root } });
		expect(enabled.stale?.wouldDelete).toBe(0);
	});
});

// Test roots live under the temp dir, so its filesystem decides which backend tests run. The volume type alone
// does not prove the tool stores files compressed (macOS 27 `ditto --hfsCompression` writes plain copies, #16244),
// so tests that need a file to end up compressed on disk require the same probe `gc --compress --apply` runs.
const method = await gcCompress.compressMethod(os.tmpdir());
const supported = method !== undefined;
const compresses = method !== undefined && (await gcCompress.compressionWorks(os.tmpdir(), method));
const apfsCompresses = compresses && method === "apfs";

/**
 * Replace the filesystem backend so gc's selection, lease, and accounting
 * contracts hold on every host: the volume reports `volume`, the probe
 * passes, and each batch "compresses" every candidate it is handed.
 * Returns the paths of every batch, in order.
 */
function fakeCompressionBackend(volume: gcCompress.CompressMethod = "ntfs"): string[][] {
	const batches: string[][] = [];
	spyOn(gcCompress, "compressMethod").mockResolvedValue(volume);
	spyOn(gcCompress, "compressionWorks").mockResolvedValue(true);
	spyOn(gcCompress, "compressUnavailable").mockReturnValue(undefined);
	spyOn(gcCompress, "compressFilesInPlace").mockImplementation(async candidates => {
		batches.push(candidates.map(candidate => candidate.path));
		return { compressed: candidates.length, allocatedAfter: 0, errors: [] };
	});
	return batches;
}

describe("runGcCommand session compression", () => {
	const filler =
		`${JSON.stringify({ type: "message", message: { role: "toolResult", content: "line ".repeat(40) } })}\n`.repeat(
			400,
		);

	/** Ages `file` to a timestamp with sub-millisecond digits, which a `Date` cannot carry. */
	async function agePathSubMs(file: string, ageDays: number): Promise<void> {
		const seconds = Math.floor((Date.now() - ageDays * 86_400_000) / 1000) + 0.123456;
		await fs.utimes(file, seconds, seconds);
	}

	/** An idle session with a compressible transcript and one artifact; filler precedes its final turn. */
	async function writeIdleSession(id: string, status: "complete" | "pending" = "complete", ageDays = 30) {
		const file = await writeSession(root, "project", id, status);
		const lines = (await Bun.file(file).text()).split("\n");
		lines.splice(1, 0, filler.trimEnd());
		await Bun.write(file, lines.join("\n"));
		const artifact = path.join(file.slice(0, -".jsonl".length), "1.bash.log");
		await fs.mkdir(path.dirname(artifact), { recursive: true });
		await Bun.write(artifact, filler);
		await agePathSubMs(artifact, ageDays);
		await agePathSubMs(file, ageDays);
		return { file, artifact };
	}

	async function snapshot(file: string) {
		const stat = await fs.stat(file);
		return {
			bytes: await Bun.file(file).text(),
			mtimeNs: (await fs.stat(file, { bigint: true })).mtimeNs,
			allocated: stat.blocks * 512,
			size: stat.size,
		};
	}

	test.skipIf(supported)("reports the phase unsupported without touching sessions", async () => {
		const { file } = await writeIdleSession(Bun.randomUUIDv7());
		const before = await snapshot(file);

		const result = await runGcCommand({ flags: { agentDir: root, compress: true, apply: true } });

		expect(result.compress).toMatchObject({ supported: false, scanned: 0, compressed: 0, errors: [] });
		expect(await snapshot(file)).toEqual(before);
	});

	test.skipIf(!compresses)("--apply stores an idle session compressed with identical bytes and mtimes", async () => {
		const { file, artifact } = await writeIdleSession(Bun.randomUUIDv7());
		const before = await Promise.all([snapshot(file), snapshot(artifact)]);

		const result = await runGcCommand({ flags: { agentDir: root, compress: true, apply: true } });

		expect(result.compress).toMatchObject({
			supported: true,
			method,
			sessions: 1,
			wouldCompress: 2,
			compressed: 2,
			errors: [],
		});
		expect(result.compress?.allocatedAfter).toBeLessThan(result.compress?.allocatedBefore ?? 0);
		for (const [index, target] of [file, artifact].entries()) {
			const after = await snapshot(target);
			expect(after.bytes).toBe(before[index].bytes);
			expect(after.mtimeNs).toBe(before[index].mtimeNs);
			expect(after.allocated).toBeLessThan(after.size);
		}
		expect((await fs.readdir(path.dirname(file))).filter(name => name.startsWith(".omp-gc-compress-"))).toEqual([]);

		const rerun = await runGcCommand({ flags: { agentDir: root, compress: true, apply: true } });
		expect(rerun.compress).toMatchObject({ wouldCompress: 0, compressed: 0 });
	});

	test("a dry run reports candidates without rewriting them", async () => {
		const batches = fakeCompressionBackend();
		const { file } = await writeIdleSession(Bun.randomUUIDv7());
		const before = await snapshot(file);

		const result = await runGcCommand({ flags: { agentDir: root, compress: true } });

		expect(result.compress).toMatchObject({ sessions: 1, wouldCompress: 2, compressed: 0 });
		expect(batches).toEqual([]);
		expect(await snapshot(file)).toEqual(before);
	});

	test("a session whose artifact tree cannot be read does not stop the run", async () => {
		fakeCompressionBackend();
		const broken = await writeIdleSession(Bun.randomUUIDv7());
		// A file where the artifact directory belongs makes the tree scan fail with ENOTDIR.
		await fs.rm(path.dirname(broken.artifact), { recursive: true });
		await Bun.write(path.dirname(broken.artifact), "not a directory");
		await writeIdleSession(Bun.randomUUIDv7());

		const result = await runGcCommand({ flags: { agentDir: root, compress: true, wal: true, apply: true } });

		expect(result.compress).toMatchObject({ scanned: 2, sessions: 1, compressed: 2 });
		expect(result.compress?.errors).toEqual([expect.stringContaining(broken.file)]);
		expect(result.wal).toBeDefined();
	});

	// The review's sweep removed a directory of a user's that held only a file
	// named like gc's owner marker and their only copy of a file, and an empty
	// directory of theirs, on nothing but the name: no run can show it made a
	// killed run's scratch, so the next run names it and removes none of it.
	test("a later run names directories that look like a killed run's scratch and removes none of them", async () => {
		fakeCompressionBackend("apfs");
		const { file, artifact } = await writeIdleSession(Bun.randomUUIDv7());
		const inSessions = path.join(path.dirname(file), ".omp-gc-compress-a1b2c3");
		const inArchive = path.join(root, "archive", "sessions", "project", "x", ".omp-gc-compress-d4e5f6");
		for (const dir of [inSessions, inArchive]) {
			await fs.mkdir(dir, { recursive: true });
			await Bun.write(path.join(dir, ".omp-gc-compress-owner"), "");
			await Bun.write(path.join(dir, "copy.jsonl"), filler);
		}
		const empty = path.join(path.dirname(artifact), ".omp-gc-compress-my-work");
		await fs.mkdir(empty);
		const notes = path.join(path.dirname(artifact), ".omp-gc-compress-notes");
		await Bun.write(path.join(notes, ".omp-gc-compress-owner"), "USER DOCUMENT, NOT A GC MARKER");
		await Bun.write(path.join(notes, "only-copy.txt"), "UNIQUE USER BYTES");
		const named = [inArchive, empty, notes, inSessions].sort();

		const dryRun = await runGcCommand({ flags: { agentDir: root, compress: true } });
		const applied = await runGcCommand({ flags: { agentDir: root, compress: true, apply: true } });

		expect([...(dryRun.compress?.leftoverScratch ?? [])].sort()).toEqual(named);
		expect(applied.compress?.errors).toEqual([]);
		expect([...(applied.compress?.leftoverScratch ?? [])].sort()).toEqual(named);
		for (const dir of [inSessions, inArchive])
			expect(await Bun.file(path.join(dir, "copy.jsonl")).text()).toBe(filler);
		expect(await fs.readdir(empty)).toEqual([]);
		expect(await Bun.file(path.join(notes, ".omp-gc-compress-owner")).text()).toBe("USER DOCUMENT, NOT A GC MARKER");
		expect(await Bun.file(path.join(notes, "only-copy.txt")).text()).toBe("UNIQUE USER BYTES");
	});

	test.skipIf(!apfsCompresses)("a failed batch still counts its files as allocated afterwards", async () => {
		const { file, artifact } = await writeIdleSession(Bun.randomUUIDv7());
		const artifactBefore = await snapshot(artifact);
		// A read-only artifact dir cannot hold the scratch copy, so only the transcript compresses.
		await fs.chmod(path.dirname(artifact), 0o555);
		let result: GcResult;
		try {
			result = await runGcCommand({ flags: { agentDir: root, compress: true, apply: true } });
		} finally {
			await fs.chmod(path.dirname(artifact), 0o755);
		}

		expect(result.compress).toMatchObject({ wouldCompress: 2, compressed: 1 });
		expect(result.compress?.errors).toHaveLength(1);
		const transcriptAfter = (await fs.stat(file)).blocks * 512;
		expect(result.compress?.allocatedAfter).toBe(transcriptAfter + artifactBefore.allocated);
		expect(await snapshot(artifact)).toEqual(artifactBefore);
	});

	test("leaves recent and leased sessions uncompressed", async () => {
		const batches = fakeCompressionBackend();
		const recent = await writeIdleSession(Bun.randomUUIDv7(), "complete", 1);
		// Unique per run: the lease is machine-wide.
		const heldId = Bun.randomUUIDv7();
		const held = await writeIdleSession(heldId);
		const release = new FileSessionStorage().claimSession(sessionId(heldId), held.file);
		if (!release) throw new Error("Expected to claim the session lease");
		const targets = [recent.file, recent.artifact, held.file, held.artifact];
		const before = await Promise.all(targets.map(snapshot));
		let result: GcResult;
		try {
			result = await runGcCommand({ flags: { agentDir: root, compress: true, apply: true } });
		} finally {
			release();
		}

		expect(result.compress).toMatchObject({ scanned: 2, skippedLive: 1, wouldCompress: 0, compressed: 0 });
		expect(batches).toEqual([]);
		expect(await Promise.all(targets.map(snapshot))).toEqual(before);
	});

	test("leaves a session uncompressed while a nested transcript is live", async () => {
		const batches = fakeCompressionBackend();
		const parent = await writeIdleSession(Bun.randomUUIDv7());
		const nestedId = Bun.randomUUIDv7();
		// `--session` opens any path, so the transcript is found by its header, not its name.
		const nested = path.join(path.dirname(parent.artifact), "0-subagent.log");
		const header = JSON.stringify({
			type: "session",
			version: 3,
			id: nestedId,
			timestamp: "2026-01-01T00:00:00.000Z",
		});
		// Leading JSON whitespace still parses as a header, so it must not hide the transcript.
		await Bun.write(nested, `\n  ${header}\n${filler}`);
		await agePathSubMs(nested, 30);
		const release = new FileSessionStorage().claimSession(nestedId, nested);
		if (!release) throw new Error("Expected to claim the nested session lease");
		const targets = [parent.file, parent.artifact, nested];
		const before = await Promise.all(targets.map(snapshot));
		let result: GcResult;
		try {
			result = await runGcCommand({ flags: { agentDir: root, compress: true, apply: true } });
		} finally {
			release();
		}

		expect(result.compress).toMatchObject({ skippedLive: 1, wouldCompress: 0, compressed: 0 });
		expect(batches).toEqual([]);
		expect(await Promise.all(targets.map(snapshot))).toEqual(before);
	});

	test("compresses an idle session whose last turn was interrupted", async () => {
		const batches = fakeCompressionBackend();
		const interrupted = await writeIdleSession(Bun.randomUUIDv7(), "pending");

		const result = await runGcCommand({ flags: { agentDir: root, compress: true, apply: true } });

		expect(result.compress).toMatchObject({ skippedLive: 0, compressed: 2 });
		expect(batches.flat().sort()).toEqual([interrupted.file, interrupted.artifact].sort());
	});

	test("compresses a session whose artifact tree holds a copy of its transcript", async () => {
		fakeCompressionBackend();
		const { file, artifact } = await writeIdleSession(Bun.randomUUIDv7());
		// A plain copy keeps the parent's session id; leasing that id twice must not read as live.
		const copy = path.join(path.dirname(artifact), "backup.jsonl");
		await fs.copyFile(file, copy);
		await agePathSubMs(copy, 30);

		const result = await runGcCommand({ flags: { agentDir: root, compress: true, apply: true } });

		expect(result.compress).toMatchObject({ skippedLive: 0, compressed: 3 });
	});

	test("a dry run reads past a large JSON artifact with no session header", async () => {
		fakeCompressionBackend();
		const { artifact } = await writeIdleSession(Bun.randomUUIDv7());
		// Pretty-printed JSON opens like a record but completes none within the header
		// read cap, and the file continues well past it.
		const output = path.join(path.dirname(artifact), "2.mcp_search.log");
		await Bun.write(output, `{\n  "results": [\n${'    "row",\n'.repeat(160_000)}    "end"\n  ]\n}\n`);
		await agePathSubMs(output, 30);

		const result = await runGcCommand({ flags: { agentDir: root, compress: true } });

		expect(result.compress).toMatchObject({ skippedLive: 0, sessions: 1, wouldCompress: 3, errors: [] });
	});

	test("--compress-after-days overrides gc.compressAfterDays", async () => {
		fakeCompressionBackend();
		await writeConfig(root, ["gc:", "  compressAfterDays: 60", ""].join("\n"));
		await writeIdleSession(Bun.randomUUIDv7(), "complete", 30);

		const configured = await runGcCommand({ flags: { agentDir: root, compress: true } });
		const overridden = await runGcCommand({ flags: { agentDir: root, compress: true, compressAfterDays: 7 } });

		expect(configured.compress?.wouldCompress).toBe(0);
		expect(overridden.compress?.wouldCompress).toBe(2);
	});

	test.skipIf(!compresses)(
		"the background run compresses idle sessions, then waits a day before running again",
		async () => {
			const { file, artifact } = await writeIdleSession(Bun.randomUUIDv7());
			const logPath = path.join(root, GC_AUTO_COMPRESS_LOG);

			const child = await scheduleGcAutoCompress(root);
			expect(await child?.exited).toBe(0);
			for (const target of [file, artifact]) {
				const after = await snapshot(target);
				expect(after.allocated).toBeLessThan(after.size);
			}
			expect(await Bun.file(logPath).text()).toContain("compress: 2/2 files in 1 sessions");

			expect(await scheduleGcAutoCompress(root)).toBeUndefined();

			const lastRun = (Date.now() - GC_AUTO_COMPRESS_INTERVAL_MS - 60_000) / 1000;
			await fs.utimes(logPath, lastRun, lastRun);
			const next = await scheduleGcAutoCompress(root);
			expect(await next?.exited).toBe(0);
			expect(await Bun.file(logPath).text()).toContain("compress: 0/0 files in 0 sessions");
		},
		60_000,
	);

	test.skipIf(!compresses)(
		"simultaneous launches start one background run and keep its summary",
		async () => {
			await writeIdleSession(Bun.randomUUIDv7());
			const logPath = path.join(root, GC_AUTO_COMPRESS_LOG);
			const lastRun = (Date.now() - GC_AUTO_COMPRESS_INTERVAL_MS - 60_000) / 1000;
			await Bun.write(logPath, "previous run\n");
			await fs.utimes(logPath, lastRun, lastRun);

			const launched = (await Promise.all([1, 2, 3].map(() => scheduleGcAutoCompress(root)))).filter(
				child => child !== undefined,
			);

			expect(launched).toHaveLength(1);
			expect(await launched[0].exited).toBe(0);
			const log = await Bun.file(logPath).text();
			expect(log).toContain("compress: 2/2 files in 1 sessions");
			expect(log).not.toContain("GC already running");
		},
		60_000,
	);

	test("--apply on a volume whose compression shrinks nothing leaves sessions alone", async () => {
		const batches = fakeCompressionBackend();
		spyOn(gcCompress, "compressionWorks").mockResolvedValue(false);
		const { file } = await writeIdleSession(Bun.randomUUIDv7());
		const before = await snapshot(file);

		const result = await runGcCommand({ flags: { agentDir: root, compress: true, apply: true } });

		expect(result.compress).toMatchObject({ supported: true, scanned: 0, wouldCompress: 0, compressed: 0 });
		expect(batches).toEqual([]);
		expect(result.compress?.probeFailure).toContain("stored a compressible probe file uncompressed");
		expect(await snapshot(file)).toEqual(before);
	});

	test("omp gc --compress --apply fails when the compression probe cannot run", async () => {
		// A supported volume, but no sessions directory to hold the probe's scratch dir.
		const volume = spyOn(gcCompress, "compressMethod").mockResolvedValue("ntfs");
		try {
			await runCli(["gc", "--agent-dir", root, "--compress", "--apply"]);
		} finally {
			volume.mockRestore();
		}

		const stderr = stderrWrites.join("");
		expect(process.exitCode).toBe(1);
		expect(stderr).toContain("GC completed with 1 error:");
		expect(stderr).toContain("compress: compression probe: ENOENT");
		expect(writes.join("")).not.toContain("compress skipped");
	});

	const scratchIn = async (dir: string): Promise<string[]> =>
		(await fs.readdir(dir)).filter(name => name.startsWith(".omp-gc-compress-"));

	test("the compression probe throws when the compression tool fails instead of reporting no compression", async () => {
		// The other platform's tool is absent here, so its batch reports a command failure.
		const absentTool = process.platform === "win32" ? "apfs" : "ntfs";

		await expect(gcCompress.compressionWorks(root, absentTool)).rejects.toThrow(
			absentTool === "apfs" ? "ditto exited" : "compact exited",
		);
		// The probe's own scratch directory went with the probe.
		expect(await scratchIn(root)).toEqual([]);
	});

	// `ditto` is absent off macOS, so the APFS batch's own scratch directory,
	// made inside the probe's, is taken away after a copy that failed.
	test.skipIf(process.platform === "darwin")(
		"a failed APFS copy leaves none of the scratch directories its run made",
		async () => {
			await expect(gcCompress.compressionWorks(root, "apfs")).rejects.toThrow("ditto exited");
			expect(await scratchIn(root)).toEqual([]);
		},
	);

	// A run takes away only what it made: a file somebody put in the probe's
	// scratch directory — here as the probe is looked at to be compressed — is
	// kept, with the directory, and named.
	test("the compression probe leaves a file it did not make in its scratch directory, and says so", async () => {
		const absentTool = process.platform === "win32" ? "apfs" : "ntfs";
		const realLstat = fs.lstat;
		let planted: string | undefined;
		const lstat = spyOn(fs, "lstat").mockImplementation((async (target: string, ...rest: unknown[]) => {
			if (planted === undefined && path.basename(String(target)) === "probe.txt") {
				planted = path.join(path.dirname(String(target)), "somebodys-notes.txt");
				await Bun.write(planted, "ONLY COPY");
			}
			return await (realLstat as (...args: unknown[]) => Promise<unknown>)(target, ...rest);
		}) as typeof fs.lstat);
		let failure: unknown;
		try {
			await gcCompress.compressionWorks(root, absentTool);
		} catch (error) {
			failure = error;
		} finally {
			lstat.mockRestore();
		}

		expect(planted).toBeDefined();
		expect(await Bun.file(planted!).text()).toBe("ONLY COPY");
		expect(String(failure)).toContain(`${path.dirname(planted!)} is not empty, so it was left as it is`);
		expect(await scratchIn(root)).toEqual([path.basename(path.dirname(planted!))]);
		expect(await fs.readdir(path.dirname(planted!))).toEqual(["somebodys-notes.txt"]);
	});

	describe.skipIf(process.platform === "darwin" || process.platform === "win32")(
		"the APFS copy and swap, with a controlled ditto on PATH",
		() => {
			const savedPath = process.env.PATH;
			afterEach(() => {
				process.env.PATH = savedPath;
			});

			/**
			 * A `ditto` first on PATH that writes each file it is given into the
			 * last argument — zero-filled at the file's size, so sparse, when
			 * `sparse`, otherwise a real copy — and exits `exit`. Not macOS's ditto:
			 * what it stands for is a copy tool whose output and exit status this
			 * test decides.
			 */
			async function controlledDitto(sparse: boolean, exit: number): Promise<void> {
				const bin = path.join(root, "bin");
				await Bun.write(
					path.join(bin, "ditto"),
					[
						"#!/bin/sh",
						'for last in "$@"; do :; done',
						'for f in "$@"; do',
						'  case "$f" in --*) continue ;; esac',
						'  [ "$f" = "$last" ] && break',
						sparse
							? '  truncate -s "$(stat -c %s "$f")" "$last/$(basename "$f")"'
							: '  cp "$f" "$last/$(basename "$f")"',
						"done",
						`exit ${exit}`,
						"",
					].join("\n"),
				);
				await fs.chmod(path.join(bin, "ditto"), 0o755);
				process.env.PATH = `${bin}:${savedPath}`;
			}

			/** A private 1 MiB file of zeros: a zero-filled sparse copy holds exactly its bytes and allocates less. */
			async function privateZeros(): Promise<{ file: string; candidate: gcCompress.CompressCandidate }> {
				const file = path.join(root, "work", "original.log");
				await Bun.write(file, Buffer.alloc(1024 * 1024));
				await fs.chmod(file, 0o600);
				const candidate = await gcCompress.compressCandidate(file);
				if (!candidate) throw new Error(`${file} is no compression candidate`);
				return { file, candidate };
			}

			// The review's controlled ditto wrote a byte-identical copy and exited
			// 23, and the copy replaced a `0600` original with a `0644` file.
			test("a copy whose tool exited nonzero is never swapped in, whatever its bytes", async () => {
				await controlledDitto(true, 23);
				const { file, candidate } = await privateZeros();
				const before = await fs.stat(file);

				const result = await gcCompress.compressFilesInPlace([candidate], "apfs", new Set());

				const after = await fs.stat(file);
				expect(result.compressed).toBe(0);
				expect(result.errors).toEqual([expect.stringContaining("ditto exited 23")]);
				expect(after.ino).toBe(before.ino);
				expect(after.mode & 0o777).toBe(0o600);
				expect(await scratchIn(path.dirname(file))).toEqual([]);
			});

			/**
			 * A `ditto` first on PATH that copies each file it is given into the
			 * last argument with its metadata — mode, owner, times to the
			 * nanosecond, extended attributes (`cp --preserve=all`) — as macOS's
			 * ditto does: zero-filled at the file's size when `sparse`, so for a
			 * file of zeros byte-identical and allocating less; otherwise a real
			 * copy, which allocates as much and is never put in place.
			 */
			async function metadataDitto(sparse: boolean): Promise<void> {
				const bin = path.join(root, "bin");
				await Bun.write(
					path.join(bin, "ditto"),
					[
						"#!/bin/sh",
						'for last in "$@"; do :; done',
						'for f in "$@"; do',
						'  case "$f" in --*) continue ;; esac',
						'  [ "$f" = "$last" ] && break',
						'  copy="$last/$(basename "$f")"',
						sparse
							? '  truncate -s "$(stat -c %s "$f")" "$copy" && cp --attributes-only --preserve=all "$f" "$copy" || exit 1'
							: '  cp --preserve=all "$f" "$copy" || exit 1',
						"done",
						"",
					].join("\n"),
				);
				await fs.chmod(path.join(bin, "ditto"), 0o755);
				process.env.PATH = `${bin}:${savedPath}`;
			}

			const isScratchCopy = (file: string): boolean =>
				file.includes(".omp-gc-compress-") && path.basename(file) === "original.log";

			/** A process of its own holding a file open to write; see {@link descriptorWriter}. */
			interface DescriptorWriter {
				/** What its first open met: the file, or a refusal while gc held it under a lease. */
				first: "opened" | "busy";
				/** Append through its descriptor, once it has one, and say how many names that file has left and how long it is. */
				append(): Promise<{ nlink: number; size: number }>;
			}

			const WRITER = [
				'const fs = require("node:fs");',
				'const say = text => fs.writeSync(1, text + "\\n");',
				"const deadline = Date.now() + 20_000;",
				"let fd;",
				"for (let tried = false; ; tried = true) {",
				"\ttry {",
				"\t\tfd = fs.openSync(process.env.WRITER_FILE, fs.constants.O_RDWR | fs.constants.O_NONBLOCK | (process.env.WRITER_CREATE ? fs.constants.O_CREAT : 0));",
				"\t\tbreak;",
				"\t} catch (error) {",
				'\t\tif (!["EAGAIN", "EWOULDBLOCK", "ENOENT"].includes(error.code) || Date.now() > deadline) throw error;',
				"\t}",
				'\tif (!tried) say("busy");',
				"\tBun.sleepSync(10);",
				"}",
				'say("opened");',
				"fs.readSync(0, Buffer.alloc(64));",
				"fs.writeSync(fd, process.env.WRITER_BYTES, fs.fstatSync(fd).size);",
				"const after = fs.fstatSync(fd);",
				"say(JSON.stringify({ nlink: after.nlink, size: after.size }));",
			].join("\n");

			/**
			 * A process of its own that opens `file` to write without blocking —
			 * again every 10 ms while the open is refused, as it is while gc holds
			 * the file under a lease, and with `O_CREAT` when `create`, as a
			 * session writer opens — and, told to, appends `bytes` through that
			 * descriptor: a writer gc cannot see by the file's name.
			 */
			async function descriptorWriter(file: string, bytes: string, create = false): Promise<DescriptorWriter> {
				const child = Bun.spawn([process.execPath, "-e", WRITER], {
					env: { ...process.env, WRITER_FILE: file, WRITER_BYTES: bytes, WRITER_CREATE: create ? "1" : "" },
					stdin: "pipe",
					stdout: "pipe",
					stderr: "inherit",
				});
				onTestFinished(() => {
					if (child.exitCode === null) child.kill();
				});
				const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
				const decoder = new TextDecoder();
				let pending = "";
				const line = async (): Promise<string> => {
					for (;;) {
						const end = pending.indexOf("\n");
						if (end >= 0) {
							const text = pending.slice(0, end);
							pending = pending.slice(end + 1);
							return text;
						}
						const next = await reader.read();
						if (next.done) throw new Error(`the writer stopped after "${pending}"`);
						pending += decoder.decode(next.value, { stream: true });
					}
				};
				const first = await line();
				if (first !== "opened" && first !== "busy") throw new Error(`the writer said "${first}"`);
				return {
					first,
					async append() {
						if (first === "busy") expect(await line()).toBe("opened");
						child.stdin.write("append\n");
						await child.stdin.flush();
						const state = JSON.parse(await line()) as { nlink: number; size: number };
						await child.exited;
						return state;
					},
				};
			}

			/** Run `act` with the copy's scratch path the first time gc asks whether the copy's lease stands: its last look before the copy goes in place. */
			function onCopyLeaseCheck(act: (copy: string) => void): void {
				const intact = openFileHolders.soleOpenLeaseStands;
				let done = false;
				spyOn(openFileHolders, "soleOpenLeaseStands").mockImplementation(fd => {
					const held = fsSync.readlinkSync(`/proc/self/fd/${fd}`);
					if (!done && isScratchCopy(held)) {
						done = true;
						act(held);
					}
					return intact(fd);
				});
			}

			/**
			 * Run `before` just before gc exchanges the copy into `file`, and
			 * `after` once that exchange is made, each with the copy's scratch path.
			 * An exchange back, which also names `file`, runs neither.
			 */
			function aroundPublish(
				file: string,
				hooks: { before?: (copy: string) => void | Promise<void>; after?: (copy: string) => void | Promise<void> },
			): void {
				const exchange = libc.renameExchange;
				let first = true;
				spyOn(libc, "renameExchange").mockImplementation(async (a, b) => {
					const publishing = first && b === file;
					if (publishing) {
						first = false;
						await hooks.before?.(a);
					}
					const done = await exchange(a, b);
					if (publishing && done.outcome === "exchanged") await hooks.after?.(a);
					return done;
				});
			}

			const beforePublish = (file: string, act: (copy: string) => void | Promise<void>): void =>
				aroundPublish(file, { before: act });

			/** This process's descriptor on `file` — the one gc holds. */
			const fdOf = (file: string): number => {
				for (const entry of fsSync.readdirSync("/proc/self/fd")) {
					try {
						if (fsSync.readlinkSync(`/proc/self/fd/${entry}`) === file) return Number(entry);
					} catch {
						// Closed while the directory was listed.
					}
				}
				throw new Error(`this process holds no descriptor on ${file}`);
			};

			test("a copy put in place carries the original's bytes and metadata, and leaves nothing behind", async () => {
				await metadataDitto(true);
				const { file, candidate } = await privateZeros();
				setXattr(file, "user.omp-test", "ORIGINAL");
				const before = await fs.stat(file, { bigint: true });

				const result = await gcCompress.compressFilesInPlace([candidate], "apfs", new Set([file]));

				const after = await fs.stat(file, { bigint: true });
				expect(result).toEqual({ compressed: 1, allocatedAfter: Number(after.blocks) * 512, errors: [] });
				expect(after.ino).not.toBe(before.ino);
				expect([after.mode, after.uid, after.gid, after.mtimeNs, after.nlink]).toEqual([
					before.mode,
					before.uid,
					before.gid,
					before.mtimeNs,
					1n,
				]);
				expect(getXattr(file, "user.omp-test")).toBe("ORIGINAL");
				expect(await fs.readFile(file)).toEqual(Buffer.alloc(1024 * 1024));
				const left = (await fs.readdir(path.dirname(file))).filter(
					name => name.endsWith(".leaving") || name.startsWith(".omp-gc-compress-"),
				);
				expect(left).toEqual([]);
			});

			// Round 3's review: where no lease answered, a process that held the
			// scratch copy open appended after cleanup's check, and the copy was
			// unlinked with no error. A copy no lease shows unheld is not gc's.
			test("a scratch copy another process holds open is kept, with what it writes later, where no lease shows it unheld", async () => {
				await metadataDitto(false);
				const { candidate } = await privateZeros();
				spyOn(openFileHolders, "takeSoleOpenLease").mockReturnValue({
					outcome: "unproved",
					evidence: "test",
					meaning: "no lease, as on a filesystem that refuses them",
					retry: false,
				});
				const open = regularFile.openRegularFile;
				let copy: string | undefined;
				let writer: DescriptorWriter | undefined;
				spyOn(regularFile, "openRegularFile").mockImplementation(async (file, options) => {
					if (copy === undefined && isScratchCopy(String(file))) {
						copy = String(file);
						writer = await descriptorWriter(copy, "ONLY WRITER BYTES");
					}
					return await open(file, options);
				});

				const result = await gcCompress.compressFilesInPlace([candidate], "apfs", new Set());
				const state = await writer!.append();

				expect(state.nlink).toBe(1);
				expect((await fs.readFile(copy!)).subarray(-17).toString()).toBe("ONLY WRITER BYTES");
				expect(result.compressed).toBe(0);
				expect(result.errors.join("\n")).toContain(`whether anything else holds ${copy} open could not be told`);
			});

			// Round 3's review: a process that opened the scratch copy after its
			// proof appended after cleanup's check, and the copy was unlinked. The
			// copy's lease is held until it is removed, and the open breaks it.
			test("a scratch copy opened by another process after its proof is kept, with what that process writes", async () => {
				await metadataDitto(false);
				const { candidate } = await privateZeros();
				const moveAside = regularFile.moveAside;
				let copy: string | undefined;
				let writer: DescriptorWriter | undefined;
				// Cleanup reaches moveAside only after taking the lease and proving
				// the copy. openRegularFile's no-follow lstat happens before that proof.
				spyOn(regularFile, "moveAside").mockImplementation(async (file, rule) => {
					if (copy === undefined && isScratchCopy(file)) {
						copy = file;
						writer = await descriptorWriter(copy, "ONLY WRITER BYTES");
					}
					return await moveAside(file, rule);
				});

				const result = await gcCompress.compressFilesInPlace([candidate], "apfs", new Set());
				const state = await writer!.append();

				expect(state.nlink).toBe(1);
				expect((await fs.readFile(copy!)).subarray(-17).toString()).toBe("ONLY WRITER BYTES");
				expect(result.errors.join("\n")).toContain(
					`${copy} was opened, or an open of it was tried, or it was truncated, by a process the kernel does not name, this one not excluded, after this run proved it`,
				);
			});

			// Round 3's review: the compression probe had the same gap.
			test("the compression probe is kept, with what another process writes to it later, when that process holds it", async () => {
				await metadataDitto(false);
				const lstat = fs.lstat;
				let probe: string | undefined;
				let writer: DescriptorWriter | undefined;
				spyOn(fs, "lstat").mockImplementation((async (target: string, ...rest: unknown[]) => {
					const name = String(target);
					if (probe === undefined && name.includes(".omp-gc-compress-") && path.basename(name) === "probe.txt") {
						probe = name;
						writer = await descriptorWriter(probe, "ONLY WRITER BYTES");
					}
					return await (lstat as (...args: unknown[]) => Promise<unknown>)(target, ...rest);
				}) as typeof fs.lstat);

				const failure = await gcCompress.compressionWorks(root, "apfs").then(
					() => undefined,
					(error: unknown) => error,
				);
				const state = await writer!.append();

				expect(state.nlink).toBe(1);
				expect(String(failure)).toContain(`${probe} is open or mapped elsewhere`);
			});

			// Round 13's review: an original this very process held open was
			// reported as open in another process. A refused lease says only that
			// another open exists, so the report names no process, and a write
			// through that descriptor stays in the session.
			test("an original this process holds open keeps its place, and the report names no other process", async () => {
				await metadataDitto(true);
				const { file, candidate } = await privateZeros();
				const before = await fs.stat(file);
				const held = await fs.open(file, "r+");
				onTestFinished(() => held.close().catch(() => undefined));

				const result = await gcCompress.compressFilesInPlace([candidate], "apfs", new Set([file]));
				await held.write(Buffer.from("ONLY OWN WRITER BYTES"), 0, 21, 1024 * 1024);

				expect((await fs.stat(file)).ino).toBe(before.ino);
				expect((await fs.readFile(file)).subarray(-21).toString()).toBe("ONLY OWN WRITER BYTES");
				expect(result.compressed).toBe(0);
				const said = result.errors.join("\n");
				expect(said).toContain(`${file} is open or mapped elsewhere`);
				expect(said).toContain("by a process the kernel does not name, this one not excluded");
				expect(said).not.toContain("another process");
			});

			// Round 3's review: a write to the original through a descriptor
			// opened before the swap landed in a file no name reached.
			test("an original another process holds open keeps its place, with what that process writes later", async () => {
				await metadataDitto(true);
				const { file, candidate } = await privateZeros();
				const before = await fs.stat(file);
				const writer = await descriptorWriter(file, "ONLY ORIGINAL WRITER BYTES");

				const result = await gcCompress.compressFilesInPlace([candidate], "apfs", new Set([file]));
				const state = await writer.append();

				expect(state.nlink).toBe(1);
				expect((await fs.stat(file)).ino).toBe(before.ino);
				expect((await fs.readFile(file)).subarray(-26).toString()).toBe("ONLY ORIGINAL WRITER BYTES");
				expect(result.compressed).toBe(0);
				expect(result.errors.join("\n")).toContain(`${file} is open or mapped elsewhere`);
			});

			// Round 3's review: a write to the original by its name between gc's
			// last look and the rename was lost; round 5's, that a writer opening
			// the name while the original was moved aside made a new file there.
			// The names are exchanged in one call, so the writer's open meets the
			// original or the copy, whichever the name holds when it tries again,
			// and its bytes land after the session's whole history either way.
			test("a writer that opens the file by its name as the copy goes in place appends after the whole history", async () => {
				await metadataDitto(true);
				const { file, candidate } = await privateZeros();
				let writer: DescriptorWriter | undefined;
				beforePublish(file, async () => {
					writer = await descriptorWriter(file, "ONLY ORIGINAL WRITER BYTES", true);
				});

				const result = await gcCompress.compressFilesInPlace([candidate], "apfs", new Set());
				const state = await writer!.append();

				expect(state.nlink).toBe(1);
				const bytes = await fs.readFile(file);
				expect(bytes.subarray(0, 1024 * 1024)).toEqual(Buffer.alloc(1024 * 1024));
				expect(bytes.subarray(1024 * 1024).toString()).toBe("ONLY ORIGINAL WRITER BYTES");
				expect(result.errors.join("\n")).toContain(
					`${file} was opened, or an open of it was tried, or it was truncated, by a process the kernel does not name, this one not excluded, as it was compressed`,
				);
			});

			// Round 5's review: a session writer in another process opened the
			// transcript while it was moved aside, and the transcript's name held
			// only that writer's one line. Its open now meets the original.
			test("a session writer that opens the transcript as its copy goes in place appends to the whole transcript", async () => {
				await metadataDitto(true);
				const { file, candidate } = await privateZeros();
				const before = await fs.stat(file);
				// The writer is omp's own session storage, loaded by this tree's path in a process of its own.
				const storage = path.join(import.meta.dir, "../src/session/session-storage.ts");
				let writer: Bun.Subprocess<"ignore", "pipe", "inherit"> | undefined;
				beforePublish(file, async () => {
					writer = Bun.spawn(
						[
							process.execPath,
							"-e",
							[
								"const { FileSessionStorage } = await import(process.env.STORAGE_MODULE);",
								'console.log("opening");',
								"const writer = new FileSessionStorage().openWriter(process.env.WRITER_FILE);",
								'writer.appendSync("REAL_STORAGE_APPEND\\n");',
								"await writer.close();",
							].join("\n"),
						],
						{
							env: { ...process.env, STORAGE_MODULE: storage, WRITER_FILE: file },
							stdin: "ignore",
							stdout: "pipe",
							stderr: "inherit",
						},
					);
					onTestFinished(() => {
						if (writer?.exitCode === null) writer.kill();
					});
					const reader = writer.stdout.getReader();
					let said = "";
					while (!said.includes("opening")) {
						const next = await reader.read();
						if (next.done) break;
						said += new TextDecoder().decode(next.value);
					}
					reader.releaseLock();
					// No event says the writer's open has reached gc's lease on the
					// original, which it breaks and then waits on, so the lease's state
					// is polled, for at most 10 s.
					const deadline = Date.now() + 10_000;
					while (openFileHolders.soleOpenLeaseStands(fdOf(file)) && Date.now() < deadline) await Bun.sleep(20);
				});

				const result = await gcCompress.compressFilesInPlace([candidate], "apfs", new Set([file]));

				expect(await writer!.exited).toBe(0);
				expect((await fs.stat(file)).ino).toBe(before.ino);
				expect(await fs.readFile(file)).toEqual(
					Buffer.concat([Buffer.alloc(1024 * 1024), Buffer.from("REAL_STORAGE_APPEND\n")]),
				);
				expect(result.compressed).toBe(0);
				// The writer is a fresh process that loads omp's session storage
				// from source, which takes seconds on a loaded machine.
			}, 30_000);

			// Round 5's review: gc removed the copy's scratch name once it was in
			// place, and a writer had by then left that name the copy's last. The
			// copy in place has one name, and gc removes none of its names.
			test("gc removes no name of the file it puts in place", async () => {
				await metadataDitto(true);
				const { file, candidate } = await privateZeros();
				const unlinked: number[] = [];
				const unlink = fs.unlink;
				spyOn(fs, "unlink").mockImplementation(async target => {
					const stat = await fs.lstat(String(target)).catch(() => undefined);
					if (stat) unlinked.push(stat.ino);
					return await unlink(target);
				});

				const result = await gcCompress.compressFilesInPlace([candidate], "apfs", new Set());

				expect(result.compressed).toBe(1);
				const placed = await fs.stat(file);
				expect(placed.nlink).toBe(1);
				expect(unlinked).not.toContain(placed.ino);
			});

			// Round 3's review: a file renamed onto the copy's name after gc's
			// last look at it was swapped in. The copy goes in place through its
			// own descriptor, so another file at its name never does.
			test("a file renamed onto the copy's name at gc's last look is never put in place", async () => {
				await metadataDitto(true);
				const { file, candidate } = await privateZeros();
				const before = await fs.stat(file);
				let planted: string | undefined;
				onCopyLeaseCheck(copy => {
					planted = copy;
					const other = path.join(root, "replacement");
					fsSync.writeFileSync(other, "UNCHECKED REPLACEMENT");
					fsSync.renameSync(other, copy);
				});

				const result = await gcCompress.compressFilesInPlace([candidate], "apfs", new Set());

				expect(planted).toBeDefined();
				expect(await fs.readFile(file)).toEqual(Buffer.alloc(1024 * 1024));
				expect((await fs.stat(file)).ino).toBe(before.ino);
				expect(await Bun.file(planted!).text()).toBe("UNCHECKED REPLACEMENT");
				expect(result.compressed).toBe(0);
			});

			// Round 3's review: a copy whose mode changed after its byte proof
			// was swapped in, `0600` becoming `0644`. What a file carries is part
			// of the proof, read again at the last look before the exchange.
			const changes = [
				{
					what: "mode",
					change: (copy: string) => fsSync.chmodSync(copy, 0o644),
					read: async (file: string): Promise<unknown> => (await fs.stat(file)).mode & 0o7777,
				},
				{
					what: "extended attribute",
					change: (copy: string) => setXattr(copy, "user.omp-test", "CHANGED"),
					read: async (file: string): Promise<unknown> => getXattr(file, "user.omp-test"),
				},
				{
					what: "modification time",
					change: (copy: string) => fsSync.utimesSync(copy, new Date(0), new Date(0)),
					read: async (file: string): Promise<unknown> => (await fs.stat(file, { bigint: true })).mtimeNs,
				},
			];
			for (const { what, change, read } of changes) {
				test(`a copy whose ${what} changes at gc's last look leaves the original in place`, async () => {
					await metadataDitto(true);
					const { file, candidate } = await privateZeros();
					setXattr(file, "user.omp-test", "ORIGINAL");
					const before = await fs.stat(file);
					const carried = await read(file);
					onCopyLeaseCheck(change);

					const result = await gcCompress.compressFilesInPlace([candidate], "apfs", new Set());

					expect(await read(file)).toEqual(carried);
					expect((await fs.stat(file)).ino).toBe(before.ino);
					expect(result.compressed).toBe(0);
					expect(result.errors.join("\n")).toContain(`the compressed copy of ${file}`);
				});

				// Round 6's review: a change made through the session file's name
				// just after the exchange reached the copy, gc gave the original its
				// name back, and cleanup removed the changed copy. Once the names are
				// exchanged the name is the users', and what reaches it stays.
				test(`a change to the session file's ${what} by its name just after the copy goes in place is kept`, async () => {
					await metadataDitto(true);
					const { file, candidate } = await privateZeros();
					setXattr(file, "user.omp-test", "ORIGINAL");
					const before = await fs.stat(file);
					let changed: unknown;
					aroundPublish(file, {
						after: async () => {
							change(file);
							changed = await read(file);
						},
					});

					const result = await gcCompress.compressFilesInPlace([candidate], "apfs", new Set());

					expect(changed).toBeDefined();
					expect(await read(file)).toEqual(changed);
					expect((await fs.stat(file)).ino).not.toBe(before.ino);
					expect(await fs.readFile(file)).toEqual(Buffer.alloc(1024 * 1024));
					expect(result.compressed).toBe(1);
					expect(await scratchIn(path.dirname(file))).toEqual([]);
				});
			}

			/** Every regular file under `dir`, at any depth, with its bytes. */
			async function filesUnder(dir: string): Promise<Array<{ file: string; bytes: Buffer }>> {
				const found: Array<{ file: string; bytes: Buffer }> = [];
				for (const entry of await fs.readdir(dir, { withFileTypes: true, recursive: true })) {
					if (!entry.isFile()) continue;
					const file = path.join(entry.parentPath, entry.name);
					found.push({ file, bytes: await fs.readFile(file) });
				}
				return found;
			}

			// Round 4's review: a `chmod`, `setxattr` or `utimes` of the
			// original after its comparison and before it gave way was lost, since
			// none of them breaks a lease. The original is proved again after the
			// exchange, and a change gives it its name back, with the change.

			/** Let go of gc's lease on the file open at `fd`, as the kernel does once an opener has waited out its break time. */
			const breakLease = (fd: number): void => {
				const F_SETLEASE = 1024;
				const F_UNLCK = 2;
				expect(libc.libc().fcntl?.(fd, F_SETLEASE, F_UNLCK)).toBe(0);
			};

			// (Each row changes the original by its name just before the exchange.)
			const originalChanges = [
				{
					what: "mode",
					change: (file: string) => fsSync.chmodSync(file, 0o400),
					read: (file: string): unknown => fsSync.statSync(file).mode & 0o7777,
				},
				{
					what: "extended attribute",
					change: (file: string) => setXattr(file, "user.omp-test", "CHANGED"),
					read: (file: string): unknown => getXattr(file, "user.omp-test"),
				},
				{
					what: "modification time",
					change: (file: string) => fsSync.utimesSync(file, new Date(0), new Date(0)),
					read: (file: string): unknown => fsSync.statSync(file, { bigint: true }).mtimeNs,
				},
			];
			for (const { what, change, read } of originalChanges) {
				test(`an original whose ${what} changes just before the copy goes in place keeps the change and its place`, async () => {
					await metadataDitto(true);
					const { file, candidate } = await privateZeros();
					setXattr(file, "user.omp-test", "ORIGINAL");
					const before = await fs.stat(file);
					let changed: unknown;
					beforePublish(file, () => {
						change(file);
						changed = read(file);
					});

					const result = await gcCompress.compressFilesInPlace([candidate], "apfs", new Set());

					expect(changed).toBeDefined();
					expect(read(file)).toEqual(changed);
					expect((await fs.stat(file)).ino).toBe(before.ino);
					expect(result.compressed).toBe(0);
					expect(result.errors.join("\n")).toContain(`${file} now has`);
				});
			}

			// Round 8's review: a process opened the session file by its name just
			// after the exchange, its open waited out the copy's 45 s lease break
			// while gc was held up, and it wrote and put the mtime back; gc gave the
			// original its name back, with the write in the scratch directory. A
			// write to the copy is a reach of the name, and keeps the copy there.
			test("a write by the name after the copy's lease lapses stays at the name", async () => {
				await metadataDitto(true);
				const { file, candidate } = await privateZeros();
				const before = await fs.stat(file);
				aroundPublish(file, {
					after: () => {
						// What the kernel does once an opener has waited out the break time.
						breakLease(fdOf(file));
						const writer = Bun.spawnSync([
							"/usr/bin/python3",
							"-c",
							"import os,sys; p=sys.argv[1]; s=os.stat(p); fd=os.open(p, os.O_RDWR); os.pwrite(fd, b'LATE PUBLIC BYTE', 0); os.close(fd); os.utime(p, ns=(s.st_atime_ns, s.st_mtime_ns))",
							file,
						]);
						expect(writer.exitCode).toBe(0);
					},
				});

				const result = await gcCompress.compressFilesInPlace([candidate], "apfs", new Set());

				const bytes = await fs.readFile(file);
				expect(bytes.subarray(0, 16).toString()).toBe("LATE PUBLIC BYTE");
				expect(bytes.length).toBe(1024 * 1024);
				expect((await fs.stat(file)).ino).not.toBe(before.ino);
				expect(result.compressed).toBe(1);
				expect(await scratchIn(path.dirname(file))).toEqual([]);
			});

			// Round 4's review: a writer that waited out the copy's lease wrote
			// through the session file's name, and taking the copy back off that
			// name unlinked it. A process that opens the name after the exchange
			// reaches the copy and waits on its lease, so the copy keeps the name,
			// with a `chmod` made by the name too, and the write lands in it once
			// gc lets go.
			test("a writer that opens the session file by its name just after the copy goes in place appends to the copy, which keeps the name", async () => {
				await metadataDitto(true);
				const { file, candidate } = await privateZeros();
				const before = await fs.stat(file);
				let writer: DescriptorWriter | undefined;
				aroundPublish(file, {
					after: async () => {
						writer = await descriptorWriter(file, "ONLY NEW WRITER BYTES");
						fsSync.chmodSync(file, 0o644);
					},
				});

				const result = await gcCompress.compressFilesInPlace([candidate], "apfs", new Set([file]));
				expect(writer!.first).toBe("busy");
				const state = await writer!.append();

				expect(state.nlink).toBe(1);
				const after = await fs.stat(file);
				expect(after.ino).not.toBe(before.ino);
				expect(after.mode & 0o7777).toBe(0o644);
				expect(await fs.readFile(file)).toEqual(
					Buffer.concat([Buffer.alloc(1024 * 1024), Buffer.from("ONLY NEW WRITER BYTES")]),
				);
				expect(result.compressed).toBe(1);
				expect(await scratchIn(path.dirname(file))).toEqual([]);
				// The writer is a fresh process, started and then retrying while gc
				// holds the copy's lease, which takes seconds on a loaded machine.
			}, 30_000);

			// Round 6's review: a file another process renamed onto the session
			// file's name just after the exchange was sent into the scratch
			// directory by an exchange back. It keeps the name: the replacement is
			// that process's, and gc removes what the name held as it would have.
			test("a file renamed onto the session file's name just after the copy goes in place keeps the name", async () => {
				await metadataDitto(true);
				const { file, candidate } = await privateZeros();
				aroundPublish(file, {
					after: () => {
						const fresh = path.join(path.dirname(file), "fresh.tmp");
						fsSync.writeFileSync(fresh, "ONLY NEW PUBLISHED SESSION");
						fsSync.renameSync(fresh, file);
					},
				});

				const result = await gcCompress.compressFilesInPlace([candidate], "apfs", new Set());

				expect(await Bun.file(file).text()).toBe("ONLY NEW PUBLISHED SESSION");
				expect(result.compressed).toBe(0);
				expect(result.errors.join("\n")).toContain(
					`another file was put at ${file} as it was compressed, and it was left there`,
				);
				expect(await scratchIn(path.dirname(file))).toEqual([]);
			});

			// Round 8's review: the session file removed by its name just after the
			// exchange was reported as another process's file there. A removal is
			// that process's deletion of the session, which stands, and it is said.
			test("a session file removed by its name just after the copy goes in place stays removed, and the run says so", async () => {
				await metadataDitto(true);
				const { file, candidate } = await privateZeros();
				aroundPublish(file, { after: () => fsSync.unlinkSync(file) });

				const result = await gcCompress.compressFilesInPlace([candidate], "apfs", new Set());

				expect(await fs.lstat(file).catch(() => undefined)).toBeUndefined();
				expect(result.compressed).toBe(0);
				const said = result.errors.join("\n");
				expect(said).toContain(`${file} was removed as it was compressed`);
				expect(said).not.toContain("was put at");
				expect(await scratchIn(path.dirname(file))).toEqual([]);
			});

			// Round 9's review: the same removal just before the exchange was
			// reported only as a name lost. It stays removed, and the run says
			// which name.
			test("a session file removed by its name just before the exchange stays removed, and the run says so", async () => {
				await metadataDitto(true);
				const { file, candidate } = await privateZeros();
				beforePublish(file, () => fsSync.unlinkSync(file));

				const result = await gcCompress.compressFilesInPlace([candidate], "apfs", new Set());

				expect(await fs.lstat(file).catch(() => undefined)).toBeUndefined();
				expect(result.compressed).toBe(0);
				expect(result.errors.join("\n")).toContain(
					`${file} was removed just before its compressed copy took its place`,
				);
				expect(await scratchIn(path.dirname(file))).toEqual([]);
			});

			// The boundary: a second reach of the name, by a process that ignores
			// the session's ownership lease, in the few system calls before the
			// exchange back goes to the scratch name with the file it reached. It
			// is reported there and kept, never removed. Round 7's review reached
			// it three ways: a file renamed onto the name, a `chmod` of the copy,
			// and an open of the copy that waited on its lease, then wrote.
			let blockingWriter: Bun.Subprocess<"ignore", "ignore", "inherit"> | undefined;
			const secondReaches = [
				{
					what: "a file renamed onto the name",
					act: async (file: string) => {
						const fresh = path.join(path.dirname(file), "fresh.tmp");
						fsSync.writeFileSync(fresh, "ONLY NEW PUBLISHED SESSION");
						fsSync.renameSync(fresh, file);
					},
					said: "another file was put at",
					kept: async (): Promise<boolean> =>
						(await filesUnder(root)).some(({ bytes }) => bytes.toString() === "ONLY NEW PUBLISHED SESSION"),
				},
				{
					what: "a `chmod` of the copy by the name",
					act: async (file: string) => fsSync.chmodSync(file, 0o440),
					said: "the compressed copy now has mode 440",
					kept: async (): Promise<boolean> =>
						(await filesUnder(root)).some(
							({ file }) =>
								file.includes(".omp-gc-compress-") && (fsSync.statSync(file).mode & 0o7777) === 0o440,
						),
				},
				{
					what: "an open of the copy by the name that waits on its lease, then a write",
					act: async (file: string) => {
						blockingWriter = Bun.spawn(
							[
								process.execPath,
								"-e",
								'const fs = require("node:fs"); const fd = fs.openSync(process.env.WRITER_FILE, "a"); fs.writeSync(fd, "ONLY LATE WRITER BYTES"); fs.closeSync(fd);',
							],
							{
								env: { ...process.env, WRITER_FILE: file },
								stdin: "ignore",
								stdout: "ignore",
								stderr: "inherit",
							},
						);
						onTestFinished(() => {
							if (blockingWriter?.exitCode === null) blockingWriter.kill();
						});
						// No event says the open has reached gc's lease on the copy, which
						// it breaks and then waits on, so the lease is polled, for at most 10 s.
						const deadline = Date.now() + 10_000;
						while (openFileHolders.soleOpenLeaseStands(fdOf(file)) && Date.now() < deadline) await Bun.sleep(20);
					},
					said: "the compressed copy was opened, or an open of it was tried, or it was truncated, by a process the kernel does not name, this one not excluded, as it was given back",
					kept: async (): Promise<boolean> => {
						expect(await blockingWriter!.exited).toBe(0);
						return (await filesUnder(root)).some(
							({ file, bytes }) =>
								file.includes(".omp-gc-compress-") &&
								bytes.subarray(-22).toString() === "ONLY LATE WRITER BYTES",
						);
					},
				},
			];
			for (const { what, act, said, kept } of secondReaches) {
				test(`${what} just before the original is given back is kept at the scratch name and reported`, async () => {
					await metadataDitto(true);
					const { file, candidate } = await privateZeros();
					const before = await fs.stat(file);
					const exchange = libc.renameExchange;
					let calls = 0;
					spyOn(libc, "renameExchange").mockImplementation(async (a, b) => {
						calls += 1;
						// Before the first: a change by name the original must keep.
						if (calls === 1) fsSync.chmodSync(file, 0o400);
						// Before the exchange back: the second reach.
						if (calls === 2) await act(file);
						return await exchange(a, b);
					});

					const result = await gcCompress.compressFilesInPlace([candidate], "apfs", new Set());

					expect(calls).toBe(2);
					const now = await fs.stat(file);
					expect(now.ino).toBe(before.ino);
					expect(now.mode & 0o7777).toBe(0o400);
					expect(await kept()).toBe(true);
					expect(result.compressed).toBe(0);
					expect(result.errors.join("\n")).toContain(said);
					// A child process in one row, which takes seconds on a loaded machine.
				}, 30_000);
			}

			// Round 7's review: a file renamed onto the name after gc's last look
			// in a swap that otherwise went through was counted as compressed; round
			// 11's, that the run then could not say whether the name was removed or
			// replaced. Neither is counted, and the run says which.
			for (const [what, act, said] of [
				[
					"a file renamed onto",
					(file: string) => {
						const fresh = path.join(path.dirname(file), "fresh.tmp");
						fsSync.writeFileSync(fresh, "ONLY NEW PUBLISHED SESSION");
						fsSync.renameSync(fresh, file);
					},
					(file: string) => `another file was put at ${file} as it was compressed, and it was left there`,
				],
				[
					"a removal of",
					(file: string) => fsSync.unlinkSync(file),
					(file: string) => `${file} was removed as it was compressed`,
				],
			] as const) {
				test(`${what} the session file's name as the swap ends is not counted as compressed, and is said`, async () => {
					await metadataDitto(true);
					const { file, candidate } = await privateZeros();
					const unlink = fs.unlink;
					spyOn(fs, "unlink").mockImplementation(async target => {
						await unlink(target);
						if (String(target).includes(".omp-gc-compress-")) act(file);
					});

					const result = await gcCompress.compressFilesInPlace([candidate], "apfs", new Set());

					expect(result.compressed).toBe(0);
					expect(result.errors.join("\n")).toContain(said(file));
				});
			}

			// Round 12's review: a failure to look at the name once the original
			// was removed was reported as both files left as they were. It says the
			// original went and the name could not be checked, and is not counted.
			test("a failure to look at the name after the original goes is reported as such, and not counted", async () => {
				await metadataDitto(true);
				const { file, candidate } = await privateZeros();
				const unlink = fs.unlink;
				let originalGone = false;
				spyOn(fs, "unlink").mockImplementation(async target => {
					await unlink(target);
					if (String(target).includes(".omp-gc-compress-")) originalGone = true;
				});
				const lstat = fs.lstat;
				spyOn(fs, "lstat").mockImplementation((async (target: string, ...rest: unknown[]) => {
					if (originalGone && String(target) === file)
						throw Object.assign(new Error("EIO: injected"), { code: "EIO" });
					return await (lstat as (...args: unknown[]) => Promise<unknown>)(target, ...rest);
				}) as typeof fs.lstat);

				const result = await gcCompress.compressFilesInPlace([candidate], "apfs", new Set());

				expect(originalGone).toBe(true);
				expect(result.compressed).toBe(0);
				const said = result.errors.join("\n");
				expect(said).toContain("what it held before was removed at the scratch name");
				expect(said).toContain(
					`whether ${file} still holds its compressed copy could not be checked (EIO: injected)`,
				);
				expect(said).not.toContain("left as they are");
			});

			// Round 11's review: a failure to read the original's metadata, or its
			// lease, after the exchange was taken for another process's reach of it,
			// and gc gave it its name back — moving the copy, with whatever had
			// reached it at the name since, into the scratch directory. A failure to
			// look moves nothing: both files stay where the exchange put them.
			for (const [what, fail] of [
				[
					"inode flags",
					(isOriginal: (fd: number) => boolean) => {
						const flags = regularFile.inodeFlags;
						spyOn(regularFile, "inodeFlags").mockImplementation(fd => {
							if (isOriginal(fd)) throw new Error("EIO: injected");
							return flags(fd);
						});
					},
				],
				[
					"lease",
					(isOriginal: (fd: number) => boolean) => {
						const stands = openFileHolders.soleOpenLeaseStands;
						spyOn(openFileHolders, "soleOpenLeaseStands").mockImplementation(fd => {
							if (isOriginal(fd)) throw new Error("EIO: injected");
							return stands(fd);
						});
					},
				],
			] as const) {
				test(`a failure to read the original's ${what} after the exchange moves nothing, and is said`, async () => {
					await metadataDitto(true);
					const { file, candidate } = await privateZeros();
					let exchanges = 0;
					let exchanged = false;
					const exchange = libc.renameExchange;
					spyOn(libc, "renameExchange").mockImplementation(async (a, b) => {
						exchanges += 1;
						const done = await exchange(a, b);
						exchanged = done.outcome === "exchanged";
						return done;
					});
					// After the exchange the original is at the scratch name.
					fail(fd => exchanged && isScratchCopy(fsSync.readlinkSync(`/proc/self/fd/${fd}`)));

					const result = await gcCompress.compressFilesInPlace([candidate], "apfs", new Set());

					expect(exchanges).toBe(1);
					expect(await fs.readFile(file)).toEqual(Buffer.alloc(1024 * 1024));
					expect(result.compressed).toBe(0);
					const said = result.errors.join("\n");
					expect(said).toContain(`${file} could not be checked (EIO: injected) after it was exchanged`);
					expect(said).not.toContain("another process");
				});
			}

			// Round 11's review: a copy cleanup could not remove was reported as
			// something this run did not make. The scratch directory's report says
			// only that it is not empty; the note before it says what was left.
			test("a copy cleanup cannot remove is reported as such, and the scratch directory as not empty", async () => {
				await metadataDitto(false);
				const { candidate } = await privateZeros();
				spyOn(fs, "unlink").mockImplementation(async target => {
					throw Object.assign(new Error(`EIO: injected, unlink '${String(target)}'`), { code: "EIO" });
				});

				const result = await gcCompress.compressFilesInPlace([candidate], "apfs", new Set());

				const said = result.errors.join("\n");
				expect(said).toContain("could not be removed (EIO: injected");
				expect(said).toContain("is not empty, so it was left as it is");
				expect(said).not.toContain("did not make");
			});

			// Round 6's review: a `link` of the session file made just before the
			// exchange left the lease standing, and the session and its new name
			// were split. The original keeps the name, and both names hold it.
			test("a link to the session file made just before the copy goes in place keeps both names on the original", async () => {
				await metadataDitto(true);
				const { file, candidate } = await privateZeros();
				const before = await fs.stat(file);
				const alias = path.join(root, "alias.log");
				beforePublish(file, () => fsSync.linkSync(file, alias));

				const result = await gcCompress.compressFilesInPlace([candidate], "apfs", new Set());

				expect((await fs.stat(file)).ino).toBe(before.ino);
				expect((await fs.stat(alias)).ino).toBe(before.ino);
				expect(result.compressed).toBe(0);
				expect(result.errors.join("\n")).toContain(`${file} was given another name as it was compressed`);
			});

			// Round 6's review: a failure to look at a name after the exchange was
			// reported as another process's file there. What the names hold is not
			// known then, so neither is touched again, and the reason is said.
			test("a failure to look at the names after the exchange leaves both files and says so", async () => {
				await metadataDitto(true);
				const { file, candidate } = await privateZeros();
				let exchanged = false;
				aroundPublish(file, {
					after: () => {
						exchanged = true;
					},
				});
				const lstat = fs.lstat;
				spyOn(fs, "lstat").mockImplementation((async (target: string, ...rest: unknown[]) => {
					if (exchanged && String(target) === file)
						throw Object.assign(new Error("EIO: injected"), { code: "EIO" });
					return await (lstat as (...args: unknown[]) => Promise<unknown>)(target, ...rest);
				}) as typeof fs.lstat);

				const result = await gcCompress.compressFilesInPlace([candidate], "apfs", new Set());

				expect(await fs.readFile(file)).toEqual(Buffer.alloc(1024 * 1024));
				expect(result.compressed).toBe(0);
				const said = result.errors.join("\n");
				expect(said).toContain(`${file} could not be checked (EIO: injected) after it was exchanged`);
				expect(said).not.toContain("another file was put");
			});

			// Round 4's review: an error reading the moved original left it at its
			// private name and nothing at the session file's name.
			test("a failure to read the original during the swap leaves it at its name", async () => {
				await metadataDitto(true);
				const { file, candidate } = await privateZeros();
				const before = await fs.stat(file);
				const lease = openFileHolders.takeSoleOpenLease;
				spyOn(openFileHolders, "takeSoleOpenLease").mockImplementation(fd => {
					if (fsSync.readlinkSync(`/proc/self/fd/${fd}`) === file) throw new Error("EIO: injected");
					return lease(fd);
				});

				const result = await gcCompress.compressFilesInPlace([candidate], "apfs", new Set());

				expect((await fs.stat(file)).ino).toBe(before.ino);
				expect((await fs.readdir(path.dirname(file))).filter(name => name.endsWith(".leaving"))).toEqual([]);
				expect(result.compressed).toBe(0);
				expect(result.errors.join("\n")).toContain(`${file} could not be checked (EIO: injected)`);
			});

			// A filesystem that refuses `RENAME_EXCHANGE` keeps every file, like
			// one that refuses leases, and the run says why.
			test("where the filesystem refuses to exchange two names, every file is kept and gc says why", async () => {
				await metadataDitto(true);
				const { file, candidate } = await privateZeros();
				const before = await fs.stat(file);
				spyOn(libc, "renameExchange").mockResolvedValue({
					outcome: "unsupported",
					why: "renameat2(RENAME_EXCHANGE) failed with EINVAL",
				});

				const result = await gcCompress.compressFilesInPlace([candidate], "apfs", new Set([file]));

				expect(result).toEqual({
					compressed: 0,
					allocatedAfter: candidate.allocated,
					errors: [
						`the compressed copy of ${file} could not be put in its place (renameat2(RENAME_EXCHANGE) failed with EINVAL), so nothing moved`,
					],
				});
				expect((await fs.stat(file)).ino).toBe(before.ino);
				expect(await fs.readFile(file)).toEqual(Buffer.alloc(1024 * 1024));
				expect(await scratchIn(path.dirname(file))).toEqual([]);
			});

			test("where no lease can be asked for at all, as on macOS, nothing is copied and gc says why", async () => {
				spyOn(openFileHolders, "leaseCallUnavailable").mockReturnValue({
					outcome: "unproved",
					evidence: "fcntl was not called",
					meaning: "this system's C library takes `fcntl`'s third argument where omp cannot pass it",
					retry: false,
				});
				spyOn(gcCompress, "compressMethod").mockResolvedValue("apfs");
				await metadataDitto(true);
				const { file, candidate } = await privateZeros();
				const before = await fs.stat(file);

				const result = await gcCompress.compressFilesInPlace([candidate], "apfs", new Set());

				expect(result).toEqual({
					compressed: 0,
					allocatedAfter: candidate.allocated,
					errors: [expect.stringContaining("so no file is compressed")],
				});
				expect((await fs.stat(file)).ino).toBe(before.ino);
				expect(await scratchIn(path.dirname(file))).toEqual([]);
				await expect(gcCompress.compressionWorks(root, "apfs")).rejects.toThrow("omp cannot pass it");
				expect(await scratchIn(root)).toEqual([]);
				const preview = await runGcCommand({ flags: { agentDir: root, compress: true } });
				expect(preview.compress?.probeFailure).toContain("so no file is compressed");
				expect(await scheduleGcAutoCompress(root)).toBeUndefined();
				expect(await Bun.file(path.join(root, GC_AUTO_COMPRESS_LOG)).text()).toContain(
					"compress skipped: APFS compression puts a compressed copy in place",
				);
			});
		},
	);

	test.skipIf(supported)("the background run never starts without filesystem compression", async () => {
		const { file } = await writeIdleSession(Bun.randomUUIDv7());
		const before = await snapshot(file);

		expect(await scheduleGcAutoCompress(root)).toBeUndefined();
		expect(await Bun.file(path.join(root, GC_AUTO_COMPRESS_LOG)).text()).toContain("compress skipped: unsupported");
		expect(await snapshot(file)).toEqual(before);
	});
});

test("round54 failed lock takeover reports the breaker left by this process too", async () => {
	const lock = path.join(root, "gc.lock");
	const breaker = `${lock}.break`;
	await leaveDeadGcLock(root);
	const unlink = fs.unlink;
	spyOn(fs, "unlink").mockImplementation(async file => {
		if ([lock, breaker].includes(String(file))) {
			throw Object.assign(new Error(`EIO: round54 unlink ${String(file)}`), { code: "EIO" });
		}
		return await unlink(file);
	});
	const run = runGcCommand({ flags: { agentDir: root, blobs: true, apply: true } });
	await expect(run).rejects.toThrow(`EIO: round54 unlink ${lock}`);
	await expect(run).rejects.toThrow(`EIO: round54 unlink ${breaker}`);
	expect(await Bun.file(breaker).text()).toContain(`${process.pid}\n`);
});

test("round54 a stale symlink lock is reported as a link, not a running gc", async () => {
	await leaveDeadGcLock(root);
	const lock = path.join(root, "gc.lock");
	const target = path.join(root, "stale-target");
	await fs.rename(lock, target);
	await fs.symlink(target, lock);
	const run = runGcCommand({ flags: { agentDir: root, blobs: true, apply: true } });
	await expect(run).rejects.not.toThrow("GC already running");
	await expect(run).rejects.toThrow("a symbolic link");
	expect((await fs.lstat(lock)).isSymbolicLink()).toBe(true);
	expect(await Bun.file(target).exists()).toBe(true);
});

test("round54 command failure retains a simultaneous lock release error", async () => {
	const lock = path.join(root, "gc.lock");
	const readdir = fs.readdir;
	const unlink = fs.unlink;
	spyOn(fs, "readdir").mockImplementation((async (...args: Parameters<typeof fs.readdir>) => {
		if (String(args[0]) === getBlobsDir(root)) {
			throw Object.assign(new Error("EIO: round54 blob listing"), { code: "EIO" });
		}
		return await Reflect.apply(readdir, fs, args);
	}) as typeof fs.readdir);
	spyOn(fs, "unlink").mockImplementation(async file => {
		if (String(file) === lock) throw Object.assign(new Error("EIO: round54 release"), { code: "EIO" });
		return await unlink(file);
	});
	const run = runGcCommand({ flags: { agentDir: root, blobs: true, apply: true } });
	await expect(run).rejects.toThrow("EIO: round54 blob listing");
	await expect(run).rejects.toThrow("EIO: round54 release");
	expect(await Bun.file(lock).exists()).toBe(true);
});

test("round54 failed dangling pointer lookup surfaces instead of silently keeping it", async () => {
	const target = path.join(root, "unreadable.jsonl");
	await Bun.write(target, "ORIGINAL");
	const marker = path.join(getCustomSessionFilesDir(root), "pointer");
	await Bun.write(marker, target);
	await agePath(marker, 90);
	const stat = fs.stat;
	spyOn(fs, "stat").mockImplementation((async (...args: Parameters<typeof fs.stat>) => {
		if (String(args[0]) === target) throw Object.assign(new Error("EIO: round54 pointer target"), { code: "EIO" });
		return await Reflect.apply(stat, fs, args);
	}) as typeof fs.stat);
	await expect(runGcCommand({ flags: { agentDir: root, stale: true, apply: true } })).rejects.toThrow(
		"EIO: round54 pointer target",
	);
	expect(await Bun.file(marker).text()).toBe(target);
	expect(await Bun.file(target).text()).toBe("ORIGINAL");
});

test("round54 gc lock pid probe failure is not a running gc", async () => {
	await leaveDeadGcLock(root);
	const lock = path.join(root, "gc.lock");
	const bytes = await Bun.file(lock).text();
	const pid = Number(bytes.split("\n")[0]);
	const kill = process.kill;
	spyOn(process, "kill").mockImplementation((target, signal) => {
		if (target === pid && signal === 0) throw Object.assign(new Error("EIO: round54 pid probe"), { code: "EIO" });
		return kill(target, signal);
	});
	const run = runGcCommand({ flags: { agentDir: root, blobs: true } });
	await expect(run).rejects.toThrow("EIO: round54 pid probe");
	await expect(run).rejects.not.toThrow("GC already running");
	expect(await Bun.file(lock).text()).toBe(bytes);
});

test("round54 fresh empty lock names no unseen running process", async () => {
	const lock = path.join(root, "gc.lock");
	await Bun.write(lock, "");
	const run = runGcCommand({ flags: { agentDir: root, blobs: true } });
	await expect(run).rejects.not.toThrow("GC already running");
	await expect(run).rejects.toThrow("empty");
	expect(await Bun.file(lock).text()).toBe("");
});
