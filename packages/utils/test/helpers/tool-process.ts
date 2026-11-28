/**
 * Helpers for tests of tool processes (`ptree.spawnToolProcess`, the spawns of the shell, the bash tool and the eval
 * kernels), shared by the test suites of every package that starts them.
 *
 * A baseline below 1000 for tests of their OOM adjustment: a tool process sets 1000, and a test that a tool process
 * of this build runs (a bash tool command) starts at 1000 already, so a child that reads 1000 shows that its spawn
 * set it only where its host holds less. The host is a `bun test` process of its own for the one test
 * ({@link belowToolScore}): the value of the test runner itself never changes.
 */
import { expect } from "bun:test";

const SCORE = "/proc/self/oom_score_adj";

/** Set in the test process {@link belowToolScore} starts: the name of the test it runs there. */
const ALONE = "OMP_TEST_BELOW_TOOL_SCORE";

/** How long the test process of {@link belowToolScore} may run before it is killed. */
export const BELOW_TOOL_SCORE_DEADLINE_MS = 90_000;

/** The timeout of a test that calls {@link belowToolScore}: past that deadline and the reading of the output. */
export const BELOW_TOOL_SCORE_TIMEOUT_MS = BELOW_TOOL_SCORE_DEADLINE_MS + 15_000;

/** How long the output of that process may stay open once it ended (a child it left may hold it). */
const OUTPUT_GRACE_MS = 5_000;

/**
 * Whether a process can hold an OOM adjustment below 1000 (Linux): a child of this one tries, so this process keeps
 * its own value. Not where a privileged writer set 1000 as its minimum, or `/proc` is not writable; the tests that
 * read a tool process's 1000 skip there.
 */
export const BELOW_TOOL_SCORE =
	process.platform === "linux" &&
	Bun.spawnSync([
		"/bin/sh",
		"-c",
		`{ read -r s < ${SCORE}; [ "$s" -lt 1000 ] || printf 999 > ${SCORE}; read -r s < ${SCORE}; [ "$s" -lt 1000 ]; } 2>/dev/null`,
	]).exitCode === 0;

/**
 * Run test `name` of test file `file` (its `import.meta.path`) again, alone, in a `bun test` process of its own
 * whose OOM adjustment is below 1000, and fail where it fails there; in that process, run `test` with that value,
 * `baseline`. The process leads a group of its own, is killed where it outlasts {@link BELOW_TOOL_SCORE_DEADLINE_MS},
 * and whatever it left in its group is killed once it ended. Give the calling test
 * {@link BELOW_TOOL_SCORE_TIMEOUT_MS}.
 */
export async function belowToolScore(
	file: string,
	name: string,
	test: (baseline: string) => Promise<void>,
): Promise<void> {
	if (Bun.env[ALONE] === name) {
		if ((await Bun.file(SCORE).text()).trim() === "1000") await Bun.write(SCORE, "999");
		const baseline = await Bun.file(SCORE).text();
		if (baseline.trim() === "1000") throw new Error("this process's OOM adjustment stayed at 1000");
		await test(baseline);
		return;
	}
	const pattern = `${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`;
	const child = Bun.spawn([process.execPath, "test", file, "--test-name-pattern", pattern], {
		cwd: process.cwd(),
		env: { ...Bun.env, [ALONE]: name },
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		detached: true,
		timeout: BELOW_TOOL_SCORE_DEADLINE_MS,
		killSignal: "SIGKILL",
	});
	const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]).then(
		([stdout, stderr]) => stdout + stderr,
	);
	let exitCode: number;
	try {
		exitCode = await child.exited;
	} finally {
		try {
			// What the test left in the process's group.
			process.kill(-child.pid, "SIGKILL");
		} catch {
			// The group is empty.
		}
	}
	// A wall-clock bound on purpose: a process the test left may hold the pipes.
	const said = await Promise.race([
		output,
		Bun.sleep(OUTPUT_GRACE_MS).then(() => "<the test process's output stayed open>"),
	]);
	if (child.signalCode === "SIGKILL") throw new Error(`the test ran past ${BELOW_TOOL_SCORE_DEADLINE_MS} ms: ${said}`);
	expect(exitCode, said).toBe(0);
	expect(said, "the test process ran no test").toMatch(/^\s*1 pass$/m);
}

/** The errno a direct spawn of `program` fails with: its code, and its number, positive. */
export function spawnFailure(program: string): { code: string | undefined; errno: number | undefined } {
	try {
		Bun.spawn([program], { stdout: "ignore", stderr: "ignore" }).kill();
	} catch (error) {
		const { code, errno } = error as NodeJS.ErrnoException;
		return { code, errno: errno === undefined ? undefined : Math.abs(errno) };
	}
	throw new Error(`${program} started`);
}
