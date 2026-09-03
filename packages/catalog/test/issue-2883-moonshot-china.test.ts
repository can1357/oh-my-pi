import { afterEach, describe, expect, test, vi } from "bun:test";
import { getCatalogProviderEntry } from "@oh-my-pi/pi-catalog/provider-models/descriptors";
import { moonshotModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";
import { $pickenv } from "@oh-my-pi/pi-utils";

const MODELS_DEV_URL = "https://catalog.stencil.so/models.json.zstd";

const ORIGINAL_ENV: Record<string, string | undefined> = {
	MOONSHOT_BASE_URL: Bun.env.MOONSHOT_BASE_URL,
	MOONSHOT_API_KEY: Bun.env.MOONSHOT_API_KEY,
	KIMI_API_KEY: Bun.env.KIMI_API_KEY,
};

function restoreEnv(): void {
	for (const key in ORIGINAL_ENV) {
		const value = ORIGINAL_ENV[key];
		if (value === undefined) {
			delete Bun.env[key];
		} else {
			Bun.env[key] = value;
		}
	}
}

function inputUrl(input: string | URL | Request): string {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.toString();
	return input.url;
}

function makeFetchMock(calls: string[]): FetchImpl {
	return vi.fn(async (input: string | URL | Request) => {
		const url = inputUrl(input);
		if (url === MODELS_DEV_URL) {
			return new Response("{}", { status: 500 });
		}
		calls.push(url);
		return new Response(JSON.stringify({ data: [{ id: "kimi-k2.7-code" }] }), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	}) as FetchImpl;
}

afterEach(() => {
	restoreEnv();
	vi.restoreAllMocks();
});

describe("Moonshot China platform (issue #2883)", () => {
	test("moonshot accepts KIMI_API_KEY as an env-key fallback for MOONSHOT_API_KEY", () => {
		// `getEnvApiKey("moonshot")` resolves a catalog provider via `$pickenv(...envVars)`
		// (see ai/src/stream.ts), so the descriptor's env-var order IS the resolution order.
		const envVars = getCatalogProviderEntry("moonshot")?.envVars;
		expect(envVars).toEqual(["MOONSHOT_API_KEY", "KIMI_API_KEY"]);

		delete Bun.env.MOONSHOT_API_KEY;
		Bun.env.KIMI_API_KEY = "kimi-china-key";
		expect($pickenv(...(envVars ?? []))).toBe("kimi-china-key");
	});

	test("MOONSHOT_API_KEY keeps precedence over the KIMI_API_KEY alias", () => {
		const envVars = getCatalogProviderEntry("moonshot")?.envVars ?? [];
		Bun.env.MOONSHOT_API_KEY = "moonshot-primary-key";
		Bun.env.KIMI_API_KEY = "kimi-fallback-key";
		expect($pickenv(...envVars)).toBe("moonshot-primary-key");
	});

	test("discovers models against api.moonshot.cn when MOONSHOT_BASE_URL is set", async () => {
		Bun.env.MOONSHOT_BASE_URL = "https://api.moonshot.cn/v1";
		const calls: string[] = [];
		const options = moonshotModelManagerOptions({ apiKey: "kimi-china-key", fetch: makeFetchMock(calls) });
		const models = await options.fetchDynamicModels?.();

		expect(calls).toContain("https://api.moonshot.cn/v1/models");
		expect(models?.[0]).toMatchObject({
			provider: "moonshot",
			baseUrl: "https://api.moonshot.cn/v1",
		});
	});

	test("explicit config baseUrl keeps precedence over MOONSHOT_BASE_URL", async () => {
		Bun.env.MOONSHOT_BASE_URL = "https://api.moonshot.cn/v1";
		const calls: string[] = [];
		const options = moonshotModelManagerOptions({
			apiKey: "kimi-china-key",
			baseUrl: "https://proxy.example/v1",
			fetch: makeFetchMock(calls),
		});
		const models = await options.fetchDynamicModels?.();

		expect(calls).toContain("https://proxy.example/v1/models");
		expect(models?.[0]?.baseUrl).toBe("https://proxy.example/v1");
	});
});
