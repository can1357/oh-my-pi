import { describe, expect, it } from "bun:test";
import { ProviderHttpError } from "@oh-my-pi/pi-ai/error";
import { synthesizeSpeech } from "@oh-my-pi/pi-ai/speech";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";

const model = getBundledModel("deepinfra", "hexgrad/Kokoro-82M");

function synthesize(body: string | Uint8Array<ArrayBuffer>, contentType: string) {
	return synthesizeSpeech(
		model,
		{ text: "Hello", format: "wav" },
		{ apiKey: "key", fetch: async () => new Response(body, { headers: { "Content-Type": contentType } }) },
	);
}

describe("speech transport 2xx JSON bodies", () => {
	it.each([
		{ name: "a nested string status", body: { error: { message: "invalid api key", status: "401" } }, status: 401 },
		{ name: "a top-level numeric code", body: { error: "voice is required", code: 400 }, status: 400 },
		{ name: "no status", body: { error: { message: "upstream overloaded", code: "server_error" } }, status: 502 },
	])("rejects a JSON body with $name as a ProviderHttpError", async ({ body, status }) => {
		const failure = synthesize(JSON.stringify(body), "application/json").catch(error => error);
		const error = await failure;
		expect(error).toBeInstanceOf(ProviderHttpError);
		expect(error).toMatchObject({ status });
	});

	it("returns audio bytes, even when they start with `{`", async () => {
		const audio = new Uint8Array([0x7b, 0x49, 0x46, 0x46, 1, 2, 3]);
		const result = await synthesize(audio, "audio/wav");
		expect(result.audio).toEqual(audio);
	});
});
