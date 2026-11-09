import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { FetchImpl } from "@oh-my-pi/pi-ai";
import { getBundledModel, getBundledModels } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";

const GATEWAY = "https://gateway.test";
const PROVIDER = "openai-codex";

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

describe("ModelRegistry pi-native gateway discovery", () => {
	let tempDir: string;
	let modelsPath: string;
	let cacheDbPath: string;
	let authStorage: AuthStorage;
	let requests: Array<{ url: string; headers: Headers }>;

	// A bundled chat id, and one the gateway will not serve.
	const bundledChatIds = getBundledModels(PROVIDER)
		.filter(model => (model.kind ?? "chat") === "chat")
		.map(model => model.id);
	const servedBundledId = bundledChatIds[0];
	const unservedBundledId = bundledChatIds[1];

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

	function gatewayFetch(rows: GatewayRow[]): FetchImpl {
		return async (input, init) => {
			const url = input instanceof Request ? input.url : String(input);
			requests.push({ url, headers: new Headers(init?.headers) });
			if (url === `${GATEWAY}/v1/models`) return Response.json({ object: "list", data: rows });
			throw new Error(`Unexpected URL: ${url}`);
		};
	}

	function createRegistry(fetch: FetchImpl) {
		return new ModelRegistry(authStorage, modelsPath, { cacheDbPath, fetch });
	}

	function ids(registry: ModelRegistry) {
		return registry
			.getAll("all")
			.filter(model => model.provider === PROVIDER)
			.map(model => model.id)
			.sort();
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

	test("roster is the gateway's own-provider rows with the prefix stripped", async () => {
		writeProviders(piNativeProvider());
		const registry = createRegistry(gatewayFetch(rows));
		await registry.refresh("online");

		expect(ids(registry)).toEqual([servedBundledId, "gpt-gateway-only", "gpt-image-gateway"].sort());
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

	test("authenticates like the stream: bearer, provider headers and attribution headers", async () => {
		writeProviders(piNativeProvider());
		const registry = createRegistry(gatewayFetch(rows));
		await registry.refresh("online");

		const request = requests.find(entry => entry.url === `${GATEWAY}/v1/models`);
		expect(request?.headers.get("authorization")).toBe("Bearer gateway-token");
		expect(request?.headers.get("cf-access-client-id")).toBe("client-id");
		expect(request?.headers.get("x-omp-install-id")).toBeTruthy();
		expect(request?.headers.get("x-omp-app")).toBeTruthy();
	});

	test("a provider Authorization header replaces the bearer, as on the stream", async () => {
		writeProviders(piNativeProvider({ headers: { Authorization: "Bearer from-headers" } }));
		const registry = createRegistry(gatewayFetch(rows));
		await registry.refresh("online");

		const request = requests.find(entry => entry.url === `${GATEWAY}/v1/models`);
		expect(request?.headers.get("authorization")).toBe("Bearer from-headers");
	});

	test("a bundled id the gateway does not list is absent", async () => {
		expect(unservedBundledId).toBeDefined();
		writeProviders(piNativeProvider());
		const registry = createRegistry(gatewayFetch(rows));
		// Before the refresh nothing is cached, so the bundled roster still shows.
		expect(registry.find(PROVIDER, unservedBundledId)).toBeDefined();

		await registry.refresh("online");

		expect(registry.find(PROVIDER, unservedBundledId)).toBeUndefined();
		expect(registry.find(PROVIDER, "gpt-gateway-only")).toBeDefined();
	});

	test("maps the row's kind to the model kind and keeps bundled metadata for listed ids", async () => {
		writeProviders(piNativeProvider());
		const registry = createRegistry(gatewayFetch(rows));
		await registry.refresh("online");

		const image = registry.find(PROVIDER, "gpt-image-gateway");
		expect(image?.kind).toBe("image");
		expect(registry.find(PROVIDER, "gpt-gateway-only")?.kind ?? "chat").toBe("chat");

		// The row carries no thinking metadata: a bundled id keeps its own.
		const bundled = getBundledModel(PROVIDER, servedBundledId);
		const served = registry.find(PROVIDER, servedBundledId);
		expect(served?.reasoning).toBe(bundled.reasoning);
		expect(served?.thinking?.efforts).toEqual(bundled.thinking?.efforts);
	});

	test("the roster is the whole catalog: bundled rows of every kind the gateway omits are retired", async () => {
		const bundledImageIds = getBundledModels(PROVIDER)
			.filter(model => model.kind === "image")
			.map(model => model.id);
		expect(bundledImageIds.length).toBeGreaterThan(0);
		writeProviders(piNativeProvider());
		const registry = createRegistry(gatewayFetch([{ id: `${PROVIDER}/only-model`, api: "openai-codex-responses" }]));
		await registry.refresh("online");

		expect(ids(registry)).toEqual(["only-model"]);
	});

	test("explicit models.yml models still merge on top", async () => {
		writeProviders(
			piNativeProvider({
				models: [{ id: "my-local-extra", name: "Extra", api: "openai-codex-responses" }],
			}),
		);
		const registry = createRegistry(gatewayFetch(rows));
		await registry.refresh("online");

		expect(registry.find(PROVIDER, "my-local-extra")).toBeDefined();
		expect(registry.find(PROVIDER, "gpt-gateway-only")).toBeDefined();
		expect(registry.find(PROVIDER, unservedBundledId)).toBeUndefined();
	});

	test("an unreachable gateway keeps the last snapshot, in the same and in a later process", async () => {
		writeProviders(piNativeProvider());
		await createRegistry(gatewayFetch(rows)).refresh("online");
		const expected = [servedBundledId, "gpt-gateway-only", "gpt-image-gateway"].sort();

		const failing: FetchImpl = async () => {
			throw new Error("gateway unreachable");
		};
		const later = createRegistry(failing);
		// Startup serves the cached gateway roster before any refresh.
		expect(ids(later)).toEqual(expected);
		await later.refresh("online");
		expect(ids(later)).toEqual(expected);
		expect(later.getProviderDiscoveryState(PROVIDER)?.status).toBe("cached");
	});

	test("an unreachable gateway with no snapshot keeps the bundled roster", async () => {
		writeProviders(piNativeProvider());
		const registry = createRegistry(async () => {
			throw new Error("gateway unreachable");
		});
		await registry.refresh("online");

		expect(registry.find(PROVIDER, unservedBundledId)).toBeDefined();
		expect(registry.getProviderDiscoveryState(PROVIDER)?.status).toBe("unavailable");
	});

	test("a reply that is not a model list keeps the last snapshot instead of emptying the roster", async () => {
		writeProviders(piNativeProvider());
		await createRegistry(gatewayFetch(rows)).refresh("online");

		const html: FetchImpl = async () => new Response("<html>login</html>", { status: 200 });
		const registry = createRegistry(html);
		await registry.refresh("online");

		expect(ids(registry)).toEqual([servedBundledId, "gpt-gateway-only", "gpt-image-gateway"].sort());
	});

	test("a gateway that lists none of the provider's models keeps the bundled roster", async () => {
		writeProviders(piNativeProvider());
		const registry = createRegistry(
			gatewayFetch([{ id: "anthropic/claude-other-provider", api: "anthropic-messages" }]),
		);
		await registry.refresh("online");

		expect(registry.find(PROVIDER, unservedBundledId)).toBeDefined();
	});

	test("a provider without transport pi-native is unchanged", async () => {
		writeProviders({ [PROVIDER]: { baseUrl: GATEWAY, apiKey: "gateway-token" } });
		const registry = createRegistry(gatewayFetch(rows));
		await registry.refresh("online");

		expect(requests.some(entry => entry.url === `${GATEWAY}/v1/models`)).toBe(false);
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

	test("discovery state follows the gateway's own base URL, not a snapshot from another one", async () => {
		writeProviders(piNativeProvider());
		await createRegistry(gatewayFetch(rows)).refresh("online");

		writeProviders(piNativeProvider({ baseUrl: "https://other-gateway.test" }));
		const other = createRegistry(async () => {
			throw new Error("gateway unreachable");
		});

		// No snapshot for the other gateway: the first gateway's roster must not answer for it.
		expect(other.find(PROVIDER, "gpt-gateway-only")).toBeUndefined();
	});
});
