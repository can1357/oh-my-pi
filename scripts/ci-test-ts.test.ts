import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { runTestCommandsSequentially, type SequentialChunkRunner, type TestCommand } from "./ci-test-ts";

// The sequential (CI) path of scripts/ci-test-ts.ts. Contract under test: when
// CI=true the runner must not fail fast — every chunk runs even after one
// fails, each failure is named with its exit code, the run ends with the same
// summary footer the parallel path prints, and the process exit code is
// non-zero. Regression: the old loop threw on the first failing chunk
// (runTestCommand's `throw`), skipping every chunk after it, so a CI job
// reported one failure and hid the rest behind a runner stack trace.
describe("runTestCommandsSequentially", () => {
	// Fake chunks: two fail (2 and 5), three pass, and the failures are
	// non-adjacent so the test proves chunks after each failure still ran.
	const exitCodes = [0, 1, 0, 0, 1];
	const commands: TestCommand[] = exitCodes.map((exitCode, i) => ({
		label: `fake chunk ${i + 1} (exit ${exitCode})`,
		cwd: ".",
		command: ["bun", "test", `--fake-${i + 1}`],
	}));
	/** Injected execution: reports the scripted exit code, empty output. */
	const fakeRun: SequentialChunkRunner = async testCommand => {
		const index = Number(/--fake-(\d+)/.exec(testCommand.command.at(-1) ?? "")?.[1]);
		return { exitCode: exitCodes[index - 1], output: "" };
	};
	let stdout = "";
	let stdoutSpy: ReturnType<typeof spyOn>;

	beforeEach(() => {
		process.exitCode = 0;
		stdout = "";
		stdoutSpy = spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
			stdout += chunk.toString();
			return true;
		}) as typeof process.stdout.write);
	});

	afterEach(() => {
		stdoutSpy.mockRestore();
		process.exitCode = 0;
	});

	test("runs every chunk, names the failing one, summarizes, and exits non-zero", async () => {
		await runTestCommandsSequentially(commands, fakeRun);

		// All five chunks ran — chunks 3–5 are the regression assertion: the
		// fail-fast loop never reached them after chunk 2's failure.
		for (const command of commands) {
			expect(stdout).toContain(`==> ${command.label}`);
		}
		// The failing chunk is named with its exit code.
		expect(stdout).toContain("✗ fake chunk 2 (exit 1)");
		// The closing summary names the failure counts and stays plain-text
		// (no ANSI) because stdout is not a TTY under the test runner.
		expect(stdout).toContain("3 chunks passed");
		expect(stdout).toContain("2 failed");
		expect(stdout).toContain("Ran 5 test command(s) in");
		expect(stdout).not.toContain("\x1b[");
		// Exit code is non-zero, not an uncaught throw.
		expect(process.exitCode).not.toBe(0);
	});

	test("an all-green run prints only the summary footer and exits zero", async () => {
		const runGreen: SequentialChunkRunner = async () => ({ exitCode: 0, output: "" });

		await runTestCommandsSequentially(commands, runGreen);

		expect(stdout).toContain("5 chunks passed");
		expect(stdout).toContain("0 failed");
		expect(stdout).not.toContain("✗");
		expect(process.exitCode).toBe(0);
	});
});
