import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgDisasmBackend } from "@oh-my-pi/pi-coding-agent/disasm/active";
import { formatDatabaseHandle, parseDatabaseHandle } from "@oh-my-pi/pi-coding-agent/disasm/protocol";
import { ghidraHostSupported } from "@oh-my-pi/pi-coding-agent/ghidra/platform";
import { isExecutableHeader, parseFatSlices, selectSlice, splitSliceRef } from "@oh-my-pi/pi-coding-agent/disasm/store";
import { type BinaryView, parseBinaryView } from "@oh-my-pi/pi-coding-agent/tools/read-binary";

describe("isExecutableHeader", () => {
	const cases: Array<[string, number[], boolean]> = [
		["ELF", [0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00], true],
		[
			"PE (DOS header, e_lfanew=0x80)",
			[0x4d, 0x5a, ...Array.from({ length: 58 }, () => 0), 0x80, 0x00, 0x00, 0x00],
			true,
		],
		["8-byte MZ blob", [0x4d, 0x5a, 0xff, 0xfe, 0xc0, 0xc0, 0x90, 0x91], false],
		["Mach-O 32 BE", [0xfe, 0xed, 0xfa, 0xce, 0, 0, 0, 0], true],
		["Mach-O 32 LE", [0xce, 0xfa, 0xed, 0xfe, 0, 0, 0, 0], true],
		["Mach-O 64 BE", [0xfe, 0xed, 0xfa, 0xcf, 0, 0, 0, 0], true],
		["Mach-O 64 LE", [0xcf, 0xfa, 0xed, 0xfe, 0, 0, 0, 0], true],
		["fat Mach-O, nfat_arch=2", [0xca, 0xfe, 0xba, 0xbe, 0x00, 0x00, 0x00, 0x02], true],
		["Java 8 class", [0xca, 0xfe, 0xba, 0xbe, 0x00, 0x00, 0x00, 0x34], false],
		["PNG", [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], false],
		["shorter than 4 bytes", [0x7f, 0x45, 0x4c], false],
	];
	for (const [name, bytes, expected] of cases) {
		it(`${name} → ${expected}`, () => {
			expect(isExecutableHeader(new Uint8Array(bytes))).toBe(expected);
		});
	}
});

/** Big-endian fat header; each entry is `[cputype, cpusubtype, offset, size]`. */
function fatHeader(entries: Array<[number, number, number, number]>, { is64 = false } = {}): Uint8Array {
	const entrySize = is64 ? 32 : 20;
	const view = new DataView(new ArrayBuffer(8 + entries.length * entrySize));
	view.setUint32(0, is64 ? 0xcafebabf : 0xcafebabe);
	view.setUint32(4, entries.length);
	entries.forEach(([cpuType, subtype, offset, size], i) => {
		const at = 8 + i * entrySize;
		view.setUint32(at, cpuType);
		view.setUint32(at + 4, subtype);
		if (is64) {
			view.setBigUint64(at + 8, BigInt(offset));
			view.setBigUint64(at + 16, BigInt(size));
		} else {
			view.setUint32(at + 8, offset);
			view.setUint32(at + 12, size);
		}
	});
	return new Uint8Array(view.buffer);
}

describe("universal Mach-O slices", () => {
	// Mirrors macOS 27 /usr/bin/yes: x86_64, arm64e (pointer-auth capability bit set), and an arm64 subtype lipo cannot name.
	const yes = fatHeader([
		[0x01000007, 3, 0x4000, 0x100],
		[0x0100000c, 0x80000002, 0x110000, 0x200],
		[0x0100000c, 0x8000000c, 0x224000, 0x200],
	]);

	it("names slices like lipo, masking capability bits", () => {
		expect(parseFatSlices(yes)?.map(s => s.arch)).toEqual(["x86_64", "arm64e", "arm64.12"]);
	});

	it("reads 64-bit fat_arch offsets", () => {
		const slices = parseFatSlices(fatHeader([[0x0100000c, 0, 0x1_0000_0000, 0x10]], { is64: true }));
		expect(slices).toEqual([{ arch: "arm64", cpuType: 0x0100000c, offset: 0x1_0000_0000, size: 0x10 }]);
	});

	it("rejects a slice table cut short", () => {
		expect(parseFatSlices(yes.subarray(0, yes.length - 1))).toBeNull();
	});

	it("defaults to the host CPU slice rather than the first", () => {
		const slices = parseFatSlices(yes) ?? [];
		const expected = process.arch === "arm64" ? "arm64e" : "x86_64";
		expect(selectSlice(slices).arch).toBe(expected);
	});

	it("lists available slices for an unknown arch", () => {
		expect(() => selectSlice(parseFatSlices(yes) ?? [], "ppc")).toThrow("no ppc slice; available: x86_64, arm64e");
	});

	it("splits a trailing :@arch off a db reference", () => {
		expect(splitSliceRef("bin/yes:@x86_64")).toEqual({ path: "bin/yes", arch: "x86_64" });
		expect(splitSliceRef("bin/yes")).toEqual({ path: "bin/yes" });
		expect(() => splitSliceRef("bin/yes:@")).toThrow("empty slice name");
	});
});

describe("parseBinaryView", () => {
	const cases: Array<[string, BinaryView]> = [
		["", { kind: "overview" }],
		["overview", { kind: "overview" }],
		["imports", { kind: "imports" }],
		["main:asm", { kind: "asm", target: "main" }],
		["xrefs:0x401000", { kind: "xrefs", target: "0x401000" }],
		["sub_1000", { kind: "pseudocode", target: "sub_1000" }],
	];
	for (const [view, expected] of cases) {
		it(`${JSON.stringify(view)} → ${expected.kind}`, () => {
			expect(parseBinaryView(view)).toEqual(expected);
		});
	}

	it("rejects xrefs without a target", () => {
		expect(() => parseBinaryView("xrefs:")).toThrow("xrefs needs a target");
	});
});

describe("disassembler backend selection", () => {
	let withIdalib: string;
	let withoutIdalib: string;
	let withBinja: string;
	let withoutBinja: string;

	beforeAll(async () => {
		withIdalib = await fs.mkdtemp(path.join(os.tmpdir(), "ida-install-"));
		withoutIdalib = await fs.mkdtemp(path.join(os.tmpdir(), "ida-empty-"));
		withBinja = await fs.mkdtemp(path.join(os.tmpdir(), "binja-install-"));
		withoutBinja = await fs.mkdtemp(path.join(os.tmpdir(), "binja-empty-"));
		for (const lib of ["libidalib.dylib", "libidalib.so", "idalib.dll"]) {
			await Bun.write(path.join(withIdalib, lib), "");
		}
		for (const lib of ["libbinaryninjacore.so.1", "libbinaryninjacore.dylib", "binaryninjacore.dll"]) {
			await Bun.write(path.join(withBinja, lib), "");
		}
	});

	afterAll(async () => {
		for (const dir of [withIdalib, withoutIdalib, withBinja, withoutBinja]) {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("prefers an idalib install", () => {
		const settings = Settings.isolated({ "ida.installDir": withIdalib });
		expect(cfgDisasmBackend.get(settings)).toBe("ida");
	});

	it("disables every backend even with an idalib install", () => {
		expect(
			cfgDisasmBackend.get(Settings.isolated({ "disassembler.backend": "none", "ida.installDir": withIdalib })),
		).toBeUndefined();
	});

	it("does not fall back when IDA is explicitly selected but unavailable", () => {
		expect(
			cfgDisasmBackend.get(Settings.isolated({ "disassembler.backend": "ida", "ida.installDir": withoutIdalib })),
		).toBeUndefined();
	});

	it("falls back to Ghidra without idalib on supported hosts", () => {
		const settings = Settings.isolated({ "ida.installDir": withoutIdalib });
		expect(cfgDisasmBackend.get(settings)).toBe(ghidraHostSupported() ? "ghidra" : undefined);
	});

	it("honors explicit Ghidra selection despite an idalib install", () => {
		expect(
			cfgDisasmBackend.get(Settings.isolated({ "disassembler.backend": "ghidra", "ida.installDir": withIdalib })),
		).toBe(ghidraHostSupported() ? "ghidra" : undefined);
	});

	it("keeps IDA first in auto when Binary Ninja is installed too", () => {
		const settings = Settings.isolated({ "ida.installDir": withIdalib, "binja.installDir": withBinja });
		expect(cfgDisasmBackend.get(settings)).toBe("ida");
	});

	it("never picks Binary Ninja in auto, even where it is the only backend installed", () => {
		const settings = Settings.isolated({ "ida.installDir": withoutIdalib, "binja.installDir": withBinja });
		expect(cfgDisasmBackend.get(settings)).toBe(ghidraHostSupported() ? "ghidra" : undefined);
	});

	it("honors explicit Binary Ninja selection despite an idalib install", () => {
		expect(
			cfgDisasmBackend.get(
				Settings.isolated({
					"disassembler.backend": "binja",
					"ida.installDir": withIdalib,
					"binja.installDir": withBinja,
				}),
			),
		).toBe("binja");
	});

	it("does not fall back when Binary Ninja is explicitly selected but unavailable", () => {
		expect(
			cfgDisasmBackend.get(
				Settings.isolated({
					"disassembler.backend": "binja",
					"ida.installDir": withIdalib,
					"binja.installDir": withoutBinja,
				}),
			),
		).toBeUndefined();
	});

	it("selects radare2 explicitly when configured", async () => {
		const r2 = path.join(withoutIdalib, "radare2");
		await Bun.write(r2, "");
		await fs.chmod(r2, 0o755);
		expect(
			cfgDisasmBackend.get(Settings.isolated({ "disassembler.backend": "radare2", "radare2.r2Path": r2 })),
		).toBe("radare2");
	});
});

describe("database handles", () => {
	const instance = "0b9d2a52-6c1f-4f0e-9a57-3d1c5e8f7a10";

	it("round-trips a Binary Ninja handle", () => {
		const handle = formatDatabaseHandle({ backend: "binja", id: "1a2b3c4d5e6f7a8b-true", instance });
		expect(handle).toBe(`dsm://binja/1a2b3c4d5e6f7a8b-true/${instance}`);
		expect(parseDatabaseHandle(handle)).toEqual({ backend: "binja", id: "1a2b3c4d5e6f7a8b-true", instance });
	});

	it("rejects a handle whose host is not a backend", () => {
		expect(() => parseDatabaseHandle(`dsm://radare/1a2b3c4d5e6f7a8b-true/${instance}`)).toThrow("Invalid dsm handle");
	});

	it("leaves ordinary paths to the caller", () => {
		expect(parseDatabaseHandle("/tmp/binja/sample")).toBeUndefined();
	});
});
