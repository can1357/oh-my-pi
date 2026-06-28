import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type AssistantMessageEventStream, clearCustomApis, getCustomApi } from "@pk-nerdsaver-ai/pi-ai";
import { ModelRegistry, type ProviderConfigInput } from "@pk-nerdsaver-ai/pi-coding-agent/config/model-registry";
import { AuthStorage } from "@pk-nerdsaver-ai/pi-coding-agent/session/auth-storage";
import { removeSyncWithRetries, Snowflake } from "@pk-nerdsaver-ai/pi-utils";

describe("ModelRegistry runtime source cleanup", () => {
	let tempDir: string;
	let modelsJsonPath: string;
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
		tempDir = path.join(os.tmpdir(), `pi-test-model-registry-runtime-cleanup-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		modelsJsonPath = path.join(tempDir, "models.json");
		authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"));
	});

	afterEach(() => {
		clearCustomApis();
		authStorage.close();
		if (tempDir && fs.existsSync(tempDir)) {
			removeSyncWithRetries(tempDir);
		}
	});

	test("clearSourceRegistrations removes runtime overlays and fallback auth for that source", () => {
		const registry = new ModelRegistry(authStorage, modelsJsonPath);
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
});
