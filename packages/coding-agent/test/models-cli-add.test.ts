import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as path from "node:path";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import { TempDir } from "@oh-my-pi/pi-utils";
import { runModelsCommand } from "../src/cli/models-cli";
import { ModelRegistry } from "../src/config/model-registry";
import { readModelsConfigFile } from "../src/config/models-config-writer";

describe("models cli add", () => {
	let tempDir: TempDir;
	let configPath: string;

	beforeEach(() => {
		tempDir = TempDir.createSync("models-cli-add-test-");
		configPath = path.join(tempDir.path(), "models.yml");
		process.exitCode = 0;
	});

	afterEach(async () => {
		process.exitCode = 0;
		await tempDir.remove().catch(() => {});
	});

	test("adds custom provider with manual model definition and loads via ModelRegistry", async () => {
		await runModelsCommand({
			action: "add",
			flags: {
				provider: "cli-vllm",
				baseUrl: "http://127.0.0.1:8000/v1",
				auth: "none",
				model: "llama-3-8b",
				modelName: "Llama 3 8B Local",
				contextWindow: 65536,
				configPath,
			},
		});

		expect(process.exitCode).toBe(0);

		const config = await readModelsConfigFile(configPath);
		expect(config.providers?.["cli-vllm"]).toBeDefined();
		expect(config.providers?.["cli-vllm"]?.baseUrl).toBe("http://127.0.0.1:8000/v1");
		expect(config.providers?.["cli-vllm"]?.models).toHaveLength(1);
		expect(config.providers?.["cli-vllm"]?.models?.[0]).toEqual({
			id: "llama-3-8b",
			name: "Llama 3 8B Local",
			contextWindow: 65536,
			supportsTools: true,
		});

		// Verify that ModelRegistry reads the file and exposes the model
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		try {
			const registry = new ModelRegistry(authStorage, configPath);
			const models = registry.getAll();
			const customModel = models.find(m => m.provider === "cli-vllm" && m.id === "llama-3-8b");
			expect(customModel).toBeDefined();
			expect(customModel?.name).toBe("Llama 3 8B Local");
			expect(customModel?.contextWindow).toBe(65536);
			expect(customModel?.supportsTools).toBe(true);
		} finally {
			authStorage.close();
		}
	});

	test("adds custom provider with automatic discovery", async () => {
		await runModelsCommand({
			action: "add",
			flags: {
				provider: "cli-proxy",
				baseUrl: "https://api.proxy.example.com/v1",
				apiKey: "sk-test-token",
				discovery: true,
				configPath,
			},
		});

		expect(process.exitCode).toBe(0);

		const config = await readModelsConfigFile(configPath);
		expect(config.providers?.["cli-proxy"]).toBeDefined();
		expect(config.providers?.["cli-proxy"]?.discovery).toEqual({ type: "openai-models-list" });
		expect(config.providers?.["cli-proxy"]?.apiKey).toBe("sk-test-token");
	});

	test("outputs JSON format when --json is passed", async () => {
		let stdoutContent = "";
		const originalWrite = process.stdout.write;
		process.stdout.write = (chunk: string | Uint8Array) => {
			stdoutContent += chunk.toString();
			return true;
		};

		try {
			await runModelsCommand({
				action: "add",
				flags: {
					json: true,
					provider: "json-vllm",
					baseUrl: "http://localhost:8000/v1",
					auth: "none",
					model: "qwen-coder",
					configPath,
				},
			});

			const parsed = JSON.parse(stdoutContent.trim());
			expect(parsed.provider).toBe("json-vllm");
			expect(parsed.modelId).toBe("qwen-coder");
			expect(parsed.isNew).toBe(true);
		} finally {
			process.stdout.write = originalWrite;
		}
	});

	test("validates required flags and exits non-zero on error", async () => {
		// Missing baseUrl
		await runModelsCommand({
			action: "add",
			flags: {
				provider: "bad-prov",
				configPath,
			},
		});
		expect(process.exitCode).toBe(1);

		process.exitCode = 0;

		// Missing model or discovery
		await runModelsCommand({
			action: "add",
			flags: {
				provider: "bad-prov",
				baseUrl: "http://localhost:8000/v1",
				configPath,
			},
		});
		expect(process.exitCode).toBe(1);
	});

	test("--test flag probes endpoint and aborts on connectivity failure", async () => {
		// Test against unreachable port
		await runModelsCommand({
			action: "add",
			flags: {
				provider: "test-prov",
				baseUrl: "http://127.0.0.1:19998/v1",
				auth: "none",
				model: "dummy-model",
				test: true,
				configPath,
			},
		});

		expect(process.exitCode).toBe(1);

		// Config file should not have been created
		const config = await readModelsConfigFile(configPath);
		expect(config.providers?.["test-prov"]).toBeUndefined();
	});

	test("--test flag succeeds when mock endpoint responds", async () => {
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(req) {
				const url = new URL(req.url);
				if (url.pathname === "/v1/models") {
					return Response.json({
						object: "list",
						data: [{ id: "mock-llama-3" }],
					});
				}
				return new Response("Not Found", { status: 404 });
			},
		});

		try {
			process.exitCode = 0;
			await runModelsCommand({
				action: "add",
				flags: {
					provider: "verified-prov",
					baseUrl: `http://127.0.0.1:${server.port}/v1`,
					auth: "none",
					model: "mock-llama-3",
					test: true,
					configPath,
				},
			});

			expect(process.exitCode).toBe(0);
			const config = await readModelsConfigFile(configPath);
			expect(config.providers?.["verified-prov"]).toBeDefined();
		} finally {
			server.stop();
		}
	});
});
