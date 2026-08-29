import { describe, expect, it, vi } from "bun:test";
import { loginMindsHub } from "@oh-my-pi/pi-ai/registry/mindshub";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";

describe("mindshub login", () => {
	it("opens the MindsHub console and validates against the models endpoint", async () => {
		let authUrl: string | undefined;

		const fetchMock: FetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			expect(url).toBe("https://api.mindshub.ai/v1/models");
			expect(init?.method).toBe("GET");
			expect(init?.headers).toEqual({ Authorization: "Bearer mdb-test-key" });
			return new Response(JSON.stringify({ object: "list", data: [] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		});

		const apiKey = await loginMindsHub({
			onAuth: info => {
				authUrl = info.url;
			},
			onPrompt: async () => "mdb-test-key",
			fetch: fetchMock,
		});

		// The exact instructional/placeholder copy isn't a consumer contract —
		// only the console URL, the auth header, the returned key, and the
		// validation call are (see AGENTS.md's testing guidance).
		expect(authUrl).toBe("https://console.mindshub.ai");
		expect(apiKey).toBe("mdb-test-key");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("rejects empty keys", async () => {
		await expect(
			loginMindsHub({
				onPrompt: async () => "   ",
			}),
		).rejects.toThrow("API key is required");
	});

	it("requires onPrompt callback", async () => {
		await expect(loginMindsHub({})).rejects.toThrow("MindsHub login requires onPrompt callback");
	});

	it("surfaces models endpoint validation errors", async () => {
		const fetchMock: FetchImpl = vi.fn(
			async () => new Response('{"error":"invalid_api_key"}', { status: 401 }),
		) as unknown as typeof fetch;

		await expect(
			loginMindsHub({
				onPrompt: async () => "mdb-test-key",
				fetch: fetchMock,
			}),
		).rejects.toThrow("MindsHub API key validation failed (401)");
	});
});
