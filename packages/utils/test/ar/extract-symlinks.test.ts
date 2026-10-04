import { afterEach, describe, expect, test, vi } from "bun:test";
import * as fsSync from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { extractArchive } from "../../src/ar/open";

const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");

afterEach(() => {
	vi.restoreAllMocks();
	if (platformDescriptor) Object.defineProperty(process, "platform", platformDescriptor);
});

// ── Minimal ZIP writer (STORE, Unix host) so tests can ship symlinks ──────────

const CRC_TABLE = new Uint32Array(256).map((_, index) => {
	let value = index;
	for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
	return value >>> 0;
});

function crc32(bytes: Uint8Array): number {
	let crc = 0xffffffff;
	for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
	return (crc ^ 0xffffffff) >>> 0;
}

interface ZipMember {
	name: string;
	content?: Uint8Array;
	symlink?: boolean;
}

/** A STORE-method ZIP with Unix attributes, so symlink members survive the reader. */
function buildZip(members: readonly ZipMember[]): Uint8Array {
	const encoder = new TextEncoder();
	const parts: Uint8Array[] = [];
	const directory: Uint8Array[] = [];
	let offset = 0;
	for (const member of members) {
		const name = encoder.encode(member.name);
		const content = member.content ?? new Uint8Array(0);
		const mode = member.symlink ? 0o120777 : member.name.endsWith("/") ? 0o40755 : 0o100644;
		const externalAttrs = (mode << 16) | (member.name.endsWith("/") ? 0x10 : 0);
		const crc = crc32(content);

		const local = new Uint8Array(30 + name.byteLength);
		const view = new DataView(local.buffer);
		view.setUint32(0, 0x04034b50, true);
		view.setUint16(4, 20, true);
		view.setUint16(6, 0x0800, true);
		view.setUint16(8, 0, true);
		view.setUint32(14, crc, true);
		view.setUint32(18, content.byteLength, true);
		view.setUint32(22, content.byteLength, true);
		view.setUint16(26, name.byteLength, true);
		local.set(name, 30);
		parts.push(local, content);

		const central = new Uint8Array(46 + name.byteLength);
		const centralView = new DataView(central.buffer);
		centralView.setUint32(0, 0x02014b50, true);
		centralView.setUint16(4, (3 << 8) | 20, true);
		centralView.setUint16(6, 20, true);
		centralView.setUint16(8, 0x0800, true);
		centralView.setUint16(10, 0, true);
		centralView.setUint32(16, crc, true);
		centralView.setUint32(20, content.byteLength, true);
		centralView.setUint32(24, content.byteLength, true);
		centralView.setUint16(28, name.byteLength, true);
		centralView.setUint32(38, externalAttrs, true);
		centralView.setUint32(42, offset, true);
		central.set(name, 46);
		directory.push(central);

		offset += local.byteLength + content.byteLength;
	}
	const directorySize = directory.reduce((sum, part) => sum + part.byteLength, 0);
	const end = new Uint8Array(22);
	const endView = new DataView(end.buffer);
	endView.setUint32(0, 0x06054b50, true);
	endView.setUint16(8, members.length, true);
	endView.setUint16(10, members.length, true);
	endView.setUint32(12, directorySize, true);
	endView.setUint32(16, offset, true);

	const total = offset + directorySize + end.byteLength;
	const archive = new Uint8Array(total);
	let cursor = 0;
	for (const part of [...parts, ...directory, end]) {
		archive.set(part, cursor);
		cursor += part.byteLength;
	}
	return archive;
}

/** A ZIP with a real file, a directory symlink (`alias -> data`), and a file symlink (`link.txt -> data/file.txt`). */
function symlinkedZip(): Uint8Array {
	const encoder = new TextEncoder();
	return buildZip([
		{ name: "data/" },
		{ name: "data/file.txt", content: encoder.encode("hello through a link\n") },
		{ name: "alias", content: encoder.encode("data"), symlink: true },
		{ name: "link.txt", content: encoder.encode("data/file.txt"), symlink: true },
	]);
}

// ── extractArchive symlink handling ──────────────────────────────────────────

describe("extractArchive symlink handling", () => {
	test.skipIf(process.platform === "win32")("materializes zip symlinks as real symlinks", async () => {
		const dest = fsSync.mkdtempSync(path.join(os.tmpdir(), "omp-ar-link-"));
		const count = await extractArchive({ bytes: symlinkedZip(), format: "zip" }, dest);

		expect(count).toBe(4);
		expect(fsSync.statSync(path.join(dest, "alias")).isDirectory()).toBe(true);
		expect(fsSync.readFileSync(path.join(dest, "link.txt"), "utf8")).toBe("hello through a link\n");
	});

	test("degrades directory symlinks to junctions and file symlinks to copies on Windows EPERM", async () => {
		// Failure mode: Windows denies fs.symlink with EPERM unless the caller
		// holds the symlink privilege (developer mode or admin), and one
		// refused link failed the whole extraction.
		if (!platformDescriptor) throw new Error("process.platform descriptor is unavailable");
		Object.defineProperty(process, "platform", { ...platformDescriptor, value: "win32" });
		const realSymlink = fsPromises.symlink;
		const symlink = vi.spyOn(fsPromises, "symlink").mockImplementation(async (target, outputPath, type) => {
			if (type === "junction") return realSymlink(target, outputPath, "junction");
			const error = new Error("operation not permitted") as NodeJS.ErrnoException;
			error.code = "EPERM";
			throw error;
		});

		const dest = fsSync.mkdtempSync(path.join(os.tmpdir(), "omp-ar-eprem-"));
		const count = await extractArchive({ bytes: symlinkedZip(), format: "zip" }, dest);

		// The directory alias survives as a junction; the file link as a copy.
		expect(count).toBe(4);
		expect(symlink).toHaveBeenCalledWith(expect.any(String), path.join(dest, "alias"), "junction");
		expect(fsSync.statSync(path.join(dest, "alias")).isDirectory()).toBe(true);
		expect(fsSync.readFileSync(path.join(dest, "link.txt"), "utf8")).toBe("hello through a link\n");
		expect(fsSync.lstatSync(path.join(dest, "link.txt")).isSymbolicLink()).toBe(false);
	});
});
