import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { isSameOAuthAccount, type OAuthCredential, resolveCredentialIdentityKey } from "@oh-my-pi/pi-ai/auth-storage";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { loginKiroHook, refreshKiroHook } from "@oh-my-pi/pi-ai/registry/oauth/kiro";
import type { OAuthController, OAuthCredentials, OAuthPrompt } from "@oh-my-pi/pi-ai/registry/oauth/types";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";
import { decodeKiroCredential, encodeKiroOAuthRow } from "@oh-my-pi/pi-catalog/wire/kiro";

const PROFILE_US = "arn:aws:codewhisperer:us-east-1:123456789012:profile/one";
const PROFILE_EU = "arn:aws:codewhisperer:eu-central-1:123456789012:profile/two";
const SOCIAL_DEFAULT = "arn:aws:codewhisperer:us-east-1:699475941385:profile/EHGA3GRVQMUK";
const SOCIAL_AUTH = "https://prod.us-east-1.auth.desktop.kiro.dev";
const START = "https://example.awsapps.com/start";
const TOKEN = { accessToken: "access-token", refreshToken: "refresh-token", expiresIn: 3600 };
const CATALOG = { models: [{ modelId: "m", tokenLimits: { maxInputTokens: 1000, maxOutputTokens: 500 } }] };
const OIDC_DEVICE = {
	deviceCode: "dc",
	userCode: "ABCD",
	verificationUriComplete: "https://device.test/c",
	expiresIn: 60,
	interval: 1,
};
const SOCIAL_DEVICE = {
	deviceCode: "social-device",
	userCode: "PPMS",
	verificationUriComplete: "https://device.test/c",
	expiresInMilliseconds: 300_000,
	intervalInMilliseconds: 1_000,
};

type Call = { url: string; body: Record<string, unknown> | undefined };

function json(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

/** A fake server answering each request from `handler`, recording URL and JSON body. */
function server(handler: (url: string, body: Record<string, unknown>) => Response) {
	const calls: Call[] = [];
	const fetch: FetchImpl = async (input, init) => {
		const call = { url: String(input), body: init?.body ? JSON.parse(String(init.body)) : undefined };
		calls.push(call);
		return handler(call.url, call.body ?? {});
	};
	return { fetch, calls };
}

/** Controller answering prompts in order and recording them; an extra prompt fails the test. */
function controller(fetch: FetchImpl, ...answers: string[]) {
	const prompts: OAuthPrompt[] = [];
	const ctrl: OAuthController = {
		fetch,
		onAuth() {},
		onPrompt: async prompt => {
			prompts.push(prompt);
			return answers.shift() ?? Promise.reject(new Error(`unexpected prompt: ${prompt.message}`));
		},
	};
	return { ctrl, prompts };
}

/** OIDC endpoints: register, authorize, then one pending poll before the token. */
function oidcHandler(profiles: (url: string) => Response) {
	let polls = 0;
	return (url: string): Response => {
		if (url.endsWith("/client/register")) return json({ clientId: "client-id", clientSecret: "client-secret" });
		if (url.endsWith("/device_authorization")) return json(OIDC_DEVICE);
		if (url.endsWith("/token")) return ++polls === 1 ? json({ error: "authorization_pending" }, 400) : json(TOKEN);
		return profiles(url);
	};
}

/** Social endpoints: authorize, one pending poll, then completion carrying `extra`. */
function socialHandler(extra: Record<string, unknown>, profiles: (url: string) => Response) {
	let polls = 0;
	return (url: string): Response => {
		if (url.endsWith("/oauth/device/authorization")) return json(SOCIAL_DEVICE);
		if (url.endsWith("/oauth/device/poll")) {
			return ++polls === 1
				? json({ status: "authorization_pending" })
				: json({ accessToken: "social-access", refreshToken: "social-refresh", status: "complete", ...extra });
		}
		return profiles(url);
	};
}

let sleep: { mockRestore(): void } | undefined;
beforeEach(() => {
	sleep = spyOn(Bun, "sleep").mockImplementation((() => Promise.resolve()) as typeof Bun.sleep);
});
afterEach(() => {
	sleep?.mockRestore();
});

describe("Kiro device login", () => {
	it("Identity Center: registers, polls past pending, and stores the picked profile without showing its ARN", async () => {
		const { fetch, calls } = server(
			oidcHandler(url =>
				url.includes("us-east-1.kiro.dev")
					? json({ profiles: [{ arn: PROFILE_US, profileName: "Personal" }] })
					: json({ profiles: [{ arn: PROFILE_EU }] }),
			),
		);
		const { ctrl, prompts } = controller(fetch, "1", START, "eu-west-1", "2");
		const row = (await loginKiroHook(ctrl)) as OAuthCredentials;

		const oidc = "https://oidc.eu-west-1.amazonaws.com";
		expect(calls.slice(0, 4).map(call => call.url)).toEqual([
			`${oidc}/client/register`,
			`${oidc}/device_authorization`,
			`${oidc}/token`,
			`${oidc}/token`,
		]);
		expect(calls[1]?.body).toEqual({ clientId: "client-id", clientSecret: "client-secret", startUrl: START });
		expect(row).toEqual({
			access: "access-token",
			refresh: "refresh-token",
			expires: expect.any(Number),
			accountId: expect.any(String),
			kiroClientId: "client-id",
			kiroClientSecret: "client-secret",
			kiroOidcRegion: "eu-west-1",
			kiroProfileArn: PROFILE_EU,
			region: "eu-central-1",
			orgName: "two",
		});
		expect(prompts.at(-1)?.message).toContain("Personal");
		expect(JSON.stringify(prompts)).not.toContain("123456789012");
		expect(decodeKiroCredential(encodeKiroOAuthRow(row), {})).toEqual({
			kind: "oauth",
			token: "access-token",
			region: "eu-central-1",
			loginId: row.accountId!,
			profileArn: PROFILE_EU,
		});
	});

	it("Builder ID signs in on us-east-1 without a Start URL, region, or profile", async () => {
		const { fetch, calls } = server(oidcHandler(() => json({}, 500)));
		const row = (await loginKiroHook(controller(fetch, "2").ctrl)) as OAuthCredentials;
		expect(calls[1]?.body).toMatchObject({ startUrl: "https://view.awsapps.com/start" });
		expect(calls.every(call => call.url.startsWith("https://oidc.us-east-1.amazonaws.com/"))).toBe(true);
		expect(row).toMatchObject({ region: "us-east-1", kiroOidcRegion: "us-east-1" });
		expect(row.kiroProfileArn).toBeUndefined();
	});
});

describe("Kiro social login", () => {
	it("routes by the poll's profile ARN without listing profiles", async () => {
		const { fetch, calls } = server(socialHandler({ profileArn: PROFILE_EU }, () => json({}, 500)));
		const row = (await loginKiroHook(controller(fetch, "4").ctrl)) as OAuthCredentials;
		expect(calls[0]?.body).toEqual({ clientId: "Kiro-CLI", loginProvider: "Google" });
		expect(calls.map(call => call.url)).toEqual([
			`${SOCIAL_AUTH}/oauth/device/authorization`,
			`${SOCIAL_AUTH}/oauth/device/poll`,
			`${SOCIAL_AUTH}/oauth/device/poll`,
		]);
		expect(row).toMatchObject({ kiroProfileArn: PROFILE_EU, region: "eu-central-1", orgName: "Google" });
		expect(row.kiroClientId).toBeUndefined();
	});

	it("without a poll ARN, takes a listed profile, the default only when every region lists none, else fails", async () => {
		const cases: Array<[string, Response, string | undefined]> = [
			["listed", json({ profiles: [{ arn: PROFILE_US }] }), PROFILE_US],
			["none listed", json({ profiles: [] }), SOCIAL_DEFAULT],
			["listing failed", json({}, 403), undefined],
		];
		for (const [name, usEast, expected] of cases) {
			const { fetch } = server(
				socialHandler({}, url =>
					url.includes("us-east-1") ? (usEast.clone() as Response) : json({ profiles: [] }),
				),
			);
			const login = loginKiroHook(controller(fetch, "5").ctrl);
			if (expected) {
				expect({ name, arn: ((await login) as OAuthCredentials).kiroProfileArn }).toEqual({ name, arn: expected });
			} else {
				await expect(login).rejects.toMatchObject({ kind: "discovery" });
			}
		}
	});

	it("keeps two sign-ins of one email as two accounts", async () => {
		const logins: OAuthCredential[] = [];
		for (let i = 0; i < 2; i++) {
			const { fetch } = server(
				socialHandler({ profileArn: PROFILE_US }, () =>
					json({ userInfo: { email: "someone@example.com", userId: "d-0000000000.user" } }),
				),
			);
			const row = await loginKiroHook(controller(fetch, "4").ctrl);
			if (typeof row === "string") throw new Error("expected an OAuth login");
			logins.push({ type: "oauth", ...row });
		}
		const [first, second] = logins;
		if (!first || !second) throw new Error("expected two logins");
		expect(isSameOAuthAccount(first, second)).toBe(false);
		expect(resolveCredentialIdentityKey("kiro", first)).not.toBe(resolveCredentialIdentityKey("kiro", second));
	});
});

describe("Kiro API key login", () => {
	const saved = Bun.env.KIRO_API_REGION;
	afterEach(() => {
		if (saved === undefined) delete Bun.env.KIRO_API_REGION;
		else Bun.env.KIRO_API_REGION = saved;
	});

	it("pins KIRO_API_REGION and probes the key's models there", async () => {
		Bun.env.KIRO_API_REGION = "eu-central-1";
		const { fetch, calls } = server(() => json(CATALOG));
		const key = await loginKiroHook(controller(fetch, "3", "  ksk_key \n").ctrl);
		expect(calls.map(call => call.url)).toEqual(["https://management.eu-central-1.kiro.dev/"]);
		expect(decodeKiroCredential(key as string, {})).toEqual({
			kind: "api_key",
			token: "ksk_key",
			region: "eu-central-1",
		});

		const rejected = server(() => json({}, 403));
		await expect(loginKiroHook(controller(rejected.fetch, "3", "ksk_key").ctrl)).rejects.toMatchObject({
			kind: "discovery",
		});
	});

	it("without a pin, stores the one bootstrap region that accepts the key", async () => {
		delete Bun.env.KIRO_API_REGION;
		const { fetch } = server(url => (url.includes("eu-central-1") ? json(CATALOG) : json({}, 403)));
		const key = await loginKiroHook(controller(fetch, "api", "ksk_key").ctrl);
		expect(decodeKiroCredential(key as string, {})).toMatchObject({ region: "eu-central-1" });

		await expect(loginKiroHook(controller(fetch, "3", "not-a-key").ctrl)).rejects.toMatchObject({
			kind: "validation",
		});
	});
});

describe("Kiro token refresh", () => {
	const oidcRow: OAuthCredentials = {
		access: "old",
		refresh: "refresh-token",
		expires: 0,
		accountId: "login",
		region: "us-east-1",
		kiroClientId: "client-id",
		kiroClientSecret: "client-secret",
		kiroOidcRegion: "eu-west-1",
	};
	const socialRow: OAuthCredentials = {
		access: "old",
		refresh: "social-refresh",
		expires: 0,
		accountId: "login",
		region: "us-east-1",
		kiroProfileArn: PROFILE_US,
	};

	/** Refresh `row` with global fetch answering `response`; returns the result or the error, plus the calls. */
	async function refresh(row: OAuthCredentials, response: Response) {
		const { fetch, calls } = server(() => response);
		const spy = spyOn(globalThis, "fetch").mockImplementation(fetch as typeof globalThis.fetch);
		try {
			return { result: await refreshKiroHook(row).catch(error => error as Error), calls };
		} finally {
			spy.mockRestore();
		}
	}

	it("refreshes an OIDC login against its region's token endpoint, keeping the refresh token when none rotates", async () => {
		const { result, calls } = await refresh(oidcRow, json({ accessToken: "next", expiresIn: 3600 }));
		expect(calls).toEqual([
			{
				url: "https://oidc.eu-west-1.amazonaws.com/token",
				body: {
					grantType: "refresh_token",
					refreshToken: "refresh-token",
					clientId: "client-id",
					clientSecret: "client-secret",
				},
			},
		]);
		expect(result).toEqual({ ...oidcRow, access: "next", refresh: "refresh-token", expires: expect.any(Number) });
	});

	it("fails definitive only when the stored grant or client cannot recover", async () => {
		const cases: Array<[string, OAuthCredentials, Response, boolean]> = [
			["invalid_grant", oidcRow, json({ error: "invalid_grant" }, 400), true],
			["invalid client", oidcRow, json({ __type: "com.amazonaws#InvalidClientException" }, 400), true],
			["missing OIDC state", { ...oidcRow, kiroOidcRegion: undefined }, json(TOKEN), true],
			["missing refresh token", { ...socialRow, refresh: "" }, json(TOKEN), true],
			["other OIDC error", oidcRow, json({ error: "invalid_request" }, 400), false],
			["social 401", socialRow, json({ message: "Bad credentials" }, 401), true],
		];
		for (const [name, row, response, definitive] of cases) {
			const { result } = await refresh(row, response);
			expect({ name, error: result instanceof Error, definitive: AIError.isDefinitiveOAuthFailure(result) }).toEqual(
				{ name, error: true, definitive },
			);
		}
	});

	it("refreshes a social login and follows a moved profile to its region", async () => {
		const { result, calls } = await refresh(
			socialRow,
			json({ accessToken: "next", refreshToken: "rotated", profileArn: PROFILE_EU }),
		);
		expect(calls).toEqual([{ url: `${SOCIAL_AUTH}/refreshToken`, body: { refreshToken: "social-refresh" } }]);
		expect(result).toMatchObject({
			access: "next",
			refresh: "rotated",
			kiroProfileArn: PROFILE_EU,
			region: "eu-central-1",
			accountId: "login",
		});
	});
});
