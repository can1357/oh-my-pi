import { describe, expect, it, vi } from "bun:test";
import { getProviderDefinition } from "@oh-my-pi/pi-ai/registry/registry";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";

const loginUmans = getProviderDefinition("umans")!.login!;

describe("umans login", () => {
	it("validates pasted keys against the Anthropic messages endpoint", async () => {
		let authUrl: string | undefined;
		let authInstructions: string | undefined;
		let promptMessage: string | undefined;
		let promptPlaceholder: string | undefined;
		const fetchMock: FetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			const headers = new Headers(init?.headers);
			const body = JSON.parse(String(init?.body)) as { model?: string; max_tokens?: number };

			expect(url).toBe("https://api.code.umans.ai/v1/messages");
			expect(init?.method).toBe("POST");
			expect(headers.get("content-type")).toBe("application/json");
			expect(headers.get("anthropic-version")).toBe("2023-06-01");
			expect(headers.get("x-api-key")).toBe("sk-umans-valid");
			expect(headers.get("authorization")).toBeNull();
			expect(body.model).toBe("umans-coder");
			expect(body.max_tokens).toBe(1);

			return new Response(JSON.stringify({ id: "msg_test", type: "message" }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		});

		const apiKey = await loginUmans({
			onAuth: info => {
				authUrl = info.url;
				authInstructions = info.instructions;
			},
			onPrompt: async prompt => {
				promptMessage = prompt.message;
				promptPlaceholder = prompt.placeholder;
				return "  sk-umans-valid  ";
			},
			fetch: fetchMock,
		});

		expect(apiKey).toBe("sk-umans-valid");
		expect(authUrl).toBe("https://app.umans.ai/billing");
		expect(authInstructions).toContain("Dashboard → API Keys");
		expect(promptMessage).toBe("Paste your Umans API key");
		expect(promptPlaceholder).toBe("sk-...");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("surfaces validation errors from the Anthropic messages endpoint", async () => {
		const fetchMock: FetchImpl = vi.fn(
			async () =>
				new Response("invalid key", {
					status: 401,
					headers: { "Content-Type": "text/plain" },
				}),
		);

		await expect(
			loginUmans({
				onPrompt: async () => "sk-umans-bad",
				fetch: fetchMock,
			}),
		).rejects.toThrow("Umans AI Coding Plan API key validation failed (401): invalid key");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});
