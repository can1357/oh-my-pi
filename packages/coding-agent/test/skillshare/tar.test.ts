import { describe, expect, test } from "bun:test";
import { readTar, type TarEntry, writeTar } from "../../src/skillshare/tar";

const encoder = new TextEncoder();
const BLOCK = 512;

function bytes(text: string): Uint8Array {
	return encoder.encode(text);
}

/** One ustar header + padded body with a raw `name` field (≤100 bytes) and `type`, checksum fixed up. */
function rawEntry(name: string, type: string, content: Uint8Array = new Uint8Array(0)): Uint8Array {
	const archive = writeTar([{ path: "placeholder", content, executable: false }]);
	const entry = archive.slice(0, archive.length - BLOCK * 2);
	entry.fill(0, 0, 100);
	entry.set(bytes(name), 0);
	entry[156] = type.charCodeAt(0);
	entry.fill(0x20, 148, 156);
	let sum = 0;
	for (let i = 0; i < BLOCK; i++) sum += entry[i];
	entry.set(encoder.encode(`${sum.toString(8).padStart(6, "0")}\0 `), 148);
	return entry;
}

function concat(...parts: Uint8Array[]): Uint8Array {
	const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0) + BLOCK * 2);
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.length;
	}
	return out;
}

function paxBody(path: string): Uint8Array {
	const record = ` path=${path}\n`;
	let length = record.length + 1;
	while (`${length}${record}`.length !== length) length++;
	return bytes(`${length}${record}`);
}

describe("writeTar/readTar", () => {
	test("round-trips long paths, executable bits, empty and multi-block files", () => {
		const longPath = `${"d".repeat(120)}/${"f".repeat(99)}`;
		const entries: TarEntry[] = [
			{ path: "scripts/run.sh", content: bytes("#!/bin/sh\necho hi\n"), executable: true },
			{ path: "SKILL.md", content: bytes("---\nname: x\n---\n"), executable: false },
			{ path: longPath, content: new Uint8Array(1300).fill(7), executable: false },
			{ path: "empty.txt", content: new Uint8Array(0), executable: false },
			{ path: "docs/ünïcode.md", content: bytes("é"), executable: false },
		];
		const read = readTar(writeTar(entries));
		const expected = [...entries].sort((a, b) => Buffer.compare(bytes(a.path), bytes(b.path)));
		expect(read.map(entry => entry.path)).toEqual(expected.map(entry => entry.path));
		for (let i = 0; i < expected.length; i++) {
			expect(read[i].executable).toBe(expected[i].executable);
			expect(Buffer.from(read[i].content).equals(Buffer.from(expected[i].content))).toBe(true);
		}
	});

	test("is deterministic regardless of input order", () => {
		const entries: TarEntry[] = [
			{ path: "b.md", content: bytes("b"), executable: false },
			{ path: "a/c.sh", content: bytes("c"), executable: true },
			{ path: "a.md", content: bytes("a"), executable: false },
		];
		const first = writeTar(entries);
		const second = writeTar([...entries].reverse());
		expect(Buffer.from(first).equals(Buffer.from(second))).toBe(true);
		expect(Buffer.from(first).equals(Buffer.from(writeTar(entries)))).toBe(true);
		// mtime field is zero so rebuilding later yields the same integrity.
		expect(new TextDecoder().decode(first.subarray(136, 147))).toBe("0".repeat(11));
	});

	test("rejects paths that ustar cannot hold and unsafe paths", () => {
		const content = new Uint8Array(0);
		expect(() => writeTar([{ path: `${"a".repeat(200)}/${"b".repeat(60)}`, content, executable: false }])).toThrow(
			/exceeds 255 bytes/,
		);
		expect(() => writeTar([{ path: "x".repeat(150), content, executable: false }])).toThrow(/prefix\/name/);
		expect(() => writeTar([{ path: "../escape", content, executable: false }])).toThrow(/not normalized/);
		expect(() => writeTar([{ path: "/abs", content, executable: false }])).toThrow(/absolute/);
		expect(() =>
			writeTar([
				{ path: "dup", content, executable: false },
				{ path: "dup", content, executable: true },
			]),
		).toThrow(/duplicate/);
	});

	test("reader rejects symlinks and hard links", () => {
		expect(() => readTar(concat(rawEntry("link", "2")))).toThrow(/symlink/);
		expect(() => readTar(concat(rawEntry("hard", "1")))).toThrow(/hard link/);
	});

	test("reader skips directories and honors PAX path and GNU long names", () => {
		const paxPath = `${"p".repeat(180)}/${"q".repeat(120)}.md`;
		const gnuPath = `${"g".repeat(170)}/${"h".repeat(110)}.md`;
		const archive = concat(
			rawEntry("dir/", "5"),
			rawEntry("PaxHeader", "x", paxBody(paxPath)),
			rawEntry("short-a", "0", bytes("pax")),
			rawEntry("././@LongLink", "L", bytes(`${gnuPath}\0`)),
			rawEntry("short-b", "0", bytes("gnu")),
			rawEntry("./plain.txt", "0", bytes("plain")),
		);
		const read = readTar(archive);
		expect(read.map(entry => entry.path)).toEqual([paxPath, gnuPath, "plain.txt"]);
		expect(new TextDecoder().decode(read[0].content)).toBe("pax");
		expect(new TextDecoder().decode(read[1].content)).toBe("gnu");
	});

	test("reader rejects traversal, absolute paths, and corrupted headers", () => {
		const corrupted = rawEntry("safe", "0", bytes("x"));
		corrupted[0] = 0x74;
		expect(() => readTar(concat(corrupted))).toThrow(/checksum/);
		expect(() => readTar(concat(rawEntry("aa/../../etc", "0")))).toThrow(/not normalized/);
		expect(() => readTar(concat(rawEntry("/etc/passwd", "0")))).toThrow(/absolute/);
	});
});
