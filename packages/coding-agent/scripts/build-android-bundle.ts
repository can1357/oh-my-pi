#!/usr/bin/env bun

import * as fs from "node:fs/promises";
import * as path from "node:path";

const packageDir = path.join(import.meta.dir, "..");

async function runCommand(command: string[], env: Record<string, string | undefined> = Bun.env): Promise<void> {
	const proc = Bun.spawn(command, {
		cwd: packageDir,
		env,
		stdout: "inherit",
		stderr: "inherit",
	});
	const exitCode = await proc.exited;
	if (exitCode !== 0) {
		throw new Error(`Command failed with exit code ${exitCode}: ${command.join(" ")}`);
	}
}

async function buildAndroidBundle(): Promise<void> {
	if (process.platform !== "linux") {
		throw new Error("Android cross-build requires a Linux build host");
	}

	const artifactDir = path.join(packageDir, "dist", "android");
	const outputPath = path.join(artifactDir, "omp");

	await runCommand(["bun", "../../scripts/bazel-natives.ts", "android-arm64", "--dest", "../natives/native"], {
		...Bun.env,
		OMP_NATIVE_BUILD_BACKEND: "bazel",
	});
	await runCommand(["bun", "run", "gen:tool-views"]);

	await fs.rm(artifactDir, { recursive: true, force: true });
	await fs.mkdir(artifactDir, { recursive: true });
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

if (import.meta.main) await buildAndroidBundle();
