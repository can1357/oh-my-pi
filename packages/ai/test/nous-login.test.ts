import { describe, expect, it } from "bun:test";
import { loginNousPortal } from "@oh-my-pi/pi-ai/registry/nous";

const MODELS_RESPONSE = JSON.stringify({ data: [{ id: "nousresearch/hermes-4-70b" }] });

describe("Nous Portal proxy login", () => {
	it("validates the local Hermes proxy without exposing Portal credentials", async () => {
		let authUrl: string | undefined;
		let instructions: string | undefined;
		let requestedUrl: string | undefined;
		let authorization: string | null | undefined;

		const apiKey = await loginNousPortal({
			onAuth: info => {
				authUrl = info.url;
				instructions = info.instructions;
			},
			fetch: async (input, init) => {
				requestedUrl = String(input);
				authorization = new Headers(init?.headers).get("Authorization");
				return new Response(MODELS_RESPONSE, { status: 200 });
			},
		});

		expect(authUrl).toContain("subscription-proxy.md");
		expect(instructions).toContain("hermes portal");
		expect(instructions).toContain("hermes proxy start");
		expect(requestedUrl).toBe("http://127.0.0.1:8645/v1/models");
		expect(authorization).toBe("Bearer sk-unused");
		expect(apiKey).toBe("sk-unused");
	});
});
