import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import * as aiStream from "@oh-my-pi/pi-ai/stream";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { runSearchQuery } from "@oh-my-pi/pi-coding-agent/web/search";
import * as providerRegistry from "@oh-my-pi/pi-coding-agent/web/search/provider";
import { searchAnySearch } from "@oh-my-pi/pi-coding-agent/web/search/providers/anysearch";
import type { SearchProviderId, SearchResponse } from "@oh-my-pi/pi-coding-agent/web/search/types";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "../../helpers/agent-session-setup";

interface FakeAuthStorage {
	authStorage: AuthStorage;
	getStoredKey: () => string | undefined;
}

function createAuthStorage(initialKey?: string): FakeAuthStorage {
	let storedKey = initialKey;
	const authStorage = {
		keys: { has: () => storedKey !== undefined, get: async () => storedKey, resolver: () => async () => storedKey },
		credentials: {
			addGeneratedApiKeyIfAbsent: async (_provider: string, apiKey: string) => {
				if (storedKey !== undefined) return false;
				storedKey = apiKey;
				return true;
			},
		},
	} as unknown as AuthStorage;
	return { authStorage, getStoredKey: () => storedKey };
}

function successfulResponse(requestId = "req-success"): Response {
	return Response.json({
		code: 0,
		message: "success",
		request_id: requestId,
		data: {
			results: [
				{
					title: "AnySearch result",
					url: "https://example.com/result",
					content: "Full result content",
					snippet: "Short snippet",
				},
			],
		},
	});
}

function registrationResponse(message: string): Response {
	return Response.json({ code: -1, message, request_id: "req-registration" }, { status: 402 });
}

function createdRegistrationMessage(apiKey: string, username = "as_auto_dGVzdHVzZXI", password = "Secret123"): string {
	return `Your account and API key have been automatically generated. Use the API key below to continue.\nusername=${username}\npassword=${password}\napi_key=${apiKey}`;
}

const REGISTRATION_PENDING_MESSAGE =
	"Your anonymous free quota has been exhausted. We’re registering your account and generating an API key. Please try again shortly.";
const REGISTRATION_FAILED_MESSAGE =
	"Free quota exhausted. Auto-registration failed. Please try again later or contact support.";
const REGISTRATION_DISABLED_MESSAGE =
	"Free quota exhausted. Auto-registration is disabled. Please use an existing account or API key, or contact support.";

describe("AnySearch provider", () => {
	const openAuthStorages: AuthStorage[] = [];
	async function roleContext(primary?: string, fallbacks: string[] | null = []) {
		const settings = await Settings.init({ inMemory: true });
		if (primary) settings.setModelRole("web", primary);
		if (fallbacks !== null) settings.set("retry.fallbackChains", { web: fallbacks });
		const authStorage = createInMemoryAuthStorage();
		openAuthStorages.push(authStorage);
		vi.spyOn(aiStream, "getEnvApiKey").mockReturnValue(undefined);
		const modelRegistry = new ModelRegistry(authStorage, undefined, { settings });
		return { authStorage, modelRegistry };
	}

	function stubOtherEngines(available: SearchProviderId[], search: (id: SearchProviderId) => Promise<SearchResponse>) {
		const originalGet = providerRegistry.getSearchProvider;
		vi.spyOn(providerRegistry, "getSearchProvider").mockImplementation(async id => {
			if (id === "anysearch") return originalGet(id);
			const providerId = id as SearchProviderId;
			return {
				id: providerId,
				label: id,
				isAvailable: () => available.includes(providerId),
				isExplicitlyAvailable: () => available.includes(providerId),
				search: () => search(providerId),
			};
		});
	}

	afterEach(() => {
		vi.restoreAllMocks();
		resetSettingsForTest();
		for (const authStorage of openAuthStorages.splice(0)) authStorage.close();
	});

	it("uses anonymous search when explicitly selected without a key and clamps max_results to 10", async () => {
		const { authStorage } = createAuthStorage();
		let authorization: string | null = "not-called";
		let requestBody: unknown;
		const fetchMock: FetchImpl = async (_input, init) => {
			const headers = new Headers(init?.headers);
			authorization = headers.get("Authorization");
			requestBody = JSON.parse(String(init?.body)) as unknown;
			return successfulResponse();
		};

		const response = await searchAnySearch({
			query: "latest Bun release",
			num_results: 20,
			authStorage,
			provisionGeneratedCredential: true,
			fetch: fetchMock,
		});

		expect(authorization).toBeNull();
		expect(requestBody).toEqual({ query: "latest Bun release", max_results: 10 });
		expect(response).toEqual({
			provider: "anysearch",
			sources: [
				{
					title: "AnySearch result",
					url: "https://example.com/result",
					snippet: "Full result content",
				},
			],
			requestId: "req-success",
			authMode: "anonymous",
		});
	});

	it("strips terminal control sequences from indexed result text before returning it", async () => {
		const { authStorage } = createAuthStorage("existing-key");
		const fetchMock: FetchImpl = async () =>
			Response.json({
				code: 0,
				request_id: "req-sanitized",
				data: {
					results: [
						{
							title: "Safe \x1b[31mred\x1b[0m title\x1b]52;c;c2VjcmV0\x07",
							url: "https://example.com/sanitized",
							content: "Before\x1b]52;c;c2VjcmV0\x07After \x1b[2Jcontent",
						},
					],
				},
			});

		const response = await searchAnySearch({ query: "query", authStorage, fetch: fetchMock });

		expect(response.sources).toEqual([
			{
				title: "Safe red title",
				url: "https://example.com/sanitized",
				snippet: "BeforeAfter content",
			},
		]);
	});

	it("sends a configured key as Bearer authentication", async () => {
		const { authStorage } = createAuthStorage("existing-key");
		const authorizations: Array<string | null> = [];
		const fetchMock: FetchImpl = async (_input, init) => {
			authorizations.push(new Headers(init?.headers).get("Authorization"));
			return successfulResponse();
		};

		const response = await searchAnySearch({ query: "query", authStorage, fetch: fetchMock });

		expect(authorizations).toEqual(["Bearer existing-key"]);
		expect(response.authMode).toBe("api_key");
	});

	it("saves a complete generated credential and retries the rejected search exactly once", async () => {
		const { authStorage, getStoredKey } = createAuthStorage();
		const secretKey = "as_sk_0123456789abcdef0123456789abcdef";
		const secretPassword = "Secret123";
		const authorizations: Array<string | null> = [];
		const fetchMock: FetchImpl = async (_input, init) => {
			authorizations.push(new Headers(init?.headers).get("Authorization"));
			if (authorizations.length === 1) {
				return registrationResponse(createdRegistrationMessage(secretKey, "as_auto_dGVzdHVzZXI", secretPassword));
			}
			return successfulResponse("req-retried");
		};

		const response = await searchAnySearch({
			query: "query",
			authStorage,
			provisionGeneratedCredential: true,
			fetch: fetchMock,
		});

		expect(authorizations).toEqual([null, `Bearer ${secretKey}`]);
		expect(getStoredKey()).toBe(secretKey);
		expect(JSON.stringify(response)).not.toContain(secretKey);
		expect(JSON.stringify(response)).not.toContain(secretPassword);
	});

	it("preserves a login credential written while anonymous registration is in flight", async () => {
		vi.spyOn(aiStream, "getEnvApiKey").mockReturnValue(undefined);
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-anysearch-auth-race-"));
		const dbPath = path.join(tempDir, "agent.db");
		let primaryStorage: AuthStorage | undefined;
		let loginStorage: AuthStorage | undefined;
		try {
			primaryStorage = await AuthStorage.create(dbPath);
			loginStorage = await AuthStorage.create(dbPath);
			await Promise.all([primaryStorage.reload(), loginStorage.reload()]);
			const generatedKey = "as_sk_88888888888888888888888888888888";
			const loginKey = "user-login-key";
			const authorizations: Array<string | null> = [];
			const fetchMock: FetchImpl = async (_input, init) => {
				authorizations.push(new Headers(init?.headers).get("Authorization"));
				if (authorizations.length === 1) {
					await loginStorage?.credentials.set("anysearch", { type: "api_key", key: loginKey, source: "login" });
					return registrationResponse(createdRegistrationMessage(generatedKey));
				}
				return successfulResponse("req-login-won");
			};

			const response = await searchAnySearch({
				query: "query",
				authStorage: primaryStorage,
				provisionGeneratedCredential: true,
				fetch: fetchMock,
			});

			expect(authorizations).toEqual([null, `Bearer ${loginKey}`]);
			expect(response.requestId).toBe("req-login-won");
			expect(primaryStorage.credentials.list("anysearch").map(entry => entry.credential)).toEqual([
				{ type: "api_key", key: loginKey, source: "login" },
			]);
		} finally {
			primaryStorage?.close();
			loginStorage?.close();
			await removeWithRetries(tempDir);
		}
	});

	it("removes the legacy response period without changing the generated API key", async () => {
		const { authStorage, getStoredKey } = createAuthStorage();
		const secretKey = "as_sk_11111111111111111111111111111111";
		const authorizations: Array<string | null> = [];
		const fetchMock: FetchImpl = async (_input, init) => {
			authorizations.push(new Headers(init?.headers).get("Authorization"));
			return authorizations.length === 1
				? registrationResponse(`${createdRegistrationMessage(secretKey)}.`)
				: successfulResponse();
		};

		await searchAnySearch({
			query: "query",
			authStorage,
			provisionGeneratedCredential: true,
			fetch: fetchMock,
		});

		expect(getStoredKey()).toBe(secretKey);
		expect(authorizations).toEqual([null, `Bearer ${secretKey}`]);
	});

	it("retries a temporary 401 while a generated key reaches Gateway caches", async () => {
		const { authStorage, getStoredKey } = createAuthStorage();
		const secretKey = "as_sk_22222222222222222222222222222222";
		const authorizations: Array<string | null> = [];
		const fetchMock: FetchImpl = async (_input, init) => {
			authorizations.push(new Headers(init?.headers).get("Authorization"));
			if (authorizations.length === 1) return registrationResponse(createdRegistrationMessage(secretKey));
			if (authorizations.length === 2) {
				return Response.json(
					{ code: -1, message: "The API key does not exist.", request_id: "req-key-propagation" },
					{ status: 401 },
				);
			}
			return successfulResponse("req-key-active");
		};

		const response = await searchAnySearch({
			query: "query",
			authStorage,
			provisionGeneratedCredential: true,
			credentialActivationRetryDelaysMs: [0],
			fetch: fetchMock,
		});

		expect(getStoredKey()).toBe(secretKey);
		expect(authorizations).toEqual([null, `Bearer ${secretKey}`, `Bearer ${secretKey}`]);
		expect(response.requestId).toBe("req-key-active");
	});

	it("keeps the generated key and reports a safe retry-later error when Gateway activation remains pending", async () => {
		const { authStorage, getStoredKey } = createAuthStorage();
		const secretKey = "as_sk_66666666666666666666666666666666";
		let callCount = 0;
		const fetchMock: FetchImpl = async () => {
			callCount++;
			if (callCount === 1) return registrationResponse(createdRegistrationMessage(secretKey));
			return Response.json(
				{ code: -1, message: "The API key does not exist.", request_id: "req-key-still-pending" },
				{ status: 401 },
			);
		};

		let error: unknown;
		try {
			await searchAnySearch({
				query: "query",
				authStorage,
				provisionGeneratedCredential: true,
				credentialActivationRetryDelaysMs: [],
				fetch: fetchMock,
			});
		} catch (caught) {
			error = caught;
		}

		expect(getStoredKey()).toBe(secretKey);
		expect(String(error)).toContain("has not reached the search gateway yet");
		expect(String(error)).toContain("Request ID: req-key-still-pending");
		expect(String(error)).not.toContain("The API key does not exist");
		expect(String(error)).not.toContain(secretKey);
	});

	it("polls a pending registration only within the configured bounded schedule", async () => {
		const { authStorage, getStoredKey } = createAuthStorage();
		let callCount = 0;
		const fetchMock: FetchImpl = async () => {
			callCount++;
			if (callCount === 1) return registrationResponse(REGISTRATION_PENDING_MESSAGE);
			if (callCount === 2) {
				return registrationResponse(createdRegistrationMessage("as_sk_33333333333333333333333333333333"));
			}
			return successfulResponse();
		};

		await searchAnySearch({
			query: "query",
			authStorage,
			provisionGeneratedCredential: true,
			registrationPollDelaysMs: [0],
			fetch: fetchMock,
		});

		expect(callCount).toBe(3);
		expect(getStoredKey()).toBe("as_sk_33333333333333333333333333333333");
	});

	it("surfaces a safe request ID when registration remains pending", async () => {
		const { authStorage } = createAuthStorage();
		const fetchMock: FetchImpl = async () => registrationResponse(REGISTRATION_PENDING_MESSAGE);

		await expect(
			searchAnySearch({
				query: "query",
				authStorage,
				provisionGeneratedCredential: true,
				registrationPollDelaysMs: [],
				fetch: fetchMock,
			}),
		).rejects.toThrow(
			"AnySearch account registration is still in progress. Select AnySearch and try again shortly. Request ID: req-registration.",
		);
	});

	it("normalizes failed registration into configuration guidance without exposing the response body", async () => {
		const { authStorage } = createAuthStorage();
		const fetchMock: FetchImpl = async () => registrationResponse(REGISTRATION_FAILED_MESSAGE);

		let error: unknown;
		try {
			await searchAnySearch({
				query: "query",
				authStorage,
				provisionGeneratedCredential: true,
				fetch: fetchMock,
			});
		} catch (caught) {
			error = caught;
		}

		expect(String(error)).toContain("Configure ANYSEARCH_API_KEY or run /login anysearch");
		expect(String(error)).toContain("Request ID: req-registration");
		expect(String(error)).not.toContain(REGISTRATION_FAILED_MESSAGE);
	});

	it("normalizes disabled registration into configuration guidance without exposing the response body", async () => {
		const { authStorage } = createAuthStorage();
		const fetchMock: FetchImpl = async () => registrationResponse(REGISTRATION_DISABLED_MESSAGE);

		let error: unknown;
		try {
			await searchAnySearch({
				query: "query",
				authStorage,
				provisionGeneratedCredential: true,
				fetch: fetchMock,
			});
		} catch (caught) {
			error = caught;
		}

		expect(String(error)).toContain("Configure ANYSEARCH_API_KEY or run /login anysearch");
		expect(String(error)).toContain("Request ID: req-registration");
		expect(String(error)).not.toContain(REGISTRATION_DISABLED_MESSAGE);
	});

	it("stops registration polling when the caller aborts during backoff", async () => {
		const { authStorage } = createAuthStorage();
		const controller = new AbortController();
		let callCount = 0;
		const fetchMock: FetchImpl = async () => {
			callCount++;
			controller.abort(new Error("stop registration"));
			return registrationResponse(REGISTRATION_PENDING_MESSAGE);
		};

		await expect(
			searchAnySearch({
				query: "query",
				authStorage,
				provisionGeneratedCredential: true,
				registrationPollDelaysMs: [1_000],
				fetch: fetchMock,
				signal: controller.signal,
			}),
		).rejects.toThrow("stop registration");
		expect(callCount).toBe(1);
	});

	it("keeps registration polling within one provider deadline", async () => {
		const { authStorage } = createAuthStorage();
		let callCount = 0;
		const fetchMock: FetchImpl = async () => {
			callCount++;
			return registrationResponse(REGISTRATION_PENDING_MESSAGE);
		};

		await expect(
			searchAnySearch({
				query: "query",
				authStorage,
				provisionGeneratedCredential: true,
				registrationPollDelaysMs: [200],
				timeoutMs: 20,
				fetch: fetchMock,
			}),
		).rejects.toMatchObject({ name: "TimeoutError" });
		expect(callCount).toBe(1);
	});

	it("keeps generated-key activation retries within the same provider deadline", async () => {
		const { authStorage, getStoredKey } = createAuthStorage();
		const secretKey = "as_sk_77777777777777777777777777777777";
		let callCount = 0;
		const fetchMock: FetchImpl = async () => {
			callCount++;
			if (callCount === 1) return registrationResponse(createdRegistrationMessage(secretKey));
			return Response.json(
				{ code: -1, message: "The API key does not exist.", request_id: "req-key-propagation" },
				{ status: 401 },
			);
		};

		await expect(
			searchAnySearch({
				query: "query",
				authStorage,
				provisionGeneratedCredential: true,
				credentialActivationRetryDelaysMs: [200],
				timeoutMs: 20,
				fetch: fetchMock,
			}),
		).rejects.toMatchObject({ name: "TimeoutError" });
		expect(callCount).toBe(2);
		expect(getStoredKey()).toBe(secretKey);
	});

	it("keeps generated-credential persistence within the provider deadline", async () => {
		const secretKey = "as_sk_88888888888888888888888888888888";
		let persistenceSignal: AbortSignal | undefined;
		const authStorage = {
			keys: { has: () => false, get: async () => undefined, resolver: () => async () => undefined },
			credentials: {
				addGeneratedApiKeyIfAbsent: async (_provider: string, _apiKey: string, signal?: AbortSignal) => {
					if (!signal) throw new Error("generated credential persistence requires a provider signal");
					persistenceSignal = signal;
					signal.throwIfAborted();
					const aborted = Promise.withResolvers<boolean>();
					const onAbort = (): void => aborted.reject(signal.reason);
					signal.addEventListener("abort", onAbort, { once: true });
					try {
						return await aborted.promise;
					} finally {
						signal.removeEventListener("abort", onAbort);
					}
				},
			},
		} as unknown as AuthStorage;

		await expect(
			searchAnySearch({
				query: "query",
				authStorage,
				provisionGeneratedCredential: true,
				timeoutMs: 20,
				fetch: async () => registrationResponse(createdRegistrationMessage(secretKey)),
			}),
		).rejects.toMatchObject({ name: "TimeoutError" });
		expect(persistenceSignal?.aborted).toBe(true);
	});

	it("does not overwrite an existing key or expose credentials from an authenticated 402", async () => {
		const { authStorage, getStoredKey } = createAuthStorage("existing-key");
		const leakedKey = "must-not-replace-existing-key";
		const fetchMock: FetchImpl = async () =>
			registrationResponse(`quota exhausted\nusername=attacker\npassword=leaked-password\napi_key=${leakedKey}`);

		let error: unknown;
		try {
			await searchAnySearch({ query: "query", authStorage, fetch: fetchMock });
		} catch (caught) {
			error = caught;
		}

		expect(getStoredKey()).toBe("existing-key");
		expect(String(error)).toContain("credits exhausted");
		expect(String(error)).not.toContain(leakedKey);
		expect(String(error)).not.toContain("leaked-password");
	});

	it("rejects partial registration credentials without persisting or leaking them", async () => {
		const { authStorage, getStoredKey } = createAuthStorage();
		const partialKey = "as_sk_44444444444444444444444444444444";
		const fetchMock: FetchImpl = async () => registrationResponse(`created\nusername=user\napi_key=${partialKey}`);

		let error: unknown;
		try {
			await searchAnySearch({
				query: "query",
				authStorage,
				provisionGeneratedCredential: true,
				registrationPollDelaysMs: [],
				fetch: fetchMock,
			});
		} catch (caught) {
			error = caught;
		}

		expect(getStoredKey()).toBeUndefined();
		expect(String(error)).toContain("402 credits exhausted");
		expect(String(error)).not.toContain(partialKey);
	});

	it("rejects a complete credential message whose API key does not match the generated-key format", async () => {
		const { authStorage, getStoredKey } = createAuthStorage();
		const invalidKey = "as_sk_not-a-generated-key";
		const fetchMock: FetchImpl = async () => registrationResponse(createdRegistrationMessage(invalidKey));

		let error: unknown;
		try {
			await searchAnySearch({
				query: "query",
				authStorage,
				provisionGeneratedCredential: true,
				registrationPollDelaysMs: [],
				fetch: fetchMock,
			});
		} catch (caught) {
			error = caught;
		}

		expect(getStoredKey()).toBeUndefined();
		expect(String(error)).toContain("402 credits exhausted");
		expect(String(error)).not.toContain(invalidKey);
	});

	it.each(["role", "override"])(
		"provisions a generated key through an explicit %s and returns the retried result",
		async selection => {
			const context = await roleContext(selection === "role" ? "web/anysearch" : "web/duckduckgo");
			const generatedKey = "as_sk_55555555555555555555555555555555";
			const authorizations: Array<string | null> = [];
			const fetchMock = Object.assign(
				async (_input: string | Request | URL, init?: RequestInit): Promise<Response> => {
					authorizations.push(new Headers(init?.headers).get("Authorization"));
					if (authorizations.length === 1) {
						return registrationResponse(createdRegistrationMessage(generatedKey));
					}
					return successfulResponse("req-full-path");
				},
				{ preconnect: fetch.preconnect },
			);
			vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);

			const result = await runSearchQuery(
				{ query: "query", ...(selection === "override" ? { model: "web/anysearch" } : {}) },
				context,
			);

			expect(authorizations).toEqual([null, `Bearer ${generatedKey}`]);
			expect(await context.authStorage.keys.get("anysearch")).toBe(generatedKey);
			expect(result.details.response).toMatchObject({
				provider: "anysearch",
				requestId: "req-full-path",
				authMode: "api_key",
				sources: [{ title: "AnySearch result", url: "https://example.com/result" }],
			});
			expect(result.content[0]?.text).toContain("AnySearch result");
			expect(JSON.stringify(result)).not.toContain(generatedKey);
			expect(JSON.stringify(result)).not.toContain("Secret123");
		},
	);

	it.each(["web/parallel", "web/missing-engine"])(
		"does not provision credentials when AnySearch follows %s",
		async primary => {
			const context = await roleContext(primary, ["web/anysearch"]);
			const generatedKey = "as_sk_66666666666666666666666666666666";
			const anysearch = await providerRegistry.getSearchProvider("anysearch");
			const originalGet = providerRegistry.getSearchProvider;
			vi.spyOn(providerRegistry, "getSearchProvider").mockImplementation(async id => {
				if (id !== "parallel") return originalGet(id);
				return {
					id: "parallel",
					label: "Parallel",
					isAvailable: () => true,
					isExplicitlyAvailable: () => true,
					search: async () => {
						throw new Error("preferred engine failed");
					},
				};
			});
			const search = vi.spyOn(anysearch, "search");
			const fetchMock = vi
				.spyOn(globalThis, "fetch")
				.mockResolvedValue(registrationResponse(createdRegistrationMessage(generatedKey)));
			const result = await runSearchQuery({ query: "query" }, context);
			expect(search).toHaveBeenCalledTimes(1);
			expect(fetchMock).toHaveBeenCalledTimes(1);
			expect(await context.authStorage.keys.get("anysearch")).toBeUndefined();
			expect(result.details.error).toContain("402 credits exhausted");
			expect(JSON.stringify(result)).not.toContain(generatedKey);
		},
	);

	it("uses a saved AnySearch key through the automatic web role without registration", async () => {
		const context = await roleContext(undefined, null);
		const attempts: string[] = [];
		stubOtherEngines(["startpage"], async () => {
			attempts.push("startpage");
			throw new Error("AnySearch should run first");
		});
		await context.authStorage.credentials.set("anysearch", { type: "api_key", key: "saved-key" });
		const authorizations: Array<string | null> = [];
		vi.spyOn(globalThis, "fetch").mockImplementation(
			Object.assign(
				async (_input: string | Request | URL, init?: RequestInit) => {
					attempts.push("anysearch");
					authorizations.push(new Headers(init?.headers).get("Authorization"));
					return successfulResponse();
				},
				{ preconnect: fetch.preconnect },
			),
		);
		const result = await runSearchQuery({ query: "query" }, context);
		expect(authorizations).toEqual(["Bearer saved-key"]);
		expect(attempts).toEqual(["anysearch"]);
		expect(result.details.response.sources[0]?.url).toBe("https://example.com/result");
		expect(result.details.response.provider).toBe("anysearch");
	});

	it.each(["first fails", "first succeeds", "no alternative", "configured order", "configured fallbacks"])(
		"orders anonymous search by actual availability: %s",
		async scenario => {
			const context =
				scenario === "configured order"
					? await roleContext("web/startpage", ["web/duckduckgo", "web/anysearch"])
					: scenario === "configured fallbacks"
						? await roleContext(undefined, ["web/startpage"])
						: await roleContext(undefined, null);
			const attempts: string[] = [];
			const authorizations: Array<string | null> = [];
			stubOtherEngines(scenario === "no alternative" ? [] : ["startpage", "duckduckgo"], async id => {
				attempts.push(id);
				if (scenario !== "first succeeds") throw new Error("engine failed");
				return { provider: id, sources: [{ title: "First result", url: "https://first.example/" }] };
			});
			vi.spyOn(globalThis, "fetch").mockImplementation(
				Object.assign(
					async (_input: string | Request | URL, init?: RequestInit) => {
						attempts.push("anysearch");
						authorizations.push(new Headers(init?.headers).get("Authorization"));
						return successfulResponse();
					},
					{ preconnect: fetch.preconnect },
				),
			);
			const result = await runSearchQuery({ query: "query" }, context);
			const expected =
				scenario === "first succeeds"
					? ["startpage"]
					: scenario === "configured order"
						? ["startpage", "duckduckgo", "anysearch"]
						: scenario === "first fails"
							? ["startpage", "anysearch"]
							: ["anysearch"];
			expect(attempts).toEqual(expected);
			expect(authorizations).toEqual(scenario === "first succeeds" ? [] : [null]);
			expect(result.details.error).toBeUndefined();
			expect(result.details.response.sources[0]?.url).toBe(
				scenario === "first succeeds" ? "https://first.example/" : "https://example.com/result",
			);
			expect(await context.authStorage.keys.get("anysearch")).toBeUndefined();
		},
	);

	it.each(["pending", "generated"])(
		"continues the original chain after anonymous quota exhaustion with a %s response",
		async state => {
			const context = await roleContext(undefined, null);
			const generatedKey = "as_sk_99999999999999999999999999999999";
			const message = state === "pending" ? REGISTRATION_PENDING_MESSAGE : createdRegistrationMessage(generatedKey);
			const attempts: string[] = [];
			stubOtherEngines(["startpage", "duckduckgo"], async id => {
				attempts.push(id);
				if (id === "startpage") throw new Error("first engine failed");
				return { provider: id, sources: [{ title: "Fallback result", url: "https://fallback.example/" }] };
			});
			const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
				Object.assign(
					async () => {
						attempts.push("anysearch");
						return registrationResponse(message);
					},
					{ preconnect: fetch.preconnect },
				),
			);
			const result = await runSearchQuery({ query: "query" }, context);
			expect(attempts).toEqual(["startpage", "anysearch", "duckduckgo"]);
			expect(fetchMock).toHaveBeenCalledTimes(1);
			expect(result.details.error).toBeUndefined();
			expect(result.details.response.sources[0]?.url).toBe("https://fallback.example/");
			expect(await context.authStorage.keys.get("anysearch")).toBeUndefined();
			expect(JSON.stringify(result)).not.toContain(generatedKey);
			expect(JSON.stringify(result)).not.toContain("Secret123");
		},
	);

	it("does not start deferred anonymous search after cancellation of the first engine", async () => {
		const context = await roleContext(undefined, null);
		const controller = new AbortController();
		stubOtherEngines(["startpage"], async () => {
			controller.abort();
			controller.signal.throwIfAborted();
			throw new Error("unreachable");
		});
		const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected anonymous request"));
		await expect(runSearchQuery({ query: "query" }, { ...context, signal: controller.signal })).rejects.toMatchObject(
			{ name: "ToolAbortError" },
		);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
