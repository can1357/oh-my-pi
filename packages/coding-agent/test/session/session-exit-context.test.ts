import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExitContext } from "@oh-my-pi/pi-coding-agent/session/exit-context";
import {
	defaultExitContextSources,
	type ExitContextSources,
	readExitContext,
	startExitContextReader,
	writeExitIntent,
} from "@oh-my-pi/pi-coding-agent/session/exit-context";
import {
	EXIT_CONTEXT_IO_TIMEOUT_MS,
	EXIT_INTENT_MAX_CHARS,
} from "@oh-my-pi/pi-coding-agent/session/exit-context-protocol";
import { SESSION_EXIT_CUSTOM_TYPE } from "@oh-my-pi/pi-coding-agent/session/exit-diagnostics";
import { TempDir } from "@oh-my-pi/pi-utils";
import type { ExitContextThreadRequest } from "../fixtures/session-exit-context-thread";

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
const SIGNAL_TREE = path.join(import.meta.dir, "../fixtures/session-exit-signal-tree.ts");

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

	it("a SIGTERM records the signal and the intent for a parent and its worker-thread subagents, idle and busy", async () => {
		using tempDir = TempDir.createSync("@omp-exit-context-signal-tree-");
		const home = tempDir.join("home");
		fs.mkdirSync(home);
		const child = Bun.spawn([process.execPath, SIGNAL_TREE, tempDir.join("tree")], {
			stdout: "pipe",
			stderr: "pipe",
			env: privateHomeEnv(home, { TMUX_PANE: "%43" }),
		});
		try {
			const reader = child.stdout.getReader();
			let output = "";
			while (!output.includes("\n")) {
				const { value, done } = await reader.read();
				if (done) throw new Error(`tree exited before ready: ${await new Response(child.stderr).text()}`);
				output += new TextDecoder().decode(value);
			}
			reader.releaseLock();
			const ready = /^READY (.+)$/m.exec(output);
			if (!ready) throw new Error(`unexpected tree output: ${output}`);
			const files = JSON.parse(ready[1]!) as { parent: string; idle: string; busy: string };

			const cli = runExitIntentCli(home, [String(child.pid), "restart"]);
			expect(cli.exitCode, cli.stderr.toString()).toBe(0);
			child.kill("SIGTERM");
			await child.exited;

			const expected = { reason: "sigterm", kind: "signal", pid: child.pid, pane: "%43", intent: "restart" };
			expect(await readExitEntry(files.parent)).toMatchObject(expected);
			// Released by the parent's lifecycle teardown.
			expect(await readExitEntry(files.idle)).toMatchObject(expected);
			// Still running its tool call: the worker pool's exit teardown disposes it before terminating the worker.
			expect(await readExitEntry(files.busy)).toMatchObject({
				...expected,
				pendingToolCalls: [{ toolName: "bash" }],
			});
			expect(fs.existsSync(cli.stdout.toString().trim())).toBe(false);
		} finally {
			child.kill("SIGKILL");
			await child.exited;
		}
	}, 120_000);
});

const THREAD = path.join(import.meta.dir, "../fixtures/session-exit-context-thread.ts");

interface SessionThread extends Disposable {
	post(request: ExitContextThreadRequest): void;
	/** The thread's next message: `"at-gate"` for a gated request, then what its session records. */
	next(): Promise<unknown>;
	read(request: ExitContextThreadRequest): Promise<ExitContext>;
}

/** A worker thread of this process with its own session realm, as a worker-thread subagent has. */
async function startSessionThread(tempDir: TempDir): Promise<SessionThread> {
	const worker = new Worker(THREAD, { type: "module" });
	const inbox: unknown[] = [];
	const waiters: PromiseWithResolvers<unknown>[] = [];
	worker.addEventListener("message", event => {
		const waiter = waiters.shift();
		if (waiter) waiter.resolve(event.data);
		else inbox.push(event.data);
	});
	worker.addEventListener("error", event => {
		for (const waiter of waiters.splice(0)) waiter.reject(new Error(event.message));
	});
	const thread: SessionThread = {
		post(request) {
			worker.postMessage(request);
		},
		next() {
			if (inbox.length > 0) return Promise.resolve(inbox.shift());
			const waiter = Promise.withResolvers<unknown>();
			waiters.push(waiter);
			return waiter.promise;
		},
		async read(request) {
			thread.post(request);
			return (await thread.next()) as ExitContext;
		},
		[Symbol.dispose]() {
			worker.terminate();
		},
	};
	try {
		expect(await thread.next()).toBe("ready");
		// Load the thread's reader on a source without an intent, so a test's reads race only on the claim.
		await thread.read({ sources: fakeSources(tempDir) });
	} catch (error) {
		worker.terminate();
		throw error;
	}
	return thread;
}

describe("sessions on several threads of one process", () => {
	it("a session on a worker thread records the word a main-thread session claimed", async () => {
		using tempDir = TempDir.createSync("@omp-exit-context-main-first-");
		using thread = await startSessionThread(tempDir);
		const sources = fakeSources(tempDir);
		writeExitIntent(sources.pid, "restart", sources.intentDir);

		expect(readExitContext(sources).intent).toBe("restart");
		expect(fs.existsSync(intentPath(sources))).toBe(false);
		expect(await thread.read({ sources })).toEqual({ pid: sources.pid, pane: "%7", oomKills: 3, intent: "restart" });
	}, 60_000);

	it("a main-thread session records the word a worker-thread session claimed", async () => {
		using tempDir = TempDir.createSync("@omp-exit-context-worker-first-");
		using thread = await startSessionThread(tempDir);
		const sources = fakeSources(tempDir);
		writeExitIntent(sources.pid, "restart", sources.intentDir);

		expect((await thread.read({ sources })).intent).toBe("restart");
		expect(fs.existsSync(intentPath(sources))).toBe(false);
		expect(readExitContext(sources)).toEqual({ pid: sources.pid, pane: "%7", oomKills: 3, intent: "restart" });
	}, 60_000);

	it("sessions on several threads exiting at once all record the word", async () => {
		using tempDir = TempDir.createSync("@omp-exit-context-threads-at-once-");
		const threads = await Promise.all(Array.from({ length: 4 }, () => startSessionThread(tempDir)));
		try {
			const sources = fakeSources(tempDir);
			writeExitIntent(sources.pid, "stop", sources.intentDir);
			const gate = new SharedArrayBuffer(4);
			for (const thread of threads) thread.post({ sources, gate });
			for (const thread of threads) expect(await thread.next()).toBe("at-gate");
			const gateWord = new Int32Array(gate);
			Atomics.store(gateWord, 0, 1);
			Atomics.notify(gateWord, 0);

			const contexts = (await Promise.all(threads.map(thread => thread.next()))) as ExitContext[];
			expect(contexts.map(context => context.intent)).toEqual(threads.map(() => "stop"));
			expect(fs.readdirSync(sources.intentDir)).toEqual([]);
			expect(readExitContext(sources).intent).toBe("stop");
		} finally {
			for (const thread of threads) thread[Symbol.dispose]();
		}
	}, 120_000);

	it("a session on a thread started after the word was published records it", async () => {
		using tempDir = TempDir.createSync("@omp-exit-context-late-thread-");
		const sources = fakeSources(tempDir);
		writeExitIntent(sources.pid, "restart", sources.intentDir);
		// Published after the process started and before the thread below starts.
		const published = new Date((defaultExitContextSources().processStartMs + Date.now()) / 2);
		fs.utimesSync(intentPath(sources), published, published);
		using thread = await startSessionThread(tempDir);

		// The thread dates the file against its own default process start, as its sessions do.
		const context = await thread.read({ sources, processStart: "thread" });
		expect(context.intent).toBe("restart");
		expect(fs.readdirSync(sources.intentDir)).toEqual([]);
		expect(readExitContext(sources).intent).toBe("restart");
	}, 60_000);

	it("a thread still drops an intent file older than the process", async () => {
		using tempDir = TempDir.createSync("@omp-exit-context-process-start-");
		using thread = await startSessionThread(tempDir);
		const sources = fakeSources(tempDir);
		// A file written before the process started is stale on every thread.
		writeExitIntent(sources.pid, "move", sources.intentDir);
		const beforeProcess = new Date(defaultExitContextSources().processStartMs - 60_000);
		fs.utimesSync(intentPath(sources), beforeProcess, beforeProcess);

		expect((await thread.read({ sources, processStart: "thread" })).intent).toBeUndefined();
		expect(fs.existsSync(intentPath(sources))).toBe(false);
	}, 60_000);
});

const KILLED_READER = path.join(import.meta.dir, "../fixtures/session-exit-context-killed-reader.ts");
// strace holds the reader thread in one real call of its claim, so the test can kill it exactly there.
const straceAvailable =
	process.platform === "linux" &&
	Bun.which("strace") !== null &&
	Bun.spawnSync(["strace", "-f", "-o", "/dev/null", "true"]).exitCode === 0;

interface KilledReaderResult {
	claimed: string[];
	afterDeath: ExitContext;
	files: string[];
}

/** Run the killed-reader fixture with strace holding the reader thread's first `syscalls` call for 6 s. */
async function runKilledReader(
	tempDir: TempDir,
	syscalls: string,
	phase: "enter" | "exit",
): Promise<KilledReaderResult> {
	const dir = tempDir.join("exit-intent");
	fs.mkdirSync(dir, { recursive: true });
	const child = Bun.spawn(
		[
			"strace",
			"-f",
			"-qq",
			"-o",
			"/dev/null",
			"-e",
			`trace=${syscalls}`,
			"-e",
			`inject=${syscalls}:delay_${phase}=6s:when=1`,
			process.execPath,
			KILLED_READER,
			dir,
		],
		{ stdout: "pipe", stderr: "pipe" },
	);
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	expect(exitCode, stderr).toBe(0);
	return JSON.parse(stdout.trim()) as KilledReaderResult;
}

describe.skipIf(!straceAvailable)("a reader that dies in the middle of a claim", () => {
	it("loses no word when it dies after taking the file and before publishing the word", async () => {
		using tempDir = TempDir.createSync("@omp-exit-context-killed-renamed-");
		// Held on the way out of the rename: the file is taken, nothing is read or published yet.
		const result = await runKilledReader(tempDir, "rename,renameat,renameat2", "exit");
		expect(result.claimed).toHaveLength(1);
		expect(result.afterDeath.intent).toBe("restart");
		expect(result.files).toEqual([]);
	}, 90_000);

	it("loses no word when it dies while it deletes its claimed copy", async () => {
		using tempDir = TempDir.createSync("@omp-exit-context-killed-unlink-");
		const result = await runKilledReader(tempDir, "unlink,unlinkat", "enter");
		expect(result.claimed).toHaveLength(1);
		expect(result.afterDeath.intent).toBe("restart");
		// The word is on the board before the copy is deleted; whether the held unlink finishes is the kernel's business.
		expect(result.files.filter(name => !name.includes(".claimed-"))).toEqual([]);
	}, 90_000);
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
