import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Contract: while suppression is active, unmanaged fd-2 writes land in the
 * redirect target instead of the TUI terminal; restore rejoins the saved
 * stderr; a stderr that is not the stdout terminal is left untouched.
 *
 * Runs in subprocesses so the test suite's own fd 2 is never mutated.
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

	it.skipIf(process.platform === "win32")("suppresses same-terminal fd-2 writes by default", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stderr-guard-"));
		tempDirs.push(dir);
		const redirectPath = path.join(dir, "redirect.log");
		const probePath = path.join(dir, "terminal-probe.ts");
		fs.writeFileSync(
			probePath,
			[
				`import { restoreTerminalStderr, suppressTerminalStderr } from ${JSON.stringify(GUARD_MODULE)};`,
				`import * as fs from "node:fs";`,
				`const redirectPath = process.argv[2];`,
				`const redirected = suppressTerminalStderr({ redirectPath });`,
				`process.stdout.write(JSON.stringify({`,
				`	stdoutTTY: process.stdout.isTTY,`,
				`	stderrTTY: process.stderr.isTTY,`,
				`	redirected,`,
				`}) + "\\n");`,
				`fs.writeSync(2, "redirected\\n");`,
				`restoreTerminalStderr();`,
				`fs.writeSync(2, "restored\\n");`,
			].join("\n"),
		);

		const chunks: Buffer[] = [];
		const terminalExited = Promise.withResolvers<void>();
		const proc = Bun.spawn([process.execPath, probePath, redirectPath], {
			terminal: {
				data(_terminal, data) {
					chunks.push(Buffer.from(data));
				},
				exit() {
					terminalExited.resolve();
				},
			},
			timeout: 10_000,
		});
		const exitCode = await proc.exited;
		await terminalExited.promise;
		proc.terminal?.close();

		expect(exitCode).toBe(0);
		const output = Buffer.concat(chunks).toString("utf8").replaceAll("\r\n", "\n");
		expect(output).toBe('{"stdoutTTY":true,"stderrTTY":true,"redirected":true}\nrestored\n');
		expect(fs.readFileSync(redirectPath, "utf8")).toBe("redirected\n");
	});
});
