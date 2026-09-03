/**
 * xAI OAuth endpoint discovery, identity, and billing helpers.
 */

import * as AIError from "../../error";
import type { FetchImpl } from "../../types";

const XAI_OAUTH_ISSUER = "https://auth.x.ai";
const XAI_OAUTH_DISCOVERY_URL = `${XAI_OAUTH_ISSUER}/.well-known/openid-configuration`;
const XAI_OAUTH_USERINFO_URL = `${XAI_OAUTH_ISSUER}/oauth2/userinfo`;
const XAI_CLI_BILLING_BASE_URL = "https://cli-chat-proxy.grok.com";
const XAI_CLI_BILLING_PATH = "/v1/billing";
const XAI_CLI_BILLING_FORMAT = "credits";

const DISCOVERY_TIMEOUT_MS = 15_000;

interface XAIOAuthDiscovery {
	token_endpoint: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/**
 * Validate an xAI OIDC endpoint against its scheme and host.
 *
 * The discovery response is long-lived and its token endpoint receives every
 * future refresh token. Rejecting non-HTTPS or non-`x.ai` / `*.x.ai` hosts
 * pins that endpoint to the xAI auth origin.
 *
 * @throws Error with message `Invalid xAI <field>: <url>` when the URL fails
 *         either scheme or host validation.
 */
function isXaiAuthHostname(host: string): boolean {
	return host === "x.ai" || host.endsWith(".x.ai");
}

/** SuperGrok CLI billing proxy host (`cli-chat-proxy.grok.com`), not the OIDC issuer. */
function isXaiBillingHostname(host: string): boolean {
	return host === "grok.com" || host.endsWith(".grok.com");
}

export function validateXAIEndpoint(url: string, field: string): string {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new AIError.OAuthError(`Invalid xAI ${field}: ${url}`, { kind: "validation", provider: "xai" });
	}
	if (parsed.protocol !== "https:") {
		throw new AIError.OAuthError(`Invalid xAI ${field}: ${url}`, { kind: "validation", provider: "xai" });
	}
	const host = parsed.hostname.toLowerCase();
	if (!host || !isXaiAuthHostname(host)) {
		throw new AIError.OAuthError(`Invalid xAI ${field}: ${url}`, { kind: "validation", provider: "xai" });
	}
	return url;
}

/**
 * Pin SuperGrok billing URLs to HTTPS `grok.com` / `*.grok.com`.
 * The CLI billing proxy is intentionally not on `*.x.ai`.
 */
export function validateXAIBillingEndpoint(url: string, field: string = "billing_url"): string {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new AIError.OAuthError(`Invalid xAI ${field}: ${url}`, { kind: "validation", provider: "xai" });
	}
	if (parsed.protocol !== "https:") {
		throw new AIError.OAuthError(`Invalid xAI ${field}: ${url}`, { kind: "validation", provider: "xai" });
	}
	const host = parsed.hostname.toLowerCase();
	if (!host || !isXaiBillingHostname(host)) {
		throw new AIError.OAuthError(`Invalid xAI ${field}: ${url}`, { kind: "validation", provider: "xai" });
	}
	return url;
}

/** Fetch xAI's OIDC discovery document and validate the token endpoint. */
async function xaiOAuthDiscovery(
	timeoutMs: number = DISCOVERY_TIMEOUT_MS,
	fetchOverride?: FetchImpl,
	signal?: AbortSignal,
): Promise<XAIOAuthDiscovery> {
	const fetchImpl = fetchOverride ?? fetch;
	let response: Response;
	try {
		response = await fetchImpl(XAI_OAUTH_DISCOVERY_URL, {
			method: "GET",
			headers: { Accept: "application/json" },
			signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
		});
	} catch (error) {
		throw new AIError.OAuthError(
			`xAI OIDC discovery failed: ${error instanceof Error ? error.message : String(error)}`,
			{
				kind: "discovery",
				provider: "xai",
				cause: error,
			},
		);
	}
	if (response.status !== 200) {
		throw new AIError.OAuthError(`xAI OIDC discovery returned status ${response.status}.`, {
			kind: "discovery",
			provider: "xai",
			status: response.status,
		});
	}
	let payload: unknown;
	try {
		payload = await response.json();
	} catch (error) {
		throw new AIError.OAuthError(
			`xAI OIDC discovery returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
			{ kind: "validation", provider: "xai", cause: error },
		);
	}
	if (!isRecord(payload)) {
		throw new AIError.OAuthError("xAI OIDC discovery response was not a JSON object.", {
			kind: "validation",
			provider: "xai",
		});
	}
	const tokenEndpoint = typeof payload.token_endpoint === "string" ? payload.token_endpoint.trim() : "";
	if (!tokenEndpoint) {
		throw new AIError.OAuthError("xAI OIDC discovery response was missing token_endpoint.", {
			kind: "validation",
			provider: "xai",
		});
	}
	validateXAIEndpoint(tokenEndpoint, "token_endpoint");
	return { token_endpoint: tokenEndpoint };
}

/** Discover and pin the xAI token endpoint used by login and refresh. */
export async function getXAITokenEndpoint(signal?: AbortSignal): Promise<string> {
	const discovery = await xaiOAuthDiscovery(DISCOVERY_TIMEOUT_MS, undefined, signal);
	return validateXAIEndpoint(discovery.token_endpoint, "token_endpoint");
}

/** Decode an xAI access-token JWT payload without verifying its signature. */
export function parseXAIAccessTokenPayload(jwt: string): Record<string, unknown> | null {
	try {
		if (typeof jwt !== "string" || !jwt.includes(".")) return null;
		const parts = jwt.split(".");
		if (parts.length < 2) return null;
		const payloadPart = parts[1];
		if (!payloadPart) return null;
		const decoded = Buffer.from(payloadPart, "base64url").toString("utf8");
		const payload = JSON.parse(decoded) as unknown;
		return isRecord(payload) && !Array.isArray(payload) ? payload : null;
	} catch {
		return null;
	}
}

/**
 * Check whether a JWT access token is at or past its `exp` claim (with an
 * optional refresh-skew margin).
 *
 * Returns `false` for malformed input because this is a refresh-trigger check,
 * not token validation.
 */
export function isXAIAccessTokenExpiring(jwt: string, skewSeconds: number = 0): boolean {
	const payload = parseXAIAccessTokenPayload(jwt);
	if (!payload) return false;
	const exp = payload.exp;
	if (typeof exp !== "number" || !Number.isFinite(exp)) return false;
	const now = Math.floor(Date.now() / 1000);
	const skew = Math.max(0, Math.floor(skewSeconds));
	return exp <= now + skew;
}

/** Extract the stable xAI subject UUID from an access token. */
export function extractXAIAccessTokenSubject(jwt: string): string | undefined {
	const sub = parseXAIAccessTokenPayload(jwt)?.sub;
	return typeof sub === "string" && sub.trim() ? sub.trim() : undefined;
}

export interface XAIOAuthIdentity {
	accountId?: string;
	email?: string;
	name?: string;
}

/** Fetch optional OIDC userinfo for a valid xAI access token. */
export async function fetchXAIOAuthIdentity(
	accessToken: string,
	fetchOverride?: FetchImpl,
	signal?: AbortSignal,
): Promise<XAIOAuthIdentity | null> {
	const token = accessToken.trim();
	if (!token) return null;
	const fetchImpl = fetchOverride ?? fetch;
	try {
		const response = await fetchImpl(XAI_OAUTH_USERINFO_URL, {
			method: "GET",
			headers: {
				Authorization: `Bearer ${token}`,
				Accept: "application/json",
			},
			redirect: "error",
			signal: signal
				? AbortSignal.any([signal, AbortSignal.timeout(DISCOVERY_TIMEOUT_MS)])
				: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
		});
		if (!response.ok) return null;
		const payload = (await response.json()) as unknown;
		if (!isRecord(payload) || Array.isArray(payload)) return null;
		const sub = typeof payload.sub === "string" && payload.sub.trim() ? payload.sub.trim() : undefined;
		const email = typeof payload.email === "string" && payload.email.trim() ? payload.email.trim() : undefined;
		const name = typeof payload.name === "string" && payload.name.trim() ? payload.name.trim() : undefined;
		if (!sub && !email && !name) return null;
		return {
			...(sub ? { accountId: sub } : {}),
			...(email ? { email: email.toLowerCase() } : {}),
			...(name ? { name } : {}),
		};
	} catch {
		return null;
	}
}

/** Build the SuperGrok CLI billing URL. Pass `""` to omit `format` (unified monthly payload). */
export function buildXAICliBillingUrl(format: string = XAI_CLI_BILLING_FORMAT): string {
	const url = new URL(XAI_CLI_BILLING_PATH, XAI_CLI_BILLING_BASE_URL);
	if (format) url.searchParams.set("format", format);
	return validateXAIBillingEndpoint(url.toString());
}

/**
 * Headers for SuperGrok CLI billing (`cli-chat-proxy.grok.com`).
 * Official Grok CLI also sends `X-XAI-Token-Auth: xai-grok-cli` on this host;
 * include it so billing stays on the same product gate as chat inference.
 */
export function getXAICliBillingHeaders(options: { accessToken: string }): Record<string, string> {
	return {
		Authorization: `Bearer ${options.accessToken}`,
		Accept: "application/json",
		"X-XAI-Token-Auth": "xai-grok-cli",
	};
}
