import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type Api, complete, type Model } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";

const GATEWAY = "http://gateway.invalid:4000";
const FAKE_KEY = "sk-ant-api03-not-a-real-key";
const GATEWAY_CONFIG = `providers:\n  anthropic:\n    baseUrl: ${GATEWAY}\n`;
const DIRECT_CONFIG = "providers:\n  anthropic:\n    compat:\n      replayUnsignedThinking: false\n";

/** Send one real request through the provider's transport and return the URL it reached. */
async function requestUrl(model: Model<Api>): Promise<string> {
	const urls: string[] = [];
	const stub = async (input: string | URL | Request) => {
		urls.push(input instanceof Request ? input.url : String(input));
		return Response.json(
			{ type: "error", error: { type: "authentication_error", message: "stub" } },
			{ status: 401 },
		);
	};
	await complete(
		model,
		{ messages: [{ role: "user", content: "hi", timestamp: 0 }] },
		{ apiKey: FAKE_KEY, fetch: Object.assign(stub, { preconnect: fetch.preconnect }) },
	);
	expect(urls.length).toBeGreaterThan(0);
	return urls[0];
}

describe("model cache follows the configured endpoint", () => {
	let tempDir: string;
	let modelsPath: string;
	let authStorage: AuthStorage;

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-test-endpoint-cache-"));
		modelsPath = path.join(tempDir, "models.yml");
		authStorage = await AuthStorage.create(path.join(tempDir, "agent.db"));
		await authStorage.credentials.set("anthropic", { type: "api_key", key: FAKE_KEY });
		// A previous process discovered the Anthropic roster through a gateway
		// configured as the built-in provider's baseUrl. The gateway lists a bundled
		// id and one only it serves.
		fs.writeFileSync(modelsPath, GATEWAY_CONFIG);
		const gatewayRegistry = new ModelRegistry(authStorage, modelsPath, {
			fetch: async input => {
				const url = String(input);
				if (url === `${GATEWAY}/v1/models`) {
					return Response.json({
						data: [
							{ id: "claude-opus-5-5", type: "model" },
							{ id: "gateway-only-model", type: "model" },
						],
					});
				}
				throw new Error(`offline: ${url}`);
			},
		});
		await gatewayRegistry.refreshProvider("anthropic", "online");
		expect(gatewayRegistry.find("anthropic", "claude-opus-5-5")?.baseUrl).toBe(GATEWAY);
	});

	afterEach(() => {
		authStorage.close();
		if (tempDir && fs.existsSync(tempDir)) removeSyncWithRetries(tempDir);
	});

	test("removing the provider baseUrl sends the gateway-discovered model to the built-in endpoint", async () => {
		fs.writeFileSync(modelsPath, DIRECT_CONFIG);
		const registry = new ModelRegistry(authStorage, modelsPath, {
			fetch: () => Promise.reject(new Error("offline")),
		});
		const discovered = registry.find("anthropic", "claude-opus-5-5");
		const bundledOnly = registry.find("anthropic", "claude-opus-5");
		if (!discovered || !bundledOnly) throw new Error("expected both Anthropic models");
		// The gateway's roster is not the built-in endpoint's.
		expect(registry.find("anthropic", "gateway-only-model")).toBeUndefined();

		const url = await requestUrl(discovered);
		expect(new URL(url).host).not.toBe(new URL(GATEWAY).host);
		// Same endpoint as a model the gateway never listed: the built-in default.
		expect(new URL(url).origin).toBe(new URL(await requestUrl(bundledOnly)).origin);
	});

	test("a configured gateway still gets its cached roster after a restart", async () => {
		const registry = new ModelRegistry(authStorage, modelsPath, {
			fetch: () => Promise.reject(new Error("offline")),
		});
		const model = registry.find("anthropic", "gateway-only-model");
		if (!model) throw new Error("expected the gateway's cached model");
		expect(new URL(await requestUrl(model)).origin).toBe(GATEWAY);
	});

	test("a models.yml discovery provider moved to another endpoint does not list the old endpoint's roster", async () => {
		const config = (baseUrl: string) =>
			`providers:\n  probe:\n    baseUrl: ${baseUrl}\n    api: openai-completions\n    apiKey: ${FAKE_KEY}\n    discovery:\n      type: openai-models-list\n`;
		fs.writeFileSync(modelsPath, config("http://endpoint-a.invalid/v1"));
		const before = new ModelRegistry(authStorage, modelsPath, {
			fetch: async input => {
				if (String(input) === "http://endpoint-a.invalid/v1/models") {
					return Response.json({ data: [{ id: "endpoint-a-only-model" }] });
				}
				throw new Error(`offline: ${String(input)}`);
			},
		});
		await before.refreshProvider("probe", "online");
		expect(before.find("probe", "endpoint-a-only-model")).toBeDefined();

		fs.writeFileSync(modelsPath, config("http://endpoint-b.invalid/v1"));
		const after = new ModelRegistry(authStorage, modelsPath, {
			fetch: () => Promise.reject(new Error("offline")),
		});
		await after.refresh("offline");
		expect(after.find("probe", "endpoint-a-only-model")).toBeUndefined();
	});

	test("a discovery still running when the baseUrl is removed does not restore the gateway roster", async () => {
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const registry = new ModelRegistry(authStorage, modelsPath, {
			fetch: async input => {
				if (String(input) === `${GATEWAY}/v1/models`) {
					started.resolve();
					await release.promise;
					return Response.json({ data: [{ id: "late-gateway-model", type: "model" }] });
				}
				throw new Error(`offline: ${String(input)}`);
			},
		});
		try {
			const inFlight = registry.refreshProvider("anthropic", "online");
			await started.promise;
			fs.writeFileSync(modelsPath, DIRECT_CONFIG);
			await registry.refreshProvider("anthropic", "offline");
			release.resolve();
			await inFlight;
		} finally {
			release.resolve();
		}
		expect(registry.find("anthropic", "late-gateway-model")).toBeUndefined();
		expect(registry.find("anthropic", "gateway-only-model")).toBeUndefined();
		const model = registry.find("anthropic", "claude-opus-5-5");
		if (!model) throw new Error("expected the bundled model");
		expect(new URL(await requestUrl(model)).host).not.toBe(new URL(GATEWAY).host);
	});

	test("an extension's discovered roster for a built-in provider id is gone once the extension is", async () => {
		fs.writeFileSync(modelsPath, DIRECT_CONFIG);
		const extensionHost = "http://extension.invalid:4000";
		const registry = new ModelRegistry(authStorage, modelsPath, {
			fetch: () => Promise.reject(new Error("offline")),
		});
		registry.registerProvider(
			"anthropic",
			{
				baseUrl: extensionHost,
				api: "anthropic-messages",
				fetchDynamicModels: async () => [
					{
						id: "extension-only-model",
						name: "Extension Only",
						reasoning: false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 200_000,
						maxTokens: 8_192,
					},
				],
			},
			"test-extension",
		);
		await registry.refreshRuntimeProviders("online");
		expect(registry.find("anthropic", "extension-only-model")).toBeDefined();
		registry.unregisterProvider("anthropic");

		const restarted = new ModelRegistry(authStorage, modelsPath, {
			fetch: () => Promise.reject(new Error("offline")),
		});
		expect(restarted.find("anthropic", "extension-only-model")).toBeUndefined();
	});
});
