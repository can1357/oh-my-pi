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
 * Patching a signed Mach-O invalidates the page hashes of its ad-hoc code
 * signature, which arm64 macOS refuses to load, so the stamp refreshes them in
 * place ({@link refreshAdhocSignature}) on every host: darwin addons
 * cross-compiled on Linux are stamped there too.
 *
 * Usage: bun scripts/stamp-native-version.ts <addon.node>... [--version <v>] [--no-sign]
 * (default version: packages/natives/package.json#version; `--no-sign` leaves
 * Mach-O re-signing to the caller, e.g. Nix's `signIfRequired`).
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { VERSION_STAMP_MAGIC, VERSION_STAMP_SIZE } from "../packages/natives/native/version-sentinel.js";

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
function isMachO(bytes: Uint8Array): boolean {
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

const MH_MAGIC_64 = 0xfeedfacf;
const LC_CODE_SIGNATURE = 0x1d;
const CSMAGIC_EMBEDDED_SIGNATURE = 0xfade0cc0;
const CSMAGIC_CODEDIRECTORY = 0xfade0c02;
const CS_ADHOC = 0x2;
/** CodeDirectory hashType → digest algorithm and stored hash length. */
const CD_HASHES: Record<number, { algorithm: "sha1" | "sha256"; size: number }> = {
	1: { algorithm: "sha1", size: 20 },
	2: { algorithm: "sha256", size: 32 },
	3: { algorithm: "sha256", size: 20 }, // SHA-256 truncated to 20 bytes
};

/**
 * Recompute the code page hashes of a thin 64-bit Mach-O's embedded ad-hoc
 * signature in place, so it stays valid after the image was patched. Returns
 * false for an unsigned image (nothing to refresh).
 *
 * Only page hashes change: an ad-hoc signature (the linker's, or `codesign -s
 * -`'s) pins nothing else to the file's bytes, while special slots hash
 * signature blobs this leaves alone. Throws for fat or 32-bit images, and for
 * a signature by an identity, whose CMS signature over the code directory
 * would no longer verify — those must be re-signed with the identity.
 */
function refreshAdhocSignature(bytes: Uint8Array): boolean {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (view.getUint32(0, true) !== MH_MAGIC_64) {
		throw new Error("native version stamp: only thin 64-bit Mach-O images can be re-signed in place");
	}
	const ncmds = view.getUint32(16, true);
	let cursor = 32; // sizeof(mach_header_64)
	let signature: { offset: number; size: number } | undefined;
	for (let i = 0; i < ncmds; i++) {
		const cmd = view.getUint32(cursor, true);
		if (cmd === LC_CODE_SIGNATURE) {
			signature = { offset: view.getUint32(cursor + 8, true), size: view.getUint32(cursor + 12, true) };
		}
		cursor += view.getUint32(cursor + 4, true);
	}
	if (!signature) return false;
	if (view.getUint32(signature.offset, false) !== CSMAGIC_EMBEDDED_SIGNATURE) {
		throw new Error("native version stamp: LC_CODE_SIGNATURE does not point at an embedded signature");
	}
	const count = view.getUint32(signature.offset + 8, false);
	let refreshed = false;
	for (let i = 0; i < count; i++) {
		const cd = signature.offset + view.getUint32(signature.offset + 16 + i * 8, false);
		if (view.getUint32(cd, false) !== CSMAGIC_CODEDIRECTORY) continue;
		if ((view.getUint32(cd + 12, false) & CS_ADHOC) === 0) {
			throw new Error(
				"native version stamp: the image is signed by an identity; re-sign it with that identity instead",
			);
		}
		const hashOffset = view.getUint32(cd + 16, false);
		const nCodeSlots = view.getUint32(cd + 28, false);
		const codeLimit = view.getUint32(cd + 32, false);
		const hash = CD_HASHES[view.getUint8(cd + 37)];
		if (!hash || view.getUint8(cd + 36) !== hash.size) {
			throw new Error(`native version stamp: unsupported code directory hash type ${view.getUint8(cd + 37)}`);
		}
		const pageSize = 2 ** view.getUint8(cd + 39);
		for (let page = 0; page < nCodeSlots; page++) {
			const start = page * pageSize;
			const digest = Bun.CryptoHasher.hash(
				hash.algorithm,
				bytes.subarray(start, Math.min(start + pageSize, codeLimit)),
			).subarray(0, hash.size);
			const slot = cd + hashOffset + page * hash.size;
			if (!digest.equals(bytes.subarray(slot, slot + hash.size))) {
				bytes.set(digest, slot);
				refreshed = true;
			}
		}
	}
	return refreshed;
}

/** Whether `bytes` carries the post-link version stamp slot (addons built before it do not). */
export function hasVersionStampSlot(bytes: Uint8Array): boolean {
	return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).indexOf(magicBytes) !== -1;
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
 * A signed Mach-O gets its ad-hoc signature refreshed in the same write
 * ({@link refreshAdhocSignature}); `sign: false` skips that for callers that
 * sign the result themselves (the Nix build signs through its own hook).
 */
export async function stampNativeVersion(
	filePath: string,
	version: string,
	{ sign = true }: { sign?: boolean } = {},
): Promise<void> {
	const bytes = await fs.readFile(filePath);
	if (!stampNativeBytes(bytes, version)) return;
	if (sign && isMachO(bytes)) refreshAdhocSignature(bytes);
	const stat = await fs.stat(filePath);
	const tempPath = `${filePath}.stamp.${process.pid}`;
	try {
		await fs.writeFile(tempPath, bytes, { mode: stat.mode & 0o777 });
		await fs.rename(tempPath, filePath);
	} catch (err) {
		await fs.unlink(tempPath).catch(() => {});
		throw err;
	}
}

if (import.meta.main) {
	const argv = process.argv.slice(2);
	let version: string | undefined;
	let sign = true;
	const files: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--version") version = argv[++i];
		else if (argv[i] === "--no-sign") sign = false;
		else files.push(argv[i]);
	}
	try {
		if (files.length === 0)
			throw new Error("Usage: bun scripts/stamp-native-version.ts <addon.node>... [--version <v>] [--no-sign]");
		const resolved = version ?? (await nativesPackageVersion());
		for (const file of files) {
			await stampNativeVersion(file, resolved, { sign });
			console.log(`stamped ${file} with ${resolved}`);
		}
	} catch (err) {
		console.error(err instanceof Error ? err.message : String(err));
		process.exit(1);
	}
}
