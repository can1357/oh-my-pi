import { afterEach, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { FetchImpl, Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { writeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { resolveProviderModels } from "@oh-my-pi/pi-catalog/model-manager";
import { kiroModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models";
import { encodeKiroCredential } from "@oh-my-pi/pi-catalog/wire/kiro-credential";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

const RUNTIME = "https://runtime.us-east-1.kiro.dev/";
const apiKey = (apiEndpoint: string) => encodeKiroCredential({ kind: "api_key", token: "ksk_key", apiEndpoint });

let tempDir: string;
let authStorage: AuthStorage;

beforeEach(async () => {
	tempDir = path.join(os.tmpdir(), `pi-test-kiro-cache-${Snowflake.next()}`);
	await fs.promises.mkdir(tempDir, { recursive: true });
	authStorage = await AuthStorage.create(":memory:");
});

afterEach(() => {
	authStorage.close();
	if (fs.existsSync(tempDir)) removeSyncWithRetries(tempDir);
});

test("an offline ModelRegistry restores only the Kiro cache keyed by the stored login", async () => {
	const cacheDbPath = path.join(tempDir, "models.db");
	const seededKey = apiKey("https://runtime.eu-central-1.kiro.dev/");
	const discovered = {
		modelId: "kiro-discovered",
		modelName: "Discovered",
		supportedInputTypes: ["TEXT"],
		tokenLimits: { maxInputTokens: 32_000, maxOutputTokens: 4_000 },
	};
	const discoveryFetch: FetchImpl = async () => Response.json({ models: [discovered] });
	await resolveProviderModels(
		{ ...kiroModelManagerOptions({ apiKey: seededKey, fetch: discoveryFetch }), cacheDbPath },
		"online",
	);
	// A bare legacy row (no credential scope) must never be restored.
	const bare = buildModel({
		id: "kiro-bare",
		name: "Bare",
		api: "kiro-api",
		provider: "kiro",
		baseUrl: RUNTIME,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 32_000,
		maxTokens: 4_000,
	});
	writeModelCache("kiro", Date.now(), [bare as Model], true, "", cacheDbPath);

	const offlineFetch: FetchImpl = async input => {
		throw new Error(`offline restore fetched ${String(input)}`);
	};
	const restore = async (key: string) => {
		await authStorage.credentials.set("kiro", { type: "api_key", key, source: "login" });
		const registry = new ModelRegistry(authStorage, path.join(tempDir, "models.json"), { fetch: offlineFetch });
		await registry.refreshProvider("kiro", "offline");
		return registry
			.getAll()
			.filter(model => model.provider === "kiro")
			.map(model => model.id);
	};
	expect(await restore(seededKey)).toEqual(["kiro-discovered"]);
	expect(await restore(apiKey(RUNTIME))).toEqual([]);
});
