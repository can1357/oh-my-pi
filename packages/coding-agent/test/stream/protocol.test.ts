import { describe, expect, it } from "bun:test";
import { StreamLineReader } from "@oh-my-pi/pi-coding-agent/stream/protocol";

function collect(reader: StreamLineReader, chunks: Buffer[]): { lines: string[]; ok: boolean } {
	const lines: string[] = [];
	let ok = true;
	for (const chunk of chunks) {
		ok = reader.push(chunk, line => {
			lines.push(line);
			return true;
		});
		if (!ok) break;
	}
	return { lines, ok };
}

describe("StreamLineReader", () => {
	it("does not merge lines when appending compacts the pending tail", () => {
		const tail = "z".repeat(4093);
		const { lines, ok } = collect(new StreamLineReader(), [
			Buffer.from("abc"),
			Buffer.from("def\nghi"),
			Buffer.from(`X\nY\n${tail}`),
			Buffer.from("\n"),
		]);
		expect(ok).toBe(true);
		expect(lines).toEqual(["abcdef", "ghiX", "Y", tail]);
	});

	it("splits lines across chunks, strips CR, and keeps multi-byte characters intact", () => {
		const bytes = Buffer.from("first\r\nsé€ond\n\nthird line\n", "utf8");
		for (const size of [1, 2, 3, 5, bytes.length]) {
			const chunks: Buffer[] = [];
			for (let index = 0; index < bytes.length; index += size) chunks.push(bytes.subarray(index, index + size));
			expect(collect(new StreamLineReader(), chunks)).toEqual({
				lines: ["first", "sé€ond", "", "third line"],
				ok: true,
			});
		}
	});

	it("rejects a line over the cap whether or not it is terminated", () => {
		expect(collect(new StreamLineReader(8), [Buffer.from("123456789\n")]).ok).toBe(false);
		expect(collect(new StreamLineReader(8), [Buffer.from("12345"), Buffer.from("6789")]).ok).toBe(false);
		expect(collect(new StreamLineReader(8), [Buffer.from("1234"), Buffer.from("5678\nok\n")])).toEqual({
			lines: ["12345678", "ok"],
			ok: true,
		});
	});

	it("stops at the first line the handler rejects", () => {
		const seen: string[] = [];
		const ok = new StreamLineReader().push(Buffer.from("a\nb\nc\n"), line => {
			seen.push(line);
			return line !== "b";
		});
		expect(ok).toBe(false);
		expect(seen).toEqual(["a", "b"]);
	});

	it("reassembles a long line delivered in many small chunks", () => {
		const line = "x".repeat(200_000);
		const bytes = Buffer.from(`${line}\nnext\n`);
		const chunks: Buffer[] = [];
		for (let index = 0; index < bytes.length; index += 1000) chunks.push(bytes.subarray(index, index + 1000));
		expect(collect(new StreamLineReader(), chunks)).toEqual({ lines: [line, "next"], ok: true });
	});
});
