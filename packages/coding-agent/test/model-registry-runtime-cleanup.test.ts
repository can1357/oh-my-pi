import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type AssistantMessageEventStream, clearCustomApis, getCustomApi } from "@oh-my-pi/pi-ai";
import { getOAuthProvider } from "@oh-my-pi/pi-ai/oauth";
import { ModelRegistry, type ProviderConfigInput } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";

describe("ModelRegistry runtime source cleanup", () => {
	let authStorage: AuthStorage;

	const sourceId = "ext://runtime-cleanup";
	const baseModel: NonNullable<ProviderConfigInput["models"]>[number] = {
		id: "runtime-model",
		name: "Runtime Model",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 8192,
	};

	const streamSimple: NonNullable<ProviderConfigInput["streamSimple"]> = () =>
		({}) as unknown as AssistantMessageEventStream;

	beforeEach(async () => {
		authStorage = await AuthStorage.create(":memory:");
	});

	afterEach(() => {
		clearCustomApis();
		authStorage.close();
	});

	test("clearSourceRegistrations removes runtime overlays and fallback auth for that source", () => {
		const registry = new ModelRegistry(authStorage, undefined, { ignoreLocalModelConfig: true });
		const config: ProviderConfigInput = {
			baseUrl: "https://runtime.example.com/v1",
			apiKey: "RUNTIME_KEY",
			api: "custom-runtime-cleanup-api",
			streamSimple,
			models: [baseModel],
		};

		registry.registerProvider("runtime-provider", config, sourceId);

		expect(registry.find("runtime-provider", "runtime-model")).toBeDefined();
		expect(registry.authStorage.hasAuth("runtime-provider")).toBe(true);
		expect(getCustomApi("custom-runtime-cleanup-api")).toBeDefined();

		registry.clearSourceRegistrations(sourceId);

		expect(registry.find("runtime-provider", "runtime-model")).toBeUndefined();
		expect(registry.authStorage.hasAuth("runtime-provider")).toBe(false);
		expect(getCustomApi("custom-runtime-cleanup-api")).toBeUndefined();
	});

	test("unregisterProvider removes only the named provider and its login entry", () => {
		const registry = new ModelRegistry(authStorage, undefined, { ignoreLocalModelConfig: true });
		registry.registerProvider(
			"runtime-provider",
			{
				baseUrl: "https://runtime.example.com/v1",
				apiKey: "RUNTIME_KEY",
				api: "custom-runtime-cleanup-api",
				streamSimple,
				models: [baseModel],
				oauth: {
					name: "Runtime Provider",
					login: async () => "runtime-token",
				},
			},
			sourceId,
		);
		registry.registerProvider(
			"peer-provider",
			{
				baseUrl: "https://peer.example.com/v1",
				apiKey: "PEER_KEY",
				api: "openai-completions",
				models: [{ ...baseModel, id: "peer-model" }],
			},
			sourceId,
		);

		expect(getOAuthProvider("runtime-provider")).toBeDefined();
		registry.unregisterProvider("runtime-provider");

		expect(registry.find("runtime-provider", "runtime-model")).toBeUndefined();
		expect(registry.authStorage.hasAuth("runtime-provider")).toBe(false);
		expect(getOAuthProvider("runtime-provider")).toBeUndefined();
		expect(registry.find("peer-provider", "peer-model")).toBeDefined();
	});
});
