import { afterEach, describe, expect, it, vi } from "bun:test";
import { getProviderDefinition } from "@oh-my-pi/pi-ai/registry";
import type { OAuthController } from "@oh-my-pi/pi-ai/registry/oauth/types";
import {
	ANTIGRAVITY_LOAD_CODE_ASSIST_METADATA,
	googleAntigravityProjectHook,
} from "../src/registry/oauth/google-antigravity";

const CLOUD_CODE_ASSIST_ENDPOINT = "https://daily-cloudcode-pa.googleapis.com";
const LOAD_CODE_ASSIST_URL = `${CLOUD_CODE_ASSIST_ENDPOINT}/v1internal:loadCodeAssist`;
const ONBOARD_USER_URL = `${CLOUD_CODE_ASSIST_ENDPOINT}/v1internal:onboardUser`;
const OPERATION_URL = `${CLOUD_CODE_ASSIST_ENDPOINT}/v1internal/operations/onboard-123`;

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

async function discoverAntigravityProject() {
	return googleAntigravityProjectHook(
		{ access: "access-token", refresh: "refresh-token", expires: 0 },
		{
			provider: "google-antigravity",
			phase: "login",
			raw: { refresh_token: "refresh-token" },
			fetch,
		},
	);
}

describe("Antigravity OAuth project discovery", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("loads and refreshes an existing account through the daily endpoint", async () => {
		const payload = {
			currentTier: { id: "free-tier" },
			paidTier: { id: "standard-tier" },
			allowedTiers: [{ id: "free-tier" }],
			cloudaicompanionProject: "project-123",
		};
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockImplementation(Object.assign(async () => jsonResponse(payload), { preconnect: fetch.preconnect }));

		const credentials = await discoverAntigravityProject();

		expect(credentials.projectId).toBe("project-123");
		expect(fetchSpy).toHaveBeenCalledTimes(2);
		for (const [url, init] of fetchSpy.mock.calls) {
			expect(url).toBe(LOAD_CODE_ASSIST_URL);
			expect(init?.method).toBe("POST");
			expect(init?.headers).toEqual({
				Authorization: "Bearer access-token",
				"Content-Type": "application/json",
				"User-Agent": expect.stringMatching(/^antigravity\/hub\//),
				"Accept-Encoding": "gzip",
			});
			expect(JSON.parse(String(init?.body))).toEqual({
				metadata: ANTIGRAVITY_LOAD_CODE_ASSIST_METADATA,
			});
		}
	});

	it("reloads with the returned project when paidTier is absent", async () => {
		const hydrated = {
			currentTier: { id: "free-tier" },
			paidTier: { id: "standard-tier" },
			allowedTiers: [{ id: "free-tier" }],
			cloudaicompanionProject: "project-123",
		};
		const responses = [
			{
				currentTier: { id: "free-tier" },
				allowedTiers: [{ id: "free-tier" }],
				cloudaicompanionProject: "project-123",
			},
			hydrated,
			hydrated,
		];
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
			Object.assign(
				async () => {
					const payload = responses.shift();
					if (!payload) throw new Error("Unexpected Cloud Code Assist request");
					return jsonResponse(payload);
				},
				{ preconnect: fetch.preconnect },
			),
		);

		const credentials = await discoverAntigravityProject();

		expect(credentials.projectId).toBe("project-123");
		expect(fetchSpy).toHaveBeenCalledTimes(3);
		expect(JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body))).toEqual({
			metadata: ANTIGRAVITY_LOAD_CODE_ASSIST_METADATA,
		});
		expect(JSON.parse(String(fetchSpy.mock.calls[1]?.[1]?.body))).toEqual({
			cloudaicompanionProject: "project-123",
			metadata: ANTIGRAVITY_LOAD_CODE_ASSIST_METADATA,
		});
		expect(JSON.parse(String(fetchSpy.mock.calls[2]?.[1]?.body))).toEqual({
			metadata: ANTIGRAVITY_LOAD_CODE_ASSIST_METADATA,
		});
	});

	it("onboards an account once with the native free-tier request", async () => {
		const responses = [
			{ allowedTiers: [{ id: "free-tier" }] },
			{
				name: "operations/onboard-123",
				done: true,
				response: {
					"@type": "type.googleapis.com/google.internal.cloud.code.v1internal.OnboardUserResponse",
					cloudaicompanionProject: "project-123",
				},
			},
			{
				currentTier: { id: "free-tier" },
				paidTier: { id: "standard-tier" },
				cloudaicompanionProject: "project-123",
			},
		];
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
			Object.assign(
				async () => {
					const payload = responses.shift();
					if (!payload) throw new Error("Unexpected Cloud Code Assist request");
					return jsonResponse(payload);
				},
				{ preconnect: fetch.preconnect },
			),
		);

		const credentials = await discoverAntigravityProject();

		expect(credentials.projectId).toBe("project-123");
		expect(fetchSpy).toHaveBeenCalledTimes(3);
		expect(fetchSpy.mock.calls[1]?.[0]).toBe(ONBOARD_USER_URL);
		expect(fetchSpy.mock.calls[1]?.[1]?.method).toBe("POST");
		expect(JSON.parse(String(fetchSpy.mock.calls[1]?.[1]?.body))).toEqual({
			tierId: "free-tier",
			metadata: ANTIGRAVITY_LOAD_CODE_ASSIST_METADATA,
		});
		expect(fetchSpy.mock.calls[2]?.[0]).toBe(LOAD_CODE_ASSIST_URL);
	});

	it("polls a pending onboarding operation with GET after one second", async () => {
		const sleepSpy = vi.spyOn(Bun, "sleep").mockResolvedValue(undefined);
		const responses = [
			{ allowedTiers: [{ id: "free-tier" }] },
			{ name: "operations/onboard-123" },
			{
				name: "operations/onboard-123",
				done: true,
				response: {
					"@type": "type.googleapis.com/google.internal.cloud.code.v1internal.OnboardUserResponse",
					cloudaicompanionProject: "project-123",
				},
			},
			{
				currentTier: { id: "free-tier" },
				paidTier: { id: "standard-tier" },
				cloudaicompanionProject: "project-123",
			},
		];
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
			Object.assign(
				async () => {
					const payload = responses.shift();
					if (!payload) throw new Error("Unexpected Cloud Code Assist request");
					return jsonResponse(payload);
				},
				{ preconnect: fetch.preconnect },
			),
		);

		const credentials = await discoverAntigravityProject();

		expect(credentials.projectId).toBe("project-123");
		expect(sleepSpy).toHaveBeenCalledTimes(1);
		expect(sleepSpy).toHaveBeenCalledWith(1_000);
		expect(fetchSpy).toHaveBeenCalledTimes(4);
		expect(fetchSpy.mock.calls[2]?.[0]).toBe(OPERATION_URL);
		expect(fetchSpy.mock.calls[2]?.[1]?.method).toBe("GET");
		expect(fetchSpy.mock.calls[2]?.[1]?.headers).toEqual({
			Authorization: "Bearer access-token",
			"Content-Type": "application/json",
			"User-Agent": expect.stringMatching(/^antigravity\/hub\//),
			"Accept-Encoding": "gzip",
		});
		expect(fetchSpy.mock.calls[2]?.[1]?.body).toBeUndefined();
		expect(fetchSpy.mock.calls.filter(([url]) => url === ONBOARD_USER_URL)).toHaveLength(1);
	});

	it("surfaces native free-tier ineligibility without onboarding", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			jsonResponse({
				ineligibleTiers: [
					{
						tierId: "free-tier",
						reasonMessage: "This account is not eligible for the free tier.",
						validationUrl: "https://example.test/validate",
					},
				],
			}),
		);

		await expect(discoverAntigravityProject()).rejects.toThrow("This account is not eligible for the free tier.");
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(fetchSpy.mock.calls[0]?.[0]).toBe(LOAD_CODE_ASSIST_URL);
	});

	it("rejects non-200 responses exactly like the native transport", async () => {
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response("created", { status: 201, statusText: "Created" }));

		await expect(discoverAntigravityProject()).rejects.toThrow("loadCodeAssist failed: 201 Created: created");
		expect(fetchSpy).toHaveBeenCalledTimes(1);
	});
});

describe("Antigravity OAuth login", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("registered login sends the native scopes and binds the PKCE verifier to the form token exchange", async () => {
		let tokenForm: URLSearchParams | undefined;
		const stub = Object.assign(
			async (input: string | URL | Request, init?: RequestInit) => {
				const url = String(input instanceof Request ? input.url : input);
				if (url === "https://oauth2.googleapis.com/token") {
					tokenForm = new URLSearchParams(String(init?.body));
					return jsonResponse({ access_token: "access-token", refresh_token: "refresh-token", expires_in: 3600 });
				}
				if (url.startsWith("https://www.googleapis.com/oauth2/v1/userinfo")) {
					return jsonResponse({ email: "user@example.test" });
				}
				if (url === LOAD_CODE_ASSIST_URL) {
					return jsonResponse({
						currentTier: { id: "free-tier" },
						paidTier: { id: "standard-tier" },
						cloudaicompanionProject: "project-123",
					});
				}
				return new Response(`unexpected ${url}`, { status: 500 });
			},
			{ preconnect: fetch.preconnect },
		);
		// Project discovery runs through the shared Google transport on the global fetch.
		vi.spyOn(globalThis, "fetch").mockImplementation(stub);
		let authorize: URL | undefined;
		const ctrl: OAuthController = {
			onAuth: info => {
				authorize = new URL(info.url);
			},
			onManualCodeInput: async () => {
				const callback = new URL(authorize!.searchParams.get("redirect_uri")!);
				callback.searchParams.set("code", "auth-code");
				callback.searchParams.set("state", authorize!.searchParams.get("state")!);
				return callback.href;
			},
			fetch: stub,
			signal: AbortSignal.timeout(5_000),
		};

		const credentials = await getProviderDefinition("google-antigravity")!.login!(ctrl);
		if (typeof credentials === "string") throw new Error("Expected OAuth credentials");

		const params = authorize!.searchParams;
		expect(params.get("response_type")).toBe("code");
		expect(params.get("access_type")).toBe("offline");
		expect(params.get("prompt")).toBe("consent");
		expect(params.get("code_challenge_method")).toBe("S256");
		expect(params.get("scope")?.split(" ")).toEqual([
			"https://www.googleapis.com/auth/cloud-platform",
			"https://www.googleapis.com/auth/userinfo.email",
			"https://www.googleapis.com/auth/userinfo.profile",
			"https://www.googleapis.com/auth/cclog",
			"https://www.googleapis.com/auth/experimentsandconfigs",
			"https://www.googleapis.com/auth/aicode",
		]);
		expect(tokenForm?.get("grant_type")).toBe("authorization_code");
		expect(tokenForm?.get("code")).toBe("auth-code");
		expect(tokenForm?.get("client_id")).toBe(params.get("client_id"));
		expect(tokenForm?.get("client_secret")).toBeTruthy();
		expect(tokenForm?.get("redirect_uri")).toBe(params.get("redirect_uri"));
		expect(Bun.SHA256.hash(tokenForm!.get("code_verifier")!, "base64url")).toBe(params.get("code_challenge")!);
		expect(credentials).toMatchObject({ access: "access-token", refresh: "refresh-token", projectId: "project-123" });
	});
});
