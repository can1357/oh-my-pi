#!/usr/bin/env bun

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ANDROID_COMPILE_TARGET, compileCodingAgent } from "./compile-binary";

const packageDir = path.join(import.meta.dir, "..");
const repoRoot = path.join(packageDir, "..", "..");

async function runCommand(command: string[]): Promise<void> {
	const proc = Bun.spawn(command, {
		cwd: packageDir,
		stdout: "inherit",
		stderr: "inherit",
	});
	const exitCode = await proc.exited;
	if (exitCode !== 0) {
		throw new Error(`Command failed with exit code ${exitCode}: ${command.join(" ")}`);
	}
}

async function buildAndroidBinary(): Promise<void> {
	if (process.platform !== "linux") {
		throw new Error("Android cross-build requires a Linux build host");
	}

	const outputPath = path.join(packageDir, "dist", "omp-android-arm64");
	await runCommand(["bun", "../../scripts/bazel-natives.ts", "android-arm64", "--dest", "../natives/native"]);
	try {
		await runCommand(["bun", "--cwd=../stats", "run", "gen:stats"]);
		await runCommand(["bun", "--cwd=../collab-web", "run", "gen:export-viewer"]);
		await fs.mkdir(path.dirname(outputPath), { recursive: true });
		await compileCodingAgent({
			repoRoot,
			entrypoint: path.join(packageDir, "src", "cli.ts"),
			outfile: outputPath,
			native: { platform: "android", arch: "arm64" },
			target: ANDROID_COMPILE_TARGET,
		});
	} finally {
		await runCommand(["bun", "--cwd=../stats", "run", "gen:stats:reset"]);
	}
}

if (import.meta.main) await buildAndroidBinary();
