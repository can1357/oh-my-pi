import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import * as oauthUtils from "@oh-my-pi/pi-ai/oauth";
import {
	collectDisabledCredentialNotices,
	formatCredentialDisabledNotice,
} from "@oh-my-pi/pi-coding-agent/config/credential-notices";

const SUPPRESS_ANTHROPIC_ENV = ["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN"] as const;
const savedEnv: Partial<Record<(typeof SUPPRESS_ANTHROPIC_ENV)[number], string | undefined>> = {};

const oauthCredential = (expires: number) => ({
	type: "oauth" as const,
	access: "access-token",
	refresh: "refresh-token",
	expires,
	email: "signed-out@example.com",
	accountId: "acct-1",
});

describe("credential sign-out notices", () => {
	let tempDir = "";
	let authStorage: AuthStorage | undefined;

	beforeEach(() => {
		for (const key of SUPPRESS_ANTHROPIC_ENV) {
			savedEnv[key] = process.env[key];
			delete process.env[key];
		}
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "credential-notices-"));
	});

	afterEach(() => {
		vi.restoreAllMocks();
		authStorage?.close();
		fs.rmSync(tempDir, { recursive: true, force: true });
		for (const key of SUPPRESS_ANTHROPIC_ENV) {
			if (savedEnv[key] === undefined) delete process.env[key];
			else process.env[key] = savedEnv[key];
		}
	});

	it("replays an automatic sign-out at startup until the account signs in again", async () => {
		authStorage = await AuthStorage.create(path.join(tempDir, "agent.db"));
		await authStorage.set("anthropic", [oauthCredential(Date.now() - 60_000)]);
		vi.spyOn(oauthUtils, "refreshOAuthToken").mockImplementation(async () => {
			throw new Error('HTTP 400 invalid_grant {"error":"invalid_grant","error_description":"grant revoked"}');
		});
		expect(await authStorage.getApiKey("anthropic", "session")).toBeUndefined();

		const notices = await collectDisabledCredentialNotices(authStorage, Date.now());
		expect(notices).toHaveLength(1);
		expect(notices[0]).toContain("anthropic signed-out@example.com was signed out");
		expect(notices[0]).toContain("grant revoked");
		expect(notices[0]).toContain("/login anthropic");

		await authStorage.set("anthropic", [oauthCredential(Date.now() + 3_600_000)]);
		expect(await collectDisabledCredentialNotices(authStorage, Date.now())).toEqual([]);
	});

	it("never lets a failed tombstone listing break startup", async () => {
		authStorage = await AuthStorage.create(path.join(tempDir, "agent.db"));
		vi.spyOn(authStorage, "listActionableDisabledCredentials").mockRejectedValue(new Error("broker offline"));

		expect(await collectDisabledCredentialNotices(authStorage, Date.now())).toEqual([]);
	});

	it("names the account, the cause, and the way back in for a live teardown", () => {
		expect(
			formatCredentialDisabledNotice({
				provider: "openai-codex",
				credentialId: 16,
				credentialType: "oauth",
				email: "signed-out@example.com",
				orgName: "Example Org",
				disabledCause: "oauth refresh failed: OAuthError: invalid_grant; refresh token expired",
			}),
		).toBe(
			"Signed out of openai-codex signed-out@example.com · Example Org: OAuthError: invalid_grant. Sign in again with /login openai-codex.",
		);
		expect(
			formatCredentialDisabledNotice({
				provider: "kagi",
				credentialId: 2,
				credentialType: "api_key",
				disabledCause: "disabled via auth-broker",
			}),
		).toBe("Signed out of kagi API key: disabled via auth-broker. Sign in again with /login kagi.");
	});
});
