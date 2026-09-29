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
const PRELOAD_MODULE = path.resolve(import.meta.dir, "fixtures/logger-fixed-date-preload.ts");
const ROTATION_PROBE = path.resolve(import.meta.dir, "fixtures/stderr-guard-rotation-probe.ts");

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

interface RotationReport {
	forced: boolean;
	logPathBasename: string;
	startupFile: string;
	currentFile: string | undefined;
	startupBody: string;
	currentBody: string;
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

	/**
	 * Regression (#13003): fd 2 was dup2'd once at TUI start and never moved,
	 * so after the sink rotated at local midnight raw stderr kept landing in
	 * the startup day's file — which retention later prunes. The UTC stamp in
	 * `getLogPath()` additionally named a different file than the sink's
	 * local-day name at any non-zero offset (here UTC+8, 01:00 local).
	 */
	it("follows the rotating sink across a local-day boundary", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "stderr-guard-rotation-"));
		tempDirs.push(root);
		const logsDir = path.join(root, "logs");
		fs.mkdirSync(logsDir);

		const proc = Bun.spawn(
			[
				process.execPath,
				"--preload",
				PRELOAD_MODULE,
				ROTATION_PROBE,
				logsDir,
				"2026-09-23T17:00:00Z",
				"2026-09-24T17:00:00Z",
			],
			{
				env: {
					...process.env,
					BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
					OMP_LOGGER_TEST_NOW: "2026-09-22T17:00:00Z",
					TZ: "Asia/Singapore",
				},
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
			new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
			proc.exited,
		]);

		expect(exitCode, stderr).toBe(0);
		const report = JSON.parse(stdout) as RotationReport;
		// 2026-09-22T17:00Z is 2026-09-23 01:00 in Singapore: the sink names
		// the local day, and getLogPath() must name the same file.
		expect(report.startupFile).toBe(`omp.2026-09-23.${proc.pid}.log`);
		expect(report.logPathBasename).toBe(report.startupFile);
		expect(report.currentFile).toBe(`omp.2026-09-24.${proc.pid}.log`);

		if (report.forced) {
			expect(report.startupBody).toContain("startup-day-marker");
			expect(report.startupBody).not.toContain("next-day-marker");
			expect(report.currentBody).toContain("next-day-marker");
			// Written after restore and one more rotation: the guard must have
			// released fd 2 back to the terminal and left it there.
			expect(stderr).toBe("restored\n");
		} else {
			// libc fd ops unavailable: the guard stays inert, every marker
			// reaches the real stderr and no log file absorbs them.
			expect(stderr).toBe("startup-day-marker\nnext-day-marker\nrestored\n");
			expect(report.startupBody).not.toContain("marker");
			expect(report.currentBody).not.toContain("marker");
		}
	});
});
