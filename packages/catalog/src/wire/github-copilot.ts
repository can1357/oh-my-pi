import { USER_AGENT } from "@oh-my-pi/pi-utils";
import { LRUCache } from "@oh-my-pi/pi-utils/lru";
import type { FetchImpl } from "../types";
import { isRecord } from "../utils";

/**
 * GitHub Copilot wire metadata: API-key envelope parsing and endpoint
 * derivation shared by catalog discovery and the pi-ai OAuth flow. The device
 * login / token refresh flow lives in `@oh-my-pi/pi-ai`'s registry.
 */
const COPILOT_CLI_VERSION = "1.0.82";
const COPILOT_CLI_USER_AGENT = `copilot/${COPILOT_CLI_VERSION}`;

/** Headers sent by Copilot CLI to GitHub API and OAuth endpoints. */
export const COPILOT_GITHUB_HEADERS = {
	"User-Agent": COPILOT_CLI_USER_AGENT,
} as const;

/** Copilot CLI identity sent to the Copilot API. */
export const COPILOT_CAPI_IDENTITY_HEADERS = {
	...COPILOT_GITHUB_HEADERS,
	"Editor-Version": COPILOT_CLI_USER_AGENT,
	"Copilot-Integration-Id": "copilot-developer-cli",
	"Copilot-Harness-Id": "copilot-sdk",
	"Openai-Intent": "conversation-agent",
} as const;

/** Chat identity used when Copilot CLI entitlement is not active on the subscription. */
export const COPILOT_CHAT_IDENTITY_HEADERS = {
	"User-Agent": USER_AGENT,
	"Openai-Intent": "conversation-edits",
} as const;

const copilotCliDisabledTokens = new LRUCache<string, boolean>({ max: 64, ttl: 24 * 60 * 60 * 1000 });

export function markCopilotCliDisabled(token?: string): void {
	if (token?.trim()) {
		copilotCliDisabledTokens.set(token.trim(), true);
	}
}

export function isCopilotCliDisabled(token?: string): boolean {
	if (!token?.trim()) return false;
	return copilotCliDisabledTokens.get(token.trim()) === true;
}

export function clearCopilotCliDisabled(token?: string): void {
	if (token?.trim()) {
		copilotCliDisabledTokens.delete(token.trim());
	} else {
		copilotCliDisabledTokens.clear();
	}
}

export function getCopilotCapiIdentityHeaders(options?: { cliDisabled?: boolean }): Record<string, string> {
	if (options?.cliDisabled) {
		return { ...COPILOT_CHAT_IDENTITY_HEADERS };
	}
	return { ...COPILOT_CAPI_IDENTITY_HEADERS };
}
/**
 * Copilot API version sent on `api.githubcopilot.com` requests (`/models`,
 * chat endpoints). Newer versions unlock tiered context metadata: `/models`
 * reports the full long-context window in `capabilities.limits` plus per-tier
 * boundaries/prices under `billing.token_prices.{default,long_context}`.
 * Without it the endpoint serves default-tier limits only (e.g. 264k instead
 * of 1M for Claude Opus). Never send this to `api.github.com` REST endpoints —
 * they validate `X-GitHub-Api-Version` against the REST version vocabulary.
 */
export const COPILOT_API_VERSION = "2026-08-01" as const;

/** Headers shared by Copilot API model requests and model definitions. */
export const COPILOT_API_HEADERS = {
	...COPILOT_CAPI_IDENTITY_HEADERS,
	"X-GitHub-Api-Version": COPILOT_API_VERSION,
} as const;
/** Copilot CLI headers for user-initiated model discovery. */
export const COPILOT_DISCOVERY_HEADERS = {
	...COPILOT_API_HEADERS,
	"X-Initiator": "user",
} as const;

const MANAGED_COPILOT_HEADER_NAMES: Record<string, true> = {
	"user-agent": true,
	"editor-version": true,
	"editor-plugin-version": true,
	"copilot-integration-id": true,
	"copilot-harness-id": true,
	"openai-intent": true,
	"x-github-api-version": true,
	"x-initiator": true,
	"x-interaction-type": true,
};
export function sanitizeCopilotHeaders(headers?: Readonly<Record<string, string>>): Record<string, string> {
	const result: Record<string, string> = {};
	if (headers) {
		for (const [key, value] of Object.entries(headers)) {
			if (value !== undefined && !MANAGED_COPILOT_HEADER_NAMES[key.toLowerCase()]) {
				result[key] = value;
			}
		}
	}
	return result;
}
function getHeaderCaseInsensitive(
	headers: Readonly<Record<string, string>> | undefined,
	name: string,
): string | undefined {
	if (!headers) return undefined;
	const lower = name.toLowerCase();
	for (const key of Object.keys(headers)) {
		if (key.toLowerCase() === lower) return headers[key];
	}
	return undefined;
}

/** Preserve model-specific headers while enforcing the current Copilot API identity. */
export function mergeCopilotApiHeaders(
	headers?: Readonly<Record<string, string>>,
	options?: { cliDisabled?: boolean },
): Record<string, string> {
	const baseIdentity = getCopilotCapiIdentityHeaders(options);
	const custom = sanitizeCopilotHeaders(headers);
	const initiator = getHeaderCaseInsensitive(headers, "x-initiator");
	const interactionType = getHeaderCaseInsensitive(headers, "x-interaction-type");
	return {
		...custom,
		...baseIdentity,
		"X-GitHub-Api-Version": COPILOT_API_VERSION,
		...(initiator ? { "X-Initiator": initiator } : {}),
		...(interactionType ? { "X-Interaction-Type": interactionType } : {}),
	};
}

type GitHubCopilotApiKeyPayload = {
	token?: unknown;
	enterpriseUrl?: unknown;
	apiEndpoint?: unknown;
	cliDisabled?: unknown;
	cli_enabled?: unknown;
	cliEnabled?: unknown;
};

export type ParsedGitHubCopilotApiKey = {
	accessToken: string;
	enterpriseUrl?: string;
	apiEndpoint?: string;
	cliDisabled?: boolean;
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
				...COPILOT_GITHUB_HEADERS,
			},
			signal,
		});
		if (!response.ok) return undefined;
		const data: unknown = await response.json();
		if (!isRecord(data)) return undefined;
		if (data.cli_enabled === false) {
			markCopilotCliDisabled(token);
		} else if (data.cli_enabled === true) {
			clearCopilotCliDisabled(token);
		}
		if (!isRecord(data.endpoints)) return undefined;
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
			if (parsed.cli_enabled === true || parsed.cliEnabled === true) {
				clearCopilotCliDisabled(parsed.token);
			}
			const cliDisabled =
				parsed.cli_enabled === true || parsed.cliEnabled === true
					? false
					: parsed.cliDisabled === true ||
						parsed.cli_enabled === false ||
						parsed.cliEnabled === false ||
						isCopilotCliDisabled(parsed.token);
			if (cliDisabled) {
				markCopilotCliDisabled(parsed.token);
			}
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
				cliDisabled: cliDisabled ? true : undefined,
			};
		}
	} catch {}

	return {
		accessToken: apiKeyRaw,
		cliDisabled: isCopilotCliDisabled(apiKeyRaw) ? true : undefined,
	};
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
