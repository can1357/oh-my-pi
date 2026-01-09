/**
 * Credential storage for API keys and OAuth tokens.
 * Handles loading, saving, and refreshing credentials from auth.json.
 */

import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
	getEnvApiKey,
	getOAuthApiKey,
	loginAnthropic,
	loginAntigravity,
	loginGeminiCli,
	loginGitHubCopilot,
	loginOpenAICodex,
	type OAuthCredentials,
	type OAuthProvider,
} from "@oh-my-pi/pi-ai";
import { logger } from "./logger";

export type ApiKeyCredential = {
	type: "api_key";
	key: string;
};

export type OAuthCredential = {
	type: "oauth";
} & OAuthCredentials;

export type AuthCredential = ApiKeyCredential | OAuthCredential;

export type AuthStorageData = Record<string, AuthCredential>;

/**
 * Credential storage backed by a JSON file.
 * Reads from multiple fallback paths, writes to primary path.
 */
export class AuthStorage {
	private data: AuthStorageData = {};
	private runtimeOverrides: Map<string, string> = new Map();
	private fallbackResolver?: (provider: string) => string | undefined;

	/**
	 * @param authPath - Primary path for reading/writing auth.json
	 * @param fallbackPaths - Additional paths to check when reading (legacy support)
	 */
	constructor(private authPath: string, private fallbackPaths: string[] = []) {}

	/**
	 * Set a runtime API key override (not persisted to disk).
	 * Used for CLI --api-key flag.
	 */
	setRuntimeApiKey(provider: string, apiKey: string): void {
		this.runtimeOverrides.set(provider, apiKey);
	}

	/**
	 * Remove a runtime API key override.
	 */
	removeRuntimeApiKey(provider: string): void {
		this.runtimeOverrides.delete(provider);
	}

	/**
	 * Set a fallback resolver for API keys not found in auth.json or env vars.
	 * Used for custom provider keys from models.json.
	 */
	setFallbackResolver(resolver: (provider: string) => string | undefined): void {
		this.fallbackResolver = resolver;
	}

	/**
	 * Reload credentials from disk.
	 * Checks primary path first, then fallback paths.
	 */
	async reload(): Promise<void> {
		const pathsToCheck = [this.authPath, ...this.fallbackPaths];

		logger.debug("AuthStorage.reload checking paths", { paths: pathsToCheck });

		for (const authPath of pathsToCheck) {
			const exists = existsSync(authPath);
			logger.debug("AuthStorage.reload path check", { path: authPath, exists });

			if (exists) {
				try {
					this.data = JSON.parse(readFileSync(authPath, "utf-8"));
					logger.debug("AuthStorage.reload loaded", { path: authPath, providers: Object.keys(this.data) });
					return;
				} catch (e) {
					logger.error("AuthStorage failed to parse auth file", { path: authPath, error: String(e) });
					// Continue to next path on parse error
				}
			}
		}

		logger.warn("AuthStorage no auth file found", { checkedPaths: pathsToCheck });
		this.data = {};
	}

	/**
	 * Save credentials to disk.
	 */
	private async save(): Promise<void> {
		writeFileSync(this.authPath, JSON.stringify(this.data, null, 2));
		chmodSync(this.authPath, 0o600);
		const dir = dirname(this.authPath);
		chmodSync(dir, 0o700);
	}

	/**
	 * Get credential for a provider.
	 */
	get(provider: string): AuthCredential | undefined {
		return this.data[provider] ?? undefined;
	}

	/**
	 * Set credential for a provider.
	 */
	async set(provider: string, credential: AuthCredential): Promise<void> {
		this.data[provider] = credential;
		await this.save();
	}

	/**
	 * Remove credential for a provider.
	 */
	async remove(provider: string): Promise<void> {
		delete this.data[provider];
		await this.save();
	}

	/**
	 * List all providers with credentials.
	 */
	list(): string[] {
		return Object.keys(this.data);
	}

	/**
	 * Check if credentials exist for a provider in auth.json.
	 */
	has(provider: string): boolean {
		return provider in this.data;
	}

	/**
	 * Check if any form of auth is configured for a provider.
	 * Unlike getApiKey(), this doesn't refresh OAuth tokens.
	 */
	hasAuth(provider: string): boolean {
		if (this.runtimeOverrides.has(provider)) return true;
		if (this.data[provider]) return true;
		if (getEnvApiKey(provider)) return true;
		if (this.fallbackResolver?.(provider)) return true;
		return false;
	}

	/**
	 * Get all credentials (for passing to getOAuthApiKey).
	 */
	getAll(): AuthStorageData {
		return { ...this.data };
	}

	/**
	 * Login to an OAuth provider.
	 */
	async login(
		provider: OAuthProvider,
		callbacks: {
			onAuth: (info: { url: string; instructions?: string }) => void;
			onPrompt: (prompt: { message: string; placeholder?: string }) => Promise<string>;
			onProgress?: (message: string) => void;
		}
	): Promise<void> {
		let credentials: OAuthCredentials;

		switch (provider) {
			case "anthropic":
				credentials = await loginAnthropic(
					(url) => callbacks.onAuth({ url }),
					() => callbacks.onPrompt({ message: "Paste the authorization code:" })
				);
				break;
			case "github-copilot":
				credentials = await loginGitHubCopilot({
					onAuth: (url, instructions) => callbacks.onAuth({ url, instructions }),
					onPrompt: callbacks.onPrompt,
					onProgress: callbacks.onProgress,
				});
				break;
			case "google-gemini-cli":
				credentials = await loginGeminiCli(callbacks.onAuth, callbacks.onProgress);
				break;
			case "google-antigravity":
				credentials = await loginAntigravity(callbacks.onAuth, callbacks.onProgress);
				break;
			case "openai-codex":
				credentials = await loginOpenAICodex(callbacks);
				break;
			default:
				throw new Error(`Unknown OAuth provider: ${provider}`);
		}

		await this.set(provider, { type: "oauth", ...credentials });
	}

	/**
	 * Logout from a provider.
	 */
	async logout(provider: string): Promise<void> {
		await this.remove(provider);
	}

	/**
	 * Get API key for a provider.
	 * Priority:
	 * 1. Runtime override (CLI --api-key)
	 * 2. API key from auth.json
	 * 3. OAuth token from auth.json (auto-refreshed)
	 * 4. Environment variable
	 * 5. Fallback resolver (models.json custom providers)
	 */
	async getApiKey(provider: string): Promise<string | undefined> {
		// Runtime override takes highest priority
		const runtimeKey = this.runtimeOverrides.get(provider);
		if (runtimeKey) {
			return runtimeKey;
		}

		const cred = this.data[provider];

		if (cred?.type === "api_key") {
			return cred.key;
		}

		if (cred?.type === "oauth") {
			// Filter to only oauth credentials for getOAuthApiKey
			const oauthCreds: Record<string, OAuthCredentials> = {};
			for (const [key, value] of Object.entries(this.data)) {
				if (value.type === "oauth") {
					oauthCreds[key] = value;
				}
			}

			try {
				const result = await getOAuthApiKey(provider as OAuthProvider, oauthCreds);
				if (result) {
					this.data[provider] = { type: "oauth", ...result.newCredentials };
					await this.save();
					return result.apiKey;
				}
			} catch {
				await this.remove(provider);
			}
		}

		// Fall back to environment variable
		const envKey = getEnvApiKey(provider);
		if (envKey) return envKey;

		// Fall back to custom resolver (e.g., models.json custom providers)
		return this.fallbackResolver?.(provider) ?? undefined;
	}
}
