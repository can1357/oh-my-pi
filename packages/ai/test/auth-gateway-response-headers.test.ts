import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { startAuthGateway } from "@oh-my-pi/pi-ai/auth-gateway";
import { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
import { createMockModel, type MockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";

interface GatewayHarness {
	url: string;
	mock: MockModel;
	close(): Promise<void>;
}

async function bootGateway(): Promise<GatewayHarness> {
	registerMockApi();
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-response-headers-"));
	const storage = await AuthStorage.create(path.join(dir, "auth.db"));
	storage.setRuntimeApiKey("openrouter", "test-key");
	const mock = createMockModel({ provider: "openrouter", id: "mock/header-model" });
	const handle = startAuthGateway({
		bind: "127.0.0.1:0",
		bearerTokens: ["t"],
		storage,
		resolveModel: () => mock.model,
		version: "test",
	});
	return {
		url: handle.url,
		mock,
		close: async () => {
			await handle.close();
			storage.close();
			await fs.rm(dir, { recursive: true, force: true });
		},
	};
}

afterEach(() => {
	clearCustomApis();
});

describe("auth-gateway diagnostic response headers", () => {
	it("non-streaming responses carry cost, model id, request id, and duration", async () => {
		const gw = await bootGateway();
		try {
			gw.mock.push({
				content: ["hello"],
				usage: {
					input: 10,
					output: 5,
					totalTokens: 15,
					cost: { input: 0.001, output: 0.0002, total: 0.0012 },
				},
			});
			const res = await fetch(`${gw.url}/v1/chat/completions`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Authorization: "Bearer t" },
				body: JSON.stringify({
					model: "mock/header-model",
					messages: [{ role: "user", content: "hi" }],
					stream: false,
				}),
			});
			expect(res.status).toBe(200);
			expect(res.headers.get("x-litellm-response-cost")).toBe("0.0012");
			expect(res.headers.get("x-litellm-model-id")).toBe("mock/header-model");
			const duration = res.headers.get("x-litellm-response-duration-ms");
			expect(duration).not.toBeNull();
			expect(Number(duration)).toBeGreaterThanOrEqual(0);
			expect(res.headers.get("openai-processing-ms")).toBe(duration);
			const requestId = res.headers.get("x-request-id");
			expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
			expect(res.headers.get("request-id")).toBe(requestId);
		} finally {
			await gw.close();
		}
	});

	it("marks client-declared tools for execution outside the gateway", async () => {
		const gw = await bootGateway();
		try {
			gw.mock.push({ content: ["ok"] });
			const res = await fetch(`${gw.url}/v1/chat/completions`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Authorization: "Bearer t" },
				body: JSON.stringify({
					model: "mock/header-model",
					messages: [{ role: "user", content: "send this" }],
					tools: [
						{
							type: "function",
							function: {
								name: "send_message",
								description: "Send a message",
								parameters: { type: "object", properties: { text: { type: "string" } } },
							},
						},
					],
					stream: false,
				}),
			});
			expect(res.status).toBe(200);
			expect(gw.mock.calls[0]?.options?.cursorExternalToolExecutor).toBe(true);
		} finally {
			await gw.close();
		}
	});

	it("streaming responses carry the model and request ids but no cost (unknown at header time)", async () => {
		const gw = await bootGateway();
		try {
			gw.mock.push({ content: ["hello"] });
			const res = await fetch(`${gw.url}/v1/chat/completions`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Authorization: "Bearer t" },
				body: JSON.stringify({
					model: "mock/header-model",
					messages: [{ role: "user", content: "hi" }],
					stream: true,
				}),
			});
			expect(res.status).toBe(200);
			expect(res.headers.get("x-litellm-model-id")).toBe("mock/header-model");
			expect(res.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
			expect(res.headers.get("x-litellm-response-cost")).toBeNull();
			await res.text();
		} finally {
			await gw.close();
		}
	});
});
