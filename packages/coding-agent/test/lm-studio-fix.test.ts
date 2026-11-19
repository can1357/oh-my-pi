import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

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

	test("refreshSelectedModelMetadata tracks the LM Studio JIT-load lifecycle", async () => {
		let state: "not-loaded" | "loaded" = "not-loaded";
		const fetchMock: FetchImpl = input => {
			const url = String(input);
			if (url === "http://127.0.0.1:1234/api/v0/models") {
				return Promise.resolve(
					new Response(
						JSON.stringify({
							data: [
								{
									id: "big-model",
									type: "llm",
									state,
									max_context_length: 262144,
									loaded_context_length: state === "loaded" ? 81920 : null,
								},
							],
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					),
				);
			}
			if (url === "http://127.0.0.1:1234/v1/models") {
				return Promise.resolve(
					new Response(JSON.stringify({ data: [{ id: "big-model", object: "model" }] }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					}),
				);
			}
			return Promise.resolve(new Response(null, { status: 404 }));
		};

		const registry = new ModelRegistry(authStorage, modelsJsonPath, { fetch: fetchMock });
		await registry.refresh();

		// Discovery while unloaded records the architectural ceiling.
		const discovered = registry.find("lm-studio", "big-model");
		expect(discovered?.contextWindow).toBe(262144);

		// JIT load: refreshing the selected model adopts the loaded window.
		state = "loaded";
		const loaded = await registry.refreshSelectedModelMetadata(discovered!);
		expect(loaded.contextWindow).toBe(81920);
		expect(registry.find("lm-studio", "big-model")?.contextWindow).toBe(81920);

		// Unload: the runtime-derived window is not retained; it falls back to max.
		state = "not-loaded";
		const unloaded = await registry.refreshSelectedModelMetadata(loaded);
		expect(unloaded.contextWindow).toBe(262144);
		expect(registry.find("lm-studio", "big-model")?.contextWindow).toBe(262144);
	});

	test("first successful inference refreshes the live session context window", async () => {
		let loaded = false;
		const fetchMock: FetchImpl = input => {
			const url = String(input);
			if (url === "http://127.0.0.1:1234/api/v0/models") {
				return Promise.resolve(
					new Response(
						JSON.stringify({
							data: [
								{
									id: "big-model",
									type: "llm",
									state: loaded ? "loaded" : "not-loaded",
									max_context_length: 262144,
									loaded_context_length: loaded ? 81920 : null,
								},
							],
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					),
				);
			}
			if (url === "http://127.0.0.1:1234/v1/models") {
				return Promise.resolve(
					new Response(JSON.stringify({ data: [{ id: "big-model", object: "model" }] }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					}),
				);
			}
			return Promise.resolve(new Response(null, { status: 404 }));
		};

		const modelRegistry = new ModelRegistry(authStorage, modelsJsonPath, { fetch: fetchMock });
		await modelRegistry.refresh();
		expect(modelRegistry.find("lm-studio", "big-model")?.contextWindow).toBe(262144);

		// Model registered while unloaded, then JIT-loaded on the first request.
		loaded = true;

		// A MockModel carrying the LM Studio provider/id/baseUrl drives the agent
		// loop and fires onResponse (via responseHeaders) with a 200, exactly like
		// a real provider returning after the JIT load completes.
		const mockModel = createMockModel({
			provider: "lm-studio",
			id: "big-model",
			baseUrl: "http://127.0.0.1:1234/v1",
			contextWindow: 262144,
			responses: [{ content: ["ok"], responseHeaders: {} }],
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: mockModel, systemPrompt: ["Test"], tools: [] },
			streamFn: mockModel.stream,
		});
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
		});
		try {
			expect(session.model?.contextWindow).toBe(262144);
			await session.prompt("hi");
			await session.waitForIdle();
			// The first successful inference re-probed the runtime window and folded
			// it into the live session model without a manual refresh.
			expect(session.model?.contextWindow).toBe(81920);
		} finally {
			await session.dispose();
		}
	});
});
