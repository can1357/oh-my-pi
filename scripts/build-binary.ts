#!/usr/bin/env bun

import * as path from "node:path";
import { compileCodingAgent } from "../packages/coding-agent/scripts/compile-binary";
import { buildLinkedRuntime, hostLinkedRuntimeTarget, resolveLinkedRuntimeTarget } from "./linked-runtime";

const repoRoot = path.join(import.meta.dir, "..");
const packageDir = path.join(repoRoot, "packages", "coding-agent");

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

async function main(): Promise<void> {
	const crossBuild = Bun.env.CROSS_TARGET ? resolveLinkedRuntimeTarget(Bun.env.CROSS_TARGET) : null;
	const native = crossBuild ?? hostLinkedRuntimeTarget();
	const mode = Bun.env.OMP_COMPILED_NATIVES ?? "linked";
	if (mode !== "linked" && mode !== "embedded") throw new Error(`Unknown OMP_COMPILED_NATIVES: ${mode}`);
	const template = Bun.env.BUN_COMPILE_EXECUTABLE_PATH;
	if (mode === "embedded" && !template) throw new Error("Embedded builds require BUN_COMPILE_EXECUTABLE_PATH");
	const shouldAdhocSign =
		process.platform === "darwin" &&
		(!crossBuild || crossBuild.platform === "darwin") &&
		Bun.env.BUN_NO_CODESIGN_MACHO_BINARY !== "1";
	const outName = crossBuild ? `omp-${crossBuild.id}` : "omp";
	const outputPath = path.join(packageDir, "dist", outName);
	// Generate inside the try so the finally always restores the empty checked-in
	// placeholders (stats client archive, docs index) even on failure.
	try {
		await runCommand(["bun", "--cwd=../stats", "run", "gen:stats"]);
		// Embed metadata for the same content-addressed viewer used by source exports.
		// Generate here too for clean checkouts that skipped install hooks.
		await runCommand(["bun", "--cwd=../collab-web", "run", "gen:export-viewer"]);
		await compileCodingAgent({
			repoRoot,
			entrypoint: path.join(packageDir, "src", "cli.ts"),
			outfile: outputPath,
			executablePath: template ?? (await buildLinkedRuntime(native.id)),
			target: native.target,
			embeddedNative: mode === "embedded" ? native : undefined,
			skipBuiltinCodesign: shouldAdhocSign,
		});

		if (shouldAdhocSign) {
			await runCommand([
				"codesign",
				"--force",
				"--sign",
				"-",
				"--entitlements",
				path.join(repoRoot, "scripts", "macos-entitlements.plist"),
				outputPath,
			]);
		}
	} finally {
		await runCommand(["bun", "--cwd=../stats", "run", "gen:stats:reset"]);
	}
}

if (import.meta.main) await main();
