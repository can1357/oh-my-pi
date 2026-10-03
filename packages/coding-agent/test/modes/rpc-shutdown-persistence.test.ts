/**
 * Contract (review 3983906393): a store failure latched while RPC mode shuts
 * down must still reach the client. The notice is queued on the asynchronous
 * `stdoutQueue`, so the process has to drain that queue before it exits on
 * either path; otherwise the frames go with the process and the client either
 * sees a clean exit for a run whose transcript never became durable, or never
 * learns about a failure the mode already reported and then recovered from.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { isRecord, TempDir } from "@oh-my-pi/pi-utils";

const tempDirs: TempDir[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => dir.remove()));
});

/**
 * The harness needs three preconditions it cannot synthesize: POSIX `chmod`
 * (0o500 denies writes only to a non-root user), a non-blocking FIFO read, and
 * the `mkfifo` tool. Where any is missing the test skips rather than erroring.
 */
const unsupportedHarness =
	process.platform === "win32" ||
	Bun.which("mkfifo") === null ||
	(typeof process.getuid === "function" && process.getuid() === 0);

/**
 * A FIFO, not a pipe, for stdout: Bun buffers a pipe's megabytes in userspace,
 * so the child never blocks on stdout and an undrained queue is invisible. The
 * FIFO's 64 KiB kernel buffer is the backpressure these contracts are about.
 */
function spawnRpcChild(options: { root: string; sessionDir: string }) {
	const fifoPath = path.join(options.root, "stdout.fifo");
	const mkfifo = Bun.spawnSync(["mkfifo", fifoPath]);
	expect(mkfifo.exitCode, mkfifo.stderr.toString()).toBe(0);
	// O_NONBLOCK is explicit: an empty blocking read on a FIFO never returns, and
	// the drain loop's deadline check can only run between reads.
	const fifo = fs.openSync(fifoPath, fs.constants.O_RDWR | fs.constants.O_NONBLOCK);

	const agentDir = path.join(options.root, "agent");
	fs.mkdirSync(agentDir, { recursive: true });
	const packageRoot = path.join(import.meta.dir, "..", "..");
	const child = Bun.spawn(
		[
			"bun",
			path.join(packageRoot, "src", "cli.ts"),
			"--mode",
			"rpc",
			"--session-dir",
			options.sessionDir,
			"--no-extensions",
			"--no-skills",
			"--no-rules",
		],
		{
			cwd: packageRoot,
			env: {
				...Bun.env,
				ANTHROPIC_API_KEY: "sk-ant-not-a-real-key",
				PI_NO_TITLE: "1",
				NO_COLOR: "1",
				XDG_DATA_HOME: options.root,
				XDG_CONFIG_HOME: options.root,
				PI_CODING_AGENT_DIR: agentDir,
			},
			stdin: "pipe",
			stdout: fifo,
			stderr: "pipe",
		},
	);

	// The stderr mirror is written the moment the store latches, so it doubles as
	// the signal that the failure is in place before the directory is reopened.
	const decoder = new TextDecoder();
	let stderrText = "";
	void (async () => {
		for await (const chunk of child.stderr as ReadableStream<Uint8Array>) {
			stderrText += decoder.decode(chunk);
		}
	})();

	return {
		child,
		fifo,
		release: () => fs.closeSync(fifo),
		stderrText: () => stderrText,
		waitForStderr: async (needle: string, budgetMs: number): Promise<boolean> => {
			const deadline = Date.now() + budgetMs;
			while (!stderrText.includes(needle)) {
				if (Date.now() > deadline) return false;
				await Bun.sleep(10);
			}
			return true;
		},
	};
}

/** A stdout backlog the parent deliberately refuses to read yet. */
function backlogFrames(): string {
	const frames: string[] = [];
	for (let index = 0; index < 400; index++) {
		frames.push(JSON.stringify({ id: `page-${index}`, type: "get_available_commands" }));
	}
	frames.push(JSON.stringify({ id: "boom", type: "new_session" }));
	return `${frames.join("\n")}\n`;
}

/** Read the child's FIFO until it is gone; EAGAIN means the buffer is empty. */
async function drainFifo(
	child: { exitCode: number | null; kill: () => void },
	fifo: number,
	budgetMs: number,
): Promise<string> {
	const decoder = new TextDecoder();
	const readBuffer = Buffer.alloc(64 * 1024);
	const deadline = Date.now() + budgetMs;
	let output = "";
	for (;;) {
		let read = -1;
		try {
			read = fs.readSync(fifo, readBuffer, 0, readBuffer.length, null);
		} catch {
			read = -1;
		}
		if (read > 0) {
			output += decoder.decode(readBuffer.subarray(0, read));
			continue;
		}
		if (child.exitCode !== null) break;
		if (Date.now() > deadline) {
			child.kill();
			break;
		}
		await Bun.sleep(2);
	}
	return output;
}

function findPersistenceNotice(output: string): Record<string, unknown> | undefined {
	for (const line of output.split("\n")) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			continue;
		}
		if (isRecord(parsed) && parsed.type === "notice" && parsed.source === "session-persistence") return parsed;
	}
	return undefined;
}

/**
 * Deliberate stall, not a duration guess: the condition under test is whether
 * the child keeps the process alive for its queued frames, and a process that
 * decides not to has no event to await.
 */
const exitedWhileQueued = (child: { exited: Promise<number> }): Promise<boolean> =>
	Promise.race([child.exited.then(() => true), Bun.sleep(2_000).then(() => false)]);

describe.skipIf(unsupportedHarness)("RPC shutdown on a failed session store", () => {
	it("drains the queued notice before exiting on a persistence failure", async () => {
		const dir = TempDir.createSync("@pi-rpc-shutdown-");
		tempDirs.push(dir);
		const root = dir.path();
		// A session directory the process can read but not write: the first
		// persistence write fails with EACCES and the store latches the failure,
		// exactly as a full or unplugged disk would.
		const sessionDir = path.join(root, "sessions");
		fs.mkdirSync(sessionDir, { recursive: true });
		fs.chmodSync(sessionDir, 0o500);

		const { child, fifo, release, stderrText } = spawnRpcChild({ root, sessionDir });
		try {
			child.stdin.write(backlogFrames());
			await child.stdin.flush();
			child.stdin.end();

			const wasQueuedAtDrain = await exitedWhileQueued(child);
			const output = await drainFifo(child, fifo, 20_000);
			const exitCode = await child.exited;

			expect(exitCode).toBe(1);
			const notice = findPersistenceNotice(output);
			expect(notice?.level).toBe("error");
			expect(String(notice?.message)).toContain("Session persistence failed: ");
			// The mode's own teardown claim is on stderr; the raw fatal dump the
			// review complains about never gets this far.
			expect(stderrText()).toContain("Session persistence is still failing at shutdown: ");
			// The mechanism: without the drain the child is gone before the parent
			// reads a single frame, so nothing above could pass.
			expect(wasQueuedAtDrain).toBe(false);
		} finally {
			release();
			fs.chmodSync(sessionDir, 0o700);
		}
	}, 30_000);

	it("drains a recovered failure's notice before exiting successfully", async () => {
		const dir = TempDir.createSync("@pi-rpc-recovered-");
		tempDirs.push(dir);
		const root = dir.path();
		const sessionDir = path.join(root, "sessions");
		fs.mkdirSync(sessionDir, { recursive: true });
		fs.chmodSync(sessionDir, 0o500);

		const { child, fifo, release, waitForStderr } = spawnRpcChild({ root, sessionDir });
		try {
			child.stdin.write(backlogFrames());
			await child.stdin.flush();
			// The store rejects the first write, so a notice is queued behind the
			// backlog the parent is still not reading.
			expect(await waitForStderr("Session persistence failed: ", 20_000)).toBe(true);

			// The store recovers: a successful rewrite clears the latch, so dispose
			// resolves and the mode leaves through its success path. A second
			// `new_session` cannot be used here: it awaits `#drainAndCloseWriter`
			// before `#resetToNewSession` clears the error, so it replays the latch.
			fs.chmodSync(sessionDir, 0o700);
			child.stdin.write(`${JSON.stringify({ id: "recover", type: "set_session_name", name: "after-failure" })}\n`);
			await child.stdin.flush();
			child.stdin.end();

			const wasQueuedAtDrain = await exitedWhileQueued(child);
			const output = await drainFifo(child, fifo, 20_000);
			const exitCode = await child.exited;

			expect(exitCode).toBe(0);
			// The notice the mode already emitted on the failed write still reaches
			// the client, even though the run itself recovered and reported success.
			const notice = findPersistenceNotice(output);
			expect(notice?.level).toBe("error");
			expect(String(notice?.message)).toContain("Session persistence failed: ");
			// The mechanism: without the success-path drain the child is gone before
			// the parent reads a single frame, so the notice above is lost.
			expect(wasQueuedAtDrain).toBe(false);
		} finally {
			release();
			fs.chmodSync(sessionDir, 0o700);
		}
	}, 30_000);
});
