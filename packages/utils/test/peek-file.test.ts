import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { peekFile, peekFileEnds, peekFileSync, peekFileTail } from "@oh-my-pi/pi-utils/peek-file";

function rangeBuffer(length: number, offset = 0): Buffer {
	return Buffer.from(Array.from({ length }, (_, index) => (index + offset) % 256));
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

	it("keeps a retained 512-byte slice stable across later peeks", async () => {
		const firstPath = path.join(tempDir, "first.bin");
		const secondPath = path.join(tempDir, "second.bin");
		const firstContent = Buffer.alloc(512, 0x11);
		fs.writeFileSync(firstPath, firstContent);
		fs.writeFileSync(secondPath, Buffer.alloc(512, 0xee));

		const retained = await peekFile(firstPath, 512, bytes => bytes.slice());
		await peekFile(secondPath, 512, bytes => bytes[0]);

		expect(bytesOf(retained)).toEqual(bytesOf(firstContent));
	});

	it("gives callbacks Uint8Array slice copy semantics", async () => {
		const filePath = path.join(tempDir, "slice.bin");
		const content = rangeBuffer(32, 71);
		fs.writeFileSync(filePath, content);

		const sliced = await peekFile(filePath, content.length, bytes => {
			const result = bytes.slice();
			bytes.fill(0);
			return result;
		});

		expect(bytesOf(sliced)).toEqual(bytesOf(content));
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

	it("reads an exact tail slice ending at EOF with Uint8Array slice semantics", async () => {
		const filePath = path.join(tempDir, "sample.bin");
		const content = rangeBuffer(1024);
		fs.writeFileSync(filePath, content);

		const tail = await peekFileTail(filePath, 37, bytes => {
			const result = bytes.slice();
			bytes.fill(0);
			return result;
		});
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

		const [head, tail] = await peekFileEnds(filePath, 37, 41, (headBytes, tailBytes) => {
			const result = [headBytes.slice(), tailBytes.slice()] as const;
			headBytes.fill(0);
			tailBytes.fill(0);
			return result;
		});
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

	it("reads distinct head and tail content across 512-byte boundaries", async () => {
		const cases = [511, 512, 513].map((headLength, index) => {
			const filePath = path.join(tempDir, `boundary-${headLength}.bin`);
			const content = rangeBuffer(2048, 79 * (index + 1));
			fs.writeFileSync(filePath, content);
			return { content, filePath, headLength, tailLength: headLength + 1 };
		});

		const slices = await Promise.all(
			cases.map(({ filePath, headLength, tailLength }) =>
				peekFileEnds(filePath, headLength, tailLength, (headBytes, tailBytes) => [
					headBytes.slice(),
					tailBytes.slice(),
				]),
			),
		);
		for (const [index, [head, tail]] of slices.entries()) {
			const { content, headLength, tailLength } = cases[index];
			expect(bytesOf(head)).toEqual(bytesOf(content.subarray(0, headLength)));
			expect(bytesOf(tail)).toEqual(bytesOf(content.subarray(content.length - tailLength)));
		}
	});
});
