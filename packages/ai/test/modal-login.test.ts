import { afterEach, describe, expect, test, vi } from "bun:test";
import { getProviderDefinition } from "@oh-my-pi/pi-ai/registry/registry";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";

const loginModal = getProviderDefinition("modal")!.login!;

const ORIGINAL_MODAL_BASE_URL = Bun.env.MODAL_BASE_URL;

afterEach(() => {
	if (ORIGINAL_MODAL_BASE_URL === undefined) delete Bun.env.MODAL_BASE_URL;
	else Bun.env.MODAL_BASE_URL = ORIGINAL_MODAL_BASE_URL;
});

function probe(expectedUrl: string, status: number, expectedKey = "wk-test.ws-secret"): FetchImpl {
	return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input.toString();
		expect(url).toBe(expectedUrl);
		expect(init?.method ?? "GET").toBe("GET");
		expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${expectedKey}`);
		return new Response(JSON.stringify({ data: [] }), { status });
	});
}

describe("Modal login with MODAL_BASE_URL", () => {
	// Dedicated endpoints serve `/v1/models`, so a bare endpoint origin must gain
	// `/v1` before `/models` is appended.
	test("validates against <base>/v1/models for a bare endpoint origin", async () => {
		Bun.env.MODAL_BASE_URL = "https://ep-foo.us-west.modal.direct/";
		const fetchMock = probe("https://ep-foo.us-west.modal.direct/v1/models", 200);

		const apiKey = await loginModal({ onPrompt: async () => " wk-test.ws-secret ", fetch: fetchMock });

		expect(apiKey).toBe("wk-test.ws-secret");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	test("does not double /v1 when the base already ends in it", async () => {
		Bun.env.MODAL_BASE_URL = "https://ep-foo.us-west.modal.direct/v1";
		const fetchMock = probe("https://ep-foo.us-west.modal.direct/v1/models", 200);

		expect(await loginModal({ onPrompt: async () => "wk-test.ws-secret", fetch: fetchMock })).toBe(
			"wk-test.ws-secret",
		);
	});

	test("rejects a token the configured endpoint refuses", async () => {
		Bun.env.MODAL_BASE_URL = "https://ep-foo.us-west.modal.direct";
		const fetchMock = probe("https://ep-foo.us-west.modal.direct/v1/models", 401, "wk-bad.ws-x");

		await expect(loginModal({ onPrompt: async () => "wk-bad.ws-x", fetch: fetchMock })).rejects.toThrow("401");
	});

	test("uses the shared gateway when MODAL_BASE_URL is unset", async () => {
		delete Bun.env.MODAL_BASE_URL;
		const fetchMock = probe("https://inference.us-west.modal.direct/v1/models", 200);

		expect(await loginModal({ onPrompt: async () => "wk-test.ws-secret", fetch: fetchMock })).toBe(
			"wk-test.ws-secret",
		);
	});
});
