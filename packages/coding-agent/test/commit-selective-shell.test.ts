import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createDraft } from "@oh-my-pi/pi-coding-agent/commit/selective/draft";
import {
	ChangeJournal,
	type ChangeRecord,
	shellChangeSnapshots,
} from "@oh-my-pi/pi-coding-agent/commit/selective/journal";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { executeBash } from "@oh-my-pi/pi-coding-agent/exec/bash-executor";
import { InternalUrlFilesystem } from "@oh-my-pi/pi-coding-agent/internal-urls/url-filesystem";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const tempDirs: string[] = [];

async function tempDir(tag: string): Promise<string> {
	// Real path: the shell reports paths as the kernel resolves the working directory.
	const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `omp-shell-journal-${tag}-`)));
	tempDirs.push(dir);
	return dir;
}

async function git(cwd: string, args: readonly string[]): Promise<void> {
	const env = { ...process.env, HOME: cwd, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
	const proc = Bun.spawn(["git", "-C", cwd, ...args], { env, stdout: "ignore", stderr: "pipe" });
	const [err, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
	if (code !== 0) throw new Error(`git ${args.join(" ")} failed (${code}): ${err}`);
}

/** A repository with `files` committed. */
async function repoWith(files: Record<string, string>): Promise<string> {
	const root = await tempDir("repo");
	await git(root, ["init", "-q", "-b", "main"]);
	for (const [name, value] of [
		["user.email", "test@example.com"],
		["user.name", "Test"],
		["commit.gpgSign", "false"],
		["core.autocrlf", "false"],
	]) {
		await git(root, ["config", name, value]);
	}
	for (const file in files) await Bun.write(path.join(root, file), files[file]);
	await git(root, ["add", "."]);
	await git(root, ["commit", "-qm", "seed"]);
	return root;
}

/**
 * Run `script` in the embedded shell at `cwd`, journaling what it reports as agent Main's. The
 * script's last command writes `end`, whose report follows every other.
 */
async function runJournaled(script: string, cwd: string, journal: ChangeJournal, end: string): Promise<void> {
	const done = Promise.withResolvers<void>();
	const result = await executeBash(script, {
		cwd,
		timeout: 20_000,
		filesystem: new InternalUrlFilesystem({
			context: { cwd },
			tier: "read",
			onFileChange: change => {
				journal.recordChange({ agent: "Main", tool: "bash", ...shellChangeSnapshots(change) });
				if (change.path === path.join(cwd, end)) done.resolve();
			},
		}).shellFilesystem(),
	});
	expect({ exitCode: result.exitCode, output: result.output }).toEqual({ exitCode: 0, output: "" });
	await done.promise;
}

describe.skipIf(process.platform === "win32")("selective commit of shell changes", () => {
	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true, cwd: os.tmpdir() });
	});

	afterEach(async () => {
		resetSettingsForTest();
		await Promise.all(tempDirs.splice(0).map(dir => removeWithRetries(dir)));
	});

	it("attributes what a command's builtins and redirections wrote, and nothing a spawned program wrote itself", async () => {
		const root = await repoWith({
			"a.ts": "export const a = 1;\n",
			"old.ts": "old\n",
			"gone.ts": "gone\n",
			"log.md": "one\n",
			"dir/x.ts": "x\n",
			".gitignore": "*.log\n",
		});
		const outside = await tempDir("outside");
		const journal = new ChangeJournal(await tempDir("artifacts"));

		await runJournaled(
			[
				"sed -i 's/1/2/' a.ts",
				"cat > new.ts <<'EOF'\nexport const fresh = true;\nEOF",
				"mv old.ts moved.ts",
				"rm gone.ts",
				"echo two >> log.md",
				"cp a.ts copy.ts",
				"mv dir lib",
				// The shell opened `late.txt`; the program it spawned opened `external.txt` itself.
				"/bin/sh -c 'sleep 0.2; echo late' > late.txt",
				"/bin/sh -c 'echo own > external.txt'",
				// Nothing a commit could hold: outside any checkout, or ignored by git.
				`echo scratch > '${outside}/scratch.txt'`,
				"echo noise > build.log",
				"echo end > zz.end",
			].join("\n"),
			root,
			journal,
			"zz.end",
		);

		const draft = await createDraft({ cwd: root, journal, caller: "Main" });
		expect(draft.selection().map(change => change.path)).toEqual([
			"a.ts",
			"copy.ts",
			"dir/x.ts",
			"gone.ts",
			"late.txt",
			"lib/x.ts",
			"log.md",
			"moved.ts",
			"new.ts",
			"old.ts",
			"zz.end",
		]);
		const summary = draft.summary();
		expect(summary).not.toContain("Review:");
		expect(summary).toContain("Unrecorded: 1 path(s)");
		expect(summary).toContain("· external.txt  +1");

		const records = (await journal.read()).filter((entry): entry is ChangeRecord => entry.type === "change");
		expect(records.filter(entry => entry.path.startsWith(outside) || entry.path.endsWith(".log"))).toEqual([]);
		// The redirection's file is compared once the spawned program is done writing through it.
		const late = records.filter(entry => entry.path === path.join(root, "late.txt"));
		expect(await journal.snapshots(late)).toEqual([{ agent: "Main", before: null, after: "late\n" }]);
	});

	it("keeps a later edit of the same file apart from what the shell wrote before it", async () => {
		const root = await repoWith({ "notes.md": "one\ntwo\nthree\n" });
		const journal = new ChangeJournal(await tempDir("artifacts"));

		await runJournaled("sed -i 's/two/2/' notes.md\necho end > zz.end", root, journal, "zz.end");
		// The user edits another line afterwards, outside any tool.
		await Bun.write(path.join(root, "notes.md"), "one\n2\nTHREE\n");

		const draft = await createDraft({ cwd: root, journal, caller: "Main" });
		const notes = draft.selection().find(change => change.path === "notes.md");
		expect(notes?.kind === "text" ? notes.after?.text : undefined).toBe("one\n2\nthree\n");
	});
});
