import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, peekFile } from "@oh-my-pi/pi-utils";
import { shortenPath } from "@oh-my-pi/pi-tui/render/render-utils";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";

/** Number of leading bytes needed by {@link isExecutableHeader} (a full 64-byte DOS header for PE). */
export const EXECUTABLE_SNIFF_BYTES = 64;
/** Separator between a universal binary path and the slice to analyze (`<bin>:@<arch>`). */
export const SLICE_SEPARATOR = ":@";

/** Largest plausible `nfat_arch` for a fat Mach-O; Java class files (same magic) carry a version ≥ 45 there. */
const MAX_FAT_ARCHS = 30;
/** Size of the DOS header; `e_lfanew` (u32 LE at 0x3C) of a real DOS/PE image points at or past it. */
const DOS_HEADER_SIZE = 64;
const MAX_NAME_LENGTH = 64;
const LOCK_SUFFIX = ".lock";
/** `fat_header` (magic + nfat_arch). */
const FAT_HEADER_SIZE = 8;
const FAT_ARCH_SIZE = 20;
const FAT_ARCH_64_SIZE = 32;
/** Mask off capability bits (e.g. arm64e pointer-auth ABI) from `cpusubtype`. */
const CPU_SUBTYPE_MASK = 0x00ffffff;
const CPU_TYPE_X86 = 7;
const CPU_TYPE_X86_64 = 0x01000007;
const CPU_TYPE_ARM = 12;
const CPU_TYPE_ARM64 = 0x0100000c;
const CPU_TYPE_ARM64_32 = 0x0200000c;
const CPU_TYPE_PPC = 18;
const CPU_TYPE_PPC64 = 0x01000012;

/** lipo-compatible names per `cputype`: the family plus the subtypes lipo spells out. */
const CPU_NAMES = new Map<number, { family: string; subtypes: Record<number, string> }>([
	[CPU_TYPE_X86, { family: "i386", subtypes: { 3: "i386" } }],
	[CPU_TYPE_X86_64, { family: "x86_64", subtypes: { 3: "x86_64", 8: "x86_64h" } }],
	[CPU_TYPE_ARM, { family: "arm", subtypes: { 0: "arm", 6: "armv6", 9: "armv7", 11: "armv7s", 12: "armv7k" } }],
	[CPU_TYPE_ARM64, { family: "arm64", subtypes: { 0: "arm64", 1: "arm64v8", 2: "arm64e" } }],
	[CPU_TYPE_ARM64_32, { family: "arm64_32", subtypes: { 1: "arm64_32" } }],
	[CPU_TYPE_PPC, { family: "ppc", subtypes: { 0: "ppc" } }],
	[CPU_TYPE_PPC64, { family: "ppc64", subtypes: { 0: "ppc64" } }],
]);

/** `cputype` of the running process, used to pick the default slice of a universal binary. */
const HOST_CPU_TYPES: Partial<Record<NodeJS.Architecture, number>> = {
	arm64: CPU_TYPE_ARM64,
	x64: CPU_TYPE_X86_64,
	ia32: CPU_TYPE_X86,
	arm: CPU_TYPE_ARM,
	ppc64: CPU_TYPE_PPC64,
};

/**
 * True when `header` starts with an ELF, thin Mach-O, or fat Mach-O magic, or holds a full DOS header
 * (`MZ`, ≥ 64 bytes, `e_lfanew` ≥ 64) so blobs that merely start with "MZ" are rejected.
 */
export function isExecutableHeader(header: Uint8Array): boolean {
	if (header.length >= 2 && header[0] === 0x4d && header[1] === 0x5a) {
		if (header.length < DOS_HEADER_SIZE) return false;
		const eLfanew = (header[0x3c] | (header[0x3d] << 8) | (header[0x3e] << 16) | (header[0x3f] << 24)) >>> 0;
		return eLfanew >= DOS_HEADER_SIZE;
	}
	if (header.length < 4) return false;
	const b0 = header[0];
	const b1 = header[1];
	const b2 = header[2];
	const b3 = header[3];
	if (b0 === 0x7f && b1 === 0x45 && b2 === 0x4c && b3 === 0x46) return true;
	if (b0 === 0xfe && b1 === 0xed && b2 === 0xfa && (b3 === 0xce || b3 === 0xcf)) return true;
	if ((b0 === 0xce || b0 === 0xcf) && b1 === 0xfa && b2 === 0xed && b3 === 0xfe) return true;
	if (b0 === 0xca && b1 === 0xfe && b2 === 0xba && (b3 === 0xbe || b3 === 0xbf)) {
		if (header.length < 8) return false;
		const nfatArch = ((header[4] << 24) | (header[5] << 16) | (header[6] << 8) | header[7]) >>> 0;
		return nfatArch >= 1 && nfatArch <= MAX_FAT_ARCHS;
	}
	return false;
}

/** One architecture slice of a fat (universal) Mach-O. */
export interface MachOSlice {
	/** lipo-style name (`x86_64`, `arm64e`); subtypes lipo cannot name render as `<family>.<subtype>`. */
	arch: string;
	cpuType: number;
	/** Byte offset of the thin Mach-O inside the fat file. */
	offset: number;
	size: number;
}

/** The slice of a universal binary a database was built from, plus its siblings. */
export interface FatSelection {
	slice: MachOSlice;
	slices: MachOSlice[];
}

function sliceArchName(cpuType: number, cpuSubtype: number): string {
	const subtype = cpuSubtype & CPU_SUBTYPE_MASK;
	const names = CPU_NAMES.get(cpuType);
	if (!names) return `cpu${cpuType}.${subtype}`;
	return names.subtypes[subtype] ?? `${names.family}.${subtype}`;
}

/**
 * Parse the slice table of a fat Mach-O (`fat_arch` or `fat_arch_64`) from its leading bytes.
 * Returns null for anything that is not a fat Mach-O, including Java class files and headers
 * truncated before the end of the table.
 */
export function parseFatSlices(header: Uint8Array): MachOSlice[] | null {
	if (header.length < FAT_HEADER_SIZE) return null;
	const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
	const magic = view.getUint32(0);
	if (magic !== 0xcafebabe && magic !== 0xcafebabf) return null;
	const count = view.getUint32(4);
	if (count < 1 || count > MAX_FAT_ARCHS) return null;
	const is64 = magic === 0xcafebabf;
	const entrySize = is64 ? FAT_ARCH_64_SIZE : FAT_ARCH_SIZE;
	if (header.length < FAT_HEADER_SIZE + count * entrySize) return null;
	const slices: MachOSlice[] = [];
	for (let i = 0; i < count; i++) {
		const at = FAT_HEADER_SIZE + i * entrySize;
		const cpuType = view.getUint32(at);
		const offset = is64 ? Number(view.getBigUint64(at + 8)) : view.getUint32(at + 8);
		const size = is64 ? Number(view.getBigUint64(at + 16)) : view.getUint32(at + 12);
		slices.push({ arch: sliceArchName(cpuType, view.getUint32(at + 4)), cpuType, offset, size });
	}
	return slices;
}

/** Slice table of a fat Mach-O on disk; null when the file is not one. */
export async function readFatSlices(absPath: string): Promise<MachOSlice[] | null> {
	const header = await Bun.file(absPath)
		.slice(0, FAT_HEADER_SIZE + MAX_FAT_ARCHS * FAT_ARCH_64_SIZE)
		.bytes();
	return parseFatSlices(header);
}

/**
 * Pick the slice named `arch`, or by default the first slice matching the host CPU (falling back to the first slice).
 * Throws a ToolError listing the available slices when `arch` names none of them.
 */
export function selectSlice(slices: MachOSlice[], arch?: string): MachOSlice {
	if (arch !== undefined) {
		const named = slices.find(slice => slice.arch === arch);
		if (named) return named;
		throw new ToolError(`no ${arch} slice; available: ${slices.map(slice => slice.arch).join(", ")}`);
	}
	const host = HOST_CPU_TYPES[process.arch];
	return slices.find(slice => slice.cpuType === host) ?? slices[0];
}

/**
 * Split an explicit slice suffix off a binary reference: `/usr/bin/yes:@x86_64` → `{ path: "/usr/bin/yes", arch: "x86_64" }`.
 * References without `:@` come back unchanged.
 */
export function splitSliceRef(ref: string): { path: string; arch?: string } {
	const at = ref.lastIndexOf(SLICE_SEPARATOR);
	if (at <= 0) return { path: ref };
	const arch = ref.slice(at + SLICE_SEPARATOR.length);
	if (!arch) throw new ToolError(`empty slice name: use <binary>${SLICE_SEPARATOR}<arch>`);
	return { path: ref.slice(0, at), arch };
}

/** True when `p` has an IDA database extension (`.i64`/`.idb`, case-insensitive). */
export function isIdaDatabasePath(p: string): boolean {
	const ext = path.extname(p).toLowerCase();
	return ext === ".i64" || ext === ".idb";
}

/** Sniff the file header; false on any I/O error. */
export async function isExecutableFile(absPath: string): Promise<boolean> {
	try {
		return await peekFile(absPath, EXECUTABLE_SNIFF_BYTES, isExecutableHeader);
	} catch {
		return false;
	}
}

/** Where an IDB for a given source lives and how to open it. */
export interface IdbLocation {
	/** Registry key: `<sha16>-<name>` for store DBs, `<name>-<pathsha8>` for in-place DBs. */
	id: string;
	/** Directory holding the IDB (store dir, or the user's directory for in-place). */
	dir: string;
	/** Absolute path the user asked for (binary or `.i64`/`.idb`). */
	sourcePath: string;
	/** `store` = managed under the agent dir; `inplace` = user's own `.i64`/`.idb`. */
	kind: "store" | "inplace";
	/** Path passed to the worker's `open`; provisional for store DBs until {@link prepareStoreDir}. */
	openPath: string;
	/** Whether the worker must create a new database; provisional for store DBs until {@link prepareStoreDir}. */
	isNew: boolean;
	/** Path handed to `acquireFileLock` (lock file is `${lockTarget}.lock`). */
	lockTarget: string;
	/** Set for universal binaries: the store IDB is built from `fat.slice` alone. */
	fat?: FatSelection;
}

/** Reference `read` and `ida db=` resolve back to a database: the source path plus `:@<arch>` for a universal binary slice. */
export function idbRef(loc: Pick<IdbLocation, "sourcePath" | "fat">): string {
	return loc.fat ? `${loc.sourcePath}${SLICE_SEPARATOR}${loc.fat.slice.arch}` : loc.sourcePath;
}

/** Options for {@link locateIdb}. */
export interface LocateIdbOptions {
	/** Slice of a universal binary to analyze; defaults to the host architecture. Rejected for thin binaries and IDBs. */
	arch?: string;
}

/** Replace characters outside `[A-Za-z0-9._-]` with `_` and cap at 64 chars. */
export function sanitizeIdbName(name: string): string {
	return name.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, MAX_NAME_LENGTH);
}

interface ContentHash {
	size: number;
	mtimeMs: number;
	sha: string;
}

const contentHashes = new Map<string, ContentHash>();

async function hashFileContent(absPath: string): Promise<string> {
	const stat = await fs.promises.stat(absPath);
	const cached = contentHashes.get(absPath);
	if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) return cached.sha;
	const hasher = new Bun.CryptoHasher("sha256");
	for await (const chunk of Bun.file(absPath).stream()) {
		hasher.update(chunk);
	}
	const sha = hasher.digest("hex");
	contentHashes.set(absPath, { size: stat.size, mtimeMs: stat.mtimeMs, sha });
	return sha;
}

/**
 * Compute the IDB location for a binary (content-addressed store, one per slice of a universal binary)
 * or an existing `.i64`/`.idb` (in place).
 * Throws a ToolError when `arch` is given for a thin binary or IDB, or names no slice.
 */
export async function locateIdb(sourcePath: string, options: LocateIdbOptions = {}): Promise<IdbLocation> {
	const absPath = path.resolve(sourcePath);
	const name = sanitizeIdbName(path.basename(absPath));
	const slices = isIdaDatabasePath(absPath) ? null : await readFatSlices(absPath);
	if (options.arch !== undefined && !slices) {
		throw new ToolError(`${shortenPath(absPath)} is not a universal binary; drop ${SLICE_SEPARATOR}${options.arch}`);
	}

	if (isIdaDatabasePath(absPath)) {
		const pathSha = new Bun.CryptoHasher("sha256").update(absPath).digest("hex");
		return {
			id: `${name}-${pathSha.slice(0, 8)}`,
			dir: path.dirname(absPath),
			sourcePath: absPath,
			kind: "inplace",
			openPath: absPath,
			isNew: false,
			lockTarget: absPath,
		};
	}

	const sha = await hashFileContent(absPath);
	const fat = slices ? { slice: selectSlice(slices, options.arch), slices } : undefined;
	const id = `${sha.slice(0, 16)}-${name}${fat ? `.${sanitizeIdbName(fat.slice.arch)}` : ""}`;
	const dir = path.join(getAgentDir(), "idbs", id);
	return {
		id,
		dir,
		sourcePath: absPath,
		kind: "store",
		openPath: path.join(dir, name),
		isNew: true,
		lockTarget: path.join(dir, "db"),
		fat,
	};
}

/**
 * Validate an in-place location (refuses when IDA has it unpacked) or stage a store binary and settle `loc.openPath`/`loc.isNew`.
 * Call only while holding the lock on `loc.lockTarget` and only when the DB is not already open in this process.
 */
export async function prepareStoreDir(loc: IdbLocation): Promise<void> {
	if (loc.kind === "inplace") {
		const id0Path = path.join(loc.dir, `${path.basename(loc.openPath, path.extname(loc.openPath))}.id0`);
		if (await Bun.file(id0Path).exists()) {
			throw new ToolError(
				`${shortenPath(loc.openPath)} appears open in IDA (unpacked .id0 present); close it in IDA first`,
			);
		}
		return;
	}
	await fs.promises.mkdir(loc.dir, { recursive: true });

	const stagedName = sanitizeIdbName(path.basename(loc.sourcePath));
	const staged = path.join(loc.dir, stagedName);
	if (!(await Bun.file(staged).exists())) {
		if (loc.fat) {
			// IDA's loader would silently take the first slice of a fat file; stage the chosen thin Mach-O instead.
			const { arch, offset, size } = loc.fat.slice;
			const source = Bun.file(loc.sourcePath);
			if (offset + size > source.size) {
				throw new ToolError(`${shortenPath(loc.sourcePath)}: ${arch} slice extends past end of file`);
			}
			// Materialize the bytes: `Bun.write` of a sliced BunFile copies the whole source file.
			await Bun.write(staged, await source.slice(offset, offset + size).bytes());
		} else {
			await fs.promises.copyFile(loc.sourcePath, staged, fs.constants.COPYFILE_FICLONE);
		}
	}

	const entries = (await fs.promises.readdir(loc.dir)).sort();
	const databases = entries.filter(entry => entry.toLowerCase().endsWith(".i64"));
	if (databases.length > 0) {
		// Prefer the DB IDA names after the staged input; unpacked `<stem>.id0`… siblings are left for IDA.
		const preferred = databases.find(entry => entry === `${stagedName}.i64`) ?? databases[0];
		loc.openPath = path.join(loc.dir, preferred);
		loc.isNew = false;
		return;
	}

	// No finished database: anything besides the staged input and the lock is a crashed-creation leftover.
	const lockName = `${path.basename(loc.lockTarget)}${LOCK_SUFFIX}`;
	await Promise.all(
		entries
			.filter(entry => entry !== stagedName && entry !== lockName)
			.map(entry => fs.promises.rm(path.join(loc.dir, entry), { recursive: true, force: true })),
	);
	loc.openPath = staged;
	loc.isNew = true;
}
