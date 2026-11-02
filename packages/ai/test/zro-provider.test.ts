import { describe, expect, test } from "bun:test";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import { getProviderDefinition } from "@oh-my-pi/pi-ai/registry/registry";
import type { Context, SimpleStreamOptions } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { seedModels } from "@oh-my-pi/pi-catalog/compat/providers";

const context: Context = {
	systemPrompt: ["You are a coding assistant."],
	messages: [{ role: "user", content: "hello", timestamp: 0 }],
};

async function payloadFor(id: string, options: SimpleStreamOptions): Promise<Record<string, unknown> | undefined> {
	let payload: Record<string, unknown> | undefined;
	const controller = new AbortController();
	controller.abort();
	const model = buildModel(seedModels<"openai-completions">("zro").find(model => model.id === id)!);
	const stream = streamOpenAICompletions(model, context, {
		...options,
		apiKey: "sk-zro-test",
		signal: controller.signal,
		onPayload: body => {
			payload = body as Record<string, unknown>;
		},
	});
	await stream.result();
	return payload;
}

describe("Zro chat requests", () => {
	test.each([
		// `none` disables DeepSeek reasoning. Omitting the field would keep the
		// server default (high) on.
		{ id: "deepseek-v4.1-flash", options: { disableReasoning: true }, wireEffort: "none" },
		// GLM-5.3 and its Dolly fine-tunes cannot disable reasoning: thinking-off
		// runs at the lowest documented tier rather than sending a `none` the
		// server would treat as low anyway.
		{ id: "glm-5.3", options: { disableReasoning: true }, wireEffort: "low" },
		{ id: "dolly1-security", options: { disableReasoning: true }, wireEffort: "low" },
	])("$id with $options sends reasoning_effort $wireEffort", async ({ id, options, wireEffort }) => {
		const payload = await payloadFor(id, options);
		expect(payload?.reasoning_effort).toBe(wireEffort);
	});

	test("GLM-5.3 and Dolly 2 can request their full 131k output cap", async () => {
		for (const id of ["glm-5.3", "dolly2-security"]) {
			const payload = await payloadFor(id, { maxTokens: 131_000 });
			expect(payload?.max_completion_tokens).toBe(131_000);
		}
	});
});

describe("Zro API-key login", () => {
	// `/v1/models` is key-protected, so login validates there and never bills a
	// chat completion.
	test("validates keys against the free /v1/models probe", async () => {
		const login = getProviderDefinition("zro")!.login!;
		const requests: Array<{ url: string; authorization: string | null }> = [];
		const loginWith = (apiKey: string) =>
			login({
				onAuth: () => {},
				onPrompt: async () => apiKey,
				fetch: async (input, init) => {
					requests.push({ url: String(input), authorization: new Headers(init?.headers).get("authorization") });
					return apiKey === "sk-valid"
						? Response.json({ object: "list", data: [{ id: "deepseek-v4.1-flash", object: "model" }] })
						: Response.json(
								{ error: { message: "Authentication Error", type: "token_not_found_in_db", code: "401" } },
								{ status: 401 },
							);
				},
			});

		await expect(loginWith("sk-revoked")).rejects.toThrow("Zro API key validation failed (401)");
		expect(await loginWith("sk-valid")).toBe("sk-valid");
		expect(requests).toEqual([
			{ url: "https://zro.moonmath.ai/v1/models", authorization: "Bearer sk-revoked" },
			{ url: "https://zro.moonmath.ai/v1/models", authorization: "Bearer sk-valid" },
		]);
	});
});
