import { afterEach, describe, expect, test, vi } from "bun:test";
import { getProviderDefinition } from "@oh-my-pi/pi-ai/registry/registry";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";

const loginTypeSafe = getProviderDefinition("typesafe")!.login!;

const ORIGINAL_TYPESAFE_BASE_URL = Bun.env.TYPESAFE_BASE_URL;

afterEach(() => {
	if (ORIGINAL_TYPESAFE_BASE_URL === undefined) delete Bun.env.TYPESAFE_BASE_URL;
	else Bun.env.TYPESAFE_BASE_URL = ORIGINAL_TYPESAFE_BASE_URL;
});

function probe(expectedUrl: string, status: number): FetchImpl {
	return vi.fn(async (input: string | URL | Request) => {
		const url = typeof input === "string" ? input : input.toString();
		expect(url).toBe(expectedUrl);
		return new Response(JSON.stringify({ models: [] }), { status });
	});
}

describe("TypeSafe login with TYPESAFE_BASE_URL", () => {
	// The base is an origin (the SDK appends `/v1/systemone`), so the probe must
	// keep the `/v1` the default URL has; `${base}/models` is a page, not the API.
	test("validates against <base>/v1/models", async () => {
		Bun.env.TYPESAFE_BASE_URL = "https://cloud.stencil.so/";
		const fetchMock = probe("https://cloud.stencil.so/v1/models", 200);

		const apiKey = await loginTypeSafe({ onPrompt: async () => " sk-test ", fetch: fetchMock });

		expect(apiKey).toBe("sk-test");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	test("rejects a key the configured endpoint refuses", async () => {
		Bun.env.TYPESAFE_BASE_URL = "https://cloud.stencil.so";
		const fetchMock = probe("https://cloud.stencil.so/v1/models", 401);

		await expect(loginTypeSafe({ onPrompt: async () => "sk-bad", fetch: fetchMock })).rejects.toThrow("401");
	});

	test("uses the public endpoint when TYPESAFE_BASE_URL is unset", async () => {
		delete Bun.env.TYPESAFE_BASE_URL;
		const fetchMock = probe("https://api.typesafe.ai/v1/models", 200);

		expect(await loginTypeSafe({ onPrompt: async () => "sk-live", fetch: fetchMock })).toBe("sk-live");
	});
});
