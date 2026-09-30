import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
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
		{ access: "access-token", refresh: "refresh-token", expires: 0, email: "user@example.com" },
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

	it("rejects a login when userinfo did not identify the account", async () => {
		await expect(
			googleAntigravityProjectHook(
				{ access: "access-token", refresh: "refresh-token", expires: 0 },
				{
					provider: "google-antigravity",
					phase: "login",
					raw: { refresh_token: "refresh-token" },
					fetch,
				},
			),
		).rejects.toThrow("Could not identify the Antigravity account");
	});
	it("does not merge unrelated unidentified grants sharing a project", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-antigravity-identity-"));
		const store = await SqliteAuthCredentialStore.open(path.join(dir, "agent.db"));
		try {
			await store.upsertAuthCredential("google-antigravity", {
				type: "oauth",
				access: "first-grant",
				refresh: "first-refresh",
				expires: Date.now() + 60_000,
				projectId: "aicode-consumers",
			});
			const rows = await store.upsertAuthCredential("google-antigravity", {
				type: "oauth",
				access: "second-grant",
				refresh: "second-refresh",
				expires: Date.now() + 60_000,
				projectId: "aicode-consumers",
			});
			expect(rows.map(row => row.id)).toEqual([1, 2]);
			expect(rows.map(row => row.credential.type === "oauth" && row.credential.access)).toEqual([
				"first-grant",
				"second-grant",
			]);
		} finally {
			store.close();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("claims only the legacy project row belonging to the re-logged Google account", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-antigravity-legacy-"));
		const store = await SqliteAuthCredentialStore.open(path.join(dir, "agent.db"));
		try {
			for (const access of ["legacy-a", "legacy-b"]) {
				await store.upsertAuthCredential("google-antigravity", {
					type: "oauth",
					access,
					refresh: access,
					expires: Date.now() + 60_000,
					projectId: "aicode-consumers",
				});
			}
			const auth = new AuthStorage(store);
			await auth.reload();
			vi.spyOn(globalThis, "fetch").mockImplementation(
				Object.assign(
					async () =>
						jsonResponse({
							currentTier: { id: "free-tier" },
							paidTier: { id: "standard-tier" },
							cloudaicompanionProject: "aicode-consumers",
						}),
					{ preconnect: fetch.preconnect },
				),
			);
			let authUrl = "";
			await auth.oauth.login("google-antigravity", {
				onAuth: info => {
					authUrl = info.url;
				},
				onPrompt: async () => "",
				onManualCodeInput: async () => `callback-code#${new URL(authUrl).searchParams.get("state")}`,
				fetch: async (url, init) => {
					if (String(url).includes("/userinfo")) {
						const token = new Headers(init?.headers).get("authorization");
						return jsonResponse({
							email: token === "Bearer legacy-b" ? "other@example.com" : "same@example.com",
						});
					}
					return jsonResponse({ access_token: "new-grant", refresh_token: "new-refresh", expires_in: 3600 });
				},
			});
			const rows = store.listAuthCredentials("google-antigravity");
			expect(rows.map(row => row.id)).toEqual([1, 2]);
			expect(rows.map(row => row.credential.type === "oauth" && row.credential.access)).toEqual([
				"new-grant",
				"legacy-b",
			]);
		} finally {
			store.close();
			await fs.rm(dir, { recursive: true, force: true });
		}
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
