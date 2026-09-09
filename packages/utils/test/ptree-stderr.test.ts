import { describe, expect, it } from "bun:test";
import { exec, NonZeroExitError, spawn } from "@oh-my-pi/pi-utils/ptree";

const STDERR_LIMIT = NonZeroExitError.MAX_TRACE;
const LARGE_STDERR_SIZE = 4 * 1024 * 1024;
const STDERR_HEAD = "stderr-head\n";
const STDERR_TAIL = "\nstderr-tail";
const FULL_CAPTURE_ERROR = "Full stderr capture must be requested when spawning the process";

function stderrFixture(size: number, exitCode = 0, stdout = ""): string[] {
	const fillLength = size - STDERR_HEAD.length - STDERR_TAIL.length;
	const script = [
		`await Bun.stdout.write(${JSON.stringify(stdout)});`,
		`await Bun.stderr.write(${JSON.stringify(STDERR_HEAD)} + "x".repeat(${fillLength}) + ${JSON.stringify(STDERR_TAIL)});`,
		`process.exitCode = ${exitCode};`,
	].join("\n");
	return ["bun", "-e", script];
}

describe("ptree stderr capture", () => {
	it("requires full stderr capture to be selected before spawning", async () => {
		using child = spawn(stderrFixture(LARGE_STDERR_SIZE));
		await child.exited;

		let captureError: unknown;
		try {
			await child.wait({ stderr: "full" });
		} catch (caught) {
			captureError = caught;
		}
		expect(captureError).toBeInstanceOf(Error);
		if (!(captureError instanceof Error)) throw new Error("Expected full capture error");
		expect(captureError.message).toContain(FULL_CAPTURE_ERROR);
		const result = await child.wait();

		expect(result.stderr.length).toBe(STDERR_LIMIT);
		expect(result.stderr).not.toContain(STDERR_HEAD);
		expect(result.stderr).toEndWith(STDERR_TAIL);
		expect(child.peekStderr()).toBe(result.stderr);
	});

	it("preserves complete stderr for explicit exec capture", async () => {
		const result = await exec(stderrFixture(LARGE_STDERR_SIZE, 0, "stdout-ok"), { stderr: "full" });

		expect(result.stdout).toBe("stdout-ok");
		expect(result.stderr.length).toBe(LARGE_STDERR_SIZE);
		expect(result.stderr).toStartWith(STDERR_HEAD);
		expect(result.stderr).toEndWith(STDERR_TAIL);
	});

	it("preserves the live stream and retained stderr for explicit spawn capture", async () => {
		const size = STDERR_LIMIT * 4;
		using child = spawn(stderrFixture(size, 0, "spawn-ok"), { stderr: "full" });
		const stderrStream = child.stderr;
		if (!stderrStream) throw new Error("Expected exposed stderr stream");

		const streamedStderr = new Response(stderrStream).text();
		const [result, streamed] = await Promise.all([child.wait({ stderr: "full" }), streamedStderr]);

		expect(result.stdout).toBe("spawn-ok");
		expect(result.stderr.length).toBe(size);
		expect(result.stderr).toStartWith(STDERR_HEAD);
		expect(result.stderr).toEndWith(STDERR_TAIL);
		expect(streamed).toBe(result.stderr);
	});

	it("keeps peek and nonzero errors on the bounded stderr tail", async () => {
		using child = spawn(stderrFixture(STDERR_LIMIT * 4, 7));
		let error: unknown;
		try {
			await child.exitedCleanly;
		} catch (caught) {
			error = caught;
		}

		expect(error).toBeInstanceOf(NonZeroExitError);
		if (!(error instanceof NonZeroExitError)) throw new Error("Expected NonZeroExitError");
		expect(error.stderr.length).toBe(STDERR_LIMIT);
		expect(error.stderr).not.toContain(STDERR_HEAD);
		expect(error.stderr).toEndWith(STDERR_TAIL);
		expect(error.message).toContain(STDERR_TAIL);
		expect(child.peekStderr()).toBe(error.stderr);
	});
});
