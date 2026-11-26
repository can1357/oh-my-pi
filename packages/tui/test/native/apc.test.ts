import { describe, expect, it } from "bun:test";
import {
	decodeTspEvent,
	decodeTspReply,
	encodeHelloQuery,
	encodeTsp,
	parseTspApc,
	type RawTspMessage,
	TspChunkReader,
} from "@oh-my-pi/pi-tui/native/apc";
import type { TspEvent } from "@oh-my-pi/pi-wire";

const encoder = new TextEncoder();

function messages(stream: string): RawTspMessage[] {
	return stream
		.split("\x1b\\")
		.filter(Boolean)
		.map(part => parseTspApc(`${part}\x1b\\`)!);
}

describe("TSP framing", () => {
	it("frames the Tern SDK's conformance chunking cases byte for byte", () => {
		const cases = [
			{
				body: '{"sf":"s1","s":9,"ops":[["text","log","append","0123456789abcdefghij"]]}',
				limit: 24,
				out: '\x1b_tsp;f;c=k7;m=1;{"sf":"s1","s":9,"ops":[\x1b\\\x1b_tsp;f;c=k7;m=1;["text","log","append","\x1b\\\x1b_tsp;f;c=k7;0123456789abcdefghij"]]}\x1b\\',
			},
			{
				body: '{"sf":"s1","s":2,"ops":[["text","m","append","héllo wörld ✓ 𝄞 done"]]}',
				limit: 11,
				out: '\x1b_tsp;f;c=k7;m=1;{"sf":"s1",\x1b\\\x1b_tsp;f;c=k7;m=1;"s":2,"ops"\x1b\\\x1b_tsp;f;c=k7;m=1;:[["text","\x1b\\\x1b_tsp;f;c=k7;m=1;m","append"\x1b\\\x1b_tsp;f;c=k7;m=1;,"héllo w\x1b\\\x1b_tsp;f;c=k7;m=1;örld ✓ \x1b\\\x1b_tsp;f;c=k7;m=1;𝄞 done"]\x1b\\\x1b_tsp;f;c=k7;]}\x1b\\',
			},
			{
				body: '{"sf":"s1","s":3,"ops":[["text","m","replace","xab=1;q"]]}',
				limit: 48,
				out: '\x1b_tsp;f;c=k7;m=1;{"sf":"s1","s":3,"ops":[["text","m","replace",\x1b\\\x1b_tsp;f;c=k7;"xab=1;q"]]}\x1b\\',
			},
			{
				body: '{"k":"zzzzzzzzzzzzzzzz=1;"}',
				limit: 10,
				out: '\x1b_tsp;f;c=k7;m=1;{"k":\x1b\\\x1b_tsp;f;c=k7;m=1;"zzzzzzzzzzzzzzzz\x1b\\\x1b_tsp;f;c=k7;=1;"}\x1b\\',
			},
		];
		for (const { body, limit, out } of cases) {
			expect(encodeTsp("f", body, undefined, limit).replace(/;c=[0-9a-z]+;/g, ";c=k7;")).toBe(out);
		}
	});

	it("chunks under the limit without splitting a code point, and the reader joins them byte-exact", () => {
		const body = JSON.stringify({ text: 'ab€漢字🙂🙃 é\u001b"quote" '.repeat(9) });
		const chunks = messages(encodeTsp("f", body, undefined, 23));
		expect(chunks.length).toBeGreaterThan(1);
		for (const chunk of chunks) {
			expect(encoder.encode(chunk.body).length).toBeLessThanOrEqual(23);
			expect(chunk.body.isWellFormed()).toBe(true);
			expect(Object.keys(chunk.params).every(key => key === "c" || key === "m")).toBe(true);
		}
		const reader = new TspChunkReader();
		const out = chunks.map(chunk => reader.feed(chunk));
		expect(out.slice(0, -1).every(m => m === null)).toBe(true);
		expect(out.at(-1)).toEqual({ verb: "f", params: {}, body });
	});

	it("puts a message's parameters on the first chunk only and cuts base64 at exactly the limit", () => {
		const body = Buffer.from(crypto.getRandomValues(new Uint8Array(30_000))).toString("base64");
		const chunks = messages(encodeTsp("b", body, { id: "abc", mime: "image/png" }, 4096));
		expect(chunks.length).toBe(Math.ceil(body.length / 4096));
		expect(chunks[0]!.params).toEqual({ id: "abc", mime: "image/png", c: chunks[0]!.params.c!, m: "1" });
		expect(chunks.at(-1)!.params).toEqual({ c: chunks[0]!.params.c! });
		const reader = new TspChunkReader();
		const joined = chunks.map(chunk => reader.feed(chunk)).at(-1);
		expect(joined).toEqual({ verb: "b", params: { id: "abc", mime: "image/png" }, body });
	});

	it("sends a body at the limit unchunked", () => {
		expect(encodeTsp("f", "x".repeat(40), undefined, 40)).toBe(`\x1b_tsp;f;${"x".repeat(40)}\x1b\\`);
	});

	it("advertises the program's features in hello", () => {
		const hello = parseTspApc(encodeHelloQuery({ ver: "1.2" }))!;
		expect(hello.verb).toBe("q");
		expect(JSON.parse(hello.body)).toEqual({
			q: "hello",
			v: [1],
			app: "omp",
			features: ["edit", "undo", "send"],
			ver: "1.2",
		});
	});

	it("decodes a doc's new and edited comments, uncomments and in-place edits", () => {
		const events: TspEvent[] = [
			{ ev: "comment", sf: "s:1", id: "a.doc", quote: "Alpha line", at: 3, note: "too vague" },
			{ ev: "comment", sf: "s:1", id: "a.doc", comment: "c1", note: "name the API" },
			{ ev: "uncomment", sf: "s:1", id: "a.doc", comment: "c1" },
			{ ev: "change", sf: "s:1", id: "a.doc", text: "# Plan\n\nnew body\n" },
		];
		for (const event of events) expect(decodeTspEvent(JSON.stringify(event))).toEqual(event);
	});

	it("rejects malformed doc comment and change events", () => {
		const valid: Extract<TspEvent, { ev: "comment" }> = {
			ev: "comment",
			sf: "s:1",
			id: "a.doc",
			quote: "Alpha",
			at: 0,
			note: "clarify",
		};
		for (const event of [
			{ ...valid, sf: undefined },
			{ ...valid, id: "" },
			{ ...valid, note: undefined },
			{ ...valid, quote: undefined },
			{ ...valid, at: "0" },
			// `comment` and `text` pick the route when present; a non-string one must not fall through.
			{ ...valid, comment: null },
			{ ev: "comment", sf: "s:1", id: "a.doc", note: "clarify" },
			{ ev: "uncomment", sf: "s:1", id: "a.doc" },
			{ ev: "change", sf: "s:1", id: "a.doc" },
			{ ev: "change", sf: "s:1", id: "a.prefs", item: "mode", value: "fast", text: null },
		]) {
			expect(decodeTspEvent(JSON.stringify(event))).toBeNull();
		}
	});

	it("decodes the annotated picture Tern hands back and rejects malformed ones", () => {
		const picture: TspEvent = {
			ev: "change",
			sf: "s:1",
			id: "a.img",
			value: { mime: "image/jpeg", data: "QUJD", w: 640, h: 480 },
		};
		expect(decodeTspEvent(JSON.stringify(picture))).toEqual(picture);
		for (const value of [
			{ mime: "image/gif", data: "QUJD", w: 640, h: 480 },
			{ mime: "image/png", data: 5, w: 640, h: 480 },
			{ mime: "image/png", data: "QUJD", w: "640", h: 480 },
			{ mime: "image/png", data: "QUJD", w: 640 },
		])
			expect(decodeTspEvent(JSON.stringify({ ...picture, value }))).toBeNull();
	});

	it("decodes events tolerantly and rejects malformed ones", () => {
		expect(decodeTspEvent('{"ev":"toggle","sf":"s","id":"a","collapsed":true,"future":1}')).toEqual({
			ev: "toggle",
			sf: "s",
			id: "a",
			collapsed: true,
			future: 1,
		} as never);
		for (const value of [true, 5, "x", ["a"], null])
			expect(decodeTspEvent(JSON.stringify({ ev: "change", sf: "s", id: "p", item: "i", value }))).not.toBeNull();
		expect(decodeTspEvent('{"ev":"change","sf":"s","id":"p"}')).toBeNull();
		expect(decodeTspEvent('{"ev":"toggle","sf":"s","id":"m","collapsed":true,"open":null}')).toBeNull();
		expect(decodeTspEvent('{"ev":"action","sf":"s","id":"m","act":"show","checked":"false"}')).toBeNull();
		expect(decodeTspEvent('{"ev":"send","sf":"","id":"a","text":"x"}')).toBeNull();
		expect(decodeTspEvent('{"ev":"ack"}')).toBeNull();
		expect(decodeTspEvent('{"ev":"nope"}')).toBeNull();
		expect(decodeTspEvent("{not json")).toBeNull();
		expect(decodeTspReply('{"r":"hello","v":1,"term":"t"}')).toBeNull();
		expect(decodeTspReply('{"r":"hello","v":1,"term":"t","kinds":["col"],"x":2}')).toEqual({
			r: "hello",
			v: 1,
			term: "t",
			kinds: ["col"],
			x: 2,
		} as never);
	});
});
