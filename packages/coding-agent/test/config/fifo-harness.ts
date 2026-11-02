import { afterEach, beforeEach, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";

// A real FIFO stands at a path a user names, and the reader's own call runs in
// a child process: a read that blocks stops every timer in its own process, so
// only another process can see it. A child that does not finish in time is
// killed.
//
// The deadline is wide because it cannot tell a child blocked on a FIFO from one
// slow to load omp's modules on a busy machine: at load about 290, a child that
// was still loading was killed at a 20 s deadline. A blocked child never
// finishes, so a wide deadline only slows a failing run.
export const CHILD_DEADLINE_MS = 45_000;
export const TEST_TIMEOUT_MS = CHILD_DEADLINE_MS + 15_000;
/** What a FIFO holds for its real reader: every byte of it must still be there after omp ran. */
export const PAYLOAD = "queued for someone else\n";
/** How long a writer that a reader woke may take to say so, once the reader's process has ended. */
const WAKE_GRACE_MS = 1_000;
const repoRoot = path.resolve(import.meta.dir, "../../../..");

/** A module of this repository, by absolute path, as a string literal: the child runs in the project directory. */
export function mod(pkg: string, file: string): string {
	return JSON.stringify(path.join(repoRoot, "packages", pkg, "src", file));
}

export function mkfifo(target: string): void {
	fs.mkdirSync(path.dirname(target), { recursive: true });
	const made = Bun.spawnSync(["mkfifo", target]);
	if (made.exitCode !== 0) throw new Error(made.stderr.toString());
}

/** A FIFO at `target` holding {@link PAYLOAD}, its write end held by this process until `left` is read. */
export function fifoWithInput(target: string): { left(): string } {
	mkfifo(target);
	const fd = fs.openSync(target, fs.constants.O_RDWR | fs.constants.O_NONBLOCK);
	fs.writeSync(fd, PAYLOAD);
	return {
		left() {
			const buffer = Buffer.alloc(4096);
			let text = "";
			try {
				for (;;) {
					const n = fs.readSync(fd, buffer, 0, buffer.length, null);
					if (n <= 0) break;
					text += buffer.subarray(0, n).toString();
				}
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EAGAIN") throw error;
			} finally {
				fs.closeSync(fd);
			}
			return text;
		},
	};
}

/** Each sandbox's own files: the FIFOs' writers mark here, never next to a FIFO, where a discovery could find the mark. */
let marks = 0;

/**
 * A FIFO at `target` with nothing written to it, and a writer waiting in its
 * own open for a reader, as a mount that serves a file through a pipe waits.
 * Any open of the FIFO for reading, even one that reads nothing, wakes it;
 * `woken` says whether one did, once the reader's process has ended.
 */
export function writerWaitingInOpen(box: FifoSandbox, target: string): { woken(): Promise<boolean>; stop(): void } {
	mkfifo(target);
	const mark = path.join(box.root, `woken-${++marks}`);
	const writer = Bun.spawn(["sh", "-c", 'exec 3>"$0"; : > "$1"; exec sleep 60', target, mark], {
		stdout: "ignore",
		stderr: "ignore",
	});
	return {
		async woken() {
			// A real timer: the writer is another process. A woken writer marks at
			// once; one still waiting never does.
			for (const started = Date.now(); Date.now() - started < WAKE_GRACE_MS; await Bun.sleep(20)) {
				if (fs.existsSync(mark)) return true;
			}
			return fs.existsSync(mark);
		},
		stop() {
			writer.kill("SIGKILL");
		},
	};
}

/** A fresh home, agent directory and project for each test. */
export interface FifoSandbox {
	readonly root: string;
	readonly home: string;
	readonly agentDir: string;
	readonly projectDir: string;
}

/** Register a fresh {@link FifoSandbox} before each test and its removal after; the object reads the current one. */
export function useFifoSandbox(prefix: string): FifoSandbox {
	let tempDir: TempDir | undefined;
	beforeEach(() => {
		tempDir = TempDir.createSync(prefix);
		const home = path.join(tempDir.path(), "home");
		fs.mkdirSync(path.join(home, ".omp", "agent"), { recursive: true });
		// Inside home, so a walk up from the project stops there.
		fs.mkdirSync(path.join(home, "project", ".omp"), { recursive: true });
	});
	afterEach(() => {
		tempDir?.removeSync();
		tempDir = undefined;
	});
	const root = (): string => {
		if (!tempDir) throw new Error("no sandbox outside a test");
		return tempDir.path();
	};
	return {
		get root() {
			return root();
		},
		get home() {
			return path.join(root(), "home");
		},
		get agentDir() {
			return path.join(root(), "home", ".omp", "agent");
		},
		get projectDir() {
			return path.join(root(), "home", "project");
		},
	};
}

/** The test runner's environment without anything that would point omp, AWS, Google or IDA somewhere else. */
export function childEnv(box: FifoSandbox, extra: Record<string, string>): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value === undefined || /^(PI_|OMP_|AWS_|XDG_|IDA|GOOGLE_|NODE_EXTRA_CA_CERTS$)/.test(key)) continue;
		env[key] = value;
	}
	return {
		...env,
		HOME: box.home,
		PI_CODING_AGENT_DIR: box.agentDir,
		AWS_EC2_METADATA_DISABLED: "true",
		...extra,
	};
}

export interface Run {
	exit: number | "hung";
	stdout: string;
	stderr: string;
}

/** Run `script` as a module in `cwd` (the project directory by default); "hung" if it does not finish in time. */
export async function runChild(
	box: FifoSandbox,
	script: string,
	env: Record<string, string> = {},
	cwd: string = box.projectDir,
): Promise<Run> {
	const child = Bun.spawn([process.execPath, "--no-env-file", "-e", `${script}\nprocess.exit(0);`], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
		env: childEnv(box, env),
	});
	// A real timer, because the defect is a read that blocks: no fake clock reaches the child.
	const settled = await Promise.race([child.exited.then(() => true), Bun.sleep(CHILD_DEADLINE_MS).then(() => false)]);
	if (!settled) child.kill("SIGKILL");
	const exitCode = await child.exited;
	const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
	return { exit: settled ? exitCode : "hung", stdout, stderr };
}

/** {@link runChild}, started now: `saw` waits for a line on its standard error that `matches`, `finish` for its end. */
export function startChild(
	box: FifoSandbox,
	script: string,
): {
	child: Bun.Subprocess;
	saw(matches: (line: string) => boolean): Promise<boolean>;
	finish(): Promise<Run>;
} {
	const child = Bun.spawn([process.execPath, "--no-env-file", "-e", `${script}\nprocess.exit(0);`], {
		cwd: box.projectDir,
		stdout: "pipe",
		stderr: "pipe",
		env: childEnv(box, {}),
	});
	let stderr = "";
	const drained = (async () => {
		const decoder = new TextDecoder();
		for await (const chunk of child.stderr as ReadableStream<Uint8Array>) {
			stderr += decoder.decode(chunk, { stream: true });
		}
	})();
	const seen = (matches: (line: string) => boolean): boolean => stderr.split("\n").some(matches);
	return {
		child,
		async saw(matches) {
			// A real timer: the child is another process, and no fake clock reaches it.
			for (const started = Date.now(); Date.now() - started < CHILD_DEADLINE_MS; await Bun.sleep(20)) {
				if (seen(matches)) return true;
				if (child.exitCode !== null || child.signalCode !== null) break;
			}
			return seen(matches);
		},
		async finish() {
			const settled = await Promise.race([
				child.exited.then(() => true),
				Bun.sleep(CHILD_DEADLINE_MS).then(() => false),
			]);
			if (!settled) child.kill("SIGKILL");
			const exitCode = await child.exited;
			await drained;
			const stdout = await new Response(child.stdout as ReadableStream<Uint8Array>).text();
			return { exit: settled ? exitCode : "hung", stdout, stderr };
		},
	};
}

/**
 * The lines of `text` that name `file`: what omp said about it. Notes are for a
 * person and no program parses them, so tests read the facts a note carries —
 * the file, its kind, a bound, a consequence — and not its wording.
 */
export function notesAbout(text: string, file: string): string[] {
	return text.split("\n").filter(line => line.includes(file));
}

/** How many lines of `text` name `file` as a FIFO: a refusal by kind. */
export function namedAsFifo(text: string, file: string): number {
	return notesAbout(text, file).filter(line => /\bFIFO\b/.test(line)).length;
}

/** A user-named file, the reader that reads it, and what that reader does when a FIFO stands there. */
export interface FifoCase {
	/** The path, as the pull request names it. */
	name: string;
	/** Where the FIFO stands, once the directories exist. */
	at(): string;
	/** The child module: imports, then the reader's own call that reads `at`. */
	script(): string;
	/**
	 * `skipped`: an optional file — the caller goes on without it, exits 0,
	 * and says once on standard error which file it did not read and why.
	 * `refused`: a file the command cannot go on without — it stops with exit 1
	 * and names the file. `reported`: the caller's own error result names it,
	 * and the command goes on (the child prints that result after `error `).
	 */
	outcome: "skipped" | "refused" | "reported";
	/** Files the reader needs beside the FIFO, written before it runs. */
	setup?(): void;
	env?(): Record<string, string>;
}

function expectNamed(run: Run, c: FifoCase): void {
	const at = c.at();
	if (c.outcome === "skipped") {
		expect(run.exit).toBe(0);
		expect(namedAsFifo(run.stderr, at)).toBe(1);
	} else if (c.outcome === "refused") {
		expect(run.exit).toBe(1);
		expect(namedAsFifo(run.stdout + run.stderr, at)).toBeGreaterThan(0);
	} else {
		expect(run.exit).toBe(0);
		expect(run.stdout).toStartWith("error ");
		expect(namedAsFifo(run.stdout, at)).toBeGreaterThan(0);
	}
}

/**
 * Two tests for `c`, each with a real FIFO at its path:
 *
 * - with input waiting in the FIFO and its write end held open by this test:
 *   a reader that reads it takes the input, then waits for an end of file that
 *   never comes. The pass is the outcome, and every byte still in the FIFO.
 * - with nothing written to it, and a writer waiting in its own open, as a
 *   mount that serves a file through a pipe waits for a reader: a blocking
 *   open, or a read, waits for ever, and any open at all wakes the writer.
 *   The pass is the outcome, and the writer still waiting.
 *
 * An open with `O_NONBLOCK` and a check of the descriptor fails the second: the
 * open returns at once, but it wakes the writer.
 */
export function itRefusesFifo(box: FifoSandbox, c: FifoCase): void {
	it(
		`${c.name}, with input waiting in it`,
		async () => {
			c.setup?.();
			const fifo = fifoWithInput(c.at());

			const run = await runChild(box, c.script(), c.env?.() ?? {});
			const left = fifo.left();

			expectNamed(run, c);
			expect(left).toBe(PAYLOAD);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		`${c.name}, with a writer waiting in its open`,
		async () => {
			c.setup?.();
			const writer = writerWaitingInOpen(box, c.at());
			try {
				const run = await runChild(box, c.script(), c.env?.() ?? {});

				expectNamed(run, c);
				expect(await writer.woken()).toBe(false);
			} finally {
				writer.stop();
			}
		},
		TEST_TIMEOUT_MS,
	);
}
