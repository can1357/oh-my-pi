import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EditTool } from "@oh-my-pi/pi-coding-agent/edit";
import { createLspWritethrough } from "@oh-my-pi/pi-coding-agent/lsp/writethrough";
import type { AgentToolContext } from "@oh-my-pi/pi-agent-core";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { backupBeforeClobber } from "@oh-my-pi/pi-coding-agent/tools/clobber-backup";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { addFileWriteFallback } from "@oh-my-pi/pi-coding-agent/tools/file-write-fallback";
import { WriteTool } from "@oh-my-pi/pi-coding-agent/tools/write";
import {
	$which,
	getAgentDir,
	getClobberBackupsDir,
	getSessionsDir,
	removeWithRetries,
	setAgentDir,
} from "@oh-my-pi/pi-utils";
import { readArchiveEntries, writeArchive } from "@oh-my-pi/pi-utils/ar";

/** The old content of the file each clobber test destroys; distinctive enough to find anywhere on disk. */
const DOOMED = "register entry 1\nregister entry 2\nregister entry 3\n";

function makeSession(cwd: string, sessionFile: string | null = null): ToolSession {
	return {
		cwd,
		hasUI: false,
		enableLsp: false,
		getSessionFile: () => sessionFile,
		getSessionSpawns: () => "*",
		getArtifactsDir: () => null,
		getSessionId: () => null,
		getPlanModeState: () => undefined,
		settings: Settings.isolated({ "edit.mode": "patch" }),
	} as ToolSession;
}

/**
 * The slice of a tool-call context the `write` tool reads to join a deferred
 * LSP writethrough batch: which call of the batch this is, and the batch it
 * belongs to. Nothing else in the context is reached on this path.
 */
function batchContext(batchId: string, index: number): AgentToolContext {
	return {
		toolCall: {
			index,
			batchId,
			toolCalls: [
				{ id: "0", name: "write", arguments: {} },
				{ id: "1", name: "write", arguments: {} },
			],
		},
	} as unknown as AgentToolContext;
}

function resultText(result: { content: { type: string; text?: string }[] }): string {
	return result.content.flatMap(block => (block.type === "text" && block.text ? [block.text] : [])).join("\n");
}

/** The store's directory name for `date`, the same shape the module writes. */
function dayKey(date: Date): string {
	return `${date.getFullYear()}-${`${date.getMonth() + 1}`.padStart(2, "0")}-${`${date.getDate()}`.padStart(2, "0")}`;
}

/** A completed day, far enough back to be swept by the budget but not by retention. */
function completedDay(): string {
	return dayKey(new Date(Date.now() - 2 * 24 * 60 * 60 * 1000));
}

/**
 * Wait for the detached sweep to remove `target`. The sweep is filesystem work
 * the tool call deliberately does not await, and it exposes no promise to hook,
 * so there is no signal to wait on and no timer to fake: the condition itself is
 * the signal. Polls rather than sleeping a guessed duration, and names the file
 * it was waiting for when it gives up.
 */
async function untilGone(target: string, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (await Bun.file(target).exists()) {
		if (Date.now() > deadline) throw new Error(`still present after ${timeoutMs}ms: ${target}`);
		await Bun.sleep(5);
	}
}

/** Every regular file in the backup store, excluding the per-day index. */
async function backupFiles(): Promise<string[]> {
	const root = getClobberBackupsDir();
	const found: string[] = [];
	const days = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
	for (const day of days) {
		if (!day.isDirectory()) continue;
		for (const entry of await fs.readdir(path.join(root, day.name))) {
			if (entry !== "index.jsonl") found.push(path.join(root, day.name, entry));
		}
	}
	return found.sort();
}

let tempDir: string;
let agentDir: string;
let originalAgentDir: string;

beforeEach(async () => {
	resetSettingsForTest();
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-clobber-work-"));
	agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-clobber-agent-"));
	// Captured as a resolved path, not an env var: only `setAgentDir` rebuilds the
	// resolver, so clearing the variable would leave later test files pointing at
	// the directory this one deletes.
	originalAgentDir = getAgentDir();
	setAgentDir(agentDir);
	await Settings.init({ inMemory: true, cwd: tempDir });
});

afterEach(async () => {
	resetSettingsForTest();
	setAgentDir(originalAgentDir);
	await removeWithRetries(tempDir);
	await removeWithRetries(agentDir);
});

describe("copy-before-clobber: a file this session did not create", () => {
	test("write keeps the replaced bytes and names where it put them", async () => {
		const target = path.join(tempDir, "register.md");
		await fs.writeFile(target, DOOMED);

		const result = await new WriteTool(makeSession(tempDir)).execute("clobber", {
			path: "register.md",
			content: "gone\n",
		});

		expect(await Bun.file(target).text()).toBe("gone\n");
		const backups = await backupFiles();
		expect(backups).toHaveLength(1);
		expect(await Bun.file(backups[0]!).bytes()).toEqual(new TextEncoder().encode(DOOMED));
		expect(path.basename(backups[0]!)).toEndWith("-register.md");
		const text = resultText(result);
		expect(text).toContain("this session did not create it");
		expect(text).toContain(path.basename(backups[0]!));
	});

	test("the day's index records where the bytes came from", async () => {
		await fs.writeFile(path.join(tempDir, "register.md"), DOOMED);
		await new WriteTool(makeSession(tempDir)).execute("clobber", { path: "register.md", content: "gone\n" });

		const day = (await fs.readdir(getClobberBackupsDir()))[0]!;
		const index = await Bun.file(path.join(getClobberBackupsDir(), day, "index.jsonl")).text();
		const entry = JSON.parse(index.trim()) as Record<string, unknown>;
		expect(entry.from).toBe(path.join(tempDir, "register.md"));
		expect(entry.reason).toBe("not-created-here");
		expect(entry.bytes).toBe(DOOMED.length);
		expect(await Bun.file(entry.to as string).text()).toBe(DOOMED);
	});

	test("a file this session created is replaced without a copy", async () => {
		const session = makeSession(tempDir);
		const tool = new WriteTool(session);
		await tool.execute("create", { path: "scratch.md", content: DOOMED });
		expect(await backupFiles()).toHaveLength(0);

		const result = await tool.execute("rewrite", { path: "scratch.md", content: "second\n" });

		expect(await backupFiles()).toHaveLength(0);
		expect(resultText(result)).not.toContain("[Backup]");
		expect(await Bun.file(path.join(tempDir, "scratch.md")).text()).toBe("second\n");
	});

	test("edit keeps the whole pre-edit file, not just the replaced region", async () => {
		await fs.writeFile(path.join(tempDir, "register.md"), DOOMED);

		const result = await new EditTool(makeSession(tempDir), "patch").execute("edit-clobber", {
			path: "register.md",
			edits: [{ op: "update", diff: "@@\n-register entry 2\n+clobbered" }],
		});

		expect(result.isError).toBeFalsy();
		const backups = await backupFiles();
		expect(backups).toHaveLength(1);
		expect(await Bun.file(backups[0]!).text()).toBe(DOOMED);
		expect(resultText(result)).toContain("this session did not create it");
	});

	test("replacing one archive member keeps the container it republished", async () => {
		const archive = path.join(tempDir, "bundle.tar");
		await writeArchive(archive, "tar", new Map([["notes.md", DOOMED]]));
		const before = await Bun.file(archive).bytes();

		const result = await new WriteTool(makeSession(tempDir)).execute("archive-clobber", {
			path: "bundle.tar:notes.md",
			content: "gone\n",
		});

		const backups = await backupFiles();
		expect(backups).toHaveLength(1);
		expect(await Bun.file(backups[0]!).bytes()).toEqual(before);
		expect(resultText(result)).toContain("this session did not create it");
		const member = (await readArchiveEntries({ path: archive, format: "tar" })).get("notes.md");
		expect(await new Response(member).text()).toBe("gone\n");
	});

	test("deleting a file this session did not create keeps its bytes", async () => {
		const target = path.join(tempDir, "register.md");
		await fs.writeFile(target, DOOMED);

		const result = await new EditTool(makeSession(tempDir), "patch").execute("edit-delete", {
			path: "register.md",
			edits: [{ op: "delete" }],
		});

		expect(result.isError).toBeFalsy();
		expect(await Bun.file(target).exists()).toBe(false);
		const backups = await backupFiles();
		expect(backups).toHaveLength(1);
		expect(await Bun.file(backups[0]!).text()).toBe(DOOMED);
		expect(resultText(result)).toContain("this session did not create it");
	});

	test("a file this session created and another writer then replaced is no longer its own", async () => {
		const session = makeSession(tempDir);
		const tool = new WriteTool(session);
		await tool.execute("create", { path: "scratch.md", content: "mine\n" });
		// A different process replaces the content behind this session's back.
		await fs.writeFile(path.join(tempDir, "scratch.md"), DOOMED);

		const result = await tool.execute("rewrite", { path: "scratch.md", content: "gone\n" });

		const backups = await backupFiles();
		expect(backups).toHaveLength(1);
		expect(await Bun.file(backups[0]!).text()).toBe(DOOMED);
		expect(resultText(result)).toContain("it changed since this session wrote it");
	});

	test("a file over the size limit is reported rather than copied", async () => {
		const target = path.join(tempDir, "huge.bin");
		await fs.writeFile(target, "x");
		await fs.truncate(target, 65 * 1024 * 1024);

		const backup = await backupBeforeClobber(makeSession(tempDir), target);

		expect(backup).toMatchObject({ kind: "too-large", reason: "not-created-here", bytes: 65 * 1024 * 1024 });
		expect(await backupFiles()).toHaveLength(0);
	});

	test("an unwritable backup store reports the loss instead of failing the write", async () => {
		await fs.writeFile(path.join(tempDir, "register.md"), DOOMED);
		// A regular file where the store's directory belongs: every mkdir under it fails.
		await fs.writeFile(getClobberBackupsDir(), "not a directory\n");

		const result = await new WriteTool(makeSession(tempDir)).execute("clobber", {
			path: "register.md",
			content: "gone\n",
		});

		expect(await Bun.file(path.join(tempDir, "register.md")).text()).toBe("gone\n");
		expect(resultText(result)).toContain("could not be copied aside");
		expect(resultText(result)).toContain("not recoverable from here");
		// The quoted errno message carries the store path; the home directory must
		// not ride into the model's context with it.
		expect(resultText(result)).not.toContain(os.homedir());
	});

	test("an edit create that overwrites a file copies it aside, then owns it", async () => {
		const target = path.join(tempDir, "register.md");
		await fs.writeFile(target, DOOMED);
		const session = makeSession(tempDir);

		const created = await new EditTool(session, "patch").execute("edit-create-over", {
			path: "register.md",
			edits: [{ op: "create", diff: "replacement\n" }],
		});

		expect(created.isError).toBeFalsy();
		expect(await Bun.file(target).text()).toBe("replacement\n");
		expect(await Bun.file((await backupFiles())[0]!).text()).toBe(DOOMED);
		// The pre-session content is safe now, so the session's own later writes
		// to this file destroy only its own output and are not copied again.
		const second = await new WriteTool(session).execute("rewrite", { path: "register.md", content: "gone\n" });
		expect(await backupFiles()).toHaveLength(1);
		expect(resultText(second)).not.toContain("[Backup]");
	});

	test("a copy whose index entry cannot be written is still reported as saved", async () => {
		await fs.writeFile(path.join(tempDir, "register.md"), DOOMED);
		const now = new Date();
		const day = `${now.getFullYear()}-${`${now.getMonth() + 1}`.padStart(2, "0")}-${`${now.getDate()}`.padStart(2, "0")}`;
		// A directory where the day's index belongs: the copy lands, the append does not.
		await fs.mkdir(path.join(getClobberBackupsDir(), day, "index.jsonl"), { recursive: true });

		const result = await new WriteTool(makeSession(tempDir)).execute("clobber", {
			path: "register.md",
			content: "gone\n",
		});

		const backups = await backupFiles();
		expect(backups).toHaveLength(1);
		expect(await Bun.file(backups[0]!).text()).toBe(DOOMED);
		expect(resultText(result)).toContain("were copied to");
		expect(resultText(result)).not.toContain("could not be copied aside");
	});

	test("a move that also rewrites its source keeps the source's pre-move content", async () => {
		await fs.writeFile(path.join(tempDir, "a.md"), DOOMED);

		// Patch mode refuses a rename onto an existing destination and refuses an
		// update with no hunks, so the rewritten source is the half of the move
		// branch this mode can reach.
		const rewritten = await new EditTool(makeSession(tempDir), "patch").execute("move-rewrite", {
			path: "a.md",
			edits: [{ op: "update", diff: "@@\n-register entry 2\n+clobbered", rename: "a-moved.md" }],
		});

		expect(rewritten.isError).toBeFalsy();
		expect(await Bun.file(path.join(tempDir, "a.md")).exists()).toBe(false);
		const backups = await backupFiles();
		expect(backups).toHaveLength(1);
		expect(await Bun.file(backups[0]!).text()).toBe(DOOMED);
	});

	test("a move whose rewrite is the same length still keeps the source", async () => {
		// The branch that reads and compares the bytes only runs when length
		// cannot answer; the test above never reaches it.
		await fs.writeFile(path.join(tempDir, "a.md"), DOOMED);

		const rewritten = await new EditTool(makeSession(tempDir), "patch").execute("move-rewrite-same-length", {
			path: "a.md",
			edits: [{ op: "update", diff: "@@\n-register entry 2\n+register entry 9", rename: "a-moved.md" }],
		});

		expect(rewritten.isError).toBeFalsy();
		expect(await Bun.file(path.join(tempDir, "a-moved.md")).text()).toBe(DOOMED.replace("entry 2", "entry 9"));
		const backups = await backupFiles();
		expect(backups).toHaveLength(1);
		expect(await Bun.file(backups[0]!).text()).toBe(DOOMED);
	});

	/** The system `touch`; Bun's builtin has no `-r`, and nothing in `node:fs` restores a timestamp to the nanosecond. */
	const systemTouch = $which("touch");

	test.skipIf(systemTouch === null)(
		"a session-created file another writer replaced with its timestamps preserved is no longer its own",
		async () => {
			const touch = async (...args: string[]): Promise<void> => {
				const proc = Bun.spawn([systemTouch!, ...args], { stdout: "ignore", stderr: "ignore" });
				expect(await proc.exited).toBe(0);
			};
			const session = makeSession(tempDir);
			const tool = new WriteTool(session);
			const target = path.join(tempDir, "scratch.md");
			await tool.execute("create", { path: "scratch.md", content: DOOMED });
			const mine = await fs.stat(target);
			// The timestamps come back through `touch -r`, which restores them to
			// the nanosecond. `utimes` restores milliseconds, and the mtime check
			// would then catch the swap on its own — leaving this test green with
			// `ctimeMs` removed. What is left here is the real case: same size,
			// same inode, same mtime to the nanosecond, different content.
			const theirContent = DOOMED.replace("entry 2", "entry 9");
			const stamp = path.join(tempDir, "stamp.md");
			await fs.writeFile(stamp, "");
			await touch("-r", target, stamp);
			await fs.writeFile(target, theirContent);
			await touch("-r", stamp, target);
			const theirs = await fs.stat(target);
			expect(theirs.size).toBe(mine.size);
			expect(theirs.ino).toBe(mine.ino);
			expect(theirs.mtimeMs).toBe(mine.mtimeMs);

			const result = await tool.execute("rewrite", { path: "scratch.md", content: "gone\n" });

			const backups = await backupFiles();
			expect(backups).toHaveLength(1);
			expect(await Bun.file(backups[0]!).text()).toBe(theirContent);
			expect(resultText(result)).toContain("it changed since this session wrote it");
		},
	);

	test("a completed day over the budget is swept even when its index does not account for it", async () => {
		// 33 x 64 MiB of sparse copies, none named by the index and all in a
		// subdirectory: the two shapes that let a day outlive the budget while the
		// index was trusted for sizes.
		const old = path.join(getClobberBackupsDir(), completedDay());
		const nested = path.join(old, "nested");
		await fs.mkdir(nested, { recursive: true });
		for (let i = 0; i < 33; i++) {
			const file = path.join(nested, `copy-${i}.md`);
			await fs.writeFile(file, "x");
			await fs.truncate(file, 64 * 1024 * 1024);
		}
		await fs.writeFile(path.join(old, "index.jsonl"), `${JSON.stringify({ bytes: 1, to: "nowhere" })}\n`);
		await fs.writeFile(path.join(tempDir, "register.md"), DOOMED);

		// Any backup triggers the day's first sweep.
		await new WriteTool(makeSession(tempDir)).execute("clobber", { path: "register.md", content: "gone\n" });

		await untilGone(path.join(nested, "copy-0.md"));
		expect(await backupFiles()).toHaveLength(1);
	});

	test("a completed day whose index alone is over the budget is swept", async () => {
		// The count gate reasons from the per-file cap, and the index is the one
		// file no cap applies to. Left uncounted, a day of any size rides under it.
		const old = path.join(getClobberBackupsDir(), completedDay());
		await fs.mkdir(old, { recursive: true });
		const kept = path.join(old, "copy.md");
		await fs.writeFile(kept, "small\n");
		const index = path.join(old, "index.jsonl");
		await fs.writeFile(index, `${JSON.stringify({ bytes: 1, to: kept })}\n`);
		await fs.truncate(index, 3 * 1024 * 1024 * 1024);
		await fs.writeFile(path.join(tempDir, "register.md"), DOOMED);

		await new WriteTool(makeSession(tempDir)).execute("clobber", { path: "register.md", content: "gone\n" });

		await untilGone(kept);
		expect(await backupFiles()).toHaveLength(1);
	});

	test("a copy that outgrew the per-file cap is weighed, not assumed", async () => {
		// A source another writer extends between the cap's `stat` and the copy
		// lands a copy above the cap. The count gate would charge it 64 MiB
		// forever; the mark is what makes it get measured instead.
		const old = path.join(getClobberBackupsDir(), completedDay());
		await fs.mkdir(old, { recursive: true });
		const grew = path.join(old, "120000000-abcdef12-grew.md.oversize");
		await fs.writeFile(grew, "x");
		await fs.truncate(grew, 3 * 1024 * 1024 * 1024);
		await fs.writeFile(path.join(old, "index.jsonl"), `${JSON.stringify({ bytes: 1, to: grew })}\n`);
		await fs.writeFile(path.join(tempDir, "register.md"), DOOMED);

		await new WriteTool(makeSession(tempDir)).execute("clobber", { path: "register.md", content: "gone\n" });

		await untilGone(grew);
		expect(await backupFiles()).toHaveLength(1);
	});

	test("editing a file this session did not create copies it once, not once per edit", async () => {
		// The ordinary path in a coding session: repeated edits to a tracked file
		// nobody in this session authored. The first edit insures the content that
		// was there before; every edit after that destroys only this session's own
		// previous edit, which is not what the copy exists to protect.
		await fs.writeFile(path.join(tempDir, "register.md"), DOOMED);
		const tool = new EditTool(makeSession(tempDir), "patch");

		const first = await tool.execute("edit-1", {
			path: "register.md",
			edits: [{ op: "update", diff: "@@\n-register entry 1\n+edited once" }],
		});
		const second = await tool.execute("edit-2", {
			path: "register.md",
			edits: [{ op: "update", diff: "@@\n-register entry 2\n+edited twice" }],
		});
		const third = await tool.execute("edit-3", {
			path: "register.md",
			edits: [{ op: "update", diff: "@@\n-register entry 3\n+edited thrice" }],
		});

		expect([first, second, third].every(result => !result.isError)).toBe(true);
		const backups = await backupFiles();
		expect(backups).toHaveLength(1);
		expect(await Bun.file(backups[0]!).text()).toBe(DOOMED);
		expect(resultText(first)).toContain("[Backup]");
		expect(resultText(second)).not.toContain("[Backup]");
		expect(resultText(third)).not.toContain("[Backup]");
	});

	test("the setting turns the whole thing off, and the write still lands", async () => {
		const target = path.join(tempDir, "register.md");
		await fs.writeFile(target, DOOMED);
		const session = makeSession(tempDir);
		session.settings = Settings.isolated({ "edit.mode": "patch", "edit.clobberBackup": false });

		const result = await new WriteTool(session).execute("clobber", { path: "register.md", content: "gone\n" });

		expect(await Bun.file(target).text()).toBe("gone\n");
		expect(await backupFiles()).toHaveLength(0);
		expect(resultText(result)).not.toContain("[Backup]");
		// Nothing is left behind either: no store directory is created at all.
		expect(await Bun.file(getClobberBackupsDir()).exists()).toBe(false);
	});

	test("a multibyte name leaves room for the oversize mark", async () => {
		// 78 CJK characters are 78 JavaScript characters and 234 UTF-8 bytes. A
		// name capped by characters produced a 253-byte backup name, and the
		// rename to `.oversize` then failed with ENAMETOOLONG: the copy stayed
		// unmarked and the budget charged it the per-file cap for the day.
		const name = `${"界".repeat(78)}.md`;
		await fs.writeFile(path.join(tempDir, name), DOOMED);

		await new WriteTool(makeSession(tempDir)).execute("clobber", { path: name, content: "gone\n" });

		const backups = await backupFiles();
		expect(backups).toHaveLength(1);
		expect(await Bun.file(backups[0]!).text()).toBe(DOOMED);
		const basename = path.basename(backups[0]!);
		expect(Buffer.byteLength(basename, "utf8") + ".oversize".length).toBeLessThanOrEqual(255);
		// Cut on a code-point boundary, so the name is still readable.
		expect(basename).not.toContain("\uFFFD");
		expect(basename).toEndWith(".md");
	});
});

describe("copy-before-clobber: another session's directory", () => {
	/** `<sessions root>/<project>/<stamp>_<id>.jsonl`, the layout session files are written in. */
	function sessionFile(id: string): string {
		return path.join(getSessionsDir(), "-tmp-project", `2026-11-05T00-00-00_${id}.jsonl`);
	}

	test("a write under another session's transcript directory is copied aside even when this session made the file", async () => {
		const mine = sessionFile("mine");
		const theirs = path.dirname(sessionFile("theirs"));
		const target = path.join(theirs, "2026-11-05T00-00-00_theirs", "notes.md");
		const session = makeSession(tempDir, mine);
		const tool = new WriteTool(session);

		// This session creates the file, so only the foreign directory can be
		// what makes the second write worth insuring.
		await tool.execute("create", { path: target, content: DOOMED });
		expect(await backupFiles()).toHaveLength(0);

		const result = await tool.execute("clobber", { path: target, content: "gone\n" });

		const backups = await backupFiles();
		expect(backups).toHaveLength(1);
		expect(await Bun.file(backups[0]!).text()).toBe(DOOMED);
		expect(resultText(result)).toContain("it is inside another session's directory");
	});

	test("a session's own artifacts directory is its own", async () => {
		const mine = sessionFile("mine");
		const target = path.join(mine.slice(0, -".jsonl".length), "plan.md");
		const tool = new WriteTool(makeSession(tempDir, mine));

		await tool.execute("create", { path: target, content: DOOMED });
		const result = await tool.execute("rewrite", { path: target, content: "second\n" });

		expect(await backupFiles()).toHaveLength(0);
		expect(resultText(result)).not.toContain("[Backup]");
	});

	test("a session's own transcript file is its own", async () => {
		const mine = sessionFile("mine");
		const tool = new WriteTool(makeSession(tempDir, mine));

		await tool.execute("create", { path: mine, content: DOOMED });
		const result = await tool.execute("rewrite", { path: mine, content: "second\n" });

		expect(await backupFiles()).toHaveLength(0);
		expect(resultText(result)).not.toContain("[Backup]");
	});
});

describe("copy-before-clobber: a record must not claim bytes this session never wrote", () => {
	test("a rename that rewrites nothing leaves the destination's bytes insured", async () => {
		// The destination now holds the SOURCE's content. A plain rename loses
		// nothing, so there is nothing to copy yet — but the session did not write
		// those bytes, and the write that replaces them is the one that must.
		await fs.writeFile(path.join(tempDir, "a.md"), DOOMED);
		const session = makeSession(tempDir);

		const moved = await new EditTool(session, "patch").execute("move-only", {
			path: "a.md",
			edits: [{ op: "update", rename: "a-moved.md", diff: "@@\n register entry 1\n register entry 2" }],
		});

		expect(moved.isError).toBeFalsy();
		expect(await Bun.file(path.join(tempDir, "a-moved.md")).text()).toBe(DOOMED);
		expect(await backupFiles()).toHaveLength(0);

		const clobbered = await new WriteTool(session).execute("clobber", {
			path: "a-moved.md",
			content: "gone\n",
		});

		const backups = await backupFiles();
		expect(backups).toHaveLength(1);
		expect(await Bun.file(backups[0]!).text()).toBe(DOOMED);
		expect(resultText(clobbered)).toContain("this session did not create it");
	});

	test("a rename of a file this session wrote carries the exemption to the destination", async () => {
		// The other half: the bytes the rename carried ARE this session's own, so
		// the destination inherits the exemption and the next write copies nothing.
		const session = makeSession(tempDir);
		await new WriteTool(session).execute("create", { path: "a.md", content: DOOMED });

		const moved = await new EditTool(session, "patch").execute("move-own", {
			path: "a.md",
			edits: [{ op: "update", rename: "a-moved.md", diff: "@@\n register entry 1\n register entry 2" }],
		});
		expect(moved.isError).toBeFalsy();
		const after = await new WriteTool(session).execute("rewrite", { path: "a-moved.md", content: "gone\n" });

		expect(await backupFiles()).toHaveLength(0);
		expect(resultText(after)).not.toContain("[Backup]");
	});

	test.skipIf(process.getuid?.() === 0)(
		"an edit the tool rejected because it never landed does not claim the file",
		async () => {
			// A registered write fallback that reports success without writing is the
			// real shape of "the write said it worked and disk still holds the
			// pre-image": the edit tool's own post-write check rejects it. The record
			// must not be taken for a write that did not happen, or the next write of
			// the same file destroys the pre-image without a word to the model.
			const target = path.join(tempDir, "register.md");
			await fs.writeFile(target, DOOMED);
			await fs.chmod(target, 0o444);
			const removeFallback = addFileWriteFallback(async () => true);
			try {
				const session = makeSession(tempDir);
				const failed = await new EditTool(session, "patch").execute("edit-unlanded", {
					path: "register.md",
					edits: [{ op: "update", diff: "@@\n-register entry 2\n+clobbered" }],
				});

				expect(resultText(failed)).toContain("did not change on disk");
				expect(await Bun.file(target).text()).toBe(DOOMED);
				expect(await backupFiles()).toHaveLength(1);

				// The retry, now permitted to land, destroys bytes nobody in this
				// session wrote: it is insured and the model is told so.
				await fs.chmod(target, 0o644);
				const retried = await new EditTool(session, "patch").execute("edit-retry", {
					path: "register.md",
					edits: [{ op: "update", diff: "@@\n-register entry 2\n+clobbered" }],
				});

				expect(retried.isError).toBeFalsy();
				expect(await backupFiles()).toHaveLength(2);
				expect(resultText(retried)).toContain("this session did not create it");
			} finally {
				removeFallback();
			}
		},
	);

	test("a batch flush claims only what it rewrote, not what it merely read", async () => {
		// A batched write commits its bytes immediately and is post-processed at
		// the flush. When the post-processing rewrites the file the flush is its
		// last writer and has to say so, or the caller's record is stale and the
		// session re-insures its own formatted file. When it rewrites nothing,
		// saying so would hand the caller whatever another process left there
		// between the two tool calls.
		const settled: string[] = [];
		const writethrough = createLspWritethrough(tempDir, {
			onFileSettled: dst => {
				settled.push(dst);
			},
		});
		const first = path.join(tempDir, "one.md");
		const second = path.join(tempDir, "two.md");
		const batchId = "flush-settled";

		await writethrough(first, "one\n", undefined, undefined, { id: batchId, flush: false });
		// Another process replaces the committed file between the two calls.
		await fs.writeFile(first, DOOMED);
		await writethrough(second, "two\n", undefined, undefined, { id: batchId, flush: true });

		// No formatter ran, so the flush wrote nothing and claims nothing.
		expect(settled).toEqual([]);
		expect(await Bun.file(first).text()).toBe(DOOMED);
		expect(await Bun.file(second).text()).toBe("two\n");
	});

	test("a batched write another process replaced before the flush is still insured", async () => {
		// The same hole through the real tool: the external write lands between
		// two completed tool calls, nowhere near the one-`stat` record window, so
		// nothing may make it the session's own.
		const session = makeSession(tempDir);
		session.enableLsp = true;
		const tool = new WriteTool(session);
		const first = batchContext("external-batch", 0);
		const flush = batchContext("external-batch", 1);

		await tool.execute("first", { path: "a.md", content: "own\n" }, undefined, undefined, first);
		await fs.writeFile(path.join(tempDir, "a.md"), DOOMED);
		await tool.execute("flush", { path: "b.md", content: "other\n" }, undefined, undefined, flush);
		const destroyed = await tool.execute("destroy", { path: "a.md", content: "gone\n" });

		const backups = await backupFiles();
		expect(backups).toHaveLength(1);
		expect(await Bun.file(backups[0]!).text()).toBe(DOOMED);
		expect(resultText(destroyed)).toContain("[Backup]");
	});

	test.skipIf($which("ruff") === null)(
		"a file the batch's formatter rewrote is not re-insured on the next write",
		async () => {
			// The other direction, with a real formatter: the flush rewrites an
			// earlier batch entry, so without the refresh the session's own file
			// reports "changed since this session wrote it" and is copied for
			// nothing — the per-edit cost this whole feature must not add.
			await Bun.write(path.join(tempDir, "ruff.toml"), "line-length = 88\n");
			const session = makeSession(tempDir);
			session.enableLsp = true;
			session.settings = Settings.isolated({
				"edit.mode": "patch",
				"lsp.formatOnWrite": true,
				"lsp.diagnosticsOnWrite": false,
				"lsp.diagnosticsOnEdit": false,
			});
			const tool = new WriteTool(session);
			const first = batchContext("ruff-batch", 0);
			const flush = batchContext("ruff-batch", 1);

			await tool.execute("first", { path: "one.py", content: "x={'a':1}\n" }, undefined, undefined, first);
			const beforeFlush = await Bun.file(path.join(tempDir, "one.py")).text();
			await tool.execute("flush", { path: "two.py", content: "y=[1,2,3]\n" }, undefined, undefined, flush);
			const afterFlush = await Bun.file(path.join(tempDir, "one.py")).text();

			// The formatter really did rewrite the earlier entry at the flush.
			expect(beforeFlush).toBe("x={'a':1}\n");
			expect(afterFlush).toBe('x = {"a": 1}\n');
			expect(await backupBeforeClobber(session, path.join(tempDir, "one.py"))).toBeUndefined();
		},
	);

	test("a move cannot carry one logical session's exemption into another", async () => {
		// A `ToolSession` outlives the logical session it serves. Session A writes
		// the file; the host re-points the session; session B renames it onto an
		// absent path, so nothing at the destination is insured. B must not
		// inherit A's ownership of the bytes it just carried there.
		let id = "session-A";
		const session = makeSession(tempDir);
		session.getSessionId = () => id;
		await new WriteTool(session).execute("create", { path: "a.md", content: DOOMED });
		id = "session-B";

		const moved = await new EditTool(session, "patch").execute("move-across-sessions", {
			path: "a.md",
			edits: [{ op: "update", rename: "b.md", diff: "@@\n register entry 1\n register entry 2" }],
		});
		expect(moved.isError).toBeFalsy();
		const destroyed = await new WriteTool(session).execute("destroy", { path: "b.md", content: "gone\n" });

		const backups = await backupFiles();
		expect(backups).toHaveLength(1);
		expect(await Bun.file(backups[0]!).text()).toBe(DOOMED);
		expect(resultText(destroyed)).toContain("[Backup]");
	});

	test("a rename onto an existing destination keeps what it replaced", async () => {
		// Patch mode refuses a rename onto an existing destination; hashline's
		// `MV` allows it, and is also a rename that rewrites nothing. The
		// destination's bytes are the ones with no other copy anywhere.
		const session = makeSession(tempDir);
		session.settings = Settings.isolated({ "edit.mode": "hashline", "edit.enforceSeenLines": false });
		await Bun.write(path.join(tempDir, "from.md"), DOOMED);
		await Bun.write(path.join(tempDir, "to.md"), "destination entry\n");
		const read = await new ReadTool(session).execute("read", { path: "from.md" });
		const header = resultText(read).split("\n")[0]!;

		const moved = await new EditTool(session, "hashline").execute("move-onto", {
			input: `${header}\nMV to.md`,
		});

		expect(moved.isError).toBeFalsy();
		const backups = await backupFiles();
		expect(backups).toHaveLength(1);
		expect(await Bun.file(backups[0]!).text()).toBe("destination entry\n");
		expect(await Bun.file(path.join(tempDir, "to.md")).text()).toBe(DOOMED);
	});
});
