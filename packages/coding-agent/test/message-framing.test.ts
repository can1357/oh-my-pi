import { describe, expect, it } from "bun:test";
import { MessageFramer } from "../src/jsonrpc/message-framing";

function frame(text: string): Buffer {
	return Buffer.from(`Content-Length: ${Buffer.byteLength(text)}\r\n\r\n${text}`);
}

describe("MessageFramer", () => {
	it("recognizes a header terminator split into single-byte reads", () => {
		const framer = new MessageFramer(Buffer.alloc(0));
		const bytes = Buffer.from(
			"Content-Type: application/vscode-jsonrpc; charset=utf-8\r\ncontent-length:\t2\r\n\r\n{}",
		);
		const messages: string[] = [];
		for (const byte of bytes) {
			framer.push(Buffer.from([byte]));
			messages.push(...framer.drain(() => {}));
		}
		expect(messages).toEqual(["{}"]);
	});

	it("accepts a header at the size limit and rejects one byte beyond it", () => {
		const suffix = "\r\nContent-Length: 2\r\n\r\n";
		const header = "X-Trace: ".padEnd(16 * 1024 - suffix.length, "x") + suffix;
		const accepted = new MessageFramer(Buffer.from(`${header}{}`));
		expect([...accepted.drain(() => {})]).toEqual(["{}"]);
		const rejected = new MessageFramer(Buffer.from(`X${header}{}`));
		expect(() => [...rejected.drain(() => {})]).toThrow(/header.*limit/i);
	});
	it("preserves UTF-8 and coalesced messages at every byte boundary", () => {
		const texts = ['{"text":"🌍你好"}', '{"id":2}'];
		const input = Buffer.concat(texts.map(frame));
		for (let split = 0; split <= input.length; split++) {
			const framer = new MessageFramer(input.subarray(0, split));
			const output = [...framer.drain(() => {})];
			framer.push(input.subarray(split));
			output.push(...framer.drain(() => {}));
			expect(output).toEqual(texts);
			expect(framer.remainder()).toEqual(Buffer.alloc(0));
		}
	});

	it("resumes from an incomplete body after a reader restart", () => {
		const text = '{"text":"αβγ"}';
		const input = frame(text);
		const framer = new MessageFramer(input.subarray(0, input.length - 3));
		expect([...framer.drain(() => {})]).toEqual([]);
		const resumed = new MessageFramer(framer.remainder());
		resumed.push(input.subarray(input.length - 3));
		expect([...resumed.drain(() => {})]).toEqual([text]);
	});

	it("resynchronizes after bounded stdout noise", () => {
		const framer = new MessageFramer(Buffer.concat([Buffer.from("wrapper log\r\n\r\n"), frame("{}")]));
		const headers: string[] = [];
		expect([...framer.drain(header => headers.push(header))]).toEqual(["{}"]);
		expect(headers).toEqual(["wrapper log"]);
	});

	it("rejects oversized incomplete headers and releases their bytes", () => {
		const framer = new MessageFramer(Buffer.alloc(0));
		framer.push(Buffer.alloc(16 * 1024, 97));
		expect(() => [...framer.drain(() => {})]).toThrow(/header.*limit/i);
		expect(framer.remainder()).toEqual(Buffer.alloc(0));
		expect(() => framer.push(frame("{}"))).toThrow(/header.*limit/i);
	});

	for (const length of ["268435457", "-1", "1.5"]) {
		it(`rejects invalid or excessive Content-Length ${length} before receiving a body`, () => {
			const framer = new MessageFramer(Buffer.from(`Content-Length: ${length}\r\n\r\n`));
			expect(() => [...framer.drain(() => {})]).toThrow(/Content-Length/);
			expect(framer.remainder()).toEqual(Buffer.alloc(0));
		});
	}

	it("rejects ambiguous duplicate lengths", () => {
		const framer = new MessageFramer(Buffer.from("Content-Length: 2\r\nContent-Length: 3\r\n\r\n{}x"));
		expect(() => [...framer.drain(() => {})]).toThrow(/Content-Length/);
	});

	it("decodes large valid messages incrementally without confusing body delimiters for headers", () => {
		const text = JSON.stringify({ text: "🌍\r\n\r\n".repeat(512 * 1024) });
		const input = frame(text);
		const framer = new MessageFramer(Buffer.alloc(0));
		const output: string[] = [];
		for (let offset = 0; offset < input.length; offset += 4096) {
			framer.push(input.subarray(offset, offset + 4096));
			output.push(...framer.drain(() => {}));
		}
		expect(output).toEqual([text]);
	});
});
