import { afterEach, describe, expect, it, vi } from "bun:test";
import type { AuthStorage } from "@oh-my-pi/pi-ai";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import { runSearchQuery } from "@oh-my-pi/pi-coding-agent/web/search";
import * as providerRegistry from "@oh-my-pi/pi-coding-agent/web/search/provider";
import { searchAnySearch } from "@oh-my-pi/pi-coding-agent/web/search/providers/anysearch";
import type { SearchProvider } from "@oh-my-pi/pi-coding-agent/web/search/providers/base";
import { SEARCH_PROVIDER_OPTIONS, SEARCH_PROVIDER_ORDER } from "@oh-my-pi/pi-coding-agent/web/search/types";

interface FakeAuthStorage {
	authStorage: AuthStorage;
	getStoredKey: () => string | undefined;
}

function createAuthStorage(initialKey?: string): FakeAuthStorage {
	let storedKey = initialKey;
	const authStorage = {
		hasAuth: () => storedKey !== undefined,
		getApiKey: async () => storedKey,
		resolver: () => async () => storedKey,
		set: async (_provider: string, credential: unknown) => {
			if (
				typeof credential !== "object" ||
				credential === null ||
				!("type" in credential) ||
				credential.type !== "api_key" ||
				!("key" in credential) ||
				typeof credential.key !== "string"
			) {
				throw new Error("Expected an API-key credential");
			}
			storedKey = credential.key;
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
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("appears immediately after Auto and leads the concrete provider order", () => {
		expect(SEARCH_PROVIDER_OPTIONS.slice(0, 2).map(option => option.value)).toEqual(["auto", "anysearch"]);
		expect(SEARCH_PROVIDER_ORDER[0]).toBe("anysearch");
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

	it("provisions a generated key through the forced-provider query path and returns the retried result", async () => {
		const { authStorage, getStoredKey } = createAuthStorage();
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

		const result = await runSearchQuery({ query: "query", provider: "anysearch" }, { authStorage });

		expect(authorizations).toEqual([null, `Bearer ${generatedKey}`]);
		expect(getStoredKey()).toBe(generatedKey);
		expect(result.details.response).toMatchObject({
			provider: "anysearch",
			requestId: "req-full-path",
			authMode: "api_key",
			sources: [{ title: "AnySearch result", url: "https://example.com/result" }],
		});
		expect(result.content[0]?.text).toContain("AnySearch result");
		expect(JSON.stringify(result)).not.toContain(generatedKey);
		expect(JSON.stringify(result)).not.toContain("Secret123");
	});

	it("uses ordinary AnySearch search when it is an incidental fallback", async () => {
		let regularSearchCalled = false;
		let provisioningSearchCalled = false;
		const firstProvider = {
			id: "perplexity",
			label: "Perplexity",
			isAvailable: () => true,
			isExplicitlyAvailable: () => true,
			search: async () => {
				throw new Error("first provider failed");
			},
		} as SearchProvider;
		const anySearchProvider = {
			id: "anysearch",
			label: "AnySearch",
			isAvailable: () => true,
			isExplicitlyAvailable: () => true,
			search: async () => {
				regularSearchCalled = true;
				return {
					provider: "anysearch" as const,
					sources: [{ title: "result", url: "https://example.com/" }],
				};
			},
			searchWithCredentialProvisioning: async () => {
				provisioningSearchCalled = true;
				return {
					provider: "anysearch" as const,
					sources: [{ title: "result", url: "https://example.com/" }],
				};
			},
		} as SearchProvider;
		vi.spyOn(providerRegistry, "resolveProviderCandidates").mockReturnValue([
			{ id: "perplexity", explicit: true },
			{ id: "anysearch", explicit: true },
		]);
		vi.spyOn(providerRegistry, "getSearchProvider").mockImplementation(async id =>
			id === "perplexity" ? firstProvider : anySearchProvider,
		);

		await runSearchQuery({ query: "query" }, { authStorage: {} as AuthStorage });

		expect(regularSearchCalled).toBe(true);
		expect(provisioningSearchCalled).toBe(false);
	});
});
