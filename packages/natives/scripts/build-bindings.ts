/**
 * Local napi build: regenerates the TypeScript bindings (native/index.d.ts)
 * and the runtime enum exports, then installs the host addon. This is the
 * default backend for the `host` target (`bun run build` →
 * scripts/bazel-natives.ts); release addons build through Bazel with explicit
 * //:natives-* targets. Host target only — no cross-compilation.
 *
 * `OMP_NATIVE_CARGO_PROFILE` selects the cargo profile (default `local`:
 * incremental, unstripped). Image builds set `ci` for a stripped addon.
 */

import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import { createRequire } from "node:module";
import * as path from "node:path";
import { $ } from "bun";
import { detectHostAvx2Support, resolveLocalHostAddon } from "../../../scripts/host-detect";
import { generateEnumExports } from "./gen-enums";

// pcre2-sys prefers a system libpcre2 when pkg-config finds one. Keep the
// static build so the local addon never retains host Homebrew paths.
process.env.PCRE2_SYS_STATIC ??= "1";

// Windows: cc-rs and rustc auto-locate cl.exe/link.exe through the VS
// registry, but the cmake crate (audiopus_sys' bundled opus) needs cmake —
// and its Ninja generator needs ninja — on PATH. VS Build Tools ships both
// without exposing them, so outside a vcvars prompt the build dies on
// "cmake not found". Resolve the VS install via vswhere and append its
// CMake/Ninja dirs, keeping any user-provided tools ahead.
if (process.platform === "win32" && (!Bun.which("cmake") || !Bun.which("ninja"))) {
	const vswhere = path.join(
		process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)",
		"Microsoft Visual Studio",
		"Installer",
		"vswhere.exe",
	);
	const probe = Bun.spawnSync(
		[
			vswhere,
			"-latest",
			"-products",
			"*",
			"-requires",
			"Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
			"-property",
			"installationPath",
		],
		{ stdout: "pipe", stderr: "pipe" },
	);
	const vsRoot = probe.exitCode === 0 ? probe.stdout.toString("utf-8").trim() : "";
	if (vsRoot) {
		const cmakeExt = path.join(vsRoot, "Common7", "IDE", "CommonExtensions", "Microsoft", "CMake");
		const extraDirs = [path.join(cmakeExt, "CMake", "bin"), path.join(cmakeExt, "Ninja")].filter(dir =>
			fsSync.existsSync(dir),
		);
		if (extraDirs.length > 0) {
			process.env.PATH = [process.env.PATH ?? "", ...extraDirs].filter(Boolean).join(path.delimiter);
		}
	}
}

const repoRoot = path.join(import.meta.dir, "../../..");
const rustDir = path.join(repoRoot, "crates/pi-natives");
const nativeDir = path.join(import.meta.dir, "../native");
const packageJsonPath = path.join(import.meta.dir, "../package.json");

const localAddon = resolveLocalHostAddon({
	platform: process.platform,
	arch: process.arch,
	avx2: detectHostAvx2Support(),
});
const effectiveVariant = localAddon.x64Variant;
const variantSuffix = effectiveVariant ? `-${effectiveVariant}` : "";

// Pin Rust target-cpu so x64 baseline/modern variants get a reproducible ISA floor
// instead of inheriting the host CPU when RUSTFLAGS is unset. Non-x64 builds keep
// the target's default CPU features: `-C target-cpu=native` would bake the build
// host's CPU features into the addon and trips ring 0.17's aarch64-apple
// const assertion (CAPS_STATIC == MIN_STATIC_FEATURES).
if (!Bun.env.RUSTFLAGS) {
	if (effectiveVariant === "modern") {
		Bun.env.RUSTFLAGS = "-C target-cpu=x86-64-v3";
	} else if (effectiveVariant === "baseline") {
		Bun.env.RUSTFLAGS = "-C target-cpu=x86-64-v2";
	}
}

async function cleanupStaleTemps(dir: string): Promise<void> {
	try {
		const entries = await fs.readdir(dir);
		for (const entry of entries) {
			if (entry.includes(".tmp.") || entry.includes(".old.") || entry.includes(".new.")) {
				await fs.unlink(path.join(dir, entry)).catch(() => {});
			}
		}
	} catch {
		// Directory might not exist yet
	}
}

async function installBinary(src: string, dest: string): Promise<void> {
	const tempPath = `${dest}.tmp.${process.pid}`;

	await fs.copyFile(src, tempPath);

	try {
		// Atomic rename - works even if dest is loaded on Linux/macOS (old inode stays valid)
		await fs.rename(tempPath, dest);
	} catch {
		// On Windows, loaded DLLs cannot be overwritten via rename
		// Try delete-then-rename as fallback
		try {
			await fs.unlink(dest);
		} catch (unlinkErr) {
			if ((unlinkErr as NodeJS.ErrnoException).code !== "ENOENT") {
				await fs.unlink(tempPath).catch(() => {});
				const isWindows = process.platform === "win32";
				throw new Error(
					`Cannot replace ${path.basename(dest)}${isWindows ? " (file may be in use - close any running processes)" : ""}: ${(unlinkErr as Error).message}`,
				);
			}
		}
		try {
			await fs.rename(tempPath, dest);
		} catch (finalErr) {
			await fs.unlink(tempPath).catch(() => {});
			throw new Error(`Failed to install ${path.basename(dest)}: ${(finalErr as Error).message}`);
		}
	}
}

async function resolveBuiltAddonPath(outputDir: string, canonicalFilename: string): Promise<string> {
	// napi-rs 3.x emits `${binaryName}.${platformArchABI}.node` where
	// platformArchABI is e.g. `darwin-x64`, `linux-x64-gnu`, `win32-x64-msvc`,
	// `darwin-arm64`. Build into an isolated output dir so only this invocation's
	// outputs are considered fresh candidates.
	const entries = await fs.readdir(outputDir);

	if (entries.includes(canonicalFilename)) {
		return path.join(outputDir, canonicalFilename);
	}

	const generatedCandidates = entries.filter(
		entry => entry.startsWith(`pi_natives.${process.platform}-${process.arch}`) && entry.endsWith(".node"),
	);

	if (generatedCandidates.length === 1) {
		return path.join(outputDir, generatedCandidates[0]);
	}

	if (generatedCandidates.length === 0) {
		throw new Error(
			`napi build succeeded but did not emit a native addon for ${process.platform}-${process.arch}. Expected ${canonicalFilename} or an environment-tagged variant in ${outputDir}. Directory contents: ${entries.join(", ") || "(empty)"}.`,
		);
	}

	const formattedCandidates = generatedCandidates.map(candidate => `  - ${candidate}`).join("\n");
	throw new Error(
		`napi build emitted multiple unrecognized native addons for ${process.platform}-${process.arch}:\n${formattedCandidates}`,
	);
}

async function installGeneratedBindings(outputDir: string): Promise<void> {
	const sourcePath = path.join(outputDir, "index.d.ts");
	const destPath = path.join(nativeDir, "index.d.ts");
	try {
		await fs.copyFile(sourcePath, destPath);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Failed to install generated index.d.ts: ${message}`);
	}
}

const canonicalAddonFilename = localAddon.filename;
const canonicalAddonPath = path.join(nativeDir, canonicalAddonFilename);

console.log(`Building pi-natives bindings for ${process.platform}-${process.arch}${variantSuffix} (local)…`);

await fs.mkdir(nativeDir, { recursive: true });
await cleanupStaleTemps(nativeDir);
await fs.mkdir(path.join(nativeDir, ".build"), { recursive: true });
const buildOutputDir = await fs.mkdtemp(
	path.join(nativeDir, ".build", `${process.platform}-${process.arch}-${effectiveVariant ?? "default"}-local-`),
);

// Resolve the CLI's JS entry from the package manifest rather than the
// `node_modules/.bin` shim: `bunx @napi-rs/cli` can pick up the wrong bin on
// systems where `cli` exists on PATH (e.g. Mono's /usr/bin/cli on Ubuntu), and
// on Windows the shim is a `napi.exe` launcher that Bun would try to parse as
// JavaScript.
const require_ = createRequire(import.meta.url);
const napiManifestPath = require_.resolve("@napi-rs/cli/package.json");
const napiManifest: unknown = require_(napiManifestPath);
const napiBinEntry =
	typeof napiManifest === "object" &&
	napiManifest !== null &&
	"bin" in napiManifest &&
	typeof napiManifest.bin === "object" &&
	napiManifest.bin !== null &&
	"napi" in napiManifest.bin &&
	typeof napiManifest.bin.napi === "string"
		? napiManifest.bin.napi
		: null;
if (!napiBinEntry) {
	throw new Error(`@napi-rs/cli manifest at ${napiManifestPath} declares no string \`bin.napi\` entry`);
}
const napiBin = path.join(path.dirname(napiManifestPath), napiBinEntry);

// Profiles live in the root Cargo.toml; `local` trades size for iteration
// speed, `ci` strips and drops incremental state.
const cargoProfile = Bun.env.OMP_NATIVE_CARGO_PROFILE?.trim() || "local";

const napiArgs = [
	"build",
	"--manifest-path",
	path.join(rustDir, "Cargo.toml"),
	"--package-json-path",
	packageJsonPath,
	"--platform",
	"--no-js",
	"--dts",
	"index.d.ts",
	"-o",
	buildOutputDir,
	"--profile",
	cargoProfile,
];

// napi-rs / cargo route much failure detail to stdout (e.g. `cargo metadata`
// errors), so a stderr-only error collapses real failures to a bare message.
const BUILD_LOG_TAIL_LINES = 40;

/** Tail-cap captured build output into a labeled section for the failure report. */
function tailSection(label: string, text: string): string {
	const trimmed = text.trimEnd();
	if (!trimmed) return "";
	const lines = trimmed.split("\n");
	const capped = lines.length > BUILD_LOG_TAIL_LINES;
	const shown = capped ? lines.slice(-BUILD_LOG_TAIL_LINES) : lines;
	return `\n--- ${label}${capped ? ` (last ${BUILD_LOG_TAIL_LINES} lines)` : ""} ---\n${shown.join("\n")}`;
}

try {
	// The package declares Bun as its build runtime. Invoke napi's JavaScript
	// entry through this Bun process instead of its `#!/usr/bin/env node` shim so
	// an old host Node installation cannot make an otherwise supported Bun build fail.
	const buildResult = await $`${process.execPath} ${napiBin} ${napiArgs}`.nothrow();
	if (buildResult.exitCode !== 0) {
		const stdout = buildResult.stdout?.toString("utf-8") ?? "";
		const stderr = buildResult.stderr?.toString("utf-8") ?? "";
		const detail = `${tailSection("stdout", stdout)}${tailSection("stderr", stderr)}`;
		throw new Error(`napi build failed (exit ${buildResult.exitCode})${detail}`);
	}

	const builtAddonPath = await resolveBuiltAddonPath(buildOutputDir, canonicalAddonFilename);
	if (builtAddonPath !== canonicalAddonPath) {
		console.log(`Normalizing native addon filename: ${path.basename(builtAddonPath)} → ${canonicalAddonFilename}`);
		await installBinary(builtAddonPath, canonicalAddonPath);
	}

	await installGeneratedBindings(buildOutputDir);

	await generateEnumExports();

	console.log("Bindings build complete.");
} finally {
	await fs.rm(buildOutputDir, { recursive: true, force: true });
}
