import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { SessionHeader } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { getAgentDir, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";

async function runGit(cwd: string, args: string[]): Promise<string> {
	const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", windowsHide: true });
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (exitCode !== 0) throw new Error(stderr.trim() || `git ${args.join(" ")} failed (${exitCode})`);
	return stdout.trim();
}

/** A checkout with one commit on `branch`, so `HEAD` resolves to a named ref. */
async function createRepo(root: string, name: string, branch: string): Promise<string> {
	const repo = path.join(root, name);
	await fs.mkdir(repo, { recursive: true });
	await runGit(repo, ["init", "-q", "-b", branch]);
	await runGit(repo, ["config", "user.email", "test@example.com"]);
	await runGit(repo, ["config", "user.name", "Test User"]);
	await fs.writeFile(path.join(repo, "README.md"), "hi\n");
	await runGit(repo, ["add", "README.md"]);
	await runGit(repo, ["commit", "-q", "-m", "initial"]);
	return repo;
}

/** The header as an external consumer sees it: parsed back off the JSONL file. */
async function persistedHeader(manager: SessionManager): Promise<SessionHeader> {
	await manager.ensureOnDisk();
	await manager.flush();
	const file = manager.getSessionFile();
	if (!file) throw new Error("Expected a persisted session file");
	return JSON.parse(
		(await fs.readFile(file, "utf8")).split("\n").find(line => line.includes('"type":"session"'))!,
	) as SessionHeader;
}

async function withSandboxedAgentDir<T>(tempDir: string, body: () => Promise<T>): Promise<T> {
	const previous = getAgentDir();
	setAgentDir(path.join(tempDir, "agent"));
	try {
		return await body();
	} finally {
		setAgentDir(previous);
	}
}

describe("session header gitBranch", () => {
	it("records the checked-out branch of the session cwd", async () => {
		using tempDir = TempDir.createSync("@omp-session-branch-");
		const repo = await createRepo(tempDir.path(), "project", "feature/attribution");
		const manager = SessionManager.create(repo, path.join(tempDir.path(), "sessions"));

		expect((await persistedHeader(manager)).gitBranch).toBe("feature/attribution");
	});

	it("omits the branch outside a checkout and on a detached HEAD", async () => {
		using tempDir = TempDir.createSync("@omp-session-branch-absent-");
		const plain = path.join(tempDir.path(), "plain");
		await fs.mkdir(plain, { recursive: true });
		const repo = await createRepo(tempDir.path(), "detached", "main");
		await runGit(repo, ["checkout", "-q", "--detach"]);

		const outside = await persistedHeader(SessionManager.create(plain, path.join(tempDir.path(), "s1")));
		const detached = await persistedHeader(SessionManager.create(repo, path.join(tempDir.path(), "s2")));

		expect(outside.gitBranch).toBeUndefined();
		expect(Object.hasOwn(outside, "gitBranch")).toBe(false);
		expect(detached.gitBranch).toBeUndefined();
	});

	it("re-resolves the branch for sessions derived from a session that has moved on", async () => {
		using tempDir = TempDir.createSync("@omp-session-branch-derived-");
		const repo = await createRepo(tempDir.path(), "project", "main");
		const sessionDir = path.join(tempDir.path(), "sessions");
		const manager = SessionManager.create(repo, sessionDir);
		const leafId = manager.appendMessage({ role: "user", content: "work", timestamp: Date.now() });
		expect((await persistedHeader(manager)).gitBranch).toBe("main");

		// The user switches branches, then splits the session: a derived session
		// must be attributed to the branch it will actually run on, never to the
		// branch its parent header was stamped with.
		await runGit(repo, ["checkout", "-q", "-b", "feature/next"]);

		const forked = await manager.fork();
		expect(forked).toBeDefined();
		expect(manager.getHeader()?.gitBranch).toBe("feature/next");

		const branchedFile = manager.createBranchedSession(leafId);
		expect(branchedFile).toBeDefined();
		const branchedHeader = JSON.parse(
			(await fs.readFile(branchedFile!, "utf8")).split("\n").find(line => line.includes('"type":"session"'))!,
		) as SessionHeader;
		expect(branchedHeader.gitBranch).toBe("feature/next");
	});

	it("re-resolves the branch when the session moves to another checkout", async () => {
		using tempDir = TempDir.createSync("@omp-session-branch-move-");
		await withSandboxedAgentDir(tempDir.path(), async () => {
			const source = await createRepo(tempDir.path(), "source", "main");
			const target = await createRepo(tempDir.path(), "target", "release/1.x");
			const manager = SessionManager.create(source, path.join(tempDir.path(), "sessions"));
			manager.appendMessage({ role: "user", content: "work", timestamp: Date.now() });
			await persistedHeader(manager);

			await manager.moveTo(target, path.join(tempDir.path(), "sessions-target"));

			expect((await persistedHeader(manager)).gitBranch).toBe("release/1.x");
		});
	});

	it("drops the branch when the session moves outside any checkout", async () => {
		using tempDir = TempDir.createSync("@omp-session-branch-move-out-");
		await withSandboxedAgentDir(tempDir.path(), async () => {
			const source = await createRepo(tempDir.path(), "source", "main");
			const plain = path.join(tempDir.path(), "plain");
			await fs.mkdir(plain, { recursive: true });
			const manager = SessionManager.create(source, path.join(tempDir.path(), "sessions"));
			manager.appendMessage({ role: "user", content: "work", timestamp: Date.now() });
			await persistedHeader(manager);

			await manager.moveTo(plain, path.join(tempDir.path(), "sessions-plain"));

			const moved = await persistedHeader(manager);
			expect(moved.gitBranch).toBeUndefined();
			expect(Object.hasOwn(moved, "gitBranch")).toBe(false);
		});
	});
});
