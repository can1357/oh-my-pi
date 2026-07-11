import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { FetchImpl } from "@pk-nerdsaver-ai/pi-ai/types";
import { ModelRegistry } from "@pk-nerdsaver-ai/pi-coding-agent/config/model-registry";
import { AuthStorage } from "@pk-nerdsaver-ai/pi-coding-agent/session/auth-storage";
import { removeSyncWithRetries, Snowflake } from "@pk-nerdsaver-ai/pi-utils";

describe("ModelRegistry LM Studio Fixes", () => {
	let tempDir: string;
	let modelsJsonPath: string;
	let authStorage: AuthStorage;

	beforeEach(async () => {
		tempDir = path.join(os.tmpdir(), `pi-test-lm-studio-fixes-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		modelsJsonPath = path.join(tempDir, "models.json");
		authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"));
	});

	afterEach(() => {
		authStorage.close();
		if (tempDir && fs.existsSync(tempDir)) {
			removeSyncWithRetries(tempDir);
		}
	});

	test("auto-discovers both ollama and lm-studio models independently", async () => {
		const fetchMock: FetchImpl = input => {
			const url = String(input);
			if (url.includes(":11434/api/tags")) {
				return Promise.resolve(
					new Response(JSON.stringify({ models: [{ name: "ollama-model" }] }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					}),
				);
			}
			if (url.includes(":1234/v1/models")) {
				return Promise.resolve(
					new Response(JSON.stringify({ data: [{ id: "lm-studio-model" }] }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					}),
				);
			}
			return Promise.resolve(new Response(null, { status: 404 }));
		};

		const registry = new ModelRegistry(authStorage, modelsJsonPath, { fetch: fetchMock });
		await registry.refresh();

		const allModels = registry.getAll();
		expect(allModels.some(m => m.provider === "ollama" && m.id === "ollama-model")).toBe(true);
		expect(allModels.some(m => m.provider === "lm-studio" && m.id === "lm-studio-model")).toBe(true);

		const available = registry.getAvailable();
		expect(available.some(m => m.provider === "ollama")).toBe(true);
		expect(available.some(m => m.provider === "lm-studio")).toBe(true);
	});

	test("marks LM Studio native VLM models as image-capable", async () => {
		const fetchMock: FetchImpl = input => {
			const url = String(input);
			if (url === "http://127.0.0.1:1234/api/v0/models") {
				return Promise.resolve(
					new Response(
						JSON.stringify({
							data: [
								{
									id: "qwen/qwen3.6-27b",
									type: "vlm",
									capabilities: ["tool_use"],
									max_context_length: 262144,
								},
								{ id: "plain-llm", type: "llm" },
							],
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					),
				);
			}
			if (url === "http://127.0.0.1:1234/v1/models") {
				return Promise.resolve(
					new Response(
						JSON.stringify({
							data: [
								{ id: "qwen/qwen3.6-27b", object: "model" },
								{ id: "plain-llm", object: "model" },
							],
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					),
				);
			}
			return Promise.resolve(new Response(null, { status: 404 }));
		};

		const registry = new ModelRegistry(authStorage, modelsJsonPath, { fetch: fetchMock });
		await registry.refresh();

		const vision = registry.find("lm-studio", "qwen/qwen3.6-27b");
		const text = registry.find("lm-studio", "plain-llm");
		expect(vision?.input).toEqual(["text", "image"]);
		expect(vision?.contextWindow).toBe(262144);
		expect(text?.input).toEqual(["text"]);
	});

	test("LM_STUDIO_BASE_URL can target any local OpenAI-compatible /v1 server", async () => {
		const originalBaseUrl = Bun.env.LM_STUDIO_BASE_URL;
		Bun.env.LM_STUDIO_BASE_URL = "http://127.0.0.1:11434/v1";
		let requestedUrl = "";
		try {
			const fetchMock: FetchImpl = input => {
				const url = String(input);
				if (url.includes(":11434/v1/models")) {
					requestedUrl = url;
					return Promise.resolve(
						new Response(JSON.stringify({ data: [{ id: "omlx-model" }] }), {
							status: 200,
							headers: { "Content-Type": "application/json" },
						}),
					);
				}
				return Promise.resolve(new Response(null, { status: 404 }));
			};

			const registry = new ModelRegistry(authStorage, modelsJsonPath, { fetch: fetchMock });
			await registry.refresh();

			expect(requestedUrl).toBe("http://127.0.0.1:11434/v1/models");
			// Implicit discovery is still registered under the built-in lm-studio provider even when the base URL points to oMLX.
			expect(registry.getAll().some(m => m.provider === "lm-studio" && m.id === "omlx-model")).toBe(true);
		} finally {
			if (originalBaseUrl === undefined) {
				delete Bun.env.LM_STUDIO_BASE_URL;
			} else {
				Bun.env.LM_STUDIO_BASE_URL = originalBaseUrl;
			}
		}
	});
});
