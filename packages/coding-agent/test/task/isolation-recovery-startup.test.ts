import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { readJsonl, readLines, removeWithRetries } from "@oh-my-pi/pi-utils";

/**
 * Start-up recovery of isolated task trees whose owner is dead, through the
 * real CLI: a real process makes each sandbox and is SIGKILLed, and a real
 * `omp --mode rpc` starting against that worktree root does the sweep.
 */

const CLI = path.resolve(import.meta.dir, "../../src/cli.ts");
const OWNER_FIXTURE = path.join(import.meta.dir, "fixtures", "isolation-owner.ts");
/** How long a start is given to report its sweep. The sweep waits a second after start-up. */
const NOTICE_WAIT_MS = 30_000;

const temporary: string[] = [];
const processes: Bun.Subprocess[] = [];

afterEach(async () => {
	for (const child of processes.splice(0)) {
		child.kill("SIGKILL");
		await child.exited;
	}
	await Promise.all(temporary.splice(0).map(dir => removeWithRetries(dir)));
});

async function tempDir(prefix: string): Promise<string> {
	const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
	temporary.push(dir);
	return dir;
}

async function git(cwd: string, ...args: string[]): Promise<string> {
	const proc = Bun.spawn(["git", "-c", "user.email=t@example.com", "-c", "user.name=T", ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (code !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
	return stdout.trim();
}

/** A repository with one commit and an uncommitted file the parent was working on when the task started. */
async function makeRepo(): Promise<{ repo: string; base: string }> {
	const repo = await tempDir("omp-recovery-repo-");
	await git(repo, "init", "-q", "-b", "main");
	await git(repo, "config", "core.autocrlf", "false");
	await fs.writeFile(path.join(repo, "file.txt"), "base\n");
	await git(repo, "add", "file.txt");
	await git(repo, "commit", "-q", "-m", "base");
	await fs.writeFile(path.join(repo, "parent-wip.txt"), "the parent's own uncommitted work\n");
	return { repo, base: await git(repo, "rev-parse", "HEAD") };
}

/** A real process owning a sandbox under `root`; resolves once the sandbox (and its work) is on disk. */
async function makeOwner(
	root: string,
	repo: string,
	id: string,
	mode: "clean" | "dirty",
): Promise<{ child: Bun.Subprocess; mergedDir: string; baseDir: string }> {
	const child = Bun.spawn([process.execPath, OWNER_FIXTURE, repo, id, `session-${id}`, mode], {
		cwd: path.dirname(OWNER_FIXTURE),
		env: { ...process.env, OMP_WORKTREE_DIR: root },
		stdout: "pipe",
		stderr: "pipe",
	});
	processes.push(child);
	const decoder = new TextDecoder();
	for await (const line of readLines(child.stdout as ReadableStream<Uint8Array>)) {
		const text = decoder.decode(line);
		if (text.startsWith("@@")) {
			const { mergedDir } = JSON.parse(text.slice(2)) as { mergedDir: string };
			return { child, mergedDir, baseDir: path.dirname(mergedDir) };
		}
	}
	throw new Error(`the owner exited before its sandbox was made: ${await new Response(child.stderr).text()}`);
}

/** Kill an owner the way a crash does, and wait until it is gone. */
async function killOwner(owner: { child: Bun.Subprocess }): Promise<void> {
	owner.child.kill("SIGKILL");
	await owner.child.exited;
}

interface RpcFrame {
	type?: string;
	level?: string;
	message?: string;
	source?: string;
}

/** A home for the CLI with a loopback model that is never called, so `omp --mode rpc` starts. */
async function makeHome(): Promise<string> {
	const home = await tempDir("omp-recovery-home-");
	const agentDir = path.join(home, ".omp", "agent");
	await Bun.write(
		path.join(agentDir, "models.yml"),
		JSON.stringify({
			providers: {
				local: {
					baseUrl: "http://127.0.0.1:9/v1",
					api: "openai-completions",
					auth: "none",
					models: [
						{
							id: "loopback",
							name: "Loopback",
							reasoning: false,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 131072,
							maxTokens: 1024,
						},
					],
				},
			},
		}),
	);
	await Bun.write(
		path.join(agentDir, "config.yml"),
		JSON.stringify({ modelRoles: { default: "local/loopback" }, retry: { enabled: false } }),
	);
	return home;
}

/** Start a real `omp --mode rpc` against `root`; resolves its sweep notice, or `undefined` if none comes. */
function startOmp(root: string, home: string, cwd: string): { notice: Promise<RpcFrame | undefined> } {
	const child = Bun.spawn(
		[process.execPath, CLI, "--no-title", "--no-lsp", "--no-extensions", "--no-tools", "--mode", "rpc"],
		{
			cwd,
			env: {
				PATH: process.env.PATH,
				HOME: home,
				USERPROFILE: home,
				TMPDIR: process.env.TMPDIR,
				NO_COLOR: "1",
				OMP_WORKTREE_DIR: root,
			},
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	processes.push(child);
	const notice = (async (): Promise<RpcFrame | undefined> => {
		const frames = readJsonl<RpcFrame>(child.stdout as ReadableStream<Uint8Array>);
		const deadline = Bun.sleep(NOTICE_WAIT_MS).then(() => undefined);
		for (;;) {
			const next = await Promise.race([frames.next(), deadline]);
			if (next === undefined || next.done) return undefined;
			if (next.value.type === "notice" && next.value.source === "isolation-recovery") return next.value;
		}
	})();
	return { notice };
}

async function exists(target: string): Promise<boolean> {
	return fs.lstat(target).then(
		() => true,
		() => false,
	);
}

async function recoveredFiles(root: string): Promise<string[]> {
	return (await fs.readdir(path.join(root, ".recovered")).catch(() => [])).sort();
}

/** `omp worktree list --json` against `root`, as a person would run it. */
async function listWorktrees(root: string, home: string): Promise<Array<Record<string, unknown>>> {
	const proc = Bun.spawn([process.execPath, CLI, "worktree", "list", "--json"], {
		env: { PATH: process.env.PATH, HOME: home, TMPDIR: process.env.TMPDIR, NO_COLOR: "1", OMP_WORKTREE_DIR: root },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
	expect(code).toBe(0);
	return JSON.parse(stdout) as Array<Record<string, unknown>>;
}

describe("start-up recovery of isolated task trees", () => {
	it("saves a dead owner's uncaptured changes as a patch before removing its tree, removes a clean dead tree, and keeps a live owner's", async () => {
		const root = await tempDir("omp-recovery-wt-");
		const home = await makeHome();
		const { repo, base } = await makeRepo();
		const dirty = await makeOwner(root, repo, "DirtyTask", "dirty");
		const clean = await makeOwner(root, repo, "CleanTask", "clean");
		const live = await makeOwner(root, repo, "LiveTask", "dirty");
		await killOwner(dirty);
		await killOwner(clean);

		const notice = await startOmp(root, home, repo).notice;

		expect(notice?.level).toBe("warning");
		expect(notice?.message).toContain(path.join(root, ".recovered"));
		const files = await recoveredFiles(root);
		expect(files.filter(file => file.endsWith(".patch"))).toHaveLength(1);
		const patchName = files.find(file => file.endsWith(".patch"));
		expect(patchName).toMatch(/^session-DirtyTask-DirtyTask-\d{8}T\d{6}Z\.patch$/);
		const patchPath = path.join(root, ".recovered", patchName ?? "");
		const sidecar = JSON.parse(await fs.readFile(patchPath.replace(/\.patch$/, ".json"), "utf8")) as Record<
			string,
			unknown
		>;
		expect(sidecar).toMatchObject({
			sourceRepo: repo,
			baseCommit: base,
			ownerSessionId: "session-DirtyTask",
			taskId: "DirtyTask",
			patch: patchPath,
		});
		expect(String(sidecar.apply)).toContain("git apply");
		// The task's own work, and none of the parent's uncommitted changes it was copied with.
		const patch = await fs.readFile(patchPath, "utf8");
		expect(patch).toContain("work of DirtyTask");
		expect(patch).toContain("changed by DirtyTask");
		expect(patch).not.toContain("parent's own uncommitted work");
		// Nothing half-written is left behind.
		expect(files.filter(file => file.includes(".tmp"))).toEqual([]);
		// It applies on the commit the task started from.
		const checkout = await tempDir("omp-recovery-apply-");
		await git(checkout, "clone", "-q", repo, ".");
		await git(checkout, "checkout", "-q", base);
		await git(checkout, "apply", "--check", patchPath);

		expect(await exists(dirty.baseDir)).toBe(false);
		expect(await exists(clean.baseDir)).toBe(false);
		expect(await exists(path.join(live.mergedDir, "task-output.txt"))).toBe(true);
		// `omp worktree list` shows what was saved.
		const listed = await listWorktrees(root, home);
		expect(listed).toContainEqual(expect.objectContaining({ path: patchPath, kind: "recovered-patch" }));
	}, 120_000);

	it("keeps a dead owner's tree, and says why, when its patch cannot be written", async () => {
		const root = await tempDir("omp-recovery-wt-");
		const home = await makeHome();
		const { repo } = await makeRepo();
		const dirty = await makeOwner(root, repo, "UnsavedTask", "dirty");
		await killOwner(dirty);
		// Where the patch would go is a file, so it cannot be made a directory.
		await fs.writeFile(path.join(root, ".recovered"), "not a directory\n");

		const notice = await startOmp(root, home, repo).notice;

		expect(notice?.message).toContain("could not save");
		expect(await exists(path.join(dirty.mergedDir, "task-output.txt"))).toBe(true);
		const listed = await listWorktrees(root, home);
		const entry = listed.find(candidate => candidate.path === dirty.baseDir);
		expect(String(entry?.keptReason)).toContain("could not be saved");
		// Kept from a plain clear too: only `--all` removes the only copy.
		expect(entry?.orphanReason).toBeUndefined();
	}, 120_000);

	it("acts once on a dead tree when two omp processes start at the same time", async () => {
		const root = await tempDir("omp-recovery-wt-");
		const home = await makeHome();
		const { repo } = await makeRepo();
		const dirty = await makeOwner(root, repo, "RacedTask", "dirty");
		await killOwner(dirty);

		const first = startOmp(root, home, repo);
		const second = startOmp(root, home, repo);
		const notices = await Promise.all([first.notice, second.notice]);

		// One of them saved and removed it; the other found it taken or gone.
		expect(notices.filter(notice => notice?.message?.includes("saved the uncaptured changes"))).toHaveLength(1);
		expect((await recoveredFiles(root)).filter(file => file.endsWith(".patch"))).toHaveLength(1);
		expect(await exists(dirty.baseDir)).toBe(false);
	}, 120_000);
});
