import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearAwsCredentialCache, resolveAwsCredentials } from "@oh-my-pi/pi-ai/providers/aws-credentials";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";

const ENV_KEYS = [
	"HOME",
	"USERPROFILE",
	"AWS_CONFIG_FILE",
	"AWS_SHARED_CREDENTIALS_FILE",
	"AWS_EC2_METADATA_DISABLED",
	"AWS_PROFILE",
	"AWS_DEFAULT_PROFILE",
	"AWS_REGION",
	"AWS_DEFAULT_REGION",
	"AWS_ACCESS_KEY_ID",
	"AWS_SECRET_ACCESS_KEY",
	"AWS_SESSION_TOKEN",
	"AWS_WEB_IDENTITY_TOKEN_FILE",
	"AWS_ROLE_ARN",
	"AWS_CONTAINER_CREDENTIALS_FULL_URI",
	"AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
] as const;
const HOME_KEY = process.platform === "win32" ? "USERPROFILE" : "HOME";
const TOKEN_FILE = "fixture-token.json";
const START_URL = "https://fixture.example/start";

interface CachedToken {
	startUrl: string;
	accessToken: string;
	expiresAt: string;
	refreshToken: string;
	clientId: string;
	clientSecret: string;
}

describe("AWS SSO token refresh when HOME changes mid-refresh", () => {
	let root = "";
	let savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};

	beforeEach(async () => {
		savedEnv = {};
		for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
		for (const key of ENV_KEYS) delete process.env[key];
		root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-sso-home-"));
		clearAwsCredentialCache();
	});

	afterEach(async () => {
		for (const key of ENV_KEYS) {
			const value = savedEnv[key];
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		clearAwsCredentialCache();
		await fs.rm(root, { recursive: true, force: true });
	});

	async function writeHome(home: string, token: CachedToken): Promise<string> {
		const cacheFile = path.join(home, ".aws", "sso", "cache", TOKEN_FILE);
		await fs.mkdir(path.dirname(cacheFile), { recursive: true });
		await fs.writeFile(
			path.join(home, ".aws", "config"),
			`[profile fixture]\nsso_start_url = ${START_URL}\nsso_region = us-east-1\nsso_account_id = 123456789012\nsso_role_name = Fixture\n`,
		);
		await fs.writeFile(cacheFile, JSON.stringify(token));
		return cacheFile;
	}

	it("writes the refreshed token back to the cache file it read, not to the new home's", async () => {
		const homeA = path.join(root, "home-a");
		const homeB = path.join(root, "home-b");
		const expired: CachedToken = {
			startUrl: START_URL,
			accessToken: "a-old",
			expiresAt: "2020-01-01T00:00:00Z",
			refreshToken: "a-refresh",
			clientId: "a-client",
			clientSecret: "a-secret",
		};
		const other: CachedToken = { ...expired, accessToken: "b-token", refreshToken: "b-refresh" };
		const fileA = await writeHome(homeA, expired);
		const fileB = await writeHome(homeB, other);
		process.env[HOME_KEY] = homeA;
		process.env.AWS_CONFIG_FILE = path.join(homeA, ".aws", "config");
		process.env.AWS_SHARED_CREDENTIALS_FILE = path.join(homeA, ".aws", "credentials");
		process.env.AWS_EC2_METADATA_DISABLED = "true";

		const tokenRequested = Promise.withResolvers<void>();
		const releaseToken = Promise.withResolvers<void>();
		const fetchImpl: FetchImpl = async input => {
			const url = new URL(String(input));
			if (url.pathname === "/token") {
				tokenRequested.resolve();
				await releaseToken.promise;
				return Response.json({ accessToken: "a-new", refreshToken: "a-rotated", expiresIn: 3600 });
			}
			return Response.json({
				roleCredentials: {
					accessKeyId: "role-key",
					secretAccessKey: "role-secret",
					sessionToken: "role-session",
					expiration: Date.now() + 3_600_000,
				},
			});
		};

		const pending = resolveAwsCredentials({ profile: "fixture", region: "us-east-1", fetch: fetchImpl });
		await tokenRequested.promise;
		process.env[HOME_KEY] = homeB;
		releaseToken.resolve();
		const credentials = await pending;

		expect(credentials.accessKeyId).toBe("role-key");
		const afterA = (await Bun.file(fileA).json()) as CachedToken;
		const afterB = (await Bun.file(fileB).json()) as CachedToken;
		expect(afterA.accessToken).toBe("a-new");
		expect(afterA.refreshToken).toBe("a-rotated");
		expect(afterB).toEqual(other);
	});
});
