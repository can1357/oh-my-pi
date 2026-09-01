import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getWorktreesDir, setWorktreesDir } from "@oh-my-pi/pi-utils";
import { parseArgs } from "../src/cli/args";
import { resolveFileArguments } from "../src/cli/file-processor";
import { clearWorktrees } from "../src/cli/worktree-cli";
import { cleanupCreatedWorktree, createWorktree } from "../src/cli/worktree-create";

describe("main-session worktree launch flags", () => {
	it("parses a named or generated managed workspace without consuming the prompt", () => {
		const named = parseArgs(["--worktree", "feature-auth", "implement the feature"]);
		expect(named.worktree).toBe("feature-auth");
		expect(named.messages).toEqual(["implement the feature"]);

		const generated = parseArgs(["--worktree", "--print", "inspect the repository"]);
		expect(generated.worktree).toBe(true);
		expect(generated.print).toBe(true);
		expect(generated.messages).toEqual(["inspect the repository"]);
	});
});

describe("main-session managed workspace", () => {
	const tempDirs: string[] = [];
	let originalWorktreesDir: string;

	async function git(repo: string, ...args: string[]): Promise<string> {
		const proc = Bun.spawn(["git", ...args], { cwd: repo, stdout: "pipe", stderr: "pipe" });
		const stdout = await new Response(proc.stdout).text();
		const exitCode = await proc.exited;
		if (exitCode !== 0) throw new Error(await new Response(proc.stderr).text());
		return stdout;
	}

	async function createRepository(): Promise<string> {
		const repo = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-main-wt-repo-")));
		tempDirs.push(repo);
		await git(repo, "init", "-q");
		await git(repo, "config", "user.email", "test@example.com");
		await git(repo, "config", "user.name", "Test User");
		await git(repo, "remote", "add", "origin", "https://example.test/owner/repo.git");
		await Bun.write(path.join(repo, "tracked.txt"), "base\n");
		await git(repo, "add", "tracked.txt");
		await git(repo, "commit", "-qm", "initial");
		return repo;
	}

	beforeEach(async () => {
		originalWorktreesDir = getWorktreesDir();
		const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-main-wt-home-")));
		tempDirs.push(home);
		setWorktreesDir(path.join(home, "wt"));
	});

	afterEach(async () => {
		setWorktreesDir(originalWorktreesDir);
		vi.restoreAllMocks();
		await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
	});

	it("creates a persistent linked workspace with normal Git delivery metadata", async () => {
		const repo = await createRepository();
		const created = await createWorktree(repo, "feature-auth");

		expect(await Bun.file(path.join(created.workspacePath, "tracked.txt")).text()).toBe("base\n");
		expect((await git(created.workspacePath, "branch", "--show-current")).trim()).toBe("omp/feature-auth");
		expect((await git(created.workspacePath, "remote", "get-url", "origin")).trim()).toBe(
			"https://example.test/owner/repo.git",
		);
		expect(await git(created.workspacePath, "status", "--porcelain")).toBe("");
		expect(await git(repo, "status", "--porcelain")).toBe("");
		const reused = await createWorktree(repo, "feature-auth");
		expect(reused).toMatchObject({ ...created, reused: true });
	});

	it("inherits source-only agent configuration without overwriting tracked worktree files", async () => {
		const repo = await createRepository();
		await fs.mkdir(path.join(repo, ".omp", "skills"), { recursive: true });
		await fs.mkdir(path.join(repo, ".claude"), { recursive: true });
		await fs.mkdir(path.join(repo, ".codex"), { recursive: true });
		await fs.mkdir(path.join(repo, ".gemini"), { recursive: true });
		await fs.mkdir(path.join(repo, ".agents", "skills"), { recursive: true });
		await Bun.write(path.join(repo, ".omp", "config.yml"), "textVerbosity: high\n");
		await Bun.write(path.join(repo, ".omp", "skills", "local.md"), "# Local skill\n");
		await Bun.write(path.join(repo, ".claude", "settings.json"), '{"permissions": {}}\n');
		await Bun.write(path.join(repo, ".codex", "config.toml"), "[mcp_servers]\n");
		await Bun.write(path.join(repo, ".gemini", "settings.json"), '{"mcpServers": {}}\n');
		await Bun.write(path.join(repo, ".agents", "skills", "local.md"), "# Agent skill\n");
		await Bun.write(path.join(repo, ".mcp.json"), '{"mcpServers": {}}\n');
		await Bun.write(path.join(repo, "AGENTS.md"), "# Agent instructions\n");

		const created = await createWorktree(repo, "configured");

		expect(await Bun.file(path.join(created.workspacePath, ".omp", "config.yml")).text()).toBe(
			"textVerbosity: high\n",
		);
		expect(await Bun.file(path.join(created.workspacePath, ".omp", "skills", "local.md")).text()).toBe(
			"# Local skill\n",
		);
		expect(await Bun.file(path.join(created.workspacePath, ".claude", "settings.json")).text()).toBe(
			'{"permissions": {}}\n',
		);
		expect(await Bun.file(path.join(created.workspacePath, ".codex", "config.toml")).text()).toBe("[mcp_servers]\n");
		expect(await Bun.file(path.join(created.workspacePath, ".gemini", "settings.json")).text()).toBe(
			'{"mcpServers": {}}\n',
		);
		expect(await Bun.file(path.join(created.workspacePath, ".agents", "skills", "local.md")).text()).toBe(
			"# Agent skill\n",
		);
		expect(await Bun.file(path.join(created.workspacePath, ".mcp.json")).text()).toBe('{"mcpServers": {}}\n');
		expect(await Bun.file(path.join(created.workspacePath, "AGENTS.md")).text()).toBe("# Agent instructions\n");
	});

	it("keeps a persistent main-session workspace after its process owner exits", async () => {
		const repo = await createRepository();
		const created = await createWorktree(repo, "keep-me");

		const output: string[] = [];
		vi.spyOn(console, "log").mockImplementation(value => output.push(String(value)));
		await clearWorktrees({ all: false, dryRun: true, json: true });

		const result: { wouldRemove?: string[] } = JSON.parse(output.join("\n"));
		expect(result.wouldRemove ?? []).not.toContain(created.workspacePath);
	});

	it("does not clear a linked workspace by default when its primary checkout is missing", async () => {
		const repo = await createRepository();
		const created = await createWorktree(repo, "primary-moved");
		const movedRepo = `${repo}-moved`;
		tempDirs.push(movedRepo);
		await fs.rename(repo, movedRepo);

		await clearWorktrees({ all: false, dryRun: false, json: true });

		expect(await Bun.file(path.join(created.workspacePath, "tracked.txt")).exists()).toBe(true);
	});

	it("does not force-remove a dirty linked workspace even with --all", async () => {
		const repo = await createRepository();
		const created = await createWorktree(repo, "dirty-workspace");
		await Bun.write(path.join(created.workspacePath, "tracked.txt"), "changed\n");
		const output: string[] = [];
		const previousExitCode = process.exitCode;
		vi.spyOn(console, "log").mockImplementation(value => output.push(String(value)));

		try {
			await clearWorktrees({ all: true, dryRun: false, json: true });
			expect(process.exitCode).toBe(1);
		} finally {
			process.exitCode = previousExitCode;
		}

		expect(await Bun.file(path.join(created.workspacePath, "tracked.txt")).text()).toBe("changed\n");
		expect(JSON.parse(output.join("\n"))).toMatchObject({ removed: 0, failed: 1 });
	});

	it("serializes concurrent creation and reuses the completed workspace", async () => {
		const repo = await createRepository();
		const results = await Promise.allSettled([
			createWorktree(repo, "shared-name"),
			createWorktree(repo, "shared-name"),
		]);

		const created = results.filter(
			(result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof createWorktree>>> =>
				result.status === "fulfilled",
		);
		expect(created).toHaveLength(2);
		expect(created.map(result => result.value.reused).sort()).toEqual([false, true]);
		expect(new Set(created.map(result => result.value.workspacePath)).size).toBe(1);
	});

	it("removes a newly created workspace when startup aborts before a session begins", async () => {
		const repo = await createRepository();
		const created = await createWorktree(repo, "abort-before-session");

		await cleanupCreatedWorktree(repo, created);

		expect(await Bun.file(created.workspacePath).exists()).toBe(false);
		expect((await git(repo, "branch", "--list", created.branch)).trim()).toBe("");
	});

	it("accepts --continue alongside a managed-workspace name", () => {
		const parsed = parseArgs(["--worktree", "resume-test", "--continue"]);
		expect(parsed).toMatchObject({ worktree: "resume-test", continue: true });
	});

	it("anchors relative initial attachments to the primary checkout", async () => {
		const repo = await createRepository();
		await Bun.write(path.join(repo, "notes.md"), "outside the linked worktree\n");

		expect(resolveFileArguments(["notes.md"], repo)).toEqual([path.join(repo, "notes.md")]);
	});
});
