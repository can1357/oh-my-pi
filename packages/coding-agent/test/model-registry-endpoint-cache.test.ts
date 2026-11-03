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
});
