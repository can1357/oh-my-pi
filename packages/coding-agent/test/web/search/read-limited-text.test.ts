import { describe, expect, it } from "bun:test";
import { readLimitedText } from "@oh-my-pi/pi-coding-agent/web/search/providers/utils";

describe("readLimitedText", () => {
	it("decodes a body in the charset its Content-Type declares", async () => {
		// "café" in windows-1252: é is the single byte 0xE9, invalid as UTF-8.
		const body = new Uint8Array([0x63, 0x61, 0x66, 0xe9]);
		const response = new Response(body, { headers: { "content-type": "text/plain; charset=windows-1252" } });
		expect(await readLimitedText(response, "brave", 1024)).toBe("café");
	});

	it("drops a UTF-8 byte-order mark so JSON bodies still parse", async () => {
		const response = new Response(new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('{"ok":true}')]), {
			headers: { "content-type": "application/json" },
		});
		expect(JSON.parse(await readLimitedText(response, "brave", 1024))).toEqual({ ok: true });
	});

	it("keeps a JSON body UTF-8 when a result string quotes a <meta charset> tag", async () => {
		const payload = { snippet: "<meta charset=windows-1252> café" };
		const response = new Response(JSON.stringify(payload), { headers: { "content-type": "application/json" } });
		expect(JSON.parse(await readLimitedText(response, "brave", 1024))).toEqual(payload);
	});
});
