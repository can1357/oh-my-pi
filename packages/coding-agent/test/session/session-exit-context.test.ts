import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	EXIT_CONTEXT_IO_TIMEOUT_MS,
	type ExitContextSources,
	readExitContext,
	startExitContextReader,
	writeExitIntent,
} from "@oh-my-pi/pi-coding-agent/session/exit-context";
import { EXIT_INTENT_MAX_CHARS } from "@oh-my-pi/pi-coding-agent/session/exit-context-protocol";
import { SESSION_EXIT_CUSTOM_TYPE } from "@oh-my-pi/pi-coding-agent/session/exit-diagnostics";
import { TempDir } from "@oh-my-pi/pi-utils";

// Sessions start the reader thread when they are created; do the same, and wait
// once for it to load, so no assertion below depends on how fast a thread starts.
beforeAll(() => {
	expect(startExitContextReader()).toBeDefined();
	using tempDir = TempDir.createSync("@omp-exit-context-warm-");
	writeExitIntent(1, "stop", tempDir.path());
	const warm = readExitContext(
		{
			pid: 1,
			pane: undefined,
			cgroupFile: tempDir.join("none"),
			cgroupRoot: tempDir.path(),
			intentDir: tempDir.path(),
			processStartMs: 0,
		},
		60_000,
	);
	expect(warm.intent).toBe("stop");
});

const CLI = path.join(import.meta.dir, "../../src/cli.ts");
const CHILD = path.join(import.meta.dir, "../fixtures/session-exit-context-child.ts");

let nextPid = 900_000;

/** Fake sources under `tempDir`: a cgroup v2 membership file, a cgroup tree and an intent directory. */
function fakeSources(tempDir: TempDir, overrides: Partial<ExitContextSources> = {}): ExitContextSources {
	const cgroupRoot = tempDir.join("cgroup");
	const cgroupFile = tempDir.join("proc-self-cgroup");
	const intentDir = tempDir.join("exit-intent");
	fs.mkdirSync(path.join(cgroupRoot, "user.slice", "run-x.scope"), { recursive: true });
	fs.mkdirSync(intentDir, { recursive: true });
	fs.writeFileSync(cgroupFile, "0::/user.slice/run-x.scope\n");
	fs.writeFileSync(
		path.join(cgroupRoot, "user.slice", "run-x.scope", "memory.events"),
		"low 0\nhigh 0\nmax 4\noom 2\noom_kill 3\noom_group_kill 1\n",
	);
	return {
		pid: nextPid++,
		pane: "%7",
		cgroupFile,
		cgroupRoot,
		intentDir,
		processStartMs: Date.now() - 60_000,
		...overrides,
	};
}

function intentPath(sources: ExitContextSources): string {
	return path.join(sources.intentDir, String(sources.pid));
}

/** The `session_exit` data of the session file at `sessionFile`. */
async function readExitEntry(sessionFile: string): Promise<Record<string, unknown>> {
	const lines = (await Bun.file(sessionFile).text()).split("\n").filter(Boolean);
	const entries = lines.map(line => JSON.parse(line) as { type: string; customType?: string; data?: unknown });
	const exit = entries.findLast(entry => entry.type === "custom" && entry.customType === SESSION_EXIT_CUSTOM_TYPE);
	if (!exit) throw new Error(`No session_exit entry in ${sessionFile}`);
	return exit.data as Record<string, unknown>;
}

/** The `oom_kill` count of process `pid`'s cgroup v2, read independently of the code under test. */
function liveOomKills(pid: number): number | undefined {
	try {
		const line = fs
			.readFileSync(`/proc/${pid}/cgroup`, "utf8")
			.split("\n")
			.find(entry => entry.startsWith("0::/"));
		if (!line) return undefined;
		const events = fs.readFileSync(path.join("/sys/fs/cgroup", line.slice(3), "memory.events"), "utf8");
		const match = /^oom_kill (\d+)$/m.exec(events);
		return match ? Number(match[1]) : undefined;
	} catch {
		return undefined;
	}
}

/** Environment whose state directory is `home`, so the intent directory is private to the test. */
function privateHomeEnv(home: string, extra: Record<string, string> = {}): Record<string, string | undefined> {
	const env: Record<string, string | undefined> = { ...process.env, HOME: home, ...extra };
	delete env.XDG_STATE_HOME;
	delete env.PI_CODING_AGENT_DIR;
	delete env.PI_CONFIG_FILES;
	return env;
}

async function startChild(tempDir: TempDir, mode: "signal" | "normal", env: Record<string, string | undefined>) {
	const sessionDir = tempDir.join("sessions");
	fs.mkdirSync(sessionDir, { recursive: true });
	const child = Bun.spawn([process.execPath, CHILD, sessionDir, mode], {
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
		env,
	});
	const reader = child.stdout.getReader();
	let output = "";
	while (!output.includes("\n")) {
		const { value, done } = await reader.read();
		if (done) throw new Error(`child exited before ready: ${await new Response(child.stderr).text()}`);
		output += new TextDecoder().decode(value);
	}
	reader.releaseLock();
	const match = /^ready (.+)$/m.exec(output);
	if (!match) throw new Error(`unexpected child output: ${output}`);
	return { child, sessionFile: match[1]! };
}

function runExitIntentCli(home: string, args: string[]) {
	return Bun.spawnSync([process.execPath, CLI, "session", "exit-intent", ...args], { env: privateHomeEnv(home) });
}

describe("readExitContext", () => {
	it("records pid, pane, oom kills and the intent, and consumes the intent file once", () => {
		using tempDir = TempDir.createSync("@omp-exit-context-");
		const sources = fakeSources(tempDir);
		fs.writeFileSync(intentPath(sources), "restart\n");

		expect(readExitContext(sources)).toEqual({ pid: sources.pid, pane: "%7", oomKills: 3, intent: "restart" });
		expect(fs.existsSync(intentPath(sources))).toBe(false);

		// Another session of the same process exiting at the same signal sees the same word.
		expect(readExitContext(sources).intent).toBe("restart");
		expect(fs.existsSync(intentPath(sources))).toBe(false);
		// The claimed copy is gone too.
		expect(fs.readdirSync(sources.intentDir)).toEqual([]);
	});

	it("does not wait past its deadline, and a later exit records what a late read claimed", () => {
		using tempDir = TempDir.createSync("@omp-exit-context-deadline-");
		const sources = fakeSources(tempDir);
		fs.writeFileSync(intentPath(sources), "restart\n");
		const started = performance.now();
		const first = readExitContext(sources, 0);
		expect(performance.now() - started).toBeLessThan(1_000);
		// With no time to wait, the reader answers in time only if it is faster than the check
		// that follows; either way the entry has pid and pane, and nothing is half-recorded.
		if (first.intent === undefined) expect(first).toEqual({ pid: sources.pid, pane: "%7" });
		else expect(first).toEqual({ pid: sources.pid, pane: "%7", oomKills: 3, intent: "restart" });

		// A late reader goes on, claims the file, and answers into shared memory.
		const deadline = Date.now() + 20_000;
		while (fs.readdirSync(sources.intentDir).length > 0 && Date.now() < deadline) Bun.sleepSync(20);
		expect(fs.readdirSync(sources.intentDir)).toEqual([]);
		Bun.sleepSync(200);

		expect(readExitContext(sources)).toEqual({ pid: sources.pid, pane: "%7", oomKills: 3, intent: "restart" });
	});

	it("records a fresh intent written after a stale one was dropped", () => {
		using tempDir = TempDir.createSync("@omp-exit-context-stale-fresh-");
		const sources = fakeSources(tempDir, { processStartMs: Date.now() - 1_000 });
		fs.writeFileSync(intentPath(sources), "move\n");
		const past = new Date(Date.now() - 3_600_000);
		fs.utimesSync(intentPath(sources), past, past);
		expect(readExitContext(sources).intent).toBeUndefined();

		writeExitIntent(sources.pid, "restart", sources.intentDir);
		expect(readExitContext(sources).intent).toBe("restart");
		expect(fs.readdirSync(sources.intentDir)).toEqual([]);
	});

	it("keeps the first word for the process and leaves a later intent file untouched", () => {
		using tempDir = TempDir.createSync("@omp-exit-context-rewrite-");
		const sources = fakeSources(tempDir);
		writeExitIntent(sources.pid, "restart", sources.intentDir);
		expect(readExitContext(sources).intent).toBe("restart");
		writeExitIntent(sources.pid, "stop", sources.intentDir);
		expect(readExitContext(sources).intent).toBe("restart");
		expect(fs.readFileSync(intentPath(sources), "utf8")).toBe("stop\n");
	});

	it("leaves each field absent when its source is missing", () => {
		using tempDir = TempDir.createSync("@omp-exit-context-missing-");
		const sources = fakeSources(tempDir, {
			pane: undefined,
			cgroupFile: tempDir.join("no-such-cgroup"),
		});
		expect(readExitContext(sources)).toEqual({ pid: sources.pid });
		expect(readExitContext({ ...sources, pane: "" })).toEqual({ pid: sources.pid });
		expect(readExitContext({ ...sources, intentDir: tempDir.join("no-such-dir") })).toEqual({ pid: sources.pid });
	});

	it("leaves oomKills absent without cgroup v2, without memory.events, or without an oom_kill line", () => {
		using tempDir = TempDir.createSync("@omp-exit-context-cgroup-");
		const sources = fakeSources(tempDir, { pane: undefined });
		fs.writeFileSync(sources.cgroupFile, "12:memory:/user.slice\n1:name=systemd:/user.slice\n");
		expect(readExitContext(sources).oomKills).toBeUndefined();

		fs.writeFileSync(sources.cgroupFile, "0::/elsewhere.scope\n");
		expect(readExitContext(sources).oomKills).toBeUndefined();

		fs.writeFileSync(sources.cgroupFile, "0::/user.slice/run-x.scope\n");
		fs.writeFileSync(path.join(sources.cgroupRoot, "user.slice", "run-x.scope", "memory.events"), "oom 1\n");
		expect(readExitContext(sources).oomKills).toBeUndefined();

		fs.writeFileSync(path.join(sources.cgroupRoot, "user.slice", "run-x.scope", "memory.events"), "oom_kill many\n");
		expect(readExitContext(sources).oomKills).toBeUndefined();
	});

	it.skipIf(process.getuid?.() === 0)("leaves fields absent when their files are unreadable", () => {
		using tempDir = TempDir.createSync("@omp-exit-context-unreadable-");
		const sources = fakeSources(tempDir, { pane: undefined });
		const eventsPath = path.join(sources.cgroupRoot, "user.slice", "run-x.scope", "memory.events");
		fs.writeFileSync(intentPath(sources), "stop\n");
		fs.chmodSync(eventsPath, 0o000);
		fs.chmodSync(intentPath(sources), 0o000);
		try {
			expect(readExitContext(sources)).toEqual({ pid: sources.pid });
		} finally {
			fs.chmodSync(eventsPath, 0o644);
		}
	});

	it("does not wait on a FIFO or follow a symlink at the intent path", () => {
		using tempDir = TempDir.createSync("@omp-exit-context-special-");
		const fifoSources = fakeSources(tempDir, { pane: undefined });
		Bun.spawnSync(["mkfifo", intentPath(fifoSources)]);
		expect(fs.statSync(intentPath(fifoSources)).isFIFO()).toBe(true);
		const started = performance.now();
		expect(readExitContext(fifoSources).intent).toBeUndefined();
		expect(performance.now() - started).toBeLessThan(1_000);

		const linkSources = fakeSources(tempDir, { pane: undefined });
		fs.writeFileSync(tempDir.join("target"), "move\n");
		fs.symlinkSync(tempDir.join("target"), intentPath(linkSources));
		expect(readExitContext(linkSources).intent).toBeUndefined();
	});

	it("ignores and removes an intent file older than the process", () => {
		using tempDir = TempDir.createSync("@omp-exit-context-stale-");
		const sources = fakeSources(tempDir, { processStartMs: Date.now() });
		fs.writeFileSync(intentPath(sources), "move\n");
		const past = new Date(Date.now() - 3_600_000);
		fs.utimesSync(intentPath(sources), past, past);
		expect(readExitContext(sources).intent).toBeUndefined();
		expect(fs.existsSync(intentPath(sources))).toBe(false);
	});

	it("records any word as given, cut to the maximum length", () => {
		using tempDir = TempDir.createSync("@omp-exit-context-word-");
		const custom = fakeSources(tempDir);
		fs.writeFileSync(intentPath(custom), "  oom-guard \n");
		expect(readExitContext(custom).intent).toBe("oom-guard");

		const long = fakeSources(tempDir);
		fs.writeFileSync(intentPath(long), "x".repeat(10_000));
		expect(readExitContext(long).intent).toBe("x".repeat(EXIT_INTENT_MAX_CHARS));

		const blank = fakeSources(tempDir);
		fs.writeFileSync(intentPath(blank), " \n");
		expect(readExitContext(blank).intent).toBeUndefined();
	});
});

describe("writeExitIntent", () => {
	it("writes the word whole and leaves no staging file", () => {
		using tempDir = TempDir.createSync("@omp-exit-intent-write-");
		const dir = tempDir.join("nested", "exit-intent");
		const target = writeExitIntent(4242, "stop", dir);
		expect(target).toBe(path.join(dir, "4242"));
		expect(fs.readFileSync(target, "utf8")).toBe("stop\n");
		expect(fs.readdirSync(dir)).toEqual(["4242"]);

		writeExitIntent(4242, "move", dir);
		expect(fs.readFileSync(target, "utf8")).toBe("move\n");
		expect(fs.readdirSync(dir)).toEqual(["4242"]);
	});

	describe("where rename over an existing file is refused (Windows)", () => {
		afterEach(() => {
			vi.restoreAllMocks();
		});

		const refusal = () => Object.assign(new Error("EPERM: operation not permitted, rename"), { code: "EPERM" });

		it("replaces an earlier word and leaves no staging or backup file", () => {
			using tempDir = TempDir.createSync("@omp-exit-intent-win-");
			const dir = tempDir.path();
			const target = writeExitIntent(4242, "stop", dir);
			const rename = fs.renameSync.bind(fs);
			let refused = 0;
			vi.spyOn(fs, "renameSync").mockImplementation((source, destination) => {
				if (destination === target && fs.existsSync(target)) {
					refused++;
					throw refusal();
				}
				rename(source, destination);
			});

			writeExitIntent(4242, "move", dir);
			expect(refused).toBe(1);
			expect(fs.readFileSync(target, "utf8")).toBe("move\n");
			expect(fs.readdirSync(dir)).toEqual(["4242"]);
		});

		it("keeps the earlier word when the retry is refused too", () => {
			using tempDir = TempDir.createSync("@omp-exit-intent-win-keep-");
			const dir = tempDir.path();
			const target = writeExitIntent(4242, "stop", dir);
			const rename = fs.renameSync.bind(fs);
			vi.spyOn(fs, "renameSync").mockImplementation((source, destination) => {
				if (destination === target && String(source).endsWith(".tmp")) throw refusal();
				rename(source, destination);
			});

			expect(() => writeExitIntent(4242, "move", dir)).toThrow("EPERM");
			expect(fs.readFileSync(target, "utf8")).toBe("stop\n");
			expect(fs.readdirSync(dir)).toEqual(["4242"]);
		});
	});

	it("refuses a pid that is not a positive integer", () => {
		using tempDir = TempDir.createSync("@omp-exit-intent-pid-");
		for (const pid of [0, -1, 1.5, Number.NaN]) {
			expect(() => writeExitIntent(pid, "stop", tempDir.path())).toThrow("Invalid pid");
		}
		expect(fs.readdirSync(tempDir.path())).toEqual([]);
	});
});

describe("omp session exit-intent", () => {
	it("writes <state>/run/exit-intent/<pid> and refuses a bad pid or intent", () => {
		using tempDir = TempDir.createSync("@omp-exit-intent-cli-");
		const home = tempDir.join("home");
		fs.mkdirSync(home);
		const expected = path.join(home, ".omp", "run", "exit-intent", "4242");

		const ok = runExitIntentCli(home, ["4242", "restart"]);
		expect(ok.exitCode, ok.stderr.toString()).toBe(0);
		expect(ok.stdout.toString()).toBe(`${expected}\n`);
		expect(fs.readFileSync(expected, "utf8")).toBe("restart\n");

		for (const args of [["4242", "reboot"], ["0", "stop"], ["abc", "stop"], ["4242"], ["4242", "stop", "extra"]]) {
			const bad = runExitIntentCli(home, args);
			expect(bad.exitCode, `${args.join(" ")}: ${bad.stdout}`).not.toBe(0);
		}
		expect(fs.readFileSync(expected, "utf8")).toBe("restart\n");
	}, 60_000);
});

describe("session_exit entry", () => {
	it("a SIGTERM after `omp session exit-intent` records pid, pane, oom kills and the intent", async () => {
		using tempDir = TempDir.createSync("@omp-exit-context-signal-");
		const home = tempDir.join("home");
		fs.mkdirSync(home);
		const { child, sessionFile } = await startChild(tempDir, "signal", privateHomeEnv(home, { TMUX_PANE: "%42" }));
		const oomKills = liveOomKills(child.pid);

		const cli = runExitIntentCli(home, [String(child.pid), "restart"]);
		expect(cli.exitCode, cli.stderr.toString()).toBe(0);
		const intentFile = cli.stdout.toString().trim();
		expect(fs.existsSync(intentFile)).toBe(true);

		child.kill("SIGTERM");
		await child.exited;

		const data = await readExitEntry(sessionFile);
		expect(data).toMatchObject({ reason: "sigterm", kind: "signal", pid: child.pid, pane: "%42", intent: "restart" });
		if (oomKills === undefined) expect(data).not.toHaveProperty("oomKills");
		else expect(data.oomKills).toBe(oomKills);
		expect(fs.existsSync(intentFile)).toBe(false);
	}, 60_000);

	it("a normal exit without an intent file records pid and leaves intent and pane absent", async () => {
		using tempDir = TempDir.createSync("@omp-exit-context-normal-");
		const home = tempDir.join("home");
		fs.mkdirSync(home);
		const env = privateHomeEnv(home);
		delete env.TMUX_PANE;
		const { child, sessionFile } = await startChild(tempDir, "normal", env);
		const oomKills = liveOomKills(child.pid);
		child.stdin.end();
		expect(await child.exited).toBe(0);

		const data = await readExitEntry(sessionFile);
		expect(data).toMatchObject({ reason: "dispose", kind: "normal", pid: child.pid });
		expect(data).not.toHaveProperty("intent");
		expect(data).not.toHaveProperty("pane");
		if (oomKills === undefined) expect(data).not.toHaveProperty("oomKills");
		else expect(data.oomKills).toBe(oomKills);
	}, 60_000);
});

const SLOW_FUSE = path.join(import.meta.dir, "../fixtures/slow-fuse.py");
const fuseAvailable =
	process.platform === "linux" &&
	fs.existsSync("/dev/fuse") &&
	Bun.which("fusermount3") !== null &&
	Bun.which("python3") !== null;

// Last in the file: it replaces the module's reader thread.
describe.skipIf(!fuseAvailable)("on a filesystem that does not answer", () => {
	it("bounds the wait, skips the reads while the reader is stuck, and starts a new reader after it dies", async () => {
		using tempDir = TempDir.createSync("@omp-exit-context-fuse-");
		const mount = tempDir.join("mount");
		const server = Bun.spawn(["python3", SLOW_FUSE, mount, "30"], { stdout: "pipe", stderr: "pipe" });
		try {
			const reader = server.stdout.getReader();
			const { value } = await reader.read();
			reader.releaseLock();
			expect(new TextDecoder().decode(value)).toContain("MOUNT_READY");

			// The reader's lookup of <mount>/<pid> waits 30 s in the kernel; the exit does not.
			const hung = fakeSources(tempDir, { intentDir: mount });
			const started = performance.now();
			expect(readExitContext(hung)).toEqual({ pid: hung.pid, pane: "%7" });
			const waited = performance.now() - started;
			expect(waited).toBeGreaterThanOrEqual(EXIT_CONTEXT_IO_TIMEOUT_MS - 50);
			expect(waited).toBeLessThan(EXIT_CONTEXT_IO_TIMEOUT_MS + 1_500);

			// While the reader is stuck, another exit records what needs no I/O without waiting.
			const local = fakeSources(tempDir);
			writeExitIntent(local.pid, "move", local.intentDir);
			const again = performance.now();
			expect(readExitContext(local)).toEqual({ pid: local.pid, pane: "%7" });
			expect(performance.now() - again).toBeLessThan(200);

			// The stuck reader dies (here: terminated, then its request aborted with the server).
			const stuck = startExitContextReader();
			if (!stuck) throw new Error("expected a reader thread");
			const closed = Promise.withResolvers<void>();
			stuck.addEventListener("close", () => closed.resolve());
			stuck.terminate();
			server.kill("SIGKILL");
			await closed.promise;

			// The next exit starts a new reader and reads again.
			expect(readExitContext(local)).toEqual({ pid: local.pid, pane: "%7", oomKills: 3, intent: "move" });
		} finally {
			server.kill("SIGKILL");
			await server.exited;
			Bun.spawnSync(["fusermount3", "-u", "-z", mount]);
		}
	}, 120_000);
});
