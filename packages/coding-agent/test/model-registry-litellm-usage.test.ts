import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs";
import {
	AuthStorage,
	SqliteAuthCredentialStore,
	type UsageFetchParams,
	type UsageLogger,
	type UsageProvider,
	type UsageReport,
} from "@oh-my-pi/pi-ai";
import { litellmUsageProvider } from "@oh-my-pi/pi-ai/usage/litellm";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { cfgDisabledProviders } from "@oh-my-pi/pi-coding-agent/config/model-settings";
import { invalidateAllCommandConfigs, resolveConfigValue } from "@oh-my-pi/pi-coding-agent/config/resolve-config-value";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { TempDir } from "@oh-my-pi/pi-utils";

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function stdoutCommand(value: string): string {
	if (process.platform !== "win32") return `printf %s ${shellQuote(value)}`;
	return `${JSON.stringify(process.execPath)} -e ${JSON.stringify(`process.stdout.write(${JSON.stringify(value)})`)}`;
}

const REPORT_NOTE = "Reported key/user budget counters may lag enforcement; other gateway limits are not included.";
const USER_SCOPE_NOTE = "Whether the user budget applies to team-scoped requests depends on gateway policy.";

const A_BASE_URL = "https://a.example/pa/v1";
const A_USER_INFO = "https://a.example/pa/v2/user/info";
const B_BASE_URL = "https://b.example/pb/v1";
const B_USER_INFO = "https://b.example/pb/v2/user/info";
const PROXY_BASE_URL = "https://proxy.example/root/v1";
const PROXY_KEY_INFO = "https://proxy.example/root/key/info";
const PROXY_USER_INFO = "https://proxy.example/root/v2/user/info";

type GatewayRoute = (bearer: string | undefined) => Response;

/**
 * Injected usage fetch standing in for every gateway: records each request's
 * full URL and bearer, routes by full URL, and 404s anything unrouted. No test
 * here may reach a real gateway, including the host's ambient LiteLLM alias.
 */
function createGateway(routes: Record<string, GatewayRoute>) {
	const requests: string[] = [];
	const fetchImpl: typeof fetch = Object.assign(
		async (input: string | URL | Request, init?: RequestInit) => {
			const url = input instanceof Request ? input.url : input.toString();
			const authorization = new Headers(init?.headers).get("authorization") ?? "";
			const bearer = authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : undefined;
			requests.push(`${bearer ?? "<none>"} ${url}`);
			return routes[url]?.(bearer) ?? new Response(null, { status: 404 });
		},
		{ preconnect: fetch.preconnect },
	);
	return {
		fetch: fetchImpl,
		/** Requests since the previous call as sorted `bearer url` lines (one pass probes concurrently). */
		take(): string[] {
			return requests.splice(0).sort();
		},
	};
}

/** Answers only the listed bearers, like a gateway rejecting keys it does not know. */
function byBearer(responses: Record<string, () => Response>): GatewayRoute {
	return bearer => (bearer === undefined ? undefined : responses[bearer]?.()) ?? new Response(null, { status: 401 });
}

/** Flat `/v2/user/info` record LiteLLM serves for the authenticated user. */
function userInfo(userId: string, spend: number, maxBudget: number): () => Response {
	return () =>
		Response.json({
			user_id: userId,
			spend,
			max_budget: maxBudget,
			budget_duration: "30d",
			budget_reset_at: "2030-01-01T00:00:00Z",
		});
}

/** `/key/info` response for the authenticated management key. */
function keyInfo(userId: string, spend: number, maxBudget: number): () => Response {
	return () => Response.json({ info: { user_id: userId, spend, max_budget: maxBudget } });
}

function litellmAlias(baseUrl: string | undefined, apiKey: string, extra: Record<string, unknown> = {}) {
	return {
		api: "openai-completions",
		...(baseUrl ? { baseUrl } : {}),
		apiKey,
		discovery: { type: "litellm" },
		...extra,
	};
}

function staticReport(provider: string, limitId: string, used: number, limit: number): UsageReport {
	return {
		provider,
		fetchedAt: Date.now(),
		limits: [{ id: limitId, label: limitId, scope: { provider }, amount: { used, limit, unit: "usd" } }],
	};
}

let modelsMtimeSeconds = 1_700_000_000;

/** Write models.yml with a distinct mtime so the next offline refresh reloads it. */
function writeModels(tempDir: TempDir, providers: Record<string, unknown>): void {
	const file = tempDir.join("models.yml");
	fs.writeFileSync(file, JSON.stringify({ providers }));
	modelsMtimeSeconds += 60;
	fs.utimesSync(file, modelsMtimeSeconds, modelsMtimeSeconds);
}

const openStorages: AuthStorage[] = [];

async function createUsageStorage(options: {
	fetch: typeof fetch;
	resolver?: (provider: string) => UsageProvider | undefined;
	store?: SqliteAuthCredentialStore;
	logger?: UsageLogger;
}): Promise<AuthStorage> {
	const authStorage = new AuthStorage(options.store ?? new SqliteAuthCredentialStore(new Database(":memory:")), {
		usageFetch: options.fetch,
		// Built-ins only where a test names them; configured aliases resolve above this.
		usageProviderResolver: options.resolver ?? (() => undefined),
		usageLogger: options.logger,
	});
	openStorages.push(authStorage);
	await authStorage.credentials.reload();
	return authStorage;
}

function builtInLiteLLMOnly(provider: string): UsageProvider | undefined {
	return provider === "litellm" ? litellmUsageProvider : undefined;
}

function createRegistry(
	authStorage: AuthStorage,
	tempDir: TempDir,
	options: { settings?: Settings; ignoreLocalModelConfig?: boolean } = {},
): ModelRegistry {
	return new ModelRegistry(authStorage, tempDir.join("models.yml"), {
		settings: options.settings ?? Settings.isolated(),
		cacheDbPath: tempDir.join("models.db"),
		ignoreLocalModelConfig: options.ignoreLocalModelConfig,
	});
}

/** Aggregate usage the way `omp usage` asks for it. */
function usageReports(
	authStorage: AuthStorage,
	registry: ModelRegistry,
	provider?: string,
): Promise<UsageReport[] | null> {
	return authStorage.usage.reports({ provider, baseUrlResolver: id => registry.getProviderBaseUrl(id) });
}

/** One sorted `provider limit-id used/limit` line per reported budget. */
function budgetRows(reports: readonly UsageReport[] | null): string[] {
	return (reports ?? [])
		.flatMap(report =>
			report.limits.map(limit => `${report.provider} ${limit.id} ${limit.amount.used}/${limit.amount.limit}`),
		)
		.sort();
}

/** Built-in key budget id: an opaque hash of the key keeps several keys of one owner apart. */
function litellmKeyBudgetId(apiKey: string): string {
	return `litellm:key:${Bun.hash(apiKey).toString(16)}:budget`;
}

async function withEnv(overrides: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> {
	const previous = new Map(Object.keys(overrides).map(key => [key, Bun.env[key]]));
	try {
		for (const [key, value] of Object.entries(overrides)) {
			if (value === undefined) delete Bun.env[key];
			else Bun.env[key] = value;
		}
		await fn();
	} finally {
		for (const [key, value] of previous) {
			if (value === undefined) delete Bun.env[key];
			else Bun.env[key] = value;
		}
	}
}

/** Broker-backed store: owns aggregate usage for the providers it reports. */
class BrokerUsageStore extends SqliteAuthCredentialStore {
	readonly requestedProviders: Array<string | undefined> = [];
	readonly #reports: UsageReport[] | null;

	constructor(reports: UsageReport[] | null) {
		super(new Database(":memory:"));
		this.#reports = reports;
	}

	async fetchUsageReports(_signal?: AbortSignal, provider?: string): Promise<UsageReport[] | null> {
		this.requestedProviders.push(provider);
		return this.#reports ? [...this.#reports] : null;
	}
}

describe("ModelRegistry LiteLLM usage registration", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		invalidateAllCommandConfigs();
		for (const authStorage of openStorages.splice(0)) authStorage.close();
	});

	test("cold LiteLLM aliases report their own gateway budgets before any discovery", async () => {
		using tempDir = TempDir.createSync("@omp-litellm-usage-");
		const gateway = createGateway({
			[A_USER_INFO]: byBearer({ "fixture-a": userInfo("user-a", 25, 100) }),
			[B_USER_INFO]: byBearer({ "fixture-b": userInfo("user-b", 90, 100) }),
		});
		writeModels(tempDir, {
			"gateway-a": litellmAlias(A_BASE_URL, "fixture-a"),
			"gateway-b": litellmAlias(B_BASE_URL, "fixture-b"),
			// Another discovery type never sends its config key to a LiteLLM management endpoint.
			"models-list": {
				api: "openai-completions",
				baseUrl: "https://c.example/v1",
				apiKey: "fixture-c",
				discovery: { type: "openai-models-list" },
			},
		});
		const authStorage = await createUsageStorage({ fetch: gateway.fetch });
		const registry = createRegistry(authStorage, tempDir);

		expect(budgetRows(await usageReports(authStorage, registry))).toEqual([
			"gateway-a gateway-a:user:budget 25/100",
			"gateway-b gateway-b:user:budget 90/100",
		]);
		expect(gateway.take()).toEqual([`fixture-a ${A_USER_INFO}`, `fixture-b ${B_USER_INFO}`]);
	});

	test("alias usage follows the pinned request key and never falls back to a stored key", async () => {
		using tempDir = TempDir.createSync("@omp-litellm-usage-");
		const gateway = createGateway({
			[A_USER_INFO]: byBearer({
				"cmd-key": userInfo("user-a", 10, 100),
				"runtime-key": userInfo("user-a", 20, 100),
				"sk-stale": userInfo("user-a", 99, 100),
			}),
			"https://a.example/pa/key/info": byBearer({ "sk-stale": keyInfo("user-a", 99, 100) }),
			[B_USER_INFO]: byBearer({ "fixture-b": userInfo("user-b", 90, 100) }),
		});
		const commandKey = `!${stdoutCommand("cmd-key")}`;
		const writeAliasKey = (apiKey: string) =>
			writeModels(tempDir, {
				"gateway-a": litellmAlias(A_BASE_URL, apiKey),
				"gateway-b": litellmAlias(B_BASE_URL, "fixture-b"),
			});
		writeAliasKey(commandKey);
		const debug = vi.fn((_message: string, _meta?: Record<string, unknown>) => {});
		const authStorage = await createUsageStorage({ fetch: gateway.fetch, logger: { debug, warn: vi.fn() } });
		await authStorage.credentials.set("gateway-a", { type: "api_key", key: "sk-stale" });
		const registry = createRegistry(authStorage, tempDir);
		const gatewayB = "gateway-b gateway-b:user:budget 90/100";

		// The models.yml command key wins over the stored key.
		expect(budgetRows(await usageReports(authStorage, registry))).toEqual([
			"gateway-a gateway-a:user:budget 10/100",
			gatewayB,
		]);
		// A runtime --api-key wins over the config key.
		authStorage.keys.setRuntime("gateway-a", "runtime-key");
		expect(budgetRows(await usageReports(authStorage, registry))).toEqual([
			"gateway-a gateway-a:user:budget 20/100",
			gatewayB,
		]);
		// An empty runtime key falls through to the config key, exactly as the inference cascade does.
		authStorage.keys.setRuntime("gateway-a", "");
		expect(budgetRows(await usageReports(authStorage, registry))).toEqual([
			"gateway-a gateway-a:user:budget 10/100",
			gatewayB,
		]);
		expect(await authStorage.keys.peek("gateway-a")).toBe("cmd-key");
		authStorage.keys.removeRuntime("gateway-a");

		// Config keys that resolve to nothing suppress the probe instead of falling back.
		for (const unresolvable of [`!${stdoutCommand("")}`, "!exit 1"]) {
			writeAliasKey(unresolvable);
			await registry.refresh("offline");
			expect(budgetRows(await usageReports(authStorage, registry))).toEqual([gatewayB]);
		}
		// So does a failed resolution, logged without its error or the command text.
		writeAliasKey(commandKey);
		await registry.refresh("offline");
		authStorage.keys.setResolver(async config => {
			if (config === commandKey) throw new Error("resolver failure secret-detail");
			return resolveConfigValue(config);
		});
		expect(budgetRows(await usageReports(authStorage, registry))).toEqual([gatewayB]);
		expect(debug).toHaveBeenCalledWith("Usage request key resolution failed", { provider: "gateway-a" });
		expect(JSON.stringify(debug.mock.calls)).not.toMatch(/secret-detail|printf/);

		expect(gateway.take()).toEqual([
			`cmd-key ${A_USER_INFO}`,
			`fixture-b ${B_USER_INFO}`,
			`runtime-key ${A_USER_INFO}`,
		]);
	});

	test("an offline config reload re-targets alias usage and stops probing removed or re-typed aliases", async () => {
		using tempDir = TempDir.createSync("@omp-litellm-usage-");
		const b2BaseUrl = "https://b2.example/pb2/v1";
		const b2UserInfo = "https://b2.example/pb2/v2/user/info";
		const gateway = createGateway({
			[A_USER_INFO]: byBearer({ "fixture-a": userInfo("user-a", 25, 100) }),
			[B_USER_INFO]: byBearer({ "fixture-b": userInfo("user-b", 90, 100) }),
			[b2UserInfo]: byBearer({ "fixture-b2": userInfo("user-b", 40, 100) }),
		});
		writeModels(tempDir, {
			"gateway-a": litellmAlias(A_BASE_URL, "fixture-a"),
			"gateway-b": litellmAlias(B_BASE_URL, "fixture-b"),
		});
		const authStorage = await createUsageStorage({ fetch: gateway.fetch });
		const registry = createRegistry(authStorage, tempDir);
		expect(budgetRows(await usageReports(authStorage, registry))).toEqual([
			"gateway-a gateway-a:user:budget 25/100",
			"gateway-b gateway-b:user:budget 90/100",
		]);
		gateway.take();

		writeModels(tempDir, { "gateway-b": litellmAlias(b2BaseUrl, "fixture-b2") });
		await registry.refresh("offline");
		expect(authStorage.usage.providerFor("gateway-a")).toBeUndefined();
		expect(budgetRows(await usageReports(authStorage, registry))).toEqual(["gateway-b gateway-b:user:budget 40/100"]);
		expect(gateway.take()).toEqual([`fixture-b2 ${b2UserInfo}`]);

		writeModels(tempDir, {
			"gateway-b": {
				api: "openai-completions",
				baseUrl: b2BaseUrl,
				apiKey: "fixture-b2",
				discovery: { type: "openai-models-list" },
			},
		});
		await registry.refresh("offline");
		expect(authStorage.usage.providerFor("gateway-b")).toBeUndefined();
		expect(await usageReports(authStorage, registry)).toEqual([]);
		expect(gateway.take()).toEqual([]);
	});

	test("disabled aliases and ignored local config get no usage probes; policy reapply follows the setting", async () => {
		using tempDir = TempDir.createSync("@omp-litellm-usage-");
		const gateway = createGateway({
			[A_USER_INFO]: byBearer({ "fixture-a": userInfo("user-a", 25, 100) }),
			[B_USER_INFO]: byBearer({ "fixture-b": userInfo("user-b", 90, 100) }),
		});
		writeModels(tempDir, {
			"gateway-a": litellmAlias(A_BASE_URL, "fixture-a"),
			"gateway-b": litellmAlias(B_BASE_URL, "fixture-b"),
		});
		// Constructor overrides outrank later writes, so seed the setting through its writable layer.
		const settings = Settings.isolated();
		cfgDisabledProviders.set(settings, ["gateway-a"]);
		const authStorage = await createUsageStorage({ fetch: gateway.fetch });
		const registry = createRegistry(authStorage, tempDir, { settings });
		const rowA = "gateway-a gateway-a:user:budget 25/100";
		const rowB = "gateway-b gateway-b:user:budget 90/100";

		expect(authStorage.usage.providerFor("gateway-a")).toBeUndefined();
		expect(budgetRows(await usageReports(authStorage, registry))).toEqual([rowB]);

		// The setting toggles without a models.yml change; the policy reapply re-syncs registrations.
		cfgDisabledProviders.set(settings, []);
		await registry.reapplyModelPolicies();
		expect(budgetRows(await usageReports(authStorage, registry))).toEqual([rowA, rowB]);

		cfgDisabledProviders.set(settings, ["gateway-a"]);
		await registry.reapplyModelPolicies();
		expect(authStorage.usage.providerFor("gateway-a")).toBeUndefined();
		expect(budgetRows(await usageReports(authStorage, registry))).toEqual([rowB]);
		expect(gateway.take()).toEqual([`fixture-a ${A_USER_INFO}`, `fixture-b ${B_USER_INFO}`]);

		// Gateway mode ignores models.yml entirely, so its aliases never reach usage.
		const gatewayStorage = await createUsageStorage({ fetch: gateway.fetch });
		const gatewayRegistry = createRegistry(gatewayStorage, tempDir, { ignoreLocalModelConfig: true });
		expect(gatewayStorage.usage.providerFor("gateway-b")).toBeUndefined();
		expect(await usageReports(gatewayStorage, gatewayRegistry)).toEqual([]);
		expect(gateway.take()).toEqual([]);
	});

	test("built-in LiteLLM reports through its models.yml endpoint and key without a discovery block", async () => {
		await withEnv({ LITELLM_API_KEY: "env-decoy", LITELLM_BASE_URL: "https://env-decoy.example/v1" }, async () => {
			using tempDir = TempDir.createSync("@omp-litellm-usage-");
			const gateway = createGateway({
				[PROXY_USER_INFO]: byBearer({ "fixture-builtin": userInfo("builtin-user", 30, 60) }),
			});
			writeModels(tempDir, { litellm: { baseUrl: PROXY_BASE_URL, apiKey: "fixture-builtin" } });
			const authStorage = await createUsageStorage({ fetch: gateway.fetch, resolver: builtInLiteLLMOnly });
			const registry = createRegistry(authStorage, tempDir);

			expect(budgetRows(await usageReports(authStorage, registry))).toEqual(["litellm litellm:user:budget 30/60"]);
			expect(gateway.take()).toEqual([`fixture-builtin ${PROXY_USER_INFO}`]);
		});
	});

	test("an alias without a baseUrl probes the registry's localhost default; the adapter never guesses one", async () => {
		using tempDir = TempDir.createSync("@omp-litellm-usage-");
		const localUserInfo = "http://localhost:4000/v2/user/info";
		const gateway = createGateway({
			[localUserInfo]: byBearer({ "fixture-local": userInfo("local-user", 1, 10) }),
		});
		writeModels(tempDir, { "local-gateway": litellmAlias(undefined, "fixture-local") });
		const authStorage = await createUsageStorage({ fetch: gateway.fetch });
		const registry = createRegistry(authStorage, tempDir);

		expect(budgetRows(await usageReports(authStorage, registry))).toEqual([
			"local-gateway local-gateway:user:budget 1/10",
		]);
		expect(gateway.take()).toEqual([`fixture-local ${localUserInfo}`]);

		const direct = await litellmUsageProvider.fetchUsage(
			{ provider: "local-gateway", credential: { type: "api_key", apiKey: "fixture-local" } },
			{ fetch: gateway.fetch },
		);
		expect(direct).toBeNull();
		expect(gateway.take()).toEqual([]);
	});

	test("an explicit LiteLLM config claims a built-in provider id until it is removed", async () => {
		using tempDir = TempDir.createSync("@omp-litellm-usage-");
		const zaiUserInfo = "https://zai-gw.example/z/v2/user/info";
		const gateway = createGateway({
			[zaiUserInfo]: byBearer({ "fixture-zai": userInfo("zai-user", 5, 50) }),
		});
		const zaiFetchUsage = vi.fn(async (params: UsageFetchParams) =>
			staticReport(params.provider, "zai:native-quota", 3, 10),
		);
		const zaiUsage: UsageProvider = { id: "zai", fetchUsage: zaiFetchUsage };
		writeModels(tempDir, { zai: litellmAlias("https://zai-gw.example/z/v1", "fixture-zai") });
		const authStorage = await createUsageStorage({
			fetch: gateway.fetch,
			resolver: provider => (provider === "zai" ? zaiUsage : undefined),
		});
		await authStorage.credentials.set("zai", { type: "api_key", key: "zai-stored" });
		const registry = createRegistry(authStorage, tempDir);

		// The gateway bearer goes to LiteLLM management, never to the built-in's native usage probe.
		expect(budgetRows(await usageReports(authStorage, registry))).toEqual(["zai zai:user:budget 5/50"]);
		expect(gateway.take()).toEqual([`fixture-zai ${zaiUserInfo}`]);
		expect(zaiFetchUsage).not.toHaveBeenCalled();

		writeModels(tempDir, {});
		await registry.refresh("offline");
		expect(budgetRows(await usageReports(authStorage, registry))).toEqual(["zai zai:native-quota 3/10"]);
		expect(zaiFetchUsage.mock.calls.map(([params]) => params.credential.apiKey)).toEqual(["zai-stored"]);
		expect(gateway.take()).toEqual([]);
	});

	test("an extension usage adapter outranks the configured alias until its source is cleared", async () => {
		using tempDir = TempDir.createSync("@omp-litellm-usage-");
		const gateway = createGateway({
			[A_USER_INFO]: byBearer({
				"fixture-a": userInfo("user-a", 25, 100),
				"fixture-a-rotated": userInfo("user-a", 35, 100),
			}),
		});
		const aliasModels = { models: [{ id: "alias-model", name: "Alias Model" }] };
		writeModels(tempDir, { "gateway-a": litellmAlias(A_BASE_URL, "fixture-a", aliasModels) });
		const authStorage = await createUsageStorage({ fetch: gateway.fetch });
		const registry = createRegistry(authStorage, tempDir);
		const describeAlias = () => {
			const model = registry.find("gateway-a", "alias-model");
			return {
				models: registry
					.getAll()
					.filter(candidate => candidate.provider === "gateway-a")
					.map(candidate => candidate.id),
				providerBaseUrl: registry.getProviderBaseUrl("gateway-a"),
				api: model?.api,
				modelBaseUrl: model?.baseUrl,
				transport: model?.transport,
			};
		};
		const configuredAlias = describeAlias();
		expect(budgetRows(await usageReports(authStorage, registry))).toEqual(["gateway-a gateway-a:user:budget 25/100"]);

		const sourceId = "ext://litellm-usage-override";
		registry.registerProvider(
			"gateway-a",
			{
				baseUrl: "https://ext.example/v1",
				apiKey: "ext-key",
				transport: "pi-native",
				usage: {
					id: "gateway-a",
					fetchUsage: async params => staticReport(params.provider, "gateway-a:extension-credits", 6, 10),
				},
			},
			sourceId,
		);
		const extensionRows = ["gateway-a gateway-a:extension-credits 6/10"];
		expect(budgetRows(await usageReports(authStorage, registry))).toEqual(extensionRows);

		// A config reload re-syncs configured aliases underneath; the extension stays authoritative.
		writeModels(tempDir, { "gateway-a": litellmAlias(A_BASE_URL, "fixture-a-rotated", aliasModels) });
		await registry.refresh("offline");
		expect(budgetRows(await usageReports(authStorage, registry))).toEqual(extensionRows);
		expect(describeAlias()).toMatchObject({ providerBaseUrl: "https://ext.example/v1", transport: "pi-native" });

		registry.clearSourceRegistrations(sourceId);
		expect(describeAlias()).toEqual(configuredAlias);
		expect(budgetRows(await usageReports(authStorage, registry))).toEqual(["gateway-a gateway-a:user:budget 35/100"]);

		// A live store swap keeps the automatic alias registration.
		await authStorage.replaceStore(new SqliteAuthCredentialStore(new Database(":memory:")));
		expect(budgetRows(await usageReports(authStorage, registry))).toEqual(["gateway-a gateway-a:user:budget 35/100"]);
		expect(gateway.take()).toEqual([
			`fixture-a ${A_USER_INFO}`,
			`fixture-a-rotated ${A_USER_INFO}`,
			`fixture-a-rotated ${A_USER_INFO}`,
		]);
	});

	test("broker-backed usage probes locally only the LiteLLM providers the broker did not report", async () => {
		await withEnv(
			{ LITELLM_API_KEY: "fixture-env", LITELLM_BASE_URL: "https://builtin.example/base/v1" },
			async () => {
				using tempDir = TempDir.createSync("@omp-litellm-usage-");
				const builtinUserInfo = "https://builtin.example/base/v2/user/info";
				const gateway = createGateway({
					[A_USER_INFO]: byBearer({ "fixture-a": userInfo("user-a", 25, 100) }),
					[B_USER_INFO]: byBearer({ "fixture-b": userInfo("user-b", 90, 100) }),
					[builtinUserInfo]: byBearer({ "fixture-env": userInfo("env-user", 2, 20) }),
				});
				writeModels(tempDir, {
					"gateway-a": litellmAlias(A_BASE_URL, "fixture-a"),
					"gateway-b": litellmAlias(B_BASE_URL, "fixture-b"),
				});
				const brokerAnthropic = staticReport("anthropic", "anthropic:broker", 1, 4);
				const brokerAlias = staticReport("gateway-a", "gateway-a:broker-budget", 3, 8);
				const session = async (brokerReports: UsageReport[] | null) => {
					const store = new BrokerUsageStore(brokerReports);
					const authStorage = await createUsageStorage({
						fetch: gateway.fetch,
						resolver: builtInLiteLLMOnly,
						store,
					});
					const registry = createRegistry(authStorage, tempDir);
					const resolveConfig = vi.fn(resolveConfigValue);
					authStorage.keys.setResolver(resolveConfig);
					return { authStorage, registry, store, resolveConfig };
				};
				const rowA = "gateway-a gateway-a:user:budget 25/100";
				const rowB = "gateway-b gateway-b:user:budget 90/100";
				const rowBuiltin = "litellm litellm:user:budget 2/20";

				// Absent aliases and the env-keyed built-in merge into the broker's reports.
				const merged = await session([brokerAnthropic]);
				expect(budgetRows(await usageReports(merged.authStorage, merged.registry))).toEqual([
					"anthropic anthropic:broker 1/4",
					rowA,
					rowB,
					rowBuiltin,
				]);
				expect(gateway.take()).toEqual([
					`fixture-a ${A_USER_INFO}`,
					`fixture-b ${B_USER_INFO}`,
					`fixture-env ${builtinUserInfo}`,
				]);

				// A same-name broker report owns the alias: its key is never resolved nor probed.
				const owned = await session([brokerAnthropic, brokerAlias]);
				expect(budgetRows(await usageReports(owned.authStorage, owned.registry))).toEqual([
					"anthropic anthropic:broker 1/4",
					"gateway-a gateway-a:broker-budget 3/8",
					rowB,
					rowBuiltin,
				]);
				expect(gateway.take()).toEqual([`fixture-b ${B_USER_INFO}`, `fixture-env ${builtinUserInfo}`]);
				expect(owned.resolveConfig).toHaveBeenCalledWith("fixture-b");
				expect(owned.resolveConfig).not.toHaveBeenCalledWith("fixture-a");

				// A provider filter reaches the broker and limits local probing to that provider.
				const filtered = await session([brokerAnthropic]);
				expect(budgetRows(await usageReports(filtered.authStorage, filtered.registry, "gateway-b"))).toEqual([
					rowB,
				]);
				expect(filtered.store.requestedProviders).toEqual(["gateway-b"]);
				expect(gateway.take()).toEqual([`fixture-b ${B_USER_INFO}`]);

				// No broker answer stays no answer.
				const unavailable = await session(null);
				expect(await usageReports(unavailable.authStorage, unavailable.registry)).toBeNull();
				expect(gateway.take()).toEqual([]);
			},
		);
	});

	test("built-in LiteLLM keeps a budget per stored key, one per owner, and partitions by its default endpoint", async () => {
		await withEnv({ LITELLM_API_KEY: undefined, LITELLM_BASE_URL: undefined }, async () => {
			using tempDir = TempDir.createSync("@omp-litellm-usage-");
			const gateway = createGateway({
				[PROXY_KEY_INFO]: byBearer({ "sk-one": keyInfo("u1", 5, 50), "sk-two": keyInfo("u1", 7, 70) }),
				[PROXY_USER_INFO]: byBearer({ "sk-one": userInfo("u1", 30, 300), "sk-two": userInfo("u1", 30, 300) }),
				"https://first.example/v2/user/info": byBearer({ "fixture-env": userInfo("env-user", 11, 100) }),
				"https://second.example/v2/user/info": byBearer({ "fixture-env": userInfo("env-user", 22, 100) }),
			});
			writeModels(tempDir, { litellm: { baseUrl: PROXY_BASE_URL } });
			const authStorage = await createUsageStorage({ fetch: gateway.fetch, resolver: builtInLiteLLMOnly });
			await authStorage.credentials.set("litellm", [
				{ type: "api_key", key: "sk-one" },
				{ type: "api_key", key: "sk-two" },
			]);
			const registry = createRegistry(authStorage, tempDir);

			const reports = await usageReports(authStorage, registry);
			expect(reports).toHaveLength(1);
			expect(budgetRows(reports)).toEqual(
				[
					`litellm ${litellmKeyBudgetId("sk-one")} 5/50`,
					`litellm ${litellmKeyBudgetId("sk-two")} 7/70`,
					"litellm litellm:user:budget 30/300",
				].sort(),
			);
			gateway.take();

			// Same env key, new LITELLM_BASE_URL: the new endpoint is probed instead of reusing the first one's report.
			writeModels(tempDir, {});
			const envStorage = await createUsageStorage({ fetch: gateway.fetch, resolver: builtInLiteLLMOnly });
			const envRegistry = createRegistry(envStorage, tempDir);
			Bun.env.LITELLM_API_KEY = "fixture-env";
			Bun.env.LITELLM_BASE_URL = "https://first.example/v1";
			expect(budgetRows(await usageReports(envStorage, envRegistry))).toEqual([
				"litellm litellm:user:budget 11/100",
			]);
			Bun.env.LITELLM_BASE_URL = "https://second.example/v1";
			expect(budgetRows(await usageReports(envStorage, envRegistry))).toEqual([
				"litellm litellm:user:budget 22/100",
			]);
			expect(gateway.take()).toEqual([
				"fixture-env https://first.example/v2/user/info",
				"fixture-env https://second.example/v2/user/info",
			]);
		});
	});

	test("merging a newer key-only report with an older user-only report keeps both budgets and both caveats", async () => {
		using tempDir = TempDir.createSync("@omp-litellm-usage-");
		const gateway = createGateway({
			[PROXY_KEY_INFO]: byBearer({
				"sk-key-only": keyInfo("u1", 4, 40),
				"sk-user-only": () => new Response(null, { status: 500 }),
			}),
			[PROXY_USER_INFO]: byBearer({
				"sk-key-only": () => new Response(null, { status: 403 }),
				"sk-user-only": userInfo("u1", 12, 120),
			}),
		});
		writeModels(tempDir, { litellm: { baseUrl: PROXY_BASE_URL } });
		const authStorage = await createUsageStorage({ fetch: gateway.fetch, resolver: builtInLiteLLMOnly });
		const registry = createRegistry(authStorage, tempDir);
		const now = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2029-12-01T00:00:00Z"));

		// The user-only success lands first and stays cached...
		await authStorage.credentials.set("litellm", { type: "api_key", key: "sk-user-only" });
		expect(budgetRows(await usageReports(authStorage, registry))).toEqual(["litellm litellm:user:budget 12/120"]);
		gateway.take();

		// ...then a later key-only success for the same owner becomes the merge base.
		now.mockReturnValue(Date.parse("2029-12-01T00:01:00Z"));
		await authStorage.credentials.set("litellm", [
			{ type: "api_key", key: "sk-key-only" },
			{ type: "api_key", key: "sk-user-only" },
		]);
		const reports = await usageReports(authStorage, registry);
		expect(gateway.take()).toEqual([`sk-key-only ${PROXY_KEY_INFO}`, `sk-key-only ${PROXY_USER_INFO}`]);
		// One owner report: the key-only base keeps its row first, the user-only report adds its budget and caveat.
		expect(
			reports?.map(report => report.limits.map(limit => `${limit.id} ${limit.amount.used}/${limit.amount.limit}`)),
		).toEqual([[`${litellmKeyBudgetId("sk-key-only")} 4/40`, "litellm:user:budget 12/120"]]);
		expect(reports?.[0]?.notes).toEqual([REPORT_NOTE, USER_SCOPE_NOTE]);
	});

	test("an exhausted LiteLLM key budget neither fakes model health nor withholds the inference key", async () => {
		await withEnv({ LITELLM_API_KEY: undefined, LITELLM_BASE_URL: undefined }, async () => {
			using tempDir = TempDir.createSync("@omp-litellm-usage-");
			const gateway = createGateway({
				[PROXY_KEY_INFO]: byBearer({ "sk-exhausted": keyInfo("u1", 0, 0) }),
			});
			writeModels(tempDir, { litellm: { baseUrl: PROXY_BASE_URL } });
			const authStorage = await createUsageStorage({ fetch: gateway.fetch, resolver: builtInLiteLLMOnly });
			await authStorage.credentials.set("litellm", { type: "api_key", key: "sk-exhausted" });
			const registry = createRegistry(authStorage, tempDir);

			const reports = await usageReports(authStorage, registry);
			expect(reports?.flatMap(report => report.limits.map(limit => [limit.id, limit.status]))).toEqual([
				[litellmKeyBudgetId("sk-exhausted"), "exhausted"],
			]);
			expect(gateway.take()).toEqual([`sk-exhausted ${PROXY_KEY_INFO}`, `sk-exhausted ${PROXY_USER_INFO}`]);

			// Without a ranking strategy, a lagging gateway counter never marks the model depleted...
			expect(await authStorage.health.model("litellm", { modelId: "gateway-model", reserveFraction: 0.1 })).toEqual({
				state: "unknown",
				accounts: [],
			});
			// ...nor keeps its key from inference.
			expect(await authStorage.keys.get("litellm")).toBe("sk-exhausted");
			expect(await registry.getApiKeyForProvider("litellm")).toBe("sk-exhausted");

			// Management access is not credential validity: health checks send no management probes.
			const health = await authStorage.health.check();
			expect(health.map(result => [result.provider, result.ok])).toEqual([["litellm", null]]);
			expect(gateway.take()).toEqual([]);
		});
	});
});
