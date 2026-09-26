#!/usr/bin/env bun
/**
 * Post-link release stamp for pi_natives addons.
 *
 * `crates/pi-natives/src/lib.rs` links a fixed-size placeholder
 * (`PI_NATIVES_VERSION_STAMP:` + NUL padding, {@link VERSION_STAMP_SIZE} bytes)
 * that `__piNativesBuildVersion()` reads at runtime. This tool writes
 * `package.json#version` into that slot after the build, so a version bump
 * never edits a Rust input and never forces the addon crate to recompile.
 *
 * Usage: bun scripts/stamp-native-version.ts <addon.node>... [--version <v>]
 * (default version: packages/natives/package.json#version).
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { VERSION_STAMP_MAGIC, VERSION_STAMP_SIZE } from "../packages/natives/native/version-sentinel.js";

export { VERSION_STAMP_MAGIC, VERSION_STAMP_SIZE };

const repoRoot = path.join(import.meta.dir, "..");
const magicBytes = Buffer.from(VERSION_STAMP_MAGIC, "latin1");
/** Longest version that fits while keeping at least one NUL terminator. */
export const MAX_STAMP_VERSION_LENGTH = VERSION_STAMP_SIZE - magicBytes.length - 1;

/** `packages/natives/package.json#version` — the version every addon install stamps. */
export async function nativesPackageVersion(): Promise<string> {
	const pkg = (await Bun.file(path.join(repoRoot, "packages/natives/package.json")).json()) as { version?: unknown };
	if (typeof pkg.version !== "string" || pkg.version.length === 0) {
		throw new Error("packages/natives/package.json has no string version");
	}
	return pkg.version;
}

/** True for thin or fat Mach-O images (either byte order). */
export function isMachO(bytes: Uint8Array): boolean {
	if (bytes.length < 4) return false;
	const magic = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, false);
	return (
		magic === 0xfeedface ||
		magic === 0xfeedfacf ||
		magic === 0xcefaedfe ||
		magic === 0xcffaedfe ||
		magic === 0xcafebabe ||
		magic === 0xbebafeca
	);
}

/**
 * Write `version` into the addon's stamp slot in place. Returns false when the
 * slot already holds exactly `version` (bytes untouched), true when it changed.
 * Throws when the magic occurs zero or several times, or `version` cannot fit.
 */
export function stampNativeBytes(bytes: Buffer, version: string): boolean {
	const encoded = Buffer.from(version, "utf8");
	if (encoded.length === 0) throw new Error("native version stamp: version is empty");
	if (encoded.length > MAX_STAMP_VERSION_LENGTH) {
		throw new Error(
			`native version stamp: "${version}" is ${encoded.length} bytes; the slot fits at most ${MAX_STAMP_VERSION_LENGTH}`,
		);
	}
	if (encoded.includes(0)) throw new Error("native version stamp: version contains a NUL byte");
	const first = bytes.indexOf(magicBytes);
	if (first === -1) {
		throw new Error(
			`native version stamp: magic \`${VERSION_STAMP_MAGIC}\` not found — addon predates the stamp slot or was built from another crate`,
		);
	}
	if (bytes.indexOf(magicBytes, first + 1) !== -1) {
		throw new Error(
			`native version stamp: magic \`${VERSION_STAMP_MAGIC}\` occurs more than once; refusing to guess`,
		);
	}
	const payloadStart = first + magicBytes.length;
	const payloadEnd = first + VERSION_STAMP_SIZE;
	if (payloadEnd > bytes.length) throw new Error("native version stamp: stamp slot is truncated");
	const desired = Buffer.alloc(payloadEnd - payloadStart);
	encoded.copy(desired);
	if (bytes.subarray(payloadStart, payloadEnd).equals(desired)) return false;
	desired.copy(bytes, payloadStart);
	return true;
}

/**
 * Stamp the addon at `filePath` with `version`, replacing the file atomically.
 *
 * Patching a Mach-O invalidates the linker's ad-hoc code signature, which
 * arm64 macOS refuses to dlopen, so darwin hosts re-sign ad hoc. A non-darwin
 * host cannot re-sign, so it refuses to change a Mach-O (an already-matching
 * stamp is a no-op and passes).
 */
export async function stampNativeVersion(filePath: string, version: string): Promise<void> {
	const bytes = await fs.readFile(filePath);
	const machO = isMachO(bytes);
	if (!stampNativeBytes(bytes, version)) return;
	if (machO && process.platform !== "darwin") {
		throw new Error(
			`native version stamp: ${filePath} is a Mach-O image; stamping it requires re-signing, which only a darwin host can do. ` +
				"Stamp darwin addons on a macOS runner.",
		);
	}
	const stat = await fs.stat(filePath);
	const tempPath = `${filePath}.stamp.${process.pid}`;
	try {
		await fs.writeFile(tempPath, bytes, { mode: stat.mode & 0o777 });
		if (machO) {
			const sign = Bun.spawnSync(["codesign", "-s", "-", "-f", tempPath], { stdout: "pipe", stderr: "pipe" });
			if (sign.exitCode !== 0) {
				throw new Error(
					`codesign -s - -f ${tempPath} failed (exit ${sign.exitCode}): ${sign.stderr.toString().trim()}`,
				);
			}
		}
		await fs.rename(tempPath, filePath);
	} catch (err) {
		await fs.unlink(tempPath).catch(() => {});
		throw err;
	}
}

if (import.meta.main) {
	const argv = process.argv.slice(2);
	let version: string | undefined;
	const files: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--version") version = argv[++i];
		else files.push(argv[i]);
	}
	try {
		if (files.length === 0)
			throw new Error("Usage: bun scripts/stamp-native-version.ts <addon.node>... [--version <v>]");
		const resolved = version ?? (await nativesPackageVersion());
		for (const file of files) {
			await stampNativeVersion(file, resolved);
			console.log(`stamped ${file} with ${resolved}`);
		}
	} catch (err) {
		console.error(err instanceof Error ? err.message : String(err));
		process.exit(1);
	}
}
