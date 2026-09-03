#!/usr/bin/env bun

import * as fs from "node:fs/promises";
import { createRequire } from "node:module";
import * as path from "node:path";
import { COMPILED_EXTERNAL_DEPENDENCIES, compileCodingAgent } from "../packages/coding-agent/scripts/compile-binary";

interface BinaryTarget {
	id: string;
	platform: string;
	arch: string;
	target: Bun.Build.CompileTarget;
	outfile: string;
}

const repoRoot = path.join(import.meta.dir, "..");
const binariesDir = path.join(repoRoot, "packages", "coding-agent", "binaries");
const entrypoint = path.join(repoRoot, "packages", "coding-agent", "src", "cli.ts");
const transformersManifest: unknown = createRequire(import.meta.url)("@huggingface/transformers/package.json");
if (
	typeof transformersManifest !== "object" ||
	transformersManifest === null ||
	!("version" in transformersManifest) ||
	typeof transformersManifest.version !== "string"
) {
	throw new Error("@huggingface/transformers package manifest has no string version");
}
const transformersVersion = transformersManifest.version;
// Worker threads re-enter the binary's single CLI host entry.
const isDryRun = process.argv.includes("--dry-run");
const targets: BinaryTarget[] = [
	{
		id: "darwin-arm64",
		platform: "darwin",
		arch: "arm64",
		target: "bun-darwin-arm64",
		outfile: "packages/coding-agent/binaries/omp-darwin-arm64",
	},
	{
		id: "darwin-x64",
		platform: "darwin",
		arch: "x64",
		target: "bun-darwin-x64",
		outfile: "packages/coding-agent/binaries/omp-darwin-x64",
	},
	{
		id: "linux-x64",
		platform: "linux",
		arch: "x64",
		target: "bun-linux-x64-baseline",
		outfile: "packages/coding-agent/binaries/omp-linux-x64",
	},
	{
		id: "linux-arm64",
		platform: "linux",
		arch: "arm64",
		target: "bun-linux-arm64",
		outfile: "packages/coding-agent/binaries/omp-linux-arm64",
	},
	{
		id: "linux-musl-x64",
		platform: "linux",
		arch: "x64",
		target: "bun-linux-x64-musl-baseline",
		outfile: "packages/coding-agent/binaries/omp-linux-musl-x64",
	},
	{
		id: "linux-musl-arm64",
		platform: "linux",
		arch: "arm64",
		target: "bun-linux-arm64-musl",
		outfile: "packages/coding-agent/binaries/omp-linux-musl-arm64",
	},
	{
		id: "win32-x64",
		platform: "win32",
		arch: "x64",
		target: "bun-windows-x64-baseline",
		outfile: "packages/coding-agent/binaries/omp-windows-x64.exe",
	},
	{
		id: "win32-arm64",
		platform: "win32",
		arch: "arm64",
		target: "bun-windows-arm64",
		outfile: "packages/coding-agent/binaries/omp-windows-arm64.exe",
	},
];

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

function shouldAdhocSignDarwinBinary(target: BinaryTarget): boolean {
	return target.platform === "darwin" && process.platform === "darwin";
}

async function runCommand(command: string[], cwd: string, env: NodeJS.ProcessEnv = Bun.env): Promise<void> {
	const proc = Bun.spawn(command, {
		cwd,
		env,
		stdout: "inherit",
		stderr: "inherit",
	});
	const exitCode = await proc.exited;
	if (exitCode !== 0) {
		throw new Error(`Command failed with exit code ${exitCode}: ${command.join(" ")}`);
	}
}

async function embedNative(target: BinaryTarget): Promise<void> {
	if (isDryRun) {
		console.log(`DRY RUN bun run gen:native [${target.platform}/${target.arch}]`);
		return;
	}

	await runCommand(["bun", "run", "gen:native"], repoRoot, {
		...Bun.env,
		TARGET_PLATFORM: target.platform,
		TARGET_ARCH: target.arch,
	});
}

async function buildBinary(target: BinaryTarget): Promise<void> {
	console.log(`Building ${target.outfile}...`);
	await embedNative(target);
	if (isDryRun) {
		console.log(
			`DRY RUN Bun.build target=${target.target} outfile=${target.outfile} external=${COMPILED_EXTERNAL_DEPENDENCIES.join(",")}`,
		);
		return;
	}

	await compileCodingAgent({
		repoRoot,
		entrypoint,
		outfile: path.join(repoRoot, target.outfile),
		transformersVersion,
		target: target.target,
		minifyIdentifiers: true,
		skipBuiltinCodesign: shouldAdhocSignDarwinBinary(target),
	});
	// Bun 1.3.12 emits a truncated Mach-O signature on darwin builds.
	if (shouldAdhocSignDarwinBinary(target)) {
		await runCommand(["codesign", "--force", "--sign", "-", path.join(repoRoot, target.outfile)], repoRoot);
	}
}

async function generateBundle(): Promise<void> {
	if (isDryRun) {
		console.log("DRY RUN bun run gen:stats");
		console.log("DRY RUN bun --cwd=packages/collab-web run gen:tool-views");
		return;
	}
	await runCommand(["bun", "run", "gen:stats"], repoRoot);
	await runCommand(["bun", "--cwd=packages/collab-web", "run", "gen:tool-views"], repoRoot);
}

async function resetArtifacts(): Promise<void> {
	if (isDryRun) {
		console.log("DRY RUN bun run gen:native:reset");
		console.log("DRY RUN bun run gen:stats:reset");
		return;
	}
	await runCommand(["bun", "run", "gen:native:reset"], repoRoot);
	await runCommand(["bun", "run", "gen:stats:reset"], repoRoot);
}

async function main(): Promise<void> {
	const requestedTargets = parseRequestedTargets();
	const selectedTargets = requestedTargets ? targets.filter(target => requestedTargets.has(target.id)) : targets;

	if (requestedTargets) {
		const unknownTargets = [...requestedTargets].filter(
			requestedTarget => !targets.some(target => target.id === requestedTarget),
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
