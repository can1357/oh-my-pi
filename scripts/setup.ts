#!/usr/bin/env bun
/**
 * `bun setup` entrypoint. Chains the four setup steps (install → native
 * addon build → coding-agent link → omp link). The native host build uses
 * the local Cargo/N-API backend by default; set
 * `OMP_NATIVE_BUILD_BACKEND=bazel` to opt into bazel. Flags after `--` are
 * appended to the native build invocation.
 *
 * On Windows the final `link omp` step runs natively in this file instead of
 * spawning `sh` (issue #12483): same target check, same global-bin lookup
 * order, symlink with copy fallback.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
const repoRoot = path.join(import.meta.dir, "..");

const argv = process.argv.slice(2);
const passthrough: string[] = [];
for (let i = 0; i < argv.length; i++) {
	const arg = argv[i];
	if (arg === "--") {
		passthrough.push(...argv.slice(i + 1));
		break;
	}
	passthrough.push(arg);
}

interface Step {
	label: string;
	cmd: string[];
	cwd?: string;
}

/**
 * Native equivalent of `scripts/link-omp.sh` for Windows, where `sh` is
 * unavailable (issue #12483). Same semantics: verify the wrapper target,
 * resolve Bun's global bin dir (`bun pm -g bin`, then
 * `${BUN_INSTALL:-$HOME/.bun}/bin`), and link `omp` to it — symlink first,
 * plain copy as a fallback when links need privileges the user lacks.
 * Returns a process-like exit code for the shared runner below.
 */
function linkOmpWindows(repoRoot: string): number {
	const target = path.join(repoRoot, "packages", "coding-agent", "scripts", "omp");
	try {
		fs.accessSync(target, fs.constants.F_OK);
	} catch {
		console.error(`link-omp: target wrapper not found: ${target}`);
		return 1;
	}
	let globalBin = "";
	try {
		const out = Bun.spawnSync(["bun", "pm", "-g", "bin"], { stdout: "pipe", stderr: "ignore" });
		if (out.exitCode === 0) globalBin = Buffer.from(out.stdout).toString().trim();
	} catch {
		// fall through to the default below
	}
	if (!globalBin) globalBin = path.join(process.env.BUN_INSTALL ?? path.join(os.homedir(), ".bun"), "bin");
	const linkPath = path.join(globalBin, "omp");
	try {
		fs.mkdirSync(globalBin, { recursive: true });
		try {
			fs.unlinkSync(linkPath);
		} catch {
			// nothing to replace
		}
		fs.symlinkSync(target, linkPath, "file");
		console.log(`link-omp: linked ${linkPath} -> ${target}`);
		return 0;
	} catch (error) {
		console.error(`link-omp: symlink failed (${error}), falling back to copy`);
		try {
			fs.copyFileSync(target, linkPath);
			console.log(`link-omp: copied ${target} -> ${linkPath}`);
			return 0;
		} catch (copyError) {
			console.error(`link-omp: copy failed: ${copyError}`);
			return 1;
		}
	}
}

const steps: Step[] = [
	{ label: "bun install", cmd: ["bun", "install"] },
	{ label: "build:native", cmd: ["bun", "run", "build:native", ...passthrough] },
	{ label: "coding-agent link", cmd: ["bun", "--cwd=packages/coding-agent", "link"] },
	{ label: "link omp", cmd: ["sh", "scripts/link-omp.sh"] },
];

for (const step of steps) {
	console.log(`\n▶ ${step.label}`);
	if (step.label === "link omp" && process.platform === "win32") {
		const exitCode = linkOmpWindows(repoRoot);
		if (exitCode !== 0) {
			console.error(`\nsetup step "${step.label}" failed (exit ${exitCode})`);
			process.exit(exitCode);
		}
		continue;
	}
	const proc = Bun.spawn(step.cmd, {
		cwd: step.cwd ?? repoRoot,
		env: process.env,
		stdout: "inherit",
		stderr: "inherit",
	});
	const exitCode = await proc.exited;
	if (exitCode !== 0) {
		console.error(`\nsetup step "${step.label}" failed (exit ${exitCode})`);
		process.exit(exitCode || 1);
	}
}
