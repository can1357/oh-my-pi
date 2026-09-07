import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import * as nodeFs from "node:fs";
import { mkdirSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	computeMnemopiBankScope,
	extendRecallWithLegacyBanks,
	projectBankSegment,
} from "@oh-my-pi/pi-coding-agent/mnemopi/config";
import { removeWithRetries, TempDir } from "@oh-my-pi/pi-utils";

// Isolate `git` invocations in this file from the host's global config —
// `~/.gitconfig` commit signing or template hooks would otherwise turn the
// worktree fixture's `git init`/`git commit`/`git worktree add` into a flaky
// dance. Restored in `afterAll` below so later files sharing this worker
// don't inherit a disabled global git config.
const savedGitEnv = {
	GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
	GIT_CONFIG_SYSTEM: process.env.GIT_CONFIG_SYSTEM,
	GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM,
	GIT_TERMINAL_PROMPT: process.env.GIT_TERMINAL_PROMPT,
	GIT_ASKPASS: process.env.GIT_ASKPASS,
	XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
};
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_SYSTEM = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_TERMINAL_PROMPT = "0";
process.env.GIT_ASKPASS = "true";
delete process.env.XDG_CONFIG_HOME;

function runGit(cwd: string, args: string[]): string {
	const result = Bun.spawnSync(["git", ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "Test User",
			GIT_AUTHOR_EMAIL: "test@example.com",
			GIT_COMMITTER_NAME: "Test User",
			GIT_COMMITTER_EMAIL: "test@example.com",
		},
	});
	if (result.exitCode !== 0) {
		const stderr = new TextDecoder().decode(result.stderr).trim();
		const stdout = new TextDecoder().decode(result.stdout).trim();
		throw new Error(`git ${args.join(" ")} failed: ${stderr || stdout || `exit ${result.exitCode}`}`);
	}
	return new TextDecoder().decode(result.stdout).trim();
}

/**
 * Write a `.jj/repo` FILE pointing at `primaryJjRepoDir`, matching the shape
 * `jj workspace add` writes for a non-default workspace (content is a path
 * relative to the workspace's own `.jj` dir). No real `jj` binary is
 * invoked — this mirrors the manual-fixture convention in
 * `test/utils/jj.test.ts` rather than depending on `jj` being installed.
 */
async function writeJjWorkspacePointer(workspaceRoot: string, primaryJjRepoDir: string): Promise<void> {
	const jjDir = path.join(workspaceRoot, ".jj");
	await fs.mkdir(jjDir, { recursive: true });
	await fs.writeFile(path.join(jjDir, "repo"), path.relative(jjDir, primaryJjRepoDir));
}

// Set up a fixture filesystem we can reuse across the two regression
// suites — same shape as `~/.omp/memories/mnemopi/` on a real install.
let rootDir: TempDir;
let dbDir: string;
let banksDir: string;
let mainDbPath: string;

beforeAll(async () => {
	rootDir = await TempDir.create("@mnemopi-bank-derivation-");
	dbDir = rootDir.join("mnemopi");
	banksDir = path.join(dbDir, "banks");
	await fs.mkdir(banksDir, { recursive: true });
	mainDbPath = path.join(dbDir, "mnemopi.db");
});

afterAll(async () => {
	await Bun.sleep(0);
	await rootDir.remove();
	for (const [key, value] of Object.entries(savedGitEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

// Schema mirrors the subset of `packages/mnemopi/src/core/beam/schema.ts`
// that this code path needs to probe. We deliberately do not run the
// full schema setup — the cwd-probing query only touches working_memory.
function createBankFixture(bank: string, metadataRows: readonly Record<string, unknown>[]): void {
	const bankDir = path.join(banksDir, bank);
	const dbPath = path.join(bankDir, "mnemopi.db");
	mkdirSync(bankDir, { recursive: true });
	const db = new Database(dbPath, { create: true });
	try {
		db.exec(`
			CREATE TABLE IF NOT EXISTS working_memory (
				id TEXT PRIMARY KEY,
				content TEXT,
				metadata_json TEXT
			)
		`);
		const insert = db.prepare("INSERT INTO working_memory (id, content, metadata_json) VALUES (?, ?, ?)");
		for (const [index, meta] of metadataRows.entries()) {
			insert.run(`row-${bank}-${index}`, "content", JSON.stringify(meta));
		}
	} finally {
		db.close();
	}
}

describe("computeMnemopiBankScope (#2412)", () => {
	// Regression: same cwd must hash to the same bank no matter what the
	// ambient git layout looks like. The previous derivation walked
	// `git.repo.resolveSync(cwd)?.repoRoot ?? path.resolve(cwd)`, so a
	// disappearing/appearing ancestor `.git` repointed the same conversation
	// directory to a different bank and stranded its memories.
	it("returns the same per-project bank for one cwd regardless of git state", async () => {
		const baseDir = await TempDir.create("@mnemopi-stable-bank-");
		try {
			const project = baseDir.join("projects", "omp-workstation");
			await fs.mkdir(project, { recursive: true });
			const withoutGit = computeMnemopiBankScope(undefined, project, "per-project").bank;

			// Plant an ancestor `.git` marker — the old code path resolved
			// `project` to `baseDir/projects` via this file, producing a
			// `projects-<hash>` bank id distinct from the cwd-derived one.
			await fs.mkdir(baseDir.join("projects"), { recursive: true });
			await fs.writeFile(baseDir.join("projects", ".git"), "gitdir: /dev/null\n");
			const withAncestorGit = computeMnemopiBankScope(undefined, project, "per-project").bank;
			expect(withAncestorGit).toBe(withoutGit);

			await removeWithRetries(baseDir.join("projects", ".git"));
			const afterGitRemoved = computeMnemopiBankScope(undefined, project, "per-project").bank;
			expect(afterGitRemoved).toBe(withoutGit);
		} finally {
			await Bun.sleep(0);
			await baseDir.remove();
		}
	});

	it("derives different banks for different cwds (sanity)", () => {
		const a = computeMnemopiBankScope(undefined, "/projects/repo-a", "per-project").bank;
		const b = computeMnemopiBankScope(undefined, "/projects/repo-b", "per-project").bank;
		expect(a).not.toBe(b);
	});

	it("per-project-tagged opens both the project bank and the shared default", () => {
		const scope = computeMnemopiBankScope(undefined, "/projects/repo", "per-project-tagged");
		expect(scope.retainBank).toBe(scope.bank);
		expect(scope.recallBanks).toContain(scope.bank);
		expect(scope.recallBanks).toContain("default");
	});

	it("global ignores the cwd entirely", () => {
		const here = computeMnemopiBankScope(undefined, "/projects/here", "global");
		const there = computeMnemopiBankScope(undefined, "/elsewhere", "global");
		expect(here).toEqual(there);
		expect(here.bank).toBe("default");
	});
});

describe("extendRecallWithLegacyBanks (#2412)", () => {
	it("adds a sibling bank only when all working_memory rows tag the active cwd", () => {
		const activeCwd = path.join(rootDir.path(), "projects", "myrepo");
		createBankFixture("legacy-A", [{ session_id: "old", cwd: activeCwd }]);
		createBankFixture("unrelated-B", [{ session_id: "other", cwd: path.join(rootDir.path(), "other", "place") }]);
		const extended = extendRecallWithLegacyBanks(["active-bank"], mainDbPath, activeCwd);
		expect(extended).toContain("active-bank");
		expect(extended).toContain("legacy-A");
		expect(extended).not.toContain("unrelated-B");
	});

	it("skips mixed-cwd legacy banks because recall cannot filter rows by cwd", () => {
		const childCwd = path.join(rootDir.path(), "projects", "safe-child");
		createBankFixture("mixed-cwd-legacy", [
			{ cwd: childCwd },
			{ cwd: path.join(rootDir.path(), "projects", "sibling-child") },
		]);
		const extended = extendRecallWithLegacyBanks(["active-bank"], mainDbPath, childCwd);
		expect(extended).not.toContain("mixed-cwd-legacy");
	});
});

describe("extendRecallWithLegacyBanks edge cases", () => {
	it("ignores banks already in the recall set", () => {
		const cwd = path.join(rootDir.path(), "projects", "already-in-set");
		createBankFixture("already-in-set", [{ cwd }]);
		const extended = extendRecallWithLegacyBanks(["already-in-set"], mainDbPath, cwd);
		expect(extended).toEqual(["already-in-set"]);
	});

	it("returns the input unchanged when banks/ does not exist", () => {
		const missingRoot = rootDir.join("no-such-mnemopi", "mnemopi.db");
		const out = extendRecallWithLegacyBanks(["one"], missingRoot, "/home/user/anywhere");
		expect(out).toEqual(["one"]);
	});

	it("tolerates a corrupt bank database without throwing", async () => {
		const corruptDir = path.join(banksDir, "corrupt-C");
		await fs.mkdir(corruptDir, { recursive: true });
		await fs.writeFile(path.join(corruptDir, "mnemopi.db"), "not a sqlite file");
		const out = extendRecallWithLegacyBanks(["active"], mainDbPath, path.join(rootDir.path(), "some", "cwd"));
		expect(out).toContain("active");
		expect(out).not.toContain("corrupt-C");
	});
});

// Regression: the exploratory sibling-bank scan is capped (64 entries) to
// bound startup cost, but the worktree's pre-root-resolution bank name is
// deterministic from the raw cwd — it must be probed directly, or an
// installation with many banks silently strands that worktree's memories
// when readdir order puts the legacy bank past the cap.
describe("extendRecallWithLegacyBanks known-legacy candidate past the scan cap", () => {
	let capRootDir: TempDir;
	let capBanksDir: string;
	let capDbPath: string;

	beforeAll(async () => {
		capRootDir = await TempDir.create("@mnemopi-scan-cap-");
		const dir = capRootDir.join("mnemopi");
		capBanksDir = path.join(dir, "banks");
		await fs.mkdir(capBanksDir, { recursive: true });
		capDbPath = path.join(dir, "mnemopi.db");
	});

	// readdir order is filesystem-dependent (ext4 returns hash order), so the
	// "legacy bank sits past the cap" topology cannot be built from real
	// directory entries alone. Pin lexical order: the `aaa-*` fillers then
	// deterministically exhaust the scan budget before any `teambase-*`/`zz-*`
	// legacy bank is reached, which is exactly the pre-fix failure mode.
	let restoreReaddirOrder: (() => void) | undefined;
	beforeAll(() => {
		const real = nodeFs.readdirSync;
		const spy = spyOn(nodeFs, "readdirSync").mockImplementation(((...args: Parameters<typeof real>) => {
			const out = real(...args);
			return Array.isArray(out)
				? [...out].sort((a, b) => {
						const an = typeof a === "string" ? a : a.name.toString();
						const bn = typeof b === "string" ? b : b.name.toString();
						return an < bn ? -1 : an > bn ? 1 : 0;
					})
				: out;
		}) as typeof real);
		restoreReaddirOrder = () => spy.mockRestore();
	});

	afterAll(() => {
		restoreReaddirOrder?.();
	});

	afterAll(async () => {
		await Bun.sleep(0);
		await capRootDir.remove();
	});

	function createCapBankFixture(bank: string, metadataRows: readonly Record<string, unknown>[]): void {
		const bankDir = path.join(capBanksDir, bank);
		const dbPath = path.join(bankDir, "mnemopi.db");
		mkdirSync(bankDir, { recursive: true });
		const db = new Database(dbPath, { create: true });
		try {
			db.exec(`
				CREATE TABLE IF NOT EXISTS working_memory (
					id TEXT PRIMARY KEY,
					content TEXT,
					metadata_json TEXT
				)
			`);
			const insert = db.prepare("INSERT INTO working_memory (id, content, metadata_json) VALUES (?, ?, ?)");
			for (const [index, meta] of metadataRows.entries()) {
				insert.run(`row-${bank}-${index}`, "content", JSON.stringify(meta));
			}
		} finally {
			db.close();
		}
	}

	// Both tests below rely on the same topology: 70 `aaa-*` fillers (tagging
	// an unrelated cwd) that consume the entire 64-entry scan budget under the
	// pinned lexical order, so any later-sorting legacy bank is reachable only
	// through the deterministic known-candidate probe.
	beforeAll(() => {
		const otherCwd = capRootDir.join("projects", "elsewhere");
		for (let i = 0; i < 70; i++) {
			createCapBankFixture(`aaa-filler-${String(i).padStart(3, "0")}`, [{ cwd: otherCwd }]);
		}
	});

	it("rescues the raw-cwd bank even when the capped scan cannot reach it", () => {
		const activeCwd = capRootDir.join("projects", "zz-scan-cap");
		const legacyBank = projectBankSegment(path.resolve(activeCwd));
		createCapBankFixture(legacyBank, [{ session_id: "old", cwd: activeCwd }]);
		const extended = extendRecallWithLegacyBanks(["root-derived-bank"], capDbPath, activeCwd);
		expect(extended).toContain("root-derived-bank");
		expect(extended).toContain(legacyBank);
	});

	it("derives the base-prefixed legacy name when a shared bank base is configured", () => {
		const activeCwd = capRootDir.join("projects", "zz-based-cap");
		const segment = projectBankSegment(path.resolve(activeCwd));
		const basedLegacyBank = `teambase-${segment}`;
		createCapBankFixture(basedLegacyBank, [{ session_id: "old", cwd: activeCwd }]);
		const extended = extendRecallWithLegacyBanks(["teambase-new-root-bank"], capDbPath, activeCwd, "teambase");
		expect(extended).toContain(basedLegacyBank);
	});
});

// Regression: linked git worktrees, colocated jj workspaces (which
// `jj workspace add --colocate` implements as a real git worktree, verified
// against the `jj` CLI directly — no separate fixture needed here), and
// non-colocated jj workspaces of one repository all used to get their own
// isolated per-project bank. Ports the Hindsight backend's `projectLabel`
// fix for #2232 (`git.repo.primaryRootSync`, plus the new
// `jj.repo.primaryRootSync` for the non-colocated case) into
// `projectBank`/`resolveProjectRoot`.
describe("computeMnemopiBankScope worktree/workspace collapsing", () => {
	let baseDir: TempDir;
	let primaryRoot: string;
	let gitWorktreeRoot: string;
	let jjWorkspaceRoot: string;
	let nonRepoDir: string;

	beforeAll(async () => {
		baseDir = await TempDir.create("@mnemopi-worktree-");
		primaryRoot = baseDir.join("myrepo");
		gitWorktreeRoot = baseDir.join("myrepo-worktree");
		jjWorkspaceRoot = baseDir.join("myrepo-jj-plain");
		nonRepoDir = baseDir.join("not-a-repo");
		await fs.mkdir(primaryRoot, { recursive: true });
		await fs.mkdir(nonRepoDir, { recursive: true });
		runGit(primaryRoot, ["-c", "init.defaultBranch=main", "init"]);
		await fs.writeFile(path.join(primaryRoot, "README.md"), "hi\n");
		runGit(primaryRoot, ["add", "-A"]);
		runGit(primaryRoot, ["commit", "-m", "base"]);
		runGit(primaryRoot, ["worktree", "add", gitWorktreeRoot, "-b", "feature-x"]);
		// Colocated-jj shape: the primary's `.jj/repo` is a directory (the
		// default workspace), the linked worktree's is a FILE pointing back at
		// it — same as `jj workspace add --colocate` on top of this git
		// worktree would produce.
		await fs.mkdir(path.join(primaryRoot, ".jj", "repo", "store"), { recursive: true });
		await writeJjWorkspacePointer(gitWorktreeRoot, path.join(primaryRoot, ".jj", "repo"));
		// Non-colocated jj workspace: only `.jj/repo`, no `.git` anywhere.
		await writeJjWorkspacePointer(jjWorkspaceRoot, path.join(primaryRoot, ".jj", "repo"));
	});

	afterAll(async () => {
		if (baseDir) await baseDir.remove();
	});

	it("emits the same per-project bank from the primary checkout and a linked git worktree", () => {
		const fromPrimary = computeMnemopiBankScope(undefined, primaryRoot, "per-project").bank;
		const fromWorktree = computeMnemopiBankScope(undefined, gitWorktreeRoot, "per-project").bank;
		expect(fromWorktree).toBe(fromPrimary);
		expect(fromPrimary).toBe(`myrepo-${Bun.hash(primaryRoot).toString(36)}`);
	});

	it("emits the same per-project bank from a non-colocated jj workspace", () => {
		const fromPrimary = computeMnemopiBankScope(undefined, primaryRoot, "per-project").bank;
		const fromWorkspace = computeMnemopiBankScope(undefined, jjWorkspaceRoot, "per-project").bank;
		expect(fromWorkspace).toBe(fromPrimary);
	});

	it("keeps per-project-tagged recall scoped to the collapsed project bank across worktree and workspace", () => {
		const fromPrimary = computeMnemopiBankScope(undefined, primaryRoot, "per-project-tagged");
		const fromWorktree = computeMnemopiBankScope(undefined, gitWorktreeRoot, "per-project-tagged");
		const fromWorkspace = computeMnemopiBankScope(undefined, jjWorkspaceRoot, "per-project-tagged");
		expect(fromWorktree).toEqual(fromPrimary);
		expect(fromWorkspace).toEqual(fromPrimary);
	});

	it("preserves the plain cwd-hash fallback outside any git/jj repository", () => {
		const bank = computeMnemopiBankScope(undefined, nonRepoDir, "per-project").bank;
		expect(bank).toBe(`not-a-repo-${Bun.hash(nonRepoDir).toString(36)}`);
	});
});

// Regression: a pure jj workspace nested under an *unrelated* outer Git
// checkout — the topology `jj.isPureJjRepo` documents as real — used to
// derive its bank from the outer checkout, because `resolveProjectRoot`
// always tried Git resolution before Jujutsu. The nearer VCS root (the
// jj workspace, since it sits deeper than the unrelated outer `.git`) must
// win, or the inner project's memories mix into the outer checkout's bank.
describe("computeMnemopiBankScope pure jj nested under an unrelated outer git checkout", () => {
	let baseDir: TempDir;
	let outerGitRoot: string;
	let jjPrimaryRoot: string;
	let nestedJjRoot: string;

	beforeAll(async () => {
		baseDir = await TempDir.create("@mnemopi-nested-jj-");
		outerGitRoot = baseDir.join("outer-repo");
		jjPrimaryRoot = baseDir.join("jj-primary");
		nestedJjRoot = path.join(outerGitRoot, "nested-jj-workspace");
		await fs.mkdir(outerGitRoot, { recursive: true });
		await fs.mkdir(nestedJjRoot, { recursive: true });
		runGit(outerGitRoot, ["-c", "init.defaultBranch=main", "init"]);
		await fs.writeFile(path.join(outerGitRoot, "README.md"), "hi\n");
		runGit(outerGitRoot, ["add", "-A"]);
		runGit(outerGitRoot, ["commit", "-m", "base"]);
		// An unrelated, wholly separate non-colocated jj repository (no `.git` anywhere).
		await fs.mkdir(path.join(jjPrimaryRoot, ".jj", "repo", "store"), { recursive: true });
		// Lives inside the outer git checkout's tree but is its own jj workspace
		// pointed at the unrelated jj-primary repo above.
		await writeJjWorkspacePointer(nestedJjRoot, path.join(jjPrimaryRoot, ".jj", "repo"));
	});

	afterAll(async () => {
		if (baseDir) await baseDir.remove();
	});

	it("derives the bank from the nearer jj workspace root, not the outer git checkout", () => {
		const fromNestedJj = computeMnemopiBankScope(undefined, nestedJjRoot, "per-project").bank;
		const fromJjPrimary = computeMnemopiBankScope(undefined, jjPrimaryRoot, "per-project").bank;
		const fromOuterGit = computeMnemopiBankScope(undefined, outerGitRoot, "per-project").bank;
		expect(fromNestedJj).toBe(fromJjPrimary);
		expect(fromNestedJj).not.toBe(fromOuterGit);
	});
});

// Regression: `isNearerAncestor` used to reject a jj workspace as a
// descendant whenever its `path.relative` result merely *started with* the
// two-character string "..", which also matches directory names like
// `..jj-workspace` that are not a parent traversal at all. That false
// rejection made the nearer jj workspace lose to the unrelated outer git
// checkout, exactly like the topology above but with a dotdot-prefixed
// workspace directory name standing in for the ordinary "outer git wins"
// bug this suite already covers.
describe("computeMnemopiBankScope nested jj workspace name starting with '..'", () => {
	let baseDir: TempDir;
	let outerGitRoot: string;
	let jjPrimaryRoot: string;
	let nestedJjRoot: string;

	beforeAll(async () => {
		baseDir = await TempDir.create("@mnemopi-dotdot-jj-");
		outerGitRoot = baseDir.join("outer-repo");
		jjPrimaryRoot = baseDir.join("jj-primary");
		nestedJjRoot = path.join(outerGitRoot, "..jj-workspace");
		await fs.mkdir(outerGitRoot, { recursive: true });
		await fs.mkdir(nestedJjRoot, { recursive: true });
		runGit(outerGitRoot, ["-c", "init.defaultBranch=main", "init"]);
		await fs.writeFile(path.join(outerGitRoot, "README.md"), "hi\n");
		runGit(outerGitRoot, ["add", "-A"]);
		runGit(outerGitRoot, ["commit", "-m", "base"]);
		await fs.mkdir(path.join(jjPrimaryRoot, ".jj", "repo", "store"), { recursive: true });
		await writeJjWorkspacePointer(nestedJjRoot, path.join(jjPrimaryRoot, ".jj", "repo"));
	});

	afterAll(async () => {
		if (baseDir) await baseDir.remove();
	});

	it("still treats the dotdot-prefixed workspace as the nearer root, not the outer git checkout", () => {
		const fromNestedJj = computeMnemopiBankScope(undefined, nestedJjRoot, "per-project").bank;
		const fromJjPrimary = computeMnemopiBankScope(undefined, jjPrimaryRoot, "per-project").bank;
		const fromOuterGit = computeMnemopiBankScope(undefined, outerGitRoot, "per-project").bank;
		expect(fromNestedJj).toBe(fromJjPrimary);
		expect(fromNestedJj).not.toBe(fromOuterGit);
	});
});
