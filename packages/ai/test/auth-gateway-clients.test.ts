import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import {
	type AuthGatewayClient,
	type AuthGatewayServerHandle,
	hashAuthGatewayToken,
	parseAuthGatewayClients,
	startAuthGateway,
} from "@oh-my-pi/pi-ai/auth-gateway";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import { ProviderHttpError } from "@oh-my-pi/pi-ai/error";
import { createMockModel, type MockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import * as oauthUtils from "@oh-my-pi/pi-ai/registry/oauth";
import type { Api, Model } from "@oh-my-pi/pi-ai/types";

const GATEWAY_TOKEN = "gateway-token";
const CI_TOKEN = "ci-token";
const CI_CLIENT: AuthGatewayClient = {
	name: "ci",
	tokenSha256: hashAuthGatewayToken(CI_TOKEN),
	models: ["mock/granted"],
	accounts: { mock: ["account:acc-b"] },
};

function oauthAccount(suffix: string) {
	return {
		type: "oauth" as const,
		access: `access-${suffix}`,
		refresh: `refresh-${suffix}`,
		expires: Date.now() + 60 * 60_000,
		accountId: `acc-${suffix}`,
		email: `${suffix}@example.com`,
	};
}

describe("auth-gateway scoped clients", () => {
	let dir = "";
	let storage: AuthStorage;
	let gateway: AuthGatewayServerHandle | undefined;

	beforeEach(async () => {
		registerMockApi();
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-clients-"));
		storage = new AuthStorage(await SqliteAuthCredentialStore.open(path.join(dir, "auth.db")));
		await storage.credentials.set("mock", [
			oauthAccount("a"),
			oauthAccount("b"),
			{ type: "api_key", key: "stored-key" },
		]);
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (provider, credentials) => {
			const credential = credentials[provider];
			return credential ? { newCredentials: credential, apiKey: credential.access } : null;
		});
	});

	afterEach(async () => {
		await gateway?.close();
		gateway = undefined;
		vi.restoreAllMocks();
		clearCustomApis();
		storage.close();
		await fs.rm(dir, { recursive: true, force: true });
	});

	/** Serve `models` the way `serve` indexes its catalog: qualified ids, then each bare id's first model. */
	function boot(
		models: MockModel[],
		clients: readonly AuthGatewayClient[] | undefined,
		bearerTokens = [GATEWAY_TOKEN],
	): AuthGatewayServerHandle {
		const byId = new Map<string, Model<Api>>();
		for (const model of models) {
			byId.set(`${model.provider}/${model.id}`, model);
			if (!byId.has(model.id)) byId.set(model.id, model);
		}
		gateway = startAuthGateway({
			bind: "127.0.0.1:0",
			bearerTokens,
			storage,
			resolveModel: id => byId.get(id),
			listModels: () => byId.values(),
			clients,
			version: "test",
		});
		return gateway;
	}

	function chat(token: string, model: string, promptCacheKey?: string, stream = false): Promise<Response> {
		if (!gateway) throw new Error("gateway not started");
		return fetch(`${gateway.url}/v1/chat/completions`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
			body: JSON.stringify({
				model,
				messages: [{ role: "user", content: "hi" }],
				stream,
				prompt_cache_key: promptCacheKey,
			}),
		});
	}

	async function answer(response: Response): Promise<string | null | undefined> {
		const body = (await response.json()) as { choices?: Array<{ message?: { content?: string | null } }> };
		return body.choices?.[0]?.message?.content;
	}

	function get(token: string, route: string): Promise<Response> {
		if (!gateway) throw new Error("gateway not started");
		return fetch(`${gateway.url}${route}`, { headers: { Authorization: `Bearer ${token}` } });
	}

	it("serves a client only from its bound account, never a sibling account or API key", async () => {
		let accountBExhausted = false;
		const granted = createMockModel({
			provider: "mock",
			id: "granted",
			handler: (_context, options) => {
				if (accountBExhausted && options?.apiKey === "access-b") {
					throw new ProviderHttpError("Usage limit reached", 429, { code: "insufficient_quota" });
				}
				return { content: [`served:${options?.apiKey}`] };
			},
		});
		boot([granted], [CI_CLIENT]);

		const served = await chat(CI_TOKEN, "mock/granted", "conversation-1");
		expect(served.status).toBe(200);
		expect(await answer(served)).toBe("served:access-b");

		accountBExhausted = true;
		granted.reset();
		const exhausted = await chat(CI_TOKEN, "mock/granted", "conversation-2");
		expect(exhausted.status).toBe(429);
		expect(granted.calls.map(call => call.options?.apiKey)).toEqual(["access-b"]);

		// The gateway token keeps today's behavior: recovery moves to another credential.
		const unscoped = await chat(GATEWAY_TOKEN, "mock/granted", "conversation-3");
		expect(unscoped.status).toBe(200);
		expect(await answer(unscoped)).not.toBe("served:access-b");
	});

	it("refuses models outside a client's grants before any credential lookup", async () => {
		// Listed first, so a bare `shared` resolves here for unscoped callers.
		const decoy = createMockModel({ provider: "alpha", id: "shared" });
		const granted = createMockModel({ provider: "mock", id: "granted", handler: { content: ["ok"] } });
		const shared = createMockModel({
			provider: "mock",
			id: "shared",
			handler: (_context, options) => ({ content: [`shared:${options?.apiKey}`] }),
		});
		const other = createMockModel({ provider: "mock", id: "other", handler: { content: ["refused"] } });
		// An aggregator-style id that spells another provider's qualified id.
		const lookalike = createMockModel({ provider: "mock", id: "alpha/shared", handler: { content: ["lookalike"] } });
		boot(
			[decoy, granted, shared, other, lookalike],
			[{ ...CI_CLIENT, models: ["mock/granted", "mock/shared", "mock/alpha/shared"] }],
		);
		const lookups = vi.spyOn(storage.keys, "getWithCredential");

		const refused = await chat(CI_TOKEN, "mock/other");
		expect(refused.status).toBe(404);
		expect(other.calls).toHaveLength(0);
		expect(lookups).not.toHaveBeenCalled();
		// A refused provider-qualified id is never reread as another provider's bare id.
		expect((await chat(CI_TOKEN, "alpha/shared")).status).toBe(404);
		expect(lookalike.calls).toHaveLength(0);

		const bare = await chat(CI_TOKEN, "shared");
		expect(bare.status).toBe(200);
		expect(await answer(bare)).toBe("shared:access-b");
		expect(decoy.calls).toHaveLength(0);

		const listed = (await (await get(CI_TOKEN, "/v1/models")).json()) as { data: Array<{ id: string }> };
		expect(listed.data.map(row => row.id)).toEqual(["mock/granted", "mock/shared", "mock/alpha/shared"]);
		expect((await get(CI_TOKEN, "/v1/usage")).status).toBe(403);
		expect((await get(CI_TOKEN, "/v1/credentials/check")).status).toBe(403);
	});

	it("refuses every provider its accounts omit, even without a models list", async () => {
		const unbound = createMockModel({ provider: "alpha", id: "free", handler: { content: ["unbound"] } });
		const bound = createMockModel({
			provider: "mock",
			id: "granted",
			handler: (_context, options) => ({ content: [`served:${options?.apiKey}`] }),
		});
		await storage.credentials.set("alpha", [{ type: "api_key", key: "alpha-key" }]);
		boot([unbound, bound], [{ name: "ci", tokenSha256: CI_CLIENT.tokenSha256, accounts: CI_CLIENT.accounts }]);

		expect((await chat(CI_TOKEN, "alpha/free")).status).toBe(404);
		expect(unbound.calls).toHaveLength(0);
		expect(await answer(await chat(CI_TOKEN, "mock/granted"))).toBe("served:access-b");
		const listed = (await (await get(CI_TOKEN, "/v1/models")).json()) as { data: Array<{ id: string }> };
		expect(listed.data.map(row => row.id)).toEqual(["mock/granted"]);
		// The gateway token still reaches the unbound provider.
		expect(await answer(await chat(GATEWAY_TOKEN, "alpha/free"))).toBe("unbound");
	});

	it("keeps bearer auth on for an empty table and refuses a removed client's token", async () => {
		const granted = createMockModel({ provider: "mock", id: "granted", handler: { content: ["ok"] } });
		const handle = boot([granted], [], []);
		expect((await fetch(`${handle.url}/v1/models`)).status).toBe(401);

		handle.setClients([CI_CLIENT]);
		expect((await chat(CI_TOKEN, "mock/granted")).status).toBe(200);
		// A client's token anywhere but Authorization is refused, like the gateway token.
		expect((await get(CI_TOKEN, `/v1/models?key=${CI_TOKEN}`)).status).toBe(400);

		handle.setClients([]);
		expect((await chat(CI_TOKEN, "mock/granted")).status).toBe(401);
		expect(() =>
			handle.setClients([
				{ name: "impostor", tokenSha256: hashAuthGatewayToken(CI_TOKEN).toUpperCase() },
				CI_CLIENT,
			]),
		).toThrow("same tokenSha256");
	});

	it("refuses a client that claims the gateway token", () => {
		expect(() =>
			boot([], [{ name: "impostor", tokenSha256: hashAuthGatewayToken(GATEWAY_TOKEN) }], [GATEWAY_TOKEN]),
		).toThrow("gateway token's digest");
	});

	it.each([false, true])(
		"keeps a request admitted before a token rotation on its own account for a late retry (stream: %p)",
		async stream => {
			const entered = Promise.withResolvers<void>();
			const proceed = Promise.withResolvers<void>();
			const granted = createMockModel({
				provider: "mock",
				id: "granted",
				handler: async (_context, options) => {
					if (options?.apiKey === "access-a") {
						entered.resolve();
						await proceed.promise;
						throw new ProviderHttpError("Usage limit reached", 429, { code: "insufficient_quota" });
					}
					return { content: [`served:${options?.apiKey}`] };
				},
			});
			const handle = boot([granted], [{ ...CI_CLIENT, accounts: { mock: ["account:acc-a"] } }]);

			const inFlight = chat(CI_TOKEN, "mock/granted", undefined, stream);
			await entered.promise;
			// The name moves to a new token bound to account b while the old token's request waits to retry.
			handle.setClients([{ ...CI_CLIENT, tokenSha256: hashAuthGatewayToken("ci-token-2") }]);
			proceed.resolve();

			const old = await inFlight;
			if (stream) expect(await old.text()).toContain("Usage limit reached");
			else expect(old.status).toBe(429);
			expect(granted.calls.map(call => call.options?.apiKey)).toEqual(["access-a"]);
			expect((await chat(CI_TOKEN, "mock/granted")).status).toBe(401);
			expect(await answer(await chat("ci-token-2", "mock/granted"))).toBe("served:access-b");
		},
	);

	it("lifts a retired client's restriction after its last request, and every restriction on close", async () => {
		const restrict = vi.spyOn(storage.sessions, "restrict");
		const entered = Promise.withResolvers<void>();
		const proceed = Promise.withResolvers<void>();
		const granted = createMockModel({
			provider: "mock",
			id: "granted",
			handler: async () => {
				entered.resolve();
				await proceed.promise;
				return { content: ["ok"] };
			},
		});
		const handle = boot([granted], [CI_CLIENT]);
		const accountA = storage.credentials
			.list("mock")
			.find(row => row.credential.type === "oauth" && row.credential.accountId === "acc-a");
		if (!accountA) throw new Error("account a is not stored");
		// CI_CLIENT is bound to account b, so account a is refused while its restriction holds.
		const restricted = (call: number): boolean =>
			!storage.sessions.permits("mock", restrict.mock.calls[call]?.[1] ?? "", accountA.id);
		expect(restricted(0)).toBe(true);

		const inFlight = chat(CI_TOKEN, "mock/granted");
		await entered.promise;
		handle.setClients([]);
		expect(restricted(0)).toBe(true);
		proceed.resolve();
		expect((await inFlight).status).toBe(200);
		expect(restricted(0)).toBe(false);

		handle.setClients([CI_CLIENT]);
		expect(restricted(1)).toBe(true);
		await handle.close();
		gateway = undefined;
		expect(restricted(1)).toBe(false);
	});

	it("never shares retained provider state between clients", async () => {
		const states: unknown[] = [];
		const granted = createMockModel({
			provider: "mock",
			id: "granted",
			handler: (_context, options) => {
				states.push(options?.providerSessionState);
				return { content: ["ok"] };
			},
		});
		boot([granted], [CI_CLIENT, { name: "ops", tokenSha256: hashAuthGatewayToken("ops-token") }]);

		for (const token of [CI_TOKEN, "ops-token", GATEWAY_TOKEN, CI_TOKEN]) {
			expect((await chat(token, "mock/granted", "same-key")).status).toBe(200);
		}
		expect(new Set(states).size).toBe(3);
		expect(states[3]).toBe(states[0]);
	});
});

describe("parseAuthGatewayClients", () => {
	const digest = hashAuthGatewayToken(CI_TOKEN);

	it.each([
		["text that is not JSON", "{", "not valid JSON"],
		["a misspelled field", { ci: { tokenSha256: digest, model: ["mock/granted"] } }, 'unknown field "model"'],
		["a truncated digest", { ci: { tokenSha256: digest.slice(1) } }, "64 hex digits"],
		["a glob inside a model id", { ci: { tokenSha256: digest, models: ["mock/gran*"] } }, '"provider/*"'],
		["whitespace inside a grant", { ci: { tokenSha256: digest, models: ["mock /granted"] } }, '"provider/*"'],
		[
			"an account provider id with surrounding whitespace, which would leave mock unbound",
			{ ci: { tokenSha256: digest, accounts: { "mock ": ["account:acc-b"] } } },
			"provider id",
		],
		[
			"identity keys that are not a list",
			{ ci: { tokenSha256: digest, accounts: { mock: "account:acc-b" } } },
			"list",
		],
		[
			"a model grant for a provider its accounts do not bind",
			{ ci: { tokenSha256: digest, models: ["mock/granted", "alpha/*"], accounts: { mock: ["account:acc-b"] } } },
			'grants provider "alpha"',
		],
		[
			"two clients with one token",
			{ ci: { tokenSha256: digest }, ops: { tokenSha256: digest.toUpperCase() } },
			"same",
		],
	])("rejects a whole file with %s", (_label, file, message) => {
		expect(() => parseAuthGatewayClients(typeof file === "string" ? file : JSON.stringify(file))).toThrow(message);
	});
});
