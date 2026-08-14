/**
 * Factory Droid (Droid Core) OAuth — WorkOS device-code flow.
 *
 * A public WorkOS user-management client with RFC 8628 device
 * authorization, no localhost callback server. Users approve at
 * https://auth.factory.ai/device with a
 * short user code; the returned access/refresh pair is what Factory's
 * subscription LLM proxy accepts as `Bearer` (Factory API keys are
 * control-plane only and do not authorize inference).
 */

import { factoryDroidApiBaseUrl } from "@oh-my-pi/pi-catalog/discovery";
import * as AIError from "../../error";
import type { FetchImpl } from "../../types";
import { isRecord } from "../../utils";
import { type OAuthDeviceCodePollResult, pollOAuthDeviceCodeFlow } from "./device-code";
import type { OAuthController, OAuthCredentials } from "./types";

const WORKOS_BASE_URL = "https://api.workos.com/user_management";
/** Public WorkOS client id for Droid device authorization. */
const WORKOS_CLIENT_ID = "client_01HNM792M5G5G1A2THWPXKFMXB";
const TOKEN_REQUEST_TIMEOUT_MS = 15_000;

interface DeviceAuthorization {
	deviceCode: string;
	userCode: string;
	verificationUri: string;
	verificationUriComplete: string;
	intervalSeconds: number;
	expiresInSeconds: number;
}

interface TokenResponse {
	accessToken: string;
	refreshToken: string;
	email?: string;
	orgId?: string;
	accountId?: string;
}

async function requestDeviceAuthorization(fetchImpl: FetchImpl, signal?: AbortSignal): Promise<DeviceAuthorization> {
	const response = await fetchImpl(`${WORKOS_BASE_URL}/authorize/device`, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
		body: new URLSearchParams({ client_id: WORKOS_CLIENT_ID }),
		signal: signal ?? AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
	});
	if (!response.ok) {
		throw new AIError.OAuthError(`Factory device authorization failed: ${response.status}`, {
			kind: "device-auth",
			status: response.status,
		});
	}
	const body: unknown = await response.json();
	if (
		!isRecord(body) ||
		typeof body.device_code !== "string" ||
		typeof body.user_code !== "string" ||
		typeof body.verification_uri !== "string"
	) {
		throw new AIError.OAuthError("Factory device authorization returned an unexpected payload", {
			kind: "validation",
		});
	}
	return {
		deviceCode: body.device_code,
		userCode: body.user_code,
		verificationUri: body.verification_uri,
		verificationUriComplete:
			typeof body.verification_uri_complete === "string" ? body.verification_uri_complete : body.verification_uri,
		intervalSeconds: typeof body.interval === "number" ? body.interval : 5,
		expiresInSeconds: typeof body.expires_in === "number" ? body.expires_in : 300,
	};
}

async function pollDeviceToken(
	deviceCode: string,
	fetchImpl: FetchImpl,
	signal?: AbortSignal,
): Promise<OAuthDeviceCodePollResult<TokenResponse>> {
	const response = await fetchImpl(`${WORKOS_BASE_URL}/authenticate`, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
		body: new URLSearchParams({
			grant_type: "urn:ietf:params:oauth:grant-type:device_code",
			device_code: deviceCode,
			client_id: WORKOS_CLIENT_ID,
		}),
		signal: signal ?? AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
	});
	const body: unknown = await response.json().catch(() => undefined);
	if (response.ok) {
		if (!isRecord(body) || typeof body.access_token !== "string" || typeof body.refresh_token !== "string") {
			return { status: "failed", message: "Factory token response missing access/refresh tokens" };
		}
		return { status: "complete", value: readTokenResponse(body) };
	}
	const error = isRecord(body) && typeof body.error === "string" ? body.error : "unknown";
	switch (error) {
		case "authorization_pending":
			return { status: "pending" };
		case "slow_down":
			return { status: "slow_down" };
		case "expired_token":
		case "access_denied":
			return {
				status: "failed",
				message: `Factory device login ${error === "access_denied" ? "was denied" : "expired"}`,
			};
		default:
			return { status: "failed", message: `Factory device login failed: ${error} (${response.status})` };
	}
}

/** WorkOS wraps identity in a `user` object on token responses. */
function readTokenResponse(body: Record<string, unknown>): TokenResponse {
	const accessToken = body.access_token as string;
	const refreshToken = body.refresh_token as string;
	const user = isRecord(body.user) ? body.user : undefined;
	const claims = decodeJwtClaims(accessToken);
	return {
		accessToken,
		refreshToken,
		email:
			(typeof user?.email === "string" ? user.email : undefined) ??
			(typeof claims?.email === "string" ? claims.email : undefined),
		accountId:
			(typeof user?.id === "string" ? user.id : undefined) ??
			(typeof claims?.sub === "string" ? claims.sub : undefined),
		// X-Factory-Org-Id carries the external (Factory-side) org id, not the
		// WorkOS-internal `org_01…` id that `organization_id` returns.
		orgId:
			(typeof claims?.external_org_id === "string" ? claims.external_org_id : undefined) ??
			(typeof body.organization_id === "string" ? body.organization_id : undefined),
	};
}

function decodeJwtClaims(token: string): Record<string, unknown> | null {
	const [, segment] = token.split(".");
	if (!segment) return null;
	try {
		const decoded: unknown = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
		return isRecord(decoded) ? decoded : null;
	} catch {
		return null;
	}
}

function toCredentials(tokens: TokenResponse): OAuthCredentials {
	const claims = decodeJwtClaims(tokens.accessToken);
	const expires = typeof claims?.exp === "number" ? claims.exp * 1000 : Date.now() + 24 * 60 * 60 * 1000;
	return {
		refresh: tokens.refreshToken,
		access: tokens.accessToken,
		expires,
		email: tokens.email,
		accountId: tokens.accountId,
		orgId: tokens.orgId,
	};
}

/**
 * Account residency region from `GET /api/cli/whoami` (the CLI's `X4L`).
 * Best-effort: a failed or region-less response leaves the region undefined,
 * which every consumer treats as the default "global" region — the CLI
 * behaves the same way. The whoami call always targets the default host
 * because the region is unknown until the call returns.
 */
async function fetchRegion(
	fetchImpl: FetchImpl,
	accessToken: string,
	signal?: AbortSignal,
): Promise<string | undefined> {
	try {
		const response = await fetchImpl(`${factoryDroidApiBaseUrl(undefined)}/api/cli/whoami`, {
			headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
			signal: signal ?? AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
		});
		if (!response.ok) return undefined;
		const body: unknown = await response.json();
		if (isRecord(body) && typeof body.region === "string" && body.region.length > 0) {
			return body.region;
		}
	} catch {
		// Best-effort: region stays undefined (global) on any failure.
	}
	return undefined;
}

/** Login with Factory Droid via the WorkOS device-code flow (headless-friendly, no callback port). */
export async function loginFactoryDroid(ctrl: OAuthController): Promise<OAuthCredentials> {
	const fetchImpl = ctrl.fetch ?? fetch;
	ctrl.onProgress?.("Requesting Factory device code…");
	const device = await requestDeviceAuthorization(fetchImpl, ctrl.signal);
	ctrl.onAuth?.({
		url: device.verificationUriComplete,
		instructions: `Enter code: ${device.userCode}`,
	});
	ctrl.onProgress?.("Waiting for Factory authorization…");
	const tokens = await pollOAuthDeviceCodeFlow({
		poll: () => pollDeviceToken(device.deviceCode, fetchImpl),
		intervalSeconds: device.intervalSeconds,
		expiresInSeconds: device.expiresInSeconds,
		signal: ctrl.signal,
	});
	const credentials = toCredentials(tokens);
	const region = await fetchRegion(fetchImpl, credentials.access, ctrl.signal);
	return region === undefined ? credentials : { ...credentials, region };
}

/** Refresh a stored Factory Droid WorkOS session. */
export async function refreshFactoryDroidToken(
	refreshToken: string,
	fetchOverride?: FetchImpl,
): Promise<OAuthCredentials> {
	const fetchImpl = fetchOverride ?? fetch;
	const response = await fetchImpl(`${WORKOS_BASE_URL}/authenticate`, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
		body: new URLSearchParams({
			grant_type: "refresh_token",
			refresh_token: refreshToken,
			client_id: WORKOS_CLIENT_ID,
		}),
		signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
	});
	const body: unknown = await response.json().catch(() => undefined);
	if (!response.ok) {
		const error = isRecord(body) && typeof body.error === "string" ? body.error : response.statusText;
		throw new AIError.OAuthError(`Factory token refresh failed: ${error}`, {
			kind: "token-refresh",
			status: response.status,
		});
	}
	if (!isRecord(body) || typeof body.access_token !== "string" || typeof body.refresh_token !== "string") {
		throw new AIError.OAuthError("Factory token refresh returned an unexpected payload", { kind: "validation" });
	}
	const credentials = toCredentials(readTokenResponse(body));
	// Mirror the CLI, which re-reads whoami on every token refresh: an account
	// migrated between regions picks up the new region here, and the
	// auth-storage merge falls back to the prior region when this call fails.
	const region = await fetchRegion(fetchImpl, credentials.access);
	return region === undefined ? credentials : { ...credentials, region };
}

/** Extract the bearer token for the LLM proxy from stored credentials. */
export function getFactoryDroidApiKey(credentials: OAuthCredentials): string {
	return credentials.access;
}
