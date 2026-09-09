import { describe, expect, it, vi } from "bun:test";
import { getProviderDefinition } from "@oh-my-pi/pi-ai/registry/registry";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";

const loginZhipuCodingPlan = getProviderDefinition("zhipu-coding-plan")!.login!;

describe("zhipu coding plan login", () => {
	it("validates against the domestic Coding Plan base and model used as provider default", async () => {
		let validationBody: Record<string, unknown> | undefined;
		const fetchMock: FetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			expect(url).toBe("https://open.bigmodel.cn/api/coding/paas/v4/chat/completions");
			expect(init?.method).toBe("POST");
			expect(init?.headers).toEqual({
				"Content-Type": "application/json",
				Authorization: "Bearer zhipu-key",
			});
			validationBody =
				typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
			return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		});

		const apiKey = await loginZhipuCodingPlan({
			onPrompt: async () => "  zhipu-key  ",
			fetch: fetchMock,
		});

		expect(apiKey).toBe("zhipu-key");
		expect(validationBody).toMatchObject({
			model: "glm-5.1",
			messages: [{ role: "user", content: "ping" }],
			max_tokens: 1,
			temperature: 0,
		});
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});
