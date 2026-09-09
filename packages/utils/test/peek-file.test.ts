import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { peekFile, peekFileEnds, peekFileSync, peekFileTail } from "@oh-my-pi/pi-utils/peek-file";

function rangeBuffer(length: number): Buffer {
	return Buffer.from(Array.from({ length }, (_, index) => index % 256));
}

function bytesOf(input: Uint8Array): number[] {
	return Array.from(input);
}

describe("peekFile", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-peek-file-"));
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it("reads an exact header slice asynchronously", async () => {
		const filePath = path.join(tempDir, "sample.bin");
		const content = rangeBuffer(1024);
		fs.writeFileSync(filePath, content);

		const header = await peekFile(filePath, 37, bytes => bytes.slice());
		expect(bytesOf(header)).toEqual(bytesOf(content.subarray(0, 37)));
	});

	it("reads an exact header slice synchronously", () => {
		const filePath = path.join(tempDir, "sample.bin");
		const content = rangeBuffer(2048);
		fs.writeFileSync(filePath, content);

		const header = peekFileSync(filePath, 777, bytes => bytes.slice());
		expect(bytesOf(header)).toEqual(bytesOf(content.subarray(0, 777)));
	});

	it("serves concurrent async peeks without corrupting buffers", async () => {
		const filePath = path.join(tempDir, "sample.bin");
		const content = rangeBuffer(4096);
		fs.writeFileSync(filePath, content);

		const lengths = [17, 33, 64, 128, 257, 511, 512, 513, 777, 1024, 1536, 2048];
		const headers = await Promise.all(lengths.map(length => peekFile(filePath, length, bytes => bytes.slice())));
		expect(headers).toHaveLength(lengths.length);
		for (const [index, header] of headers.entries()) {
			expect(bytesOf(header)).toEqual(bytesOf(content.subarray(0, lengths[index])));
		}
	});
});

describe("peekFileTail", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-peek-tail-"));
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it("reads an exact tail slice ending at EOF", async () => {
		const filePath = path.join(tempDir, "sample.bin");
		const content = rangeBuffer(1024);
		fs.writeFileSync(filePath, content);

		// `op` must copy out of the pooled buffer; the pool reuses slots between calls.
		const tail = await peekFileTail(filePath, 37, bytes => Uint8Array.from(bytes));
		expect(bytesOf(tail)).toEqual(bytesOf(content.subarray(content.length - 37)));
	});

	it("returns the whole file when shorter than the budget", async () => {
		const filePath = path.join(tempDir, "small.bin");
		const content = rangeBuffer(20);
		fs.writeFileSync(filePath, content);

		const tail = await peekFileTail(filePath, 4096, bytes => Uint8Array.from(bytes));
		expect(bytesOf(tail)).toEqual(bytesOf(content));
	});

	it("returns empty for a non-positive budget", async () => {
		const filePath = path.join(tempDir, "z.bin");
		fs.writeFileSync(filePath, rangeBuffer(64));
		expect(bytesOf(await peekFileTail(filePath, 0, bytes => Uint8Array.from(bytes)))).toEqual([]);
	});

	it("serves concurrent tail peeks across pool and alloc paths", async () => {
		const filePath = path.join(tempDir, "sample.bin");
		const content = rangeBuffer(4096);
		fs.writeFileSync(filePath, content);

		const lengths = [17, 33, 64, 128, 257, 511, 512, 513, 777, 1024, 1536, 2048];
		const tails = await Promise.all(
			lengths.map(length => peekFileTail(filePath, length, bytes => Uint8Array.from(bytes))),
		);
		expect(tails).toHaveLength(lengths.length);
		for (const [index, tail] of tails.entries()) {
			expect(bytesOf(tail)).toEqual(bytesOf(content.subarray(content.length - lengths[index])));
		}
	});
});

describe("peekFileEnds", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-peek-ends-"));
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it("reads exact head and tail slices from a larger file", async () => {
		const filePath = path.join(tempDir, "sample.bin");
		const content = rangeBuffer(2048);
		fs.writeFileSync(filePath, content);

		const [head, tail] = await peekFileEnds(filePath, 37, 41, (headBytes, tailBytes) => [
			Uint8Array.from(headBytes),
			Uint8Array.from(tailBytes),
		]);
		expect(bytesOf(head)).toEqual(bytesOf(content.subarray(0, 37)));
		expect(bytesOf(tail)).toEqual(bytesOf(content.subarray(content.length - 41)));
	});

	it("returns the whole file for both windows when it fits in the head budget", async () => {
		const filePath = path.join(tempDir, "small.bin");
		const content = rangeBuffer(20);
		fs.writeFileSync(filePath, content);

		const [head, tail] = await peekFileEnds(filePath, 4096, 4096, (headBytes, tailBytes) => [
			Uint8Array.from(headBytes),
			Uint8Array.from(tailBytes),
		]);
		expect(bytesOf(head)).toEqual(bytesOf(content));
		expect(bytesOf(tail)).toEqual(bytesOf(content));
	});

	it("returns an empty tail when the suffix budget is zero", async () => {
		const filePath = path.join(tempDir, "head-only.bin");
		const content = rangeBuffer(64);
		fs.writeFileSync(filePath, content);

		const [head, tail] = await peekFileEnds(filePath, 8, 0, (headBytes, tailBytes) => [
			Uint8Array.from(headBytes),
			Uint8Array.from(tailBytes),
		]);
		expect(bytesOf(head)).toEqual(bytesOf(content.subarray(0, 8)));
		expect(bytesOf(tail)).toEqual([]);
	});

	it("returns an empty head when the prefix budget is zero", async () => {
		const filePath = path.join(tempDir, "tail-only.bin");
		const content = rangeBuffer(64);
		fs.writeFileSync(filePath, content);

		const [head, tail] = await peekFileEnds(filePath, 0, 9, (headBytes, tailBytes) => [
			Uint8Array.from(headBytes),
			Uint8Array.from(tailBytes),
		]);
		expect(bytesOf(head)).toEqual([]);
		expect(bytesOf(tail)).toEqual(bytesOf(content.subarray(content.length - 9)));
	});

	it("returns two empty slices without opening when both budgets are zero", async () => {
		const missingPath = path.join(tempDir, "missing.bin");
		const [head, tail] = await peekFileEnds(missingPath, 0, 0, (headBytes, tailBytes) => [
			Uint8Array.from(headBytes),
			Uint8Array.from(tailBytes),
		]);
		expect(bytesOf(head)).toEqual([]);
		expect(bytesOf(tail)).toEqual([]);
	});

	it("serves concurrent head and tail peeks without corrupting buffers", async () => {
		const filePath = path.join(tempDir, "sample.bin");
		const content = rangeBuffer(4096);
		fs.writeFileSync(filePath, content);

		const lengths = [17, 33, 64, 128, 257, 511, 512, 513, 777, 1024, 1536, 2048];
		const slices = await Promise.all(
			lengths.map(length =>
				peekFileEnds(filePath, length, length + 1, (headBytes, tailBytes) => [
					Uint8Array.from(headBytes),
					Uint8Array.from(tailBytes),
				]),
			),
		);
		expect(slices).toHaveLength(lengths.length);
		for (const [index, [head, tail]] of slices.entries()) {
			const headLength = lengths[index];
			const tailLength = headLength + 1;
			expect(bytesOf(head)).toEqual(bytesOf(content.subarray(0, headLength)));
			expect(bytesOf(tail)).toEqual(bytesOf(content.subarray(content.length - tailLength)));
		}
	});
});
