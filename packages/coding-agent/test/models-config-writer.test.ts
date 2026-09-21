import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import {
	addCustomOpenAIProvider,
	probeOpenAIEndpoint,
	readModelsConfigFile,
	sanitizeBaseUrl,
	validateBaseUrl,
	validateProviderId,
	writeModelsConfigFile,
} from "../src/config/models-config-writer";

describe("models-config-writer", () => {
	let tempDir: TempDir;
	let configPath: string;

	beforeEach(() => {
		tempDir = TempDir.createSync("models-config-writer-test-");
		configPath = path.join(tempDir.path(), "models.yml");
	});

	afterEach(async () => {
		await tempDir.remove().catch(() => {});
	});

	describe("validation", () => {
		test("validateProviderId accepts valid identifiers", () => {
			expect(validateProviderId("vllm")).toBeUndefined();
			expect(validateProviderId("my-local-llama_3")).toBeUndefined();
			expect(validateProviderId("deepseek-custom")).toBeUndefined();
		});

		test("validateProviderId rejects empty or invalid characters", () => {
			expect(validateProviderId("")).toBe("Provider ID cannot be empty");
			expect(validateProviderId("   ")).toBe("Provider ID cannot be empty");
			expect(validateProviderId("invalid provider")).toBe(
				"Provider ID can only contain letters, numbers, hyphens, and underscores",
			);
			expect(validateProviderId("foo/bar")).toBe(
				"Provider ID can only contain letters, numbers, hyphens, and underscores",
			);
			expect(validateProviderId("a".repeat(65))).toBe("Provider ID is too long (max 64 characters)");
		});

		test("validateBaseUrl accepts valid http and https URLs", () => {
			expect(validateBaseUrl("http://localhost:8000/v1")).toBeUndefined();
			expect(validateBaseUrl("https://api.openai.com/v1")).toBeUndefined();
			expect(validateBaseUrl("http://127.0.0.1:11434/v1/")).toBeUndefined();
		});

		test("validateBaseUrl rejects invalid or non-http URLs", () => {
			expect(validateBaseUrl("")).toBe("Base URL cannot be empty");
			expect(validateBaseUrl("not-a-url")).toBe("Base URL must be a valid URL (e.g. http://localhost:8000/v1)");
			expect(validateBaseUrl("ftp://localhost:8000")).toBe("Base URL must use http:// or https:// protocol");
		});

		test("sanitizeBaseUrl removes trailing slashes", () => {
			expect(sanitizeBaseUrl("http://localhost:8000/v1/")).toBe("http://localhost:8000/v1");
			expect(sanitizeBaseUrl("http://localhost:8000/v1///")).toBe("http://localhost:8000/v1");
			expect(sanitizeBaseUrl("  http://localhost:8000/v1  ")).toBe("http://localhost:8000/v1");
		});
	});

	describe("read and write roundtrip", () => {
		test("returns empty providers when file does not exist", async () => {
			const config = await readModelsConfigFile(configPath);
			expect(config).toEqual({ providers: {} });
		});

		test("writes and reads config atomically", async () => {
			await writeModelsConfigFile(
				{
					providers: {
						test_provider: {
							baseUrl: "http://localhost:8000/v1",
							apiKey: "sk-test",
							api: "openai-completions",
							models: [
								{
									id: "test-model",
									supportsTools: true,
								},
							],
						},
					},
				},
				configPath,
			);

			const loaded = await readModelsConfigFile(configPath);
			expect(loaded.providers?.test_provider).toBeDefined();
			expect(loaded.providers?.test_provider.baseUrl).toBe("http://localhost:8000/v1");
			expect(loaded.providers?.test_provider.models?.[0].id).toBe("test-model");
			expect(loaded.providers?.test_provider.models?.[0].supportsTools).toBe(true);
		});
	});

	describe("addCustomOpenAIProvider", () => {
		test("adds manual model with supportsTools: true and disableStrictTools: true by default", async () => {
			const result = await addCustomOpenAIProvider(
				{
					provider: "local-vllm",
					baseUrl: "http://127.0.0.1:8000/v1",
					auth: "none",
					model: {
						id: "llama-3-8b",
						name: "Llama 3 8B",
						contextWindow: 65536,
						maxTokens: 4096,
					},
				},
				configPath,
			);

			expect(result.provider).toBe("local-vllm");
			expect(result.modelId).toBe("llama-3-8b");
			expect(result.isNew).toBe(true);

			const config = await readModelsConfigFile(configPath);
			const provider = config.providers?.["local-vllm"];
			expect(provider).toBeDefined();
			expect(provider?.baseUrl).toBe("http://127.0.0.1:8000/v1");
			expect(provider?.auth).toBe("none");
			expect(provider?.disableStrictTools).toBe(true);
			expect(provider?.models).toHaveLength(1);
			expect(provider?.models?.[0]).toEqual({
				id: "llama-3-8b",
				name: "Llama 3 8B",
				supportsTools: true,
				contextWindow: 65536,
				maxTokens: 4096,
			});
		});

		test("configures discovery: { type: 'openai-models-list' }", async () => {
			const result = await addCustomOpenAIProvider(
				{
					provider: "proxy-gw",
					baseUrl: "https://proxy.example.com/v1",
					apiKey: "sk-secret-token",
					discovery: true,
				},
				configPath,
			);

			expect(result.provider).toBe("proxy-gw");
			expect(result.discovery).toBe(true);

			const config = await readModelsConfigFile(configPath);
			const provider = config.providers?.["proxy-gw"];
			expect(provider).toBeDefined();
			expect(provider?.apiKey).toBe("sk-secret-token");
			expect(provider?.discovery).toEqual({ type: "openai-models-list" });
			expect(provider?.api).toBe("openai-completions");
		});

		test("preserves existing providers and models when adding or updating", async () => {
			// First add provider A
			await addCustomOpenAIProvider(
				{
					provider: "provider-a",
					baseUrl: "http://localhost:8001/v1",
					auth: "none",
					model: { id: "model-a1" },
				},
				configPath,
			);

			// Add model A2 to provider A
			await addCustomOpenAIProvider(
				{
					provider: "provider-a",
					baseUrl: "http://localhost:8001/v1",
					auth: "none",
					model: { id: "model-a2" },
				},
				configPath,
			);

			// Add provider B
			await addCustomOpenAIProvider(
				{
					provider: "provider-b",
					baseUrl: "http://localhost:8002/v1",
					auth: "none",
					model: { id: "model-b1" },
				},
				configPath,
			);

			const config = await readModelsConfigFile(configPath);
			expect(Object.keys(config.providers ?? {})).toContain("provider-a");
			expect(Object.keys(config.providers ?? {})).toContain("provider-b");
			expect(config.providers?.["provider-a"]?.models).toHaveLength(2);
			expect(config.providers?.["provider-a"]?.models?.map(m => m.id)).toEqual(["model-a1", "model-a2"]);
			expect(config.providers?.["provider-b"]?.models).toHaveLength(1);
		});

		test("rejects invalid provider IDs", async () => {
			await expect(
				addCustomOpenAIProvider(
					{
						provider: "invalid id with spaces",
						baseUrl: "http://localhost:8000/v1",
					},
					configPath,
				),
			).rejects.toThrow("Provider ID can only contain letters, numbers, hyphens, and underscores");
		});

		test("rejects invalid base URL", async () => {
			await expect(
				addCustomOpenAIProvider(
					{
						provider: "valid-provider",
						baseUrl: "not-a-valid-url",
					},
					configPath,
				),
			).rejects.toThrow("Base URL must be a valid URL");
		});

		test("concurrent additions execute safely under lock", async () => {
			const promises = Array.from({ length: 5 }, (_, i) =>
				addCustomOpenAIProvider(
					{
						provider: `concurrent-prov-${i}`,
						baseUrl: `http://localhost:${8000 + i}/v1`,
						auth: "none",
						model: { id: `model-${i}` },
					},
					configPath,
				),
			);

			await Promise.all(promises);

			const config = await readModelsConfigFile(configPath);
			for (let i = 0; i < 5; i++) {
				expect(config.providers?.[`concurrent-prov-${i}`]).toBeDefined();
				expect(config.providers?.[`concurrent-prov-${i}`]?.models?.[0]?.id).toBe(`model-${i}`);
			}
		});
	});

	describe("probeOpenAIEndpoint", () => {
		test("probes mock server and extracts models", async () => {
			const server = Bun.serve({
				port: 0,
				fetch(req) {
					const url = new URL(req.url);
					if (url.pathname === "/v1/models") {
						return Response.json({
							object: "list",
							data: [{ id: "mock-model-1" }, { id: "mock-model-2" }],
						});
					}
					return new Response("Not Found", { status: 404 });
				},
			});

			try {
				const result = await probeOpenAIEndpoint(`http://localhost:${server.port}/v1`);
				expect(result.ok).toBe(true);
				expect(result.models).toEqual(["mock-model-1", "mock-model-2"]);
			} finally {
				server.stop();
			}
		});

		test("handles non-200 responses gracefully", async () => {
			const server = Bun.serve({
				port: 0,
				fetch() {
					return new Response("Unauthorized", { status: 401, statusText: "Unauthorized" });
				},
			});

			try {
				const result = await probeOpenAIEndpoint(`http://localhost:${server.port}/v1`);
				expect(result.ok).toBe(false);
				expect(result.error).toContain("401");
			} finally {
				server.stop();
			}
		});

		test("handles unreachable endpoint gracefully", async () => {
			// Connect to closed port
			const result = await probeOpenAIEndpoint("http://127.0.0.1:19999/v1", undefined, 1000);
			expect(result.ok).toBe(false);
			expect(result.error).toBeDefined();
		});
	});
});
