import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { startAuthGateway } from "@oh-my-pi/pi-ai/auth-gateway";
import { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";

describe("auth-gateway explicit OpenAI prompt cache controls", () => {
	it("rejects raw controls clearly and forwards the pi-native policy", async () => {
		registerMockApi();
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-openai-prompt-cache-"));
		const storage = await AuthStorage.create(path.join(dir, "auth.db"));
		storage.setRuntimeApiKey("mock", "test-key");
		const mock = createMockModel({
			provider: "mock",
			id: "gateway-prompt-cache",
			handler: () => ({ content: ["ok"] }),
		});
		const handle = startAuthGateway({
			bind: "127.0.0.1:0",
			bearerTokens: ["t"],
			storage,
			resolveModel: () => mock.model,
			version: "test",
		});

		try {
			const chatResponse = await fetch(`${handle.url}/v1/chat/completions`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Authorization: "Bearer t" },
				body: JSON.stringify({
					model: "gateway-prompt-cache",
					messages: [{ role: "user", content: "hi" }],
					prompt_cache_options: { mode: "explicit", ttl: "30m" },
				}),
			});
			const chatBody = (await chatResponse.json()) as { error?: { type?: string; message?: string } };
			expect(chatResponse.status).toBe(400);
			expect(chatBody.error).toEqual({
				type: "invalid_request_error",
				message:
					"openai-chat: prompt_cache_options and prompt_cache_breakpoint are unsupported by this auth-gateway route; use /v1/pi/stream with options.promptCache instead",
			});

			const responsesResponse = await fetch(`${handle.url}/v1/responses`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Authorization: "Bearer t" },
				body: JSON.stringify({
					model: "gateway-prompt-cache",
					input: [
						{
							role: "user",
							content: [{ type: "input_text", text: "hi", prompt_cache_breakpoint: { mode: "explicit" } }],
						},
					],
				}),
			});
			const responsesBody = (await responsesResponse.json()) as { error?: { type?: string; message?: string } };
			expect(responsesResponse.status).toBe(400);
			expect(responsesBody.error).toEqual({
				type: "invalid_request_error",
				message:
					"openai-responses: prompt_cache_options and prompt_cache_breakpoint are unsupported by this auth-gateway route; use /v1/pi/stream with options.promptCache instead",
			});

			const piResponse = await fetch(`${handle.url}/v1/pi/stream`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Authorization: "Bearer t" },
				body: JSON.stringify({
					modelId: "gateway-prompt-cache",
					context: { messages: [{ role: "user", content: "hi", timestamp: 0 }] },
					options: { promptCache: { mode: "explicit", ttl: "30m", breakpoint: "none" } },
					stream: false,
				}),
			});
			expect(piResponse.status).toBe(200);
			expect(mock.calls).toHaveLength(1);
			expect(mock.calls[0]?.options?.promptCache).toEqual({ mode: "explicit", ttl: "30m", breakpoint: "none" });
		} finally {
			await handle.close();
			storage.close();
			clearCustomApis();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});
