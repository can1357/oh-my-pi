import { describe, expect, it } from "bun:test";
import { decodeDataUri } from "@oh-my-pi/pi-ai/providers/openai-data-uri";

describe("OpenAI data URI decoding", () => {
	it("decodes percent-encoded metadata and ignores URL fragments", () => {
		expect(decodeDataUri("data:image/png%3BBASE64,SGk%3D#preview")).toEqual({
			data: "SGk=",
			mimeType: "image/png",
		});
	});
});
