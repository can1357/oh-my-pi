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

/** Options shape the engine actually passes: object form with argv in `cmd`.
 * `stdin` is a Uint8Array or a BunFile (which carries its path in `name`). */
interface SpawnCall {
	cmd: string[];
	stdin?: Uint8Array | { name?: string };
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

/** Real subprocess that prints `text` and exits 0 (keeps the engine's
 * stream/exited plumbing on genuine Subprocess objects). */
function scripted(text: string) {
	return realSpawn({
		cmd: [process.execPath, "-e", `process.stdout.write(${JSON.stringify(text)});`],
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
 * sentinel the engine appends. Everything else (git bundle/rev-parse/commit/
 * push --delete) passes through to the real spawn. */
const fakeSpawnImpl = (call: SpawnCall) => {
	if (call.cmd[0] !== "ssh") return realSpawn(call as never);
	sshCalls.push([...call.cmd]);
	const payload = call.cmd[call.cmd.length - 1];
	const run = (label: string, fn: () => void) => {
		try {
			fn();
			return scripted("__SSH_RC=0\n");
		} catch (err) {
			return scripted(`${label} failed: ${err instanceof Error ? err.message : String(err)}\n__SSH_RC=1\n`);
		}
	};
	if (payload.includes("test -d")) return scripted("EXISTS\n__SSH_RC=0\n");
	if (payload.includes("git rev-list"))
		return scripted(`${git(remoteRepo, "rev-list", "--max-count=100", "HEAD")}\n__SSH_RC=0\n`);
	if (payload.includes('git rev-parse "HEAD^{tree}"'))
		return scripted(`${git(remoteRepo, "rev-parse", "HEAD^{tree}")}\n__SSH_RC=0\n`);
	if (payload.includes("git rev-parse HEAD")) return scripted(`${git(remoteRepo, "rev-parse", "HEAD")}\n__SSH_RC=0\n`);
	if (payload.includes("codespace-handoff.bundle")) {
		// Bundle apply: the engine streams the local bundle file via stdin
		// (a BunFile whose `name` is the tmp path). Fetch it into the fixture
		// remote and align the branch exactly like the remote shell would.
		const stdin = call.stdin;
		const bundlePath = stdin && typeof stdin === "object" && "name" in stdin ? stdin.name : undefined;
		const m = payload.match(/git checkout -B "([^"]+)" ([0-9a-f]{40})/);
		return run("bundle apply", () => {
			if (!bundlePath || !m) throw new Error("bundle path or checkout target missing");
			git(remoteRepo, "reset", "--hard");
			git(remoteRepo, "clean", "-fd");
			git(remoteRepo, "fetch", bundlePath, "HEAD");
			git(remoteRepo, "checkout", "-B", m[1], m[2]);
		});
	}
	if (payload.includes("git checkout -B")) {
		// Align path (remote already has every object).
		const m = payload.match(/git checkout -B "([^"]+)" ([0-9a-f]{40})/);
		return run("align", () => {
			if (!m) throw new Error("align target missing");
			git(remoteRepo, "reset", "--hard");
			git(remoteRepo, "clean", "-fd");
			git(remoteRepo, "checkout", "-B", m[1], m[2]);
		});
	}
	return scripted("__SSH_RC=1\n");
};
// The engine only uses the object-form overload; widening the narrow test
// double to Bun.spawn's full overloaded type is inexpressible without a cast.
const fakeSpawn = fakeSpawnImpl as unknown as typeof Bun.spawn;

const handoffArgs = () => ({
	opts: { direction: "handoff" as const, sshTarget: "k@fakemac2", remoteDir: remoteRepo, launch: false },
	plan: {
		ok: true as const,
		direction: "handoff" as const,
		sshTarget: "k@fakemac2",
		remoteDir: remoteRepo,
		localRepo,
		branch: "main",
		dirtyFiles: 0,
		untrackedFiles: 1,
		stashCount: 0,
		transferBytesEstimate: 4,
	},
});

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

test("handoff fast path delivers a bundle over ssh with exact sha alignment", async () => {
	bunRuntime.spawn = fakeSpawn;
	try {
		const { opts, plan } = handoffArgs();
		await handoff(opts, plan);
	} finally {
		bunRuntime.spawn = realSpawn;
	}

	// Bundles transfer real objects — remote HEAD must be the EXACT local sha
	// (the old `git am` transport rewrote commits and broke incrementality).
	expect(git(remoteRepo, "rev-parse", "HEAD")).toBe(git(localRepo, "rev-parse", "HEAD"));
	expect(git(remoteRepo, "rev-parse", "HEAD^{tree}")).toBe(git(localRepo, "rev-parse", "HEAD^{tree}"));
	expect(git(remoteRepo, "symbolic-ref", "--short", "HEAD")).toBe("handoff/fakemac2");
	const carried = await fs.readFile(path.join(remoteRepo, "file2.txt"), "utf8");
	expect(carried.replace(/\r\n/g, "\n")).toBe("two\n"); // autocrlf may check out CRLF

	// Artifact guard: the stale bundle survives on disk but never enters the
	// commit — locally or on the remote.
	expect(await Bun.file(path.join(localRepo, ".codespace-sync.bundle")).exists()).toBe(true);
	expect(git(localRepo, "ls-tree", "-r", "--name-only", "HEAD")).not.toContain(".codespace-sync.bundle");
	expect(git(remoteRepo, "ls-tree", "-r", "--name-only", "HEAD")).not.toContain(".codespace-sync.bundle");

	// The apply argv must come from sshArgv() (regression: an undefined
	// buildSshArgv() call once crashed exactly this branch).
	const apply = sshCalls.find(c => c[c.length - 1].includes("codespace-handoff.bundle"));
	expect(apply).toBeDefined();
	expect(apply?.[0]).toBe("ssh");
	expect(apply).toContain("StrictHostKeyChecking=no");
});

test("second handoff stays incremental (regression: rewritten shas replayed whole history)", async () => {
	// New work between handoffs — run 2 must ship ONLY this as a small bundle.
	await fs.writeFile(path.join(localRepo, "file3.txt"), "three\n");
	const before = sshCalls.length;
	bunRuntime.spawn = fakeSpawn;
	try {
		const { opts, plan } = handoffArgs();
		await handoff(opts, plan);
	} finally {
		bunRuntime.spawn = realSpawn;
	}

	// Still converged after a re-run…
	expect(git(remoteRepo, "rev-parse", "HEAD")).toBe(git(localRepo, "rev-parse", "HEAD"));
	expect(git(remoteRepo, "rev-parse", "HEAD^{tree}")).toBe(git(localRepo, "rev-parse", "HEAD^{tree}"));

	// …via a second incremental bundle on the fast path (no git-push fallback).
	const secondRun = sshCalls.slice(before);
	expect(secondRun.some(c => c[c.length - 1].includes("codespace-handoff.bundle"))).toBe(true);
	expect(secondRun.some(c => c[c.length - 1].includes('git fetch "'))).toBe(false);
	const carried = await fs.readFile(path.join(remoteRepo, "file3.txt"), "utf8");
	expect(carried.replace(/\r\n/g, "\n")).toBe("three\n");
});
