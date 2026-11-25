/**
 * The base context omp gathers for a workspace (protected git metadata, `.env`-free discovery) and
 * the materialized policy the backend receives (writable entries under a denied path dropped).
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { gatherContext, materialize } from "@oh-my-pi/pi-coding-agent/sandbox/context";
import { TempDir } from "@oh-my-pi/pi-utils";
import { git } from "../helpers/sandbox-test-state";

let scratch: TempDir;
/** `<scratch>`, realpath'd. */
let root: string;
/** `<root>/tmp`: the private temp dir handed to `gatherContext`. */
let tmpdir: string;

beforeEach(() => {
	scratch = TempDir.createSync(path.join(os.tmpdir(), "omp-sandbox-context-"));
	root = fs.realpathSync(scratch.path());
	tmpdir = path.join(root, "tmp");
	fs.mkdirSync(tmpdir);
});

afterEach(() => {
	scratch.removeSync();
});

describe.skipIf(!Bun.which("git"))("gatherContext protected git metadata", () => {
	it("protects the missing `.git` of a workspace below its repository's root", () => {
		const repo = path.join(root, "repo");
		const workspace = path.join(repo, "sub");
		fs.mkdirSync(workspace, { recursive: true });
		git(repo, "init", "-q");
		expect(gatherContext(workspace, tmpdir).protectedPaths).toContain(path.join(workspace, ".git"));
	});

	it("does not protect the `.git` directory of a workspace at its repository's root", () => {
		const workspace = path.join(root, "repo");
		fs.mkdirSync(workspace);
		git(workspace, "init", "-q");
		const { protectedPaths } = gatherContext(workspace, tmpdir);
		expect(protectedPaths).not.toContain(path.join(workspace, ".git"));
		expect(protectedPaths).toContain(path.join(workspace, ".git", "config"));
	});

	it("protects the missing entries of submodule git dirs and linked worktrees", () => {
		const workspace = path.join(root, "repo");
		fs.mkdirSync(workspace);
		git(workspace, "init", "-q");
		const gitDir = path.join(workspace, ".git");
		const submodule = path.join(gitDir, "modules", "sub");
		fs.mkdirSync(submodule, { recursive: true });
		fs.writeFileSync(path.join(submodule, "HEAD"), "ref: refs/heads/main\n");
		const worktree = path.join(gitDir, "worktrees", "wt");
		fs.mkdirSync(worktree, { recursive: true });
		const { protectedPaths } = gatherContext(workspace, tmpdir);
		expect(protectedPaths).toEqual(
			expect.arrayContaining([
				path.join(submodule, "hooks"),
				path.join(submodule, "commondir"),
				path.join(submodule, "config.worktree"),
				path.join(worktree, "commondir"),
				path.join(worktree, "config.worktree"),
			]),
		);
	});
});

describe.skipIf(process.platform === "win32")("gatherContext environment", () => {
	const names = ["CARGO_HOME", "GIT_CONFIG_GLOBAL"] as const;
	let saved: Record<string, string | undefined>;
	let workspace: string;
	let cargo: string;
	let gitconfig: string;

	beforeEach(() => {
		saved = Object.fromEntries(names.map(name => [name, process.env[name]]));
		workspace = path.join(root, "workspace");
		fs.mkdirSync(workspace);
		cargo = path.join(root, "outside", "cargo");
		fs.mkdirSync(path.join(cargo, "bin"), { recursive: true });
		gitconfig = path.join(root, "outside", "gitconfig");
		fs.writeFileSync(gitconfig, "[user]\n\tname = t\n");
		process.env.CARGO_HOME = cargo;
		process.env.GIT_CONFIG_GLOBAL = gitconfig;
	});

	afterEach(() => {
		for (const name of names) {
			if (saved[name] === undefined) delete process.env[name];
			else process.env[name] = saved[name];
		}
	});

	it("widens the read roots by tool variables of the launch environment", () => {
		const context = gatherContext(workspace, tmpdir);
		expect(context.discovered.readonlyPaths).toContain(cargo);
		expect(context.workspaceRead()).toContain(gitconfig);
	});

	it("never widens them by values the workspace's `.env` supplied", () => {
		fs.writeFileSync(path.join(workspace, ".env"), `CARGO_HOME=${cargo}\nGIT_CONFIG_GLOBAL=${gitconfig}\n`);
		const context = gatherContext(workspace, tmpdir);
		expect(context.discovered.readonlyPaths).not.toContain(cargo);
		expect(context.workspaceRead()).not.toContain(gitconfig);
	});
});

describe("materialize", () => {
	it("drops a writable entry at or under a denied path, keeping the others", () => {
		const open = path.join(root, "open");
		const secret = path.join(root, "secret");
		const below = path.join(secret, "sub");
		for (const dir of [open, below]) fs.mkdirSync(dir, { recursive: true });
		const policy = { readwritePaths: [open, below], readonlyPaths: [], deniedPaths: [secret], protectedPaths: [] };
		expect(materialize(policy, process.platform).readwritePaths).toEqual([open]);
		expect(materialize({ ...policy, deniedPaths: [] }, process.platform).readwritePaths).toEqual([open, below]);
	});

	it("keeps a writable root that only contains a denied path", () => {
		const open = path.join(root, "workspace");
		const secret = path.join(open, "secret");
		fs.mkdirSync(secret, { recursive: true });
		const policy = { readwritePaths: [open], readonlyPaths: [], deniedPaths: [secret], protectedPaths: [] };
		expect(materialize(policy, process.platform).readwritePaths).toEqual([open]);
	});
});
