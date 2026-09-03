import { describe, expect, it, vi } from "bun:test";
import { getProviderDefinition } from "@oh-my-pi/pi-ai/registry/registry";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";

const loginSynthetic = getProviderDefinition("synthetic")!.login!;

describe("synthetic login", () => {
	it("validates API keys against the models endpoint instead of a deprecated model", async () => {
		const fetchMock: FetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			expect(String(input)).toBe("https://api.synthetic.new/openai/v1/models");
			expect(init?.method).toBe("GET");
			expect(init?.headers).toEqual({ Authorization: "Bearer sk-synthetic-test" });
			return new Response(JSON.stringify({ data: [{ id: "hf:zai-org/GLM-5.1" }] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		});

		const apiKey = await loginSynthetic({
			onPrompt: async () => "sk-synthetic-test",
			fetch: fetchMock,
		});

		expect(apiKey).toBe("sk-synthetic-test");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});
