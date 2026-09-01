/**
 * Kimi Code OAuth flow (device authorization grant)
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import { $env, getAgentDir } from "@oh-my-pi/pi-utils";
import packageJson from "../../../package.json" with { type: "json" };
import * as AIError from "../../error";
import { isRecord } from "../../utils";
import type { OAuthController, OAuthCredentials } from "./types";

const CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098";
const DEFAULT_OAUTH_HOST = "https://auth.kimi.com";
const DEVICE_ID_FILENAME = "kimi-device-id";
const DEFAULT_POLL_INTERVAL_MS = 5000;
const DEFAULT_DEVICE_FLOW_TTL_MS = 15 * 60 * 1000;
const OAUTH_EXPIRY_SKEW_MS = 5 * 60 * 1000;

interface DeviceAuthorizationResponse {
	user_code?: string;
	device_code?: string;
	verification_uri?: string;
	verification_uri_complete?: string;
	expires_in?: number;
	interval?: number;
}

interface TokenResponse {
	access_token?: string;
	refresh_token?: string;
	expires_in?: number;
	scope?: string;
	token_type?: string;
	error?: string;
	error_description?: string;
	interval?: number;
}

function resolveOAuthHost(): string {
	return $env.KIMI_CODE_OAUTH_HOST || $env.KIMI_OAUTH_HOST || DEFAULT_OAUTH_HOST;
}

function formatDeviceModel(system: string, release: string, arch: string): string {
	return [system, release, arch].filter(Boolean).join(" ").trim();
}

function getDeviceModel(): string {
	const platform = os.platform();
	const release = os.release();
	const arch = os.arch();
	if (platform === "darwin") return formatDeviceModel("macOS", release, arch);
	if (platform === "win32") return formatDeviceModel("Windows", release, arch);
	const label = platform === "linux" ? "Linux" : platform;
	return formatDeviceModel(label, release, arch);
}

// Device id identifies this install to Kimi. Persistence is best-effort: a
// missing/unwritable agent dir must never break header construction (and with
// it every usage probe / request that spreads getKimiCommonHeaders()) — fall
// back to a per-process ephemeral id instead.
let getDeviceId = (): string => {
	const deviceIdPath = path.join(getAgentDir(), DEVICE_ID_FILENAME);
	try {
		const existing = fs.readFileSync(deviceIdPath, "utf-8").trim();
		if (existing) {
			getDeviceId = () => existing;
			return existing;
		}
	} catch {
		// Unreadable device-id file: regenerate below.
	}

	const deviceId = crypto.randomUUID().replace(/-/g, "");
	try {
		fs.mkdirSync(path.dirname(deviceIdPath), { recursive: true });
		fs.writeFileSync(deviceIdPath, `${deviceId}\n`, { mode: 0o600 });
	} catch {
		// Persist failure → ephemeral id for this process.
	}
	getDeviceId = () => deviceId;
	return deviceId;
};

function sanitizeHeaderValue(value: string, fallback = ""): string {
	const sanitized = value.replace(/[^\x20-\x7E]/g, "").trim();
	return sanitized || fallback;
}

export let getKimiCommonHeaders = () => {
	const headers = Object.freeze({
		"User-Agent": `KimiCLI/${packageJson.version}`,
		"X-Msh-Platform": "kimi_cli",
		"X-Msh-Version": packageJson.version,
		"X-Msh-Device-Name": sanitizeHeaderValue(os.hostname(), "unknown"),
		"X-Msh-Device-Model": sanitizeHeaderValue(getDeviceModel(), "unknown"),
		"X-Msh-Os-Version": sanitizeHeaderValue(os.version(), "unknown"),
		"X-Msh-Device-Id": sanitizeHeaderValue(getDeviceId(), "unknown"),
	});
	getKimiCommonHeaders = () => headers;
	return headers;
};

async function requestDeviceAuthorization(): Promise<{
	userCode: string;
	deviceCode: string;
	verificationUri: string;
	verificationUriComplete: string;
	expiresInMs: number;
	intervalMs: number;
}> {
	const response = await fetch(`${resolveOAuthHost()}/api/oauth/device_authorization`, {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
			...getKimiCommonHeaders(),
		},
		body: new URLSearchParams({ client_id: CLIENT_ID }),
	});

	if (!response.ok) {
		const text = await response.text();
		throw new AIError.OAuthError(`Kimi device authorization failed: ${response.status} ${text}`, {
			kind: "device-auth",
			provider: "kimi",
			status: response.status,
		});
	}

	const payload = (await response.json()) as DeviceAuthorizationResponse;
	const userCode = payload.user_code;
	const deviceCode = payload.device_code;
	const verificationUri = payload.verification_uri;
	const verificationUriComplete = payload.verification_uri_complete;

	if (!userCode || !deviceCode || !verificationUri) {
		throw new AIError.OAuthError("Kimi device authorization response missing required fields", {
			kind: "validation",
			provider: "kimi",
		});
	}

	const expiresInMs = typeof payload.expires_in === "number" ? payload.expires_in * 1000 : DEFAULT_DEVICE_FLOW_TTL_MS;
	const intervalMs =
		typeof payload.interval === "number" && payload.interval > 0 ? payload.interval * 1000 : DEFAULT_POLL_INTERVAL_MS;

	return {
		userCode,
		deviceCode,
		verificationUri,
		verificationUriComplete: verificationUriComplete || verificationUri,
		expiresInMs,
		intervalMs,
	};
}

function parseTokenPayload(payload: TokenResponse, refreshTokenFallback?: string): OAuthCredentials {
	if (!payload.access_token || typeof payload.expires_in !== "number") {
		throw new AIError.OAuthError("Kimi token response missing required fields", {
			kind: "validation",
			provider: "kimi",
		});
	}

	const refresh = payload.refresh_token ?? refreshTokenFallback;
	if (!refresh) {
		throw new AIError.OAuthError("Kimi token response missing refresh token", {
			kind: "validation",
			provider: "kimi",
		});
	}

	let accountId: string | undefined;
	const tokenParts = payload.access_token.split(".");
	const jwtPayloadPart = tokenParts.length === 3 ? tokenParts[1] : undefined;
	if (jwtPayloadPart) {
		try {
			const jwtPayload: unknown = JSON.parse(
				new TextDecoder("utf-8").decode(Uint8Array.fromBase64(jwtPayloadPart, { alphabet: "base64url" })),
			);
			if (isRecord(jwtPayload)) {
				const userId = typeof jwtPayload.user_id === "string" ? jwtPayload.user_id.trim() : "";
				const subject = typeof jwtPayload.sub === "string" ? jwtPayload.sub.trim() : "";
				accountId = userId || subject || undefined;
			}
		} catch {
			// Opaque access tokens remain valid credentials without account metadata.
		}
	}

	return {
		access: payload.access_token,
		refresh,
		expires: Date.now() + payload.expires_in * 1000 - OAUTH_EXPIRY_SKEW_MS,
		accountId,
	};
}

async function pollForToken(
	deviceCode: string,
	intervalMs: number,
	expiresInMs: number,
	signal?: AbortSignal,
): Promise<OAuthCredentials> {
	const deadline = Date.now() + expiresInMs;
	let waitMs = Math.max(1000, intervalMs);

	while (Date.now() < deadline) {
		if (signal?.aborted) {
			throw new AIError.LoginCancelledError();
		}

		const response = await fetch(`${resolveOAuthHost()}/api/oauth/token`, {
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
				...getKimiCommonHeaders(),
			},
			body: new URLSearchParams({
				client_id: CLIENT_ID,
				device_code: deviceCode,
				grant_type: "urn:ietf:params:oauth:grant-type:device_code",
			}),
		});

		const payload = (await response.json()) as TokenResponse;
		if (response.ok && payload.access_token) {
			return parseTokenPayload(payload);
		}

		const error = payload.error;
		if (error === "authorization_pending") {
			await scheduler.wait(waitMs, { signal });
			continue;
		}

		if (error === "slow_down") {
			waitMs += 5000;
			const retryAfter = typeof payload.interval === "number" ? payload.interval * 1000 : undefined;
			if (retryAfter && retryAfter > waitMs) waitMs = retryAfter;
			await scheduler.wait(waitMs, { signal });
			continue;
		}

		if (error === "expired_token") {
			throw new AIError.OAuthError("Kimi device authorization expired", {
				kind: "validation",
				provider: "kimi",
			});
		}

		if (error === "access_denied") {
			throw new AIError.OAuthError("Kimi device authorization denied", {
				kind: "validation",
				provider: "kimi",
			});
		}

		const description = payload.error_description ? `: ${payload.error_description}` : "";
		throw new AIError.OAuthError(`Kimi device flow failed: ${error ?? response.status}${description}`, {
			kind: "polling",
			provider: "kimi",
		});
	}

	throw new AIError.OAuthError("Kimi device flow timed out", {
		kind: "timeout",
		provider: "kimi",
	});
}

/**
 * Login with Kimi Code OAuth (device code flow).
 */
export async function loginKimi(options: OAuthController): Promise<OAuthCredentials> {
	const device = await requestDeviceAuthorization();
	options.onAuth?.({
		url: device.verificationUriComplete,
		instructions: `Enter code: ${device.userCode}`,
	});

	return pollForToken(device.deviceCode, device.intervalMs, device.expiresInMs, options.signal);
}

/**
 * Refresh Kimi OAuth token.
 */
export async function refreshKimiToken(refreshToken: string): Promise<OAuthCredentials> {
	const response = await fetch(`${resolveOAuthHost()}/api/oauth/token`, {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
			...getKimiCommonHeaders(),
		},
		body: new URLSearchParams({
			grant_type: "refresh_token",
			refresh_token: refreshToken,
			client_id: CLIENT_ID,
		}),
	});

	if (!response.ok) {
		const payload = (await response.json().catch(() => undefined)) as TokenResponse | undefined;
		const description = payload?.error_description ? `: ${payload.error_description}` : "";
		throw new AIError.OAuthError(`Kimi token refresh failed: ${response.status}${description}`, {
			kind: "token-refresh",
			provider: "kimi",
			status: response.status,
		});
	}

	const payload = (await response.json()) as TokenResponse;
	return parseTokenPayload(payload, refreshToken);
}
