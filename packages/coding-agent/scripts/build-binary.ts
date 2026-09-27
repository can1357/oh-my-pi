#!/usr/bin/env bun

import * as fs from "node:fs/promises";
import { createRequire } from "node:module";
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
export function resolveCrossBuild(value: string | undefined): CrossBuild | null {
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

// Transformers.js is an optional, native-heavy dependency that is never bundled
// into the binary; the tiny-model worker `bun install`s it into a runtime cache
// on first use. The `catalog:` spec cannot be resolved from inside the compiled
// bunfs (issue #1763), so embed the concrete installed version here for the
// worker to pin its runtime install against.
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

async function runCommand(
	command: string[],
	env: NodeJS.ProcessEnv = Bun.env,
	cwd: string = packageDir,
): Promise<void> {
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
	const crossBuild = resolveCrossBuild(Bun.env.CROSS_TARGET);
	const isAndroidBuild = process.platform === "android" && !crossBuild;
	const shouldAdhocSign =
		process.platform === "darwin" &&
		(!crossBuild || crossBuild.platform === "darwin") &&
		Bun.env.BUN_NO_CODESIGN_MACHO_BINARY !== "1";
	const outName = crossBuild ? `omp-${crossBuild.id}` : "omp";
	const outputDir = isAndroidBuild ? path.join(packageDir, "dist", "android") : path.join(packageDir, "dist");
	const outputPath = path.join(outputDir, outName);
	// Generate inside the try so the finally always restores the empty checked-in
	// placeholders (stats client archive, docs index) even on failure.
	try {
		await runCommand(["bun", "--cwd=../stats", "run", "gen:stats"]);
		// The in-memory legacy Pi virtual module reaches the coding-agent
		// `export/html` subpath, whose source imports `tool-views.generated.js`.
		// Rebuild it before compilation so clean checkouts that skipped install
		// hooks still contain that generated bundle.
		await runCommand(["bun", "--cwd=../collab-web", "run", "gen:tool-views"]);
		await runCommand(
			["bun", "--cwd=../natives", "run", "gen:native"],
			crossBuild ? { ...Bun.env, TARGET_PLATFORM: crossBuild.platform, TARGET_ARCH: crossBuild.arch } : Bun.env,
		);
		try {
			if (isAndroidBuild) {
				await buildAndroidLauncher(outputPath);
			} else {
				await compileCodingAgent({
					repoRoot,
					entrypoint: path.join(packageDir, "src", "cli.ts"),
					outfile: outputPath,
					transformersVersion,
					target: crossBuild?.target,
					executablePath: Bun.env.BUN_COMPILE_EXECUTABLE_PATH || undefined,
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
			}
		} finally {
			await runCommand(["bun", "--cwd=../natives", "run", "gen:native:reset"]);
		}
	} finally {
		await runCommand(["bun", "--cwd=../stats", "run", "gen:stats:reset"]);
	}
}

if (import.meta.main) await main();
