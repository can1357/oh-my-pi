import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const REPO_ROOT = path.join(import.meta.dir, "..");
const ACTION_SUITE = path.join(REPO_ROOT, "scripts/bun-install-action.test.ts");

/** Whether this host can run the action's shell step, the way the suite decides it. */
const HAS_POSIX_SHELL = process.platform !== "win32" && Bun.which("bash") !== null;

interface SuiteOutcome {
	exitCode: number;
	/** Every test case the child ran, with its class (the enclosing describe). */
	cases: { classname: string; name: string; skipped: boolean }[];
}

/**
 * Run the bun-install action suite in a child process and report the cases it
 * ran. The child sees `env`, so the caller decides what the suite can reach.
 */
async function runActionSuite(env: Record<string, string | undefined>): Promise<SuiteOutcome> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-action-suite-"));
	try {
		const junit = path.join(dir, "junit.xml");
		const proc = Bun.spawn(
			[process.execPath, "test", "--reporter=junit", `--reporter-outfile=${junit}`, ACTION_SUITE],
			{
				cwd: REPO_ROOT,
				env,
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
			throw new Error(`the suite failed:\n${stdout}\n${stderr}`);
		}
		return { exitCode, cases };
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
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
		return await runActionSuite({
			...process.env,
			// An empty directory on `PATH`: no `bash`, so the shell-dependent
			// fixtures cannot run. `process.execPath` is absolute, so the
			// child itself still starts.
			PATH: dir,
		});
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}

/**
 * Run the bun-install action suite in a child process that keeps this host's
 * `PATH`, so the shell-dependent fixtures can run.
 */
async function runActionSuiteWithShell(): Promise<SuiteOutcome> {
	return await runActionSuite({ ...process.env });
}

/** The cases of the describes that drive the action's shell step. */
function shellDependentCases(outcome: SuiteOutcome): SuiteOutcome["cases"] {
	return outcome.cases.filter(
		c => c.classname === "bun-install setup decision" || c.classname === "bun-install setup probe",
	);
}

describe("bun-install action suite on a host without a POSIX shell", () => {
	// The composite action's "Detect environment" step is a shell script, so
	// the suites that drive it need a POSIX shell. Without one (a Windows
	// checkout with no Git Bash on `PATH`) the spawn fails before the suite
	// reaches an assertion, so `bun run test:scripts` fails outright.
	test("skips the shell-dependent suites and still runs the cross-platform guard test", async () => {
		const outcome = await runActionSuiteWithoutShell();

		const shellDependent = shellDependentCases(outcome);
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

describe.skipIf(!HAS_POSIX_SHELL)("bun-install action suite on a host with a POSIX shell", () => {
	// A guard that skipped the shell-dependent suites everywhere would satisfy
	// the case above while dropping their coverage entirely, so where a shell
	// is reachable those suites still have to run.
	test("still runs the shell-dependent suites", async () => {
		const outcome = await runActionSuiteWithShell();

		const shellDependent = shellDependentCases(outcome);
		expect(shellDependent.length).toBeGreaterThan(0);
		for (const testCase of shellDependent) {
			expect({ classname: testCase.classname, name: testCase.name, skipped: testCase.skipped }).toEqual({
				classname: testCase.classname,
				name: testCase.name,
				skipped: false,
			});
		}
	});
});
