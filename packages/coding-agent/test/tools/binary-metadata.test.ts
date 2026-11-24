import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as client from "@oh-my-pi/pi-coding-agent/disasm/client";
import { readBinaryMetadata } from "@oh-my-pi/pi-coding-agent/disasm/metadata";
import { selectSlice } from "@oh-my-pi/pi-coding-agent/disasm/store";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { readBinary } from "@oh-my-pi/pi-coding-agent/tools/read-binary";
import { parseSel } from "@oh-my-pi/pi-coding-agent/tools/read-selector";
import type { ReadToolDetails } from "@oh-my-pi/pi-coding-agent/tools/details/read";

/** One __TEXT segment, one section and LC_MAIN; arm64 and x86_64 share the same layout. */
function macho(cpu = 0x0100000c): Buffer {
	const b = Buffer.alloc(512);
	b.writeUInt32LE(0xfeedfacf, 0);
	b.writeUInt32LE(cpu, 4);
	b.writeUInt32LE(cpu === 0x01000007 ? 3 : 0, 8);
	b.writeUInt32LE(2, 12);
	b.writeUInt32LE(2, 16);
	b.writeUInt32LE(176, 20);
	b.writeUInt32LE(0x200085, 24);
	b.writeUInt32LE(0x19, 32);
	b.writeUInt32LE(152, 36);
	b.write("__TEXT", 40);
	b.writeBigUInt64LE(0x100000000n, 56);
	b.writeBigUInt64LE(0x1000n, 64);
	b.writeBigUInt64LE(512n, 80);
	b.writeUInt32LE(5, 88);
	b.writeUInt32LE(5, 92);
	b.writeUInt32LE(1, 96);
	b.write("__text", 104);
	b.write("__TEXT", 120);
	b.writeBigUInt64LE(0x100000100n, 136);
	b.writeBigUInt64LE(16n, 144);
	b.writeUInt32LE(256, 152);
	b.writeUInt32LE(0x80000400, 168);
	b.writeUInt32LE(0x80000028, 184);
	b.writeUInt32LE(24, 188);
	b.writeBigUInt64LE(256n, 192);
	return b;
}

/** ELF64 with one load segment and a string-named .text section above 2^53. */
function elf(): Buffer {
	const b = Buffer.alloc(512);
	b.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]);
	b.writeUInt16LE(2, 16);
	b.writeUInt16LE(62, 18);
	b.writeUInt32LE(1, 20);
	b.writeBigUInt64LE(0x20000000000001n, 24);
	b.writeBigUInt64LE(64n, 32);
	b.writeBigUInt64LE(128n, 40);
	b.writeUInt16LE(64, 52);
	b.writeUInt16LE(56, 54);
	b.writeUInt16LE(1, 56);
	b.writeUInt16LE(64, 58);
	b.writeUInt16LE(3, 60);
	b.writeUInt16LE(1, 62);
	b.writeUInt32LE(1, 64);
	b.writeUInt32LE(5, 68);
	b.writeBigUInt64LE(0x20000000000001n, 80);
	b.writeBigUInt64LE(512n, 96);
	b.writeBigUInt64LE(4096n, 104);
	b.writeUInt32LE(1, 192);
	b.writeUInt32LE(3, 196);
	b.writeBigUInt64LE(320n, 216);
	b.writeBigUInt64LE(17n, 224);
	b.writeUInt32LE(11, 256);
	b.writeUInt32LE(1, 260);
	b.writeBigUInt64LE(6n, 264);
	b.writeBigUInt64LE(0x20000000000001n, 272);
	b.writeBigUInt64LE(352n, 280);
	b.writeBigUInt64LE(16n, 288);
	b.write("\0.shstrtab\0.text\0", 320);
	return b;
}

function pe(): Buffer {
	const b = Buffer.alloc(1024);
	b.write("MZ", 0);
	b.writeUInt32LE(128, 60);
	b.writeUInt32LE(0x4550, 128);
	b.writeUInt16LE(0x8664, 132);
	b.writeUInt16LE(1, 134);
	b.writeUInt16LE(240, 148);
	b.writeUInt16LE(0x2022, 150);
	b.writeUInt16LE(0x20b, 152);
	b.writeUInt32LE(0x1000, 168);
	b.writeBigUInt64LE(0x20000000000001n, 176);
	b.writeUInt32LE(0x2000, 208);
	b.writeUInt16LE(3, 220);
	b.write(".text", 392);
	b.writeUInt32LE(0x100, 400);
	b.writeUInt32LE(0x1000, 404);
	b.writeUInt32LE(512, 408);
	b.writeUInt32LE(512, 412);
	b.writeUInt32LE(0x60000020, 428);
	return b;
}

function universal(is64 = false): Buffer {
	const b = Buffer.alloc(1536);
	b.writeUInt32BE(is64 ? 0xcafebabf : 0xcafebabe, 0);
	b.writeUInt32BE(2, 4);
	for (const [i, cpu] of [0x01000007, 0x0100000c].entries()) {
		const at = 8 + i * (is64 ? 32 : 20);
		b.writeUInt32BE(cpu, at);
		b.writeUInt32BE(i === 0 ? 3 : 0, at + 4);
		if (is64) {
			b.writeBigUInt64BE(BigInt(512 + i * 512), at + 8);
			b.writeBigUInt64BE(512n, at + 16);
		} else {
			b.writeUInt32BE(512 + i * 512, at + 8);
			b.writeUInt32BE(512, at + 12);
		}
		macho(cpu).copy(b, 512 + i * 512);
	}
	return b;
}

function textOutput(result: AgentToolResult<ReadToolDetails>): string {
	return result.content
		.filter(block => block.type === "text")
		.map(block => block.text)
		.join("\n");
}

let root: string;
let session: ToolSession;
beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "binary-metadata-"));
	session = {
		cwd: root,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated({
			"disassembler.backend": "none",
			"read.summarize.enabled": false,
			"edit.mode": "hashline",
		}),
	};
});
afterEach(async () => {
	await fs.rm(root, { recursive: true, force: true });
});

async function fixture(bytes: Uint8Array, name = "sample.bin"): Promise<string> {
	const file = path.join(root, name);
	await Bun.write(file, bytes);
	return file;
}

describe("on-disk executable metadata", () => {
	it("reads Mach-O segments, section flags and LC_MAIN without analysis", async () => {
		const { text } = await readBinaryMetadata(await fixture(macho()));
		expect(text).toContain("Mach-O 64-bit little-endian; architecture arm64");
		expect(text).toContain("file type EXECUTE");
		expect(text).toContain("segment __TEXT: vm 0x100000000-0x100001000 file 0x0+0x200 r-x");
		expect(text).toContain("section __TEXT,__text");
		expect(text).toContain("flags 0x80000400");
		expect(text).toContain("entry address 0x100000100");
	});

	it("reads legacy Mach-O thread-state entry registers", async () => {
		const b = Buffer.alloc(216);
		b.writeUInt32LE(0xfeedfacf, 0);
		b.writeUInt32LE(0x01000007, 4);
		b.writeUInt32LE(2, 12);
		b.writeUInt32LE(1, 16);
		b.writeUInt32LE(184, 20);
		b.writeUInt32LE(5, 32);
		b.writeUInt32LE(184, 36);
		b.writeUInt32LE(4, 40);
		b.writeUInt32LE(42, 44);
		b.writeBigUInt64LE(0x100001234n, 176);
		expect((await readBinaryMetadata(await fixture(b))).text).toContain("entry address 0x100001234 (thread state)");
	});

	it("preserves ELF64 addresses beyond Number precision and names sections", async () => {
		const { text } = await readBinaryMetadata(await fixture(elf()));
		expect(text).toContain("ELF 64-bit little-endian; architecture x86_64");
		expect(text).toContain("entry 0x20000000000001");
		expect(text).toContain("segment LOAD");
		expect(text).toContain("section .text");
		expect(text).toContain("flags 0x6 a-x");
	});

	it("reads PE32+ image base, entry point, section layout and permissions", async () => {
		const { text } = await readBinaryMetadata(await fixture(pe()));
		expect(text).toContain("PE32+ 64-bit little-endian; architecture x86_64");
		expect(text).toContain("file type DLL");
		expect(text).toContain("image base 0x20000000000001; entry RVA 0x1000 address 0x20000000001001");
		expect(text).toContain("section .text: RVA 0x1000");
		expect(text).toContain("file 0x200+0x200 r-x");
	});

	it("supports 32-bit big-endian ELF and Mach-O headers", async () => {
		const e = Buffer.alloc(52);
		e.set([0x7f, 0x45, 0x4c, 0x46, 1, 2, 1]);
		e.writeUInt16BE(1, 16);
		e.writeUInt16BE(20, 18);
		e.writeUInt32BE(1, 20);
		e.writeUInt32BE(0x80000001, 24);
		e.writeUInt16BE(52, 40);
		expect((await readBinaryMetadata(await fixture(e))).text).toContain("ELF 32-bit big-endian; architecture ppc");
		const m = Buffer.alloc(28);
		m.writeUInt32BE(0xfeedface, 0);
		m.writeUInt32BE(18, 4);
		m.writeUInt32BE(1, 12);
		expect((await readBinaryMetadata(await fixture(m))).text).toContain("Mach-O 32-bit big-endian; architecture ppc");
	});

	it("supports PE32 optional-header image bases", async () => {
		const b = pe();
		b.writeUInt16LE(0x14c, 132);
		b.writeUInt16LE(0x10b, 152);
		b.writeUInt32LE(0x400000, 180);
		expect((await readBinaryMetadata(await fixture(b))).text).toContain(
			"PE32 32-bit little-endian; architecture i386",
		);
		expect((await readBinaryMetadata(path.join(root, "sample.bin"))).text).toContain("image base 0x400000");
	});

	for (const wide of [false, true]) {
		it(`inventories universal ${wide ? "64" : "32"}-bit tables and selects default/explicit slices`, async () => {
			const file = await fixture(universal(wide));
			const metadata = await readBinaryMetadata(file);
			expect(metadata.fat).toBeDefined();
			if (!metadata.fat) throw new Error("Expected universal inventory");
			expect(metadata.fat.slice.arch).toBe(selectSlice(metadata.fat.slices).arch);
			expect(metadata.text).toContain("(default)");
			expect(metadata.text).toContain("x86_64: file 0x200 size 0x200");
			expect(metadata.text).toContain("arm64: file 0x400 size 0x200");
			const explicit = await readBinaryMetadata(file, "x86_64");
			expect(explicit.text).toContain("selected x86_64 (explicit)");
			expect(explicit.text).toContain("architecture x86_64");
			await expect(readBinaryMetadata(file, "ppc")).rejects.toThrow("available: x86_64, arm64");
		});
	}

	it("handles ELF extended section/program counts without scanning file contents", async () => {
		const b = elf();
		b.writeUInt16LE(0xffff, 56);
		b.writeUInt16LE(0, 60);
		b.writeUInt16LE(0xffff, 62);
		b.writeBigUInt64LE(3n, 160);
		b.writeUInt32LE(1, 168);
		b.writeUInt32LE(1, 172);
		expect((await readBinaryMetadata(await fixture(b))).text).toContain("section .text");
	});

	it("rejects slice selectors on thin executables and IDA databases", async () => {
		await expect(readBinaryMetadata(await fixture(macho()), "arm64")).rejects.toThrow("requires a universal");
		await expect(readBinaryMetadata(await fixture(Buffer.alloc(8), "sample.i64"), "arm64")).rejects.toThrow(
			"requires a universal",
		);
	});

	it("labels a database file with its owning backend and extension", async () => {
		const cases: Array<[string, string]> = [
			["saved.i64", "IDA database (.i64)"],
			["saved.IDB", "IDA database (.idb)"],
			["saved.bndb", "Binary Ninja database (.bndb)"],
		];
		for (const [name, heading] of cases) {
			const { text } = await readBinaryMetadata(await fixture(Buffer.alloc(8), name));
			expect(text).toBe(`${heading}\nfile size 8 bytes; database not opened`);
		}
	});

	const malformed: Array<[string, () => Buffer, string]> = [
		["short ELF header", () => elf().subarray(0, 32), "truncated header"],
		[
			"ELF overflowing table offset",
			() => {
				const b = elf();
				b.writeBigUInt64LE(0xffffffffffffffffn, 32);
				return b;
			},
			"out-of-range",
		],
		[
			"ELF oversized counts",
			() => {
				const b = elf();
				b.writeUInt16LE(8193, 60);
				return b;
			},
			"count exceeds",
		],
		[
			"ELF small row",
			() => {
				const b = elf();
				b.writeUInt16LE(1, 58);
				return b;
			},
			"table dimensions",
		],
		[
			"ELF bad name offset",
			() => {
				const b = elf();
				b.writeUInt32LE(99, 256);
				return b;
			},
			"name offset",
		],
		[
			"ELF missing string terminator",
			() => {
				const b = elf();
				b[336] = 65;
				return b;
			},
			"unterminated",
		],
		[
			"Mach-O short load command",
			() => {
				const b = macho();
				b.writeUInt32LE(4, 36);
				return b;
			},
			"command size",
		],
		[
			"Mach-O truncated section table",
			() => {
				const b = macho();
				b.writeUInt32LE(2, 96);
				return b;
			},
			"section table",
		],
		[
			"Mach-O oversized command area",
			() => {
				const b = macho();
				b.writeUInt32LE(0xffffffff, 20);
				return b;
			},
			"inspection limit",
		],
		[
			"PE bogus signature",
			() => {
				const b = pe();
				b.writeUInt32LE(0, 128);
				return b;
			},
			"signature",
		],
		[
			"PE beyond-EOF header",
			() => {
				const b = pe();
				b.writeUInt32LE(0xfffffff0, 60);
				return b;
			},
			"out-of-range",
		],
		["PE truncated sections", () => pe().subarray(0, 400), "out-of-range"],
		[
			"PE section beyond EOF",
			() => {
				const b = pe();
				b.writeUInt32LE(0xffffff00, 412);
				return b;
			},
			"bounds",
		],
		["universal table cut short", () => universal().subarray(0, 40), "slice table"],
		[
			"universal out-of-range slice",
			() => {
				const b = universal();
				b.writeUInt32BE(2048, 16);
				return b;
			},
			"out-of-range universal",
		],
		[
			"universal overlapping slices",
			() => {
				const b = universal();
				b.writeUInt32BE(768, 36);
				return b;
			},
			"overlapping",
		],
		[
			"universal unsafe 64-bit offset",
			() => {
				const b = universal(true);
				b.writeBigUInt64BE(0x20000000000001n, 16);
				return b;
			},
			"precision",
		],
	];
	for (const [name, bytes, message] of malformed) {
		it(`rejects ${name}`, async () => {
			await expect(readBinaryMetadata(await fixture(bytes()))).rejects.toThrow(message);
		});
	}
});

describe("read metadata and explicit analysis boundary", () => {
	it("plain ReadTool reads useful metadata with analysis disabled and never acquires a database", async () => {
		await fixture(elf());
		const acquire = spyOn(client, "acquireDatabase").mockImplementation(async () => {
			throw new Error("unexpected analysis");
		});
		try {
			const result = await new ReadTool(session).execute("metadata", { path: "sample.bin" });
			expect(textOutput(result)).toContain("ELF 64-bit");
			expect(textOutput(result)).toContain("disassembler.backend");
			expect(textOutput(result)).not.toContain("HASHLINE");
			expect(acquire).not.toHaveBeenCalled();
		} finally {
			acquire.mockRestore();
		}
	});

	it("metadata remains immutable and pageable with an enabled backend", async () => {
		const file = await fixture(macho());
		session = {
			...session,
			settings: Settings.isolated({
				"disassembler.backend": "ghidra",
				"read.summarize.enabled": false,
				"edit.mode": "hashline",
			}),
		};
		const acquire = spyOn(client, "acquireDatabase").mockImplementation(async () => {
			throw new Error("unexpected analysis");
		});
		try {
			const result = await readBinary(session, { backend: "ghidra", absolutePath: file, view: "" }, parseSel("2-2"));
			expect(textOutput(result)).toContain("Mach-O 64-bit");
			expect(textOutput(result)).not.toContain("dsm namespace");
			expect(textOutput(result)).not.toMatch(/\d+:[A-Z0-9]{2,}/);
			expect(textOutput(await new ReadTool(session).execute("enabled-metadata", { path: "sample.bin" }))).toContain(
				"Mach-O 64-bit",
			);
			const full = await readBinary(
				session,
				{ backend: "ghidra", absolutePath: file, view: "" },
				parseSel(undefined),
			);
			expect(textOutput(full)).toContain("sample.bin:overview");
			expect(textOutput(full)).toContain("help://eval/dsm");
			expect(acquire).not.toHaveBeenCalled();
		} finally {
			acquire.mockRestore();
		}
	});

	it("bare :@arch remains metadata, including with backend none", async () => {
		await fixture(universal());
		const acquire = spyOn(client, "acquireDatabase").mockImplementation(async () => {
			throw new Error("unexpected analysis");
		});
		try {
			const tool = new ReadTool(session);
			expect(textOutput(await tool.execute("slice-metadata", { path: "sample.bin:@x86_64" }))).toContain(
				"selected x86_64 (explicit)",
			);
			expect(textOutput(await tool.execute("slice-page", { path: "sample.bin:@arm64:2-4" }))).toContain(
				"selected arm64 (explicit)",
			);
			expect(acquire).not.toHaveBeenCalled();
		} finally {
			acquire.mockRestore();
		}
	});

	it("plain IDA databases are not opened even when their bytes are not binary", async () => {
		await fixture(Buffer.from("IDA database fixture"), "saved.i64");
		const acquire = spyOn(client, "acquireDatabase").mockImplementation(async () => {
			throw new Error("unexpected analysis");
		});
		try {
			expect(textOutput(await new ReadTool(session).execute("idb-metadata", { path: "saved.i64" }))).toContain(
				"database not opened",
			);
			expect(acquire).not.toHaveBeenCalled();
		} finally {
			acquire.mockRestore();
		}
	});

	it("nonempty views fail clearly when disabled without acquisition", async () => {
		await fixture(elf());
		const acquire = spyOn(client, "acquireDatabase").mockImplementation(async () => {
			throw new Error("unexpected analysis");
		});
		try {
			await expect(new ReadTool(session).execute("disabled-analysis", { path: "sample.bin:main" })).rejects.toThrow(
				"analysis is disabled",
			);
			expect(acquire).not.toHaveBeenCalled();
		} finally {
			acquire.mockRestore();
		}
	});

	it("explicit :overview starts analysis instead of returning on-disk metadata", async () => {
		await fixture(elf());
		session = { ...session, settings: Settings.isolated({ "disassembler.backend": "ghidra" }) };
		const acquire = spyOn(client, "acquireDatabase").mockImplementation(async () => {
			throw new Error("analysis boundary reached");
		});
		try {
			await expect(
				new ReadTool(session).execute("explicit-analysis", { path: "sample.bin:overview" }),
			).rejects.toThrow("analysis boundary reached");
		} finally {
			acquire.mockRestore();
		}
	});

	it("literal colon filenames and :raw retain their existing routes", async () => {
		await fixture(elf());
		await fixture(Buffer.from("literal contents"), "sample.bin:overview");
		expect(
			textOutput(await new ReadTool(session).execute("literal-view-name", { path: "sample.bin:overview" })),
		).toContain("literal contents");
		const raw = await new ReadTool(session).execute("binary-raw", { path: "sample.bin:raw" });
		expect(textOutput(raw)).toContain("\u007fELF");
	});
});
