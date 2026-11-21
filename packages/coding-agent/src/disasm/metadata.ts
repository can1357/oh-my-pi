import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { databaseOwner } from "./backend";
import { parseFatSlices, selectSlice, type FatSelection } from "./store";

const MAX_TABLE_BYTES = 4 * 1024 * 1024;
const MAX_ROWS = 8192;
const MAX_READ_BYTES = 8 * 1024 * 1024;
const hex = (value: bigint | number): string => `0x${value.toString(16)}`;
const label = (names: Record<number, string>, value: number): string => names[value] ?? hex(value);
const fixedName = (bytes: Buffer): string => {
	const end = bytes.indexOf(0);
	return bytes.toString("utf8", 0, end < 0 ? bytes.length : end).replace(/[\x00-\x1f\x7f-\x9f]/g, "?");
};

/** On-disk executable facts and the selected universal slice, without opening an analysis database. */
export interface BinaryMetadata {
	text: string;
	fat?: FatSelection;
}

/** Bounded on-disk inspection only: no hashing, store, broker, runtime, or analysis. */
export async function readBinaryMetadata(file: string, arch?: string): Promise<BinaryMetadata> {
	const handle = await fs.open(file, "r");
	try {
		const stat = await handle.stat({ bigint: true });
		if (!stat.isFile()) throw new ToolError("Binary metadata requires a regular file");
		const owner = databaseOwner(file);
		if (owner) {
			if (arch !== undefined) throw new ToolError("slice selection requires a universal Mach-O binary");
			return {
				text: `${owner.label} database (${path.extname(file).toLowerCase()})\nfile size ${stat.size} bytes; database not opened`,
			};
		}
		let base = 0n;
		let size = stat.size;
		let budget = MAX_READ_BYTES;
		const read = async (offset: bigint, length: number): Promise<Buffer> => {
			if (!Number.isSafeInteger(length) || length < 0 || length > MAX_TABLE_BYTES || length > budget) {
				throw new ToolError("Malformed binary: metadata table exceeds inspection limit");
			}
			if (offset < 0n || offset + BigInt(length) > size)
				throw new ToolError("Malformed binary: truncated or out-of-range metadata");
			const position = base + offset;
			if (position + BigInt(length) > BigInt(Number.MAX_SAFE_INTEGER))
				throw new ToolError("Binary metadata offset exceeds supported file-position precision");
			budget -= length;
			const bytes = Buffer.allocUnsafe(length);
			let done = 0;
			while (done < length) {
				const result = await handle.read(bytes, done, length - done, Number(position) + done);
				if (result.bytesRead === 0) throw new ToolError("Malformed binary: truncated metadata");
				done += result.bytesRead;
			}
			return bytes;
		};
		const initial = await read(0n, Number(size < 64n ? size : 64n));
		if (initial.length < 4) throw new ToolError("Malformed binary: truncated header");
		let fat: FatSelection | undefined;
		const magic = initial.readUInt32BE(0);
		if (magic === 0xcafebabe || magic === 0xcafebabf) {
			if (initial.length < 8) throw new ToolError("Malformed binary: truncated universal slice table");
			const tableEnd = 8 + initial.readUInt32BE(4) * (magic === 0xcafebabf ? 32 : 20);
			if (tableEnd > MAX_TABLE_BYTES || BigInt(tableEnd) > size)
				throw new ToolError("Malformed binary: invalid or truncated universal slice table");
			const slices = parseFatSlices(await read(0n, tableEnd));
			if (!slices) throw new ToolError("Malformed binary: invalid universal slice table");
			for (const slice of slices) {
				if (!Number.isSafeInteger(slice.offset) || !Number.isSafeInteger(slice.size))
					throw new ToolError("Malformed binary: universal slice exceeds supported offset precision");
				if (slice.offset < tableEnd || slice.size < 28 || BigInt(slice.offset) + BigInt(slice.size) > stat.size)
					throw new ToolError("Malformed binary: out-of-range universal slice");
			}
			const sorted = [...slices].sort((a, b) => a.offset - b.offset);
			for (let i = 1; i < sorted.length; i++) {
				if (BigInt(sorted[i - 1].offset) + BigInt(sorted[i - 1].size) > BigInt(sorted[i].offset))
					throw new ToolError("Malformed binary: overlapping universal slices");
			}
			const slice = selectSlice(slices, arch);
			fat = { slice, slices };
			base = BigInt(slice.offset);
			size = BigInt(slice.size);
		} else if (arch !== undefined) {
			throw new ToolError("slice selection requires a universal Mach-O binary");
		}
		const header = fat ? await read(0n, Number(size < 64n ? size : 64n)) : initial;
		const lines = [`file size ${stat.size} bytes`];
		if (fat) {
			lines.push(`universal Mach-O; selected ${fat.slice.arch}${arch === undefined ? " (default)" : " (explicit)"}`);
			for (const slice of fat.slices)
				lines.push(
					`  ${slice.arch}: file ${hex(slice.offset)} size ${hex(slice.size)}${slice === fat.slice ? " (shown)" : ""}`,
				);
		}
		const checkRows = (count: number): void => {
			if (!Number.isSafeInteger(count) || count < 0 || count > MAX_ROWS)
				throw new ToolError("Malformed binary: metadata count exceeds inspection limit");
		};
		const range = (offset: bigint, length: bigint): void => {
			if (offset < 0n || length < 0n || offset + length > size)
				throw new ToolError("Malformed binary: file layout outside binary bounds");
		};
		const headerMagic = header.readUInt32BE(0);
		if (fat && ![0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe].includes(headerMagic)) {
			throw new ToolError("Malformed binary: universal slice is not Mach-O");
		}
		if ([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe].includes(headerMagic)) {
			const little = headerMagic === 0xcefaedfe || headerMagic === 0xcffaedfe;
			const wide = headerMagic === 0xfeedfacf || headerMagic === 0xcffaedfe;
			const headerSize = wide ? 32 : 28;
			if (header.length < headerSize) throw new ToolError("Malformed Mach-O: truncated header");
			const u32 = (b: Buffer, at: number): number => (little ? b.readUInt32LE(at) : b.readUInt32BE(at));
			const word = (b: Buffer, at: number): bigint =>
				wide ? (little ? b.readBigUInt64LE(at) : b.readBigUInt64BE(at)) : BigInt(u32(b, at));
			const cpu = u32(header, 4);
			if (fat && cpu !== fat.slice.cpuType)
				throw new ToolError("Malformed Mach-O: slice CPU does not match universal inventory");
			lines.push(
				`Mach-O ${wide ? 64 : 32}-bit ${little ? "little" : "big"}-endian; architecture ${label({ 7: "i386", 12: "arm", 18: "ppc", 16777223: "x86_64", 16777228: "arm64", 33554444: "arm64_32", 16777234: "ppc64" }, cpu)} subtype ${hex(u32(header, 8))}`,
			);
			lines.push(
				`file type ${label({ 1: "OBJECT", 2: "EXECUTE", 3: "FVMLIB", 4: "CORE", 6: "DYLIB", 7: "DYLINKER", 8: "BUNDLE", 11: "KEXT_BUNDLE", 12: "FILESET" }, u32(header, 12))}; flags ${hex(u32(header, 24))}`,
			);
			const count = u32(header, 16);
			checkRows(count);
			const commands = await read(BigInt(headerSize), u32(header, 20));
			let at = 0;
			let entry: bigint | undefined;
			let threadEntry: bigint | undefined;
			let imageBase: bigint | undefined;
			let textAddress: bigint | undefined;
			let textOffset = 0n;
			let sectionsSeen = 0;
			for (let i = 0; i < count; i++) {
				if (at + 8 > commands.length) throw new ToolError("Malformed Mach-O: truncated load command");
				const cmd = u32(commands, at);
				const length = u32(commands, at + 4);
				if (length < 8 || length % 4 !== 0 || at + length > commands.length)
					throw new ToolError("Malformed Mach-O: invalid load command size");
				const b = commands.subarray(at, at + length);
				if (cmd === 1 || cmd === 0x19) {
					if ((cmd === 0x19) !== wide || length < (wide ? 72 : 56))
						throw new ToolError("Malformed Mach-O: invalid segment command");
					const name = fixedName(b.subarray(8, 24));
					const vm = word(b, 24),
						vmSize = word(b, wide ? 32 : 28),
						off = word(b, wide ? 40 : 32),
						len = word(b, wide ? 48 : 36);
					range(off, len);
					const prot = u32(b, wide ? 60 : 44);
					const n = u32(b, wide ? 64 : 48);
					sectionsSeen += n;
					checkRows(sectionsSeen);
					if ((wide ? 72 : 56) + n * (wide ? 80 : 68) > length)
						throw new ToolError("Malformed Mach-O: truncated section table");
					if (len > 0n && (imageBase === undefined || vm < imageBase)) imageBase = vm;
					if (name === "__TEXT") {
						textAddress = vm;
						textOffset = off;
					}
					lines.push(
						`segment ${name}: vm ${hex(vm)}-${hex(vm + vmSize)} file ${hex(off)}+${hex(len)} ${prot & 1 ? "r" : "-"}${prot & 2 ? "w" : "-"}${prot & 4 ? "x" : "-"} flags ${hex(u32(b, wide ? 68 : 52))}`,
					);
					for (let s = 0; s < n; s++) {
						const p = (wide ? 72 : 56) + s * (wide ? 80 : 68);
						const addr = word(b, p + 32),
							sectionSize = word(b, p + (wide ? 40 : 36));
						const offset = u32(b, p + (wide ? 48 : 40)),
							flags = u32(b, p + (wide ? 64 : 56));
						if (![1, 12, 18].includes(flags & 0xff)) range(BigInt(offset), sectionSize);
						lines.push(
							`  section ${fixedName(b.subarray(p + 16, p + 32))},${fixedName(b.subarray(p, p + 16))}: vm ${hex(addr)}+${hex(sectionSize)} file ${hex(offset)} flags ${hex(flags)}`,
						);
					}
				} else if (cmd === 4 || cmd === 5) {
					// LC_THREAD/LC_UNIXTHREAD may contain several flavor/count state records.
					let state = 8;
					while (state < length) {
						if (state + 8 > length) throw new ToolError("Malformed Mach-O: truncated thread state");
						const flavor = u32(b, state),
							words = u32(b, state + 4);
						const end = state + 8 + words * 4;
						if (end > length) throw new ToolError("Malformed Mach-O: truncated thread state");
						let pcOffset: number | undefined;
						let pcWide = false;
						if (cpu === 0x01000007 && flavor === 4) {
							pcOffset = 128;
							pcWide = true;
						} else if (cpu === 7 && flavor === 1) pcOffset = 40;
						else if (cpu === 0x0100000c && flavor === 6) {
							pcOffset = 256;
							pcWide = true;
						} else if (cpu === 12 && flavor === 1) pcOffset = 60;
						if (pcOffset !== undefined) {
							const pc = state + 8 + pcOffset;
							if (pc + (pcWide ? 8 : 4) > end)
								throw new ToolError("Malformed Mach-O: thread state lacks entry register");
							threadEntry = pcWide
								? little
									? b.readBigUInt64LE(pc)
									: b.readBigUInt64BE(pc)
								: BigInt(u32(b, pc));
						}
						state = end;
					}
				} else if (cmd === 0x80000028) {
					if (length < 24) throw new ToolError("Malformed Mach-O: truncated LC_MAIN");
					entry = little ? b.readBigUInt64LE(8) : b.readBigUInt64BE(8);
				}
				at += length;
			}
			if (at !== commands.length) throw new ToolError("Malformed Mach-O: load command count/size mismatch");
			if (imageBase !== undefined) lines.push(`image base ${hex(imageBase)}`);
			if (entry !== undefined) {
				range(entry, 1n);
				lines.push(
					`entry file offset ${hex(entry)}${textAddress === undefined || entry < textOffset ? "" : `; entry address ${hex(textAddress + entry - textOffset)}`}`,
				);
			} else if (threadEntry !== undefined) {
				lines.push(`entry address ${hex(threadEntry)} (thread state)`);
			}
		} else if (headerMagic === 0x7f454c46) {
			if (header.length < 16 || ![1, 2].includes(header[4]) || ![1, 2].includes(header[5]) || header[6] !== 1)
				throw new ToolError("Malformed ELF: invalid identification");
			const wide = header[4] === 2,
				little = header[5] === 1;
			if (header.length < (wide ? 64 : 52)) throw new ToolError("Malformed ELF: truncated header");
			const u16 = (b: Buffer, at: number): number => (little ? b.readUInt16LE(at) : b.readUInt16BE(at));
			const u32 = (b: Buffer, at: number): number => (little ? b.readUInt32LE(at) : b.readUInt32BE(at));
			const word = (b: Buffer, at: number): bigint =>
				wide ? (little ? b.readBigUInt64LE(at) : b.readBigUInt64BE(at)) : BigInt(u32(b, at));
			if (u16(header, wide ? 52 : 40) < (wide ? 64 : 52) || u32(header, 20) !== 1)
				throw new ToolError("Malformed ELF: invalid header size/version");
			lines.push(
				`ELF ${wide ? 64 : 32}-bit ${little ? "little" : "big"}-endian; architecture ${label({ 3: "i386", 8: "MIPS", 20: "ppc", 21: "ppc64", 40: "arm", 62: "x86_64", 183: "arm64", 243: "RISC-V" }, u16(header, 18))}`,
			);
			lines.push(
				`file type ${label({ 0: "NONE", 1: "REL", 2: "EXEC", 3: "DYN", 4: "CORE" }, u16(header, 16))}; entry ${hex(word(header, 24))}; flags ${hex(u32(header, wide ? 48 : 36))}`,
			);
			const phoff = word(header, wide ? 32 : 28),
				shoff = word(header, wide ? 40 : 32);
			const phsize = u16(header, wide ? 54 : 42),
				shsize = u16(header, wide ? 58 : 46);
			let phnum = u16(header, wide ? 56 : 44),
				shnum = u16(header, wide ? 60 : 48),
				namesIndex = u16(header, wide ? 62 : 50);
			if (shoff !== 0n && (shnum === 0 || phnum === 0xffff || namesIndex === 0xffff)) {
				if (shsize < (wide ? 64 : 40)) throw new ToolError("Malformed ELF: invalid section entry size");
				const zero = await read(shoff, shsize);
				if (shnum === 0) {
					const count = word(zero, wide ? 32 : 20);
					if (count > BigInt(MAX_ROWS))
						throw new ToolError("Malformed ELF: section count exceeds inspection limit");
					shnum = Number(count);
				}
				if (phnum === 0xffff) phnum = u32(zero, wide ? 44 : 28);
				if (namesIndex === 0xffff) namesIndex = u32(zero, wide ? 40 : 24);
			}
			checkRows(phnum);
			checkRows(shnum);
			if (
				(phnum && (phoff === 0n || phsize < (wide ? 56 : 32))) ||
				(shnum && (shoff === 0n || shsize < (wide ? 64 : 40))) ||
				namesIndex >= Math.max(1, shnum)
			)
				throw new ToolError("Malformed ELF: invalid table dimensions");
			const programs = await read(phoff, phsize * phnum);
			let imageBase: bigint | undefined;
			for (let i = 0; i < phnum; i++) {
				const b = programs.subarray(i * phsize, (i + 1) * phsize);
				const type = u32(b, 0),
					flags = u32(b, wide ? 4 : 24),
					off = word(b, wide ? 8 : 4),
					vm = word(b, wide ? 16 : 8),
					len = word(b, wide ? 32 : 16),
					mem = word(b, wide ? 40 : 20);
				range(off, len);
				if (type === 1 && len > mem) throw new ToolError("Malformed ELF: load segment exceeds its memory size");
				if (type === 1 && (imageBase === undefined || vm < imageBase)) imageBase = vm;
				lines.push(
					`segment ${label({ 0: "NULL", 1: "LOAD", 2: "DYNAMIC", 3: "INTERP", 4: "NOTE", 6: "PHDR", 7: "TLS" }, type)}: vm ${hex(vm)}+${hex(mem)} file ${hex(off)}+${hex(len)} ${flags & 4 ? "r" : "-"}${flags & 2 ? "w" : "-"}${flags & 1 ? "x" : "-"}`,
				);
			}
			if (imageBase !== undefined) lines.push(`image base ${hex(imageBase)}`);
			const sections = await read(shoff, shsize * shnum);
			let names: Buffer = Buffer.alloc(0);
			if (namesIndex > 0) {
				const b = sections.subarray(namesIndex * shsize, (namesIndex + 1) * shsize);
				const length = word(b, wide ? 32 : 20);
				if (u32(b, 4) !== 3 || length > BigInt(MAX_TABLE_BYTES))
					throw new ToolError("Malformed ELF: invalid section name table");
				names = await read(word(b, wide ? 24 : 16), Number(length));
			}
			for (let i = 0; i < shnum; i++) {
				const b = sections.subarray(i * shsize, (i + 1) * shsize);
				const type = u32(b, 4),
					flags = word(b, 8),
					vm = word(b, wide ? 16 : 12),
					off = word(b, wide ? 24 : 16),
					len = word(b, wide ? 32 : 20),
					nameAt = u32(b, 0);
				if (type !== 8 && type !== 0) range(off, len);
				if (namesIndex > 0 && nameAt >= names.length)
					throw new ToolError("Malformed ELF: invalid section name offset");
				if (namesIndex > 0 && names[names.length - 1] !== 0)
					throw new ToolError("Malformed ELF: unterminated section name table");
				const name = namesIndex > 0 ? fixedName(names.subarray(nameAt, nameAt + 256)) : `#${i}`;
				lines.push(
					`section ${name}: vm ${hex(vm)}+${hex(len)} file ${hex(off)} type ${hex(type)} flags ${hex(flags)} ${flags & 2n ? "a" : "-"}${flags & 1n ? "w" : "-"}${flags & 4n ? "x" : "-"}`,
				);
			}
		} else if (header[0] === 0x4d && header[1] === 0x5a) {
			if (header.length < 64) throw new ToolError("Malformed PE: truncated DOS header");
			const peoff = header.readUInt32LE(60);
			if (peoff < 64) throw new ToolError("Malformed PE: invalid PE header offset");
			const coff = await read(BigInt(peoff), 24);
			if (coff.readUInt32LE(0) !== 0x4550) throw new ToolError("Malformed PE: invalid signature");
			const count = coff.readUInt16LE(6),
				optionalSize = coff.readUInt16LE(20);
			checkRows(count);
			const optional = await read(BigInt(peoff) + 24n, optionalSize);
			if (optional.length < 2) throw new ToolError("Malformed PE: missing optional header");
			const kind = optional.readUInt16LE(0),
				wide = kind === 0x20b;
			if ((kind !== 0x10b && !wide) || optional.length < (wide ? 112 : 96))
				throw new ToolError("Malformed PE: invalid optional header");
			const imageBase = wide ? optional.readBigUInt64LE(24) : BigInt(optional.readUInt32LE(28));
			const entry = optional.readUInt32LE(16),
				flags = coff.readUInt16LE(22);
			lines.push(
				`PE${wide ? "32+" : "32"} ${wide ? 64 : 32}-bit little-endian; architecture ${label({ 332: "i386", 34404: "x86_64", 448: "arm", 452: "armv7", 43620: "arm64" }, coff.readUInt16LE(4))}`,
			);
			lines.push(
				`file type ${flags & 0x2000 ? "DLL" : flags & 2 ? "EXECUTABLE" : "IMAGE"}; characteristics ${hex(flags)}; subsystem ${optional.readUInt16LE(68)}`,
			);
			lines.push(
				`image base ${hex(imageBase)}; entry RVA ${hex(entry)} address ${hex(imageBase + BigInt(entry))}; image size ${hex(optional.readUInt32LE(56))}`,
			);
			const table = await read(BigInt(peoff) + 24n + BigInt(optionalSize), count * 40);
			for (let i = 0; i < count; i++) {
				const b = table.subarray(i * 40, (i + 1) * 40);
				const vm = b.readUInt32LE(12),
					mem = b.readUInt32LE(8),
					len = b.readUInt32LE(16),
					off = b.readUInt32LE(20),
					f = b.readUInt32LE(36);
				if (len > 0) range(BigInt(off), BigInt(len));
				lines.push(
					`section ${fixedName(b.subarray(0, 8))}: RVA ${hex(vm)} vm ${hex(imageBase + BigInt(vm))}+${hex(mem)} file ${hex(off)}+${hex(len)} ${f & 0x40000000 ? "r" : "-"}${f & 0x80000000 ? "w" : "-"}${f & 0x20000000 ? "x" : "-"} flags ${hex(f)}`,
				);
			}
		} else {
			throw new ToolError("Unrecognized executable format");
		}
		return { text: lines.join("\n"), fat };
	} finally {
		await handle.close();
	}
}
