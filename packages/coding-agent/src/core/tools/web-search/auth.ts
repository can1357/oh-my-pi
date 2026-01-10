/**
 * Anthropic Authentication
 *
 * 4-tier auth resolution:
 *   1. ANTHROPIC_SEARCH_API_KEY / ANTHROPIC_SEARCH_BASE_URL env vars
 *   2. Provider with api="anthropic-messages" in ~/.omp/agent/models.json
 *   3. OAuth credentials in ~/.omp/agent/auth.json (with expiry check)
 *   4. ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL fallback
 */

import * as os from "node:os";
import * as path from "node:path";
import { buildBetaHeader, claudeCodeHeaders, claudeCodeVersion } from "@oh-my-pi/pi-ai";
import { getConfigDirPaths } from "../../../config";
import type { AnthropicAuthConfig, AnthropicOAuthCredential, AuthJson, ModelsJson } from "./types";

const DEFAULT_BASE_URL = "https://api.anthropic.com";

/** Parse a .env file and return key-value pairs */
async function parseEnvFile(filePath: string): Promise<Record<string, string>> {
	const result: Record<string, string> = {};
	try {
		const file = Bun.file(filePath);
		if (!(await file.exists())) return result;

		const content = await file.text();
		for (const line of content.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith("#")) continue;

			const eqIndex = trimmed.indexOf("=");
			if (eqIndex === -1) continue;

			const key = trimmed.slice(0, eqIndex).trim();
			let value = trimmed.slice(eqIndex + 1).trim();

			// Remove surrounding quotes
			if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
				value = value.slice(1, -1);
			}

			result[key] = value;
		}
	} catch {
		// Ignore read errors
	}
	return result;
}

/** Get env var from process.env or .env files */
export async function getEnv(key: string): Promise<string | undefined> {
	if (process.env[key]) return process.env[key];

	const localEnv = await parseEnvFile(`${process.cwd()}/.env`);
	if (localEnv[key]) return localEnv[key];

	const homeEnv = await parseEnvFile(`${os.homedir()}/.env`);
	if (homeEnv[key]) return homeEnv[key];

	return undefined;
}

/** Read JSON file safely */
async function readJson<T>(filePath: string): Promise<T | null> {
	try {
		const file = Bun.file(filePath);
		if (!(await file.exists())) return null;
		const content = await file.text();
		return JSON.parse(content) as T;
	} catch {
		return null;
	}
}

/** Check if a token is an OAuth token (sk-ant-oat* prefix) */
export function isOAuthToken(apiKey: string): boolean {
	return apiKey.includes("sk-ant-oat");
}

function normalizeAnthropicOAuthCredentials(entry: AuthJson["anthropic"] | undefined): AnthropicOAuthCredential[] {
	if (!entry) return [];
	return Array.isArray(entry) ? entry : [entry];
}

/**
 * Find Anthropic auth config using 4-tier priority:
 *   1. ANTHROPIC_SEARCH_API_KEY / ANTHROPIC_SEARCH_BASE_URL
 *   2. Provider with api="anthropic-messages" in models.json
 *   3. OAuth in auth.json (with 5-minute expiry buffer)
 *   4. ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL fallback
 */
export async function findAnthropicAuth(): Promise<AnthropicAuthConfig | null> {
	// Get all config directories (user-level only) for fallback support
	const configDirs = getConfigDirPaths("", { project: false });

	// 1. Explicit search-specific env vars
	const searchApiKey = await getEnv("ANTHROPIC_SEARCH_API_KEY");
	const searchBaseUrl = await getEnv("ANTHROPIC_SEARCH_BASE_URL");
	if (searchApiKey) {
		return {
			apiKey: searchApiKey,
			baseUrl: searchBaseUrl ?? DEFAULT_BASE_URL,
			isOAuth: isOAuthToken(searchApiKey),
		};
	}

	// 2. Provider with api="anthropic-messages" in models.json (check all config dirs)
	for (const configDir of configDirs) {
		const modelsJson = await readJson<ModelsJson>(path.join(configDir, "models.json"));
		if (modelsJson?.providers) {
			// First pass: look for providers with actual API keys
			for (const [_name, provider] of Object.entries(modelsJson.providers)) {
				if (provider.api === "anthropic-messages" && provider.apiKey && provider.apiKey !== "none") {
					return {
						apiKey: provider.apiKey,
						baseUrl: provider.baseUrl ?? DEFAULT_BASE_URL,
						isOAuth: isOAuthToken(provider.apiKey),
					};
				}
			}
			// Second pass: check for proxy mode (baseUrl but apiKey="none")
			for (const [_name, provider] of Object.entries(modelsJson.providers)) {
				if (provider.api === "anthropic-messages" && provider.baseUrl) {
					return {
						apiKey: provider.apiKey ?? "",
						baseUrl: provider.baseUrl,
						isOAuth: false,
					};
				}
			}
		}
	}

	// 3. OAuth credentials in auth.json (with 5-minute expiry buffer, check all config dirs)
	const expiryBuffer = 5 * 60 * 1000; // 5 minutes
	const now = Date.now();
	for (const configDir of configDirs) {
		const authJson = await readJson<AuthJson>(path.join(configDir, "auth.json"));
		const credentials = normalizeAnthropicOAuthCredentials(authJson?.anthropic);
		for (const credential of credentials) {
			if (credential.type !== "oauth" || !credential.access) continue;
			if (credential.expires > now + expiryBuffer) {
				return {
					apiKey: credential.access,
					baseUrl: DEFAULT_BASE_URL,
					isOAuth: true,
				};
			}
		}
	}

	// 4. Generic ANTHROPIC_API_KEY fallback
	const apiKey = await getEnv("ANTHROPIC_API_KEY");
	const baseUrl = await getEnv("ANTHROPIC_BASE_URL");
	if (apiKey) {
		return {
			apiKey,
			baseUrl: baseUrl ?? DEFAULT_BASE_URL,
			isOAuth: isOAuthToken(apiKey),
		};
	}

	return null;
}

function isAnthropicBaseUrl(baseUrl: string): boolean {
	try {
		const url = new URL(baseUrl);
		return url.protocol === "https:" && url.hostname === "api.anthropic.com";
	} catch {
		return false;
	}
}

/** Build headers for Anthropic API request */
export function buildAnthropicHeaders(auth: AnthropicAuthConfig): Record<string, string> {
	const baseBetas = auth.isOAuth
		? [
				"claude-code-20250219",
				"oauth-2025-04-20",
				"interleaved-thinking-2025-05-14",
				"fine-grained-tool-streaming-2025-05-14",
			]
		: ["fine-grained-tool-streaming-2025-05-14"];
	const betaHeader = buildBetaHeader(baseBetas, ["web-search-2025-03-05"]);

	const headers: Record<string, string> = {
		accept: "application/json",
		"content-type": "application/json",
		"anthropic-dangerous-direct-browser-access": "true",
		"anthropic-beta": betaHeader,
		"user-agent": `claude-cli/${claudeCodeVersion} (external, cli)`,
		"x-app": "cli",
		"accept-encoding": "gzip, deflate, br, zstd",
		connection: "keep-alive",
		...claudeCodeHeaders,
	};

	if (auth.isOAuth || !isAnthropicBaseUrl(auth.baseUrl)) {
		headers.authorization = `Bearer ${auth.apiKey}`;
	} else {
		headers["x-api-key"] = auth.apiKey;
	}

	return headers;
}

/** Build API URL (OAuth requires ?beta=true) */
export function buildAnthropicUrl(auth: AnthropicAuthConfig): string {
	const base = `${auth.baseUrl}/v1/messages`;
	return `${base}?beta=true`;
}
