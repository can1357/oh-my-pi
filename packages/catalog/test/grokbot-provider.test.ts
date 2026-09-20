import { Database } from "bun:sqlite";
import { describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { providerEntry, seedModels } from "@oh-my-pi/pi-catalog/compat/providers";
import { fetchGrokbotAvailableModels, normalizeGrokbotAvailableModels } from "@oh-my-pi/pi-catalog/discovery/grokbot";
import {
	clearGrokbotTokenCache,
	loadGrokbotConfig,
	mintGrokbotAccessToken,
} from "@oh-my-pi/pi-catalog/discovery/grokbot-auth";
import { MAX_GROKBOT_CATALOG_JSON_BODY_BYTES } from "@oh-my-pi/pi-catalog/discovery/grokbot-body";
import { Effort, THINKING_EFFORTS } from "@oh-my-pi/pi-catalog/effort";
import { resolveProviderModels } from "@oh-my-pi/pi-catalog/model-manager";
import { PROVIDER_DESCRIPTORS } from "@oh-my-pi/pi-catalog/provider-models/descriptors";
import { grokbotModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/special";
type TestHeaders = NonNullable<RequestInit["headers"]>;

const GROKBOT_SEED_IDS = ["sand-cua", "default", "grok-4.6"];

describe("Grok Bot catalog seed", () => {
	test("defaults offline selection to the first-party routed Auto model", () => {
		const seed = seedModels<"grokbot-sand">("grokbot");
		expect(seed.map(model => model.id)).toEqual(GROKBOT_SEED_IDS);
		expect(providerEntry("grokbot")?.defaultModel).toBe("default");

		const auto = seed.find(model => model.id === "default");
		expect(auto).toMatchObject({
			name: "Auto",
			reasoning: true,
			supportsTools: false,
			sandParameterIds: [],
			sandMaxMode: false,
		});
		expect(auto?.thinking).toBeUndefined();

		const cua = seed.find(model => model.id === "sand-cua");
		expect(cua?.reasoning).toBe(true);
		expect(cua?.supportsTools).toBe(false);
		expect(cua?.sandParameterIds).toEqual([]);
		expect(cua?.thinking).toBeUndefined();

		const grok = seed.find(model => model.id === "grok-4.6");
		if (!grok) throw new Error("missing Grok 4.6 fallback");
		expect(grok).toMatchObject({
			name: "Grok 4.6 (sand)",
			reasoning: true,
			supportsTools: true,
			sandParameterIds: ["effort", "fast"],
			sandMaxMode: false,
			thinking: { mode: "effort", efforts: ["low", "medium", "high", "xhigh"] },
		});
	});

	test("remaps all static fallbacks to a configured sand host", () => {
		const seed = seedModels<"grokbot-sand">("grokbot");
		expect(grokbotModelManagerOptions().staticModels).toBe(seed);
		const remapped = grokbotModelManagerOptions({ baseUrl: "https://sand.internal" }).staticModels;
		expect(remapped?.map(model => model.baseUrl)).toEqual(GROKBOT_SEED_IDS.map(() => "https://sand.internal"));
	});
});

describe("Grok Bot live catalog", () => {
	test("overlays current routed model specs from the KDL seed", () => {
		const endpoint = "https://sand.example/tenant";
		const liveModels = normalizeGrokbotAvailableModels(
			[
				{
					name: "default",
					clientDisplayName: "under-described server metadata",
					supportsThinking: false,
					supportsImages: false,
				},
			],
			endpoint,
		);
		const seed = seedModels<"grokbot-sand">("grokbot");

		for (const routerId of ["default", "sand-cua"]) {
			const seedRouter = seed.find(model => model.id === routerId);
			const liveRouter = liveModels.find(model => model.id === routerId);
			if (!seedRouter || !liveRouter) throw new Error(`Missing router ${routerId}`);
			expect(liveRouter).toEqual({ ...seedRouter, baseUrl: endpoint });
		}
	});

	test("orders live thinking efforts in the canonical ladder", () => {
		const model = normalizeGrokbotAvailableModels([
			{
				name: "grok-full-effort",
				parameterDefinitions: [
					{
						id: "effort",
						values: [
							{ value: "high" },
							{ value: "minimal" },
							{ value: "max" },
							{ value: "low" },
							{ value: "xhigh" },
						],
					},
				],
				variants: [{ parameterValues: [{ id: "effort", value: "medium" }] }],
			},
		]).find(candidate => candidate.id === "grok-full-effort");
		if (!model?.thinking || model.thinking.mode !== "effort") throw new Error("Missing live effort ladder");

		expect(model.thinking.efforts).toEqual(THINKING_EFFORTS);
	});

	test("maps nested live effort definitions onto canonical levels and exact wire values", () => {
		const model = normalizeGrokbotAvailableModels([
			{
				name: "nested-live-efforts",
				parameterDefinitions: [
					{
						id: "reasoning_effort",
						parameterType: {
							enumParameter: {
								values: [{ value: "low" }, { value: "extra-high" }],
							},
						},
					},
				],
			},
		]).find(candidate => candidate.id === "nested-live-efforts");
		if (!model) throw new Error("Missing nested live effort model");

		expect(model.thinking).toEqual({ mode: "effort", efforts: [Effort.Low, Effort.XHigh] });
		expect(model.sandEffortValues).toEqual({ low: "low", xhigh: "extra-high" });
		expect(buildModel(model).thinking).toEqual({ mode: "effort", efforts: [Effort.Low, Effort.XHigh] });
	});

	test("keeps routed Auto on in-band tools while enabling verified Grok 4.6 identities", () => {
		const models = normalizeGrokbotAvailableModels([
			{ name: "unverified-live-model" },
			{ name: "grok-4.6-server-alias", idAliases: ["GROK-4.6"] },
		]);

		expect(models.find(model => model.id === "unverified-live-model")?.supportsTools).toBe(false);
		expect(models.find(model => model.id === "grok-4.6-server-alias")?.supportsTools).toBe(true);
		expect(models.find(model => model.id === "default")?.supportsTools).toBe(false);
	});

	test("loads live models through its lazy discovery binding", async () => {
		const requests: string[] = [];
		let availableModelsRequest: unknown;
		const options = grokbotModelManagerOptions({
			apiKey: JSON.stringify({ renewal: "synthetic-catalog-renewal", machineId: "synthetic-catalog-machine" }),
			baseUrl: "https://sand.example/tenant",
			fetch: async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
				requests.push(input.toString());
				if (input.toString().endsWith("/sand-box/inference-credential")) {
					return Response.json({
						accessToken: "synthetic-access-token",
						grokBotToken: "grok-bot-token",
						expiresAtMs: Date.now() + 10 * 60_000,
					});
				}
				availableModelsRequest = JSON.parse(String(init?.body));
				return Response.json({ models: [] });
			},
		});
		clearGrokbotTokenCache();
		try {
			const models = await options.fetchDynamicModels?.();

			expect(models?.map(model => model.id)).toEqual(["default", "sand-cua"]);
			expect(requests).toEqual([
				"https://sand.example/tenant/sand-box/inference-credential",
				"https://sand.example/tenant/aiserver.v1.AiService/AvailableModels",
			]);
			expect(availableModelsRequest).toEqual({
				useModelParameters: true,
				doNotUseMarkdown: true,
				scope: "AVAILABLE_MODELS_SCOPE_USER_AVAILABLE",
			});
		} finally {
			clearGrokbotTokenCache();
		}
	});

	test("forwards custom headers and scopes its cache by canonicalized non-secret header identities", async () => {
		const seenHeaders: string[] = [];
		const options = grokbotModelManagerOptions({
			apiKey: JSON.stringify({ renewal: "header-renewal", machineId: "header-machine" }),
			headers: { "X-Grok-Tenant": "tenant-a" },
			fetch: async (input, init) => {
				seenHeaders.push(new Headers(init?.headers).get("x-grok-tenant") ?? "");
				if (String(input).endsWith("/sand-box/inference-credential")) {
					return Response.json({
						accessToken: "synthetic-header-access-token",
						grokBotToken: "header-grok-bot-token",
						expiresAtMs: Date.now() + 10 * 60_000,
					});
				}
				return Response.json({ models: [] });
			},
		});
		const sameHeaders = grokbotModelManagerOptions({
			apiKey: JSON.stringify({ renewal: "header-renewal", machineId: "header-machine" }),
			headers: { "x-grok-tenant": "tenant-a" },
		});
		const differentHeaders = grokbotModelManagerOptions({
			apiKey: JSON.stringify({ renewal: "header-renewal", machineId: "header-machine" }),
			headers: { "x-grok-tenant": "tenant-b" },
		});

		clearGrokbotTokenCache();
		try {
			await options.fetchDynamicModels?.();
			expect(seenHeaders).toEqual(["tenant-a", "tenant-a"]);
			expect(options.cacheProviderId).toBe(sameHeaders.cacheProviderId);
			expect(options.cacheProviderId).not.toBe(differentHeaders.cacheProviderId);
			expect(options.cacheProviderId).not.toContain("tenant-a");
		} finally {
			clearGrokbotTokenCache();
		}
	});

	test("case-insensitively protects Sand catalog headers while preserving later nonreserved caller headers", async () => {
		const valuesFor = (headers: TestHeaders | undefined, name: string): string[] =>
			Object.entries(headers as Record<string, string>).flatMap(([key, value]) =>
				key.toLowerCase() === name ? [value] : [],
			);
		const requests: TestHeaders[] = [];
		clearGrokbotTokenCache();
		try {
			await fetchGrokbotAvailableModels({
				apiKey: JSON.stringify({ renewal: "catalog-header-renewal", machineId: "catalog-header-machine" }),
				headers: {
					Authorization: "Bearer caller-token",
					"Content-Type": "caller-content",
					"X-Cursor-Client-Type": "caller-client",
					"X-Caller-Layer": "caller",
				},
				fetch: async (input, init) => {
					requests.push(init?.headers ?? {});
					if (String(input).endsWith("/sand-box/inference-credential")) {
						return Response.json({
							accessToken: "synthetic-catalog-access-token",
							grokBotToken: "catalog-grok-bot-token",
							expiresAtMs: Date.now() + 10 * 60_000,
						});
					}
					return Response.json({ models: [] });
				},
			});

			const [mintHeaders, rosterHeaders] = requests;
			expect(valuesFor(mintHeaders, "authorization")).toEqual([]);
			expect(valuesFor(mintHeaders, "content-type")).toEqual(["application/json"]);
			expect(valuesFor(mintHeaders, "x-cursor-client-type")).toEqual(["sand"]);
			expect(valuesFor(mintHeaders, "x-caller-layer")).toEqual(["caller"]);
			expect(valuesFor(rosterHeaders, "authorization")).toEqual(["Bearer synthetic-catalog-access-token"]);
			expect(valuesFor(rosterHeaders, "content-type")).toEqual(["application/json"]);
			expect(valuesFor(rosterHeaders, "x-cursor-client-type")).toEqual(["sand"]);
			expect(valuesFor(rosterHeaders, "x-caller-layer")).toEqual(["caller"]);
		} finally {
			clearGrokbotTokenCache();
		}
	});

	test("keeps a router-only live roster usable while caching it non-authoritatively", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-catalog-grokbot-router-roster-"));
		const dbPath = path.join(tempDir, "models.db");
		const routerOnly = normalizeGrokbotAvailableModels([]);
		const configured = grokbotModelManagerOptions({ apiKey: "grokbot-cache-test" });
		const cacheProviderId = configured.cacheProviderId;
		if (!cacheProviderId) throw new Error("Missing Grok Bot cache namespace");
		let currentTime = 1_000_000;
		let fetches = 0;
		const options = {
			...configured,
			cacheDbPath: dbPath,
			now: () => currentTime,
			fetchDynamicModels: async () => {
				fetches++;
				return routerOnly;
			},
		};
		try {
			const initial = await resolveProviderModels(options, "online");
			expect(initial.models.map(model => model.id).sort()).toEqual(routerOnly.map(model => model.id).sort());
			expect(initial.stale).toBe(false);
			expect(fetches).toBe(1);

			const db = new Database(dbPath, { readonly: true });
			const row = db
				.query<{ authoritative: number }, [string]>("SELECT authoritative FROM model_cache WHERE provider_id = ?")
				.get(cacheProviderId);
			db.close();
			expect(row?.authoritative).toBe(0);

			currentTime += 5 * 60_000 - 1;
			await resolveProviderModels(options, "online-if-uncached");
			expect(fetches).toBe(1);

			currentTime++;
			const retried = await resolveProviderModels(options, "online-if-uncached");
			expect(retried.models.map(model => model.id).sort()).toEqual(routerOnly.map(model => model.id).sort());
			expect(retried.stale).toBe(false);
			expect(fetches).toBe(2);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	test("does not invent thinking efforts absent from live parameter values", () => {
		const model = normalizeGrokbotAvailableModels([
			{
				name: "grok-unrecognized-effort",
				supportsThinking: true,
				parameterDefinitions: [{ id: "effort", values: [{ value: "turbo" }] }],
				variants: [{ parameterValues: [{ id: "effort", value: "experimental" }] }],
			},
		]).find(candidate => candidate.id === "grok-unrecognized-effort");
		if (!model) throw new Error("Missing normalized Grok Bot model");

		expect(model).toMatchObject({ reasoning: true, sandParameterIds: ["effort"] });
		expect(model.thinking).toBeUndefined();
		expect(buildModel(model).thinking).toBeUndefined();
	});

	test("compiles its authoritative live-roster policy from KDL without environment credentials", () => {
		const entry = providerEntry("grokbot");
		expect(entry?.dynamicModelsAuthoritative).toBe(true);
		expect(entry?.envVars).toBeUndefined();

		const descriptor = PROVIDER_DESCRIPTORS.find(candidate => candidate.providerId === "grokbot");
		if (!descriptor) throw new Error("Missing Grok Bot descriptor");
		expect(descriptor.dynamicModelsAuthoritative).toBe(true);
	});
});

describe("Grok Bot bounded account discovery", () => {
	test("cancels a stalled successful token-mint body when the caller aborts", async () => {
		const caller = new AbortController();
		const bodyReadStarted = Promise.withResolvers<void>();
		const bodyCancelled = Promise.withResolvers<void>();
		const abortReason = new Error("caller cancelled token mint");
		const stalledRead = Promise.withResolvers<void>().promise;
		let response: Response | undefined;
		let cancelled = false;
		clearGrokbotTokenCache();
		try {
			const mint = mintGrokbotAccessToken(
				loadGrokbotConfig("stalled-token-mint"),
				async () =>
					(response = new Response(
						new ReadableStream<Uint8Array>({
							pull() {
								bodyReadStarted.resolve();
								return stalledRead;
							},
							cancel() {
								cancelled = true;
								bodyCancelled.resolve();
							},
						}),
					)),
				"https://sand.example",
				caller.signal,
			);

			await bodyReadStarted.promise;
			caller.abort(abortReason);

			await expect(mint).rejects.toBe(abortReason);
			await bodyCancelled.promise;
			expect(cancelled).toBe(true);
			if (!response) throw new Error("Missing stalled token-mint response");
			expect(response.body?.locked).toBe(false);
		} finally {
			clearGrokbotTokenCache();
		}
	});

	test("cancels a stalled successful AvailableModels body when the caller aborts", async () => {
		const caller = new AbortController();
		const bodyReadStarted = Promise.withResolvers<void>();
		const bodyCancelled = Promise.withResolvers<void>();
		const stalledRead = Promise.withResolvers<void>().promise;
		const apiKey = JSON.stringify({ renewal: "stalled-roster", machineId: "machine-stalled-roster" });
		let cancelled = false;
		clearGrokbotTokenCache();
		try {
			const discovery = fetchGrokbotAvailableModels({
				apiKey,
				signal: caller.signal,
				fetch: async input => {
					if (String(input).endsWith("/sand-box/inference-credential")) {
						return Response.json({
							accessToken: "synthetic-stalled-roster-token",
							grokBotToken: "grok-bot-stalled-roster",
							expiresAtMs: Date.now() + 10 * 60_000,
						});
					}
					return new Response(
						new ReadableStream<Uint8Array>({
							pull() {
								bodyReadStarted.resolve();
								return stalledRead;
							},
							cancel() {
								cancelled = true;
								bodyCancelled.resolve();
							},
						}),
					);
				},
			});

			await bodyReadStarted.promise;
			caller.abort(new Error("caller cancelled roster discovery"));

			expect(await discovery).toBeNull();
			await bodyCancelled.promise;
			expect(cancelled).toBe(true);
		} finally {
			clearGrokbotTokenCache();
		}
	});

	test("cancels an oversized successful token-mint body", async () => {
		let cancelled = false;
		clearGrokbotTokenCache();
		try {
			await expect(
				mintGrokbotAccessToken(
					loadGrokbotConfig("oversized-token-mint"),
					async () =>
						new Response(
							new ReadableStream<Uint8Array>({
								start(controller) {
									controller.enqueue(new Uint8Array(64 * 1024 + 1));
								},
								cancel() {
									cancelled = true;
								},
							}),
						),
				),
			).rejects.toThrow("Grok Bot JSON response exceeded the body limit");
			expect(cancelled).toBe(true);
		} finally {
			clearGrokbotTokenCache();
		}
	});

	test("never substitutes the wrong JWT type for an endpoint", async () => {
		clearGrokbotTokenCache();
		try {
			await expect(
				mintGrokbotAccessToken(loadGrokbotConfig("session-only-token"), async () =>
					Response.json({ accessToken: "session-token" }),
				),
			).rejects.toThrow("Grok Bot token renew returned no grokBotToken");

			await expect(
				mintGrokbotAccessToken(
					loadGrokbotConfig("inference-only-token"),
					async () => Response.json({ grokBotToken: "inference-token" }),
					undefined,
					undefined,
					undefined,
					"session",
				),
			).rejects.toThrow("Grok Bot token renew returned no accessToken");
		} finally {
			clearGrokbotTokenCache();
		}
	});

	test("accepts a normal parameterized roster larger than the legacy 64 KiB cap", async () => {
		const apiKey = JSON.stringify({ renewal: "large-roster", machineId: "machine-large-roster" });
		clearGrokbotTokenCache();
		try {
			const models = await fetchGrokbotAvailableModels({
				apiKey,
				fetch: async input => {
					if (String(input).endsWith("/sand-box/inference-credential")) {
						return Response.json({
							accessToken: "synthetic-large-roster-token",
							grokBotToken: "grok-bot-large-roster",
							expiresAtMs: Date.now() + 10 * 60_000,
						});
					}
					return Response.json({
						models: [
							{
								name: "large-live-model",
								clientDisplayName: "x".repeat(64 * 1024),
								parameterDefinitions: [{ id: "effort", values: [{ value: "low" }] }],
							},
						],
					});
				},
			});

			expect(models?.find(model => model.id === "large-live-model")?.thinking).toEqual({
				mode: "effort",
				efforts: [Effort.Low],
			});
		} finally {
			clearGrokbotTokenCache();
		}
	});

	test("cancels an oversized successful AvailableModels body", async () => {
		const apiKey = JSON.stringify({ renewal: "oversized-roster", machineId: "machine-oversized-roster" });
		let cancelled = false;
		clearGrokbotTokenCache();
		try {
			const models = await fetchGrokbotAvailableModels({
				apiKey,
				fetch: async input => {
					if (String(input).endsWith("/sand-box/inference-credential")) {
						return Response.json({
							accessToken: "synthetic-oversized-roster-token",
							grokBotToken: "grok-bot-oversized-roster",
							expiresAtMs: Date.now() + 10 * 60_000,
						});
					}
					return new Response(
						new ReadableStream<Uint8Array>({
							start(controller) {
								controller.enqueue(new Uint8Array(MAX_GROKBOT_CATALOG_JSON_BODY_BYTES + 1));
							},
							cancel() {
								cancelled = true;
							},
						}),
					);
				},
			});

			expect(models).toBeNull();
			expect(cancelled).toBe(true);
		} finally {
			clearGrokbotTokenCache();
		}
	});

	test("intersects divergent account rosters and keys the cache by the complete credential set", async () => {
		const accountA = JSON.stringify({ renewal: "renewal-account-a", machineId: "machine-account-a" });
		const accountB = JSON.stringify({ renewal: "renewal-account-b", machineId: "machine-account-b" });
		const endpoint = "https://sand.example/multi-account";
		const rosterRequests: string[] = [];
		const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			const url = String(input);
			if (url.endsWith("/sand-box/inference-credential")) {
				const { credential } = JSON.parse(String(init?.body)) as { credential: string };
				return Response.json({
					accessToken: `synthetic-access-${credential}`,
					grokBotToken: `grok-bot-${credential}`,
					expiresAtMs: Date.now() + 10 * 60_000,
				});
			}
			rosterRequests.push(new Headers(init?.headers).get("authorization") ?? "");
			if (new Headers(init?.headers).get("authorization") === "Bearer synthetic-access-renewal-account-a") {
				return Response.json({
					models: [
						{
							name: "shared-grok",
							supportsThinking: true,
							supportsImages: true,
							supportsMaxMode: true,
							supportsNonMaxMode: false,
							contextTokenLimit: 100_000,
							contextTokenLimitForMaxMode: 128_000,
							idAliases: ["shared-alias", "account-a-alias"],
							parameterDefinitions: [
								{ id: "effort", values: [{ value: "low" }, { value: "high" }] },
								{ id: "fast" },
							],
						},
						{ name: "account-a-only" },
					],
				});
			}
			return Response.json({
				models: [
					{
						name: "shared-grok",
						supportsThinking: true,
						supportsImages: false,
						supportsMaxMode: false,
						supportsNonMaxMode: true,
						contextTokenLimit: 50_000,
						idAliases: ["shared-alias", "account-b-alias"],
						parameterDefinitions: [{ id: "effort", values: [{ value: "low" }] }, { id: "safe" }],
					},
					{ name: "account-b-only" },
				],
			});
		};
		const options = grokbotModelManagerOptions({
			apiKey: accountA,
			apiKeys: [accountB, accountA],
			baseUrl: endpoint,
			fetch,
		});
		const sameCredentialsReordered = grokbotModelManagerOptions({
			apiKey: accountB,
			apiKeys: [accountA],
			baseUrl: endpoint,
		});
		const oneCredential = grokbotModelManagerOptions({ apiKey: accountA, baseUrl: endpoint });
		if (!options.fetchDynamicModels) throw new Error("Missing Grok Bot dynamic discovery");

		clearGrokbotTokenCache();
		try {
			const models = await options.fetchDynamicModels();
			const shared = models?.find(model => model.id === "shared-grok");

			expect(models?.map(model => model.id)).toEqual(["default", "sand-cua", "shared-grok"]);
			expect(rosterRequests.sort()).toEqual([
				"Bearer synthetic-access-renewal-account-a",
				"Bearer synthetic-access-renewal-account-b",
			]);
			expect(shared).toMatchObject({
				reasoning: true,
				input: ["text"],
				contextWindow: 50_000,
				sandParameterIds: ["effort"],
				sandMaxMode: false,
				aliases: ["shared-alias"],
			});
			expect(shared?.thinking).toEqual({ mode: "effort", efforts: [Effort.Low] });
			expect(options.cacheProviderId).toBe(sameCredentialsReordered.cacheProviderId);
			expect(options.cacheProviderId).not.toBe(oneCredential.cacheProviderId);
		} finally {
			clearGrokbotTokenCache();
		}
	});

	test("fails discovery rather than cache a partial roster when any account request fails", async () => {
		const accountA = JSON.stringify({ renewal: "renewal-partial-a", machineId: "machine-partial-a" });
		const accountB = JSON.stringify({ renewal: "renewal-partial-b", machineId: "machine-partial-b" });
		clearGrokbotTokenCache();
		try {
			const models = await fetchGrokbotAvailableModels({
				apiKeys: [accountA, accountB],
				fetch: async (input, init) => {
					if (String(input).endsWith("/sand-box/inference-credential")) {
						const { credential } = JSON.parse(String(init?.body)) as { credential: string };
						return Response.json({
							accessToken: `synthetic-access-${credential}`,
							grokBotToken: `grok-bot-${credential}`,
							expiresAtMs: Date.now() + 10 * 60_000,
						});
					}
					return new Headers(init?.headers).get("authorization") === "Bearer synthetic-access-renewal-partial-b"
						? new Response("unavailable", { status: 503 })
						: Response.json({ models: [{ name: "only-account-a" }] });
				},
			});

			expect(models).toBeNull();
		} finally {
			clearGrokbotTokenCache();
		}
	});

	test("cancels a stalled successful sibling roster body when another account is unavailable", async () => {
		const accountA = JSON.stringify({ renewal: "renewal-a-pending", machineId: "machine-a-pending" });
		const accountB = JSON.stringify({ renewal: "renewal-b-fails", machineId: "machine-b-fails" });
		const siblingRosterStarted = Promise.withResolvers<void>();
		const stalledRead = Promise.withResolvers<void>().promise;
		let siblingBodyWasCancelled = false;
		let siblingRosterResponse: Response | undefined;
		clearGrokbotTokenCache();
		try {
			const discovery = fetchGrokbotAvailableModels({
				apiKeys: [accountA, accountB],
				timeoutMs: 10_000,
				fetch: async (input, init) => {
					if (String(input).endsWith("/sand-box/inference-credential")) {
						const { credential } = JSON.parse(String(init?.body)) as { credential: string };
						return Response.json({
							accessToken: `synthetic-access-${credential}`,
							grokBotToken: `grok-bot-${credential}`,
							expiresAtMs: Date.now() + 10 * 60_000,
						});
					}
					if (new Headers(init?.headers).get("authorization") === "Bearer synthetic-access-renewal-a-pending") {
						siblingRosterResponse = new Response(
							new ReadableStream<Uint8Array>({
								pull() {
									siblingRosterStarted.resolve();
									return stalledRead;
								},
								cancel() {
									siblingBodyWasCancelled = true;
								},
							}),
						);
						return siblingRosterResponse;
					}
					await siblingRosterStarted.promise;
					return new Response("unavailable", { status: 503 });
				},
			});

			expect(await discovery).toBeNull();
			expect(siblingBodyWasCancelled).toBe(true);
			expect(siblingRosterResponse?.body?.locked).toBe(false);
		} finally {
			clearGrokbotTokenCache();
		}
	});
});

describe("Grok Bot renewal", () => {
	test("isolates renewed tokens by account, backend, namespace, and client version", async () => {
		let fetches = 0;
		const mint = async (): Promise<Response> => {
			fetches++;
			return Response.json({
				accessToken: `synthetic-access-${fetches}`,
				grokBotToken: `grok-bot-${fetches}`,
				expiresAtMs: Date.now() + 10 * 60_000,
			});
		};
		const accountA = { ...loadGrokbotConfig("renewal-account-a"), namespace: "prod", clientVersion: "1.0.0" };
		const accountB = { ...accountA, renewal: "renewal-account-b" };
		const devNamespace = { ...accountA, namespace: "dev" };
		const newerClient = { ...accountA, clientVersion: "2.0.0" };
		clearGrokbotTokenCache();
		try {
			expect(await mintGrokbotAccessToken(accountA, mint, "https://sand-a.example")).toBe("grok-bot-1");
			expect(await mintGrokbotAccessToken(accountB, mint, "https://sand-a.example")).toBe("grok-bot-2");
			expect(await mintGrokbotAccessToken(accountA, mint, "https://sand-b.example")).toBe("grok-bot-3");
			expect(await mintGrokbotAccessToken(devNamespace, mint, "https://sand-a.example")).toBe("grok-bot-4");
			expect(await mintGrokbotAccessToken(newerClient, mint, "https://sand-a.example")).toBe("grok-bot-5");
			expect(await mintGrokbotAccessToken(accountA, mint, "https://sand-a.example")).toBe("grok-bot-1");
			expect(fetches).toBe(5);
		} finally {
			clearGrokbotTokenCache();
		}
	});

	test("partitions minted JWTs by effective custom headers", async () => {
		let fetches = 0;
		const mint = async (): Promise<Response> => {
			fetches++;
			return Response.json({
				accessToken: `synthetic-access-${fetches}`,
				grokBotToken: `grok-bot-${fetches}`,
				expiresAtMs: Date.now() + 10 * 60_000,
			});
		};
		const config = loadGrokbotConfig("header-partitioned-renewal");
		clearGrokbotTokenCache();
		try {
			expect(
				await mintGrokbotAccessToken(config, mint, "https://sand.example", undefined, { "X-Tenant": "one" }),
			).toBe("grok-bot-1");
			expect(
				await mintGrokbotAccessToken(config, mint, "https://sand.example", undefined, { "x-tenant": "one" }),
			).toBe("grok-bot-1");
			expect(
				await mintGrokbotAccessToken(config, mint, "https://sand.example", undefined, { "x-tenant": "two" }),
			).toBe("grok-bot-2");
			expect(fetches).toBe(2);
		} finally {
			clearGrokbotTokenCache();
		}
	});

	test("renews expired tokens on lookup", async () => {
		let fetches = 0;
		let expired = true;
		const mint = async (): Promise<Response> => {
			fetches++;
			return Response.json({
				accessToken: `synthetic-access-${fetches}`,
				grokBotToken: `grok-bot-${fetches}`,
				expiresAtMs: expired ? Date.now() : Date.now() + 10 * 60_000,
			});
		};
		const config = loadGrokbotConfig("expired-renewal");
		clearGrokbotTokenCache();
		try {
			expect(await mintGrokbotAccessToken(config, mint)).toBe("grok-bot-1");
			expired = false;
			expect(await mintGrokbotAccessToken(config, mint)).toBe("grok-bot-2");
			expect(fetches).toBe(2);
		} finally {
			clearGrokbotTokenCache();
		}
	});
	test("logs failed renewal status without response contents", async () => {
		const renewal = "renewal-credential-must-never-appear-in-a-log";
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
		clearGrokbotTokenCache();
		try {
			await expect(
				mintGrokbotAccessToken(
					loadGrokbotConfig(renewal),
					async () => new Response(`backend echoed ${renewal}`, { status: 500 }),
				),
			).rejects.toThrow("Grok Bot token renew failed (HTTP 500)");
			expect(warnSpy).toHaveBeenCalledWith("Grok Bot token renew failed", { status: 500 });
			expect(JSON.stringify(warnSpy.mock.calls)).not.toContain(renewal);
		} finally {
			warnSpy.mockRestore();
			clearGrokbotTokenCache();
		}
	});
});
