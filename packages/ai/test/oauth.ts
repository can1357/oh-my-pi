/**
 * Test helper for resolving API keys from ~/.omp/agent/testauth.db
 *
 * Supports both API key and OAuth credentials.
 * OAuth tokens are automatically refreshed if expired and saved back to testauth.db.
 *
 * E2E tests are disabled by default. Set E2E=1 environment variable to enable.
 */
import * as fs from "node:fs/promises";
import path from "node:path";
import { getOAuthApiKey } from "@oh-my-pi/pi-ai/oauth";
import type { OAuthCredentials, OAuthProvider } from "@oh-my-pi/pi-ai/oauth/types";
import { $flag, getAgentDir, isEnoent } from "@oh-my-pi/pi-utils";

/**
 * E2E tests require explicit opt-in via E2E=1 environment variable.
 * This prevents accidental API calls when keys happen to be in the environment.
 */
const E2E_ENABLED = $flag("E2E");

/**
 * Get an API key from environment, but only if E2E tests are enabled.
 * Use this in skipIf conditions: `describe.skipIf(!e2eApiKey("OPENAI_API_KEY"))(...)`
 */
export function e2eApiKey(envVar: string): string | undefined {
	if (!E2E_ENABLED) return undefined;
	return Bun.env[envVar];
}

const AUTH_PATH = path.join(getAgentDir(), "testauth.db");

type ApiKeyCredential = {
	type: "api_key";
	key: string;
};

type OAuthCredentialEntry = {
	type: "oauth";
} & OAuthCredentials;

type AuthCredential = ApiKeyCredential | OAuthCredentialEntry;

type AuthStorage = Record<string, AuthCredential>;

async function loadAuthStorage(): Promise<AuthStorage> {
	try {
		const content = await Bun.file(AUTH_PATH).text();
		return JSON.parse(content);
	} catch (err) {
		if (isEnoent(err)) return {};
		throw err;
	}
}

async function saveAuthStorage(storage: AuthStorage): Promise<void> {
	await Bun.write(AUTH_PATH, JSON.stringify(storage, null, 2));
	await fs.chmod(AUTH_PATH, 0o600);
}

/**
 * Resolve API key for a provider from ~/.omp/agent/testauth.db
 *
 * For API key credentials, returns the key directly.
 * For OAuth credentials, returns the access token (refreshing if expired and saving back).
 *
 * For google-gemini-cli and google-antigravity, returns JSON-encoded { token, projectId }
 */
export async function resolveApiKey(provider: string): Promise<string | undefined> {
	if (!E2E_ENABLED) return undefined;

	const storage = await loadAuthStorage();
	const entry = storage[provider];

	if (!entry) return undefined;

	if (entry.type === "api_key") {
		return entry.key;
	}

	if (entry.type === "oauth") {
		// Build OAuthCredentials record for getOAuthApiKey
		const oauthCredentials: Record<string, OAuthCredentials> = {};
		for (const [key, value] of Object.entries(storage)) {
			if (value.type === "oauth") {
				const { type: _, ...creds } = value;
				oauthCredentials[key] = creds;
			}
		}

		const result = await getOAuthApiKey(provider as OAuthProvider, oauthCredentials);
		if (!result) return undefined;

		// Save refreshed credentials back to testauth.db
		storage[provider] = { type: "oauth", ...result.newCredentials };
		await saveAuthStorage(storage);

		return result.apiKey;
	}

	return undefined;
}
