import { describe, expect, test } from "bun:test";
import { decodeDataUri } from "../src/providers/openai-data-uri";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC";

describe("decodeDataUri", () => {
	test("decodes percent-encoded binary bytes without requiring valid UTF-8", () => {
		const encoded = Array.from(Buffer.from(PNG, "base64"), byte => `%${byte.toString(16).padStart(2, "0")}`).join("");

		expect(decodeDataUri(`data:image/png,${encoded}`)).toEqual({ mimeType: "image/png", data: PNG });
	});

	test("accepts case-insensitive data schemes and base64 markers", () => {
		expect(decodeDataUri(`DATA:image/png;BASE64,${PNG}`)).toEqual({ mimeType: "image/png", data: PNG });
	});

	test("retains text and percent escapes as their encoded bytes", () => {
		expect(decodeDataUri("data:text/plain,snowman:%20%E2%98%83")).toEqual({
			mimeType: "text/plain",
			data: Buffer.from("snowman: ☃", "utf8").toString("base64"),
		});
	});
});
