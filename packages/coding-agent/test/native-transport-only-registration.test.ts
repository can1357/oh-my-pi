import { afterEach, describe, expect, it, vi } from "bun:test";
import { getCustomApi } from "@oh-my-pi/pi-ai/api-registry";
import { getOAuthProvider, registerOAuthProvider, unregisterOAuthProviders } from "@oh-my-pi/pi-ai/oauth";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import * as catalogProviders from "@oh-my-pi/pi-catalog/compat/providers";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

/**
 * A provider declaring `native-transport-only "<api>"` in its catalog rules
 * (Kiro) keeps its built-in transport and login: extensions may override it
 * like any built-in, but a registration that would shadow the native
 * transport is refused with a warning instead of aborting startup.
 */
describe("native-transport-only provider registrations", () => {
	const cleanups: Array<() => void> = [];
	afterEach(() => {
		for (const cleanup of cleanups.splice(0).reverse()) cleanup();
		vi.restoreAllMocks();
	});

	function declareNative(): void {
		vi.spyOn(catalogProviders, "nativeTransportOwner").mockImplementation(id =>
			id === "acme" || id === "openai-completions" ? { provider: "acme", api: "openai-completions" } : undefined,
		);
	}

	function registry(): ModelRegistry {
		const dir = TempDir.createSync("omp-native-transport-");
		const authStorage = createInMemoryAuthStorage();
		cleanups.push(
			() => dir.removeSync(),
			() => authStorage.close(),
			() => unregisterOAuthProviders("legacy"),
		);
		return new ModelRegistry(authStorage, dir.join("models.yml"));
	}

	const row = (id: string, api: "anthropic-messages" | "openai-completions") => ({
		id,
		name: id,
		api,
		reasoning: false,
		input: ["text" as const],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 32_000,
		maxTokens: 4_000,
	});

	it("refuses a shadowing registration with a warning and keeps the native API's rows off a gateway", async () => {
		declareNative();
		const models = registry();
		const oauth = { name: "Shadow", login: async () => ({ access: "a", refresh: "r", expires: 0 }) };

		models.registerProvider(
			"acme",
			{
				baseUrl: "https://shadow.example.invalid/",
				api: "shadow-api",
				streamSimple: createMockModel({ handler: () => ({ content: ["shadow"] }) }).stream,
				oauth,
			},
			"legacy",
		);
		models.registerProvider("acme", { baseUrl: "http://gateway.example.invalid", transport: "pi-native" }, "legacy");
		expect(getCustomApi("shadow-api")).toBeUndefined();
		expect(getOAuthProvider("acme")).toBeUndefined();
		const warnings = models.drainConfigWarnings();
		expect(warnings).toHaveLength(2);
		expect(warnings[0]).toContain("api, streamSimple, oauth");
		expect(warnings[1]).toContain("transport");
		// The registration seams outside the model registry refuse it too.
		expect(() => registerOAuthProvider({ ...oauth, id: "acme", sourceId: "legacy" })).toThrow();

		// An extension's own models keep its transport; rows on the native API do not.
		models.registerProvider(
			"acme",
			{
				baseUrl: "http://gateway.example.invalid",
				apiKey: "gateway-token",
				transport: "pi-native",
				fetchDynamicModels: async () => [
					row("gateway-model", "anthropic-messages"),
					row("native-model", "openai-completions"),
				],
			},
			"legacy",
		);
		await models.refreshProvider("acme", "online");
		expect(models.find("acme", "gateway-model")?.transport).toBe("pi-native");
		expect(models.find("acme", "native-model")?.transport).toBeUndefined();
		expect(models.drainConfigWarnings()).toEqual([]);
	});

	it("leaves providers without the setting free to register their own transport and login", () => {
		const models = registry();
		const oauth = { name: "Acme", login: async () => ({ access: "a", refresh: "r", expires: 0 }) };

		models.registerProvider("acme", { baseUrl: "https://acme.example.invalid/", oauth }, "legacy");

		expect(getOAuthProvider("acme")?.name).toBe("Acme");
		expect(models.drainConfigWarnings()).toEqual([]);
	});
});
