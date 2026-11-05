import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EditTool } from "@oh-my-pi/pi-coding-agent/edit";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { backupBeforeClobber } from "@oh-my-pi/pi-coding-agent/tools/clobber-backup";
import { WriteTool } from "@oh-my-pi/pi-coding-agent/tools/write";
import { getAgentDir, getClobberBackupsDir, getSessionsDir, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";
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

function resultText(result: { content: { type: string; text?: string }[] }): string {
	return result.content.flatMap(block => (block.type === "text" && block.text ? [block.text] : [])).join("\n");
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
		expect(resultText(result)).toContain("this session did not create it");
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
	});

	test("an edit create that overwrites a file keeps it, and does not claim it afterwards", async () => {
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
		// Overwriting a file is not authoring it: the next write is insured too.
		await new WriteTool(session).execute("rewrite", { path: "register.md", content: "gone\n" });
		expect(await backupFiles()).toHaveLength(2);
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

	test("a session-created file another writer replaced in place, timestamps restored, is no longer its own", async () => {
		const session = makeSession(tempDir);
		const tool = new WriteTool(session);
		const target = path.join(tempDir, "scratch.md");
		await tool.execute("create", { path: "scratch.md", content: DOOMED });
		const mine = await fs.stat(target);
		// Same length, same inode, and the timestamps this session left, as far as
		// `utimes` can restore them: a `cp --preserve=timestamps` in miniature.
		const theirContent = DOOMED.replace("entry 2", "entry 9");
		await fs.writeFile(target, theirContent);
		await fs.utimes(target, mine.atime, mine.mtime);
		const theirs = await fs.stat(target);
		expect(theirs.size).toBe(mine.size);
		expect(theirs.ino).toBe(mine.ino);

		const result = await tool.execute("rewrite", { path: "scratch.md", content: "gone\n" });

		const backups = await backupFiles();
		expect(backups).toHaveLength(1);
		expect(await Bun.file(backups[0]!).text()).toBe(theirContent);
		expect(resultText(result)).toContain("this session did not create it");
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
