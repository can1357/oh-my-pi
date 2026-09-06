import { afterEach, describe, expect, it, vi } from "bun:test";
import {
	buildXAICliBillingUrl,
	extractXAIAccessTokenSubject,
	fetchXAIOAuthIdentity,
	getXAICliBillingHeaders,
	isXAIAccessTokenExpiring,
	loginXAIOAuth,
	parseXAIAccessTokenPayload,
	refreshXAIOAuthToken,
	validateXAIBillingEndpoint,
	validateXAIEndpoint,
} from "../../../src/registry/oauth/xai-oauth";
import type { FetchImpl } from "../../../src/types";

afterEach(() => {
	vi.restoreAllMocks();
});

function jwtWithExp(exp: number): string {
	return jwtWithPayload({ exp });
}

function jwtWithPayload(payload: Record<string, unknown>): string {
	const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
	const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
	return `${header}.${encodedPayload}.sig`;
}

const DISCOVERY_URL = "https://auth.x.ai/.well-known/openid-configuration";
const DEVICE_CODE_URL = "https://auth.x.ai/oauth2/device/code";
const TOKEN_ENDPOINT = "https://auth.x.ai/oauth2/token";
const USERINFO_URL = "https://auth.x.ai/oauth2/userinfo";
const CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const SCOPE = "openid profile email offline_access grok-cli:access api:access";

const DEVICE_AUTHORIZATION = {
	device_code: "device-code-123",
	user_code: "ABCD-EFGH",
	verification_uri: "https://auth.x.ai/activate",
	verification_uri_complete: "https://auth.x.ai/activate?user_code=ABCD-EFGH",
	expires_in: 600,
	interval: 1,
};

type RecordedRequest = {
	url: string;
	init: RequestInit | undefined;
};

type TokenResponse = {
	body: unknown;
	status?: number;
};

function jsonResponse(body: unknown, status: number = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function createDeviceFlowFetch(
	tokenResponses: readonly TokenResponse[],
	userinfoResponse: TokenResponse = { body: {} },
) {
	const requests: RecordedRequest[] = [];
	let tokenResponseIndex = 0;
	const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
		requests.push({ url, init });

		if (url === DISCOVERY_URL) {
			return jsonResponse({ token_endpoint: TOKEN_ENDPOINT });
		}
		if (url === DEVICE_CODE_URL) {
			return jsonResponse(DEVICE_AUTHORIZATION);
		}
		if (url === TOKEN_ENDPOINT) {
			const tokenResponse = tokenResponses[tokenResponseIndex];
			tokenResponseIndex += 1;
			if (!tokenResponse) {
				throw new Error(`Unexpected xAI token poll ${tokenResponseIndex}`);
			}
			return jsonResponse(tokenResponse.body, tokenResponse.status);
		}
		if (url === USERINFO_URL) {
			return jsonResponse(userinfoResponse.body, userinfoResponse.status);
		}
		throw new Error(`Unexpected xAI OAuth request: ${url}`);
	});

	return {
		fetchMock: fetchMock as unknown as typeof fetch,
		requests,
	};
}

function requestForm(request: RecordedRequest | undefined): URLSearchParams {
	const body = request?.init?.body;
	if (!(body instanceof URLSearchParams)) {
		throw new Error("Expected an application/x-www-form-urlencoded request body");
	}
	return body;
}

describe("isXAIAccessTokenExpiring", () => {
	it("returns false for an empty string", () => {
		expect(isXAIAccessTokenExpiring("")).toBe(false);
	});

	it("returns false for a non-JWT", () => {
		expect(isXAIAccessTokenExpiring("not.a.jwt")).toBe(false);
	});

	it("returns true when exp is already in the past", () => {
		const now = Math.floor(Date.now() / 1000);
		expect(isXAIAccessTokenExpiring(jwtWithExp(now - 60))).toBe(true);
	});

	it("returns false when exp is well in the future", () => {
		const now = Math.floor(Date.now() / 1000);
		expect(isXAIAccessTokenExpiring(jwtWithExp(now + 3600))).toBe(false);
	});
});

describe("xAI OAuth helpers", () => {
	it("parses JWT payloads and extracts subjects", () => {
		const token = jwtWithPayload({ sub: " subject-123 ", exp: 1_900_000_000 });

		expect(parseXAIAccessTokenPayload(token)).toEqual({ sub: " subject-123 ", exp: 1_900_000_000 });
		expect(extractXAIAccessTokenSubject(token)).toBe("subject-123");
		expect(parseXAIAccessTokenPayload("not-a-jwt")).toBeNull();
		expect(extractXAIAccessTokenSubject("not-a-jwt")).toBeUndefined();
	});

	it("builds the billing URL and CLI-aligned headers", () => {
		expect(buildXAICliBillingUrl()).toBe("https://cli-chat-proxy.grok.com/v1/billing?format=credits");
		expect(buildXAICliBillingUrl("tokens")).toBe("https://cli-chat-proxy.grok.com/v1/billing?format=tokens");
		expect(buildXAICliBillingUrl("")).toBe("https://cli-chat-proxy.grok.com/v1/billing");
		expect(getXAICliBillingHeaders({ accessToken: "access-token" })).toEqual({
			Authorization: "Bearer access-token",
			Accept: "application/json",
			"X-XAI-Token-Auth": "xai-grok-cli",
		});
	});

	it("pins SuperGrok billing URLs to https grok.com hosts", () => {
		expect(validateXAIBillingEndpoint("https://cli-chat-proxy.grok.com/v1/billing")).toBe(
			"https://cli-chat-proxy.grok.com/v1/billing",
		);
		expect(() => validateXAIBillingEndpoint("https://auth.x.ai/v1/billing")).toThrow(/Invalid xAI billing_url/);
		expect(() => validateXAIBillingEndpoint("http://cli-chat-proxy.grok.com/v1/billing")).toThrow(
			/Invalid xAI billing_url/,
		);
		expect(() => validateXAIBillingEndpoint("https://evil.com/v1/billing")).toThrow(/Invalid xAI billing_url/);
	});

	it("normalizes OIDC userinfo identity", async () => {
		const requests: RecordedRequest[] = [];
		const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			requests.push({
				url: typeof input === "string" ? input : input instanceof Request ? input.url : input.toString(),
				init,
			});
			return jsonResponse({ sub: "profile-sub", email: "User@Example.com", name: "User" });
		});

		await expect(fetchXAIOAuthIdentity("access-token", fetchMock as unknown as typeof fetch)).resolves.toEqual({
			accountId: "profile-sub",
			email: "user@example.com",
			name: "User",
		});
		expect(requests[0]?.url).toBe(USERINFO_URL);
		expect(new Headers(requests[0]?.init?.headers)).toEqual(
			new Headers({ Authorization: "Bearer access-token", Accept: "application/json" }),
		);
		expect(requests[0]?.init?.redirect).toBe("error");
	});

	it("combines caller cancellation with the 15-second userinfo timeout", async () => {
		const timeoutControllers: AbortController[] = [];
		const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockImplementation(timeoutMs => {
			expect(timeoutMs).toBe(15_000);
			const controller = new AbortController();
			timeoutControllers.push(controller);
			return controller.signal;
		});
		const requests: RecordedRequest[] = [];
		const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			requests.push({
				url: typeof input === "string" ? input : input instanceof Request ? input.url : input.toString(),
				init,
			});
			const { promise, reject } = Promise.withResolvers<Response>();
			const requestSignal = init?.signal;
			if (!requestSignal) {
				reject(new Error("expected userinfo request signal"));
			} else if (requestSignal.aborted) {
				reject(requestSignal.reason);
			} else {
				requestSignal.addEventListener("abort", () => reject(requestSignal.reason), { once: true });
			}
			return promise;
		});

		const callerController = new AbortController();
		const callerCancelled = fetchXAIOAuthIdentity(
			"access-token",
			fetchMock as unknown as typeof fetch,
			callerController.signal,
		);
		callerController.abort();
		await expect(callerCancelled).resolves.toBeNull();
		expect(requests[0]?.init?.signal).not.toBe(callerController.signal);

		expect(timeoutSpy).toHaveBeenCalledWith(15_000);
		const timeoutCancelled = fetchXAIOAuthIdentity(
			"access-token",
			fetchMock as unknown as typeof fetch,
			new AbortController().signal,
		);
		const timeoutController = timeoutControllers[1];
		expect(timeoutController).toBeDefined();
		timeoutController?.abort();
		await expect(timeoutCancelled).resolves.toBeNull();
		expect(requests[1]?.init?.signal).not.toBe(timeoutController?.signal);
	});
});

describe("validateXAIEndpoint", () => {
	it("rejects non-HTTPS URLs", () => {
		expect(() => validateXAIEndpoint("http://x.ai/token", "token_endpoint")).toThrow(/Invalid xAI token_endpoint/);
	});

	it("rejects non-xAI hosts", () => {
		expect(() => validateXAIEndpoint("https://evil.com/token", "token_endpoint")).toThrow(
			/Invalid xAI token_endpoint/,
		);
	});

	it("accepts the x.ai apex and *.x.ai subdomains", () => {
		expect(validateXAIEndpoint("https://x.ai/token", "token_endpoint")).toBe("https://x.ai/token");
		expect(validateXAIEndpoint("https://auth.x.ai/oauth/token", "token_endpoint")).toBe(
			"https://auth.x.ai/oauth/token",
		);
	});
});

describe("refreshXAIOAuthToken", () => {
	it("rejects an empty refresh_token without making a network call", async () => {
		const fetchMock = vi.fn(async () => {
			throw new Error("fetch should not be called when refresh_token is empty");
		});

		await expect(refreshXAIOAuthToken("", fetchMock as unknown as typeof fetch)).rejects.toThrow(
			/missing refresh_token/,
		);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("persists refreshed OAuth identity from OIDC userinfo", async () => {
		const accessToken = jwtWithPayload({ sub: "jwt-sub" });
		const requests: RecordedRequest[] = [];
		const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
			requests.push({ url, init });
			if (url === DISCOVERY_URL) return jsonResponse({ token_endpoint: TOKEN_ENDPOINT });
			if (url === TOKEN_ENDPOINT) {
				return jsonResponse({
					access_token: accessToken,
					expires_in: 3600,
				});
			}
			if (url === USERINFO_URL) return jsonResponse({ sub: "profile-sub", email: "User@Example.com" });
			throw new Error(`Unexpected xAI OAuth request: ${url}`);
		});

		await expect(
			refreshXAIOAuthToken("old-refresh-token", fetchMock as unknown as typeof fetch),
		).resolves.toMatchObject({
			access: accessToken,
			refresh: "old-refresh-token",
			accountId: "profile-sub",
			email: "user@example.com",
		});
		expect(requests.map(request => request.url)).toEqual([DISCOVERY_URL, TOKEN_ENDPOINT, USERINFO_URL]);
		expect(requests.find(request => request.url === TOKEN_ENDPOINT)?.init?.redirect).toBe("error");
	});

	it("binds refresh HTTP requests to the caller abort signal", async () => {
		const accessToken = jwtWithPayload({ sub: "jwt-sub" });
		const controller = new AbortController();
		const requests: RecordedRequest[] = [];
		const fetchMock: FetchImpl = async (input, init) => {
			const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
			requests.push({ url, init });
			if (url === DISCOVERY_URL) return jsonResponse({ token_endpoint: TOKEN_ENDPOINT });
			if (url === TOKEN_ENDPOINT) {
				return jsonResponse({
					access_token: accessToken,
					expires_in: 3600,
				});
			}
			if (url === USERINFO_URL) return jsonResponse({ sub: "profile-sub" });
			throw new Error(`Unexpected xAI OAuth request: ${url}`);
		};

		await refreshXAIOAuthToken("old-refresh-token", fetchMock, controller.signal);
		const refreshSignal = requests.find(request => request.url === TOKEN_ENDPOINT)?.init?.signal;
		expect(refreshSignal?.aborted).toBe(false);

		controller.abort(new Error("refresh ownership ended"));
		expect(refreshSignal?.aborted).toBe(true);
	});
});

describe("loginXAIOAuth", () => {
	it("performs the RFC 8628 device flow and returns the issued credentials", async () => {
		const now = 1_800_000_000_000;
		vi.spyOn(Date, "now").mockReturnValue(now);
		const { fetchMock, requests } = createDeviceFlowFetch([
			{
				body: {
					access_token: "access-token",
					refresh_token: "refresh-token",
					expires_in: 3600,
				},
			},
		]);
		const authEvents: Array<{ url: string; instructions?: string }> = [];
		const progress: string[] = [];
		const onAuth = vi.fn((info: { url: string; instructions?: string }) => {
			authEvents.push(info);
		});
		const onProgress = vi.fn((message: string) => {
			progress.push(message);
		});
		const onManualCodeInput = vi.fn(async () => {
			throw new Error("device authorization must not request a pasted code");
		});

		const credentials = await loginXAIOAuth({
			fetch: fetchMock,
			onAuth,
			onProgress,
			onManualCodeInput,
		});

		expect(requests.map(request => request.url)).toEqual([
			DISCOVERY_URL,
			DEVICE_CODE_URL,
			TOKEN_ENDPOINT,
			USERINFO_URL,
		]);

		const discoveryRequest = requests[0];
		expect(discoveryRequest?.init?.method).toBe("GET");
		expect(new Headers(discoveryRequest?.init?.headers).get("Accept")).toBe("application/json");

		const deviceRequest = requests[1];
		expect(deviceRequest?.init?.method).toBe("POST");
		const deviceHeaders = new Headers(deviceRequest?.init?.headers);
		expect(deviceHeaders.get("Content-Type")).toBe("application/x-www-form-urlencoded");
		expect(deviceHeaders.get("Accept")).toBe("application/json");
		const deviceForm = requestForm(deviceRequest);
		expect([...deviceForm.keys()].sort()).toEqual(["client_id", "scope"]);
		expect(Object.fromEntries(deviceForm)).toEqual({
			client_id: CLIENT_ID,
			scope: SCOPE,
		});

		const tokenRequest = requests[2];
		expect(tokenRequest?.init?.method).toBe("POST");
		const tokenHeaders = new Headers(tokenRequest?.init?.headers);
		expect(tokenHeaders.get("Content-Type")).toBe("application/x-www-form-urlencoded");
		expect(tokenHeaders.get("Accept")).toBe("application/json");
		const tokenForm = requestForm(tokenRequest);
		expect([...tokenForm.keys()].sort()).toEqual(["client_id", "device_code", "grant_type"]);
		expect(Object.fromEntries(tokenForm)).toEqual({
			grant_type: "urn:ietf:params:oauth:grant-type:device_code",
			client_id: CLIENT_ID,
			device_code: DEVICE_AUTHORIZATION.device_code,
		});

		expect(authEvents).toEqual([
			{
				url: DEVICE_AUTHORIZATION.verification_uri_complete,
				instructions: `Enter code: ${DEVICE_AUTHORIZATION.user_code}`,
			},
		]);
		expect(authEvents[0]?.instructions).not.toMatch(/hermes/i);
		expect(onManualCodeInput).not.toHaveBeenCalled();
		expect(progress).toEqual(["Waiting for xAI device authorization..."]);
		expect(credentials).toEqual({
			access: "access-token",
			refresh: "refresh-token",
			expires: now + 3_300_000,
		});
	});

	it("continues through authorization_pending and slow_down responses", async () => {
		const sleepSpy = vi.spyOn(Bun, "sleep").mockResolvedValue(undefined);
		const { fetchMock, requests } = createDeviceFlowFetch([
			{ status: 400, body: { error: "authorization_pending" } },
			{ status: 400, body: { error: "slow_down" } },
			{
				body: {
					access_token: "eventual-access-token",
					refresh_token: "eventual-refresh-token",
					expires_in: 3600,
				},
			},
		]);

		const credentials = await loginXAIOAuth({ fetch: fetchMock });

		const tokenRequests = requests.filter(request => request.url === TOKEN_ENDPOINT);
		expect(tokenRequests).toHaveLength(3);
		expect(tokenRequests.every(request => request.init?.redirect === "error")).toBe(true);
		expect(tokenRequests.map(request => Object.fromEntries(requestForm(request)))).toEqual([
			{
				grant_type: "urn:ietf:params:oauth:grant-type:device_code",
				client_id: CLIENT_ID,
				device_code: DEVICE_AUTHORIZATION.device_code,
			},
			{
				grant_type: "urn:ietf:params:oauth:grant-type:device_code",
				client_id: CLIENT_ID,
				device_code: DEVICE_AUTHORIZATION.device_code,
			},
			{
				grant_type: "urn:ietf:params:oauth:grant-type:device_code",
				client_id: CLIENT_ID,
				device_code: DEVICE_AUTHORIZATION.device_code,
			},
		]);
		expect(sleepSpy.mock.calls).toEqual([[1000], [6000]]);
		expect(credentials.access).toBe("eventual-access-token");
		expect(credentials.refresh).toBe("eventual-refresh-token");
	});

	it("retains the JWT subject and succeeds when OIDC userinfo fails", async () => {
		const accessToken = jwtWithPayload({ sub: "jwt-sub" });
		const controller = new AbortController();
		const { fetchMock, requests } = createDeviceFlowFetch(
			[
				{
					body: {
						access_token: accessToken,
						refresh_token: "refresh-token",
						expires_in: 3600,
					},
				},
			],
			{ body: { error: "userinfo unavailable" }, status: 503 },
		);

		const credentials = await loginXAIOAuth({ fetch: fetchMock, signal: controller.signal });

		expect(credentials).toMatchObject({
			access: accessToken,
			refresh: "refresh-token",
			accountId: "jwt-sub",
		});
		expect(requests.at(-1)?.url).toBe(USERINFO_URL);
		expect(requests.at(-1)?.init?.signal).not.toBe(controller.signal);
	});

	it("keeps the JWT subject when userinfo returns only an email", async () => {
		const accessToken = jwtWithPayload({ sub: "jwt-sub" });
		const { fetchMock } = createDeviceFlowFetch(
			[
				{
					body: {
						access_token: accessToken,
						refresh_token: "refresh-token",
						expires_in: 3600,
					},
				},
			],
			{ body: { email: "User@Example.com" } },
		);

		await expect(loginXAIOAuth({ fetch: fetchMock })).resolves.toMatchObject({
			accountId: "jwt-sub",
			email: "user@example.com",
		});
	});

	it("rejects a token response that omits access_token", async () => {
		const { fetchMock, requests } = createDeviceFlowFetch([
			{
				body: {
					refresh_token: "refresh-token",
					expires_in: 3600,
				},
			},
		]);

		await expect(loginXAIOAuth({ fetch: fetchMock })).rejects.toThrow(
			/xAI device-code token response missing access_token/,
		);
		expect(requests.filter(request => request.url === TOKEN_ENDPOINT)).toHaveLength(1);
	});
});
