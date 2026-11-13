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
import { THINKING_BINDING_CONTROLS_BETA } from "@oh-my-pi/pi-ai/providers/anthropic-wire";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import * as oauthUtils from "@oh-my-pi/pi-ai/registry/oauth";
import type { Api, Model, SimpleStreamOptions } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { anthropicChunks, completionsChunks } from "./helpers/factory-droid";

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

	/**
	 * Serve `models` the way `serve` resolves its catalog: a `provider/id` names one model,
	 * a bare id the first listed model of that id the caller accepts.
	 */
	function boot(
		models: Model<Api>[],
		clients: readonly AuthGatewayClient[] | undefined,
		bearerTokens = [GATEWAY_TOKEN],
	): AuthGatewayServerHandle {
		const byKey = new Map<string, Model<Api>>(models.map(model => [`${model.provider}/${model.id}`, model]));
		gateway = startAuthGateway({
			bind: "127.0.0.1:0",
			bearerTokens,
			storage,
			resolveModel: (id, options) => {
				const accepts = options?.accepts ?? (() => true);
				const qualified = byKey.get(id);
				if (qualified) return accepts(qualified) ? qualified : undefined;
				return models.find(model => model.id === id && accepts(model));
			},
			listModels: () => byKey.values(),
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

	it.each(["/v1/pi/stream", "/v1/chat/completions", "/v1/messages", "/v1/responses"])(
		"drops scoped caller headers on %s without dropping the bound credential or unscoped headers",
		async route => {
			const received: Headers[] = [];
			const upstream = Bun.serve({
				hostname: "127.0.0.1",
				port: 0,
				fetch: async req => {
					await req.arrayBuffer();
					received.push(new Headers(req.headers));
					const chunks = [...completionsChunks("ok", "granted"), "[DONE]"];
					return new Response(chunks.map(chunk => `data: ${chunk}\n\n`).join(""), {
						headers: { "Content-Type": "text/event-stream" },
					});
				},
			});
			try {
				const model = buildModel({
					id: "granted",
					name: "granted",
					provider: "mock",
					api: "openai-completions",
					baseUrl: `http://127.0.0.1:${upstream.port}/v1`,
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 8192,
					maxTokens: 128,
				});
				const handle = boot([model], [CI_CLIENT]);
				const callerHeaders = {
					Host: "caller.invalid",
					Authorization: "Bearer caller-key",
					"OpenAI-Organization": "caller-org",
					"x-proof-neutral": "caller-marker",
				};
				for (const stream of [false, true]) {
					for (const token of [CI_TOKEN, GATEWAY_TOKEN]) {
						const response = await fetch(`${handle.url}${route}`, {
							method: "POST",
							headers: {
								Authorization: `Bearer ${token}`,
								"Content-Type": "application/json",
								"OpenAI-Project": "outer-project",
								"chatgpt-account-id": "outer-account",
								"x-stainless-proof": "outer-marker",
								"anthropic-beta": THINKING_BINDING_CONTROLS_BETA,
							},
							body: JSON.stringify(
								route === "/v1/pi/stream"
									? {
											modelId: "mock/granted",
											context: { messages: [{ role: "user", content: "hi", timestamp: 1 }] },
											options: { headers: callerHeaders },
											stream,
										}
									: {
											model: "mock/granted",
											messages: [{ role: "user", content: "hi" }],
											input: "hi",
											max_tokens: 128,
											stream,
										},
							),
						});
						expect(response.status).toBe(200);
						expect(await response.text()).toContain("ok");
						expect(received).toHaveLength(1);
						const headers = received.pop()!;
						if (token === CI_TOKEN) {
							expect({
								authorization: headers.get("authorization"),
								host: headers.get("host"),
								organization: headers.get("openai-organization"),
								neutral: headers.get("x-proof-neutral"),
								outerProject: headers.get("openai-project"),
								outerAccount: headers.get("chatgpt-account-id"),
								outerNeutral: headers.get("x-stainless-proof"),
							}).toEqual({
								authorization: "Bearer access-b",
								host: `127.0.0.1:${upstream.port}`,
								organization: null,
								neutral: null,
								outerProject: null,
								outerAccount: null,
								outerNeutral: null,
							});
						} else if (route === "/v1/pi/stream") {
							expect(headers.get("openai-organization")).toBe("caller-org");
							expect(headers.get("x-proof-neutral")).toBe("caller-marker");
						}
						for (const [name, value] of [
							["openai-project", "outer-project"],
							["chatgpt-account-id", "outer-account"],
							["x-stainless-proof", "outer-marker"],
							["anthropic-beta", THINKING_BINDING_CONTROLS_BETA],
						]) {
							expect(headers.get(name)).toBe(token === CI_TOKEN ? null : value);
						}
					}
				}
			} finally {
				upstream.stop(true);
			}
		},
	);

	it("drops a scoped caller's anthropic-user-profile-id on /v1/messages but encodes its stream like the gateway token's", async () => {
		const received: Headers[] = [];
		const upstream = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: async req => {
				await req.arrayBuffer();
				received.push(new Headers(req.headers));
				const frames = anthropicChunks("ok").map(chunk => {
					const { type } = JSON.parse(chunk) as { type: string };
					return `event: ${type}\ndata: ${chunk}\n\n`;
				});
				return new Response(frames.join(""), { headers: { "Content-Type": "text/event-stream" } });
			},
		});
		try {
			const model = buildModel({
				id: "granted",
				name: "granted",
				provider: "mock",
				api: "anthropic-messages",
				baseUrl: `http://127.0.0.1:${upstream.port}`,
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 8192,
				maxTokens: 128,
			});
			const handle = boot([model], [CI_CLIENT]);
			const seen: Array<{ profile: string | null; frames: unknown[] }> = [];
			for (const token of [CI_TOKEN, GATEWAY_TOKEN]) {
				const response = await fetch(`${handle.url}/v1/messages`, {
					method: "POST",
					headers: {
						Authorization: `Bearer ${token}`,
						"Content-Type": "application/json",
						"anthropic-user-profile-id": "caller-profile",
						"anthropic-beta": THINKING_BINDING_CONTROLS_BETA,
					},
					body: JSON.stringify({
						model: "mock/granted",
						max_tokens: 128,
						stream: true,
						messages: [{ role: "user", content: "hi" }],
					}),
				});
				expect(response.status).toBe(200);
				const frames = (await response.text())
					.split("\n")
					.filter(line => line.startsWith("data: "))
					.map(line => JSON.parse(line.slice("data: ".length)) as { type: string; message?: { id?: string } })
					.filter(frame => frame.type !== "ping");
				// Each response mints its own message id.
				for (const frame of frames) if (frame.message) frame.message.id = "msg";
				expect(received).toHaveLength(1);
				seen.push({ profile: received.pop()!.get("anthropic-user-profile-id"), frames });
			}
			const [scoped, unscoped] = seen;
			expect([scoped.profile, unscoped.profile]).toEqual([null, "caller-profile"]);
			// The caller's binding-controls beta still shapes its response.
			expect(scoped.frames[0]).toMatchObject({ type: "message_start", message: { input_transformations: [] } });
			expect(scoped.frames).toEqual(unscoped.frames);
		} finally {
			upstream.stop(true);
		}
	});

	it("keeps a scoped caller's model options on /v1/pi/stream and drops its attribution and billing options", async () => {
		const granted = createMockModel({ provider: "mock", id: "granted", handler: { content: ["ok"] } });
		const handle = boot([granted], [CI_CLIENT]);
		const callerOptions = {
			userProfileId: "caller-profile",
			initiatorOverride: "agent",
			serviceTier: "priority",
			temperature: 0.5,
		} satisfies SimpleStreamOptions;
		for (const token of [CI_TOKEN, GATEWAY_TOKEN]) {
			const response = await fetch(`${handle.url}/v1/pi/stream`, {
				method: "POST",
				headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
				body: JSON.stringify({
					modelId: "mock/granted",
					context: { messages: [{ role: "user", content: "hi", timestamp: 1 }] },
					options: callerOptions,
					stream: false,
				}),
			});
			expect(response.status).toBe(200);
		}
		const received = granted.calls.map(({ options }) => ({
			userProfileId: options?.userProfileId,
			initiatorOverride: options?.initiatorOverride,
			serviceTier: options?.serviceTier,
			temperature: options?.temperature,
		}));
		expect(received).toEqual([
			{ userProfileId: undefined, initiatorOverride: undefined, serviceTier: undefined, temperature: 0.5 },
			callerOptions,
		]);
	});

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
