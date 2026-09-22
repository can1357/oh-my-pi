#!/usr/bin/env bun
/**
 * `bun setup` entrypoint. Chains the four setup steps (install → native
 * addon build → coding-agent link → omp link). The native host build uses
 * the local Cargo/N-API backend by default; set
 * `OMP_NATIVE_BUILD_BACKEND=bazel` to opt into bazel. Flags after `--` are
 * appended to the native build invocation.
 */
import * as fs from "node:fs";
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

/**
 * Resolve the `sh` interpreter for the link step. On Windows there is no
 * `sh` on PATH, but Git for Windows (a hard repo prerequisite: `git` is
 * already required to check out the tree) ships one next to `git.exe`
 * (`<git-root>/bin/sh.exe`). Without this, `bun run setup` fails on native
 * Windows with `ENOENT: sh` (issue #12483).
 */
function resolveSh(): string[] {
	if (process.platform !== "win32") return ["sh"];
	for (const dir of String(Bun.env.PATH ?? "").split(path.delimiter)) {
		const trimmed = dir.trim().replace(/^"|"$/g, "");
		if (!trimmed) continue;
		for (const candidate of [path.join(trimmed, "sh.exe"), path.join(trimmed, "sh")]) {
			try {
				if (fs.statSync(candidate).isFile()) return [candidate];
			} catch {
				// Not here; keep searching.
			}
		}
		if (/git[\\/]cmd$/i.test(trimmed.replace(/[/\\]$/, ""))) {
			for (const candidate of [
				path.join(trimmed, "..", "bin", "sh.exe"),
				path.join(trimmed, "..", "usr", "bin", "sh.exe"),
			]) {
				try {
					if (fs.statSync(candidate).isFile()) return [candidate];
				} catch {
					// Not here; keep searching.
				}
			}
		}
	}
	return ["sh"];
}

interface Step {
	label: string;
	cmd: string[];
	cwd?: string;
}

const steps: Step[] = [
	{ label: "bun install", cmd: ["bun", "install"] },
	{ label: "build:native", cmd: ["bun", "run", "build:native", ...passthrough] },
	{ label: "coding-agent link", cmd: ["bun", "--cwd=packages/coding-agent", "link"] },
	{ label: "link omp", cmd: [...resolveSh(), "scripts/link-omp.sh"] },
];

for (const step of steps) {
	console.log(`\n▶ ${step.label}`);
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
