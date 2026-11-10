import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { TempDir } from "@oh-my-pi/pi-utils";

const AMBIENT_ENV = ["LITELLM_API_KEY", "LITELLM_BASE_URL"] as const;

function gatewayAlias(host: string, apiKey: string, discoveryType = "litellm") {
	return { api: "openai-completions", baseUrl: `https://${host}/v1`, apiKey, discovery: { type: discoveryType } };
}

describe("ModelRegistry LiteLLM usage registration", () => {
	const ambient = new Map<string, string | undefined>();
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let probes: string[];
	let usageFetch: typeof fetch;
	let mtime = 1_700_000_000;

	function writeModels(providers: Record<string, unknown>): void {
		const file = tempDir.join("models.yml");
		fs.writeFileSync(file, JSON.stringify({ providers }));
		mtime += 60;
		fs.utimesSync(file, mtime, mtime);
	}

	async function budgets(registry: ModelRegistry): Promise<string[]> {
		const reports = await authStorage.usage.reports({ baseUrlResolver: id => registry.getProviderBaseUrl(id) });
		return (reports ?? []).map(report => `${report.provider} ${report.limits[0]?.amount.used}`).sort();
	}

	beforeEach(async () => {
		for (const key of AMBIENT_ENV) {
			ambient.set(key, Bun.env[key]);
			delete Bun.env[key];
		}
		tempDir = TempDir.createSync("@omp-litellm-usage-");
		probes = [];
		// Every gateway answers its user record with a spend derived from the bearer.
		usageFetch = Object.assign(
			async (input: string | URL | Request, init?: RequestInit) => {
				const url = new URL(String(input));
				const bearer = new Headers(init?.headers).get("authorization")?.replace("Bearer ", "") ?? "";
				probes.push(`${bearer} ${url.host}${url.pathname}`);
				if (url.pathname !== "/v2/user/info") return new Response(null, { status: 404 });
				return Response.json({ user_id: bearer, spend: bearer.length, max_budget: 100 });
			},
			{ preconnect: fetch.preconnect },
		);
		authStorage = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")), { usageFetch });
		await authStorage.credentials.reload();
	});

	afterEach(() => {
		authStorage.close();
		tempDir.removeSync();
		for (const [key, value] of ambient) {
			if (value === undefined) delete Bun.env[key];
			else Bun.env[key] = value;
		}
	});

	function createRegistry(settings = Settings.isolated()): ModelRegistry {
		return new ModelRegistry(authStorage, tempDir.join("models.yml"), {
			settings,
			cacheDbPath: tempDir.join("models.db"),
		});
	}

	test("probes each LiteLLM alias with its models.yml key and endpoint, skipping disabled and non-LiteLLM providers", async () => {
		writeModels({
			"gateway-a": gatewayAlias("a.example", "key-a"),
			"gateway-off": gatewayAlias("off.example", "key-off"),
			"models-list": gatewayAlias("c.example", "key-c", "openai-models-list"),
		});
		const registry = createRegistry(Settings.isolated({ disabledProviders: ["gateway-off"] }));

		expect(await budgets(registry)).toEqual(["gateway-a 5"]);
		expect(probes).toEqual(["key-a a.example/v2/user/info"]);
	});

	test("a models.yml reload re-keys, adds, and removes alias usage", async () => {
		writeModels({ "gateway-a": gatewayAlias("a.example", "key-a") });
		const registry = createRegistry();
		expect(await budgets(registry)).toEqual(["gateway-a 5"]);

		writeModels({ "gateway-b": gatewayAlias("b.example", "key-b-rotated") });
		await registry.refresh("offline");
		expect(authStorage.usage.providerFor("gateway-a")).toBeUndefined();
		probes.length = 0;
		expect(await budgets(registry)).toEqual(["gateway-b 13"]);
		expect(probes).toEqual(["key-b-rotated b.example/v2/user/info"]);
	});

	test("probes with the key inference would send, not a stale stored key", async () => {
		writeModels({ "gateway-a": gatewayAlias("a.example", "key-a") });
		await authStorage.credentials.set("gateway-a", { type: "api_key", key: "stale-stored" });
		const registry = createRegistry();
		expect(await budgets(registry)).toEqual(["gateway-a 5"]);

		// A runtime --api-key outranks the models.yml key, for usage as for inference.
		authStorage.keys.setRuntime("gateway-a", "runtime-key");
		await authStorage.usage.invalidate("gateway-a");
		expect(await budgets(registry)).toEqual(["gateway-a 11"]);
		expect(probes).toEqual(["key-a a.example/v2/user/info", "runtime-key a.example/v2/user/info"]);
	});

	test("a new process reuses the persisted report instead of re-probing the gateway", async () => {
		writeModels({ "gateway-a": gatewayAlias("a.example", "key-a") });
		const dbPath = tempDir.join("agent.db");
		const openProcess = async (): Promise<AuthStorage> => {
			const storage = new AuthStorage(await SqliteAuthCredentialStore.open(dbPath), { usageFetch });
			await storage.credentials.reload();
			return storage;
		};

		const first = await openProcess();
		const firstRegistry = new ModelRegistry(first, tempDir.join("models.yml"), {
			settings: Settings.isolated(),
			cacheDbPath: tempDir.join("models.db"),
		});
		await first.usage.reports({ baseUrlResolver: id => firstRegistry.getProviderBaseUrl(id) });
		first.close();
		expect(probes).toEqual(["key-a a.example/v2/user/info"]);

		const second = await openProcess();
		try {
			const registry = new ModelRegistry(second, tempDir.join("models.yml"), {
				settings: Settings.isolated(),
				cacheDbPath: tempDir.join("models.db"),
			});
			const reports = await second.usage.reports({ baseUrlResolver: id => registry.getProviderBaseUrl(id) });
			expect(reports?.map(report => report.provider)).toEqual(["gateway-a"]);
			expect(probes).toEqual(["key-a a.example/v2/user/info"]);
		} finally {
			second.close();
		}
	});
});
