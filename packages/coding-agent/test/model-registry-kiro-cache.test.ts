import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { FetchImpl, Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { writeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { resolveProviderModels } from "@oh-my-pi/pi-catalog/model-manager";
import { kiroModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

describe("ModelRegistry Kiro cache isolation", () => {
	let tempDir: string;
	let modelsPath: string;
	let cacheDbPath: string;
	let authStorage: AuthStorage;

	beforeEach(async () => {
		tempDir = path.join(os.tmpdir(), `pi-test-kiro-cache-${Snowflake.next()}`);
		await fs.promises.mkdir(tempDir, { recursive: true });
		modelsPath = path.join(tempDir, "models.json");
		cacheDbPath = path.join(tempDir, "models.db");
		authStorage = await AuthStorage.create(":memory:");
	});

	afterEach(() => {
		authStorage.close();
		if (fs.existsSync(tempDir)) removeSyncWithRetries(tempDir);
	});

	test("restores only the selected credential's cache and ignores a bare legacy row", async () => {
		const profileA = "arn:aws:codewhisperer:us-east-1:123456789012:profile/profile-a";
		const profileB = "arn:aws:codewhisperer:us-east-1:123456789012:profile/profile-b";
		const credentialA = JSON.stringify({ token: "kiro-token-a", profileArn: profileA });
		const credentialB = JSON.stringify({ token: "kiro-token-b", profileArn: profileB });
		const discoveredModelId = "kiro-profile-a-model";
		const bareModelId = "kiro-bare-legacy-model";
		let discoveryCalls = 0;

		const discoveryFetch: FetchImpl = async () => {
			discoveryCalls += 1;
			return Response.json({
				defaultModel: discoveredModelId,
				models: [
					{
						modelId: discoveredModelId,
						modelName: "Profile A model",
						supportedInputTypes: ["TEXT"],
						tokenLimits: { maxInputTokens: 32_000, maxOutputTokens: 4_000 },
					},
				],
			});
		};

		const managerOptions = kiroModelManagerOptions({ apiKey: credentialA, fetch: discoveryFetch });
		const seeded = await resolveProviderModels({ ...managerOptions, cacheDbPath }, "online");
		expect(seeded.models.map(model => model.id)).toEqual([discoveredModelId]);
		expect(discoveryCalls).toBe(1);

		const bareModel = buildModel({
			id: bareModelId,
			name: "Legacy bare Kiro model",
			api: "kiro-api",
			provider: "kiro",
			baseUrl: "https://runtime.us-east-1.kiro.dev/",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 32_000,
			maxTokens: 4_000,
		});
		writeModelCache("kiro", Date.now(), [bareModel as Model], true, "", cacheDbPath);

		authStorage.keys.setRuntime("kiro", credentialA);
		const offlineFetch: FetchImpl = async input => {
			throw new Error(`Kiro offline restore unexpectedly fetched ${String(input)}`);
		};
		const profileARegistry = new ModelRegistry(authStorage, modelsPath, { fetch: offlineFetch });
		await profileARegistry.refreshProvider("kiro", "offline");

		expect(profileARegistry.find("kiro", discoveredModelId)?.name).toBe("Profile A model");
		expect(profileARegistry.find("kiro", bareModelId)).toBeUndefined();
		expect(discoveryCalls).toBe(1);

		authStorage.keys.setRuntime("kiro", credentialB);
		const profileBRegistry = new ModelRegistry(authStorage, modelsPath, { fetch: offlineFetch });
		await profileBRegistry.refreshProvider("kiro", "offline");

		expect(profileBRegistry.find("kiro", discoveredModelId)).toBeUndefined();
		expect(profileBRegistry.find("kiro", bareModelId)).toBeUndefined();
		expect(profileBRegistry.getAll().filter(model => model.provider === "kiro")).toHaveLength(0);
		expect(discoveryCalls).toBe(1);
	});

	test("restores the cache selected by a persisted Kiro API-key endpoint", async () => {
		const endpointA = "https://runtime.eu-central-1.kiro.dev/";
		const endpointB = "https://runtime.us-east-1.kiro.dev/";
		const credentialA = JSON.stringify({ token: "kiro-api-key", apiEndpoint: endpointA });
		const discoveredModelId = "kiro-api-key-model";
		let discoveryCalls = 0;

		const discoveryFetch: FetchImpl = async () => {
			discoveryCalls += 1;
			return Response.json({
				models: [
					{
						modelId: discoveredModelId,
						modelName: "API key model",
						supportedInputTypes: ["TEXT"],
						tokenLimits: { maxInputTokens: 32_000, maxOutputTokens: 4_000 },
					},
				],
			});
		};

		const seeded = await resolveProviderModels(
			{
				...kiroModelManagerOptions({ apiKey: credentialA, fetch: discoveryFetch }),
				cacheDbPath,
			},
			"online",
		);
		expect(seeded.models.map(model => model.id)).toEqual([discoveredModelId]);
		expect(discoveryCalls).toBe(1);

		await authStorage.credentials.set("kiro", {
			type: "api_key",
			key: "kiro-api-key",
			apiEndpoint: endpointA,
			source: "login",
		});
		expect(await authStorage.keys.peek("kiro")).toBe(credentialA);

		let offlineCalls = 0;
		const offlineFetch: FetchImpl = async input => {
			offlineCalls += 1;
			throw new Error(`Kiro offline restore unexpectedly fetched ${String(input)}`);
		};
		const endpointARegistry = new ModelRegistry(authStorage, modelsPath, { fetch: offlineFetch });
		await endpointARegistry.refreshProvider("kiro", "offline");
		expect(endpointARegistry.find("kiro", discoveredModelId)?.name).toBe("API key model");
		expect(offlineCalls).toBe(0);

		await authStorage.credentials.set("kiro", {
			type: "api_key",
			key: "kiro-api-key",
			apiEndpoint: endpointB,
			source: "login",
		});
		const endpointBRegistry = new ModelRegistry(authStorage, modelsPath, { fetch: offlineFetch });
		await endpointBRegistry.refreshProvider("kiro", "offline");
		expect(endpointBRegistry.find("kiro", discoveredModelId)).toBeUndefined();
		expect(offlineCalls).toBe(0);
	});
});
