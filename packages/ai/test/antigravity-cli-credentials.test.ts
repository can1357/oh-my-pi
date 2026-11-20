import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { authCredentialEquals } from "../src/auth/pool";
import { AuthStorage, isSameOAuthAccount, SqliteAuthCredentialStore } from "../src/auth-storage";
import { isDefinitiveOAuthFailure } from "../src/error";
import {
	AGY_GCP_OAUTH_CLIENT_ID,
	AGY_GCP_OAUTH_REDIRECT_URI,
	AGY_OAUTH_CLIENT_ID,
	agyCredentialEnv,
	agyCredentialKey,
	agyCredentialVersion,
	exchangeAgyGcpCode,
	exportAgyCredentials,
	parseAgyApiKey,
	parseAgyStoredCredentials,
	refreshAgyCredentials,
	stageAgyCredentials,
} from "../src/providers/antigravity-cli/credentials";
import { getOAuthApiKey } from "../src/registry/oauth";
import { AgyAuthUrlParser, agyAuthorizationCode, loginAntigravityGcp } from "../src/registry/oauth/antigravity-cli";
import type { OAuthCredentials } from "../src/registry/oauth/types";
const directories: string[] = [];
const GCP_ENV_KEYS = ["GOOGLE_CLOUD_PROJECT", "GCP_PROJECT", "GCLOUD_PROJECT"] as const;
const originalGcpEnv = new Map(GCP_ENV_KEYS.map(key => [key, Bun.env[key]]));
const grant: OAuthCredentials = {
	access: "fixture-access",
	refresh: "fixture-refresh",
	expires: Date.now() + 3_600_000,
	email: "account@example.test",
	accountId: "fixture-account",
};
const idToken = `header.${Buffer.from(JSON.stringify({ sub: grant.accountId, email: grant.email })).toString("base64url")}.signature`;
const stored = {
	token: {
		access_token: grant.access,
		refresh_token: grant.refresh,
		token_type: "Bearer",
		expiry: new Date(grant.expires).toISOString(),
	},
	auth_method: "consumer",
	id_token: idToken,
};
const apiKey = JSON.stringify({
	token: grant.access,
	refreshToken: grant.refresh,
	expiresAt: grant.expires,
	email: grant.email,
	accountId: grant.accountId,
});

afterEach(async () => {
	for (const key of GCP_ENV_KEYS) {
		const original = originalGcpEnv.get(key);
		if (original === undefined) delete Bun.env[key];
		else Bun.env[key] = original;
	}
	await Promise.all(directories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});

describe("Antigravity CLI credential ownership", () => {
	it("exports a real refreshable native consumer grant and identity", () => {
		expect(parseAgyStoredCredentials(stored)).toEqual(grant);
	});

	it("exports the ACP id_token_email shape without requiring the older standalone ID token", () => {
		const credentials = parseAgyStoredCredentials({
			token: stored.token,
			auth_method: "consumer",
			id_token_email: grant.email,
		});
		expect(credentials.access).toBe(grant.access);
		expect(credentials.refresh).toBe(grant.refresh);
		expect(credentials.email).toBe(grant.email);
		expect(credentials.accountId).toBeUndefined();
		const emailOnly = JSON.stringify({ ...JSON.parse(apiKey), accountId: undefined });
		expect(agyCredentialKey(emailOnly)).toBe(agyCredentialKey(apiKey));
	});

	it("rejects non-consumer, missing, corrupt and non-refreshable grants without echoing secrets", () => {
		for (const value of [
			null,
			{ ...stored, auth_method: "business" },
			{ ...stored, token: { ...stored.token, refresh_token: "" } },
			{ ...stored, token: { ...stored.token, refresh_token: "__remote__" } },
			{ ...stored, token: { ...stored.token, expiry: "secret-invalid-expiry" } },
		]) {
			expect(() => parseAgyStoredCredentials(value)).toThrow();
		}
		try {
			parseAgyApiKey("not-json-secret");
			throw new Error("unexpected success");
		} catch (error) {
			expect(String(error)).not.toContain("not-json-secret");
		}
		expect(() => parseAgyApiKey("agy-keychain")).toThrow();
		expect(() => parseAgyApiKey(JSON.stringify({ token: "secret" }))).toThrow();
	});

	it("keeps account ownership stable across rotations and changes host revisions", () => {
		const rotated = JSON.stringify({
			...JSON.parse(apiKey),
			token: "rotated-access",
			refreshToken: "rotated-refresh",
		});
		expect(agyCredentialKey(rotated)).toBe(agyCredentialKey(apiKey));
		expect(agyCredentialVersion(rotated)).not.toBe(agyCredentialVersion(apiKey));
		const other = JSON.stringify({
			...JSON.parse(apiKey),
			accountId: "another-account",
			email: "other@example.test",
		});
		expect(agyCredentialKey(other)).not.toBe(agyCredentialKey(apiKey));
		const emailOnly = { ...JSON.parse(apiKey), accountId: undefined };
		expect(agyCredentialKey(JSON.stringify({ ...emailOnly, email: "ACCOUNT@EXAMPLE.TEST" }))).toBe(
			agyCredentialKey(JSON.stringify(emailOnly)),
		);
		expect(() => agyCredentialKey(JSON.stringify({ ...emailOnly, email: undefined }))).toThrow();
	});

	it("stages a private complete native file and atomically replaces it without changing another account", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "agy-credentials-"));
		directories.push(directory);
		const account = path.join(directory, agyCredentialKey(apiKey));
		await stageAgyCredentials(apiKey, account);
		const tokenPath = path.join(account, "antigravity-cli", "antigravity-oauth-token");
		const previous = await fs.open(tokenPath, "r");
		try {
			await stageAgyCredentials(JSON.stringify({ ...JSON.parse(apiKey), token: "new-access" }), account);
			expect(JSON.parse(await previous.readFile("utf8")).token.access_token).toBe(grant.access);
			expect((await exportAgyCredentials(account)).access).toBe("new-access");
		} finally {
			await previous.close();
		}
		if (process.platform !== "win32") {
			expect((await fs.stat(account)).mode & 0o777).toBe(0o700);
			expect((await fs.stat(tokenPath)).mode & 0o777).toBe(0o600);
		}
		expect(await fs.readdir(path.join(account, "antigravity-cli"))).toEqual(["antigravity-oauth-token"]);
		const otherKey = JSON.stringify({
			...JSON.parse(apiKey),
			accountId: "second",
			email: "second@example.test",
			token: "second-access",
		});
		const otherAccount = path.join(directory, agyCredentialKey(otherKey));
		await stageAgyCredentials(otherKey, otherAccount);
		expect((await exportAgyCredentials(account)).access).toBe("new-access");
		expect((await exportAgyCredentials(otherAccount)).access).toBe("second-access");
	});

	it("renders broker credentials with the local structured policy before staging", async () => {
		const result = await getOAuthApiKey("antigravity-cli", {
			"antigravity-cli": { ...grant, refresh: "__remote__" },
		});
		expect(result).not.toBeNull();
		expect(parseAgyApiKey(result!.apiKey)).toEqual({ ...grant, refresh: "__remote__" });
	});

	it("never stages the broker's refresh sentinel or mutates the parent environment", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "agy-broker-"));
		directories.push(directory);
		const before = process.env.SSH_TTY;
		expect(agyCredentialEnv()).toEqual({ SSH_TTY: "omp-agy-file-auth" });
		expect(process.env.SSH_TTY).toBe(before);
		await stageAgyCredentials(JSON.stringify({ ...JSON.parse(apiKey), refreshToken: "__remote__" }), directory);
		const contents = await fs.readFile(path.join(directory, "antigravity-cli", "antigravity-oauth-token"), "utf8");
		expect(contents).not.toContain("__remote__");
		expect(JSON.parse(contents).token.refresh_token).toBeUndefined();
		await expect(
			stageAgyCredentials(JSON.stringify({ ...JSON.parse(apiKey), expiresAt: 1 }), directory),
		).rejects.toThrow("refreshed");
	});
});

describe("Antigravity CLI authorization output", () => {
	const url = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${AGY_OAUTH_CLIENT_ID}&state=fixture&scope=a%20b`;

	it("waits for a complete URL at every possible chunk boundary", () => {
		for (let boundary = 0; boundary <= url.length; boundary++) {
			const parser = new AgyAuthUrlParser();
			expect(parser.push(`Sign in:\n${url.slice(0, boundary)}`)).toBeUndefined();
			expect(parser.push(url.slice(boundary))).toBeUndefined();
			expect(parser.push("\nPaste code: ")).toBe(url);
		}
	});

	it("handles EOF and ANSI delimiters but rejects a different OAuth client", () => {
		expect(new AgyAuthUrlParser().push(url, true)).toBe(url);
		expect(new AgyAuthUrlParser().push(`${url}\x1b[0m`)).toBe(url);
		expect(() => new AgyAuthUrlParser().push("https://accounts.google.com/auth?client_id=wrong\n")).toThrow(
			"unexpected OAuth client",
		);
		expect(() => new AgyAuthUrlParser().push("x".repeat(65 * 1024))).toThrow("limit");
	});

	it("accepts codes and callback URLs, not failed callbacks or multiline input", () => {
		expect(agyAuthorizationCode("  fixture-code  ")).toBe("fixture-code");
		expect(agyAuthorizationCode("http://localhost/callback?code=one%2Btwo&state=fixture")).toBe("one+two");
		expect(() => agyAuthorizationCode("http://localhost/callback?error=access_denied")).toThrow();
		expect(() => agyAuthorizationCode("one\ntwo")).toThrow();
	});
});

describe("Antigravity CLI login handoff", () => {
	it.skipIf(process.platform === "win32")(
		"exports ACP app-data credentials, suppresses child errors, and cancels pending input",
		async () => {
			const root = await fs.mkdtemp(path.join(os.tmpdir(), "agy-login-"));
			directories.push(root);
			const executable = path.join(root, "fixture-agy");
			await fs.writeFile(
				executable,
				`#!${process.execPath}
import * as fs from "node:fs/promises";
import * as path from "node:path";
if (process.env.SSH_TTY !== "omp-agy-file-auth") process.exit(9);
const args = process.argv.slice(2);
const appData = args[args.indexOf("--app-data-dir") + 1];
process.stdout.write("https://accounts.google.com/o/oauth2/v2/auth?client_id=${AGY_OAUTH_CLIENT_ID}&state=fixture\\n");
const code = (await Bun.stdin.text()).trim();
if (code !== "fixture-code") process.exit(8);
if (process.env.FIXTURE_MODE === "failure") {
	process.stderr.write("secret-native-error-payload");
	process.exit(1);
}
await fs.mkdir(appData, {recursive: true, mode: 0o700});
await fs.writeFile(path.join(appData, "antigravity-oauth-token"), JSON.stringify({
	token: ${JSON.stringify(stored.token)}, auth_method: "consumer", id_token_email: "account@example.test"
}), {mode: 0o600});
`,
				{ mode: 0o700 },
			);
			const moduleUrl = new URL("../src/registry/oauth/antigravity-cli.ts", import.meta.url).href;
			for (const mode of ["success", "failure", "cancel"]) {
				const runner = `
import { loginAntigravityCli } from ${JSON.stringify(moduleUrl)};
const controller = new AbortController();
try {
	const credentials = await loginAntigravityCli({
		signal: controller.signal,
		onAuth: () => { if (process.env.FIXTURE_MODE === "cancel") controller.abort("secret-cancel-reason"); },
		onPrompt: async () => (process.env.FIXTURE_MODE === "cancel" ? new Promise(() => {}) : "fixture-code")
	});
	console.log(JSON.stringify({
		realGrant: typeof credentials === "object" && credentials.refresh === "fixture-refresh",
		identity: credentials.email === "account@example.test"
	}));
} catch (error) {
	console.log(JSON.stringify({error: String(error)}));
}
`;
				const child = Bun.spawn([process.execPath, "--eval", runner], {
					env: {
						...process.env,
						HOME: root,
						USERPROFILE: root,
						PI_CONFIG_DIR: ".omp-fixture",
						PI_CODING_AGENT_DIR: path.join(root, "agent"),
						PI_AGY_PATH: executable,
						FIXTURE_MODE: mode,
					},
					stdout: "pipe",
					stderr: "pipe",
				});
				try {
					const text = await new Response(child.stdout).text();
					const stderr = await new Response(child.stderr).text();
					expect(await child.exited).toBe(0);
					expect(text + stderr).not.toContain("secret-");
					expect(text + stderr).not.toContain("fixture-refresh");
					const result = JSON.parse(text);
					if (mode === "success") expect(result).toEqual({ realGrant: true, identity: true });
					else expect(result.error).toContain(mode === "cancel" ? "cancelled" : "sign-in failed");
				} finally {
					child.kill("SIGKILL");
				}
			}
		},
		15_000,
	);
});

describe("Antigravity CLI refresh", () => {
	it("uses the installed consumer client and preserves unrotated grant metadata", async () => {
		const refreshed = await refreshAgyCredentials(grant, undefined, async (url, init) => {
			expect(String(url)).toBe("https://oauth2.googleapis.com/token");
			const body = new URLSearchParams(String(init?.body));
			expect(body.get("client_id")).toBe(AGY_OAUTH_CLIENT_ID);
			expect(body.get("grant_type")).toBe("refresh_token");
			expect(body.get("refresh_token")).toBe(grant.refresh);
			expect(body.get("client_secret")).toBeTruthy();
			return Response.json({ access_token: "new-access", expires_in: 3600 });
		});
		expect(refreshed.access).toBe("new-access");
		expect(refreshed.refresh).toBe(grant.refresh);
		expect(refreshed.accountId).toBe(grant.accountId);
		expect(refreshed.email).toBe(grant.email);
		expect(refreshed.expires).toBeGreaterThan(Date.now() + 3_000_000);
	});

	it("retains rotated refresh tokens and rejects malformed success bodies", async () => {
		const rotated = await refreshAgyCredentials(grant, undefined, async () =>
			Response.json({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 }),
		);
		expect(rotated.refresh).toBe("new-refresh");
		for (const body of [
			null,
			{},
			{ access_token: "secret", expires_in: -1 },
			{ access_token: "secret", expires_in: "3600" },
			{ access_token: "secret", expires_in: 3600, refresh_token: "" },
		]) {
			await expect(refreshAgyCredentials(grant, undefined, async () => Response.json(body))).rejects.toThrow(
				"invalid token response",
			);
		}
	});

	it("classifies revoked grants but never exposes provider response payloads", async () => {
		for (const [status, code, definitive] of [
			[400, "invalid_grant", true],
			[401, "unknown", true],
			[403, "secret-provider-error", false],
			[429, "invalid_grant", false],
			[503, "invalid_grant", false],
		] as const) {
			try {
				await refreshAgyCredentials(grant, undefined, async () =>
					Response.json({ error: code, error_description: "secret-provider-payload" }, { status }),
				);
				throw new Error("unexpected success");
			} catch (error) {
				expect(String(error)).not.toContain("secret-provider");
				expect(isDefinitiveOAuthFailure(String(error))).toBe(definitive);
			}
		}
		await expect(
			refreshAgyCredentials(grant, undefined, async () => new Response("secret-html", { status: 401 })),
		).rejects.toThrow("HTTP 401");
	});

	it("does not send sentinel grants, pre-aborted work, or leaking network errors", async () => {
		let calls = 0;
		const fetchImpl = async () => {
			calls++;
			throw new Error("secret-network-payload");
		};
		await expect(refreshAgyCredentials({ ...grant, refresh: "__remote__" }, undefined, fetchImpl)).rejects.toThrow(
			"credential owner",
		);
		await expect(refreshAgyCredentials(grant, AbortSignal.abort("secret-reason"), fetchImpl)).rejects.toThrow(
			"cancelled",
		);
		expect(calls).toBe(0);
		try {
			await refreshAgyCredentials(grant, undefined, fetchImpl);
		} catch (error) {
			expect(String(error)).not.toContain("secret-network-payload");
		}
	});
});

describe("Antigravity CLI Gemini Enterprise (gcp)", () => {
	const gcpGrant: OAuthCredentials = {
		...grant,
		projectId: "konsai-labs",
		region: "global",
	};
	const gcpApiKey = JSON.stringify({
		token: gcpGrant.access,
		refreshToken: gcpGrant.refresh,
		expiresAt: gcpGrant.expires,
		email: gcpGrant.email,
		accountId: gcpGrant.accountId,
		projectId: gcpGrant.projectId,
		region: gcpGrant.region,
	});

	it("isolates credential key and version between consumer and gcp accounts", () => {
		expect(agyCredentialKey(gcpApiKey)).not.toBe(agyCredentialKey(apiKey));
		expect(agyCredentialVersion(gcpApiKey)).not.toBe(agyCredentialVersion(apiKey));
		const usKey = JSON.stringify({ ...JSON.parse(gcpApiKey), region: "us-central1" });
		expect(agyCredentialVersion(usKey)).not.toBe(agyCredentialVersion(gcpApiKey));
	});

	it("stages both antigravity-oauth-token (gcp) and settings.json for enterprise grants", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-gcp-stage-"));
		directories.push(dir);
		await stageAgyCredentials(gcpApiKey, dir);

		const stagedToken = JSON.parse(
			await fs.readFile(path.join(dir, "antigravity-cli", "antigravity-oauth-token"), "utf8"),
		);
		expect(stagedToken.auth_method).toBe("gcp");
		expect(stagedToken.project_id).toBe("konsai-labs");
		expect(stagedToken.region).toBe("global");
		expect(stagedToken.id_token_email).toBe(gcpGrant.email);
		expect(stagedToken.token.access_token).toBe(gcpGrant.access);

		const settings = JSON.parse(await fs.readFile(path.join(dir, "antigravity-cli", "settings.json"), "utf8"));
		expect(settings).toEqual({ gcp: { project: "konsai-labs", location: "global" } });
	});

	it("refreshes gcp credentials with AGY_GCP_OAUTH_CLIENT_ID and preserves projectId/region", async () => {
		const refreshed = await refreshAgyCredentials(gcpGrant, undefined, async (_url, init) => {
			const body = new URLSearchParams(String(init?.body));
			expect(body.get("client_id")).toBe(AGY_GCP_OAUTH_CLIENT_ID);
			expect(body.get("client_secret")).toBeTruthy();
			expect(body.get("grant_type")).toBe("refresh_token");
			return Response.json({ access_token: "new-gcp-access", expires_in: 3600 });
		});
		expect(refreshed.access).toBe("new-gcp-access");
		expect(refreshed.projectId).toBe("konsai-labs");
		expect(refreshed.region).toBe("global");
	});

	it("preserves projectId and region in structured API key from getOAuthApiKey", async () => {
		const result = await getOAuthApiKey("antigravity-cli", {
			"antigravity-cli": gcpGrant,
		});
		expect(result).not.toBeNull();
		const parsed = parseAgyApiKey(result!.apiKey);
		expect(parsed.projectId).toBe("konsai-labs");
		expect(parsed.region).toBe("global");
	});

	it("runs enterprise loginAntigravityGcp flow with PKCE and exchanges code for OAuthCredentials", async () => {
		const prompts = ["konsai-labs", ""];
		let capturedUrl = "";
		const creds = await loginAntigravityGcp({
			onPrompt: async () => prompts.shift() ?? "auth-code-123",
			onAuth: info => {
				capturedUrl = info.url;
			},
			onManualCodeInput: async () => {
				const matchedState = new URL(capturedUrl).searchParams.get("state");
				expect(matchedState).toBeTruthy();
				return `${AGY_GCP_OAUTH_REDIRECT_URI}?code=enterprise-code-42&state=${matchedState}`;
			},
			fetch: async (url, init) => {
				expect(String(url)).toBe("https://oauth2.googleapis.com/token");
				const body = new URLSearchParams(String(init?.body));
				expect(body.get("client_id")).toBe(AGY_GCP_OAUTH_CLIENT_ID);
				expect(body.get("code")).toBe("enterprise-code-42");
				expect(body.get("redirect_uri")).toBe(AGY_GCP_OAUTH_REDIRECT_URI);
				expect(body.get("code_verifier")).toBeTruthy();
				expect(body.get("grant_type")).toBe("authorization_code");
				return Response.json({
					access_token: "gcp-access",
					refresh_token: "gcp-refresh",
					expires_in: 3600,
					id_token: idToken,
				});
			},
		});

		const authUrl = new URL(capturedUrl);
		expect(authUrl.origin + authUrl.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
		expect(authUrl.searchParams.get("client_id")).toBe(AGY_GCP_OAUTH_CLIENT_ID);
		expect(authUrl.searchParams.get("redirect_uri")).toBe(AGY_GCP_OAUTH_REDIRECT_URI);
		expect(authUrl.searchParams.get("code_challenge_method")).toBe("S256");
		expect(authUrl.searchParams.get("code_challenge")).toBeTruthy();
		expect(authUrl.searchParams.get("scope")?.split(" ")).toEqual([
			"https://www.googleapis.com/auth/cloud-platform",
			"https://www.googleapis.com/auth/userinfo.email",
			"https://www.googleapis.com/auth/userinfo.profile",
			"https://www.googleapis.com/auth/cclog",
			"https://www.googleapis.com/auth/experimentsandconfigs",
			"openid",
		]);

		expect(creds.access).toBe("gcp-access");
		expect(creds.refresh).toBe("gcp-refresh");
		expect(creds.email).toBe(grant.email);
		expect(creds.accountId).toBe(grant.accountId);
		expect(creds.projectId).toBe("konsai-labs");
		expect(creds.region).toBe("global");
	});

	it("validates OAuth state in callback URLs for enterprise loginAntigravityGcp", async () => {
		let capturedUrl = "";
		const matchPrompts = ["konsai-labs", ""];
		const matched = await loginAntigravityGcp({
			onPrompt: async () => matchPrompts.shift() ?? "",
			onAuth: info => {
				capturedUrl = info.url;
			},
			onManualCodeInput: async () => {
				const matchedState = new URL(capturedUrl).searchParams.get("state");
				expect(matchedState).toBeTruthy();
				return `${AGY_GCP_OAUTH_REDIRECT_URI}?code=enterprise-code-ok&state=${matchedState}`;
			},
			fetch: async () =>
				Response.json({
					access_token: "gcp-access",
					refresh_token: "gcp-refresh",
					expires_in: 3600,
					id_token: idToken,
				}),
		});
		expect(matched.access).toBe("gcp-access");

		const mismatchPrompts = ["konsai-labs", ""];
		await expect(
			loginAntigravityGcp({
				onPrompt: async () => mismatchPrompts.shift() ?? "",
				onAuth: () => {},
				onManualCodeInput: async () => `${AGY_GCP_OAUTH_REDIRECT_URI}?code=enterprise-code-bad&state=wrong-state`,
				fetch: async () => {
					throw new Error("fetch should not be called on state mismatch");
				},
			}),
		).rejects.toThrow("Antigravity CLI OAuth state mismatch");

		const missingStatePrompts = ["konsai-labs", ""];
		await expect(
			loginAntigravityGcp({
				onPrompt: async () => missingStatePrompts.shift() ?? "",
				onAuth: () => {},
				onManualCodeInput: async () => `${AGY_GCP_OAUTH_REDIRECT_URI}?code=enterprise-code-no-state`,
				fetch: async () => {
					throw new Error("fetch should not be called on missing state");
				},
			}),
		).rejects.toThrow("Antigravity CLI OAuth state mismatch");
	});

	it("rejects loginAntigravityGcp when onPrompt is missing or signal is pre-aborted", async () => {
		await expect(loginAntigravityGcp({})).rejects.toThrow("requires");
		await expect(
			loginAntigravityGcp({
				signal: AbortSignal.abort("cancelled"),
				onPrompt: async () => "konsai-labs",
			}),
		).rejects.toThrow("cancelled");
	});

	it("rejects empty project ID, supports onPrompt-only fallback, and trims whitespace env candidates", async () => {
		Bun.env.GOOGLE_CLOUD_PROJECT = "   ";
		Bun.env.GCP_PROJECT = " env-gcp-proj ";
		delete Bun.env.GCLOUD_PROJECT;

		const seenPrompts: Array<{ message: string; secret?: boolean; placeholder?: string }> = [];
		const answers = ["", "us-central1", "bare-auth-code"];
		const creds = await loginAntigravityGcp({
			onPrompt: async prompt => {
				seenPrompts.push({ message: prompt.message, secret: prompt.secret, placeholder: prompt.placeholder });
				return answers.shift() ?? "";
			},
			onAuth: () => {},
			fetch: async () =>
				Response.json({
					access_token: "gcp-access",
					refresh_token: "gcp-refresh",
					expires_in: 3600,
					id_token: idToken,
				}),
		});
		expect(creds.projectId).toBe("env-gcp-proj");
		expect(creds.region).toBe("us-central1");
		expect(seenPrompts[0]?.placeholder).toBe("env-gcp-proj");
		expect(seenPrompts[2]?.secret).toBeUndefined();

		delete Bun.env.GOOGLE_CLOUD_PROJECT;
		delete Bun.env.GCP_PROJECT;
		await expect(
			loginAntigravityGcp({
				onPrompt: async () => "   ",
			}),
		).rejects.toThrow("Project ID is required");
	});

	it("validates exchangeAgyGcpCode response fields and identity claims", async () => {
		for (const body of [
			{ access_token: "a", expires_in: 3600, id_token: idToken },
			{ access_token: "a", refresh_token: "__remote__", expires_in: 3600, id_token: idToken },
			{ access_token: "a", refresh_token: "r", expires_in: 0, id_token: idToken },
			{ access_token: "a", refresh_token: "r", expires_in: 3600 },
		]) {
			await expect(
				exchangeAgyGcpCode(
					{ code: "c", codeVerifier: "v", projectId: "konsai-labs", region: "global" },
					undefined,
					async () => Response.json(body),
				),
			).rejects.toThrow();
		}
	});

	it("updates staged settings.json when enterprise region changes", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-gcp-region-"));
		directories.push(dir);
		await stageAgyCredentials(gcpApiKey, dir);
		const usKey = JSON.stringify({ ...JSON.parse(gcpApiKey), region: "us-central1" });
		await stageAgyCredentials(usKey, dir);
		const settings = JSON.parse(await fs.readFile(path.join(dir, "antigravity-cli", "settings.json"), "utf8"));
		expect(settings).toEqual({ gcp: { project: "konsai-labs", location: "us-central1" } });
	});

	it("coexists consumer and multiple enterprise projects on one Google email and detects region edits", async () => {
		const store = new SqliteAuthCredentialStore(new Database(":memory:"));
		const storage = new AuthStorage(store);
		try {
			await storage.credentials.reload();
			const consumer = { type: "oauth" as const, ...grant };
			const projA = { type: "oauth" as const, ...gcpGrant, projectId: "proj-a", region: "global" };
			const projB = { type: "oauth" as const, ...gcpGrant, projectId: "proj-b", region: "us-central1" };
			await store.upsertAuthCredential("antigravity-cli", consumer);
			await store.upsertAuthCredential("antigravity-cli", projA);
			await store.upsertAuthCredential("antigravity-cli", projB);
			await store.upsertAuthCredential("antigravity-cli", { ...projA, access: "proj-a-refreshed" });
			await storage.credentials.reload();

			const rows = storage.credentials.list("antigravity-cli");
			expect(rows).toHaveLength(3);
			expect(
				rows.map(row =>
					row.credential.type === "oauth"
						? `${row.credential.projectId ?? "consumer"}:${row.credential.access}`
						: "",
				),
			).toEqual(["consumer:fixture-access", "proj-a:proj-a-refreshed", "proj-b:fixture-access"]);

			expect(isSameOAuthAccount(consumer, projA, "antigravity-cli")).toBe(false);
			expect(isSameOAuthAccount(projA, projB, "antigravity-cli")).toBe(false);
			expect(isSameOAuthAccount(projA, { ...projA, access: "other" }, "antigravity-cli")).toBe(true);
			expect(authCredentialEquals(projA, { ...projA, region: "us-central1" })).toBe(false);
		} finally {
			storage.close();
		}
	});
});
