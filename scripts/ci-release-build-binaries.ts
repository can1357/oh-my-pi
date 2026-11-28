#!/usr/bin/env bun

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { COMPILED_EXTERNAL_DEPENDENCIES, compileCodingAgent } from "../packages/coding-agent/scripts/compile-binary";
import { buildLinkedRuntime, type LinkedRuntimeTarget, linkedRuntimeTargets } from "./linked-runtime";

const repoRoot = path.join(import.meta.dir, "..");
const binariesDir = path.join(repoRoot, "packages", "coding-agent", "binaries");
const entrypoint = path.join(repoRoot, "packages", "coding-agent", "src", "cli.ts");
const isDryRun = process.argv.includes("--dry-run");

function parseRequestedTargets(): Set<string> | null {
	const flagIndex = process.argv.indexOf("--targets");
	const flagValue =
		flagIndex >= 0
			? process.argv[flagIndex + 1]
			: (process.argv.find(arg => arg.startsWith("--targets="))?.split("=", 2)[1] ?? Bun.env.RELEASE_TARGETS);

	if (!flagValue) {
		return null;
	}

	return new Set(
		flagValue
			.split(",")
			.map(value => value.trim())
			.filter(Boolean),
	);
}

function shouldAdhocSignDarwinBinary(target: LinkedRuntimeTarget): boolean {
	return target.platform === "darwin" && process.platform === "darwin";
}

async function runCommand(command: string[], cwd: string): Promise<void> {
	const proc = Bun.spawn(command, {
		cwd,
		stdout: "inherit",
		stderr: "inherit",
	});
	const exitCode = await proc.exited;
	if (exitCode !== 0) {
		throw new Error(`Command failed with exit code ${exitCode}: ${command.join(" ")}`);
	}
}

async function buildBinary(target: LinkedRuntimeTarget): Promise<void> {
	const name = target.platform === "win32" ? `omp-windows-${target.arch}.exe` : `omp-${target.id}`;
	const outfile = path.join(binariesDir, name);
	console.log(`Building ${outfile}...`);
	if (isDryRun) {
		console.log(
			`DRY RUN Bun.build target=${target.target} outfile=${outfile} external=${COMPILED_EXTERNAL_DEPENDENCIES.join(",")}`,
		);
		return;
	}

	await compileCodingAgent({
		repoRoot,
		entrypoint,
		outfile,
		executablePath: Bun.env.BUN_COMPILE_EXECUTABLE_PATH ?? (await buildLinkedRuntime(target.id)),
		target: target.target,
		minifyIdentifiers: true,
		skipBuiltinCodesign: shouldAdhocSignDarwinBinary(target),
	});
	// Bun 1.3.12 emits a truncated Mach-O signature on darwin builds.
	if (shouldAdhocSignDarwinBinary(target)) {
		await runCommand(
			[
				"codesign",
				"--force",
				"--sign",
				"-",
				"--entitlements",
				path.join(repoRoot, "scripts", "macos-entitlements.plist"),
				outfile,
			],
			repoRoot,
		);
	}
}

async function generateBundle(): Promise<void> {
	if (isDryRun) {
		console.log("DRY RUN bun run gen:stats");
		console.log("DRY RUN bun --cwd=packages/collab-web run gen:export-viewer --check");
		return;
	}
	await runCommand(["bun", "run", "gen:stats"], repoRoot);
	await runCommand(["bun", "--cwd=packages/collab-web", "run", "gen:export-viewer", "--check"], repoRoot);
}

async function resetArtifacts(): Promise<void> {
	if (isDryRun) {
		console.log("DRY RUN bun run gen:stats:reset");
		return;
	}
	await runCommand(["bun", "run", "gen:stats:reset"], repoRoot);
}

async function main(): Promise<void> {
	const requestedTargets = parseRequestedTargets();
	const selectedTargets = requestedTargets
		? linkedRuntimeTargets.filter(target => requestedTargets.has(target.id))
		: linkedRuntimeTargets;
	if (Bun.env.BUN_COMPILE_EXECUTABLE_PATH && selectedTargets.length > 1) {
		throw new Error("A prebuilt runtime template can only be used with a single release target.");
	}

	if (requestedTargets) {
		const unknownTargets = [...requestedTargets].filter(
			requestedTarget => !linkedRuntimeTargets.some(target => target.id === requestedTarget),
		);
		if (unknownTargets.length > 0) {
			throw new Error(`Unknown release target(s): ${unknownTargets.join(", ")}`);
		}
	}

	if (selectedTargets.length === 0) {
		throw new Error("No release targets selected.");
	}

	await fs.mkdir(binariesDir, { recursive: true });
	// Generate inside the try so resetArtifacts() always restores the empty
	// checked-in placeholders, even if a generate or build step throws.
	try {
		await generateBundle();
		for (const target of selectedTargets) {
			await buildBinary(target);
		}
	} finally {
		await resetArtifacts();
	}
}

await main();
