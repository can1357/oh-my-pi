/**
 * Test helper for resolving API keys from ~/.omp/agent/auth.json
 *
 * Supports both API key and OAuth credentials.
 * OAuth tokens are automatically refreshed if expired and saved back to auth.json.
 */

import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { getOAuthApiKey } from "../src/utils/oauth/index";
import type { OAuthCredentials, OAuthProvider } from "../src/utils/oauth/types";

const AUTH_PATH = join(homedir(), ".omp", "agent", "auth.json");

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
	const file = Bun.file(AUTH_PATH);
	if (!(await file.exists())) {
		return {};
	}
	try {
		return await file.json();
	} catch {
		return {};
	}
}

async function saveAuthStorage(storage: AuthStorage): Promise<void> {
	const configDir = dirname(AUTH_PATH);
	await Bun.write(join(configDir, ".keep"), "");
	await Bun.write(AUTH_PATH, JSON.stringify(storage, null, 2));
	await Bun.spawn(["chmod", "600", AUTH_PATH]).exited;
}

/**
 * Resolve API key for a provider from ~/.omp/agent/auth.json
 *
 * For API key credentials, returns the key directly.
 * For OAuth credentials, returns the access token (refreshing if expired and saving back).
 *
 * For google-gemini-cli and google-antigravity, returns JSON-encoded { token, projectId }
 */
export async function resolveApiKey(provider: string): Promise<string | undefined> {
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

		// Save refreshed credentials back to auth.json
		storage[provider] = { type: "oauth", ...result.newCredentials };
		await saveAuthStorage(storage);

		return result.apiKey;
	}

	return undefined;
}
