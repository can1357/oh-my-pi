import { afterEach, describe, expect, it, vi } from "bun:test";
import { heapStats } from "bun:jsc";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { commitSelection, type CommitOutcome } from "@oh-my-pi/pi-coding-agent/commit/selective/apply";
import { createDraft } from "@oh-my-pi/pi-coding-agent/commit/selective/draft";
import { ChangeJournal, type JournalRecord } from "@oh-my-pi/pi-coding-agent/commit/selective/journal";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const tempDirs: string[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
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

function commitIsRecorded(journalFile: string, sha: string): boolean {
	let text: string;
	try {
		text = fsSync.readFileSync(journalFile, "utf8");
	} catch {
		return false;
	}
	return text.split("\n").some(line => {
		if (!line) return false;
		try {
			const record: JournalRecord = JSON.parse(line);
			return record.type === "commit" && record.sha === sha;
		} catch {
			return false;
		}
	});
}

async function installSubjectRewriteHook(root: string): Promise<void> {
	await git(root, ["config", "core.hooksPath", ".git/hooks"]);
	const hook = path.join(root, ".git", "hooks", "commit-msg");
	await Bun.write(
		hook,
		"#!/bin/sh\n" +
			"cat > \"$1\" <<'EOF'\n" +
			"fix(notes): kept the rewritten subject\n" +
			"\n" +
			"- Hook rewrote the body.\n" +
			"EOF\n",
	);
	await fs.chmod(hook, 0o755);
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
	// Drafts convert content in-process, reading the developer's global config, where
	// `core.autocrlf` may be set; the oracle `git` above ignores it.
	await git(root, ["config", "core.autocrlf", "false"]);
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

async function gitlinkWorkspace() {
	const workspace = await emptyRepo();
	const { root } = workspace;
	const module = path.join(root, "module");
	await fs.mkdir(module);
	await git(module, ["init", "-q", "-b", "main"]);
	await git(module, ["config", "user.email", "test@example.com"]);
	await git(module, ["config", "user.name", "Test"]);
	await git(module, ["config", "commit.gpgSign", "false"]);
	const commits: string[] = [];
	for (const content of ["one\n", "two\n", "three\n"]) {
		await Bun.write(path.join(module, "content.txt"), content);
		await git(module, ["add", "content.txt"]);
		await git(module, ["commit", "-qm", content.trim()]);
		commits.push((await git(module, ["rev-parse", "HEAD"])).trim());
	}
	const [before, after, later] = commits;
	await git(module, ["checkout", "-q", before]);
	await Bun.write(path.join(root, "user.txt"), "original\n");
	await git(root, ["add", "user.txt"]);
	await git(root, ["update-index", "--add", "--cacheinfo", `160000,${before},module`]);
	await git(root, ["commit", "-qm", "seed gitlink"]);
	await git(module, ["checkout", "-q", after]);
	return { ...workspace, module, before, after, later };
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
	it("never selects a second copy of a paragraph already committed during a reorder", async () => {
		const { root, journal, write } = await emptyRepo();
		const file = "notes.md";
		const contents = (order: string, main = "old", other = "old") =>
			Array.from(order, key => `## ${key}\n\nsame body\n\n\n`).join("") +
			`footer\nmain: ${main}\nseparator\nother: ${other}\n`;
		await Bun.write(path.join(root, file), contents("AB"));
		await git(root, ["add", file]);
		await git(root, ["commit", "-qm", "initial paragraphs"]);
		await write("Main", undefined, file, contents("BAC"));
		await write("Other", undefined, file, contents("BADC", "old", "pending"));
		// Another commit takes D alone without touching the working file.
		await Bun.write(path.join(root, ".git", "snapshot"), contents("ABD"));
		const sha = (await git(root, ["hash-object", "-w", ".git/snapshot"])).trim();
		await git(root, ["update-index", "--cacheinfo", `100644,${sha},${file}`]);
		await git(root, ["commit", "-qm", "take D"]);
		await write("Main", undefined, file, contents("ABCD", "pending", "pending"));
		await journal.flush();
		const draft = await createDraft({ cwd: root, journal, caller: "Main" });
		expect(draft.summary()).toContain("review the net change");
		expect(draft.diff()).toContain("+main: pending");
		expect(draft.diff()).not.toContain("+## B");
		draft.take({ path: file, units: ["1"] }); // C only, not the other writer's footer
		await commitSelection(draft, { subject: "add C" }, { journal, agent: { agent: "Main" } });
		expect(await git(root, ["show", `HEAD:${file}`])).toBe(contents("ABCD", "pending", "old"));
		expect(await Bun.file(path.join(root, file)).text()).toBe(contents("ABCD", "pending", "pending"));
	});

	it("explicitly selects a gitlink SHA with ordinary edits without committing child dirt or other staged work", async () => {
		const { root, module, journal, write, before, after } = await gitlinkWorkspace();
		await Bun.write(path.join(root, "user.txt"), "user staged\n");
		await git(root, ["add", "user.txt"]);
		await write("Main", undefined, "agent.txt", "agent\n");
		await journal.flush();
		await Bun.write(path.join(module, "content.txt"), "child dirty\n");
		const childStatus = await git(module, ["status", "--porcelain"]);
		const draft = await createDraft({ cwd: root, journal, caller: "Main" });

		expect(draft.selection().map(change => change.path)).toEqual(["agent.txt"]);
		expect(draft.skipped).not.toContain("module");
		expect(draft.show()).toContain(`${before} → ${after}`);
		expect(() => draft.take({ path: "module", units: ["2"] })).toThrow(/only unit 1/);
		draft.take({ path: "module", units: ["1"] });
		draft.drop({ path: "module" });
		expect(draft.selection().map(change => change.path)).toEqual(["agent.txt"]);
		draft.take({ path: "module" });
		draft.only(["module", "agent.txt"]);
		expect(draft.diff()).toContain(`-Subproject commit ${before}\n+Subproject commit ${after}\n`);
		const outcome = await commitSelection(
			draft,
			{ subject: "fix: update module and agent" },
			{ journal, agent: { agent: "Main" } },
		);

		expect(outcome.paths.sort()).toEqual(["agent.txt", "module"]);
		expect(outcome.indexNotes).toEqual([]);
		expect(await git(root, ["ls-tree", "HEAD", "module"])).toBe(`160000 commit ${after}\tmodule\n`);
		expect(await git(root, ["show", "HEAD:agent.txt"])).toBe("agent\n");
		expect(await git(root, ["show", "HEAD:user.txt"])).toBe("original\n");
		expect(await git(root, ["diff", "--cached", "--name-only"])).toBe("user.txt\n");
		expect(await git(module, ["status", "--porcelain"])).toBe(childStatus);
		expect(await Bun.file(path.join(module, "content.txt")).text()).toBe("child dirty\n");
	});

	it("does not offer a gitlink update when only files inside the child are dirty", async () => {
		const { root, module, journal, before } = await gitlinkWorkspace();
		await git(module, ["checkout", "-q", before]);
		await Bun.write(path.join(module, "content.txt"), "dirty\n");
		const draft = await createDraft({ cwd: root, journal, caller: "Main" });
		expect(draft.paths).not.toContain("module");
		expect(draft.selection()).toEqual([]);
	});

	it("rejects a changed child HEAD after drafting without changing the parent HEAD or index", async () => {
		const { root, module, journal, later } = await gitlinkWorkspace();
		const draft = await createDraft({ cwd: root, journal, caller: "Main" });
		draft.take({ path: "module" });
		await git(module, ["checkout", "-q", later]);
		const head = await git(root, ["rev-parse", "HEAD"]);
		const index = await git(root, ["ls-files", "--stage"]);
		await expect(
			commitSelection(draft, { subject: "fix: stale" }, { journal, agent: { agent: "Main" } }),
		).rejects.toThrow(/submodule HEAD changed.*new draft/);
		expect(await git(root, ["rev-parse", "HEAD"])).toBe(head);
		expect(await git(root, ["ls-files", "--stage"])).toBe(index);
		expect((await git(module, ["rev-parse", "HEAD"])).trim()).toBe(later);
	});

	it("preserves a different staged gitlink while committing the selected worktree SHA", async () => {
		const { root, journal, after, later } = await gitlinkWorkspace();
		await git(root, ["update-index", "--cacheinfo", `160000,${later},module`]);
		const draft = await createDraft({ cwd: root, journal, caller: "Main" });
		draft.take({ path: "module" });
		const outcome = await commitSelection(
			draft,
			{ subject: "fix: selected pointer" },
			{ journal, agent: { agent: "Main" } },
		);
		expect((await git(root, ["rev-parse", "HEAD:module"])).trim()).toBe(after);
		expect(await git(root, ["ls-files", "--stage", "module"])).toBe(`160000 ${later} 0\tmodule\n`);
		expect(outcome.indexNotes).toEqual([expect.stringContaining("someone else's staged changes")]);
	});

	it("rejects a conflicting superproject commit instead of overwriting its gitlink SHA", async () => {
		const { root, journal, later } = await gitlinkWorkspace();
		const draft = await createDraft({ cwd: root, journal, caller: "Main" });
		draft.take({ path: "module" });
		await git(root, ["update-index", "--cacheinfo", `160000,${later},module`]);
		await git(root, ["commit", "-qm", "other pointer"]);
		const head = await git(root, ["rev-parse", "HEAD"]);
		const index = await git(root, ["ls-files", "--stage"]);
		await expect(
			commitSelection(draft, { subject: "fix: conflict" }, { journal, agent: { agent: "Main" } }),
		).rejects.toThrow(/HEAD moved.*module.*new draft/);
		expect(await git(root, ["rev-parse", "HEAD"])).toBe(head);
		expect(await git(root, ["ls-files", "--stage"])).toBe(index);
	});

	it.each(["uninitialized", "deleted", "file"])(
		"skips an unsupported %s gitlink checkout while still drafting ordinary edits",
		async state => {
			const { root, module, journal, write } = await gitlinkWorkspace();
			await fs.rm(module, { recursive: true });
			if (state === "uninitialized") await fs.mkdir(module);
			if (state === "file") await Bun.write(module, "not a checkout\n");
			await write("Main", undefined, "agent.txt", "agent\n");
			await journal.flush();
			const draft = await createDraft({ cwd: root, journal, caller: "Main" });
			expect(draft.paths).not.toContain("module");
			expect(draft.selection().map(change => change.path)).toEqual(["agent.txt"]);
		},
	);

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

	it.skipIf(process.platform === "win32")(
		"runs hooks without reporting sparse-checkout paths as unstaged deletions",
		async () => {
			const { root, journal, write } = await emptyRepo();
			await Bun.write(path.join(root, "kept/inside"), "before\n");
			await Bun.write(path.join(root, "away/deep/outside"), "outside\n");
			await Bun.write(path.join(root, "away/other"), "other\n");
			await git(root, ["add", "."]);
			await git(root, ["commit", "-q", "-m", "seed"]);
			await git(root, ["sparse-checkout", "init", "--cone", "--sparse-index"]);
			await git(root, ["sparse-checkout", "set", "kept"]);

			// The shared index collapses the excluded subtree to one `away/` entry; the
			// cached diff (index_changes) must expand it, never report it as a change.
			expect((await git(root, ["ls-files", "--sparse"])).trim().split("\n").sort()).toEqual([
				"away/",
				"kept/inside",
			]);
			const repo = vcs.git(root);
			expect(repo).not.toBeNull();
			expect(await repo!.changedFiles({ cached: true })).toEqual([]);

			const marker = path.join(root, ".git", "omp-hook-sparse.txt");
			const hook = path.join(root, ".git/hooks/pre-commit");
			await Bun.write(
				hook,
				[
					"#!/bin/sh",
					"set -e",
					'[ -z "$(git diff --name-only)" ]',
					"git add kept/inside",
					'git ls-files --sparse > "$GIT_DIR/omp-hook-sparse.txt"',
				].join("\n") + "\n",
			);
			await fs.chmod(hook, 0o755);

			await write("Main", undefined, "kept/inside", "after\n");
			await journal.flush();
			const draft = await createDraft({ cwd: root, journal, caller: "Main" });
			await commitSelection(draft, { subject: "fix: sparse commit" }, { journal, agent: { agent: "Main" } });

			// The hook really did hand write_index_tree a collapsed `away/` directory entry.
			expect((await Bun.file(marker).text()).trim().split("\n").sort()).toEqual(["away/", "kept/inside"]);
			expect(await git(root, ["show", "HEAD:kept/inside"])).toBe("after\n");
			expect(await git(root, ["show", "HEAD:away/deep/outside"])).toBe("outside\n");
			expect(await git(root, ["show", "HEAD:away/other"])).toBe("other\n");
			expect((await git(root, ["ls-tree", "-r", "--name-only", "HEAD"])).trim().split("\n").sort()).toEqual([
				"away/deep/outside",
				"away/other",
				"kept/inside",
			]);
			await git(root, ["fsck", "--strict"]);
		},
	);

	it.skipIf(process.platform === "win32")(
		"syncs the shared index to what a formatting pre-commit hook committed",
		async () => {
			const { root, journal, write } = await emptyRepo();
			await Bun.write(path.join(root, "fixture.txt"), "let value = 0\n");
			await Bun.write(path.join(root, "other.txt"), "other\n");
			await git(root, ["add", "."]);
			await git(root, ["commit", "-q", "-m", "seed"]);
			await Bun.write(path.join(root, "other.txt"), "staged by the user\n");
			await git(root, ["add", "other.txt"]);
			await git(root, ["config", "core.hooksPath", ".git/hooks"]);
			// Formats the file in place and stages the result into the index the hook was handed.
			const hook = path.join(root, ".git/hooks/pre-commit");
			await Bun.write(
				hook,
				[
					"#!/bin/sh",
					"set -eu",
					"sed 's/value=/value = /' fixture.txt > fixture.tmp",
					"mv fixture.tmp fixture.txt",
					"blob=$(git hash-object -w fixture.txt)",
					'git update-index --cacheinfo "100644,$blob,fixture.txt"',
				].join("\n") + "\n",
			);
			await fs.chmod(hook, 0o755);

			for (const value of [1, 2]) {
				await write("Main", undefined, "fixture.txt", `let value=${value}\n`);
				await journal.flush();
				const draft = await createDraft({ cwd: root, journal, caller: "Main" });
				const outcome = await commitSelection(
					draft,
					{ subject: `fix: set value ${value}` },
					{ journal, agent: { agent: "Main" } },
				);

				const formatted = `let value = ${value}\n`;
				expect(outcome.indexNotes).toEqual([]);
				expect(await git(root, ["show", "HEAD:fixture.txt"])).toBe(formatted);
				expect(await git(root, ["show", ":fixture.txt"])).toBe(formatted);
				expect(await Bun.file(path.join(root, "fixture.txt")).text()).toBe(formatted);
				// The user's staged work is neither committed nor unstaged.
				expect(await git(root, ["status", "--porcelain"])).toBe("M  other.txt\n");
			}
		},
	);

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

	it("tells an empty repository apart from an empty selection when committing", async () => {
		const { root, journal } = await emptyRepo();
		await Bun.write(path.join(root, "a.ts"), "export const a = 1;\n");
		await git(root, ["add", "."]);
		await git(root, ["commit", "-q", "-m", "seed"]);
		const context = { journal, agent: { agent: "Main" } };

		const clean = await createDraft({ cwd: root, journal, caller: "Main" });
		await expect(commitSelection(clean, { subject: "fix: a" }, context)).rejects.toThrow(
			/Nothing to commit: .* has no changes against HEAD/,
		);

		// Error output must not expose the absolute home directory.
		Object.defineProperty(clean, "root", { value: path.join(os.homedir(), "workspace") });
		await expect(commitSelection(clean, { subject: "fix: a" }, context)).rejects.toThrow(
			"Nothing to commit: ~/workspace has no changes against HEAD.",
		);

		// A nested repository is dirty but skipped: the repository is not clean.
		const nested = path.join(root, "vendor");
		await fs.mkdir(nested);
		await git(nested, ["init", "-q"]);
		const skippedOnly = await createDraft({ cwd: root, journal, caller: "Main" });
		expect(skippedOnly.skipped).toEqual(["vendor"]);
		await expect(commitSelection(skippedOnly, { subject: "fix: a" }, context)).rejects.toThrow(
			"Nothing to commit: only vendor changed (submodule or nested repository), which selective commits skip.",
		);
		await fs.rm(nested, { recursive: true });

		// The user's unjournaled edit is a change, just not selected.
		await Bun.write(path.join(root, "a.ts"), "export const a = 2;\n");
		const unselected = await createDraft({ cwd: root, journal, caller: "Main" });
		await expect(commitSelection(unselected, { subject: "fix: a" }, context)).rejects.toThrow(
			"Nothing selected; use take() first.",
		);
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

	it("returns the subject a commit-msg hook stored on the commit", async () => {
		// The commit summary prints outcome.subject. A hook can replace that line;
		// callers must see the subject on the commit, not the one they submitted.
		const { root, journal, write } = await emptyRepo();
		await installSubjectRewriteHook(root);
		await write("Main", undefined, "notes.txt", "notes\n");
		await journal.flush();

		const draft = await createDraft({ cwd: root, journal, caller: "Main" });
		const outcome = await commitSelection(
			draft,
			{ subject: "chore: original subject", body: ["- Original body."] },
			{ journal, agent: { agent: "Main" } },
		);

		const stored = (await git(root, ["log", "-1", "--format=%s"])).replace(/\n$/, "");
		expect(stored).toBe("fix(notes): kept the rewritten subject");
		expect(outcome.subject).toBe(stored);
		expect(await git(root, ["log", "-1", "--format=%B"])).toContain("- Hook rewrote the body.");
		expect(await git(root, ["log", "-1", "--format=%B"])).not.toContain("Original body");
	});

	it("remembers a saved commit when the caller stops while its subject is read", async () => {
		// Stopping while the subject is read back used to happen before the session
		// recorded the commit, so a later amend was refused. The record is already on
		// disk when that read starts, the read is not cancelled, and the subject is the
		// line the hook stored.
		const { root, journal, write } = await emptyRepo();
		await installSubjectRewriteHook(root);
		await write("Main", undefined, "notes.txt", "notes\n");
		await journal.flush();

		const draft = await createDraft({ cwd: root, journal, caller: "Main" });
		const controller = new AbortController();
		const requireGit = vcs.requireGit.bind(vcs);
		const journalFile = path.join(journal.dir, "changes.jsonl");
		let sawRead = false;
		let recordedBeforeRead = false;
		let readSignal: AbortSignal | undefined;
		const spy = vi.spyOn(vcs, "requireGit").mockImplementation((dir: string) => {
			const repo = requireGit(dir);
			if (path.resolve(repo.info().repoRoot) !== path.resolve(draft.root)) return repo;
			return new Proxy(repo, {
				get(target, prop) {
					if (prop === "commitDetails") {
						return (rev: string, signal?: AbortSignal) => {
							sawRead = true;
							recordedBeforeRead = commitIsRecorded(journalFile, rev);
							readSignal = signal;
							controller.abort();
							return signal === undefined ? target.commitDetails(rev) : target.commitDetails(rev, signal);
						};
					}
					const value: unknown = Reflect.get(target, prop, target);
					return typeof value === "function" ? value.bind(target) : value;
				},
			});
		});
		try {
			let outcome: CommitOutcome | undefined;
			let failure: unknown;
			try {
				outcome = await commitSelection(
					draft,
					{ subject: "chore: original subject", body: ["- Original body."] },
					{ journal, agent: { agent: "Main" }, signal: controller.signal },
				);
			} catch (error) {
				failure = error;
			}
			expect(failure).toBeUndefined();
			if (!outcome) throw new Error("commit did not return an outcome");
			expect(sawRead).toBe(true);
			expect(recordedBeforeRead).toBe(true);
			expect(readSignal).toBeUndefined();
			expect(controller.signal.aborted).toBe(true);
			const stored = (await git(root, ["log", "-1", "--format=%s"])).replace(/\n$/, "");
			expect(stored).toBe("fix(notes): kept the rewritten subject");
			expect(outcome.subject).toBe(stored);

			spy.mockRestore();
			await write("Main", undefined, "notes.txt", "notes\nrevised\n");
			await journal.flush();
			const followUp = await createDraft({ cwd: root, journal, caller: "Main" });
			const amended = await commitSelection(
				followUp,
				{ subject: "fix(notes): amended after a stop", amend: true },
				{ journal, agent: { agent: "Main" } },
			);
			expect(amended.sha).not.toBe(outcome.sha);
			expect((await git(root, ["rev-parse", "HEAD"])).trim()).toBe(amended.sha);
			// The amend replaced the root commit: no parent, the replaced commit named, its paths kept.
			expect(amended.amended).toBe(outcome.sha);
			expect(amended.parent).toBeNull();
			expect(amended.paths).toEqual(["notes.txt"]);
			expect((await git(root, ["rev-list", "--count", "HEAD"])).trim()).toBe("1");
		} finally {
			spy.mockRestore();
		}
	});

	it("shows every file the summary lists under Review", async () => {
		const { root, journal, write } = await emptyRepo();
		await write("Main", undefined, "blob.bin", "binary\0content\n");
		await journal.flush();
		const draft = await createDraft({ cwd: root, journal, caller: "Main" });

		expect(draft.summary()).toContain("? blob.bin  whole binary, non-UTF-8, or large file; edited by Main");
		expect(draft.show()).toBe(
			"blob.bin  whole-file change (binary, non-UTF-8, or large file); edited by Main\n  1 ? whole file",
		);
	});

	it("compares and commits worktree content in its git form", async () => {
		const { root, journal, write } = await emptyRepo();
		await git(root, ["config", "core.autocrlf", "true"]);
		await Bun.write(path.join(root, "notes.txt"), "one\r\ntwo\r\nthree\r\n");
		await git(root, ["add", "notes.txt"]);
		await git(root, ["commit", "-qm", "seed"]);
		await write("Main", undefined, "notes.txt", "one\r\n2\r\nthree\r\n");
		await journal.flush();
		const draft = await createDraft({ cwd: root, journal, caller: "Main" });

		expect(draft.summary()).toContain("✓ notes.txt  +1 −1");
		await commitSelection(draft, { subject: "fix: two" }, { journal, agent: { agent: "Main" } });
		expect(await git(root, ["show", "HEAD:notes.txt"])).toBe("one\n2\nthree\n");
	});

	it("says so when the session keeps no change journal", async () => {
		const { root } = await emptyRepo();
		await Bun.write(path.join(root, "a.txt"), "a\n");
		const draft = await createDraft({ cwd: root, journal: null, caller: "Main" });

		expect(draft.summary()).toContain("No change journal: this session keeps no artifacts");
		expect(draft.summary()).toContain("Not yours: 1 path(s).");
	});

	it("keeps a draft of many untracked files near their size", async () => {
		const { root, journal } = await emptyRepo();
		const body = Array.from({ length: 200 }, (_, line) => String(1_000_000 + line)).join("\n");
		await Promise.all(
			Array.from({ length: 1_000 }, (_, file) => Bun.write(path.join(root, "evidence", `${file}.txt`), `${body}\n`)),
		);
		Bun.gc(true);
		const before = heapStats().heapSize;
		const draft = await createDraft({ cwd: root, journal, caller: "Main" });
		Bun.gc(true);
		const retained = heapStats().heapSize - before;

		// 1.6 MB of text; per-line attribution of every file held ~60 MB.
		expect(retained).toBeLessThan(20 * 1024 * 1024);
		expect(draft.summary()).toContain("Not yours: 1000 path(s).");
	});

	it("commits one taken hunk of a file no edit record explains", async () => {
		const { root, journal } = await emptyRepo();
		const lines = Array.from({ length: 20 }, (_, line) => `line ${line}`);
		await Bun.write(path.join(root, "notes.txt"), `${lines.join("\n")}\n`);
		await git(root, ["add", "."]);
		await git(root, ["commit", "-qm", "seed"]);
		const edited = lines.map((line, index) => (index === 1 || index === 18 ? `${line} edited` : line));
		await Bun.write(path.join(root, "notes.txt"), `${edited.join("\n")}\n`);
		const draft = await createDraft({ cwd: root, journal, caller: "Main" });

		draft.take({ path: "notes.txt", units: ["2"] });
		expect(draft.show("notes.txt")).toContain("+line 18 edited");
		await commitSelection(draft, { subject: "fix: notes" }, { journal, agent: { agent: "Main" } });

		const committed = lines.map((line, index) => (index === 18 ? `${line} edited` : line));
		expect(await git(root, ["show", "HEAD:notes.txt"])).toBe(`${committed.join("\n")}\n`);
	});

	it("reports an amend against the replaced commit's parent with all of its paths", async () => {
		const { root, journal, write } = await emptyRepo();
		await Bun.write(path.join(root, "seed.txt"), "seed\n");
		await git(root, ["add", "seed.txt"]);
		await git(root, ["commit", "-qm", "seed"]);
		const seed = (await git(root, ["rev-parse", "HEAD"])).trim();
		await write("Main", undefined, "a.txt", "a\n");
		await write("Main", undefined, "b.txt", "b\n");
		await journal.flush();
		const first = await commitSelection(
			await createDraft({ cwd: root, journal, caller: "Main" }),
			{ subject: "feat: a and b" },
			{ journal, agent: { agent: "Main" } },
		);

		await write("Main", undefined, "a.txt", "a\nmore\n");
		await journal.flush();
		const amended = await commitSelection(
			await createDraft({ cwd: root, journal, caller: "Main" }),
			{ subject: "feat: a and b", amend: true },
			{ journal, agent: { agent: "Main" } },
		);
		expect(amended.amended).toBe(first.sha);
		expect(amended.parent).toBe(seed);
		expect(amended.paths).toEqual(["a.txt", "b.txt"]);
		expect((await git(root, ["rev-list", "--count", "HEAD"])).trim()).toBe("2");
	});
});
