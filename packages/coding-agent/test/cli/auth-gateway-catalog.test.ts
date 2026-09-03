import { describe, expect, test, vi } from "bun:test";
import type { AuthStorage } from "@oh-my-pi/pi-ai";
import { getBundledModels } from "@oh-my-pi/pi-catalog/models";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createStrictCompletionProbe, indexModelsByRequestId } from "../../src/cli/auth-gateway-cli";
import { ModelRegistry } from "../../src/config/model-registry";

function stubAuthStorage(configKeys?: string[]): AuthStorage {
	const stub = {
		setFallbackResolver: () => {},
		clearConfigApiKeys: () => {},
		setConfigApiKey: (provider: string) => configKeys?.push(provider),
		removeConfigApiKey: () => {},
		hasAuth: () => true,
		getAll: () => ({ anthropic: {} }),
	};
	return stub as unknown as AuthStorage;
}

describe("strict credential probes", () => {
	test("sends the Muse subscription key instead of the Meta account token", async () => {
		let authorization = "";
		let requestedModel = "";
		const preconnect = fetch.preconnect;
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
			Object.assign(
				(_input: string | URL | Request, init?: RequestInit) => {
					authorization = new Headers(init?.headers).get("Authorization") ?? "";
					const body = JSON.parse(String(init?.body)) as { model?: unknown };
					requestedModel = typeof body.model === "string" ? body.model : "";
					const sse = [
						`data: ${JSON.stringify({
							type: "response.output_item.done",
							item: {
								type: "message",
								id: "msg_probe",
								role: "assistant",
								status: "completed",
								content: [{ type: "output_text", text: "pong", annotations: [] }],
							},
						})}`,
						`data: ${JSON.stringify({
							type: "response.completed",
							response: {
								status: "completed",
								usage: {
									input_tokens: 1,
									output_tokens: 1,
									total_tokens: 2,
									input_tokens_details: { cached_tokens: 0 },
								},
							},
						})}`,
					].join("\n\n");
					return Promise.resolve(new Response(`${sse}\n\n`, { headers: { "content-type": "text/event-stream" } }));
				},
				{ preconnect },
			),
		);
		try {
			const result = await createStrictCompletionProbe()({
				provider: "meta",
				credentialId: 1,
				credential: {
					type: "oauth",
					accessToken: "meta-account-access",
					apiKey: "LLM|subscription-key",
				},
				signal: new AbortController().signal,
			});

			expect(result.ok).toBe(true);
			expect(authorization).toBe("Bearer LLM|subscription-key");
			expect(requestedModel).toBe("muse-spark-1.3");
		} finally {
			fetchSpy.mockRestore();
		}
	});
});

describe("indexModelsByRequestId (auth-gateway catalog)", () => {
	test("resolves a discovery-only model absent from the bundled catalog", () => {
		const registry = new ModelRegistry(stubAuthStorage());
		// Simulate a model reached via provider discovery but not compiled into
		// the bundle (e.g. a post-release id). registerProvider merges it into
		// getAll() exactly as runtime discovery does.
		registry.registerProvider("anthropic", {
			baseUrl: "https://api.anthropic.com",
			api: "anthropic-messages",
			apiKey: "test-key",
			models: [
				{
					id: "claude-opus-5-repro",
					name: "Claude Opus 5 (repro)",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 200000,
					maxTokens: 8192,
				},
			],
		});
		expect(getBundledModels("anthropic").map(m => m.id)).not.toContain("claude-opus-5-repro");

		const index = indexModelsByRequestId(registry.getAll(), new Set(["anthropic"]));

		// The gateway can now resolve it by qualified id and bare id — was
		// "Unknown model" when the index was built from getBundledModels only.
		expect(index.get("anthropic/claude-opus-5-repro")?.id).toBe("claude-opus-5-repro");
		expect(index.get("claude-opus-5-repro")?.id).toBe("claude-opus-5-repro");
	});

	test("gateway registry ignores local models.yml credential and routing overrides", async () => {
		using tempDir = TempDir.createSync("@omp-auth-gateway-catalog-");
		const modelsPath = tempDir.join("models.yml");
		// anthropic: a plain credential/baseUrl override (no transport) — the
		// reviewer's leak. openai: a pi-native gateway route — the self-routing loop.
		await Bun.write(
			modelsPath,
			[
				"providers:",
				"  anthropic:",
				"    baseUrl: http://127.0.0.1:18899",
				"    apiKey: gateway-token",
				"  openai:",
				"    baseUrl: http://127.0.0.1:18899",
				"    apiKey: gateway-token",
				"    transport: pi-native",
				"",
			].join("\n"),
		);

		// A normal client registry applies the local overrides and installs the
		// config API keys into AuthStorage.
		const clientKeys: string[] = [];
		const clientRegistry = new ModelRegistry(stubAuthStorage(clientKeys), modelsPath);
		expect(clientRegistry.find("anthropic", "claude-sonnet-4-5")?.baseUrl).toBe("http://127.0.0.1:18899");
		expect(clientRegistry.getAll().find(model => model.provider === "openai")?.transport).toBe("pi-native");
		expect(clientKeys).toContain("anthropic");

		// The gateway registry ignores models.yml entirely: bundled routing wins,
		// no config key reaches AuthStorage, and no pi-native self-route survives.
		const gatewayKeys: string[] = [];
		const gatewayRegistry = new ModelRegistry(stubAuthStorage(gatewayKeys), modelsPath, {
			ignoreLocalModelConfig: true,
		});
		const gatewayModel = gatewayRegistry.find("anthropic", "claude-sonnet-4-5");
		const bundledModel = getBundledModels("anthropic").find(model => model.id === "claude-sonnet-4-5");
		if (!gatewayModel || !bundledModel) throw new Error("expected bundled Anthropic model");

		expect(gatewayModel.baseUrl).toBe(bundledModel.baseUrl);
		expect(gatewayModel.transport).toBeUndefined();
		expect(gatewayKeys).toHaveLength(0);
		expect(gatewayRegistry.getAll().find(model => model.provider === "openai")?.transport).toBeUndefined();
		expect(indexModelsByRequestId(gatewayRegistry.getAll(), new Set(["anthropic"])).get(gatewayModel.id)).toBe(
			gatewayModel,
		);
	});

	test("scopes the catalog to providers with credentials", () => {
		const registry = new ModelRegistry(stubAuthStorage());
		const all = registry.getAll();
		const anthropicModel = all.find(m => m.provider === "anthropic");
		const foreignModel = all.find(m => m.provider !== "anthropic");
		if (!anthropicModel || !foreignModel) throw new Error("expected mixed-provider bundled catalog");

		const index = indexModelsByRequestId(all, new Set(["anthropic"]));

		expect(index.get(`anthropic/${anthropicModel.id}`)).toBeDefined();
		expect(index.get(`${foreignModel.provider}/${foreignModel.id}`)).toBeUndefined();
	});
});
