/**
 * Regression for the `[Uncaught Exception] InvalidStateError: Worker has been
 * terminated` crash: a browser run's abort listener posted the run's `abort` to
 * a tab worker that a concurrent teardown had already terminated, and Bun's
 * `postMessage` throw escaped the listener as a process-level uncaught exception.
 *
 * Both scenarios drive a real Bun worker thread from a child process, like
 * `issue-9158-repro.test.ts`: the transport under test is Bun's own
 * `postMessage`/`terminate` behaviour, which a hand-rolled handle cannot
 * reproduce, and the failure being guarded is process-level.
 */
import { describe, expect, it } from "bun:test";
import * as path from "node:path";

const packageDir = path.resolve(import.meta.dir, "../..");

interface ChildOutcome {
	stdout: string;
	stderr: string;
	exitCode: number;
}

function runFixture(fixture: string): Promise<ChildOutcome> {
	const child = Bun.spawn([process.execPath, "run", path.join(packageDir, "test/fixtures", fixture)], {
		cwd: packageDir,
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, PI_TEST_RUNTIME: "0" },
	});
	return Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]).then(
		([stdout, stderr, exitCode]) => ({ stdout, stderr, exitCode }),
	);
}

/** Value a child reported on its `<key>:<value>` line. */
function marker(stdout: string, key: string): string | undefined {
	const line = stdout.split("\n").find(candidate => candidate.startsWith(`${key}:`));
	return line?.slice(key.length + 1);
}

describe("tab worker transport against a terminated worker", () => {
	it("aborts the run's tool calls instead of taking the process down", async () => {
		const { stdout, stderr, exitCode } = await runFixture("tab-worker-abort-after-terminate.ts");
		// Before the guard the child reported
		// `FATAL:InvalidStateError: Worker has been terminated` and never reached the
		// tool-call controllers the abort listener unwinds after the post.
		expect(stdout).toContain("ABORTED_TOOL_CALLS:1");
		expect(stdout).not.toContain("FATAL:");
		expect(exitCode, stderr).toBe(0);
	});

	it("reports send failures a dead worker cannot explain and keeps the tab live", async () => {
		const { stdout, stderr, exitCode } = await runFixture("tab-worker-send-failure.ts");
		// The guard classifies a terminated worker, not every rejection: a caller bug
		// still surfaces and the messages behind it still arrive.
		expect(marker(stdout, "SEND_FAILED")).toBe("true");
		expect(marker(stdout, "DELIVERED")).toBe("abort/r-after");
		expect(exitCode, stderr).toBe(0);
	});
});
