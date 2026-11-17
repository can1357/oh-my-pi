import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { commitSelection } from "@oh-my-pi/pi-coding-agent/commit/selective/apply";
import { createDraft } from "@oh-my-pi/pi-coding-agent/commit/selective/draft";
import { ChangeJournal } from "@oh-my-pi/pi-coding-agent/commit/selective/journal";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => removeWithRetries(dir)));
});

async function git(cwd: string, args: readonly string[], extraEnv: Record<string, string> = {}): Promise<string> {
	const env = {
		...process.env,
		HOME: cwd,
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_CONFIG_SYSTEM: "/dev/null",
		...extraEnv,
	};
	const proc = Bun.spawn(["git", "-C", cwd, ...args], { env, stdout: "pipe", stderr: "pipe" });
	const [out, err, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (code !== 0) throw new Error(`git ${args.join(" ")} failed (${code}): ${err}`);
	return out;
}

const CHANGELOG = "# Changelog\n\n## [Unreleased]\n\n### Fixed\n\n- Fixed an old bug\n";

/** Repository without commits, and a writer that edits files the way agent edit tools do: journaled. */
async function emptyRepo() {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-selective-"));
	const artifacts = await fs.mkdtemp(path.join(os.tmpdir(), "omp-selective-artifacts-"));
	tempDirs.push(root, artifacts);
	await git(root, ["init", "-q", "-b", "main"]);
	await git(root, ["config", "user.email", "test@example.com"]);
	await git(root, ["config", "user.name", "Test"]);
	await git(root, ["config", "commit.gpgSign", "false"]);
	const journal = ChangeJournal.at(artifacts);
	const write = async (agent: string, parent: string | undefined, file: string, after: string) => {
		const absolute = path.join(root, file);
		const before = await Bun.file(absolute)
			.text()
			.catch(() => null);
		await Bun.write(absolute, after);
		journal.recordChange({ agent, parent, tool: "edit", path: absolute, before, after });
	};
	return { root, journal, write };
}

/**
 * Shared workspace: the user staged a fix in `b.ts` and added a changelog bullet; agent Main
 * edited `a.ts` and added its own bullet; its subagent ParserFix created `parser.ts`.
 */
async function sharedWorkspace() {
	const { root, journal, write } = await emptyRepo();
	await Bun.write(path.join(root, "CHANGELOG.md"), CHANGELOG);
	await Bun.write(path.join(root, "a.ts"), "export const a = 1;\n");
	await Bun.write(path.join(root, "b.ts"), "export const b = 1;\n");
	await git(root, ["add", "."]);
	await git(root, ["commit", "-q", "-m", "seed"]);
	const head = (await git(root, ["rev-parse", "HEAD"])).trim();

	// The user's work, unrecorded: a staged fix and a changelog bullet.
	await Bun.write(path.join(root, "b.ts"), "export const b = 2;\n");
	await git(root, ["add", "b.ts"]);
	const userChangelog = CHANGELOG.replace("### Fixed\n\n", "### Fixed\n\n- Fixed the theme flicker\n");
	await Bun.write(path.join(root, "CHANGELOG.md"), userChangelog);

	await write("Main", undefined, "a.ts", "export const a = 2;\n");
	await write(
		"Main",
		undefined,
		"CHANGELOG.md",
		userChangelog.replace("### Fixed\n\n", "### Fixed\n\n- Fixed /commit\n"),
	);
	await write("ParserFix", "Main", "parser.ts", "export function parse() {}\n");
	await journal.flush();
	return { root, journal, head };
}

describe("selective commit flow", () => {
	it("commits the agent tree's lines and leaves the user's staged and unstaged work alone", async () => {
		const { root, journal, head } = await sharedWorkspace();
		const worktreeBefore = await git(root, ["diff", "HEAD"]);

		const draft = await createDraft({ cwd: root, journal, caller: "Main" });
		const outcome = await commitSelection(
			draft,
			{ subject: "fix(parser): added parse", body: ["- Added the parser."], fixes: 7 },
			{ journal, agent: { agent: "Main" } },
		);

		expect(outcome.parent).toBe(head);
		expect(outcome.paths.sort()).toEqual(["CHANGELOG.md", "a.ts", "parser.ts"]);
		expect(await git(root, ["show", "HEAD:CHANGELOG.md"])).toBe(
			CHANGELOG.replace("### Fixed\n\n", "### Fixed\n\n- Fixed /commit\n"),
		);
		expect(await git(root, ["show", "HEAD:b.ts"])).toBe("export const b = 1;\n");
		expect(await git(root, ["log", "-1", "--format=%B"])).toBe(
			"fix(parser): added parse\n\n- Added the parser.\n\nFixes #7\n\n",
		);
		// The user's staged fix is still exactly what is staged; committed paths show no staged reversal.
		expect((await git(root, ["diff", "--cached", "--name-only"])).trim()).toBe("b.ts");
		// The worktree is untouched: HEAD moved, so only the user's lines remain as changes.
		expect(await git(root, ["diff", "--name-only"])).toBe("CHANGELOG.md\n");
		expect(worktreeBefore).toContain("Fixed the theme flicker");
		expect(await Bun.file(path.join(root, "CHANGELOG.md")).text()).toContain("- Fixed the theme flicker");
	});

	it("syncs the shared index once another git process lets go of its lock", async () => {
		const { root, journal } = await sharedWorkspace();
		// A `git status` elsewhere holds `index.lock` while the commit is made. The lock is a real
		// file the native index writer refuses to take, so only a real delay releases it mid-commit.
		const lock = path.join(root, ".git", "index.lock");
		await Bun.write(lock, "");
		const released = Bun.sleep(250).then(() => fs.rm(lock));

		const draft = await createDraft({ cwd: root, journal, caller: "Main" });
		const outcome = await commitSelection(draft, { subject: "fix: locked" }, { journal, agent: { agent: "Main" } });
		await released;

		expect(outcome.indexNotes).toEqual([]);
		expect((await git(root, ["diff", "--cached", "--name-only"])).trim()).toBe("b.ts");
	});

	it("commits only one subagent's changes when scoped to it", async () => {
		const { root, journal } = await sharedWorkspace();

		const draft = await createDraft({ cwd: root, journal, caller: "Main", agents: "ParserFix" });
		const outcome = await commitSelection(
			draft,
			{ subject: "feat: added parser" },
			{ journal, agent: { agent: "Main" } },
		);

		expect(outcome.paths).toEqual(["parser.ts"]);
		expect((await git(root, ["show", "--name-only", "--format=", "HEAD"])).trim()).toBe("parser.ts");
	});

	it("commits modes, executable deletions, symlinks, BOMs, and non-UTF-8 files exactly as in the worktree", async () => {
		const { root, journal, write } = await emptyRepo();
		const latin1 = (text: string) => Buffer.from(text, "latin1");
		await Bun.write(path.join(root, "run.sh"), "#!/bin/sh\necho run\n");
		await Bun.write(path.join(root, "tool.sh"), "#!/bin/sh\necho tool\n");
		await Bun.write(path.join(root, "plain.txt"), "plain\n");
		await Bun.write(path.join(root, "latin1.txt"), latin1("caf\xe9\n"));
		await Bun.write(path.join(root, "bom.ass"), "placeholder\n");
		await fs.chmod(path.join(root, "run.sh"), 0o755);
		await fs.chmod(path.join(root, "tool.sh"), 0o755);
		await git(root, ["add", "."]);
		await git(root, ["commit", "-q", "-m", "seed"]);

		await fs.chmod(path.join(root, "run.sh"), 0o644);
		await fs.rm(path.join(root, "tool.sh"));
		await write("Main", undefined, "plain.txt", "plain\nmore\n");
		await fs.chmod(path.join(root, "plain.txt"), 0o755);
		await Bun.write(path.join(root, "latin1.txt"), latin1("caf\xe9\nna\xefve\n"));
		await Bun.write(path.join(root, "bom.ass"), "\uFEFF[Script Info]\r\nTitle: d\r\n");
		await fs.symlink("plain.txt", path.join(root, "link"));
		await journal.flush();

		const draft = await createDraft({ cwd: root, journal, caller: "Main" });
		draft.take({ path: "**" });
		await commitSelection(draft, { subject: "chore: committed everything" }, { journal, agent: { agent: "Main" } });

		// The commit is exactly git's own snapshot of the worktree on top of the seed: same paths,
		// bytes, and modes as `git add -A` records into a throwaway index on this filesystem.
		const oracleIndex = { GIT_INDEX_FILE: path.join(root, ".git", "oracle-index") };
		await git(root, ["read-tree", "HEAD~1"], oracleIndex);
		await git(root, ["add", "-A"], oracleIndex);
		expect(await git(root, ["rev-parse", "HEAD^{tree}"])).toBe(await git(root, ["write-tree"], oracleIndex));
		// The shared index and worktree match the commit too.
		expect(await git(root, ["status", "--porcelain"])).toBe("");

		// The fixture really exercised each case: otherwise the snapshot comparison passes vacuously.
		const modes = Object.fromEntries(
			(await git(root, ["ls-tree", "HEAD"]))
				.trim()
				.split("\n")
				.map(line => {
					const [meta, file] = line.split("\t");
					return [file, meta.split(" ")[0]];
				}),
		);
		expect(modes).toEqual(expect.objectContaining({ "bom.ass": "100644", "latin1.txt": "100644", link: "120000" }));
		expect(modes).not.toHaveProperty("tool.sh");
		// Git records executable bits only with core.fileMode, which `git init` turns off where the
		// filesystem has none (NTFS); there a chmod is invisible to git and to the snapshot alike.
		const tracksExecBit = await git(root, ["config", "--type=bool", "--default=true", "--get", "core.filemode"]);
		if (tracksExecBit.trim() === "true") {
			expect(modes).toEqual(expect.objectContaining({ "plain.txt": "100755", "run.sh": "100644" }));
		}
	});

	it("makes the first commit of a repository without commits", async () => {
		const { root, journal, write } = await emptyRepo();
		await write("Main", undefined, "first.txt", "first\n");
		await write("Main", undefined, "second.txt", "second\n");
		await journal.flush();

		const draft = await createDraft({ cwd: root, journal, caller: "Main" });
		expect(draft.summary()).toContain("✓ first.txt  +1  [Main]");
		const report = draft.only(["first.txt", "docs/**", "missing.txt"]);
		expect(report).toContain("Deselected 1 path(s)");
		expect(report).toContain("Unmatched: docs/**, missing.txt");
		expect(draft.selection().map(change => change.path)).toEqual(["first.txt"]);
		const outcome = await commitSelection(draft, { subject: "feat: first" }, { journal, agent: { agent: "Main" } });

		expect(outcome.parent).toBeNull();
		expect(await git(root, ["rev-list", "--count", "HEAD"])).toBe("1\n");
		expect(await git(root, ["ls-tree", "--name-only", "HEAD"])).toBe("first.txt\n");
		expect(await git(root, ["status", "--porcelain"])).toBe("?? second.txt\n");
	});

	it("rejects all-unmatched keep targets without changing a curated selection", async () => {
		const { root, journal, write } = await emptyRepo();
		await write("Main", undefined, "first.txt", "first\n");
		await write("Main", undefined, "second.txt", "second\n");
		await journal.flush();

		const draft = await createDraft({ cwd: root, journal, caller: "Main" });
		draft.drop({ path: "second.txt" });
		const selected = draft.selection();
		expect(selected.map(change => change.path)).toEqual(["first.txt"]);

		expect(() => draft.only(["missing.txt", "docs/**"])).toThrow(
			/No changed path matches .*missing\.txt.*docs\/\*\*/,
		);
		expect(draft.selection()).toEqual(selected);
	});

	it("rejects unmatched take, drop, and show targets without changing the selection", async () => {
		const { root, journal, write } = await emptyRepo();
		await write("Main", undefined, "first.txt", "first\n");
		await journal.flush();

		const draft = await createDraft({ cwd: root, journal, caller: "Main" });
		const selected = draft.selection();
		for (const target of ["missing.txt", "docs/**"]) {
			expect(() => draft.take({ path: target })).toThrow(/No changed path matches/);
			expect(() => draft.drop({ path: target })).toThrow(/No changed path matches/);
			expect(() => draft.show(target)).toThrow(/No changed path matches/);
		}
		expect(draft.selection()).toEqual(selected);
	});

	it("attributes edits journaled through a symlinked directory", async () => {
		const { root, journal } = await emptyRepo();
		const alias = `${root}-alias`;
		tempDirs.push(alias);
		await fs.symlink(root, alias);
		const file = path.join(alias, "notes.md");
		await Bun.write(file, "hello\n");
		journal.recordChange({ agent: "Main", tool: "write", path: file, before: null, after: "hello\n" });
		await journal.flush();

		const draft = await createDraft({ cwd: root, journal, caller: "Main" });
		expect(draft.summary()).toContain("✓ notes.md  +1  [Main]");
	});

	it("lists files a call deleted or renamed under review and commits them once taken", async () => {
		const { root, journal } = await emptyRepo();
		for (const file of ["gone.ts", "old.ts", "legacy/a.ts", "keep/x.ts", "keep/y.ts", "user.ts"]) {
			await Bun.write(path.join(root, file), `export const file = "${file}";\n`);
		}
		await git(root, ["add", "."]);
		await git(root, ["commit", "-q", "-m", "seed"]);
		// `mv` keeps this mtime; only the ctime shows the rename landed inside the call.
		const past = new Date(Date.now() - 3_600_000);
		await fs.utimes(path.join(root, "old.ts"), past, past);
		// The user's deletions: one never named, one under a directory the call names but did not remove.
		await fs.rm(path.join(root, "user.ts"));
		await fs.rm(path.join(root, "keep/y.ts"));

		const start = Date.now();
		await fs.rm(path.join(root, "gone.ts"));
		await fs.rm(path.join(root, "legacy"), { recursive: true });
		await fs.rename(path.join(root, "old.ts"), path.join(root, "new.ts"));
		journal.recordCall({
			agent: "Main",
			tool: "bash",
			start,
			end: Date.now(),
			label: "rm gone.ts",
			script: `rm ${path.join(root, "gone.ts")} && rm -rf ./legacy/ && mv old.ts new.ts && bun test keep`,
		});
		await journal.flush();

		const draft = await createDraft({ cwd: root, journal, caller: "Main" });
		const review = draft
			.summary()
			.split("\n")
			.flatMap(line => line.match(/^ {2}\? (\S+) {2}.*; no edit record; (deleted|modified)/)?.slice(1, 3) ?? []);
		expect(review).toEqual([
			"gone.ts",
			"deleted",
			"legacy/a.ts",
			"deleted",
			"new.ts",
			"modified",
			"old.ts",
			"deleted",
		]);

		for (const file of ["gone.ts", "legacy/a.ts", "new.ts", "old.ts"]) draft.take({ path: file });
		await commitSelection(draft, { subject: "refactor: moved files" }, { journal, agent: { agent: "Main" } });
		expect(await git(root, ["ls-tree", "-r", "--name-only", "HEAD"])).toBe("keep/x.ts\nkeep/y.ts\nnew.ts\nuser.ts\n");
		expect(await git(root, ["status", "--porcelain"])).toBe(" D keep/y.ts\n D user.ts\n");
	});

	it("refuses to commit on a HEAD that moved onto the same lines", async () => {
		const { root, journal } = await sharedWorkspace();
		const draft = await createDraft({ cwd: root, journal, caller: "Main", agents: "self" });
		// Someone else commits a conflicting a.ts meanwhile.
		await git(root, ["commit", "-q", "-m", "other", "--only", "b.ts"]);
		await Bun.write(path.join(root, "a.ts"), "export const a = 3;\n");
		await git(root, ["commit", "-q", "-m", "conflict", "--only", "a.ts"]);

		await expect(
			commitSelection(draft, { subject: "fix: a" }, { journal, agent: { agent: "Main" } }),
		).rejects.toThrow(/HEAD moved .* changed a\.ts/);
	});

	it("refuses to commit during a merge in a linked worktree without changing HEAD or the index", async () => {
		const { root: mainRoot, journal } = await emptyRepo();
		await Bun.write(path.join(mainRoot, "base.txt"), "base\n");
		await git(mainRoot, ["add", "."]);
		await git(mainRoot, ["commit", "-qm", "base"]);
		await git(mainRoot, ["checkout", "-qb", "side"]);
		await Bun.write(path.join(mainRoot, "side.txt"), "side\n");
		await git(mainRoot, ["add", "."]);
		await git(mainRoot, ["commit", "-qm", "side"]);
		await git(mainRoot, ["checkout", "-q", "main"]);
		await Bun.write(path.join(mainRoot, "main.txt"), "main\n");
		await git(mainRoot, ["add", "."]);
		await git(mainRoot, ["commit", "-qm", "main"]);

		const root = `${mainRoot}-linked`;
		tempDirs.push(root);
		await git(mainRoot, ["worktree", "add", "-q", "-b", "topic", root, "main"]);
		await git(root, ["merge", "--no-commit", "--no-ff", "side"]);
		const gitDir = (await git(root, ["rev-parse", "--absolute-git-dir"])).trim();
		const mergeHead = await Bun.file(path.join(gitDir, "MERGE_HEAD")).text();
		const head = await git(root, ["rev-parse", "HEAD"]);
		const staged = await git(root, ["diff", "--cached"]);
		const file = path.join(root, "agent.txt");
		await Bun.write(file, "agent\n");
		journal.recordChange({ agent: "Main", tool: "write", path: file, before: null, after: "agent\n" });
		await journal.flush();

		const draft = await createDraft({ cwd: root, journal, caller: "Main" });
		await expect(
			commitSelection(draft, { subject: "fix: agent" }, { journal, agent: { agent: "Main" } }),
		).rejects.toThrow(/merge is in progress; finish or abort.*git commit/);

		expect(await git(root, ["rev-list", "--count", "HEAD"])).toBe("2\n");
		expect(await git(root, ["rev-parse", "HEAD"])).toBe(head);
		expect(await Bun.file(path.join(gitDir, "MERGE_HEAD")).text()).toBe(mergeHead);
		expect(await git(root, ["diff", "--cached"])).toBe(staged);
	});

	it.each([
		{ operation: "cherry-pick", args: ["cherry-pick", "--no-edit", "side"], marker: "CHERRY_PICK_HEAD" },
		{ operation: "revert", args: ["revert", "--no-edit", "side"], marker: "REVERT_HEAD" },
		{ operation: "rebase", args: ["rebase", "--merge", "side"], marker: "rebase-merge" },
		{ operation: "rebase", args: ["rebase", "--apply", "side"], marker: "rebase-apply" },
		{ operation: "git am", args: ["am", "--3way", ".git/side.patch"], marker: "rebase-apply" },
	])(
		"refuses to commit during $operation ($marker) without changing HEAD or operation state",
		async ({ operation, args, marker }) => {
			const { root, journal, write } = await emptyRepo();
			await Bun.write(path.join(root, "conflict.txt"), "base\n");
			await git(root, ["add", "."]);
			await git(root, ["commit", "-qm", "base"]);
			await git(root, ["checkout", "-qb", "side"]);
			await Bun.write(path.join(root, "conflict.txt"), "side\n");
			await git(root, ["add", "."]);
			await git(root, ["commit", "-qm", "side"]);
			if (operation === "git am") {
				await Bun.write(path.join(root, ".git/side.patch"), await git(root, ["format-patch", "--stdout", "-1"]));
			}
			await git(root, ["checkout", "-q", "main"]);
			await Bun.write(path.join(root, "conflict.txt"), "main\n");
			await git(root, ["add", "."]);
			await git(root, ["commit", "-qm", "main"]);
			await expect(git(root, args)).rejects.toThrow(operation === "git am" ? /failed \(128\)/ : /failed \(1\)/);
			const gitDir = (await git(root, ["rev-parse", "--absolute-git-dir"])).trim();
			const state = await fs.readdir(gitDir);
			expect(state).toContain(marker);
			const head = await git(root, ["rev-parse", "HEAD"]);
			const staged = await git(root, ["diff", "--cached"]);
			await write("Main", undefined, "agent.txt", "agent\n");
			await journal.flush();

			const draft = await createDraft({ cwd: root, journal, caller: "Main" });
			await expect(
				commitSelection(draft, { subject: "fix: agent" }, { journal, agent: { agent: "Main" } }),
			).rejects.toThrow(new RegExp(`${operation} is in progress; finish or abort.*git commit`));

			expect(await git(root, ["rev-parse", "HEAD"])).toBe(head);
			expect(await fs.readdir(gitDir)).toEqual(state);
			expect(await git(root, ["diff", "--cached"])).toBe(staged);
		},
	);

	it("refuses an unmerged index without state files when stash pop conflicts after drafting", async () => {
		const { root, journal, write } = await emptyRepo();
		await Bun.write(path.join(root, "conflict.txt"), "base\n");
		await git(root, ["add", "."]);
		await git(root, ["commit", "-qm", "base"]);
		await Bun.write(path.join(root, "conflict.txt"), "stashed\n");
		await git(root, ["stash", "push", "-m", "stashed"]);
		await Bun.write(path.join(root, "conflict.txt"), "main\n");
		await git(root, ["add", "."]);
		await git(root, ["commit", "-qm", "main"]);
		await write("Main", undefined, "agent.txt", "agent\n");
		await journal.flush();
		const draft = await createDraft({ cwd: root, journal, caller: "Main" });
		await expect(git(root, ["stash", "pop"])).rejects.toThrow(/failed \(1\)/);
		const gitDir = (await git(root, ["rev-parse", "--absolute-git-dir"])).trim();
		const state = await fs.readdir(gitDir);
		for (const marker of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply"]) {
			expect(state).not.toContain(marker);
		}
		const head = await git(root, ["rev-parse", "HEAD"]);
		const index = await git(root, ["ls-files", "--stage"]);
		expect(await git(root, ["ls-files", "--unmerged"])).toContain("conflict.txt");
		const conflict = await Bun.file(path.join(root, "conflict.txt")).text();

		await expect(
			commitSelection(draft, { subject: "fix: agent" }, { journal, agent: { agent: "Main" } }),
		).rejects.toThrow(/index has unresolved conflicts; resolve them before using commit/);

		expect(await git(root, ["rev-parse", "HEAD"])).toBe(head);
		expect(await git(root, ["ls-files", "--stage"])).toBe(index);
		expect(await fs.readdir(gitDir)).toEqual(state);
		expect(await Bun.file(path.join(root, "conflict.txt")).text()).toBe(conflict);
	});

	it("rejects an unknown hunk unit id without changing the selection", async () => {
		const { root, journal, write } = await emptyRepo();
		await Bun.write(path.join(root, "a.ts"), "export const a = 1;\n");
		await Bun.write(path.join(root, "b.ts"), "export const b = 1;\n");
		await git(root, ["add", "."]);
		await git(root, ["commit", "-q", "-m", "seed"]);
		await write("Main", undefined, "a.ts", "export const a = 2;\nexport const extra = 3;\n");
		await write(
			"Other",
			undefined,
			"a.ts",
			"export const a = 2;\nexport const extra = 3;\nexport const foreign = 4;\n",
		);
		await write("Main", undefined, "b.ts", "export const b = 2;\n");
		await journal.flush();

		const draft = await createDraft({ cwd: root, journal, caller: "Main" });
		const selected = draft.diff();
		expect(selected).toContain("export const a = 2");
		expect(selected).not.toContain("foreign");

		expect(() => draft.take({ path: "a.ts", units: ["1z"] })).toThrow(/a\.ts has no unit "1z"/);
		expect(() => draft.drop({ path: "a.ts", units: ["1z"] })).toThrow(/a\.ts has no unit "1z"/);
		// b.ts has hunk 1 but no unit 1b; the call must fail before a.ts's 1b is selected.
		expect(() => draft.take({ path: "*.ts", units: ["1b"] })).toThrow(/has no unit "1b"/);
		expect(() => draft.take({ path: "a.ts", units: ["1b", "1z"] })).toThrow(/a\.ts has no unit "1z"/);
		expect(draft.diff()).toBe(selected);

		expect(draft.take({ path: "a.ts", units: ["1b"] })).toBe("Selected 1 change line(s).");
		expect(draft.diff()).toContain("+export const foreign = 4;");
		expect(draft.drop({ path: "a.ts", units: ["1a"] })).toBe("Deselected 3 change line(s).");
		expect(draft.diff()).not.toContain("export const extra = 3");

		const byHunk = await createDraft({ cwd: root, journal, caller: "Main" });
		expect(byHunk.take({ path: "a.ts", units: ["1"] })).toBe("Selected 1 change line(s).");
		expect(byHunk.diff()).toContain("+export const foreign = 4;");
		expect(byHunk.diff()).toContain("export const a = 2");
	});

	it.skipIf(process.platform === "win32")("commits a filename that requires a quoted diff header", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-selective-quoted-"));
		const artifacts = await fs.mkdtemp(path.join(os.tmpdir(), "omp-selective-artifacts-"));
		tempDirs.push(root, artifacts);
		await git(root, ["init", "-q", "-b", "main"]);
		await git(root, ["config", "user.email", "test@example.com"]);
		await git(root, ["config", "user.name", "Test"]);
		await git(root, ["config", "commit.gpgSign", "false"]);
		const filename = 'has"quote.txt';
		const file = path.join(root, filename);
		await Bun.write(file, "before\n");
		await git(root, ["add", "--", filename]);
		await git(root, ["commit", "-q", "-m", "seed"]);
		await Bun.write(file, "after\n");
		const journal = ChangeJournal.at(artifacts);
		journal.recordChange({
			agent: "Main",
			tool: "edit",
			path: file,
			before: "before\n",
			after: "after\n",
		});
		await journal.flush();

		const draft = await createDraft({ cwd: root, journal, caller: "Main" });
		const outcome = await commitSelection(
			draft,
			{ subject: "fix: quoted filename" },
			{ journal, agent: { agent: "Main" } },
		);

		expect(outcome.paths).toEqual([filename]);
		expect(await git(root, ["show", `HEAD:${filename}`])).toBe("after\n");
	});
});
