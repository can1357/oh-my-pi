import { describe, expect, it, spyOn } from "bun:test";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import * as AIError from "@oh-my-pi/pi-ai/error";
import * as oauthUtils from "@oh-my-pi/pi-ai/registry/oauth";
import { getOAuthApiKey } from "@oh-my-pi/pi-ai/registry/oauth";
import {
	KIRO_AUTH_MAX_ATTEMPTS,
	KIRO_IDENTITY_CENTER_SCOPES,
	KIRO_LOGIN_METHOD_PROMPT,
	loginKiroDevice,
	loginKiroHook,
	refreshKiroHook,
	refreshKiroToken,
	selectKiroProfile,
	validateKiroApiKey,
} from "@oh-my-pi/pi-ai/registry/oauth/kiro";
import type {
	OAuthAuthInfo,
	OAuthController,
	OAuthCredentials,
	OAuthPrompt,
} from "@oh-my-pi/pi-ai/registry/oauth/types";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";

const PROFILE_ONE = "arn:aws:codewhisperer:us-east-1:123456789012:profile/one";
const PROFILE_TWO = "arn:aws:codewhisperer:us-east-1:123456789012:profile/two";

function json(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function modelCatalog(): Record<string, unknown> {
	return {
		defaultModel: "model-one",
		models: [
			{
				modelId: "model-one",
				modelName: "Model One",
				supportedInputTypes: ["TEXT"],
				tokenLimits: { maxInputTokens: 1000, maxOutputTokens: 500 },
			},
		],
	};
}

function registeredClient(
	region = "us-east-1",
	tokenEndpoint: unknown = `https://oidc.${region}.amazonaws.com/token`,
	includeTokenEndpoint = true,
): Record<string, unknown> {
	return {
		clientId: "client-id",
		clientSecret: "client-secret",
		clientSecretExpiresAt: 4_000_000_000,
		...(includeTokenEndpoint ? { tokenEndpoint } : {}),
	};
}

function deviceAuthorization(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		deviceCode: "device-code",
		userCode: "ABCD-EFGH",
		verificationUri: "https://device.sso.aws.dev/verify",
		verificationUriComplete: "https://device.sso.aws.dev/complete",
		expiresIn: 60,
		interval: 1,
		...overrides,
	};
}

function profileResponses(): Response[] {
	return [json({ profiles: [{ arn: PROFILE_TWO, profileName: "Work" }] }), json({ profiles: [] })];
}

function kiroClientCredentials(overrides: Partial<OAuthCredentials> = {}): OAuthCredentials {
	return {
		access: "old-access",
		refresh: "refresh-token",
		expires: 0,
		kiroClientId: "client-id",
		kiroClientSecret: "client-secret",
		kiroClientSecretExpiresAt: Date.now() + 60_000,
		kiroTokenEndpoint: "https://oidc.us-east-1.amazonaws.com/token",
		...overrides,
	};
}

describe("Kiro authentication", () => {
	it("normalizes and validates an API key against an explicit region", async () => {
		const requests: Array<{ url: string; init?: RequestInit }> = [];
		const fetch: FetchImpl = async (input, init) => {
			requests.push({ url: String(input), init });
			return json(modelCatalog());
		};

		const result = await validateKiroApiKey("  'ksk_test-key/with+symbols' \n", {
			apiRegion: "us-east-1",
			fetch,
		});

		expect(result).toEqual({
			type: "api_key",
			key: "ksk_test-key/with+symbols",
			apiEndpoint: "https://runtime.us-east-1.kiro.dev/",
		});
		expect(requests).toHaveLength(1);
		expect(requests[0]?.url).toBe("https://management.us-east-1.kiro.dev/");
		expect(new Headers(requests[0]?.init?.headers).get("x-amz-target")).toBe(
			"AmazonCodeWhispererService.ListAvailableModels",
		);
	});

	it("rejects malformed API keys before making a network request", async () => {
		let called = false;
		await expect(
			validateKiroApiKey("not-a-kiro-key", {
				apiRegion: "us-east-1",
				fetch: async () => {
					called = true;
					return json(modelCatalog());
				},
			}),
		).rejects.toMatchObject({ kind: "validation" });
		expect(called).toBe(false);
	});

	it("rejects an invalid KIRO_API_REGION pin before making a network request", async () => {
		let called = false;
		await expect(
			validateKiroApiKey("ksk_valid-key", {
				apiRegion: "not-a-region",
				fetch: async () => {
					called = true;
					return json(modelCatalog());
				},
			}),
		).rejects.toMatchObject({ kind: "configuration" });
		expect(called).toBe(false);
	});

	it("resolves an API-key route via bootstrap probe when no region is pinned", async () => {
		const requests: string[] = [];
		const fetch: FetchImpl = async input => {
			const url = String(input);
			requests.push(url);
			if (url === "https://management.us-east-1.kiro.dev/") return json(modelCatalog());
			return json({ error: "no such key" }, 500);
		};

		const result = await validateKiroApiKey("ksk_probe-key", { fetch });

		expect(result).toEqual({
			type: "api_key",
			key: "ksk_probe-key",
			apiEndpoint: "https://runtime.us-east-1.kiro.dev/",
		});
		expect(requests).toContain("https://management.us-east-1.kiro.dev/");
		expect(requests).toContain("https://management.eu-central-1.kiro.dev/");
	});

	it("signs in with Builder ID without prompting for a Start URL, region, or profile", async () => {
		// Builder ID is the same device grant as IAM Identity Center, pinned to the
		// public Builder start URL and us-east-1. It has no organization, so there
		// is no profile to select and the credential carries no profile ARN.
		const requests: string[] = [];
		const bodies: string[] = [];
		const prompts: OAuthPrompt[] = [];
		const responses: Response[] = [
			json(registeredClient("us-east-1", undefined, false)),
			json(deviceAuthorization()),
			json({ accessToken: "builder-access", refreshToken: "builder-refresh", expiresIn: 3600 }),
		];

		const result = await loginKiroHook({
			onAuth: () => {},
			onPrompt: async (prompt: OAuthPrompt) => {
				prompts.push(prompt);
				// Builder ID fixes the Start URL, region, and profile, so the method
				// picker is the only prompt allowed.
				if (!prompt.message.includes("Select Kiro login method")) {
					throw new Error(`Builder ID must not prompt: ${prompt.message}`);
				}
				return "2";
			},
			fetch: async (input: Request | URL | string, init?: RequestInit) => {
				requests.push(String(input));
				if (init?.body) bodies.push(String(init.body));
				return responses.shift() ?? json({}, 500);
			},
		});

		// Only the method picker may prompt: the Start URL, region, and profile
		// selection are all fixed for Builder ID.
		expect(prompts).toHaveLength(1);
		expect(prompts[0]?.message).toBe(KIRO_LOGIN_METHOD_PROMPT);
		expect(requests[0]).toBe("https://oidc.us-east-1.amazonaws.com/client/register");
		expect(bodies[1]).toContain('"startUrl":"https://view.awsapps.com/start"');

		const credentials = result as OAuthCredentials;
		expect(credentials.access).toBe("builder-access");
		expect(credentials.kiroOidcRegion).toBe("us-east-1");
		expect(credentials.apiEndpoint).toBe("https://runtime.us-east-1.kiro.dev/");
		// The refresh path needs the whole registration state, and Builder ID
		// stores it without a profile ARN.
		expect(credentials).toMatchObject({
			kiroClientId: "client-id",
			kiroClientSecret: "client-secret",
			kiroTokenEndpoint: "https://oidc.us-east-1.amazonaws.com/token",
		});
		// Registration reports seconds; the credential stores milliseconds.
		expect(credentials.kiroClientSecretExpiresAt).toBe(4_000_000_000_000);
		expect(credentials.orgId).toBeUndefined();
	});

	it("does not silently choose AWS when the login-method answer is empty", async () => {
		await expect(
			loginKiroHook({
				onAuth: () => {},
				onPrompt: async () => "",
			}),
		).rejects.toBeInstanceOf(AIError.OnPromptRequiredError);
	});

	it("names the sign-in methods by account type and accepts each label", async () => {
		// "AWS" was ambiguous because Builder ID is also AWS, so the menu names the
		// account type instead. Each label must be typeable, not just numbered.
		expect(KIRO_LOGIN_METHOD_PROMPT).toContain("Identity Center");
		expect(KIRO_LOGIN_METHOD_PROMPT).toContain("Builder ID");
		expect(KIRO_LOGIN_METHOD_PROMPT).toContain("API key");
		// AWS may appear in the description, but must not stand alone as a label.
		expect(KIRO_LOGIN_METHOD_PROMPT).not.toMatch(/^\d+\. AWS$/m);

		// Typing the label must route to the same branch as typing its number:
		// Builder ID runs the device flow against the Builder portal.
		const deviceBodies: string[] = [];
		const responses: Response[] = [
			json(registeredClient("us-east-1", undefined, false)),
			json(deviceAuthorization()),
			json({ accessToken: "builder-access", refreshToken: "builder-refresh", expiresIn: 3600 }),
		];
		const credentials = (await loginKiroHook({
			onAuth: () => {},
			onPrompt: async (prompt: OAuthPrompt) => {
				if (prompt.message.includes("Select Kiro login method")) return "builder id";
				throw new Error(`unexpected prompt: ${prompt.message}`);
			},
			fetch: async (input: Request | URL | string, init?: RequestInit) => {
				if (String(input).endsWith("/device_authorization") && init?.body) deviceBodies.push(String(init.body));
				return responses.shift() ?? json({}, 500);
			},
		})) as OAuthCredentials;

		expect(deviceBodies[0]).toContain('"startUrl":"https://view.awsapps.com/start"');
		expect(credentials.kiroOidcRegion).toBe("us-east-1");
	});

	it("routes API selection to the existing API-key validation path", async () => {
		const prompts: OAuthPrompt[] = [];
		let called = false;
		let calls = 0;
		await expect(
			loginKiroHook({
				onAuth: () => {},
				onPrompt: async (prompt: OAuthPrompt) => {
					prompts.push(prompt);
					calls += 1;
					return calls === 1 ? "3" : "not-a-key";
				},
				fetch: async () => {
					called = true;
					return json(modelCatalog());
				},
			}),
		).rejects.toMatchObject({ kind: "validation" });
		expect(prompts[0]?.message).toContain("Select Kiro login method");
		expect(prompts).toContainEqual(expect.objectContaining({ message: "Paste your Kiro API key" }));
		expect(called).toBe(false);
	});

	it("requests masked entry for the Kiro API key so hosts can hide input", async () => {
		const prompts: OAuthPrompt[] = [];
		let calls = 0;
		await expect(
			loginKiroHook({
				onAuth: () => {},
				onPrompt: async (prompt: OAuthPrompt) => {
					prompts.push(prompt);
					calls += 1;
					return calls === 1 ? "3" : "not-a-key";
				},
				fetch: async () => json(modelCatalog()),
			}),
		).rejects.toMatchObject({ kind: "validation" });

		const apiKeyPrompt = prompts.find(prompt => prompt.message === "Paste your Kiro API key");
		expect(apiKeyPrompt?.secret).toBe(true);
	});

	it("rejects an invalid Start URL before registering a client", async () => {
		let called = false;
		await expect(
			loginKiroDevice(
				{
					onAuth: () => {},
					onPrompt: async () => "",
					fetch: async () => {
						called = true;
						return json(registeredClient());
					},
				},
				{ region: "us-east-1", startUrl: "https://example.com/not-start" },
			),
		).rejects.toMatchObject({ kind: "validation" });
		expect(called).toBe(false);
	});

	it("rejects an invalid Identity Center region before registering a client", async () => {
		let called = false;
		await expect(
			loginKiroDevice(
				{
					onAuth: () => {},
					onPrompt: async () => "",
					fetch: async () => {
						called = true;
						return json(registeredClient());
					},
				},
				{ region: "not-a-region", startUrl: "https://example.awsapps.com/start" },
			),
		).rejects.toMatchObject({ kind: "validation" });
		expect(called).toBe(false);
	});

	it("prompts for IAM Identity Center values and uses exact registration scopes", async () => {
		const prompts: OAuthPrompt[] = [];
		const authEvents: OAuthAuthInfo[] = [];
		const progress: string[] = [];
		const requests: Array<{ url: string; init?: RequestInit }> = [];
		const responses: Response[] = [
			json(registeredClient("eu-west-1")),
			json(deviceAuthorization()),
			json({ accessToken: "access-token", refreshToken: "refresh-token", expiresIn: 3600 }),
			...profileResponses(),
		];
		const fetch: FetchImpl = async (input, init) => {
			requests.push({ url: String(input), init });
			return responses.shift() ?? json({ error: "unexpected request" }, 500);
		};

		const loggedIn = await loginKiroDevice(
			{
				onAuth: (info: OAuthAuthInfo) => authEvents.push(info),
				onProgress: (message: string) => progress.push(message),
				onPrompt: async (prompt: OAuthPrompt) => {
					prompts.push(prompt);
					return prompt.message === "Enter Start URL" ? "https://example.awsapps.com/start" : "eu-west-1";
				},
				fetch,
			},
			{},
		);

		expect(prompts.map(prompt => prompt.message)).toEqual(["Enter Start URL", "Enter Region"]);
		const registrationBody = JSON.parse(String(requests[0]?.init?.body)) as Record<string, unknown>;
		expect(registrationBody).toEqual({
			clientName: "Kiro CLI",
			clientType: "public",
			scopes: [...KIRO_IDENTITY_CENTER_SCOPES],
		});
		expect(Object.keys(registrationBody).sort()).toEqual(["clientName", "clientType", "scopes"]);
		expect(requests[0]?.url).toBe("https://oidc.eu-west-1.amazonaws.com/client/register");
		const deviceBody = JSON.parse(String(requests[1]?.init?.body)) as Record<string, unknown>;
		expect(deviceBody).toEqual({
			clientId: "client-id",
			clientSecret: "client-secret",
			startUrl: "https://example.awsapps.com/start",
		});
		expect(authEvents).toHaveLength(1);
		expect(authEvents[0]).toMatchObject({
			url: "https://device.sso.aws.dev/complete",
			instructions: "Confirm code ABCD-EFGH in the browser",
		});
		expect(progress).toEqual(["Waiting for device authorization..."]);
		expect(loggedIn).toMatchObject({
			access: "access-token",
			refresh: "refresh-token",
			kiroClientId: "client-id",
			kiroClientSecret: "client-secret",
			kiroTokenEndpoint: "https://oidc.eu-west-1.amazonaws.com/token",
			kiroOidcRegion: "eu-west-1",
			apiEndpoint: "https://runtime.us-east-1.kiro.dev/",
			orgId: PROFILE_TWO,
			orgName: "Work",
		});
		expect(loggedIn.expires).toBeGreaterThan(Date.now());
	});

	it("registers fresh on every login instead of reusing cached state", async () => {
		// The declarative registry has no OAuthLoginCache: each device login
		// performs a fresh OIDC client registration. Two consecutive logins
		// must both hit /client/register.
		const runLogin = async (): Promise<OAuthCredentials> => {
			const responses: Response[] = [
				json(registeredClient()),
				json(deviceAuthorization()),
				json({ accessToken: "access-token", refreshToken: "refresh-token", expiresIn: 3600 }),
				...profileResponses(),
			];
			const requests: string[] = [];
			const fetch: FetchImpl = async input => {
				requests.push(String(input));
				return responses.shift() ?? json({ error: "unexpected request" }, 500);
			};
			const loggedIn = await loginKiroDevice(
				{
					onAuth: () => {},
					fetch,
				},
				{ region: "us-east-1", startUrl: "https://example.awsapps.com/start" },
			);
			expect(requests).toContain("https://oidc.us-east-1.amazonaws.com/client/register");
			return loggedIn;
		};

		const first = await runLogin();
		const second = await runLogin();
		expect(first.kiroClientId).toBe("client-id");
		expect(second.kiroClientId).toBe("client-id");
	});

	it("uses the canonical regional token endpoint when fresh registration omits it", async () => {
		const canonical = "https://oidc.eu-west-1.amazonaws.com/token";
		const requests: string[] = [];
		const responses: Response[] = [
			json(registeredClient("eu-west-1", undefined, false)),
			json(deviceAuthorization()),
			json({ accessToken: "access-token", refreshToken: "refresh-token", expiresIn: 3600 }),
			...profileResponses(),
		];
		const fetch: FetchImpl = async input => {
			requests.push(String(input));
			return responses.shift() ?? json({ error: "unexpected request" }, 500);
		};

		const loggedIn = await loginKiroDevice(
			{
				onAuth: () => {},
				fetch,
			},
			{ region: "eu-west-1", startUrl: "https://example.awsapps.com/start" },
		);

		expect(loggedIn.kiroTokenEndpoint).toBe(canonical);
		expect(requests.filter(url => url === canonical)).toHaveLength(1);

		let refreshUrl = "";
		const refreshed = await refreshKiroToken(
			{ ...loggedIn, expires: 0 },
			{
				fetch: async input => {
					refreshUrl = String(input);
					return json({ accessToken: "refreshed-access", expiresIn: 3600 });
				},
			},
		);
		expect(refreshUrl).toBe(canonical);
		expect(refreshed.kiroTokenEndpoint).toBe(canonical);
	});

	it("uses the canonical regional token endpoint when fresh registration returns null", async () => {
		const canonical = "https://oidc.eu-west-1.amazonaws.com/token";
		const requests: string[] = [];
		const responses: Response[] = [
			json(registeredClient("eu-west-1", null)),
			json(deviceAuthorization()),
			json({ accessToken: "access-token", refreshToken: "refresh-token", expiresIn: 3600 }),
			...profileResponses(),
		];
		const fetch: FetchImpl = async input => {
			requests.push(String(input));
			return responses.shift() ?? json({ error: "unexpected request" }, 500);
		};

		const loggedIn = await loginKiroDevice(
			{
				onAuth: () => {},
				fetch,
			},
			{ region: "eu-west-1", startUrl: "https://example.awsapps.com/start" },
		);

		expect(loggedIn.kiroTokenEndpoint).toBe(canonical);
		expect(requests.filter(url => url === canonical)).toHaveLength(1);
	});

	// NOTE: cached-registration repair cases (omitted/null/invalid tokenEndpoint
	// in OAuthLoginCache, 59s/61s expiry margin) have no equivalent: the new
	// hook API performs a fresh registration per login and validates the
	// endpoint at registration time. Fresh-registration canonical cases above
	// and the invalid-endpoint rejection below cover the remaining contract.

	it("rejects present invalid registration endpoints instead of treating them as omitted", async () => {
		const invalidEndpoints: unknown[] = [
			"",
			"not-a-url",
			"https://oidc.us-west-2.amazonaws.com/token",
			"https://example.com/token",
			"https://oidc.us-east-1.amazonaws.com/authorize",
			"https://oidc.us-east-1.amazonaws.com:443/token",
			"https://user:pass@oidc.us-east-1.amazonaws.com/token",
			"https://oidc.us-east-1.amazonaws.com/token?query=1",
			"https://oidc.us-east-1.amazonaws.com/token#fragment",
		];

		for (const tokenEndpoint of invalidEndpoints) {
			await expect(
				loginKiroDevice(
					{
						onAuth: () => {},
						fetch: async input => {
							if (String(input).endsWith("/client/register")) {
								return json(registeredClient("us-east-1", tokenEndpoint));
							}
							return json({}, 500);
						},
					},
					{ region: "us-east-1", startUrl: "https://example.awsapps.com/start" },
				),
			).rejects.toMatchObject({ kind: "validation" });
		}
	});

	it("persists the resolved endpoint in the stored OAuth credential", async () => {
		const store = await SqliteAuthCredentialStore.open(":memory:");
		const authStorage = new AuthStorage(store);
		const responses: Response[] = [
			json(registeredClient("us-east-1", undefined, false)),
			json(deviceAuthorization()),
			json({ accessToken: "access-token", refreshToken: "refresh-token", expiresIn: 3600 }),
			...profileResponses(),
		];
		try {
			const identity = await authStorage.oauth.login("kiro", {
				onAuth: () => {},
				onPrompt: async (prompt: OAuthPrompt) => {
					if (prompt.message.includes("Select Kiro login method")) return "1";
					return prompt.message === "Enter Start URL" ? "https://example.awsapps.com/start" : "us-east-1";
				},
				fetch: async () => responses.shift() ?? json({}, 500),
			});

			expect(identity?.type).toBe("oauth");
			expect(identity?.orgId).toBe(PROFILE_TWO);
			const stored = store.listAuthCredentials("kiro");
			expect(stored).toHaveLength(1);
			expect(stored[0]?.credential).toMatchObject({
				type: "oauth",
				kiroTokenEndpoint: "https://oidc.us-east-1.amazonaws.com/token",
				kiroClientId: "client-id",
				orgId: PROFILE_TWO,
			});
		} finally {
			authStorage.close();
		}
	});

	it("keeps the OIDC client secret out of a forced-refresh response", async () => {
		const store = await SqliteAuthCredentialStore.open(":memory:");
		const authStorage = new AuthStorage(store);
		const loginResponses: Response[] = [
			json(registeredClient("us-east-1", undefined, false)),
			json(deviceAuthorization()),
			json({ accessToken: "access-token", refreshToken: "refresh-token", expiresIn: 3600 }),
			...profileResponses(),
		];
		const refreshSpy = spyOn(oauthUtils, "refreshOAuthToken").mockImplementation(
			async (_provider: string, credential: OAuthCredentials) => ({
				...credential,
				access: "next-access",
				expires: Date.now() + 3_600_000,
			}),
		);
		try {
			await authStorage.oauth.login("kiro", {
				onAuth: () => {},
				onPrompt: async (prompt: OAuthPrompt) => {
					if (prompt.message.includes("Select Kiro login method")) return "1";
					return prompt.message === "Enter Start URL" ? "https://example.awsapps.com/start" : "us-east-1";
				},
				fetch: async () => loginResponses.shift() ?? json({}, 500),
			});
			const id = store.listAuthCredentials("kiro")[0]?.id;
			if (id === undefined) throw new Error("expected a stored kiro credential");

			// The broker serves this entry verbatim over POST /v1/credential/:id/refresh,
			// so the refresh-capable client secret must not be part of it.
			const entry = await authStorage.oauth.refresh(id);
			expect(refreshSpy).toHaveBeenCalled();
			expect(entry.credential.type).toBe("oauth");
			expect(entry.credential).not.toHaveProperty("kiroClientSecret");
			expect(entry.credential).toMatchObject({ kiroClientId: "client-id" });
		} finally {
			refreshSpy.mockRestore();
			authStorage.close();
		}
	});

	it("refreshes a Builder ID credential that has no profile ARN", async () => {
		// Builder ID stores no orgId, so refresh must not depend on parsing a profile
		// ARN; the region check runs off kiroOidcRegion instead.
		const store = await SqliteAuthCredentialStore.open(":memory:");
		const authStorage = new AuthStorage(store);
		const responses: Response[] = [
			json(registeredClient("us-east-1", undefined, false)),
			json(deviceAuthorization()),
			json({ accessToken: "builder-access", refreshToken: "builder-refresh", expiresIn: 3600 }),
		];
		const refreshSpy = spyOn(oauthUtils, "refreshOAuthToken").mockImplementation(
			async (_provider: string, credential: OAuthCredentials) => ({
				...credential,
				access: "builder-access-2",
				expires: Date.now() + 3_600_000,
			}),
		);
		try {
			await authStorage.oauth.login("kiro", {
				onAuth: () => {},
				onPrompt: async (prompt: OAuthPrompt) => {
					if (prompt.message.includes("Select Kiro login method")) return "2";
					throw new Error(`Builder ID must not prompt: ${prompt.message}`);
				},
				fetch: async () => responses.shift() ?? json({}, 500),
			});
			const id = store.listAuthCredentials("kiro")[0]?.id;
			if (id === undefined) throw new Error("expected a stored kiro credential");

			const entry = await authStorage.oauth.refresh(id);
			expect(refreshSpy).toHaveBeenCalled();
			expect(entry.credential).toMatchObject({
				access: "builder-access-2",
				kiroClientId: "client-id",
				kiroOidcRegion: "us-east-1",
			});
			expect((entry.credential as OAuthCredentials).orgId).toBeUndefined();
		} finally {
			refreshSpy.mockRestore();
			authStorage.close();
		}
	});

	it("labels the login with a profile name or ARN-safe segment, never the raw ARN", async () => {
		// A named profile labels itself; a nameless one must fall back to the
		// ARN's trailing segment, never the ARN (which embeds the account id).
		for (const [profile, expectedLabel] of [
			[{ arn: PROFILE_TWO, profileName: "Work" }, "Work"],
			[{ arn: PROFILE_TWO }, "two"],
		] as const) {
			const store = await SqliteAuthCredentialStore.open(":memory:");
			const authStorage = new AuthStorage(store);
			const responses: Response[] = [
				json(registeredClient("us-east-1", undefined, false)),
				json(deviceAuthorization()),
				json({ accessToken: "access-token", refreshToken: "refresh-token", expiresIn: 3600 }),
				json({ profiles: [profile] }),
				json({ profiles: [] }),
			];
			try {
				const identity = await authStorage.oauth.login("kiro", {
					onAuth: () => {},
					onPrompt: async (prompt: OAuthPrompt) => {
						if (prompt.message.includes("Select Kiro login method")) return "1";
						return prompt.message === "Enter Start URL" ? "https://example.awsapps.com/start" : "us-east-1";
					},
					fetch: async () => responses.shift() ?? json({}, 500),
				});

				// Consumers render `orgName` as the account label, so it must be a
				// real display label — not undefined, and never the raw ARN.
				expect(identity?.orgName).toBe(expectedLabel);
				expect(identity?.orgId).toBe(PROFILE_TWO);
			} finally {
				authStorage.close();
			}
		}
	});

	it("persists the resolved endpoint on a stored Kiro API key", async () => {
		const endpoint = "https://runtime.eu-central-1.kiro.dev/";
		const store = await SqliteAuthCredentialStore.open(":memory:");
		const authStorage = new AuthStorage(store);
		try {
			await authStorage.credentials.set("kiro", { type: "api_key", key: "ksk_persisted", apiEndpoint: endpoint });
			await authStorage.credentials.reload();

			// The endpoint is part of the credential's identity: it selects the Kiro
			// model-cache namespace, so losing it across a reload would restore the
			// wrong cache after a restart.
			const stored = store.listAuthCredentials("kiro")[0]?.credential;
			expect(stored).toMatchObject({ type: "api_key", key: "ksk_persisted", apiEndpoint: endpoint });
			expect(await authStorage.keys.peek("kiro")).toBe(
				JSON.stringify({ token: "ksk_persisted", apiEndpoint: endpoint }),
			);
		} finally {
			authStorage.close();
		}
	});

	it("keeps the raw profile ARN out of a credential-disabled event", async () => {
		// A parseable ARN is reduced to its profile segment; an unparseable one
		// (API-key logins, `credentials.set`, older rows never validated it) is
		// dropped rather than echoed, since a malformed ARN is the case that
		// most needs to stay out of the log.
		const cases: { orgId: string; expected: string | undefined }[] = [
			{ orgId: PROFILE_TWO, expected: "two" },
			{ orgId: "arn:aws:sso:us-east-1:123456789012:profile/two", expected: undefined },
		];
		for (const { orgId, expected } of cases) {
			const store = await SqliteAuthCredentialStore.open(":memory:");
			const authStorage = new AuthStorage(store);
			try {
				await authStorage.credentials.set("kiro", {
					type: "oauth",
					access: "access-token",
					refresh: "refresh-token",
					expires: Date.now() + 60_000,
					orgId,
					orgName: "Work",
				});
				const events: { orgId?: string; orgName?: string }[] = [];
				authStorage.credentials.onDisabled(event => {
					events.push(event);
				});
				const id = store.listAuthCredentials("kiro")[0]?.id;
				if (id === undefined) throw new Error("expected a stored kiro credential");

				await authStorage.credentials.disable(id, "test: forced");

				expect(events).toHaveLength(1);
				expect(events[0]?.orgName).toBe("Work");
				expect(events[0]?.orgId).toBe(expected);
				expect(JSON.stringify(events[0])).not.toContain("123456789012");
			} finally {
				authStorage.close();
			}
		}
	});

	it("limits registration, device authorization, and polling transport retries to three attempts", async () => {
		expect(KIRO_AUTH_MAX_ATTEMPTS).toBe(3);
		const run = async (failureTarget: "registration" | "device" | "poll"): Promise<void> => {
			const counts = { registration: 0, device: 0, poll: 0 };
			const profiles = profileResponses();
			const ctrl: OAuthController = {
				onAuth: () => {},
				fetch: async input => {
					const url = String(input);
					if (url.endsWith("/client/register")) {
						counts.registration += 1;
						if (failureTarget === "registration" && counts.registration < 3) return json({}, 503);
						return json(registeredClient());
					}
					if (url.endsWith("/device_authorization")) {
						counts.device += 1;
						if (failureTarget === "device" && counts.device < 3) return json({}, 503);
						return json(deviceAuthorization());
					}
					if (url.endsWith("/token")) {
						counts.poll += 1;
						if (failureTarget === "poll" && counts.poll < 3) throw new Error("temporary network failure");
						return json({ accessToken: "access-token", refreshToken: "refresh-token", expiresIn: 3600 });
					}
					return profiles.shift() ?? json({ profiles: [] });
				},
			};
			await loginKiroDevice(ctrl, { region: "us-east-1", startUrl: "https://example.awsapps.com/start" });
			expect(counts[failureTarget]).toBe(3);
		};

		await run("registration");
		await run("device");
		await run("poll");
	});

	it("continues polling after RFC 8628 pending and slow_down responses", async () => {
		const sleepSpy = spyOn(Bun, "sleep").mockImplementation((() => Promise.resolve()) as typeof Bun.sleep);
		try {
			const responses: Response[] = [
				json(registeredClient()),
				json(deviceAuthorization()),
				json({ error: "authorization_pending" }, 400),
				json({ error: "slow_down" }, 400),
				json({ accessToken: "access-token", refreshToken: "refresh-token", expiresIn: 3600 }),
				...profileResponses(),
			];
			const requests: string[] = [];
			const result = await loginKiroDevice(
				{
					onAuth: () => {},
					fetch: async input => {
						requests.push(String(input));
						return responses.shift() ?? json({ error: "unexpected request" }, 500);
					},
				},
				{ region: "us-east-1", startUrl: "https://example.awsapps.com/start" },
			);

			expect(requests.filter(url => url.endsWith("/token"))).toHaveLength(3);
			expect(result.orgId).toBe(PROFILE_TWO);
		} finally {
			sleepSpy.mockRestore();
		}
	});

	it("prompts for a selected profile without exposing its ARN or account id", async () => {
		let prompt: OAuthPrompt | undefined;
		const selected = await selectKiroProfile("access-token", "us-east-1", {
			fetch: async () =>
				json({
					profiles: [
						{ arn: PROFILE_ONE, profileName: "Personal" },
						{ arn: PROFILE_TWO, profileName: "Work" },
					],
				}),
			onPrompt: async (options: OAuthPrompt) => {
				prompt = options;
				return "2";
			},
		});

		expect(selected).toEqual({ profileArn: PROFILE_TWO, profileName: "Work" });
		expect(prompt?.message).toContain("1. Personal");
		expect(prompt?.message).toContain("2. Work");
		expect(prompt?.placeholder).toBe("1");
		expect(JSON.stringify(prompt)).not.toContain("arn:");
		expect(JSON.stringify(prompt)).not.toContain("123456789012");
	});

	it("returns fresh credentials without network when outside the refresh margin", async () => {
		const current: OAuthCredentials = {
			...kiroClientCredentials(),
			access: "fresh-access",
			expires: Date.now() + 3_600_000,
		};
		let called = false;
		const result = await refreshKiroToken(current, {
			fetch: async () => {
				called = true;
				return json({ accessToken: "unexpected", expiresIn: 3600 });
			},
		});
		expect(result).toBe(current);
		expect(called).toBe(false);

		const viaHook = await refreshKiroHook(current);
		expect(viaHook).toBe(current);
	});

	it("rejects incomplete, expired, mismatched, or invalid refresh state without network", async () => {
		const cases: Array<{ name: string; credentials: OAuthCredentials }> = [
			{
				name: "missing token endpoint",
				credentials: kiroClientCredentials({ kiroTokenEndpoint: undefined }),
			},
			{
				name: "missing client id",
				credentials: kiroClientCredentials({ kiroClientId: undefined }),
			},
			{
				name: "expired registered client",
				credentials: kiroClientCredentials({ kiroClientSecretExpiresAt: Date.now() - 1 }),
			},
			{
				name: "endpoint does not match credential region",
				credentials: kiroClientCredentials({
					kiroTokenEndpoint: "https://oidc.us-east-1.amazonaws.com/token",
					kiroOidcRegion: "eu-west-1",
				}),
			},
			{
				name: "invalid refresh endpoint",
				credentials: kiroClientCredentials({ kiroTokenEndpoint: "https://example.com/token" }),
			},
		];

		for (const { credentials } of cases) {
			let called = false;
			await expect(
				refreshKiroToken(credentials, {
					fetch: async () => {
						called = true;
						return json({ accessToken: "unexpected", expiresIn: 3600 });
					},
				}),
			).rejects.toMatchObject({ kind: expect.anything() });
			expect(called).toBe(false);
		}
	});

	it("refreshes with the registered client, rotates refresh tokens, and keeps profile provenance", async () => {
		let request: RequestInit | undefined;
		const result = await refreshKiroToken(
			{
				access: "old-access",
				refresh: "refresh-token",
				expires: 0,
				kiroClientId: "client-id",
				kiroClientSecret: "client-secret",
				kiroClientSecretExpiresAt: Date.now() + 60_000,
				kiroTokenEndpoint: "https://oidc.eu-west-1.amazonaws.com/token",
				kiroOidcRegion: "eu-west-1",
				apiEndpoint: "https://runtime.us-east-1.kiro.dev/",
				orgId: PROFILE_TWO,
				orgName: "Work",
			},
			{
				fetch: async (_input, init) => {
					request = init;
					return json({ accessToken: "new-access", refreshToken: "rotated-refresh", expiresIn: 3600 });
				},
			},
		);

		expect(JSON.parse(String(request?.body))).toEqual({
			grantType: "refresh_token",
			refreshToken: "refresh-token",
			clientId: "client-id",
			clientSecret: "client-secret",
		});
		expect(result).toMatchObject({
			access: "new-access",
			refresh: "rotated-refresh",
			kiroClientId: "client-id",
			kiroOidcRegion: "eu-west-1",
			kiroTokenEndpoint: "https://oidc.eu-west-1.amazonaws.com/token",
			apiEndpoint: "https://runtime.us-east-1.kiro.dev/",
			orgId: PROFILE_TWO,
			orgName: "Work",
		});
	});

	it("retries transient refresh failures but does not retry semantic client errors", async () => {
		const current = kiroClientCredentials();
		let transientAttempts = 0;
		const retried = await refreshKiroToken(current, {
			fetch: async () => {
				transientAttempts += 1;
				if (transientAttempts < 3)
					return json({ error: "temporarily unavailable" }, transientAttempts === 1 ? 503 : 429);
				return json({ accessToken: "new-access", refreshToken: "new-refresh", expiresIn: 3600 });
			},
		});
		expect(transientAttempts).toBe(3);
		expect(retried).toMatchObject({ access: "new-access", refresh: "new-refresh" });

		let semanticAttempts = 0;
		await expect(
			refreshKiroToken(current, {
				fetch: async () => {
					semanticAttempts += 1;
					return json({ error: "invalid client" }, 400);
				},
			}),
		).rejects.toMatchObject({ kind: "token-refresh", status: 400 });
		expect(semanticAttempts).toBe(1);
	});

	it("retains the old refresh token when rotation is omitted and rejects cancellation", async () => {
		const retained = await refreshKiroToken(kiroClientCredentials(), {
			fetch: async () => json({ accessToken: "new-access", expiresIn: 3600 }),
		});
		expect(retained.refresh).toBe("refresh-token");

		const controller = new AbortController();
		controller.abort();
		await expect(
			loginKiroDevice(
				{
					onAuth: () => {},
					signal: controller.signal,
					fetch: async () => json(registeredClient()),
				},
				{ region: "us-east-1", startUrl: "https://example.awsapps.com/start" },
			),
		).rejects.toBeInstanceOf(AIError.LoginCancelledError);
	});

	it("fails closed on an oversized token response", async () => {
		await expect(
			refreshKiroToken(kiroClientCredentials(), {
				fetch: async () => new Response(`{"accessToken":"${"x".repeat(140_000)}"}`, { status: 200 }),
			}),
		).rejects.toThrow("exceeded size limit");
	});
});

describe("Kiro OAuth API-key projection", () => {
	it("serializes structured credentials for the native runtime transport", async () => {
		const result = await getOAuthApiKey("kiro", {
			kiro: {
				access: "access-token",
				refresh: "refresh-token",
				expires: Date.now() + 3_600_000,
				apiEndpoint: "https://runtime.us-east-1.kiro.dev/",
			},
		});

		expect(result).not.toBeNull();
		expect(JSON.parse(result!.apiKey)).toMatchObject({
			token: "access-token",
			apiEndpoint: "https://runtime.us-east-1.kiro.dev/",
			refreshToken: "refresh-token",
		});
		expect(result!.newCredentials.access).toBe("access-token");
	});
});

describe("Kiro login replacement", () => {
	function loginResponses(): Response[] {
		return [
			json(registeredClient("us-east-1", undefined, false)),
			json(deviceAuthorization()),
			json({ accessToken: "access-token", refreshToken: "refresh-token", expiresIn: 3600 }),
			...profileResponses(),
		];
	}

	async function deviceLogin(authStorage: AuthStorage): Promise<void> {
		const queue = loginResponses();
		await authStorage.oauth.login("kiro", {
			onAuth: () => {},
			onPrompt: async (prompt: OAuthPrompt) => {
				if (prompt.message.includes("Select Kiro login method")) return "1";
				return prompt.message === "Enter Start URL" ? "https://example.awsapps.com/start" : "us-east-1";
			},
			fetch: async () => queue.shift() ?? json({}, 500),
		});
	}

	it("replaces the stored credential on re-login instead of accumulating rows", async () => {
		const store = await SqliteAuthCredentialStore.open(":memory:");
		const authStorage = new AuthStorage(store);
		try {
			await deviceLogin(authStorage);

			// A second login for the same provider selects the newly stored
			// account: repeated IdC device grants carry no email or account
			// claim to dedupe on, so replacement is the only way the old row
			// cannot pin an existing session.
			await deviceLogin(authStorage);
			expect(store.listAuthCredentials("kiro")).toHaveLength(1);

			// An API-key login replaces an earlier OAuth login, so requests and
			// model discovery cannot keep using the previous OAuth account.
			await authStorage.oauth.login("kiro", {
				onAuth: () => {},
				onPrompt: async (prompt: OAuthPrompt) =>
					prompt.message.includes("Select Kiro login method") ? "3" : "ksk_replacement-key",
				fetch: async input => {
					// The bootstrap probe requires exactly one responsive region.
					return String(input).includes("eu-central-1") ? json({}, 403) : json(modelCatalog());
				},
			});
			const stored = store.listAuthCredentials("kiro");
			expect(stored).toHaveLength(1);
			expect(stored[0]?.credential.type).toBe("api_key");
			expect(await authStorage.keys.peek("kiro")).not.toContain("access-token");
		} finally {
			authStorage.close();
		}
	});

	it("scopes the model cache to one login and keeps it across refresh", async () => {
		const store = await SqliteAuthCredentialStore.open(":memory:");
		const authStorage = new AuthStorage(store);
		try {
			await deviceLogin(authStorage);
			const first = store.listAuthCredentials("kiro")[0]?.credential;
			expect(first?.type).toBe("oauth");
			const firstLoginId = first?.type === "oauth" ? first.kiroLoginId : undefined;
			expect(typeof firstLoginId).toBe("string");

			// Two logins share the same endpoint, so without the stamped login
			// id they would hash to the same model-cache namespace.
			await deviceLogin(authStorage);
			const second = store.listAuthCredentials("kiro")[0]?.credential;
			const secondLoginId = second?.type === "oauth" ? second.kiroLoginId : undefined;
			expect(typeof secondLoginId).toBe("string");
			expect(secondLoginId).not.toBe(firstLoginId);

			// The login id survives token rotation, so refresh keeps the cache
			// namespace instead of orphaning the discovered roster.
			const refreshed = await refreshKiroToken(
				{ ...(second as OAuthCredentials), expires: 0 },
				{
					fetch: async () =>
						json({ accessToken: "refreshed-access", refreshToken: "refreshed-refresh", expiresIn: 3600 }),
				},
			);
			expect(refreshed.kiroLoginId).toBe(secondLoginId);
		} finally {
			authStorage.close();
		}
	});
});
