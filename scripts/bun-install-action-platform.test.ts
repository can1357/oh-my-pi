import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const REPO_ROOT = path.join(import.meta.dir, "..");
const ACTION_SUITE = path.join(REPO_ROOT, "scripts/bun-install-action.test.ts");

interface SuiteOutcome {
	exitCode: number;
	/** Every test case the child ran, with its class (the enclosing describe). */
	cases: { classname: string; name: string; skipped: boolean }[];
}

/**
 * Run the bun-install action suite in a child process whose `PATH` holds no
 * POSIX shell, which is what a Windows checkout without Git Bash looks like
 * to the suite: the fake Bun it writes is a `#!/usr/bin/env bash` shim and the
 * action's own "Detect environment" step is a shell script.
 */
async function runActionSuiteWithoutShell(): Promise<SuiteOutcome> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-no-shell-"));
	try {
		const junit = path.join(dir, "junit.xml");
		const proc = Bun.spawn(
			[process.execPath, "test", "--reporter=junit", `--reporter-outfile=${junit}`, ACTION_SUITE],
			{
				cwd: REPO_ROOT,
				// An empty directory on `PATH`: no `bash`, so the shell-dependent
				// fixtures cannot run. `process.execPath` is absolute, so the
				// child itself still starts.
				env: { ...process.env, PATH: dir },
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
		const exitCode = await proc.exited;
		const report = await fs.readFile(junit, "utf8");
		const cases: SuiteOutcome["cases"] = [];
		for (const match of report.matchAll(/<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g)) {
			const attrs = match[1] ?? "";
			const body = match[3] ?? "";
			const classname = /\bclassname="([^"]*)"/.exec(attrs)?.[1] ?? "";
			const name = /\bname="([^"]*)"/.exec(attrs)?.[1] ?? "";
			cases.push({ classname, name, skipped: body.includes("<skipped") });
		}
		if (exitCode !== 0) {
			throw new Error(`the suite failed without a POSIX shell:\n${stdout}\n${stderr}`);
		}
		return { exitCode, cases };
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}

describe("bun-install action suite on a host without a POSIX shell", () => {
	// The composite action's "Detect environment" step is a shell script, so
	// the suites that drive it need a POSIX shell. Without one (a Windows
	// checkout with no Git Bash on `PATH`) the spawn fails before the suite
	// reaches an assertion, so `bun run test:scripts` fails outright.
	test("skips the shell-dependent suites and still runs the cross-platform guard test", async () => {
		const outcome = await runActionSuiteWithoutShell();

		const shellDependent = outcome.cases.filter(
			c => c.classname === "bun-install setup decision" || c.classname === "bun-install setup probe",
		);
		expect(shellDependent.length).toBeGreaterThan(0);
		for (const testCase of shellDependent) {
			expect({ classname: testCase.classname, name: testCase.name, skipped: testCase.skipped }).toEqual({
				classname: testCase.classname,
				name: testCase.name,
				skipped: true,
			});
		}

		// The guard's own CLI test needs no shell: it runs the TypeScript guard
		// directly, so it stays enabled everywhere.
		const guardCases = outcome.cases.filter(c => c.classname === "check-bun-floor --satisfies");
		expect(guardCases.length).toBeGreaterThan(0);
		for (const testCase of guardCases) {
			expect({ classname: testCase.classname, name: testCase.name, skipped: testCase.skipped }).toEqual({
				classname: testCase.classname,
				name: testCase.name,
				skipped: false,
			});
		}
	});
});
