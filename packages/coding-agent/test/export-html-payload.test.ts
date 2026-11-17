import { describe, expect, test } from "bun:test";
import { writeBase64Json } from "../src/export/html/payload";

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
});
