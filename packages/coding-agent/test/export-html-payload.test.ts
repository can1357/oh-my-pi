import { describe, expect, test } from "bun:test";
import { stringifyJsonIteratively } from "@oh-my-pi/pi-utils";
import { writeBase64Json } from "../src/export/html/payload";
import { nestedChain } from "../../ai/test/helpers/deep-nesting";

/**
 * Contract: the streamed `#session-data` payload decodes exactly like the
 * monolithic `base64(JSON.stringify(...))` the viewer used to receive, whatever
 * the chunk boundaries split (multi-byte UTF-8, 3-byte base64 groups).
 */
async function streamed(value: unknown, chunkBytes?: number): Promise<string> {
	const chunks: string[] = [];
	await writeBase64Json(value, { write: chunk => chunks.push(chunk) }, chunkBytes);
	return chunks.join("");
}

const nullProto = Object.assign(Object.create(null), { z: 1, a: "é" });

const session = {
	header: { type: "session", id: "s", title: "naïve — 日本語 🧪" },
	entries: [
		{ id: "1", message: { role: "user", content: [{ type: "text", text: "€uro 😀😀 ok" }], extra: undefined } },
		{ id: "2", sparse: [1, undefined, () => 0, Symbol("x"), null], when: new Date(0), proto: nullProto },
		{ id: "3", deep: { a: { b: { c: { d: ["😀", "ü"] } } } }, empty: {}, none: [] },
	],
	leafId: null,
	skipped: undefined,
	subSessions: { "A/B": { entries: [{ id: "x", text: "𝄞".repeat(5) }], parent: "A" } },
};

describe("writeBase64Json", () => {
	test("matches base64 of JSON.stringify across every chunk alignment", async () => {
		const expected = Buffer.from(JSON.stringify(session)).toBase64();
		for (let chunkBytes = 6; chunkBytes <= 14; chunkBytes++) {
			expect(await streamed(session, chunkBytes)).toBe(expected);
		}
		expect(await streamed(session)).toBe(expected);
	});

	// A tool returns any JSON, and a transcript line holds it as deep as `JSON.parse` reads (millions of levels).
	test("writes an entry nested 50,000 levels, past where JSON.stringify stops", async () => {
		const details = nestedChain({ leaf: "bottom" });
		const deep = { header: null, entries: [{ id: "1", message: { role: "toolResult", details } }], leafId: "1" };
		expect(await streamed(deep)).toBe(Buffer.from(stringifyJsonIteratively(deep)!).toBase64());
	}, 20_000);
});
