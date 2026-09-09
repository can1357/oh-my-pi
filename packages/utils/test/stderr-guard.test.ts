import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Contract (issue: macOS libmalloc diagnostics painting into the TUI
 * viewport; mirrors openai/codex#24459): while suppression is active, fd-2
 * writes land in the redirect target instead of the previous stderr; restore
 * rejoins the saved stderr; without `force`, a stderr that is not the stdout
 * terminal (here: a pipe) is left untouched.
 *
 * Runs in a subprocess so the test suite's own fd 2 is never mutated.
 */

const GUARD_MODULE = path.resolve(import.meta.dir, "../src/stderr-guard.ts");

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		fs.rmSync(dir, { force: true, recursive: true });
	}
});

interface ProbeReport {
	gateResult: boolean;
	forced: boolean;
	secondSuppress: boolean;
	suppressedWhileActive: boolean;
	suppressedAfterRestore: boolean;
}

describe("stderr guard", () => {
	it("suppresses fd-2 writes only while active and refuses non-terminal stderr without force", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stderr-guard-"));
		tempDirs.push(dir);
		const redirectPath = path.join(dir, "redirect.log");
		const probePath = path.join(dir, "probe.ts");
		fs.writeFileSync(
			probePath,
			[
				`import { isTerminalStderrSuppressed, restoreTerminalStderr, suppressTerminalStderr } from ${JSON.stringify(GUARD_MODULE)};`,
				`import * as fs from "node:fs";`,
				`const redirectPath = process.argv[2];`,
				`fs.writeSync(2, "before\\n");`,
				`// stderr is a pipe here, so the same-terminal gate must refuse.`,
				`const gateResult = suppressTerminalStderr();`,
				`const forced = suppressTerminalStderr({ force: true, redirectPath });`,
				`const suppressedWhileActive = isTerminalStderrSuppressed();`,
				`if (forced) fs.writeSync(2, "hidden\\n");`,
				`// Idempotent while active: must not stack a second saved fd.`,
				`const secondSuppress = suppressTerminalStderr({ force: true, redirectPath });`,
				`restoreTerminalStderr();`,
				`fs.writeSync(2, "after\\n");`,
				`// Restore without active suppression is a no-op.`,
				`restoreTerminalStderr();`,
				`fs.writeSync(2, "still-visible\\n");`,
				`process.stdout.write(JSON.stringify({`,
				`	gateResult,`,
				`	forced,`,
				`	secondSuppress,`,
				`	suppressedWhileActive,`,
				`	suppressedAfterRestore: isTerminalStderrSuppressed(),`,
				`}));`,
			].join("\n"),
		);

		const proc = Bun.spawn([process.execPath, probePath, redirectPath], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
			new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
			proc.exited,
		]);

		expect(exitCode).toBe(0);
		const report = JSON.parse(stdout) as ProbeReport;
		// Piped stderr is not the stdout terminal → the non-forced gate refuses.
		expect(report.gateResult).toBe(false);
		expect(report.suppressedAfterRestore).toBe(false);

		if (report.forced) {
			expect(report.suppressedWhileActive).toBe(true);
			expect(report.secondSuppress).toBe(true);
			expect(stderr).toBe("before\nafter\nstill-visible\n");
			expect(fs.readFileSync(redirectPath, "utf8")).toBe("hidden\n");
		} else {
			// libc fd ops unavailable on this platform: the guard must stay
			// inert and every write must reach the original stderr.
			expect(stderr).toBe("before\nafter\nstill-visible\n");
			expect(fs.existsSync(redirectPath)).toBe(false);
		}
	});
});
