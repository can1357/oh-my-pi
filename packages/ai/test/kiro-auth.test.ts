import { describe, expect, it, spyOn } from "bun:test";
import { AuthStorage, resolveCredentialIdentityKey, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { getOAuthApiKey } from "@oh-my-pi/pi-ai/registry/oauth";
import {
	KIRO_IDENTITY_CENTER_SCOPES,
	KIRO_SOCIAL_DEFAULT_PROFILE_ARN,
	loginKiroDevice,
	loginKiroHook,
	loginKiroSocial,
	refreshKiroToken,
	selectKiroProfile,
	validateKiroApiKey,
} from "@oh-my-pi/pi-ai/registry/oauth/kiro";
import type { OAuthCredentials, OAuthPrompt } from "@oh-my-pi/pi-ai/registry/oauth/types";
import { resolveKiroModelCacheProviderId } from "@oh-my-pi/pi-catalog/provider-models";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";
import { decodeKiroCredential } from "@oh-my-pi/pi-catalog/wire/kiro-credential";

const PROFILE_ONE = "arn:aws:codewhisperer:us-east-1:123456789012:profile/one";
const PROFILE_TWO = "arn:aws:codewhisperer:us-east-1:123456789012:profile/two";
const SOCIAL_PROFILE = "arn:aws:codewhisperer:us-east-1:699475941385:profile/SOCIAL";
const SOCIAL_AUTH = "https://prod.us-east-1.auth.desktop.kiro.dev";
const START = "https://example.awsapps.com/start";
const BUILDER = "https://view.awsapps.com/start";
const IDC = { region: "us-east-1", startUrl: START };
const US_TOKEN = "https://oidc.us-east-1.amazonaws.com/token";
const RUNTIME = "https://runtime.us-east-1.kiro.dev/";
const EU_RUNTIME = "https://runtime.eu-central-1.kiro.dev/";
const TOKEN = { accessToken: "access-token", refreshToken: "refresh-token", expiresIn: 3600 };
const LIMITS = { maxInputTokens: 1000, maxOutputTokens: 500 };
const CATALOG = { models: [{ modelId: "m", modelName: "M", supportedInputTypes: ["TEXT"], tokenLimits: LIMITS }] };
const URIS = { verificationUri: "https://device.test/v", verificationUriComplete: "https://device.test/c" };
const noAuth = { onAuth() {} };

function json(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function idcResponses(registration: Record<string, unknown> = {}): Response[] {
	return [
		json({ clientId: "client-id", clientSecret: "client-secret", clientSecretExpiresAt: 4e9, ...registration }),
		json({ deviceCode: "dc", userCode: "ABCD", ...URIS, expiresIn: 60, interval: 1 }),
		json(TOKEN),
		json({ profiles: [{ arn: PROFILE_TWO }] }),
		json({ profiles: [] }),
	];
}

/** Fetch serving `responses` in order, recording each URL and JSON body. */
function queued(responses: Response[]) {
	const urls: string[] = [];
	const bodies: unknown[] = [];
	const fetch: FetchImpl = async (input, init) => {
		urls.push(String(input));
		bodies.push(init?.body ? JSON.parse(String(init.body)) : undefined);
		return responses.shift() ?? json({}, 500);
	};
	return { fetch, urls, bodies };
}

/** Prompt handler answering in order; any extra prompt fails the test. */
function answers(...list: string[]): (prompt: OAuthPrompt) => Promise<string> {
	return async prompt => list.shift() ?? Promise.reject(new Error(`unexpected prompt: ${prompt.message}`));
}

function clientCredentials(overrides: Partial<OAuthCredentials> = {}): OAuthCredentials {
	const client = { kiroClientId: "client-id", kiroClientSecret: "client-secret", kiroTokenEndpoint: US_TOKEN };
	const base = { access: "old-access", refresh: "refresh-token", expires: 0, apiEndpoint: RUNTIME };
	return { ...base, ...client, kiroClientSecretExpiresAt: Date.now() + 60_000, ...overrides };
}

type StorageHooks = { globalFetch?: (url: string, init?: RequestInit) => Response; onDisabled?: () => void };

/** In-memory AuthStorage; its refreshes use global fetch, so `globalFetch` is spied in for the test body. */
async function withStorage(
	fn: (auth: AuthStorage, store: SqliteAuthCredentialStore) => Promise<void>,
	{ globalFetch, onDisabled }: StorageHooks = {},
): Promise<void> {
	const store = await SqliteAuthCredentialStore.open(":memory:");
	const auth = new AuthStorage(store, { onCredentialDisabled: onDisabled });
	const mock = Object.assign(async (input: unknown, init?: RequestInit) => globalFetch!(String(input), init), {
		preconnect: globalThis.fetch.preconnect,
	});
	const spy = globalFetch && spyOn(globalThis, "fetch").mockImplementation(mock);
	try {
		await fn(auth, store);
	} finally {
		spy?.mockRestore();
		auth.close();
	}
}

describe("Kiro login", () => {
	it("validates API keys: pinned-region normalization, pre-network rejection, and an unpinned bootstrap probe", async () => {
		const pinned = queued([json(CATALOG)]);
		const key = await validateKiroApiKey("  'ksk_a/b+c' \n", { apiRegion: "us-east-1", fetch: pinned.fetch });
		expect(key).toEqual({ type: "api_key", key: "ksk_a/b+c", apiEndpoint: RUNTIME });
		const check = (bad: string, apiRegion: string) => validateKiroApiKey(bad, { apiRegion, fetch: pinned.fetch });
		await expect(check("not-a-kiro-key", "us-east-1")).rejects.toMatchObject({ kind: "validation" });
		await expect(check("ksk_valid-key", "not-a-region")).rejects.toMatchObject({ kind: "configuration" });
		expect(pinned.urls).toEqual(["https://management.us-east-1.kiro.dev/"]);

		const probe: FetchImpl = async input => (String(input).includes("eu-central-1") ? json(CATALOG) : json({}, 500));
		expect((await validateKiroApiKey("ksk_probe", { fetch: probe })).apiEndpoint).toBe(EU_RUNTIME);
	});

	it("picker: an empty answer is refused, and Builder ID signs in without Start URL/region/profile prompts", async () => {
		const empty = loginKiroHook({ ...noAuth, onPrompt: async () => "" });
		await expect(empty).rejects.toBeInstanceOf(AIError.OnPromptRequiredError);

		const { fetch, urls, bodies } = queued(idcResponses().slice(0, 3));
		const credentials = (await loginKiroHook({ ...noAuth, onPrompt: answers("2"), fetch })) as OAuthCredentials;
		expect([urls[0], bodies[1]]).toMatchObject([US_TOKEN.replace("token", "client/register"), { startUrl: BUILDER }]);
		expect([credentials.kiroOidcRegion, credentials.kiroProfileArn]).toEqual(["us-east-1", undefined]);
	});

	it("validates Identity Center input, registers with exact scopes, and resolves an omitted token endpoint", async () => {
		const invalid = { kind: "validation" };
		const cases: Array<[Partial<typeof IDC>, AbortSignal | undefined, object, number]> = [
			[{ startUrl: "https://example.com/not-start" }, undefined, invalid, 0],
			[{ region: "not-a-region" }, undefined, invalid, 0],
			[{}, AbortSignal.abort(), expect.any(AIError.LoginCancelledError), 0],
			[{}, undefined, invalid, 1], // registration returns an invalid tokenEndpoint
		];
		for (const [options, signal, error, requests] of cases) {
			const { fetch, urls } = queued(idcResponses(requests ? { tokenEndpoint: "x" } : {}));
			const login = loginKiroDevice({ ...noAuth, signal, fetch }, { ...IDC, ...options });
			await expect(login).rejects.toMatchObject(error);
			expect(urls).toHaveLength(requests);
		}

		const canonical = "https://oidc.eu-west-1.amazonaws.com/token";
		for (const registration of [{}, { tokenEndpoint: null }]) {
			const { fetch, urls, bodies } = queued(idcResponses(registration));
			const login = loginKiroDevice({ ...noAuth, fetch }, { region: "eu-west-1", startUrl: START });
			expect(await login).toMatchObject({ kiroTokenEndpoint: canonical, kiroOidcRegion: "eu-west-1" });
			expect([urls[0], urls[2]]).toEqual(["https://oidc.eu-west-1.amazonaws.com/client/register", canonical]);
			const scopes = [...KIRO_IDENTITY_CENTER_SCOPES];
			expect(bodies[0]).toEqual({ clientName: "Kiro CLI", clientType: "public", scopes });
		}
	});

	it("prompts for a profile without exposing its ARN or account id", async () => {
		let prompt: OAuthPrompt | undefined;
		const profiles = [PROFILE_ONE, PROFILE_TWO].map((arn, i) => ({ arn, profileName: ["Personal", "Work"][i] }));
		const selected = await selectKiroProfile("access-token", "us-east-1", {
			fetch: async () => json({ profiles }),
			onPrompt: async options => ((prompt = options), "2"),
		});
		expect(selected).toEqual({ profileArn: PROFILE_TWO, profileName: "Work" });
		expect(JSON.stringify(prompt)).not.toMatch(/arn:|123456789012/);
	});

	it("sends kiro-cli SSO-OIDC headers with numbered retries and polls past pending/slow_down", async () => {
		const sleepSpy = spyOn(Bun, "sleep").mockImplementation((() => Promise.resolve()) as typeof Bun.sleep);
		const [registration, device, ...rest] = idcResponses();
		const pending = [json({ error: "authorization_pending" }, 400), json({ error: "slow_down" }, 400)];
		const responses = [json({}, 503), json({}, 503), registration!, device!, ...pending, ...rest];
		const urls: string[] = [];
		const sent: Record<string, string>[] = [];
		const fetch: FetchImpl = async (input, init) => {
			if (urls.push(String(input)) <= 3) sent.push(Object.fromEntries(new Headers(init?.headers)));
			return responses.shift() ?? json({}, 500);
		};
		try {
			expect((await loginKiroDevice({ ...noAuth, fetch }, IDC)).kiroProfileArn).toBe(PROFILE_TWO);
		} finally {
			sleepSpy.mockRestore();
		}
		expect(urls.filter(url => url === US_TOKEN)).toHaveLength(3);
		expect(sent.map(headers => headers["amz-sdk-request"])).toEqual([1, 2, 3].map(n => `attempt=${n}; max=3`));
	});

	it("stores an ARN-safe label and endpoint, and each login adds an account", async () => {
		await withStorage(async (auth, store) => {
			for (let i = 0; i < 2; i++) {
				const onPrompt = answers("1", START, "us-east-1");
				const login = { ...noAuth, onPrompt, fetch: queued(idcResponses()).fetch };
				expect(await auth.oauth.login("kiro", login)).toMatchObject({ orgName: "two" });
			}
			const rows = store.listAuthCredentials("kiro").map(row => row.credential);
			expect(rows).toEqual([
				expect.objectContaining({ kiroTokenEndpoint: US_TOKEN }),
				expect.objectContaining({ kiroTokenEndpoint: US_TOKEN }),
			]);
		});
	});

	it("gives each login a distinct identity key that survives refresh and hides the AWS account", async () => {
		const login = () => loginKiroDevice({ ...noAuth, fetch: queued(idcResponses()).fetch }, IDC);
		const [first, second] = [await login(), await login()];
		const key = (credentials: OAuthCredentials) =>
			resolveCredentialIdentityKey("kiro", { type: "oauth", ...credentials });
		expect(key(first)).toBe(`account:${first.kiroLoginId}`);
		expect(key(second)).not.toBe(key(first));
		expect(key(first)).not.toContain("123456789012");

		const refreshed = await refreshKiroToken(first, queued([json({ accessToken: "next", expiresIn: 3600 })]));
		expect([refreshed.access, key(refreshed)]).toEqual(["next", key(first)]);
	});
});

describe("Kiro token refresh", () => {
	it("force-refreshes an unexpired login with its client, rotating without leaking the secret; retries only transients", async () => {
		const requests: unknown[] = [];
		const globalFetch = (url: string, init?: RequestInit) => {
			requests.push([url, JSON.parse(String(init?.body))]);
			return json({ accessToken: "next-access", refreshToken: "rotated", expiresIn: 3600 });
		};
		await withStorage(
			async (auth, store) => {
				const current = clientCredentials({ expires: Date.now() + 3_600_000, kiroOidcRegion: "us-east-1" });
				await auth.credentials.set("kiro", { type: "oauth", ...current });
				const entry = await auth.oauth.refresh(store.listAuthCredentials("kiro")[0]!.id);
				expect(entry.credential).toMatchObject({ access: "next-access", apiEndpoint: RUNTIME });
				expect(entry.credential).not.toHaveProperty("kiroClientSecret");
				expect(store.listAuthCredentials("kiro")[0]?.credential).toMatchObject({ refresh: "rotated" });
			},
			{ globalFetch },
		);
		const body = { grantType: "refresh_token", refreshToken: "refresh-token", clientId: "client-id" };
		expect(requests).toEqual([[US_TOKEN, { ...body, clientSecret: "client-secret" }]]);

		// Transient failures are retried; semantic client errors are not.
		let attempts = 0;
		const retried = await refreshKiroToken(clientCredentials(), {
			fetch: async () => (++attempts < 3 ? json({}, 503) : json({ accessToken: "new-access", expiresIn: 3600 })),
		});
		expect([attempts, retried.access]).toEqual([3, "new-access"]);

		const semantic = queued([json({ error: "invalid client" }, 400)]);
		await expect(refreshKiroToken(clientCredentials(), semantic)).rejects.toMatchObject({ status: 400 });
		expect(semantic.urls).toHaveLength(1);
	});

	it("disables on definitive refresh failures and keeps the login on transient ones", async () => {
		const social = { kiroProfileArn: SOCIAL_PROFILE, kiroLoginProvider: "Google" as const };
		// Last column: whether the credential is disabled.
		const cases: Array<[string, Partial<OAuthCredentials>, Response, boolean]> = [
			["invalid_grant", {}, json({ error: "invalid_grant" }, 400), true],
			["expired client", { kiroClientSecretExpiresAt: 1 }, json(TOKEN), true],
			["incomplete state", { kiroClientSecret: undefined }, json(TOKEN), true],
			["social 401", social, json({ message: "Bad credentials" }, 401), true],
			["other OIDC error", {}, json({ error: "invalid_request" }, 400), false],
			["social outage", social, json({ message: "unavailable" }, 503), false],
		];
		for (const [name, credential, response, disabled] of cases) {
			let events = 0;
			await withStorage(
				async auth => {
					const row = clientCredentials({ expires: 1, kiroLoginId: "login-dead", ...credential });
					await auth.credentials.set("kiro", { type: "oauth", ...row });
					expect(await auth.keys.get("kiro", `session-${name}`)).toBeUndefined();
					const outcome = { name, kept: auth.credentials.has("kiro"), events };
					expect(outcome).toEqual({ name, kept: !disabled, events: disabled ? 1 : 0 });
				},
				{ globalFetch: () => response.clone() as Response, onDisabled: () => void events++ },
			);
		}
	});

	it("projects route and login id without the refresh token, and peek shares its cache scope", async () => {
		const live = { access: "access-token", expires: Date.now() + 3e6, kiroProfileArn: PROFILE_ONE, kiroLoginId: "l1" };
		const row = clientCredentials(live);
		const projected = (await getOAuthApiKey("kiro", { kiro: row }))?.apiKey;
		const decoded = { kind: "oauth" as const, token: "access-token", apiEndpoint: RUNTIME, loginId: "l1" };
		expect(decodeKiroCredential(projected ?? "", {})).toEqual({ ...decoded, profileArn: PROFILE_ONE });
		expect(projected).not.toMatch(/refresh-token|client-secret/);

		const scope = resolveKiroModelCacheProviderId(projected);
		await withStorage(async auth => {
			await auth.credentials.set("kiro", { type: "oauth", ...row });
			expect(resolveKiroModelCacheProviderId(await auth.keys.peek("kiro"))).toBe(scope);
			await auth.credentials.set("kiro", { type: "oauth", ...row, access: "expired", expires: 1 });
			expect(resolveKiroModelCacheProviderId(await auth.keys.peek("kiro", { includeExpired: true }))).toBe(scope);
		});
	});
});

describe("Kiro social (Google/GitHub) sign-in", () => {
	const device = { deviceCode: "social-device", userCode: "PPMS", ...URIS };
	const socialDevice = () => json({ ...device, expiresInMilliseconds: 300_000, intervalInMilliseconds: 5_000 });
	const pollStatus = (status: string) => json({ accessToken: null, refreshToken: null, status });
	const complete = (extra: Record<string, unknown> = {}) =>
		json({ accessToken: "social-access", refreshToken: "social-refresh", status: "complete", ...extra });

	it("signs in through the picker, polls past pending/slow_down, and stores a routable login", async () => {
		const sleepSpy = spyOn(Bun, "sleep").mockImplementation((() => Promise.resolve()) as typeof Bun.sleep);
		const polls = ["authorization_pending", "slow_down"].map(pollStatus);
		const { fetch, urls, bodies } = queued([socialDevice(), ...polls, complete({ profileArn: SOCIAL_PROFILE })]);
		try {
			const credentials = (await loginKiroHook({ ...noAuth, onPrompt: answers("4"), fetch })) as OAuthCredentials;
			const poll = `${SOCIAL_AUTH}/oauth/device/poll`;
			expect(urls).toEqual([`${SOCIAL_AUTH}/oauth/device/authorization`, poll, poll, poll]);
			expect(bodies[1]).toEqual({ deviceCode: "social-device", clientId: "Kiro-CLI" });
			const projected = (await getOAuthApiKey("kiro", { kiro: credentials }))?.apiKey ?? "";
			const routing = { apiEndpoint: RUNTIME, profileArn: SOCIAL_PROFILE, loginProvider: "Google" };
			expect(decodeKiroCredential(projected, {})).toMatchObject({ ...routing, loginId: credentials.kiroLoginId });

			// invalid_token is terminal: no further poll.
			const dead = queued([socialDevice(), pollStatus("invalid_token")]);
			const failed = loginKiroSocial({ ...noAuth, fetch: dead.fetch }, "Github");
			await expect(failed).rejects.toMatchObject({ kind: "device-auth" });
			expect(dead.urls).toHaveLength(2);
		} finally {
			sleepSpy.mockRestore();
		}
	});

	it("resolves the poll-less profile from listing or the social default, surfacing listing failures", async () => {
		// The default profile is only for an account that lists none; a failed region may hold its own profile.
		const cases: Array<[string, Response, string | undefined]> = [
			["listed", json({ profiles: [{ arn: PROFILE_TWO }] }), PROFILE_TWO],
			["none listed", json({ profiles: [] }), KIRO_SOCIAL_DEFAULT_PROFILE_ARN],
			["listing failed", json({}, 503), undefined],
		];
		for (const [name, usEast, expected] of cases) {
			const fetch: FetchImpl = async input => {
				const url = String(input);
				if (url.endsWith("/oauth/device/authorization")) return socialDevice();
				if (url.endsWith("/oauth/device/poll")) return complete();
				return url.includes("us-east-1") ? (usEast.clone() as Response) : json({ profiles: [] });
			};
			const login = loginKiroSocial({ ...noAuth, fetch }, "Google");
			if (expected) expect({ name, arn: (await login).kiroProfileArn }).toEqual({ name, arn: expected });
			else await expect(login).rejects.toMatchObject({ kind: "discovery" });
		}
	});

	it("refreshes a social login against /refreshToken and follows a moved profile", async () => {
		const moved = "arn:aws:codewhisperer:eu-central-1:699475941385:profile/EU";
		const { fetch, urls, bodies } = queued([json({ accessToken: "n", refreshToken: "r2", profileArn: moved })]);
		const social = { kiroLoginId: "l", kiroLoginProvider: "Github" as const, kiroProfileArn: SOCIAL_PROFILE };
		const current = { access: "a", refresh: "social-refresh", expires: 0, apiEndpoint: RUNTIME, ...social };
		const result = await refreshKiroToken(current, { fetch });
		expect([urls, bodies]).toEqual([[`${SOCIAL_AUTH}/refreshToken`], [{ refreshToken: "social-refresh" }]]);
		expect(result).toMatchObject({ refresh: "r2", kiroProfileArn: moved, apiEndpoint: EU_RUNTIME, kiroLoginId: "l" });
	});
});
