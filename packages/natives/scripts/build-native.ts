import * as fs from "node:fs/promises";
import * as path from "node:path";
import { $ } from "bun";
import { detectHostAvx2Support } from "../../../scripts/host-detect";
import { generateEnumExports } from "./gen-enums";

const repoRoot = path.join(import.meta.dir, "../../..");
const rustDir = path.join(repoRoot, "crates/pi-natives");
const nativeDir = path.join(import.meta.dir, "../native");
const packageJsonPath = path.join(import.meta.dir, "../package.json");

const crossTarget = Bun.env.CROSS_TARGET;
const targetPlatform = Bun.env.TARGET_PLATFORM || process.platform;
const targetArch = Bun.env.TARGET_ARCH || process.arch;
const configuredVariantRaw = Bun.env.TARGET_VARIANT;
const isCrossCompile = Boolean(crossTarget) || targetPlatform !== process.platform || targetArch !== process.arch;

type X64Variant = "modern" | "baseline";

let configuredVariant: X64Variant | undefined;
if (configuredVariantRaw) {
	if (targetArch !== "x64") {
		throw new Error(`TARGET_VARIANT is only supported for x64 builds, got ${targetPlatform}-${targetArch}.`);
	}
	if (configuredVariantRaw !== "modern" && configuredVariantRaw !== "baseline") {
		throw new Error(`Unsupported TARGET_VARIANT: ${configuredVariantRaw}. Expected "modern" or "baseline".`);
	}
	configuredVariant = configuredVariantRaw;
}

function resolveEffectiveVariant(): X64Variant | null {
	if (targetArch !== "x64") return null;
	if (configuredVariant) return configuredVariant;
	if (isCrossCompile) {
		throw new Error("x64 cross-builds require TARGET_VARIANT=modern or TARGET_VARIANT=baseline.");
	}
	return detectHostAvx2Support() ? "modern" : "baseline";
}
const effectiveVariant = resolveEffectiveVariant();
const variantSuffix = effectiveVariant ? `-${effectiveVariant}` : "";

// Pin Rust target-cpu so x64 baseline/modern variants get a reproducible ISA floor
// instead of inheriting the host CPU when RUSTFLAGS is unset.
if (!isCrossCompile && !Bun.env.RUSTFLAGS) {
	if (effectiveVariant === "modern") {
		Bun.env.RUSTFLAGS = "-C target-cpu=x86-64-v3";
	} else if (effectiveVariant === "baseline") {
		Bun.env.RUSTFLAGS = "-C target-cpu=x86-64-v2";
	} else {
		Bun.env.RUSTFLAGS = "-C target-cpu=native";
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

async function resolveCargoTargetDir(): Promise<string | null> {
	// Mirror napi's resolution order (CARGO_BUILD_TARGET_DIR, else `cargo
	// metadata`'s target_directory, which already honors CARGO_TARGET_DIR and
	// config files) so a symlink we create lands exactly where napi looks.
	const explicit = process.env.CARGO_BUILD_TARGET_DIR;
	if (explicit) return path.resolve(explicit);
	const meta = await $`cargo metadata --no-deps --format-version 1`.cwd(rustDir).quiet().nothrow();
	if (meta.exitCode !== 0) return null;
	try {
		const parsed = JSON.parse(meta.stdout.toString("utf-8")) as { target_directory?: string };
		return parsed.target_directory ?? null;
	} catch {
		return null;
	}
}

async function ensureZigbuildTargetDirLink(suffixedTriple: string, bareTriple: string): Promise<void> {
	// napi 3.7.0 reads the cdylib from `<targetDir>/<--target>/<profile>/`, using
	// the full `--target` string verbatim. cargo-zigbuild strips the `.<glibc>`
	// floor suffix before invoking cargo, so the cdylib actually lands under the
	// bare-triple directory. Point the suffixed directory napi expects at the
	// bare one or postBuild aborts with "Failed to copy artifact". No-op for
	// targets without a floor suffix (arch-only cross builds, MSVC).
	if (suffixedTriple === bareTriple) return;
	const targetDir = await resolveCargoTargetDir();
	if (!targetDir) {
		console.warn(`Could not resolve cargo target dir; skipping zigbuild target-dir link for ${suffixedTriple}.`);
		return;
	}
	const linkPath = path.join(targetDir, suffixedTriple);
	await fs.mkdir(targetDir, { recursive: true });
	let exists = false;
	let isSymlink = false;
	try {
		const stats = await fs.lstat(linkPath);
		exists = true;
		isSymlink = stats.isSymbolicLink();
	} catch {
		exists = false;
	}
	// Never clobber a real build directory; only replace a stale symlink.
	if (exists && !isSymlink) return;
	if (exists) await fs.unlink(linkPath);
	await fs.symlink(bareTriple, linkPath);
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

	const generatedCandidates = entries.filter(entry => {
		if (!entry.startsWith(`pi_natives.${targetPlatform}-${targetArch}`) || !entry.endsWith(".node")) {
			return false;
		}
		return true;
	});

	if (generatedCandidates.length === 1) {
		return path.join(outputDir, generatedCandidates[0]);
	}

	if (generatedCandidates.length === 0) {
		throw new Error(
			`napi build succeeded but did not emit a native addon for ${targetPlatform}-${targetArch}. Expected ${canonicalFilename} or an environment-tagged variant in ${outputDir}. Directory contents: ${entries.join(", ") || "(empty)"}.`,
		);
	}

	const formattedCandidates = generatedCandidates.map(candidate => `  - ${candidate}`).join("\n");
	throw new Error(
		`napi build emitted multiple unrecognized native addons for ${targetPlatform}-${targetArch}:\n${formattedCandidates}`,
	);
}

function resolveBuildOutputDirPrefix(profileLabel: string): string {
	const buildTarget = crossTarget ?? `${targetPlatform}-${targetArch}`;
	const variantLabel = effectiveVariant ?? "default";
	return path.join(nativeDir, ".build", `${buildTarget}-${variantLabel}-${profileLabel}-`);
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

async function isElfFile(filePath: string): Promise<boolean> {
	const handle = await fs.open(filePath, "r");
	try {
		const buffer = Buffer.alloc(4);
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
		return bytesRead === 4 && buffer[0] === 0x7f && buffer[1] === 0x45 && buffer[2] === 0x4c && buffer[3] === 0x46;
	} finally {
		await handle.close();
	}
}

function readElfUint(buffer: Buffer, offset: number, byteLength: 2 | 4 | 8, littleEndian: boolean): number {
	if (offset < 0 || offset + byteLength > buffer.length) {
		throw new Error("ELF section table is truncated.");
	}
	if (byteLength === 2) return littleEndian ? buffer.readUInt16LE(offset) : buffer.readUInt16BE(offset);
	if (byteLength === 4) return littleEndian ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset);
	const value = littleEndian ? buffer.readBigUInt64LE(offset) : buffer.readBigUInt64BE(offset);
	const numberValue = Number(value);
	if (!Number.isSafeInteger(numberValue)) {
		throw new Error(`ELF integer exceeds JavaScript's safe range: ${value}`);
	}
	return numberValue;
}

function readCString(buffer: Buffer, offset: number): string {
	if (offset < 0 || offset >= buffer.length) return "";
	let end = offset;
	while (end < buffer.length && buffer[end] !== 0) end++;
	return buffer.toString("utf8", offset, end);
}

function readElfSectionNames(buffer: Buffer): string[] {
	if (buffer.length < 0x40 || buffer[0] !== 0x7f || buffer[1] !== 0x45 || buffer[2] !== 0x4c || buffer[3] !== 0x46) {
		return [];
	}
	const elfClass = buffer[4];
	const endian = buffer[5];
	if (elfClass !== 1 && elfClass !== 2) throw new Error(`Unsupported ELF class: ${elfClass}`);
	if (endian !== 1 && endian !== 2) throw new Error(`Unsupported ELF endian marker: ${endian}`);

	const is64Bit = elfClass === 2;
	const littleEndian = endian === 1;
	const sectionHeaderOffset = is64Bit
		? readElfUint(buffer, 0x28, 8, littleEndian)
		: readElfUint(buffer, 0x20, 4, littleEndian);
	const sectionHeaderEntrySize = readElfUint(buffer, is64Bit ? 0x3a : 0x2e, 2, littleEndian);
	const sectionHeaderCount = readElfUint(buffer, is64Bit ? 0x3c : 0x30, 2, littleEndian);
	const sectionNameTableIndex = readElfUint(buffer, is64Bit ? 0x3e : 0x32, 2, littleEndian);
	if (sectionHeaderOffset === 0 || sectionHeaderCount === 0) return [];
	if (sectionNameTableIndex >= sectionHeaderCount) {
		throw new Error("ELF section name table index is out of bounds.");
	}

	const sectionHeadersEnd = sectionHeaderOffset + sectionHeaderEntrySize * sectionHeaderCount;
	if (sectionHeadersEnd > buffer.length) {
		throw new Error("ELF section headers extend past the end of the file.");
	}

	const sectionHeader = (index: number) => sectionHeaderOffset + sectionHeaderEntrySize * index;
	const sectionNameTableHeader = sectionHeader(sectionNameTableIndex);
	const nameTableOffset = readElfUint(
		buffer,
		sectionNameTableHeader + (is64Bit ? 0x18 : 0x10),
		is64Bit ? 8 : 4,
		littleEndian,
	);
	const nameTableSize = readElfUint(
		buffer,
		sectionNameTableHeader + (is64Bit ? 0x20 : 0x14),
		is64Bit ? 8 : 4,
		littleEndian,
	);
	if (nameTableOffset + nameTableSize > buffer.length) {
		throw new Error("ELF section name table extends past the end of the file.");
	}

	const names: string[] = [];
	const nameTable = buffer.subarray(nameTableOffset, nameTableOffset + nameTableSize);
	for (let index = 0; index < sectionHeaderCount; index++) {
		const nameOffset = readElfUint(buffer, sectionHeader(index), 4, littleEndian);
		names.push(readCString(nameTable, nameOffset));
	}
	return names;
}

const forbiddenStrippedElfSections = new Set([".symtab", ".strtab"]);

function getForbiddenElfSections(sectionNames: string[]): string[] {
	return sectionNames.filter(
		sectionName =>
			forbiddenStrippedElfSections.has(sectionName) ||
			sectionName.startsWith(".debug_") ||
			sectionName.startsWith(".zdebug_"),
	);
}

async function runStripTool(addonPath: string): Promise<void> {
	const toolSpecs = [
		{ command: "llvm-strip", args: ["--strip-unneeded"] },
		{ command: "strip", args: ["--strip-unneeded"] },
	];
	for (const tool of toolSpecs) {
		const executable = Bun.which(tool.command);
		if (!executable) continue;
		const proc = Bun.spawn([executable, ...tool.args, addonPath], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const exitCode = await proc.exited;
		if (exitCode === 0) return;
	}
}

async function stripAndVerifyNativeAddon(addonPath: string): Promise<void> {
	if (profileLabel !== "ci") return;
	if (!(await isElfFile(addonPath))) return;

	await runStripTool(addonPath);
	const sectionNames = readElfSectionNames(await fs.readFile(addonPath));
	const forbiddenSections = getForbiddenElfSections(sectionNames);
	if (forbiddenSections.length > 0) {
		throw new Error(
			`Native addon ${path.basename(addonPath)} still contains stripped-release forbidden ELF sections: ${forbiddenSections.join(", ")}`,
		);
	}
}

const isCI = Boolean(Bun.env.CI);
const useLocalProfile = !isCI && !isCrossCompile;
const profileLabel = useLocalProfile ? "local" : "ci";
const profileSuffix = ` (${profileLabel})`;

const buildOutputDirPrefix = resolveBuildOutputDirPrefix(profileLabel);

// Build napi args
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
	"",
	"--profile",
	profileLabel,
];

if (crossTarget) {
	napiArgs.push("--target", crossTarget);
	// Route through `cargo-zigbuild` (non-MSVC targets) or `cargo-xwin`
	// (MSVC targets). The napi CLI picks the right backend from the target.
	napiArgs.push("--cross-compile");
	// cargo-zigbuild encodes the glibc floor as a `.<major>.<minor>` suffix on
	// the triple (e.g. `x86_64-unknown-linux-gnu.2.17`) but strips it before
	// invoking cargo, so cargo's TARGET — and the artifact dir — use the bare
	// triple.
	const bareTriple = crossTarget.replace(/\.\d+(?:\.\d+)*$/, "");
	// `zig cc` enables `NDEBUG` at `-O3`, which trips tree-sitter-just's
	// scanner.c (`#error "expected assertions to be enabled"`). cc-rs reads
	// `CFLAGS_<target>` (dashes → underscores) keyed off cargo's bare TARGET, so
	// the override must use the bare triple or it is silently dropped.
	if (!crossTarget.endsWith("-msvc")) {
		const envKey = `CFLAGS_${bareTriple.replace(/-/g, "_")}`;
		const existing = process.env[envKey] ?? "";
		process.env[envKey] = existing ? `${existing} -UNDEBUG` : "-UNDEBUG";
	}
	// napi 3.7.0 resolves the built artifact from the FULL `--target` directory,
	// but cargo-zigbuild writes under the bare triple; bridge the two so napi's
	// postBuild copyArtifact succeeds for glibc-pinned targets.
	await ensureZigbuildTargetDirLink(crossTarget, bareTriple);
}

const canonicalAddonFilename = `pi_natives.${targetPlatform}-${targetArch}${variantSuffix}.node`;
const canonicalAddonPath = path.join(nativeDir, canonicalAddonFilename);

console.log(`Building pi-natives for ${targetPlatform}-${targetArch}${variantSuffix}${profileSuffix}…`);

await fs.mkdir(nativeDir, { recursive: true });
await cleanupStaleTemps(nativeDir);
await fs.mkdir(path.join(nativeDir, ".build"), { recursive: true });
const buildOutputDir = await fs.mkdtemp(buildOutputDirPrefix);
napiArgs[10] = buildOutputDir;

// Resolve napi bin directly: `bunx @napi-rs/cli` can pick up the wrong bin on
// systems where `cli` exists on PATH (e.g. Mono's /usr/bin/cli on Ubuntu).
const napiBin = Bun.which("napi", {
	PATH: [
		path.join(import.meta.dir, "..", "node_modules", ".bin"),
		path.join(repoRoot, "node_modules", ".bin"),
		process.env.PATH ?? "",
	].join(path.delimiter),
});
if (!napiBin) {
	throw new Error("Could not locate @napi-rs/cli `napi` binary in node_modules/.bin");
}

async function runNapiBuildWithSccacheFallback() {
	let buildResult = await $`${napiBin} ${napiArgs}`.nothrow();
	let stderr = buildResult.stderr?.toString("utf-8") ?? "";
	if (
		buildResult.exitCode !== 0 &&
		process.env.RUSTC_WRAPPER === "sccache" &&
		stderr.includes("sccache: error") &&
		stderr.includes("cache storage failed")
	) {
		const retryEnv = { ...process.env };
		delete retryEnv.RUSTC_WRAPPER;
		delete retryEnv.SCCACHE_BUCKET;
		delete retryEnv.SCCACHE_ENDPOINT;
		delete retryEnv.SCCACHE_REGION;
		delete retryEnv.AWS_ACCESS_KEY_ID;
		delete retryEnv.AWS_SECRET_ACCESS_KEY;
		console.log("sccache storage unavailable; retrying native build without RUSTC_WRAPPER");
		buildResult = await $`${napiBin} ${napiArgs}`.env(retryEnv).nothrow();
		stderr = buildResult.stderr?.toString("utf-8") ?? "";
	}
	return { buildResult, stderr };
}

try {
	const { buildResult, stderr } = await runNapiBuildWithSccacheFallback();
	if (buildResult.exitCode !== 0) {
		throw new Error(`napi build failed${stderr ? `:\n${stderr}` : ""}`);
	}

	const builtAddonPath = await resolveBuiltAddonPath(buildOutputDir, canonicalAddonFilename);
	await stripAndVerifyNativeAddon(builtAddonPath);
	if (builtAddonPath !== canonicalAddonPath) {
		console.log(`Normalizing native addon filename: ${path.basename(builtAddonPath)} → ${canonicalAddonFilename}`);
		await installBinary(builtAddonPath, canonicalAddonPath);
	}

	await installGeneratedBindings(buildOutputDir);

	await generateEnumExports();

	console.log("Build complete.");
} finally {
	await fs.rm(buildOutputDir, { recursive: true, force: true });
}
