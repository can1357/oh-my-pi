import { describe, expect, it } from "bun:test";
import { encodeTspMessage, parseTspMessage, splitTspMessage, TspReader } from "@oh-my-pi/pi-tui/native/encode";
import type { TspEvent } from "@oh-my-pi/pi-wire";

const encoder = new TextEncoder();

/** Split a byte stream of APC messages into complete `ESC _ … ESC \` strings. */
function messages(stream: string): string[] {
	return stream
		.split("\x1b\\")
		.filter(Boolean)
		.map(part => `${part}\x1b\\`);
}

describe("TSP framing", () => {
	it("chunks a body over the APC limit and reassembles it byte-exact, never splitting a code point", () => {
		const body = JSON.stringify({ text: 'ab€漢字🙂🙃 é\u001b"quote" '.repeat(9) });
		const limit = 23;
		const chunks = messages(encodeTspMessage("f", body, undefined, limit)).map(message => splitTspMessage(message)!);

		expect(chunks.length).toBeGreaterThan(1);
		const ids = new Set(chunks.map(chunk => chunk.params.c));
		expect(ids.size).toBe(1);
		expect(chunks.map(chunk => chunk.params.m)).toEqual([...Array(chunks.length - 1).fill("1"), undefined]);
		for (const chunk of chunks) {
			expect(chunk.verb).toBe("f");
			expect(encoder.encode(chunk.body).length).toBeLessThanOrEqual(limit);
			// Each chunk is whole UTF-8: no lone surrogates survive encoding.
			expect(chunk.body.isWellFormed()).toBe(true);
			expect(chunk.body).not.toContain("\x1b");
		}
		const joined = Buffer.concat(chunks.map(chunk => encoder.encode(chunk.body)));
		expect(joined.equals(Buffer.from(encoder.encode(body)))).toBe(true);
	});

	it("sends a body at the limit as a single unchunked message", () => {
		const body = "x".repeat(40);
		const stream = encodeTspMessage("f", body, undefined, 40);
		expect(stream).toBe(`\x1b_tsp;f;${body}\x1b\\`);
	});

	it("reassembles chunked terminal events and tolerates unknown fields", () => {
		const reader = new TspReader();
		const event = JSON.stringify({ ev: "toggle", sf: "s:1", id: "a.b", collapsed: false, future: { x: 1 } });
		const decoded = messages(encodeTspMessage("e", event, undefined, 8)).map(message => reader.feed(message));
		expect(decoded.slice(0, -1).every(message => message === null)).toBe(true);
		// Unknown fields survive decoding untouched.
		const last: unknown = decoded.at(-1);
		expect(last).toEqual({
			verb: "e",
			event: { ev: "toggle", sf: "s:1", id: "a.b", collapsed: false, future: { x: 1 } },
		});
	});

	it("decodes prefs change events whatever their value", () => {
		for (const value of [true, 50, "branch", ["c", "a"], null]) {
			const event: TspEvent = { ev: "change", sf: "s:1", id: "pf", item: "task.isolation.merge", value };
			expect(parseTspMessage(`\x1b_tsp;e;${JSON.stringify(event)}\x1b\\`)).toEqual({ verb: "e", event });
		}
		expect(parseTspMessage('\x1b_tsp;e;{"ev":"change","sf":"s:1","id":"pf"}\x1b\\')).toBeNull();
	});

	it("rejects malformed replies and events", () => {
		expect(parseTspMessage('\x1b_tsp;r;{"r":"hello","v":1,"term":"tern"}\x1b\\')).toBeNull();
		expect(parseTspMessage('\x1b_tsp;e;{"ev":"ack"}\x1b\\')).toBeNull();
		expect(parseTspMessage("\x1b_tsp;e;{not json\x1b\\")).toBeNull();
		expect(parseTspMessage('\x1b_tsp;f;{"sf":"s:1","s":1,"ops":[]}\x1b\\')).toBeNull();
		expect(parseTspMessage('\x1b_25a1;e;{"ev":"ack","s":1}\x1b\\')).toBeNull();
		const tolerant: unknown = parseTspMessage(
			'\x1b_tsp;r;{"r":"hello","v":1,"term":"tern","kinds":["col"],"x":2}\x1b\\',
		);
		expect(tolerant).toEqual({
			verb: "r",
			reply: { r: "hello", v: 1, term: "tern", kinds: ["col"], x: 2 },
		});
	});
});
