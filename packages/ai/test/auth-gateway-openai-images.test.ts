import { describe, expect, it } from "bun:test";
import { handleImageGeneration } from "@oh-my-pi/pi-ai/providers/openai-images-server";

function post(body: string): Request {
	return new Request("http://gateway/v1/images/generations", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body,
	});
}

describe("handleImageGeneration", () => {
	it("returns 400 when prompt is missing (negative)", async () => {
		const res = await handleImageGeneration(post(JSON.stringify({ model: "gpt-image-1" })));
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: "Missing prompt" });
	});

	it("returns 400 when prompt is empty (negative)", async () => {
		const res = await handleImageGeneration(post(JSON.stringify({ prompt: "" })));
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: "Missing prompt" });
	});

	it("returns 400 for invalid JSON (negative)", async () => {
		const res = await handleImageGeneration(post("{"));
		expect(res.status).toBe(400);
	});

	it("returns 501 for a valid prompt and never a fake image (negative)", async () => {
		const res = await handleImageGeneration(post(JSON.stringify({ prompt: "a red cube", model: "gpt-image-1" })));
		expect(res.status).toBe(501);
		expect(res.status).not.toBe(200);
		const body: unknown = await res.json();
		expect(body).toEqual({ error: "image generation is not available on this gateway" });
		expect(body).not.toHaveProperty("data");
	});
});
