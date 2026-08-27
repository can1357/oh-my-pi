import { describe, expect, it } from "bun:test";
import { decodeDataUri } from "@oh-my-pi/pi-ai/providers/openai-data-uri";

const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

describe("OpenAI data URI decoding", () => {
	it("decodes percent-encoded metadata and ignores URL fragments", () => {
		expect(decodeDataUri("data:image/png%3BBASE64,SGk%3D#preview")).toEqual({
			data: "SGk=",
			mimeType: "image/png",
		});
	});

	it("decodes line-wrapped base64 payloads into their canonical form", () => {
		const head = PNG_B64.slice(0, 32);
		const tail = PNG_B64.slice(32);

		expect(decodeDataUri(`data:image/png;base64,${head}\n${tail}`)).toEqual({
			data: PNG_B64,
			mimeType: "image/png",
		});
		expect(decodeDataUri(`data:image/png;base64,${head}%0A${tail}`)).toEqual({
			data: PNG_B64,
			mimeType: "image/png",
		});
	});

	it("rejects payloads that are not canonical base64", () => {
		expect(decodeDataUri("data:image/png;base64,!!!!")).toBeUndefined();
		expect(decodeDataUri("data:image/png;base64,=")).toBeUndefined();
		expect(decodeDataUri("data:image/png;base64,%20%0A")).toBeUndefined();
	});

	it("rejects non-ASCII whitespace inside the base64 payload", () => {
		const head = PNG_B64.slice(0, 32);
		const tail = PNG_B64.slice(32);

		// A no-break space is not base64 wrapping: the payload is malformed and
		// must stay fail-closed so an alternate reference survives.
		expect(decodeDataUri(`data:image/png;base64,${head}%C2%A0${tail}`)).toBeUndefined();
		expect(decodeDataUri(`data:image/png;base64,${head}%A0${tail}`)).toBeUndefined();
	});
});
