// How plugin-bin-path.test.ts runs a case: in a child process
// (plugin-bin-path.runner.ts) whose environment is exactly what the case
// gives it. Kept apart from the runner so that importing it loads nothing of
// the coding agent into the calling process.
import * as path from "node:path";
import type { RunnerResult, RunnerScenario } from "./plugin-bin-path.runner";

const RUNNER = path.join(import.meta.dir, "plugin-bin-path.runner.ts");

/**
 * Run one route in a child process whose environment is exactly `env`; the
 * calling process's environment and directory state take no part in it, and
 * the case changes neither.
 */
export async function runCase(scenario: RunnerScenario, env: Record<string, string>): Promise<RunnerResult> {
	const child = Bun.spawn([process.execPath, RUNNER, JSON.stringify(scenario)], {
		cwd: import.meta.dir,
		env,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	if (exitCode !== 0) throw new Error(`runner exited ${exitCode}: ${stderr}`);
	return JSON.parse(stdout.trim().split("\n").at(-1) ?? "") as RunnerResult;
}
