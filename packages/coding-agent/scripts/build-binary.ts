#!/usr/bin/env bun

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { compileCodingAgent } from "./compile-binary";

const packageDir = path.join(import.meta.dir, "..");
const repoRoot = path.join(packageDir, "..", "..");

/** Binary cross-compilation settings selected by `CROSS_TARGET`. */
export interface CrossBuild {
	readonly id: string;
	readonly platform: string;
	readonly arch: string;
	readonly target: Bun.Build.CompileTarget;
}

/** Resolves a CROSS_TARGET value to the Bun compile target used by local binary builds. */
function resolveCrossBuild(value: string | undefined): CrossBuild | null {
	switch (value) {
		case undefined:
		case "":
			return null;
		case "darwin-arm64":
			return { id: value, platform: "darwin", arch: "arm64", target: "bun-darwin-arm64" };
		case "darwin-x64":
			return { id: value, platform: "darwin", arch: "x64", target: "bun-darwin-x64" };
		case "linux-arm64":
			return { id: value, platform: "linux", arch: "arm64", target: "bun-linux-arm64" };
		case "linux-x64":
			return { id: value, platform: "linux", arch: "x64", target: "bun-linux-x64-baseline" };
		case "win32-x64":
		case "windows-x64":
			return { id: value, platform: "win32", arch: "x64", target: "bun-windows-x64-baseline" };
		case "win32-arm64":
		case "windows-arm64":
			return { id: value, platform: "win32", arch: "arm64", target: "bun-windows-arm64" };
		default:
			throw new Error(`Unsupported CROSS_TARGET: ${value}`);
	}
}

async function runCommand(command: string[], env?: Record<string, string | undefined>): Promise<void> {
	const proc = Bun.spawn(command, {
		cwd: packageDir,
		env: env ?? Bun.env,
		stdout: "inherit",
		stderr: "inherit",
	});
	const exitCode = await proc.exited;
	if (exitCode !== 0) {
		throw new Error(`Command failed with exit code ${exitCode}: ${command.join(" ")}`);
	}
}

async function buildAndroidLauncher(outputPath: string): Promise<void> {
	const artifactDir = path.dirname(outputPath);
	await fs.rm(artifactDir, { recursive: true, force: true });
	await fs.mkdir(artifactDir, { recursive: true });

	// Android Bun cannot run the compiled executable, so produce a relocatable
	// bundle directory instead. The bundle script emits every generated runtime
	// asset (native archive, dashboard, export templates, and changelog) into
	// this directory; the launcher and its preload are the only files copied
	// from the canonical source launcher.
	await runCommand(["bun", "run", "gen:bundle"], {
		...Bun.env,
		OMP_ANDROID_BUNDLE: "1",
		OMP_BUNDLE_OUTDIR: artifactDir,
	});

	const canonicalLauncherPath = path.join(packageDir, "scripts", "omp");
	const canonicalPreloadPath = path.join(packageDir, "scripts", "omp.ts");
	const canonicalLauncher = await Bun.file(canonicalLauncherPath).text();
	const launcher = canonicalLauncher.replace(/^#![^\n]*\n/, "#!/data/data/com.termux/files/usr/bin/sh\n");
	if (launcher === canonicalLauncher) {
		throw new Error(`Canonical launcher has no shebang: ${canonicalLauncherPath}`);
	}
	await Bun.write(outputPath, launcher);
	await fs.copyFile(canonicalPreloadPath, path.join(artifactDir, "omp.ts"));
	await fs.chmod(outputPath, 0o755);
}

async function main(): Promise<void> {
	const crossTarget = Bun.env.CROSS_TARGET;
	// Android is a relocatable bundle, not a Bun compile target.
	const isAndroidCrossBuild = crossTarget === "android-arm64";
	const crossBuild = isAndroidCrossBuild ? null : resolveCrossBuild(crossTarget);
	const isAndroidBuild = isAndroidCrossBuild || (process.platform === "android" && !crossBuild);
	const shouldAdhocSign =
		!isAndroidBuild &&
		process.platform === "darwin" &&
		(!crossBuild || crossBuild.platform === "darwin") &&
		Bun.env.BUN_NO_CODESIGN_MACHO_BINARY !== "1";
	const outName = isAndroidBuild ? "omp" : crossBuild ? `omp-${crossBuild.id}` : "omp";
	const outputDir = isAndroidBuild ? path.join(packageDir, "dist", "android") : path.join(packageDir, "dist");
	const outputPath = path.join(outputDir, outName);
	// Generate inside the try so the finally always restores the empty checked-in
	// placeholders (stats client archive, docs index) even on failure.
	try {
		await runCommand(["bun", "--cwd=../stats", "run", "gen:stats"]);
		// Embed metadata for the same content-addressed viewer used by source exports.
		// Generate here too for clean checkouts that skipped install hooks.
		await runCommand(["bun", "--cwd=../collab-web", "run", "gen:export-viewer"]);
		if (isAndroidBuild) {
			if (isAndroidCrossBuild && process.platform !== "android") {
				// Explicit target builds use the canonical Bazel driver; only a
				// native Termux build uses the local Cargo/N-API host path.
				await runCommand(
					["bun", "../../scripts/bazel-natives.ts", "android-arm64", "--dest", "../natives/native"],
					{ ...Bun.env, OMP_NATIVE_BUILD_BACKEND: "bazel" },
				);
			} else {
				await runCommand(["bun", "--cwd=../natives", "run", "build"], {
					...Bun.env,
					OMP_NATIVE_BUILD_BACKEND: "cargo",
				});
			}
			await buildAndroidLauncher(outputPath);
		} else {
			await compileCodingAgent({
				repoRoot,
				entrypoint: path.join(packageDir, "src", "cli.ts"),
				outfile: outputPath,
				native: crossBuild ?? { platform: process.platform, arch: process.arch },
				target: crossBuild?.target,
				executablePath: Bun.env.BUN_COMPILE_EXECUTABLE_PATH || undefined,
				skipBuiltinCodesign: shouldAdhocSign,
			});
		}

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
