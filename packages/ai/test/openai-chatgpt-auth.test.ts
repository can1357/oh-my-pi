import { describe, expect, it } from "bun:test";
import { getProviderDefinition } from "@oh-my-pi/pi-ai/registry";
import type { OAuthController, OAuthCredentials } from "@oh-my-pi/pi-ai/registry/oauth/types";

const ISSUER = "https://auth.openai.com";
const TOKEN_URL = `${ISSUER}/api/accounts/oauth/token`;
const JWKS_URL = `${ISSUER}/.well-known/jwks.json`;
const SHARING_SCOPE = "chatgpt.tokens.use.direct";

const keyPair = await crypto.subtle.generateKey(
	{ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
	true,
	["sign", "verify"],
);
const publicJwk = { ...(await crypto.subtle.exportKey("jwk", keyPair.publicKey)), kid: "test-key" };

function encode(value: unknown): string {
	return Buffer.from(JSON.stringify(value)).toString("base64url");
}

async function signIdToken(claims: Record<string, unknown>): Promise<string> {
	const signingInput = `${encode({ alg: "RS256", kid: "test-key" })}.${encode(claims)}`;
	const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keyPair.privateKey, Buffer.from(signingInput));
	return `${signingInput}.${Buffer.from(signature).toString("base64url")}`;
}

type TokenOverrides = {
	scope?: string;
	nonce?: (issued: string) => string;
	/** `client_id` echoed on the redirect: a value, or null for a redirect that omits it. */
	redirectClientId?: string | null;
	/** `chatgpt_account_id` claim (a workspace id), as stored accountId carries when the token has one. */
	workspaceId?: string;
};

/** Drives the browser-less login: reads the authorization URL, "redirects" the user back with a client id. */
async function login(overrides: TokenOverrides = {}) {
	const definition = getProviderDefinition("openai");
	if (!definition?.login) throw new Error("openai login is unavailable");
	let authUrl = new URL("http://unset");
	const requests: { url: string; form: URLSearchParams }[] = [];
	const ctrl: OAuthController = {
		onAuth: info => {
			authUrl = new URL(info.url);
		},
		onManualCodeInput: async () => {
			const redirect = new URL(authUrl.searchParams.get("redirect_uri") ?? "");
			redirect.searchParams.set("code", "auth-code");
			redirect.searchParams.set("state", authUrl.searchParams.get("state") ?? "");
			if (overrides.redirectClientId !== null) {
				redirect.searchParams.set("client_id", overrides.redirectClientId ?? "agent_client_1");
			}
			return redirect.toString();
		},
		signal: AbortSignal.timeout(10_000),
		fetch: Object.assign(
			async (input: string | URL | Request, init?: RequestInit) => {
				const url = String(input);
				if (url === JWKS_URL) return Response.json({ keys: [publicJwk] });
				requests.push({ url, form: new URLSearchParams(String(init?.body)) });
				const nonce = authUrl.searchParams.get("nonce") ?? "";
				const idToken = await signIdToken({
					iss: ISSUER,
					aud: "agent_client_1",
					sub: "user-123",
					exp: Math.floor(Date.now() / 1000) + 600,
					nonce: overrides.nonce ? overrides.nonce(nonce) : nonce,
					email: "Dev@Example.com",
					...(overrides.workspaceId
						? { "https://api.openai.com/auth": { chatgpt_account_id: overrides.workspaceId } }
						: {}),
				});
				return Response.json({
					access_token: "access-1",
					refresh_token: "refresh-1",
					id_token: idToken,
					expires_in: 3600,
					scope: overrides.scope ?? `openid ${SHARING_SCOPE}`,
				});
			},
			{ preconnect: fetch.preconnect },
		),
	};
	const result = (await definition.login(ctrl)) as OAuthCredentials;
	return { result, requests, authUrl };
}

describe("OpenAI ChatGPT token-sharing login", () => {
	it("registers an agent client, exchanges the code with the issued client id, and verifies the ID token", async () => {
		const { result, requests, authUrl } = await login();

		expect(authUrl.origin + authUrl.pathname).toBe(`${ISSUER}/api/accounts/authorize`);
		expect(authUrl.searchParams.get("client_id")).toBe("dynamic_agent_client");
		expect(authUrl.searchParams.get("agent_name_hint")).toBe("Oh My Pi");
		expect(authUrl.searchParams.get("ext_agent_host_id")).toMatch(/^urn:uuid:[0-9a-f-]{36}$/);
		expect(authUrl.searchParams.get("resource")).toBe("https://api.openai.com/v1");
		expect(authUrl.searchParams.get("scope")?.split(" ")).toContain(SHARING_SCOPE);
		expect(authUrl.searchParams.get("code_challenge_method")).toBe("S256");
		expect(authUrl.searchParams.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/);

		const exchange = requests.find(request => request.url === TOKEN_URL);
		expect(exchange?.form.get("grant_type")).toBe("authorization_code");
		expect(exchange?.form.get("client_id")).toBe("agent_client_1");
		expect(exchange?.form.get("resource")).toBe("https://api.openai.com/v1");
		expect(exchange?.form.get("redirect_uri")).toBe(authUrl.searchParams.get("redirect_uri"));

		expect(result).toMatchObject({
			access: "access-1",
			refresh: "refresh-1",
			oauthClientId: "agent_client_1",
			accountId: "user-123",
			email: "dev@example.com",
		});
	});

	it("rejects a sign-in that finished without token sharing", async () => {
		await expect(login({ scope: "openid profile" })).rejects.toThrow(/token sharing/);
	});

	it("rejects an ID token minted for another sign-in attempt", async () => {
		await expect(login({ nonce: issued => `${issued}-replayed` })).rejects.toThrow(/nonce/);
	});

	it("rejects a redirect that carries no issued client id", async () => {
		await expect(login({ redirectClientId: null })).rejects.toThrow(/client ID/);
	});

	it("identifies the account by the workspace id when the verified token has one", async () => {
		const { result } = await login({ workspaceId: "acct_workspace_1" });

		expect(result.accountId).toBe("acct_workspace_1");
	});
});

describe("OpenAI ChatGPT token-sharing refresh", () => {
	async function refresh(credentials: OAuthCredentials, body: Record<string, unknown>) {
		const refreshToken = getProviderDefinition("openai")?.refreshToken;
		if (!refreshToken) throw new Error("openai refresh is unavailable");
		const original = globalThis.fetch;
		let form: URLSearchParams | undefined;
		globalThis.fetch = Object.assign(
			async (_input: string | URL | Request, init?: RequestInit) => {
				form = new URLSearchParams(String(init?.body));
				return Response.json(body);
			},
			{ preconnect: original.preconnect },
		);
		try {
			return { result: await refreshToken(credentials), form };
		} finally {
			globalThis.fetch = original;
		}
	}

	it("replays the registered client id and keeps it and an unrotated refresh token", async () => {
		const { result, form } = await refresh(
			{ access: "old", refresh: "refresh-1", expires: 0, oauthClientId: "agent_client_1", accountId: "user-123" },
			{ access_token: "access-2", expires_in: 1800 },
		);

		expect(form?.get("grant_type")).toBe("refresh_token");
		expect(form?.get("client_id")).toBe("agent_client_1");
		expect(form?.get("refresh_token")).toBe("refresh-1");
		expect(form?.get("resource")).toBe("https://api.openai.com/v1");
		expect(result).toMatchObject({
			access: "access-2",
			refresh: "refresh-1",
			oauthClientId: "agent_client_1",
			accountId: "user-123",
		});
	});

	it("fails definitively when the grant has no registered client", async () => {
		const error = await refresh({ access: "old", refresh: "refresh-1", expires: 0 }, {}).catch(
			(caught: unknown) => caught,
		);

		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toMatch(/Log in again/);
	});
});
