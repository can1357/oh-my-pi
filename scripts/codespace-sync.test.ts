import { afterAll, beforeAll, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { handoff } from "./codespace-sync";

// Bun's ambient type exposes `spawn` as readonly, but the runtime property is
// writable; this named seam is the only way to intercept the script's spawns
// (codespace-sync.ts has no injectable spawn dependency).
const bunRuntime = Bun as unknown as { spawn: typeof Bun.spawn };
const realSpawn = Bun.spawn.bind(Bun);

/** Options shape the engine actually passes: object form with argv in `cmd`. */
interface SpawnCall {
	cmd: string[];
	stdin?: Uint8Array;
	cwd?: string;
	stdout?: "pipe";
	stderr?: "pipe";
	env?: Record<string, string | undefined>;
}

function git(cwd: string, ...args: string[]): string {
	const r = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	if (r.exitCode !== 0) {
		throw new Error(`git ${args.join(" ")} failed:\n${new TextDecoder().decode(r.stderr)}`);
	}
	return new TextDecoder().decode(r.stdout).trim();
}

/** Real subprocess that prints `text` and exits with `code` (keeps the engine's
 * stream/exited plumbing on genuine Subprocess objects). */
function scripted(text: string, code = 0) {
	return realSpawn({
		cmd: [process.execPath, "-e", `process.stdout.write(${JSON.stringify(text)}); process.exit(${code});`],
		stdout: "pipe",
		stderr: "pipe",
	});
}

let tmp: string;
let localRepo: string;
let remoteRepo: string;
let bareOrigin: string;
const sshCalls: string[][] = [];

/** Emulated ssh: translates the engine's remote payloads into local git
 * operations against the fixture "remote" checkout, mimicking Tailscale SSH:
 * transport exit is always 0; the real status travels via the __SSH_RC
 * sentinel the engine appends. Everything else (git, format-patch, commit,
 * push --delete) passes through to the real spawn. */
const fakeSpawnImpl = (call: SpawnCall) => {
	if (call.cmd[0] !== "ssh") return realSpawn(call);
	sshCalls.push([...call.cmd]);
	const payload = call.cmd[call.cmd.length - 1];
	if (payload.includes("test -d")) return scripted("EXISTS\n__SSH_RC=0\n");
	if (payload.includes("git rev-parse HEAD")) return scripted(`${git(remoteRepo, "rev-parse", "HEAD")}\n__SSH_RC=0\n`);
	if (payload.includes("git am --3way")) {
		const branchMatch = payload.match(/git checkout -B "([^"]+)"/) ?? payload.match(/git checkout -B (\S+)/);
		if (branchMatch) git(remoteRepo, "checkout", "-B", branchMatch[1]);
		if (payload.includes("git reset --hard")) git(remoteRepo, "reset", "--hard");
		const am = Bun.spawnSync(["git", "am", "--3way"], { cwd: remoteRepo, stdin: call.stdin, stdout: "pipe", stderr: "pipe" });
		const amOut = new TextDecoder().decode(am.stdout);
		return scripted(`${amOut}__SSH_RC=${am.exitCode}\n`);
	}
	if (payload.includes("git checkout -B")) {
		const branchMatch = payload.match(/git checkout -B "([^"]+)"/) ?? payload.match(/git checkout -B (\S+)/);
		if (branchMatch) git(remoteRepo, "checkout", "-B", branchMatch[1]);
		return scripted("__SSH_RC=0\n");
	}
	return scripted("__SSH_RC=1\n");
};
// The engine only uses the object-form overload; widening the narrow test
// double to Bun.spawn's full overloaded type is inexpressible without a cast.
const fakeSpawn = fakeSpawnImpl as unknown as typeof Bun.spawn;

beforeAll(async () => {
	tmp = await fs.mkdtemp(path.join(os.tmpdir(), "codespace-sync-test-"));
	localRepo = path.join(tmp, "local");
	remoteRepo = path.join(tmp, "remote");
	bareOrigin = path.join(tmp, "origin.git");
	await fs.mkdir(localRepo, { recursive: true });

	git(localRepo, "init", "-b", "main");
	git(localRepo, "config", "user.email", "test@example.com");
	git(localRepo, "config", "user.name", "Test");
	await fs.writeFile(path.join(localRepo, "file1.txt"), "one\n");
	git(localRepo, "add", "-A");
	git(localRepo, "commit", "-m", "c1");

	git(tmp, "init", "--bare", bareOrigin);
	git(localRepo, "remote", "add", "origin", bareOrigin);

	// Fixture "remote" checkout: same repo at c1, as if a prior handoff cloned it.
	git(tmp, "clone", localRepo, remoteRepo);
	git(remoteRepo, "config", "user.email", "test@example.com");
	git(remoteRepo, "config", "user.name", "Test");

	// New uncommitted work the fast path must carry over (handoff stages+commits it).
	await fs.writeFile(path.join(localRepo, "file2.txt"), "two\n");

	// A stale transport artifact in the worktree — the guard must keep it out
	// of the handoff commit even though no .gitignore covers it (regression:
	// a 337 MB bundle once got committed by `git add -A` and ballooned every
	// subsequent handoff patch).
	await fs.writeFile(path.join(localRepo, ".codespace-sync.bundle"), "stale-bundle-bytes\n");

	delete process.env.CODESPACE_SYNC_KEY;
	delete process.env.CODESPACE_SYNC_PORT;
});

afterAll(async () => {
	bunRuntime.spawn = realSpawn;
	await fs.rm(tmp, { recursive: true, force: true });
});

test("handoff fast path applies patch over ssh (regression: buildSshArgv ReferenceError)", async () => {
	bunRuntime.spawn = fakeSpawn;
	try {
		// Exercises the exact branch that crashed in production:
		// remote exists + valid 40-char remote HEAD + nonempty format-patch.
		await handoff(
			{ direction: "handoff", sshTarget: "k@fakemac2", remoteDir: remoteRepo, launch: false },
			{
				ok: true,
				direction: "handoff",
				sshTarget: "k@fakemac2",
				remoteDir: remoteRepo,
				localRepo,
				branch: "main",
				dirtyFiles: 0,
				untrackedFiles: 1,
				stashCount: 0,
				transferBytesEstimate: 4,
			},
		);
	} finally {
		bunRuntime.spawn = realSpawn;
	}

	// git am re-creates commits (committer/date differ), so compare trees.
	expect(git(remoteRepo, "rev-parse", "HEAD^{tree}")).toBe(git(localRepo, "rev-parse", "HEAD^{tree}"));
	expect(git(remoteRepo, "symbolic-ref", "--short", "HEAD")).toBe("handoff/fakemac2");
	const carried = await fs.readFile(path.join(remoteRepo, "file2.txt"), "utf8");
	expect(carried.replace(/\r\n/g, "\n")).toBe("two\n"); // autocrlf may check out CRLF

	// The apply argv must come from sshArgv() — this is where the undefined
	// buildSshArgv() call blew up before the fix.
	const apply = sshCalls.find((c) => c[c.length - 1].includes("git am --3way"));
	expect(apply).toBeDefined();
	expect(apply?.[0]).toBe("ssh");
	expect(apply).toContain("StrictHostKeyChecking=no");

	// Artifact guard: the bundle survives on disk but never enters the commit —
	// locally or on the remote.
	expect(await Bun.file(path.join(localRepo, ".codespace-sync.bundle")).exists()).toBe(true);
	expect(git(localRepo, "ls-tree", "-r", "--name-only", "HEAD")).not.toContain(".codespace-sync.bundle");
	expect(git(remoteRepo, "ls-tree", "-r", "--name-only", "HEAD")).not.toContain(".codespace-sync.bundle");
});
