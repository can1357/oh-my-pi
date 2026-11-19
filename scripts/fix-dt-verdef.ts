/**
 * Repoint `DT_VERDEF` at the current `.gnu.version_d` address in a compiled ELF.
 *
 * `bun build --compile` output defines its own symbol versions
 * (`DT_VERDEFNUM 2`), so the dynamic loader reads `DT_VERDEF` at startup. When
 * `patchelf` has to grow `.dynamic` — setting an RPATH or adding a `DT_NEEDED`,
 * both of which omp's nix fixup chain does — it relocates the dynamic-section
 * cluster and rewrites `DT_SYMTAB`, `DT_STRTAB`, `DT_VERSYM` and `DT_VERNEED`,
 * but leaves `DT_VERDEF` holding the pre-relocation address. glibc follows the
 * stale pointer in `_dl_check_map_versions` and the binary SIGSEGVs in the
 * loader before `main()` runs (observed on aarch64-linux; see issue #9881).
 *
 * This restores the invariant after the fixup chain has finished patching, by
 * pointing `DT_VERDEF` back at the section-header address of `.gnu.version_d`.
 * ELF64 little-endian only — the only shape omp's Linux outputs take. Binaries
 * without a `.gnu.version_d` (ordinary Rust/C objects) are a no-op.
 */

import * as fs from "node:fs";

/** `d_tag` sentinel that terminates the `.dynamic` array. */
const DT_NULL = 0n;
/** `d_tag` for the `.gnu.version_d` (version-definition) table pointer. */
const DT_VERDEF = 0x6ffffffcn;
/** `sh_type` for `SHT_DYNAMIC`. */
const SHT_DYNAMIC = 6;
/** `sh_type` for `SHT_GNU_verdef` (`.gnu.version_d`). */
const SHT_GNU_VERDEF = 0x6ffffffd;

/** Location and extent of the `.dynamic` section within the file. */
interface DynamicSection {
	offset: number;
	size: number;
}

/**
 * Rewrite one file's `DT_VERDEF` in place so it matches `.gnu.version_d`.
 *
 * @throws if the file is not ELF64 little-endian, lacks `SHT_DYNAMIC`, or
 * carries a `.gnu.version_d` with no corresponding `DT_VERDEF` entry — all of
 * which indicate a malformed target rather than a benign skip.
 */
function repair(path: string): void {
	const fd = fs.openSync(path, "r+");
	try {
		const header = Buffer.alloc(64);
		fs.readSync(fd, header, 0, 64, 0);
		if (header.toString("latin1", 0, 4) !== "\x7fELF") throw new Error(`${path}: not an ELF file`);
		if (header[4] !== 2 || header[5] !== 1) throw new Error(`${path}: not ELF64 little-endian`);

		const shoff = Number(header.readBigUInt64LE(40));
		const shentsize = header.readUInt16LE(58);
		const shnum = header.readUInt16LE(60);

		const sections = Buffer.alloc(shentsize * shnum);
		fs.readSync(fd, sections, 0, sections.length, shoff);

		let verdefAddr: bigint | null = null;
		let dynamic: DynamicSection | null = null;
		for (let index = 0; index < shnum; index += 1) {
			const base = index * shentsize;
			const type = sections.readUInt32LE(base + 4);
			if (type === SHT_GNU_VERDEF) verdefAddr = sections.readBigUInt64LE(base + 16);
			else if (type === SHT_DYNAMIC) {
				dynamic = {
					offset: Number(sections.readBigUInt64LE(base + 24)),
					size: Number(sections.readBigUInt64LE(base + 32)),
				};
			}
		}

		if (verdefAddr === null) {
			console.log(`fix-dt-verdef: ${path}: no .gnu.version_d, nothing to do`);
			return;
		}
		if (dynamic === null) throw new Error(`${path}: no SHT_DYNAMIC section`);

		const dyn = Buffer.alloc(dynamic.size);
		fs.readSync(fd, dyn, 0, dyn.length, dynamic.offset);
		for (let cursor = 0; cursor + 16 <= dyn.length; cursor += 16) {
			const tag = dyn.readBigUInt64LE(cursor);
			if (tag === DT_NULL) break;
			if (tag !== DT_VERDEF) continue;

			const current = dyn.readBigUInt64LE(cursor + 8);
			if (current === verdefAddr) {
				console.log(`fix-dt-verdef: ${path}: DT_VERDEF already 0x${verdefAddr.toString(16)}`);
				return;
			}
			const value = Buffer.alloc(8);
			value.writeBigUInt64LE(verdefAddr);
			fs.writeSync(fd, value, 0, 8, dynamic.offset + cursor + 8);
			console.log(`fix-dt-verdef: ${path}: DT_VERDEF 0x${current.toString(16)} -> 0x${verdefAddr.toString(16)}`);
			return;
		}

		throw new Error(`${path}: .gnu.version_d present but no DT_VERDEF entry`);
	} finally {
		fs.closeSync(fd);
	}
}

const targets = process.argv.slice(2);
if (targets.length === 0) {
	console.error("usage: fix-dt-verdef.ts <elf>...");
	process.exit(2);
}
for (const target of targets) repair(target);
