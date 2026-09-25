import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgIdaAvailable, cfgIdaInstall } from "@oh-my-pi/pi-coding-agent/ida/install";
import { isExecutableHeader, parseFatSlices, selectSlice, splitSliceRef } from "@oh-my-pi/pi-coding-agent/ida/store";
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

describe("IDA availability", () => {
	let withIdalib: string;
	let withoutIdalib: string;

	beforeAll(async () => {
		withIdalib = await fs.mkdtemp(path.join(os.tmpdir(), "ida-install-"));
		withoutIdalib = await fs.mkdtemp(path.join(os.tmpdir(), "ida-empty-"));
		for (const lib of ["libidalib.dylib", "libidalib.so", "idalib.dll"]) {
			await Bun.write(path.join(withIdalib, lib), "");
		}
	});

	afterAll(async () => {
		await fs.rm(withIdalib, { recursive: true, force: true });
		await fs.rm(withoutIdalib, { recursive: true, force: true });
	});

	it("exposes IDA when the configured install ships idalib", () => {
		const settings = Settings.isolated({ "ida.installDir": withIdalib });
		expect(cfgIdaInstall.get(settings)).toBe(withIdalib);
		expect(cfgIdaAvailable.get(settings)).toBe(true);
	});

	it("hides IDA when the configured install lacks idalib, without falling back", () => {
		expect(cfgIdaAvailable.get(Settings.isolated({ "ida.installDir": withoutIdalib }))).toBe(false);
	});

	it("hides IDA when disabled even with a valid install", () => {
		expect(cfgIdaAvailable.get(Settings.isolated({ "ida.enabled": false, "ida.installDir": withIdalib }))).toBe(
			false,
		);
	});
});
