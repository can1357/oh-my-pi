import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Buffer } from "node:buffer";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { __resetVertexTokenCache, getVertexAccessToken, userAdcPath } from "../../src/providers/google-auth";
import type { FetchImpl } from "../../src/types";

const CLOUD_PLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform";
const JWT_BEARER_GRANT = "urn:ietf:params:oauth:grant-type:jwt-bearer";

/** Generate a real RS256 private key so signJwtRs256 / pemToPkcs8 run for real. */
async function generateServiceAccountPem(): Promise<string> {
	const keyPair = (await globalThis.crypto.subtle.generateKey(
		{ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
		true,
		["sign", "verify"],
	)) as CryptoKeyPair;
	const pkcs8 = new Uint8Array(await globalThis.crypto.subtle.exportKey("pkcs8", keyPair.privateKey));
	const body = (
		Buffer.from(pkcs8)
			.toString("base64")
			.match(/.{1,64}/g) ?? []
	).join("\n");
	return `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----\n`;
}

function urlOf(input: string | URL | Request): string {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.toString();
	return input.url;
}

describe("getVertexAccessToken impersonated_service_account ADC", () => {
	let tmpDir: string;
	let originalGac: string | undefined;

	beforeEach(async () => {
		__resetVertexTokenCache();
		originalGac = Bun.env.GOOGLE_APPLICATION_CREDENTIALS;
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-vertex-adc-"));
	});

	afterEach(async () => {
		__resetVertexTokenCache();
		if (originalGac === undefined) delete Bun.env.GOOGLE_APPLICATION_CREDENTIALS;
		else Bun.env.GOOGLE_APPLICATION_CREDENTIALS = originalGac;
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	it("rejects a malformed service_account_impersonation_url before any network call", async () => {
		const adcPath = path.join(tmpDir, "impersonated-bad-url.json");
		await Bun.write(
			adcPath,
			JSON.stringify({
				type: "impersonated_service_account",
				// Missing the trailing ":generateAccessToken" the principal parser requires.
				service_account_impersonation_url:
					"https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/target@project.iam.gserviceaccount.com",
				source_credentials: {
					type: "authorized_user",
					client_id: "client-id",
					client_secret: "client-secret",
					refresh_token: "refresh-token",
				},
			}),
		);
		Bun.env.GOOGLE_APPLICATION_CREDENTIALS = adcPath;

		const calls: string[] = [];
		const fetchImpl: FetchImpl = async input => {
			calls.push(urlOf(input));
			return new Response("{}");
		};

		// The principal is parsed before the source exchange, so a bad URL must fail
		// up front rather than after burning a source-token round trip.
		await expect(getVertexAccessToken({ fetch: fetchImpl })).rejects.toBeInstanceOf(RangeError);
		expect(calls).toEqual([]);
	});

	it("signs an RS256 JWT for a service_account source and reconstructs the IAM URL", async () => {
		const pem = await generateServiceAccountPem();
		const adcPath = path.join(tmpDir, "impersonated-sa.json");
		await Bun.write(
			adcPath,
			JSON.stringify({
				type: "impersonated_service_account",
				// Non-canonical project segment proves the request URL is rebuilt, not echoed.
				service_account_impersonation_url:
					"https://iamcredentials.googleapis.com/v1/projects/explicit-proj/serviceAccounts/target@project.iam.gserviceaccount.com:generateAccessToken",
				source_credentials: {
					type: "service_account",
					client_email: "source@project.iam.gserviceaccount.com",
					private_key: pem,
					private_key_id: "key-1",
				},
				// delegates intentionally omitted — the IAM body must default to [].
			}),
		);
		Bun.env.GOOGLE_APPLICATION_CREDENTIALS = adcPath;

		const calls: { url: string; init?: RequestInit }[] = [];
		const fetchImpl: FetchImpl = async (input, init) => {
			const url = urlOf(input);
			calls.push({ url, init });
			if (url === "https://oauth2.googleapis.com/token") {
				return new Response(JSON.stringify({ access_token: "sa-source-token", expires_in: 3600 }));
			}
			if (url.startsWith("https://iamcredentials.googleapis.com/")) {
				return new Response(
					JSON.stringify({
						accessToken: "impersonated-token",
						expireTime: new Date(Date.now() + 3_600_000).toISOString(),
					}),
				);
			}
			return new Response("unexpected", { status: 404 });
		};

		const token = await getVertexAccessToken({ fetch: fetchImpl });
		expect(token).toBe("impersonated-token");

		// Source JWT exchange happens first, then the impersonation exchange.
		expect(calls.map(c => c.url)).toEqual([
			"https://oauth2.googleapis.com/token",
			"https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/target@project.iam.gserviceaccount.com:generateAccessToken",
		]);

		// Source credential is exchanged via a signed JWT bearer assertion, not a refresh grant.
		const sourceBody = new URLSearchParams(String(calls[0].init?.body));
		expect(sourceBody.get("grant_type")).toBe(JWT_BEARER_GRANT);
		expect((sourceBody.get("assertion") ?? "").split(".")).toHaveLength(3);

		// The IAM call carries the source-derived bearer token and defaults delegates to [].
		const iamHeaders = calls[1].init?.headers as Record<string, string>;
		expect(iamHeaders.Authorization).toBe("Bearer sa-source-token");
		expect(JSON.parse(String(calls[1].init?.body))).toEqual({
			delegates: [],
			scope: [CLOUD_PLATFORM_SCOPE],
			lifetime: "3600s",
		});
	});
});

describe("gcloud user ADC location", () => {
	const ENV_KEYS = [
		"APPDATA",
		"GOOGLE_APPLICATION_CREDENTIALS",
		"GOOGLE_CLOUD_ACCESS_TOKEN",
		"CLOUDSDK_AUTH_ACCESS_TOKEN",
	];
	let tmpDir: string;
	let originalEnv: Record<string, string | undefined>;

	beforeEach(async () => {
		__resetVertexTokenCache();
		originalEnv = Object.fromEntries(ENV_KEYS.map(key => [key, Bun.env[key]]));
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-vertex-user-adc-"));
	});

	afterEach(async () => {
		__resetVertexTokenCache();
		for (const key of ENV_KEYS) {
			const original = originalEnv[key];
			if (original === undefined) delete Bun.env[key];
			else Bun.env[key] = original;
		}
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	it("resolves under %APPDATA%\\gcloud on win32", () => {
		expect(userAdcPath("win32", "C:\\Users\\me\\AppData\\Roaming")).toBe(
			path.join("C:\\Users\\me\\AppData\\Roaming", "gcloud", "application_default_credentials.json"),
		);
	});

	it("resolves under ~/.config/gcloud off Windows", () => {
		expect(userAdcPath("linux", "C:\\ignored")).toBe(
			path.join(os.homedir(), ".config", "gcloud", "application_default_credentials.json"),
		);
	});

	it.skipIf(process.platform !== "win32")(
		"exchanges the refresh token from %APPDATA% gcloud ADC on Windows",
		async () => {
			Bun.env.APPDATA = tmpDir;
			delete Bun.env.GOOGLE_APPLICATION_CREDENTIALS;
			delete Bun.env.GOOGLE_CLOUD_ACCESS_TOKEN;
			delete Bun.env.CLOUDSDK_AUTH_ACCESS_TOKEN;
			await Bun.write(
				path.join(tmpDir, "gcloud", "application_default_credentials.json"),
				JSON.stringify({
					type: "authorized_user",
					client_id: "client-id",
					client_secret: "client-secret",
					refresh_token: "refresh-token",
				}),
			);

			const calls: { url: string; init?: RequestInit }[] = [];
			const fetchImpl: FetchImpl = async (input, init) => {
				const url = urlOf(input);
				calls.push({ url, init });
				if (url === "https://oauth2.googleapis.com/token") {
					return new Response(JSON.stringify({ access_token: "user-adc-token", expires_in: 3600 }));
				}
				return new Response("not found", { status: 404 });
			};

			expect(await getVertexAccessToken({ fetch: fetchImpl })).toBe("user-adc-token");
			const tokenCalls = calls.filter(call => call.url === "https://oauth2.googleapis.com/token");
			expect(tokenCalls).toHaveLength(1);
			const body = new URLSearchParams(String(tokenCalls[0].init?.body));
			expect(body.get("grant_type")).toBe("refresh_token");
			expect(body.get("refresh_token")).toBe("refresh-token");
		},
	);
});
