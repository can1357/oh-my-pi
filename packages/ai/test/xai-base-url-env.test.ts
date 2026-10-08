import { afterEach, describe, expect, test } from "bun:test";
import type { Model } from "@oh-my-pi/pi-catalog/types";
import { generateOpenAIImage } from "../src/images/openai-images";
import { resolveOpenAIRequestSetup } from "../src/providers/openai-shared";
import type { FetchImpl } from "../src/types";

const ORIGINAL_XAI_BASE_URL = Bun.env.XAI_BASE_URL;

afterEach(() => {
	if (ORIGINAL_XAI_BASE_URL === undefined) {
		delete Bun.env.XAI_BASE_URL;
	} else {
		Bun.env.XAI_BASE_URL = ORIGINAL_XAI_BASE_URL;
	}
});

function baseUrlFor(provider: string, baseUrl?: string, apiKey = "xai-test"): string | undefined {
	return resolveOpenAIRequestSetup({ provider, id: "grok-4.6", baseUrl }, { apiKey, messages: [] }).baseUrl;
}

const OAUTH_ACCESS_TOKEN = `e30.${Buffer.from(JSON.stringify({ sub: "xai-user" })).toString("base64url")}.sig`;

describe("XAI_BASE_URL", () => {
	test("redirects the bundled default endpoint for xai and xai-oauth, stripping trailing slashes", () => {
		Bun.env.XAI_BASE_URL = "https://xai-proxy.example/v1//";
		expect(baseUrlFor("xai", "https://api.x.ai/v1")).toBe("https://xai-proxy.example/v1");
		expect(baseUrlFor("xai-oauth", "https://api.x.ai/v1/")).toBe("https://xai-proxy.example/v1");
		expect(baseUrlFor("xai")).toBe("https://xai-proxy.example/v1");
	});

	test("never overrides a custom baseUrl", () => {
		Bun.env.XAI_BASE_URL = "https://xai-proxy.example/v1";
		expect(baseUrlFor("xai", "https://models-yml.example/v1")).toBe("https://models-yml.example/v1");
	});

	test("keeps the bundled endpoint when unset and leaves other providers alone", () => {
		delete Bun.env.XAI_BASE_URL;
		expect(baseUrlFor("xai", "https://api.x.ai/v1")).toBe("https://api.x.ai/v1");
		Bun.env.XAI_BASE_URL = "https://xai-proxy.example/v1";
		expect(baseUrlFor("openai", "https://api.x.ai/v1")).toBe("https://api.x.ai/v1");
	});

	test("never sends an xai-oauth OAuth access token to the override", () => {
		Bun.env.XAI_BASE_URL = "https://xai-proxy.example/v1";
		expect(baseUrlFor("xai-oauth", "https://api.x.ai/v1", OAUTH_ACCESS_TOKEN)).toBe("https://api.x.ai/v1");
		expect(baseUrlFor("xai-oauth", undefined, OAUTH_ACCESS_TOKEN)).toBeUndefined();
	});
});

describe("XAI_BASE_URL for xAI image generation", () => {
	async function imageRequestUrl(baseUrl: string): Promise<string | undefined> {
		let requestUrl: string | undefined;
		const fetch: FetchImpl = async input => {
			requestUrl = String(input);
			return new Response(JSON.stringify({ data: [{ b64_json: "aGVsbG8=", media_type: "image/png" }] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		};
		const model = { provider: "xai", id: "grok-imagine-image", baseUrl } as Model;
		await generateOpenAIImage(model, { prompt: "a cat" }, { apiKey: "xai-test", fetch });
		return requestUrl;
	}

	test("redirects the bundled endpoint and keeps a custom one", async () => {
		Bun.env.XAI_BASE_URL = "https://xai-proxy.example/v1/";
		expect(await imageRequestUrl("https://api.x.ai/v1")).toBe("https://xai-proxy.example/v1/images/generations");
		expect(await imageRequestUrl("https://models-yml.example/v1")).toBe(
			"https://models-yml.example/v1/images/generations",
		);
	});
});
