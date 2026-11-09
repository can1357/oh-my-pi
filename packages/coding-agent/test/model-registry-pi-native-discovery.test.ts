import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { FetchImpl } from "@oh-my-pi/pi-ai";
import type { Api, Model } from "@oh-my-pi/pi-ai/types";
import { getBundledModel, getBundledModels } from "@oh-my-pi/pi-catalog/models";
import {
	type DiscoveryProviderConfig,
	discoverPiNativeGatewayModels,
} from "@oh-my-pi/pi-coding-agent/config/model-discovery";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";

const GATEWAY = "https://gateway.test";
const PROVIDER = "openai-codex";
/** The gateway test hosts' model list, with or without userinfo in front of the host. */
const GATEWAY_MODELS_URL_RE = /gateway\.test\/v1\/models$/;

interface GatewayRow {
	id: string;
	api?: string;
	kind?: string;
	display_name?: string;
	context_length?: number;
	max_output_tokens?: number;
	input_modalities?: string[];
	supports_tools?: boolean;
}

interface RecordedRequest {
	url: string;
	headers: Headers;
	rawHeaderNames: string[];
	redirect: RequestInit["redirect"];
}

function isChat(model: Model<Api>): boolean {
	return (model.kind ?? "chat") === "chat";
}

describe("ModelRegistry pi-native gateway discovery", () => {
	let tempDir: string;
	let modelsPath: string;
	let cacheDbPath: string;
	let authStorage: AuthStorage;
	let requests: RecordedRequest[];

	// A bundled chat id the gateway serves, and one it does not.
	const bundledChatIds = getBundledModels(PROVIDER)
		.filter(isChat)
		.map(model => model.id);
	const servedBundledId = bundledChatIds[0];
	const unservedBundledId = bundledChatIds[1];
	const bundledImageIds = getBundledModels(PROVIDER)
		.filter(model => !isChat(model))
		.map(model => model.id);

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-test-pi-native-discovery-"));
		modelsPath = path.join(tempDir, "models.json");
		cacheDbPath = path.join(tempDir, "models.db");
		authStorage = await AuthStorage.create(":memory:");
		requests = [];
	});

	afterEach(() => {
		resetSettingsForTest();
		authStorage.close();
		removeSyncWithRetries(tempDir);
	});

	function writeProviders(providers: Record<string, unknown>) {
		fs.writeFileSync(modelsPath, JSON.stringify({ providers }));
	}

	function piNativeProvider(extra: Record<string, unknown> = {}) {
		return {
			[PROVIDER]: {
				transport: "pi-native",
				baseUrl: GATEWAY,
				apiKey: "gateway-token",
				headers: { "CF-Access-Client-Id": "client-id" },
				...extra,
			},
		};
	}

	function gatewayFetch(rows: GatewayRow[], status = 200): FetchImpl {
		return async (input, init) => {
			const url = input instanceof Request ? input.url : String(input);
			if (!GATEWAY_MODELS_URL_RE.test(url)) throw new Error(`Unexpected URL: ${url}`);
			const rawHeaders = (init?.headers ?? {}) as Record<string, string>;
			requests.push({
				url,
				headers: new Headers(init?.headers),
				rawHeaderNames: Object.keys(rawHeaders),
				redirect: init?.redirect,
			});
			return status === 200 ? Response.json({ object: "list", data: rows }) : new Response("denied", { status });
		};
	}

	const unreachable: FetchImpl = async () => {
		throw new Error("gateway unreachable");
	};

	function createRegistry(fetch: FetchImpl) {
		return new ModelRegistry(authStorage, modelsPath, { cacheDbPath, fetch });
	}

	function providerModels(registry: ModelRegistry) {
		return registry.getAll("all").filter(model => model.provider === PROVIDER);
	}

	function chatIds(registry: ModelRegistry) {
		return providerModels(registry)
			.filter(isChat)
			.map(model => model.id)
			.sort();
	}

	function modelsRequests() {
		return requests.filter(entry => GATEWAY_MODELS_URL_RE.test(entry.url));
	}

	const rows: GatewayRow[] = [
		{ id: `${PROVIDER}/${servedBundledId}`, api: "openai-codex-responses" },
		{
			id: `${PROVIDER}/gpt-gateway-only`,
			api: "openai-codex-responses",
			display_name: "Gateway Only",
			context_length: 400_000,
			max_output_tokens: 64_000,
			input_modalities: ["text", "image"],
		},
		{
			id: `${PROVIDER}/gpt-image-gateway`,
			api: "openai-codex-responses",
			kind: "image",
			display_name: "Gateway Image",
		},
		{ id: "anthropic/claude-other-provider", api: "anthropic-messages" },
		{ id: "unqualified-model", api: "openai-completions" },
	];
	const snapshotChatIds = [servedBundledId, "gpt-gateway-only"].sort();

	test("chat roster is the gateway's own-provider chat rows with the prefix stripped", async () => {
		writeProviders(piNativeProvider());
		const registry = createRegistry(gatewayFetch(rows));
		await registry.refresh("online");

		expect(chatIds(registry)).toEqual(snapshotChatIds);
		// Other providers' rows never leak in, qualified or not.
		expect(registry.find("anthropic", "claude-other-provider")).toBeUndefined();
		expect(registry.find(PROVIDER, "unqualified-model")).toBeUndefined();
		expect(registry.find(PROVIDER, `${PROVIDER}/gpt-gateway-only`)).toBeUndefined();

		const gatewayOnly = registry.find(PROVIDER, "gpt-gateway-only");
		expect(gatewayOnly?.name).toBe("Gateway Only");
		expect(gatewayOnly?.contextWindow).toBe(400_000);
		expect(gatewayOnly?.maxTokens).toBe(64_000);
		expect(gatewayOnly?.input).toEqual(["text", "image"]);
		expect(gatewayOnly?.transport).toBe("pi-native");
		expect(gatewayOnly?.baseUrl).toBe(GATEWAY);
	});

	test("non-chat rows are not published and bundled non-chat rows stay", async () => {
		expect(bundledImageIds.length).toBeGreaterThan(0);
		writeProviders(piNativeProvider());
		const registry = createRegistry(gatewayFetch(rows));
		await registry.refresh("online");

		// The gateway rejects non-chat models on `/v1/pi/stream` and their runners
		// ignore the transport: a discovered row would be unusable.
		expect(registry.find(PROVIDER, "gpt-image-gateway")).toBeUndefined();
		// The gateway's authority covers the chat roster only.
		const remaining = providerModels(registry)
			.filter(model => !isChat(model))
			.map(model => model.id)
			.sort();
		expect(remaining).toEqual([...bundledImageIds].sort());
	});

	test("sends the bearer, the provider headers and no attribution headers, without following redirects", async () => {
		writeProviders(piNativeProvider());
		const registry = createRegistry(gatewayFetch(rows));
		await registry.refresh("online");

		const [request] = modelsRequests();
		expect(request.headers.get("authorization")).toBe("Bearer gateway-token");
		expect(request.headers.get("cf-access-client-id")).toBe("client-id");
		// The gateway's `/v1/models` handler does not read the attribution identity.
		expect(request.headers.get("x-omp-install-id")).toBeNull();
		expect(request.headers.get("x-omp-hostname")).toBeNull();
		expect(request.headers.get("x-omp-app")).toBeNull();
		expect(request.redirect).toBe("manual");
	});

	test("a provider Authorization header replaces the bearer, as on the stream", async () => {
		writeProviders(piNativeProvider({ headers: { Authorization: "Bearer from-headers" } }));
		const registry = createRegistry(gatewayFetch(rows));
		await registry.refresh("online");

		expect(modelsRequests()[0].headers.get("authorization")).toBe("Bearer from-headers");
	});

	test("a lowercase authorization header plus an apiKey sends one credential: the header's", async () => {
		writeProviders(piNativeProvider({ headers: { authorization: "Bearer from-headers" } }));
		const registry = createRegistry(gatewayFetch(rows));
		await registry.refresh("online");

		const [request] = modelsRequests();
		expect(request.rawHeaderNames.filter(name => name.toLowerCase() === "authorization")).toEqual(["authorization"]);
		expect(request.headers.get("authorization")).toBe("Bearer from-headers");
	});

	test("a provider Authorization header alone authenticates discovery", async () => {
		writeProviders(piNativeProvider({ apiKey: undefined, headers: { Authorization: "Bearer from-headers" } }));
		const registry = createRegistry(gatewayFetch(rows));
		await registry.refresh("online");

		expect(modelsRequests()).toHaveLength(1);
		expect(registry.find(PROVIDER, "gpt-gateway-only")).toBeDefined();
		expect(registry.getProviderDiscoveryState(PROVIDER)?.status).toBe("ok");
	});

	test("without a configured credential discovery is skipped and the bundled roster stays", async () => {
		writeProviders(piNativeProvider({ apiKey: undefined, headers: undefined }));
		const registry = createRegistry(gatewayFetch(rows));
		await registry.refresh("online");

		expect(modelsRequests()).toHaveLength(0);
		expect(registry.getProviderDiscoveryState(PROVIDER)?.status).toBe("unauthenticated");
		expect(registry.find(PROVIDER, unservedBundledId)).toBeDefined();
	});

	test("a keyless provider (auth none) discovers without any credential", async () => {
		writeProviders(piNativeProvider({ apiKey: undefined, headers: undefined, auth: "none" }));
		const registry = createRegistry(gatewayFetch(rows));
		await registry.refresh("online");

		const [request] = modelsRequests();
		expect(request.headers.get("authorization")).toBeNull();
		expect(registry.find(PROVIDER, "gpt-gateway-only")).toBeDefined();
	});

	test("a stored OAuth credential for the provider is never sent to the gateway", async () => {
		await authStorage.credentials.set(PROVIDER, {
			type: "oauth",
			access: "chatgpt-oauth-access-token",
			refresh: "chatgpt-oauth-refresh-token",
			expires: Date.now() + 3_600_000,
		});
		writeProviders(piNativeProvider());
		const registry = createRegistry(gatewayFetch(rows));
		await registry.refresh("online");

		const [request] = modelsRequests();
		expect(request.headers.get("authorization")).toBe("Bearer gateway-token");
		expect(JSON.stringify([...request.headers.entries()])).not.toContain("chatgpt-oauth");

		// With no configured gateway credential the stored login is not a substitute.
		requests = [];
		writeProviders(piNativeProvider({ apiKey: undefined, headers: undefined }));
		const withoutKey = createRegistry(gatewayFetch(rows));
		await withoutKey.refresh("online");
		expect(modelsRequests()).toHaveLength(0);
	});

	test("a gateway 401 leaves the stored credentials untouched and triggers no refresh", async () => {
		await authStorage.credentials.set(PROVIDER, {
			type: "oauth",
			access: "chatgpt-oauth-access-token",
			refresh: "chatgpt-oauth-refresh-token",
			expires: Date.now() + 3_600_000,
		});
		const before = JSON.stringify(authStorage.credentials.snapshot().credentials);
		writeProviders(piNativeProvider());
		const registry = createRegistry(gatewayFetch(rows, 401));
		await registry.refresh("online");

		// One request: no retry with a refreshed or rotated credential.
		expect(modelsRequests()).toHaveLength(1);
		expect(JSON.stringify(authStorage.credentials.snapshot().credentials)).toBe(before);
		expect(registry.getProviderDiscoveryState(PROVIDER)?.status).toBe("unauthenticated");
	});

	test("a bundled chat id the gateway does not list is absent", async () => {
		expect(unservedBundledId).toBeDefined();
		writeProviders(piNativeProvider());
		const registry = createRegistry(gatewayFetch(rows));
		// Before the refresh nothing is cached, so the bundled roster still shows.
		expect(registry.find(PROVIDER, unservedBundledId)).toBeDefined();

		await registry.refresh("online");

		expect(registry.find(PROVIDER, unservedBundledId)).toBeUndefined();
		expect(registry.find(PROVIDER, "gpt-gateway-only")).toBeDefined();
	});

	test("a listed bundled id keeps its bundled thinking metadata", async () => {
		writeProviders(piNativeProvider());
		const registry = createRegistry(gatewayFetch(rows));
		await registry.refresh("online");

		// The row carries no thinking metadata: a bundled id keeps its own.
		const bundled = getBundledModel(PROVIDER, servedBundledId);
		const served = registry.find(PROVIDER, servedBundledId);
		expect(served?.reasoning).toBe(bundled.reasoning);
		expect(served?.thinking?.efforts).toEqual(bundled.thinking?.efforts);
	});

	test("supports_tools: false on a row is carried to the model", async () => {
		writeProviders(piNativeProvider());
		const registry = createRegistry(
			gatewayFetch([
				{ id: `${PROVIDER}/gpt-no-tools`, api: "openai-codex-responses", supports_tools: false },
				{ id: `${PROVIDER}/gpt-tools`, api: "openai-codex-responses" },
			]),
		);
		await registry.refresh("online");

		expect(registry.find(PROVIDER, "gpt-no-tools")?.supportsTools).toBe(false);
		expect(registry.find(PROVIDER, "gpt-tools")?.supportsTools).not.toBe(false);
	});

	test("explicit models.yml models and modelOverrides still apply on top of the gateway roster", async () => {
		writeProviders(
			piNativeProvider({
				models: [{ id: "my-local-extra", name: "Extra", api: "openai-codex-responses" }],
				modelOverrides: { "gpt-gateway-only": { name: "Renamed Gateway Model", contextWindow: 123_456 } },
			}),
		);
		const registry = createRegistry(gatewayFetch(rows));
		await registry.refresh("online");

		expect(registry.find(PROVIDER, "my-local-extra")).toBeDefined();
		expect(registry.find(PROVIDER, unservedBundledId)).toBeUndefined();
		const overridden = registry.find(PROVIDER, "gpt-gateway-only");
		expect(overridden?.name).toBe("Renamed Gateway Model");
		expect(overridden?.contextWindow).toBe(123_456);
	});

	test("an unreachable gateway keeps the last snapshot, in a new registry over the same cache", async () => {
		writeProviders(piNativeProvider());
		await createRegistry(gatewayFetch(rows)).refresh("online");

		const later = createRegistry(unreachable);
		// Startup serves the cached gateway roster before any refresh.
		expect(chatIds(later)).toEqual(snapshotChatIds);
		await later.refresh("online");
		expect(chatIds(later)).toEqual(snapshotChatIds);
		expect(later.getProviderDiscoveryState(PROVIDER)?.status).toBe("cached");
	});

	test("an HTTP error from the gateway keeps the last snapshot", async () => {
		writeProviders(piNativeProvider());
		await createRegistry(gatewayFetch(rows)).refresh("online");

		const later = createRegistry(gatewayFetch(rows, 503));
		await later.refresh("online");

		expect(chatIds(later)).toEqual(snapshotChatIds);
		expect(later.getProviderDiscoveryState(PROVIDER)?.status).toBe("cached");
		expect(later.getProviderDiscoveryState(PROVIDER)?.error).toContain("HTTP 503");
	});

	test("an unreachable gateway with no snapshot keeps the bundled roster", async () => {
		writeProviders(piNativeProvider());
		const registry = createRegistry(unreachable);
		await registry.refresh("online");

		expect(registry.find(PROVIDER, unservedBundledId)).toBeDefined();
		expect(registry.getProviderDiscoveryState(PROVIDER)?.status).toBe("unavailable");
	});

	test("an HTML reply keeps the last snapshot instead of emptying the roster", async () => {
		writeProviders(piNativeProvider());
		await createRegistry(gatewayFetch(rows)).refresh("online");

		const html: FetchImpl = async () => new Response("<html>login</html>", { status: 200 });
		const registry = createRegistry(html);
		await registry.refresh("online");

		expect(chatIds(registry)).toEqual(snapshotChatIds);
	});

	test("a JSON object without a data array is an error and keeps the last snapshot", async () => {
		writeProviders(piNativeProvider());
		await createRegistry(gatewayFetch(rows)).refresh("online");

		const registry = createRegistry(async () => Response.json({ error: "maintenance" }));
		await registry.refresh("online");

		expect(chatIds(registry)).toEqual(snapshotChatIds);
		const state = registry.getProviderDiscoveryState(PROVIDER);
		expect(state?.status).toBe("cached");
		expect(state?.error).toContain("did not return a model list");
	});

	test("a JSON object without a data array and no snapshot keeps the bundled roster", async () => {
		writeProviders(piNativeProvider());
		const registry = createRegistry(async () => Response.json({ error: "maintenance" }));
		await registry.refresh("online");

		expect(registry.find(PROVIDER, unservedBundledId)).toBeDefined();
		expect(registry.getProviderDiscoveryState(PROVIDER)?.status).toBe("unavailable");
	});

	test("an empty own-provider reply with no snapshot keeps the bundled roster", async () => {
		writeProviders(piNativeProvider());
		const registry = createRegistry(
			gatewayFetch([{ id: "anthropic/claude-other-provider", api: "anthropic-messages" }]),
		);
		await registry.refresh("online");

		expect(registry.find(PROVIDER, unservedBundledId)).toBeDefined();
	});

	test("an empty own-provider reply that replaces a snapshot brings the bundled roster back", async () => {
		writeProviders(piNativeProvider());
		await createRegistry(gatewayFetch(rows)).refresh("online");

		const later = createRegistry(
			gatewayFetch([{ id: "anthropic/claude-other-provider", api: "anthropic-messages" }]),
		);
		// Startup serves the snapshot, which replaces the bundled chat roster.
		expect(chatIds(later)).toEqual(snapshotChatIds);
		expect(later.find(PROVIDER, unservedBundledId)).toBeUndefined();

		await later.refresh("online");

		expect(later.find(PROVIDER, unservedBundledId)).toBeDefined();
		expect(chatIds(later)).toEqual([...bundledChatIds].sort());
		expect(later.find(PROVIDER, "gpt-gateway-only")).toBeUndefined();
	});

	test("a provider without transport pi-native is unchanged", async () => {
		writeProviders({ [PROVIDER]: { baseUrl: GATEWAY, apiKey: "gateway-token" } });
		const registry = createRegistry(gatewayFetch(rows));
		await registry.refresh("online");

		expect(modelsRequests()).toHaveLength(0);
		expect(registry.find(PROVIDER, unservedBundledId)).toBeDefined();
		expect(registry.find(PROVIDER, "gpt-gateway-only")).toBeUndefined();
	});

	test("an explicit discovery block keeps its own protocol", async () => {
		writeProviders(
			piNativeProvider({ api: "openai-responses", discovery: { type: "openai-models-list" }, headers: undefined }),
		);
		const registry = createRegistry(gatewayFetch([{ id: `${PROVIDER}/gpt-gateway-only` }]));
		await registry.refresh("online");

		// openai-models-list reads the id verbatim: no prefix stripping, no gateway semantics.
		expect(registry.find(PROVIDER, `${PROVIDER}/gpt-gateway-only`)).toBeDefined();
		expect(registry.find(PROVIDER, "gpt-gateway-only")).toBeUndefined();
	});

	test("a snapshot from another base URL does not answer for this one", async () => {
		writeProviders(piNativeProvider());
		await createRegistry(gatewayFetch(rows)).refresh("online");

		writeProviders(piNativeProvider({ baseUrl: "https://other-gateway.test" }));
		const other = createRegistry(unreachable);

		expect(other.find(PROVIDER, "gpt-gateway-only")).toBeUndefined();
	});

	describe("credential scope of the cache", () => {
		const TOKEN_ENV = "PI_NATIVE_DISCOVERY_TEST_TOKEN";
		let previousToken: string | undefined;

		beforeEach(() => {
			previousToken = process.env[TOKEN_ENV];
		});

		afterEach(() => {
			if (previousToken === undefined) delete process.env[TOKEN_ENV];
			else process.env[TOKEN_ENV] = previousToken;
		});

		test("an env-backed token that changes does not reuse the previous token's snapshot", async () => {
			writeProviders(piNativeProvider({ apiKey: TOKEN_ENV }));
			process.env[TOKEN_ENV] = "token-a";
			await createRegistry(gatewayFetch(rows)).refresh("online");

			// Same token: the snapshot answers at startup.
			expect(chatIds(createRegistry(unreachable))).toEqual(snapshotChatIds);

			// Another token, possibly with other grants: no shared snapshot, not even on failure.
			process.env[TOKEN_ENV] = "token-b";
			const other = createRegistry(unreachable);
			expect(other.find(PROVIDER, "gpt-gateway-only")).toBeUndefined();
			await other.refresh("online");
			expect(other.find(PROVIDER, "gpt-gateway-only")).toBeUndefined();
			expect(other.find(PROVIDER, unservedBundledId)).toBeDefined();
		});

		test("a literal apiKey that changes does not reuse the previous snapshot", async () => {
			writeProviders(piNativeProvider({ apiKey: "literal-token-a" }));
			await createRegistry(gatewayFetch(rows)).refresh("online");

			writeProviders(piNativeProvider({ apiKey: "literal-token-b" }));
			expect(createRegistry(unreachable).find(PROVIDER, "gpt-gateway-only")).toBeUndefined();
		});

		test("a changed provider header (client identity) does not reuse the previous snapshot", async () => {
			writeProviders(piNativeProvider());
			await createRegistry(gatewayFetch(rows)).refresh("online");

			writeProviders(piNativeProvider({ headers: { "CF-Access-Client-Id": "another-client" } }));
			expect(createRegistry(unreachable).find(PROVIDER, "gpt-gateway-only")).toBeUndefined();
		});

		test("a !command apiKey is not executed to compute the cache key, only when discovery needs it", async () => {
			const marker = path.join(tempDir, "command-ran");
			writeProviders(piNativeProvider({ apiKey: `!touch '${marker}' && echo command-token` }));
			await createRegistry(gatewayFetch(rows)).refresh("online");
			expect(fs.existsSync(marker)).toBe(true);
			expect(modelsRequests()[0].headers.get("authorization")).toBe("Bearer command-token");

			// A new registry over the cached snapshot (startup path) must not run the command.
			fs.rmSync(marker);
			const later = createRegistry(unreachable);
			expect(chatIds(later)).toEqual(snapshotChatIds);
			expect(fs.existsSync(marker)).toBe(false);
		});
	});

	describe("redirects", () => {
		test("a 3xx reply is an error naming the target origin, and the target receives nothing", async () => {
			const targetHits: string[] = [];
			const target = Bun.serve({
				port: 0,
				fetch(request) {
					targetHits.push(
						`${request.method} ${new URL(request.url).pathname} ${request.headers.get("cf-access-client-id")}`,
					);
					return Response.json({ object: "list", data: rows });
				},
			});
			const origin = Bun.serve({
				port: 0,
				fetch() {
					return new Response(null, {
						status: 302,
						headers: { Location: `http://127.0.0.1:${target.port}/v1/models` },
					});
				},
			});
			try {
				writeProviders(piNativeProvider({ baseUrl: `http://127.0.0.1:${origin.port}` }));
				const registry = createRegistry(globalThis.fetch as FetchImpl);
				await registry.refresh("online");

				expect(targetHits).toEqual([]);
				const state = registry.getProviderDiscoveryState(PROVIDER);
				expect(state?.status).toBe("unavailable");
				expect(state?.error).toContain(`http://127.0.0.1:${target.port}`);
				expect(state?.error).toContain("does not follow redirects");
				expect(registry.find(PROVIDER, unservedBundledId)).toBeDefined();
			} finally {
				await origin.stop(true);
				await target.stop(true);
			}
		});
	});

	describe("error text", () => {
		test("failures carry the URL without userinfo", async () => {
			writeProviders(piNativeProvider({ baseUrl: "https://user:hunter2@gateway.test" }));
			const failures: Array<[string, FetchImpl]> = [
				["http", gatewayFetch(rows, 500)],
				[
					"network",
					async input => {
						throw new Error(`connect ECONNREFUSED ${String(input)}`);
					},
				],
				["shape", async () => Response.json({ nope: true })],
			];
			for (const [, fetch] of failures) {
				const registry = createRegistry(fetch);
				await registry.refresh("online");
				const error = registry.getProviderDiscoveryState(PROVIDER)?.error ?? "";
				expect(error).toContain("gateway.test");
				expect(error).not.toContain("hunter2");
			}
		});
	});
});

describe("discoverPiNativeGatewayModels untrusted reply", () => {
	function discover(data: unknown[]) {
		const providerConfig: DiscoveryProviderConfig = {
			provider: PROVIDER,
			api: "openai-codex-responses",
			baseUrl: GATEWAY,
			discovery: { type: "pi-native-gateway" },
		};
		const fetch: FetchImpl = async () => Response.json({ object: "list", data });
		return discoverPiNativeGatewayModels(providerConfig, { fetch, getBearerApiKeyResolver: async () => undefined });
	}

	test("skips ids with control characters and over-long ids", async () => {
		const models = await discover([
			{ id: `${PROVIDER}/ok-model` },
			{ id: `${PROVIDER}/bell\u0007model` },
			{ id: `${PROVIDER}/c1\u009bmodel` },
			{ id: `${PROVIDER}/${"x".repeat(257)}` },
		]);
		expect(models.map(model => model.id)).toEqual(["ok-model"]);
	});

	test("strips control characters from display names and caps their length", async () => {
		const [model, long] = await discover([
			{ id: `${PROVIDER}/named`, display_name: "  Fancy\u001b[31m Name\u0007  " },
			{ id: `${PROVIDER}/long`, display_name: "n".repeat(500) },
		]);
		expect(model.name).toBe("Fancy[31m Name");
		expect(long.name).toHaveLength(200);
	});

	test("skips rows naming an api this build does not know and keeps known ones", async () => {
		const models = await discover([
			{ id: `${PROVIDER}/known`, api: "openai-completions" },
			{ id: `${PROVIDER}/unknown`, api: "totally-made-up-api" },
			{ id: `${PROVIDER}/non-string`, api: 7 },
		]);
		expect(models.map(model => model.id)).toEqual(["known"]);
		expect(models[0].api).toBe("openai-completions");
	});

	test("accepts only positive safe integers as limits", async () => {
		const [fractional, negative, text, huge, good] = await discover([
			{ id: `${PROVIDER}/fractional`, context_length: 1000.5, max_output_tokens: 10.5 },
			{ id: `${PROVIDER}/negative`, context_length: -5, max_output_tokens: -1 },
			{ id: `${PROVIDER}/text`, context_length: "300000", max_output_tokens: "4096" },
			{ id: `${PROVIDER}/huge`, context_length: 1e300, max_output_tokens: 2 ** 60 },
			{ id: `${PROVIDER}/good`, context_length: 300_000, max_output_tokens: 4_096 },
		]);
		for (const rejected of [fractional, negative, text, huge]) {
			expect(Number.isSafeInteger(rejected.contextWindow)).toBe(true);
			expect(rejected.contextWindow).not.toBe(300_000);
			expect([1000.5, -5, 1e300]).not.toContain(rejected.contextWindow);
			expect(Number.isSafeInteger(rejected.maxTokens)).toBe(true);
		}
		expect(good.contextWindow).toBe(300_000);
		expect(good.maxTokens).toBe(4_096);
	});

	test("reads at most 2,000 rows", async () => {
		const data = Array.from({ length: 2_001 }, (_, index) => ({ id: `${PROVIDER}/bulk-${index}` }));
		const models = await discover(data);
		expect(models).toHaveLength(2_000);
		expect(models.some(model => model.id === "bulk-2000")).toBe(false);
	});
});
