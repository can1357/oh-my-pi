import type { FetchImpl } from "../types";
import { isRecord } from "../utils";

/**
 * GitHub Copilot wire metadata: API-key envelope parsing and endpoint
 * derivation shared by catalog discovery and the pi-ai OAuth flow. The device
 * login / token refresh flow lives in `@oh-my-pi/pi-ai`'s registry.
 */

export const COPILOT_USER_AGENT = "opencode/1.3.15" as const;

export const OPENCODE_HEADERS = {
	"User-Agent": COPILOT_USER_AGENT,
} as const;

/**
 * Copilot API version sent on `api.githubcopilot.com` requests (`/models`,
 * chat endpoints). Newer versions unlock tiered context metadata: `/models`
 * reports the full long-context window in `capabilities.limits` plus per-tier
 * boundaries/prices under `billing.token_prices.{default,long_context}`.
 * Without it the endpoint serves default-tier limits only (e.g. 264k instead
 * of 1M for Claude Opus). Never send this to `api.github.com` REST endpoints —
 * they validate `X-GitHub-Api-Version` against the REST version vocabulary.
 */
export const COPILOT_API_VERSION = "2026-06-01" as const;

/** Headers for `api.githubcopilot.com` (capi) requests: discovery, chat, policy. */
export const COPILOT_API_HEADERS = {
	...OPENCODE_HEADERS,
	"X-GitHub-Api-Version": COPILOT_API_VERSION,
} as const;

type GitHubCopilotApiKeyPayload = {
	token?: unknown;
	enterpriseUrl?: unknown;
	apiEndpoint?: unknown;
};

export type ParsedGitHubCopilotApiKey = {
	accessToken: string;
	enterpriseUrl?: string;
	apiEndpoint?: string;
};

const PUBLIC_GITHUB_HOSTS = new Set(["api.github.com", "github.com", "www.github.com"]);

export function isPublicGitHubHost(host: string): boolean {
	return PUBLIC_GITHUB_HOSTS.has(host.trim().toLowerCase());
}

/** Canonical personal-Copilot API host. */
export const PERSONAL_GITHUB_COPILOT_BASE_URL = "https://api.githubcopilot.com" as const;

/** `true` when the resolved base URL is the canonical personal-Copilot host. */
export function isPersonalGitHubCopilotBaseUrl(baseUrl: string | undefined): boolean {
	return baseUrl === PERSONAL_GITHUB_COPILOT_BASE_URL;
}

export function normalizeGitHubCopilotEnterpriseDomain(input: string | undefined): string | undefined {
	const trimmed = input?.trim();
	if (!trimmed) return undefined;
	const normalized = normalizeDomain(trimmed) ?? trimmed.toLowerCase();
	if (!normalized || isPublicGitHubHost(normalized)) return undefined;
	return normalized;
}

export function normalizeGitHubCopilotApiEndpoint(input: string | undefined): string | undefined {
	const trimmed = input?.trim();
	if (!trimmed?.startsWith("https://")) return undefined;
	try {
		const url = new URL(trimmed);
		if (url.protocol !== "https:" || !url.hostname) return undefined;
		return trimmed.replace(/\/+$/, "");
	} catch {
		return undefined;
	}
}
/**
 * Resolve the plan-specific Copilot API endpoint advertised for a GitHub token.
 * Login and raw environment-token discovery share this best-effort probe. Pass
 * a `signal` to bound it against the same discovery deadline as `/models`; a
 * stalled probe otherwise blocks discovery indefinitely.
 */
export async function discoverGitHubCopilotApiEndpoint(
	token: string,
	fetchImpl: FetchImpl,
	signal?: AbortSignal,
): Promise<string | undefined> {
	try {
		const response = await fetchImpl("https://api.github.com/copilot_internal/user", {
			headers: {
				Accept: "application/json",
				Authorization: `token ${token}`,
				...OPENCODE_HEADERS,
			},
			signal,
		});
		if (!response.ok) return undefined;
		const data: unknown = await response.json();
		if (!isRecord(data) || !isRecord(data.endpoints)) return undefined;
		const endpoint = data.endpoints.api;
		return typeof endpoint === "string" ? normalizeGitHubCopilotApiEndpoint(endpoint) : undefined;
	} catch {
		return undefined;
	}
}

export function parseGitHubCopilotApiKey(apiKeyRaw: string): ParsedGitHubCopilotApiKey {
	try {
		const parsed = JSON.parse(apiKeyRaw) as GitHubCopilotApiKeyPayload;
		if (typeof parsed.token === "string") {
			return {
				accessToken: parsed.token,
				enterpriseUrl:
					typeof parsed.enterpriseUrl === "string"
						? normalizeGitHubCopilotEnterpriseDomain(parsed.enterpriseUrl)
						: undefined,
				apiEndpoint:
					typeof parsed.apiEndpoint === "string"
						? normalizeGitHubCopilotApiEndpoint(parsed.apiEndpoint)
						: undefined,
			};
		}
	} catch {}

	return { accessToken: apiKeyRaw };
}

export function normalizeDomain(input: string): string | null {
	const trimmed = input.trim();
	if (!trimmed) return null;
	try {
		const url = trimmed.includes("://") ? new URL(trimmed) : new URL(`https://${trimmed}`);
		return url.hostname;
	} catch {
		return null;
	}
}

export function getGitHubCopilotBaseUrl(enterpriseDomain?: string): string {
	const normalizedEnterpriseDomain = normalizeGitHubCopilotEnterpriseDomain(enterpriseDomain);
	if (!normalizedEnterpriseDomain) return "https://api.githubcopilot.com";
	const host = normalizedEnterpriseDomain.startsWith("copilot-api.")
		? normalizedEnterpriseDomain
		: `copilot-api.${normalizedEnterpriseDomain}`;
	return `https://${host}`;
}
