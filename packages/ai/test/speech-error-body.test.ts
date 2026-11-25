import { describe, expect, it } from "bun:test";
import { ProviderHttpError } from "@oh-my-pi/pi-ai/error";
import { synthesizeSpeech } from "@oh-my-pi/pi-ai/speech";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";

const model = getBundledModel("deepinfra", "hexgrad/Kokoro-82M");

function respondWith(body: string | Uint8Array<ArrayBuffer>): FetchImpl {
	return async () => new Response(body, { status: 200 });
}

async function speechError(body: string | Uint8Array<ArrayBuffer>): Promise<unknown> {
	try {
		await synthesizeSpeech(model, { text: "Hello", format: "wav" }, { apiKey: "key", fetch: respondWith(body) });
	} catch (error) {
		return error;
	}
	throw new Error("synthesizeSpeech resolved");
}

describe("speech transport 2xx error bodies", () => {
	it("rejects a JSON error envelope with the status it reports", async () => {
		const error = await speechError(JSON.stringify({ error: { message: "invalid api key", status: "401" } }));
		expect(error).toBeInstanceOf(ProviderHttpError);
		expect(error).toMatchObject({ status: 401, message: expect.stringContaining("invalid api key") });
	});

	it("reads a numeric code next to a string error", async () => {
		const error = await speechError(` \n${JSON.stringify({ error: "voice is required", code: 400 })}`);
		expect(error).toBeInstanceOf(ProviderHttpError);
		expect(error).toMatchObject({ status: 400 });
	});

	it("reports an envelope without a status as a server-side failure", async () => {
		const error = await speechError(
			JSON.stringify({ error: { message: "upstream overloaded", code: "server_error" } }),
		);
		if (!(error instanceof ProviderHttpError)) throw new Error(`expected a ProviderHttpError, got ${String(error)}`);
		expect(error.code).toBe("server_error");
		expect(error.status).toBeGreaterThanOrEqual(500);
	});

	it("passes audio and JSON without an error field through", async () => {
		const audio = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3]);
		const result = await synthesizeSpeech(
			model,
			{ text: "Hello", format: "wav" },
			{ apiKey: "key", fetch: respondWith(audio) },
		);
		expect(result.audio).toEqual(audio);
		const json = new TextEncoder().encode(JSON.stringify({ audio: "base64" }));
		const passed = await synthesizeSpeech(
			model,
			{ text: "Hello", format: "wav" },
			{ apiKey: "key", fetch: respondWith(json) },
		);
		expect(passed.audio).toEqual(json);
	});
});
