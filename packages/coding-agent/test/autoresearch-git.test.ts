import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { ensureAutoresearchBranch } from "../src/autoresearch/git";
import type { ExtensionAPI } from "../src/extensibility/extensions";

const tempDirs: string[] = [];

async function mkTempDir(prefix: string): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

async function runGit(cwd: string, args: string[]): Promise<void> {
	const env = { ...process.env, HOME: cwd, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
	const proc = Bun.spawn(["git", "-C", cwd, ...args], { env, stdout: "ignore", stderr: "pipe" });
	const code = await proc.exited;
	if (code !== 0) {
		const stderr = await new Response(proc.stderr).text();
		throw new Error(`git ${args.join(" ")} failed (${code}): ${stderr}`);
	}
}

async function initGitWithCommit(dir: string): Promise<void> {
	await runGit(dir, ["init", "-q", "-b", "main"]);
	await runGit(dir, ["config", "user.email", "test@example.com"]);
	await runGit(dir, ["config", "user.name", "Test"]);
	await fs.writeFile(path.join(dir, "README"), "seed\n");
	await runGit(dir, ["add", "."]);
	await runGit(dir, ["commit", "-q", "-m", "init"]);
}

// `ensureAutoresearchBranch` never invokes the `api` it receives — its two
// internal helpers (`readGitWorkDirPrefix`, `branchExists`) immediately
// `void api`. The stub keeps the signature honest without spinning up the
// real extension runtime.
const stubApi = {} as unknown as ExtensionAPI;

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => removeWithRetries(dir)));
});

describe("ensureAutoresearchBranch jj guardrails", () => {
	it("rejects pure jj workspaces before touching git state", async () => {
		const dir = await mkTempDir("omp-ar-purejj-");
		await fs.mkdir(path.join(dir, ".jj", "repo", "store"), { recursive: true });

		const result = await ensureAutoresearchBranch(stubApi, dir, "demo");

		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("unreachable");
		expect(result.error).toMatch(/pure Jujutsu/);
		expect(result.error).toMatch(/jj git init --colocate/);
	});

	it("creates an autoresearch branch in a colocated jj-git workspace", async () => {
		const dir = await mkTempDir("omp-ar-colocated-");
		await initGitWithCommit(dir);
		await fs.mkdir(path.join(dir, ".jj", "repo", "store"), { recursive: true });

		const result = await ensureAutoresearchBranch(stubApi, dir, "demo goal");

		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("unreachable");
		expect(result.created).toBe(true);
		expect(result.branchName).toMatch(/^autoresearch\/demo-goal-\d{8}$/);
	});

	it("creates an autoresearch branch in a plain git repo (unchanged behavior)", async () => {
		const dir = await mkTempDir("omp-ar-plaingit-");
		await initGitWithCommit(dir);

		const result = await ensureAutoresearchBranch(stubApi, dir, "demo");

		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("unreachable");
		expect(result.created).toBe(true);
		expect(result.branchName).toMatch(/^autoresearch\/demo-\d{8}$/);
	});

	it("returns the soft no-git warning for directories backed by neither tool", async () => {
		const dir = await mkTempDir("omp-ar-empty-");

		const result = await ensureAutoresearchBranch(stubApi, dir, "demo");

		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("unreachable");
		expect(result.branchName).toBeNull();
		expect(result.warning).toMatch(/Not in a git repository/);
	});

	it("rejects a pure jj workspace nested inside an unrelated outer git checkout", async () => {
		// `git.repo.root(inner)` walks up and finds the outer .git — without
		// the pure-jj check running first, autoresearch would create
		// `autoresearch/*` branches and commits in the surrounding git tree
		// behind jj's back.
		const outer = await mkTempDir("omp-ar-nested-outer-");
		await initGitWithCommit(outer);
		const inner = path.join(outer, "nested-jj");
		await fs.mkdir(path.join(inner, ".jj", "repo", "store"), { recursive: true });

		const result = await ensureAutoresearchBranch(stubApi, inner, "demo");

		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("unreachable");
		expect(result.error).toMatch(/pure Jujutsu/);
		expect(result.error).toMatch(/jj git init --colocate/);
	});

	it("creates an autoresearch branch in a nested git checkout under an outer jj workspace", async () => {
		// Mirror image of the case above: `jj.repo.root(inner)` finds the outer
		// .jj, but `git.repo.root(inner)` finds the inner .git, so autoresearch
		// safely targets the nested checkout and never touches the surrounding
		// jj tree.
		const outer = await mkTempDir("omp-ar-outerjj-");
		await fs.mkdir(path.join(outer, ".jj", "repo", "store"), { recursive: true });
		const inner = path.join(outer, "vendor");
		await fs.mkdir(inner, { recursive: true });
		await initGitWithCommit(inner);

		const result = await ensureAutoresearchBranch(stubApi, inner, "demo");

		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("unreachable");
		expect(result.created).toBe(true);
		expect(result.branchName).toMatch(/^autoresearch\/demo-\d{8}$/);
	});
});
