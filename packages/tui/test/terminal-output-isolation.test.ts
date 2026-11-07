/**
 * Terminal output isolation regression — real ProcessTerminal + TUI inside a
 * native PtySession PTY.
 *
 * Regression scenario (mirrors the manual reproduction): a TUI owns the
 * terminal, then a grandchild spawned with INHERITED stdio — and the process
 * itself, through ordinary process.stdout/process.stderr/raw-fd writes —
 * emits plain compiler diagnostics to fd 1/fd 2. Those bytes bypassed the
 * renderer and painted straight into the viewport; an ordinary (differential)
 * render did not repaint them away, and the diagnostics were lost instead of
 * being preserved in the omp log (`getLogPath()`).
 *
 * Contracts under test (production behavior, exercised only through public
 * surfaces — no guard/pump internals):
 *   1. While the TUI owns the terminal, inherited child AND in-process
 *      fd 1/fd 2 writes must stay off the viewport (ordinary render included)
 *      and land greppable in the isolated `getLogPath()` log.
 *   2. Editor-style stop/handoff/restart: released fds reach the real
 *      terminal; after restart, isolation re-engages (handoff bytes on the
 *      PTY, post-restart bytes in the log).
 *   3. When the TUI process's own fd 2 does NOT share the stdout terminal
 *      (caller redirected it to a file), the guard must leave fd 2 alone:
 *      inherited child stderr stays in the caller's file, stdout stays
 *      isolated.
 *   4. A native PTY resize flows through to the child's live process.stdout
 *      geometry (guards the cached-TTY dimension hazard after fd 1 redirect)
 *      and the viewport repaints clean at the new size.
 *   5. The pump-less fallback render path (PI_TEST_RUNTIME=1 child — the
 *      public bun-test-runtime knob that suppresses the native pump — opted
 *      back into the real terminal via setTerminalHeadless(false)) drives the
 *      same isolation contract.
 *   6. With stdout piped (not a TTY), nothing is isolated: inherited child
 *      bytes pass through the caller's pipes and no omp log appears.
 *
 * Architecture: the suite process never mutates its own fd 1/2. PTY tests
 * launch a fixture under test/fixtures/ as a real child inside a native PTY
 * (PtySession.startArgv), drive it with single-key writes, and replay the
 * accumulated PTY byte stream into the kitty-backed VirtualTerminal to assert
 * what a user would actually see.
 *
 * Timing: the systems under test are separate OS processes inside kernel PTYs,
 * so deterministic time control (fake timers) cannot drive them. Every barrier
 * resolves on real PTY/pipe chunk arrivals; wall-clock timers appear only as
 * bounded deadlines (phase timeout, quit grace) so the suite can never hang.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { PtySession } from "@oh-my-pi/pi-natives";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { VirtualTerminal } from "./virtual-terminal";

const FIXTURES_DIR = path.join(import.meta.dir, "fixtures");
const FIXTURE_PATH = path.join(FIXTURES_DIR, "terminal-output-isolation-fixture.ts");
const PIPE_SMOKE_PATH = path.join(FIXTURES_DIR, "terminal-output-pipe-smoke.ts");
const COLS = 100;
const ROWS = 24;
const TITLE_SENTINEL = "OMP_ISOLATION_TITLE_CLEAN";
const OUT_SENTINEL = "OMP_ISOLATION_DIAGNOSTICS_OUT";
const ERR_SENTINEL = "OMP_ISOLATION_DIAGNOSTICS_ERR";
const HANDOFF_OUT_SENTINEL = "OMP_ISOLATION_HANDOFF_OUT";
const HANDOFF_ERR_SENTINEL = "OMP_ISOLATION_HANDOFF_ERR";
const PARENT_OUT_SENTINEL = "OMP_ISOLATION_PARENT_OUT";
const PARENT_RAWFD_SENTINEL = "OMP_ISOLATION_PARENT_RAWFD";
const PARENT_ERR_SENTINEL = "OMP_ISOLATION_PARENT_ERR";
// Not a superstring of PARENT_RAWFD_SENTINEL: an fd2 marker containing the fd1
// marker would make the fd1 log assertion implied by the fd2 one.
const PARENT_RAWFD_ERR_SENTINEL = "OMP_ISOLATION_PARENT_FD2_RAW";
const BUN_OUT_SENTINEL = "OMP_ISOLATION_BUN_OUT";
const BUN_ERR_SENTINEL = "OMP_ISOLATION_BUN_ERR";
const DEFAULT_PHASE_TIMEOUT_MS = 10_000;
const QUIT_GRACE_MS = 3_000;

interface Waiter {
	readonly marker: string;
	readonly timeoutMs: number;
	readonly timer: Timer;
	resolve(): void;
	reject(error: Error): void;
}

interface LaunchOptions {
	/**
	 * Suppress the native output pump the public way: PI_TEST_RUNTIME=1 makes
	 * isBunTestRuntime() true (pump stays off in production under test
	 * runtimes) and the fixture opts back into the real terminal via
	 * OMP_ISOLATION_FALLBACK=1 → setTerminalHeadless(false).
	 */
	readonly fallback?: boolean;
	/**
	 * Redirect the child's own fd 2 to this file before it starts (via an
	 * exec-ing shell wrapper): exercises the guard's "stderr does not share
	 * the stdout terminal" branch.
	 */
	readonly stderrFile?: string;
}

interface FixtureSession {
	/** The live native PTY session: write keys, resize the pty. */
	readonly session: PtySession;
	/** Bounded barrier: resolves as soon as `marker` appears in the PTY stream. */
	waitFor(marker: string, timeoutMs?: number): Promise<void>;
	/** Replay the whole PTY stream into a fresh VirtualTerminal and return the viewport text. */
	snapshotViewport(columns?: number, rows?: number): string;
	/** Concatenated contents of every log in the child's effective isolated log directory. */
	logContents(): string;
	/** Raw PTY byte stream accumulated so far. */
	rawStream(): string;
	/** Quit the fixture and await its exit (bounded); no filesystem cleanup. Idempotent. */
	shutdown(): Promise<void>;
	/** shutdown plus temp-HOME cleanup; safe to call after shutdown. */
	dispose(): Promise<void>;
}

const activeDisposals: Array<() => Promise<void>> = [];

function isolatedDirs(): { home: string; testDir: string } {
	return {
		home: fs.mkdtempSync(path.join(os.tmpdir(), "omp-isolation-home-")),
		testDir: fs.mkdtempSync(path.join(os.tmpdir(), "omp-isolation-test-")),
	};
}

function isolatedEnv(home: string, testDir: string, extra: Record<string, string> = {}) {
	// Minimal, deterministic child environment. No BUN_ENV/NODE_ENV/
	// PI_TEST_RUNTIME (keeps plain fixtures on the real interactive pipeline),
	// no XDG_*/PI_*/OMP_* config overrides (isolates getLogPath() to
	// $HOME/.omp/logs), no multiplexer hints (independent PTY semantics).
	return {
		PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
		HOME: home,
		TERM: "xterm-256color",
		TERM_PROGRAM: "xterm",
		TMPDIR: testDir,
		...extra,
	};
}

function launchFixture(options: LaunchOptions = {}): FixtureSession {
	const { home, testDir } = isolatedDirs();
	const env = isolatedEnv(home, testDir, {
		...(options.fallback ? { PI_TEST_RUNTIME: "1", OMP_ISOLATION_FALLBACK: "1" } : {}),
		OMP_ISOLATION_LOG_DIRECTORY_FILE: path.join(testDir, "logs-directory.txt"),
	});

	const session = new PtySession();
	let stream = "";
	const waiters = new Set<Waiter>();
	const started = Promise.withResolvers<{ error: Error | null; pid: number }>();

	function snapshotViewport(columns = COLS, rows = ROWS): string {
		const terminal = new VirtualTerminal(columns, rows);
		try {
			terminal.write(stream);
			return terminal.getViewport().join("\n");
		} finally {
			terminal.stop();
		}
	}

	function settleWaiters(): void {
		for (const waiter of waiters) {
			if (!stream.includes(waiter.marker)) continue;
			waiters.delete(waiter);
			clearTimeout(waiter.timer);
			waiter.resolve();
		}
	}

	function onChunk(error: Error | null, chunk: string): void {
		if (error) return;
		stream += chunk;
		settleWaiters();
	}

	const run = session.startArgv(
		options.stderrFile === undefined
			? {
					application: process.execPath,
					args: [FIXTURE_PATH],
					cwd: FIXTURES_DIR,
					env,
					timeoutMs: 60_000,
					cols: COLS,
					rows: ROWS,
				}
			: {
					application: "/bin/sh",
					args: ["-c", `exec "${process.execPath}" "${FIXTURE_PATH}" 2>"${options.stderrFile}"`],
					cwd: FIXTURES_DIR,
					env,
					timeoutMs: 60_000,
					cols: COLS,
					rows: ROWS,
				},
		onChunk,
		(error, pid) => started.resolve({ error, pid }),
	);

	void started.promise.then(({ error, pid }) => {
		if (error || pid <= 0) {
			// Surface start failures through the first waitFor barrier.
			stream += `\nFIXTURE_START_FAILED ${error ? String(error) : `pid ${pid}`}\n`;
			settleWaiters();
		}
	});

	function waitFor(marker: string, timeoutMs = DEFAULT_PHASE_TIMEOUT_MS): Promise<void> {
		if (stream.includes(marker)) return Promise.resolve();
		const pending = Promise.withResolvers<void>();
		const waiter: Waiter = {
			marker,
			timeoutMs,
			timer: setTimeout(() => {
				waiters.delete(waiter);
				pending.reject(
					new Error(
						`Timed out after ${timeoutMs}ms waiting for marker "${marker}" in the PTY stream.\n` +
							`Last viewport:\n${snapshotViewport()}`,
					),
				);
			}, timeoutMs),
			resolve: pending.resolve,
			reject: pending.reject,
		};
		waiters.add(waiter);
		return pending.promise;
	}

	let shutdownPromise: Promise<void> | undefined;
	function shutdown(): Promise<void> {
		if (!shutdownPromise) {
			shutdownPromise = (async () => {
				try {
					session.write("q");
				} catch {
					session.kill();
				}
				// Bounded quit grace: the child is a separate OS process, so
				// no deterministic signal exists for "should have exited".
				const outcome = await Promise.race([run, Bun.sleep(QUIT_GRACE_MS).then((): null => null)]);
				if (outcome === null) {
					session.kill();
					await run.catch(() => {});
				}
			})();
		}
		return shutdownPromise;
	}

	async function dispose(): Promise<void> {
		await shutdown();
		for (const waiter of waiters) {
			clearTimeout(waiter.timer);
			waiter.reject(new Error("fixture disposed"));
		}
		waiters.clear();
		fs.rmSync(home, { recursive: true, force: true });
		fs.rmSync(testDir, { recursive: true, force: true });
	}
	activeDisposals.push(dispose);

	function logContents(): string {
		const logsDir = fs.readFileSync(path.join(testDir, "logs-directory.txt"), "utf8");
		let names: string[] = [];
		try {
			names = fs.readdirSync(logsDir).filter(name => name.endsWith(".log"));
		} catch {
			return "";
		}
		let contents = "";
		for (const name of names) {
			contents += fs.readFileSync(path.join(logsDir, name), "utf8");
		}
		return contents;
	}

	return {
		session,
		waitFor,
		snapshotViewport,
		logContents,
		rawStream: () => stream,
		shutdown,
		dispose,
	};
}

/** Drain a pipe stream, notifying `onChunk` per arrival; resolves with the full text. */
async function consumeStream(stream: ReadableStream<Uint8Array>, onChunk: (text: string) => void): Promise<string> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let full = "";
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		const text = decoder.decode(value, { stream: true });
		full += text;
		onChunk(text);
	}
	return full;
}

interface PipeSmokeResult {
	readonly stdout: string;
	readonly stderr: string;
	readonly code: number;
	readonly home: string;
}

/**
 * Pipe-mode smoke: spawn the pipe fixture with every stdio piped, run the
 * inherited-child scenario, and return what the caller's pipes received.
 */
async function runPipeSmoke(): Promise<PipeSmokeResult> {
	const { home, testDir } = isolatedDirs();
	const child = Bun.spawn([process.execPath, PIPE_SMOKE_PATH], {
		cwd: FIXTURES_DIR,
		env: isolatedEnv(home, testDir),
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	let stdoutSoFar = "";
	const sentinelSeen = Promise.withResolvers<void>();
	const stdoutText = consumeStream(child.stdout, text => {
		stdoutSoFar += text;
		// Fence on the last stdout write, not an earlier diagnostic.
		if (stdoutSoFar.includes(BUN_OUT_SENTINEL)) sentinelSeen.resolve();
	});
	let stderrSoFar = "";
	const stderrSeen = Promise.withResolvers<void>();
	const stderrText = consumeStream(child.stderr, text => {
		stderrSoFar += text;
		if (stderrSoFar.includes(BUN_ERR_SENTINEL)) stderrSeen.resolve();
	});
	const stdin = child.stdin;
	stdin.write("c");
	stdin.flush();
	// Separate OS process: no deterministic completion signal, so a bounded
	// deadline only — never a guessed sleep.
	const timedOut = await Promise.race([
		Promise.all([sentinelSeen.promise, stderrSeen.promise]).then(() => false as const),
		Bun.sleep(DEFAULT_PHASE_TIMEOUT_MS).then(() => true as const),
	]);
	stdin.write("q");
	stdin.flush();
	await stdin.end();
	// Bounded quit-grace deadline (same contract as the PTY shutdown path):
	// separate OS process, so a wedged child must be force-killed after the
	// grace period rather than awaited without limit. SIGKILL, because a
	// wedged child's event loop never runs its SIGTERM handler.
	const killTimer = setTimeout(() => child.kill("SIGKILL"), QUIT_GRACE_MS);
	let code: number;
	try {
		code = await child.exited;
	} finally {
		clearTimeout(killTimer);
	}
	const [stdoutFull, stderrFull] = await Promise.all([stdoutText, stderrText]);
	fs.rmSync(testDir, { recursive: true, force: true });
	if (timedOut) {
		fs.rmSync(home, { recursive: true, force: true });
		throw new Error(
			`pipe smoke: no ${OUT_SENTINEL} within ${DEFAULT_PHASE_TIMEOUT_MS}ms; stdout so far:\n${stdoutSoFar}`,
		);
	}
	return { stdout: stdoutFull, stderr: stderrFull, code, home };
}

afterEach(async () => {
	const pending = activeDisposals.splice(0);
	for (const dispose of pending) {
		await dispose();
	}
});

describe.skipIf(process.platform === "win32")(
	"terminal output isolation (real ProcessTerminal + TUI in a native PTY)",
	() => {
		it("starts inline without inventing a resize when dimensions are unchanged", async () => {
			const fixture = launchFixture();
			await fixture.waitFor("ST_READY");

			// Startup with unchanged geometry must not manufacture a resize
			// transaction (the self-SIGWINCH dim-refresh path): no alt-buffer
			// entry and no CPR query may appear in the startup byte stream — the
			// fixture has no fullscreen overlay, so inline start is the contract.
			const viewport = fixture.snapshotViewport();
			expect(viewport).toContain(TITLE_SENTINEL);
			const startup = fixture.rawStream();
			expect(startup).not.toContain("\x1b[?1049h");
			expect(startup).not.toContain("\x1b[6n");
		}, 30_000);
		it("keeps the viewport clean and preserves inherited child and in-process diagnostics in the omp log while the TUI owns the terminal", async () => {
			const fixture = launchFixture();
			await fixture.waitFor("ST_READY");

			// Inherited grandchild diagnostics to fd 1/fd 2 plus ordinary
			// in-process process.stdout/process.stderr/raw-fd writes, while the
			// TUI owns the terminal; the fixture then performs an ordinary
			// (differential) render — not a forced repaint.
			fixture.session.write("c");
			await fixture.waitFor("ST_INHERITED_1");

			const viewport = fixture.snapshotViewport();
			expect(viewport).toContain(TITLE_SENTINEL);
			expect(viewport).not.toContain(OUT_SENTINEL);
			expect(viewport).not.toContain(ERR_SENTINEL);
			expect(viewport).not.toContain(PARENT_OUT_SENTINEL);
			expect(viewport).not.toContain(PARENT_RAWFD_SENTINEL);
			expect(viewport).not.toContain(PARENT_ERR_SENTINEL);
			expect(viewport).not.toContain(PARENT_RAWFD_ERR_SENTINEL);
			expect(fixture.rawStream()).not.toContain(BUN_OUT_SENTINEL);
			expect(fixture.rawStream()).not.toContain(BUN_ERR_SENTINEL);

			// The diagnostics must survive, greppable, in the child's isolated
			// getLogPath() log rather than being discarded. The fixture fences its
			// in-process writes by flush callback, so every sentinel is on the
			// redirected fd before the ST_INHERITED_1 marker renders.
			const log = fixture.logContents();
			expect(log).toContain(OUT_SENTINEL);
			expect(log).toContain(ERR_SENTINEL);
			expect(log).toContain(PARENT_OUT_SENTINEL);
			expect(log).toContain(PARENT_RAWFD_SENTINEL);
			expect(log).toContain(PARENT_ERR_SENTINEL);
			expect(log).toContain(PARENT_RAWFD_ERR_SENTINEL);
			expect(log).toContain(BUN_OUT_SENTINEL);
			expect(log).toContain(BUN_ERR_SENTINEL);
		}, 30_000);

		it("keeps the viewport clean when the child's output is captured", async () => {
			const fixture = launchFixture();
			await fixture.waitFor("ST_READY");

			// Control for the regression above: the same diagnostic payload, but
			// piped and drained by the fixture. Capture must never disturb the
			// viewport, before or after the isolation fix.
			fixture.session.write("p");
			await fixture.waitFor("ST_CAPTURED_1");

			const viewport = fixture.snapshotViewport();
			expect(viewport).toContain(TITLE_SENTINEL);
			expect(viewport).not.toContain(OUT_SENTINEL);
			expect(viewport).not.toContain(ERR_SENTINEL);
		}, 30_000);

		it("re-isolates inherited child output after an editor-style stop/handoff/restart", async () => {
			const fixture = launchFixture();
			await fixture.waitFor("ST_READY");

			// Editor/suspend handoff: the TUI stops (releasing the terminal), an
			// external program writes through the inherited fds, the TUI restarts.
			fixture.session.write("e");
			await fixture.waitFor("ST_HANDOFF_1");
			// While ownership is released, the external program's bytes must reach
			// the real terminal — isolation must not swallow released-fd output.
			expect(fixture.rawStream()).toContain(HANDOFF_OUT_SENTINEL);
			expect(fixture.rawStream()).toContain(HANDOFF_ERR_SENTINEL);

			// After the restart the TUI owns the terminal again: a further
			// inherited child must be isolated exactly like before the handoff.
			fixture.session.write("i");
			await fixture.waitFor("ST_RESTART_1");

			const viewport = fixture.snapshotViewport();
			expect(viewport).toContain(TITLE_SENTINEL);
			expect(viewport).not.toContain(OUT_SENTINEL);
			expect(viewport).not.toContain(ERR_SENTINEL);
			expect(viewport).not.toContain(HANDOFF_OUT_SENTINEL);

			// Post-restart inherited diagnostics land in the log; the handoff
			// program's output must NOT (it had the real terminal).
			const log = fixture.logContents();
			expect(log).toContain(OUT_SENTINEL);
			expect(log).not.toContain(HANDOFF_OUT_SENTINEL);
		}, 30_000);

		it("leaves a caller-redirected stderr alone: inherited child stderr stays in the caller's file, stdout stays isolated", async () => {
			const testDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-isolation-test-"));
			const callerStderr = path.join(testDir, "caller-stderr.txt");
			const fixture = launchFixture({ stderrFile: callerStderr });
			try {
				await fixture.waitFor("ST_READY");

				// The child's fd 2 is the caller's file, NOT the PTY: the guard's
				// stderrSharesStdoutTerminal branch must be false, so fd 2 must
				// never be redirected to the log. fd 1 isolation still applies.
				fixture.session.write("c");
				await fixture.waitFor("ST_INHERITED_1");

				const callerStderrText = await Bun.file(callerStderr).text();
				expect(callerStderrText).toContain(ERR_SENTINEL);
				// The in-process process.stderr write shares the child's fd 2, so
				// it must also land in the caller's file rather than the log.
				expect(callerStderrText).toContain(PARENT_ERR_SENTINEL);
				expect(callerStderrText).toContain(PARENT_RAWFD_ERR_SENTINEL);
				expect(callerStderrText).toContain(BUN_ERR_SENTINEL);

				const viewport = fixture.snapshotViewport();
				expect(viewport).toContain(TITLE_SENTINEL);
				expect(viewport).not.toContain(OUT_SENTINEL);
				expect(viewport).not.toContain(ERR_SENTINEL);
				const log = fixture.logContents();
				expect(log).toContain(OUT_SENTINEL);
				expect(log).toContain(PARENT_OUT_SENTINEL);
				expect(log).toContain(PARENT_RAWFD_SENTINEL);
				expect(log).not.toContain(ERR_SENTINEL);
				expect(log).not.toContain(PARENT_ERR_SENTINEL);
				expect(log).not.toContain(PARENT_RAWFD_ERR_SENTINEL);
				expect(log).toContain(BUN_OUT_SENTINEL);
				expect(log).not.toContain(BUN_ERR_SENTINEL);
			} finally {
				fs.rmSync(testDir, { recursive: true, force: true });
			}
		}, 30_000);

		it("keeps live stdout geometry updating across a native PTY resize while isolated", async () => {
			const fixture = launchFixture();
			await fixture.waitFor("ST_READY");

			// After fd 1 is redirected, a cached TTY stream keeps isTTY=true but
			// stops seeing kernel size updates, so the fixture reports
			// LIVE_<cols>x<rows> from its own process.stdout every frame. A native
			// PTY resize must flow through to that public surface and the TUI must
			// repaint clean at the new size.
			fixture.session.write("c");
			await fixture.waitFor("ST_INHERITED_1");

			fixture.session.resize(120, 30);
			await fixture.waitFor("LIVE_120x30");

			const viewport = fixture.snapshotViewport(120, 30);
			expect(viewport).toContain(TITLE_SENTINEL);
			expect(viewport).toContain("LIVE_120x30");
			expect(viewport).not.toContain(OUT_SENTINEL);
			expect(viewport).not.toContain(ERR_SENTINEL);
		}, 30_000);

		it("isolates inherited child and in-process output through the pump-less fallback render path", async () => {
			const fixture = launchFixture({ fallback: true });
			await fixture.waitFor("ST_READY");

			// Same contract as the first regression, but the child runs with
			// PI_TEST_RUNTIME=1, where production intentionally keeps the native
			// output pump off: the fallback render path (private saved fd) must
			// keep the viewport clean and diagnostics in the log.
			fixture.session.write("c");
			await fixture.waitFor("ST_INHERITED_1");

			const viewport = fixture.snapshotViewport();
			expect(viewport).toContain(TITLE_SENTINEL);
			expect(viewport).not.toContain(OUT_SENTINEL);
			expect(viewport).not.toContain(ERR_SENTINEL);
			expect(viewport).not.toContain(PARENT_OUT_SENTINEL);
			expect(viewport).not.toContain(PARENT_RAWFD_SENTINEL);
			expect(viewport).not.toContain(PARENT_ERR_SENTINEL);
			expect(viewport).not.toContain(PARENT_RAWFD_ERR_SENTINEL);
			expect(fixture.rawStream()).not.toContain(BUN_OUT_SENTINEL);
			expect(fixture.rawStream()).not.toContain(BUN_ERR_SENTINEL);
			const log = fixture.logContents();
			expect(log).toContain(OUT_SENTINEL);
			expect(log).toContain(ERR_SENTINEL);
			expect(log).toContain(PARENT_OUT_SENTINEL);
			expect(log).toContain(PARENT_RAWFD_SENTINEL);
			expect(log).toContain(PARENT_ERR_SENTINEL);
			expect(log).toContain(PARENT_RAWFD_ERR_SENTINEL);
			expect(log).toContain(BUN_OUT_SENTINEL);
			expect(log).toContain(BUN_ERR_SENTINEL);
		}, 30_000);

		it("restores both descriptors during emergency teardown, including without the pump", async () => {
			for (const fallback of [false, true]) {
				const fixture = launchFixture({ fallback });
				await fixture.waitFor("ST_READY");
				fixture.session.write("x");
				await fixture.waitFor("OMP_ISOLATION_EMERGENCY_RESTORED stdout");
				await fixture.waitFor("OMP_ISOLATION_EMERGENCY_RESTORED stderr");
				expect(fixture.logContents()).not.toContain("OMP_ISOLATION_EMERGENCY_RESTORED");
				await fixture.shutdown();
			}
		}, 30_000);

		it("passes inherited child output straight through the caller's pipes when stdout is not a TTY", async () => {
			const smoke = await runPipeSmoke();
			try {
				// Piped stdout is never isolated: the grandchild's bytes belong to
				// the caller's pipes, and no omp log may be created.
				expect(smoke.code).toBe(0);
				expect(smoke.stdout).toContain(OUT_SENTINEL);
				expect(smoke.stdout).toContain(PARENT_OUT_SENTINEL);
				expect(smoke.stdout).toContain(PARENT_RAWFD_SENTINEL);
				expect(smoke.stderr).toContain(ERR_SENTINEL);
				expect(smoke.stderr).toContain(PARENT_ERR_SENTINEL);
				expect(smoke.stderr).toContain(PARENT_RAWFD_ERR_SENTINEL);
				expect(smoke.stdout).toContain(BUN_OUT_SENTINEL);
				expect(smoke.stderr).toContain(BUN_ERR_SENTINEL);
				expect(fs.existsSync(path.join(smoke.home, ".omp", "logs"))).toBe(false);
			} finally {
				fs.rmSync(smoke.home, { recursive: true, force: true });
			}
		}, 30_000);
	},
);
