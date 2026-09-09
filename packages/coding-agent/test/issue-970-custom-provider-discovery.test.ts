import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { writeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import type { ModelRegistry, ProviderDiscoveryState } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { ModelRegistry as ModelRegistryImpl } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ModelHubComponent } from "@oh-my-pi/pi-coding-agent/modes/components/model-hub";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import type { TUI } from "@oh-my-pi/pi-tui";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

function normalizeRenderedText(text: string): string {
	return stripVTControlCharacters(text).replace(/\s+/g, " ").trim();
}

let testTheme = await getThemeByName("dark");

function installTestTheme(): void {
	if (!testTheme) {
		throw new Error("Failed to load dark theme for issue-970 selector test");
	}
	setThemeInstance(testTheme);
}

async function createHub(state: ProviderDiscoveryState): Promise<ModelHubComponent> {
	const modelRegistry = {
		refresh: async () => {},
		refreshProvider: async () => {},
		getError: () => undefined,
		getAvailable: () => [],
		getAll: () => [],
		getDiscoverableProviders: () => [state.provider],
		getProviderDiscoveryState: () => state,
		authStorage: { hasAuth: () => false },
	} as unknown as ModelRegistry;
	const ui = { requestRender: vi.fn(), terminal: { rows: 40 } } as unknown as TUI;
	const hub = new ModelHubComponent(ui, Settings.isolated({}), modelRegistry, [], {
		onAssign: () => {},
		onUnassign: () => {},
		onCancel: () => {},
	});
	await Bun.sleep(0);
	installTestTheme();
	// Scope-hop is the default arrow mode: one Down moves All models → the
	// sole provider entry (separators are skipped).
	hub.handleInput("\x1b[B");
	await Bun.sleep(0);
	return hub;
}

describe("issue #970 custom provider discovery", () => {
	let tempDir: string;
	let modelsPath: string;
	let authStorage: AuthStorage;

	beforeAll(async () => {
		testTheme = await getThemeByName("dark");
		if (!testTheme) {
			throw new Error("Failed to load dark theme for issue-970 selector test");
		}
	});

	beforeEach(async () => {
		tempDir = path.join(os.tmpdir(), `pi-test-issue-970-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		modelsPath = path.join(tempDir, "models.yml");
		authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
	});

	afterEach(() => {
		authStorage.close();
		if (tempDir && fs.existsSync(tempDir)) {
			removeSyncWithRetries(tempDir);
		}
	});

	test("discovers custom openai-compatible models and lets YAML models override discovered fields", async () => {
		fs.writeFileSync(
			modelsPath,
			[
				"providers:",
				"  vllm:",
				"    baseUrl: http://192.168.5.3:8085/v1",
				"    apiKey: sk-1234",
				"    api: openai-completions",
				"    auth: apiKey",
				"    discovery:",
				"      type: openai-models-list",
				"    models:",
				"      - id: qwen3.6",
				"        name: Qwen3.6",
				"        contextWindow: 128000",
				"        maxTokens: 8192",
			].join("\n"),
		);

		const fetchMock: (input: string | URL | Request, init?: RequestInit) => Promise<Response> = async (
			input,
			init,
		) => {
			const url = String(input);
			if (url !== "http://192.168.5.3:8085/v1/models") {
				throw new Error(`Unexpected URL: ${url}`);
			}
			const headers = init?.headers as Headers | Record<string, string> | undefined;
			const authHeader = headers instanceof Headers ? headers.get("Authorization") : headers?.Authorization;
			expect(authHeader).toBe("Bearer sk-1234");
			return new Response(JSON.stringify({ data: [{ id: "qwen3.6" }, { id: "vllm-lab-fork-b2" }] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		};

		const registry = new ModelRegistryImpl(authStorage, modelsPath, { fetch: fetchMock });
		await registry.refreshProvider("vllm");

		const providerModels = registry.getAll().filter(model => model.provider === "vllm");
		expect(providerModels.map(model => model.id).sort()).toEqual(["qwen3.6", "vllm-lab-fork-b2"]);
		expect(registry.getProviderDiscoveryState("vllm")?.status).toBe("ok");

		const qwen = registry.find("vllm", "qwen3.6");
		expect(qwen?.api).toBe("openai-completions");
		expect(qwen?.provider).toBe("vllm");
		expect(qwen?.name).toBe("Qwen3.6");
		expect(qwen?.contextWindow).toBe(128000);
		expect(qwen?.maxTokens).toBe(8192);

		const deepseek = registry.find("vllm", "vllm-lab-fork-b2");
		expect(deepseek?.api).toBe("openai-completions");
		expect(deepseek?.provider).toBe("vllm");
		expect(deepseek?.name).toBe("vllm-lab-fork-b2");
		expect(deepseek?.contextWindow).toBe(128000);
		expect(deepseek?.maxTokens).toBe(32_768);
	});

	test("shows a provider-tab hint when discovery succeeds but returns zero models", async () => {
		installTestTheme();
		const hub = await createHub({
			provider: "vllm",
			status: "empty",
			optional: false,
			stale: false,
			fetchedAt: Date.now(),
			models: [],
		});

		const rendered = normalizeRenderedText(hub.render(200).join("\n"));
		expect(rendered).toContain("Discovery succeeded but returned 0 models");
		expect(rendered).toContain("/models returns { data: [{ id }] }");
		hub.dispose();
	});

	test("shows a provider-tab hint when the discovery endpoint returns 404", async () => {
		installTestTheme();
		const hub = await createHub({
			provider: "vllm",
			status: "unavailable",
			optional: false,
			stale: false,
			fetchedAt: Date.now(),
			models: [],
			error: "HTTP 404 from http://192.168.5.3:8085/v1/models",
		});

		const rendered = normalizeRenderedText(hub.render(200).join("\n"));
		expect(rendered).toContain("http://192.168.5.3:8085/v1/models returned 404");
		expect(rendered).toContain("baseUrl");
		hub.dispose();
	});

	test("discovers multiple configurable vllm instances and preserves advertised context metadata", async () => {
		fs.writeFileSync(
			modelsPath,
			[
				"providers:",
				"  vllm-fast:",
				"    baseUrl: http://192.168.5.3:8085/v1",
				"    auth: none",
				"    api: openai-completions",
				"    discovery:",
				"      type: openai-models-list",
				"  vllm-long:",
				"    baseUrl: http://192.168.5.4:8085/v1",
				"    auth: none",
				"    api: openai-completions",
				"    discovery:",
				"      type: openai-models-list",
			].join("\n"),
		);

		const fetchMock: (input: string | URL | Request) => Promise<Response> = async input => {
			const url = String(input);
			if (url === "http://192.168.5.3:8085/v1/models") {
				return new Response(JSON.stringify({ data: [{ id: "vllm-lab-fork-flash", max_model_len: 262_144 }] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			if (url === "http://192.168.5.4:8085/v1/models") {
				return new Response(JSON.stringify({ data: [{ id: "vllm-lab-fork-long", context_length: "1048576" }] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			throw new Error(`Unexpected URL: ${url}`);
		};

		const registry = new ModelRegistryImpl(authStorage, modelsPath, { fetch: fetchMock });
		await registry.refreshProvider("vllm-fast");
		await registry.refreshProvider("vllm-long");

		const fast = registry.find("vllm-fast", "vllm-lab-fork-flash");
		expect(fast?.contextWindow).toBe(262_144);
		expect(fast?.maxTokens).toBe(32_768);
		const long = registry.find("vllm-long", "vllm-lab-fork-long");
		expect(long?.contextWindow).toBe(1_048_576);
		expect(long?.maxTokens).toBe(32_768);
		expect(registry.getProviderDiscoveryState("vllm-fast")?.status).toBe("ok");
		expect(registry.getProviderDiscoveryState("vllm-long")?.status).toBe("ok");
	});
	test("ignores old configured openai-models-list cache namespaces after adding vllm context parsing", async () => {
		fs.writeFileSync(
			modelsPath,
			[
				"providers:",
				"  vllm-fast:",
				"    baseUrl: http://192.168.5.3:8085/v1",
				"    auth: none",
				"    api: openai-completions",
				"    discovery:",
				"      type: openai-models-list",
			].join("\n"),
		);
		writeModelCache(
			"vllm-fast",
			Date.now(),
			[
				buildModel({
					id: "Stale",
					name: "Stale",
					provider: "vllm-fast",
					api: "openai-completions",
					baseUrl: "http://192.168.5.3:8085/v1",
					contextWindow: 128_000,
					maxTokens: 32_768,
					reasoning: false,
					input: ["text"],
					cost: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
					},
				}),
			],
			true,
			"",
			path.join(tempDir, "models.db"),
		);

		const calls: string[] = [];
		const fetchMock: (input: string | URL | Request) => Promise<Response> = async input => {
			const url = String(input);
			calls.push(url);
			if (url !== "http://192.168.5.3:8085/v1/models") {
				throw new Error(`Unexpected URL: ${url}`);
			}
			return new Response(JSON.stringify({ data: [{ id: "Fresh", max_model_len: 262_144 }] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		};

		const registry = new ModelRegistryImpl(authStorage, modelsPath, { fetch: fetchMock });
		await registry.refreshProvider("vllm-fast", "online-if-uncached");

		expect(calls).toEqual(["http://192.168.5.3:8085/v1/models"]);
		expect(registry.find("vllm-fast", "Fresh")?.contextWindow).toBe(262_144);
		expect(registry.find("vllm-fast", "Stale")).toBeUndefined();
	});

	test("uses default vllm baseUrl override for built-in discovery", async () => {
		fs.writeFileSync(
			modelsPath,
			["providers:", "  vllm:", "    baseUrl: http://192.168.5.3:8085/v1", "    auth: none"].join("\n"),
		);

		await authStorage.set("vllm", { type: "api_key", key: "vllm-local" });

		const fetchMock: (input: string | URL | Request, init?: RequestInit) => Promise<Response> = async (
			input,
			init,
		) => {
			const url = String(input);
			if (url !== "http://192.168.5.3:8085/v1/models") {
				throw new Error(`Unexpected URL: ${url}`);
			}
			const headers = init?.headers as Headers | Record<string, string> | undefined;
			const authHeader = headers instanceof Headers ? headers.get("Authorization") : headers?.Authorization;
			expect(authHeader).toBeUndefined();
			expect(init?.signal).toBeInstanceOf(AbortSignal);
			return new Response(JSON.stringify({ data: [{ id: "DeepSeek-V4-Flash", max_model_len: 262_144 }] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		};

		const registry = new ModelRegistryImpl(authStorage, modelsPath, { fetch: fetchMock });
		await registry.refreshProvider("vllm");

		const model = registry.find("vllm", "DeepSeek-V4-Flash");
		expect(model?.baseUrl).toBe("http://192.168.5.3:8085/v1");
		expect(model?.contextWindow).toBe(262_144);
		expect(model?.provider).toBe("vllm");
	});
	test("does not probe built-in vllm unless it is explicitly configured", async () => {
		fs.writeFileSync(modelsPath, ["providers: {}"].join("\n"));

		const urls: string[] = [];
		const fetchMock: (input: string | URL | Request) => Promise<Response> = async input => {
			const url = String(input);
			urls.push(url);
			if (url === "http://127.0.0.1:8000/v1/models") {
				throw new Error("Unexpected default vLLM probe");
			}
			return new Response(JSON.stringify({ data: [] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		};

		const registry = new ModelRegistryImpl(authStorage, modelsPath, { fetch: fetchMock });
		await registry.refresh();

		expect(urls).not.toContain("http://127.0.0.1:8000/v1/models");
	});

	test("treats auth none only vllm config as explicit built-in discovery", async () => {
		fs.writeFileSync(modelsPath, ["providers:", "  vllm:", "    auth: none"].join("\n"));

		const fetchMock: (input: string | URL | Request, init?: RequestInit) => Promise<Response> = async (
			input,
			init,
		) => {
			const url = String(input);
			if (url !== "http://127.0.0.1:8000/v1/models") {
				throw new Error(`Unexpected URL: ${url}`);
			}
			expect(init?.signal).toBeInstanceOf(AbortSignal);
			return new Response(JSON.stringify({ data: [{ id: "DefaultVllm", max_model_len: 262_144 }] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		};

		const registry = new ModelRegistryImpl(authStorage, modelsPath, { fetch: fetchMock });
		await registry.refreshProvider("vllm");

		expect(registry.find("vllm", "DefaultVllm")?.contextWindow).toBe(262_144);
	});

	test("refetches built-in vllm discovery when the configured baseUrl changes", async () => {
		fs.writeFileSync(
			modelsPath,
			["providers:", "  vllm:", "    baseUrl: http://192.168.5.3:8085/v1", "    auth: none"].join("\n"),
		);

		const calls: string[] = [];
		const fetchMock: (input: string | URL | Request) => Promise<Response> = async input => {
			const url = String(input);
			if (url === "http://192.168.5.3:8085/v1/models") {
				calls.push(url);
				return new Response(JSON.stringify({ data: [{ id: "Old", max_model_len: 262_144 }] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			if (url === "http://192.168.5.4:8085/v1/models") {
				calls.push(url);
				return new Response(JSON.stringify({ data: [{ id: "New", max_model_len: 524_288 }] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			throw new Error(`Unexpected URL: ${url}`);
		};

		const firstRegistry = new ModelRegistryImpl(authStorage, modelsPath, { fetch: fetchMock });
		await firstRegistry.refreshProvider("vllm");
		expect(firstRegistry.find("vllm", "Old")?.contextWindow).toBe(262_144);

		fs.writeFileSync(
			modelsPath,
			["providers:", "  vllm:", "    baseUrl: http://192.168.5.4:8085/v1", "    auth: none"].join("\n"),
		);
		const secondRegistry = new ModelRegistryImpl(authStorage, modelsPath, { fetch: fetchMock });
		await secondRegistry.refresh();

		expect(secondRegistry.find("vllm", "New")?.contextWindow).toBe(524_288);
		expect(calls).toEqual(["http://192.168.5.3:8085/v1/models", "http://192.168.5.4:8085/v1/models"]);
	});
	test("loads built-in vllm cache from the configured baseUrl namespace", async () => {
		fs.writeFileSync(
			modelsPath,
			["providers:", "  vllm:", "    baseUrl: http://192.168.5.3:8085/v1", "    auth: none"].join("\n"),
		);

		const fetchMock: (input: string | URL | Request) => Promise<Response> = async input => {
			const url = String(input);
			if (url !== "http://192.168.5.3:8085/v1/models") {
				throw new Error(`Unexpected URL: ${url}`);
			}
			return new Response(JSON.stringify({ data: [{ id: "Cached", max_model_len: 262_144 }] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		};

		const firstRegistry = new ModelRegistryImpl(authStorage, modelsPath, { fetch: fetchMock });
		await firstRegistry.refreshProvider("vllm");
		expect(firstRegistry.find("vllm", "Cached")?.contextWindow).toBe(262_144);

		const cachedRegistry = new ModelRegistryImpl(authStorage, modelsPath, {
			fetch: async input => {
				throw new Error(`Unexpected online fetch: ${String(input)}`);
			},
		});
		expect(cachedRegistry.find("vllm", "Cached")?.contextWindow).toBe(262_144);
	});

	test("does not send vllm-local placeholder as discovery bearer", async () => {
		fs.writeFileSync(
			modelsPath,
			[
				"providers:",
				"  vllm:",
				"    baseUrl: http://192.168.5.3:8085/v1",
				"    apiKey: vllm-local",
				"    api: openai-completions",
				"    discovery:",
				"      type: openai-models-list",
			].join("\n"),
		);

		const fetchMock: (input: string | URL | Request, init?: RequestInit) => Promise<Response> = async (
			input,
			init,
		) => {
			const url = String(input);
			if (url !== "http://192.168.5.3:8085/v1/models") {
				throw new Error(`Unexpected URL: ${url}`);
			}
			const headers = init?.headers as Headers | Record<string, string> | undefined;
			const authHeader = headers instanceof Headers ? headers.get("Authorization") : headers?.Authorization;
			expect(authHeader).toBeUndefined();
			return new Response(JSON.stringify({ data: [{ id: "DeepSeek-V4-Flash", max_model_len: 262_144 }] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		};

		const registry = new ModelRegistryImpl(authStorage, modelsPath, { fetch: fetchMock });
		await registry.refreshProvider("vllm");

		expect(registry.getProviderDiscoveryState("vllm")?.status).toBe("ok");
	});

	test("does not send llama.cpp-local placeholder as discovery bearer", async () => {
		fs.writeFileSync(
			modelsPath,
			[
				"providers:",
				"  llama.cpp:",
				"    baseUrl: http://127.0.0.1:8080",
				"    apiKey: llama-cpp-local",
				"    api: openai-responses",
				"    discovery:",
				"      type: llama.cpp",
			].join("\n"),
		);

		const fetchMock: (input: string | URL | Request, init?: RequestInit) => Promise<Response> = async (
			input,
			init,
		) => {
			const url = String(input);
			if (url === "http://127.0.0.1:8080/props") {
				const headers = init?.headers as Headers | Record<string, string> | undefined;
				const authHeader = headers instanceof Headers ? headers.get("Authorization") : headers?.Authorization;
				expect(authHeader).toBeUndefined();
				return new Response(JSON.stringify({ default_generation_settings: { n_ctx: 8192 } }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			if (url !== "http://127.0.0.1:8080/models") {
				throw new Error(`Unexpected URL: ${url}`);
			}
			const headers = init?.headers as Headers | Record<string, string> | undefined;
			const authHeader = headers instanceof Headers ? headers.get("Authorization") : headers?.Authorization;
			expect(authHeader).toBeUndefined();
			return new Response(JSON.stringify({ data: [{ id: "local-llama" }] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		};

		const registry = new ModelRegistryImpl(authStorage, modelsPath, { fetch: fetchMock });
		await registry.refreshProvider("llama.cpp");

		expect(registry.getProviderDiscoveryState("llama.cpp")?.status).toBe("ok");
	});
});
