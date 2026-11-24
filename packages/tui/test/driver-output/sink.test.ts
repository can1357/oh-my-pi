import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CONPTY_CHUNK_BYTES, chunkForConPTY, streamSink } from "@oh-my-pi/pi-tui/driver/output/sink";

function fakeStream() {
	const writes: string[] = [];
	return {
		writes,
		stream: { write: (data: string) => (writes.push(data), true), writableLength: 42, once: () => {} },
	};
}

describe("streamSink", () => {
	it("splits large writes for a ConPTY host at line terminators, keeping every byte", () => {
		const rows = Array.from({ length: 600 }, (_, i) => `\x1b[${i + 1};1Hrow ${i} ${"é".repeat(30)}\r`).join("");
		const chunks = chunkForConPTY(rows);
		expect(chunks.length).toBeGreaterThan(1);
		expect(chunks.join("")).toBe(rows);
		for (const chunk of chunks) {
			expect(Buffer.byteLength(chunk)).toBeLessThanOrEqual(CONPTY_CHUNK_BYTES);
			expect(chunk.endsWith("\r")).toBe(true);
		}
		const { writes, stream } = fakeStream();
		streamSink(stream, { conpty: () => true }).write(rows);
		expect(writes).toEqual(chunks);
	});

	it("never splits a CRLF pair or a surrogate pair", () => {
		const text = `${"a".repeat(9)}\r\n${"😀".repeat(10)}`;
		for (const chunk of chunkForConPTY(text, 10)) {
			expect(chunk.endsWith("\r")).toBe(false);
			expect(/[\ud800-\udbff]$/.test(chunk)).toBe(false);
		}
		expect(chunkForConPTY(text, 10).join("")).toBe(text);
	});

	it("writes once outside ConPTY and reports the backlog", () => {
		const { writes, stream } = fakeStream();
		const sink = streamSink(stream, { conpty: () => false });
		sink.write("x".repeat(CONPTY_CHUNK_BYTES * 2));
		expect(writes).toHaveLength(1);
		expect(sink.pending()).toBe(42);
	});

	it("logs writes to PI_TUI_WRITE_LOG with clipboard payloads reduced to their length", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ui-sink-"));
		const log = path.join(dir, "writes.log");
		try {
			const { stream } = fakeStream();
			streamSink(stream, { logPath: log }).write("a\x1b]52;c;c2VjcmV0\x07b");
			expect(fs.readFileSync(log, "utf8")).toBe("a\x1b]52;c;<8 bytes>\x07b");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
