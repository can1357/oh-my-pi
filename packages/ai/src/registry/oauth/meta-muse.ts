import { type } from "@oh-my-pi/omptype";
import { prompt } from "@oh-my-pi/pi-utils";
import * as AIError from "../../error";
import type { FetchImpl } from "../../types";
import metaDeviceCodePrompt from "./meta-device-code.md" with { type: "text" };
import { pollOAuthDeviceCodeFlow, type OAuthDeviceCodePollResult } from "./device-code";
import type { OAuthController, OAuthCredentials } from "./types";

const PROVIDER = "meta";
const CLIENT_ID = "1031625952748946";
const DEVICE_AUTHORIZATION_URL = "https://auth.meta.com/oidc/device/authorization/";
const TOKEN_URL = "https://auth.meta.com/oidc/device/token/";
const MUSE_KEY_URL = "https://api.meta.ai/muse-code/key";
const DEVICE_CODE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const API_VERSION = "1.0.0";
const REQUEST_TIMEOUT_MS = 20_000;
const ACCESS_TOKEN_CLIENT_SKEW_MS = 5 * 60 * 1000;

interface DeviceAuthorization {
	deviceCode: string;
	userCode: string;
	verificationUri: string;
	expiresInSeconds: number;
	intervalSeconds?: number;
}

interface TokenGrant {
	accessToken: string;
	refreshToken: string;
	expiresInSeconds: number;
}

const deviceAuthorizationSchema = type({
	device_code: "string",
	user_code: "string",
	verification_uri: "string",
	"verification_uri_complete?": "string",
	expires_in: "number",
	"interval?": "number",
});
type DeviceAuthorizationResponse = typeof deviceAuthorizationSchema.infer;

const tokenResponseSchema = type({
	"access_token?": "string",
	"refresh_token?": "string",
	"expires_in?": "number",
	"error?": "string",
	"error_description?": "string",
});
type TokenResponse = typeof tokenResponseSchema.infer;

const subscriptionWindowSchema = type({
	"used_percent?": "number",
	"resets_at?": "string | number",
	"window_duration_mins?": "number",
});

const subscriptionUsageSchema = type({
	"window?": subscriptionWindowSchema.or("null"),
	"weekly?": subscriptionWindowSchema.or("null"),
});

const museCodeKeyResponseSchema = type({
	"api_key?": "string",
	"require_payment_action_url?": "string",
	"require_payment?": "boolean",
	"action_url?": "string",
	"user_email?": "string",
	"user_id?": "string",
	"is_subs_active?": "boolean",
	"subs_tier_id?": "string",
	"subs_tier_name?": "string",
	"subs_usage?": subscriptionUsageSchema.or("null"),
});
export type MuseCodeKeyResponse = typeof museCodeKeyResponseSchema.infer;

interface MintedMuseKey {
	apiKey: string;
	email?: string;
	accountId?: string;
}

function requestSignal(signal?: AbortSignal): AbortSignal {
	const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function readJson(response: Response, label: string): Promise<unknown> {
	try {
		return await response.json();
	} catch (error) {
		throw new AIError.OAuthError(`${label} returned invalid JSON`, {
			kind: "validation",
			provider: PROVIDER,
			status: response.status,
			cause: error,
		});
	}
}

function parseDeviceAuthorization(payload: unknown): DeviceAuthorization {
	const parsed = deviceAuthorizationSchema(payload);
	if (parsed instanceof type.errors) {
		throw new AIError.OAuthError(`Invalid Meta device authorization response: ${parsed.summary}`, {
			kind: "validation",
			provider: PROVIDER,
		});
	}
	const response: DeviceAuthorizationResponse = parsed;
	const deviceCode = response.device_code.trim();
	const userCode = response.user_code.trim();
	const verificationUri = response.verification_uri_complete?.trim() || response.verification_uri.trim();
	if (
		!deviceCode ||
		!userCode ||
		!verificationUri ||
		!Number.isFinite(response.expires_in) ||
		response.expires_in <= 0 ||
		(response.interval !== undefined && (!Number.isFinite(response.interval) || response.interval <= 0))
	) {
		throw new AIError.OAuthError("Meta device authorization response is missing required fields", {
			kind: "validation",
			provider: PROVIDER,
		});
	}
	let url: URL;
	try {
		url = new URL(verificationUri);
	} catch (cause) {
		throw new AIError.OAuthError("Meta device authorization returned an invalid verification URL", {
			kind: "validation",
			provider: PROVIDER,
			cause,
		});
	}
	if (url.protocol !== "https:" || url.hostname !== "auth.meta.com") {
		throw new AIError.OAuthError("Meta device authorization returned an untrusted verification URL", {
			kind: "validation",
			provider: PROVIDER,
		});
	}
	return {
		deviceCode,
		userCode,
		verificationUri,
		expiresInSeconds: response.expires_in,
		intervalSeconds: response.interval,
	};
}

function parseTokenResponse(payload: unknown): TokenResponse {
	const parsed = tokenResponseSchema(payload);
	if (parsed instanceof type.errors) {
		throw new AIError.OAuthError(`Invalid Meta token response: ${parsed.summary}`, {
			kind: "validation",
			provider: PROVIDER,
		});
	}
	return parsed;
}

function parseTokenGrant(payload: unknown, refreshFallback?: string): TokenGrant {
	const response = parseTokenResponse(payload);
	const accessToken = response.access_token?.trim() || "";
	const refreshToken = response.refresh_token?.trim() || refreshFallback || "";
	const expiresInSeconds = response.expires_in;
	if (
		!accessToken ||
		!refreshToken ||
		typeof expiresInSeconds !== "number" ||
		!Number.isFinite(expiresInSeconds) ||
		expiresInSeconds <= 0
	) {
		throw new AIError.OAuthError("Meta token response is missing access_token, refresh_token, or expires_in", {
			kind: "validation",
			provider: PROVIDER,
		});
	}
	return { accessToken, refreshToken, expiresInSeconds };
}

function parseMintedKey(
	response: MuseCodeKeyResponse,
	identity?: Pick<OAuthCredentials, "accountId" | "email">,
): MintedMuseKey {
	if (response.is_subs_active === false) {
		throw new AIError.OAuthError("invalid_grant: Muse Code subscription is inactive", {
			kind: "token-exchange",
			provider: PROVIDER,
			status: 403,
		});
	}
	const apiKey = response.api_key?.trim() || "";
	if (!apiKey) {
		const actionUrl = response.action_url?.trim() || response.require_payment_action_url?.trim() || "";
		throw new AIError.OAuthError(
			actionUrl ? `Muse Code account setup is required: ${actionUrl}` : "Muse Code key response is missing api_key",
			{
				kind: "validation",
				provider: PROVIDER,
			},
		);
	}
	const email = response.user_email?.trim().toLowerCase() || identity?.email;
	const accountId = response.user_id?.trim() || identity?.accountId;
	if (!accountId && !email) {
		throw new AIError.OAuthError("Muse Code key response is missing a stable account identity", {
			kind: "validation",
			provider: PROVIDER,
		});
	}
	return { apiKey, email, accountId };
}

async function requestDeviceAuthorization(fetchImpl: FetchImpl, signal?: AbortSignal): Promise<DeviceAuthorization> {
	const response = await fetchImpl(DEVICE_AUTHORIZATION_URL, {
		method: "POST",
		headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({ client_id: CLIENT_ID }),
		redirect: "error",
		signal: requestSignal(signal),
	});
	if (!response.ok) {
		throw new AIError.OAuthError(`Meta device authorization failed: ${response.status}`, {
			kind: "device-auth",
			provider: PROVIDER,
			status: response.status,
		});
	}
	return parseDeviceAuthorization(await readJson(response, "Meta device authorization"));
}

async function requestToken(
	body: URLSearchParams,
	fetchImpl: FetchImpl,
	signal?: AbortSignal,
): Promise<{ response: Response; payload: unknown }> {
	const response = await fetchImpl(TOKEN_URL, {
		method: "POST",
		headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
		body,
		redirect: "error",
		signal: requestSignal(signal),
	});
	return { response, payload: await readJson(response, "Meta token request") };
}

async function pollDeviceToken(
	deviceCode: string,
	fetchImpl: FetchImpl,
	signal?: AbortSignal,
): Promise<OAuthDeviceCodePollResult<TokenGrant>> {
	const { response, payload } = await requestToken(
		new URLSearchParams({ grant_type: DEVICE_CODE_GRANT, device_code: deviceCode, client_id: CLIENT_ID }),
		fetchImpl,
		signal,
	);
	if (response.ok) return { status: "complete", value: parseTokenGrant(payload) };
	const code = parseTokenResponse(payload).error?.trim() || "";
	if (code === "authorization_pending") return { status: "pending" };
	if (code === "slow_down") return { status: "slow_down" };
	return { status: "failed", message: `Meta token polling failed: ${code || response.status}` };
}

export async function requestMuseCodeKey(
	accessToken: string,
	fetchImpl: FetchImpl = fetch,
	signal?: AbortSignal,
): Promise<MuseCodeKeyResponse> {
	const response = await fetchImpl(MUSE_KEY_URL, {
		method: "POST",
		headers: {
			Accept: "application/json",
			Authorization: `Bearer ${accessToken}`,
			"Content-Type": "application/json",
			"x-api-version": API_VERSION,
		},
		body: "{}",
		redirect: "error",
		signal: requestSignal(signal),
	});
	if (!response.ok) {
		throw new AIError.OAuthError(`Muse Code key exchange failed: ${response.status}`, {
			kind: "token-exchange",
			provider: PROVIDER,
			status: response.status,
		});
	}
	const parsed = museCodeKeyResponseSchema(await readJson(response, "Muse Code key exchange"));
	if (parsed instanceof type.errors) {
		throw new AIError.OAuthError(`Invalid Muse Code key response: ${parsed.summary}`, {
			kind: "validation",
			provider: PROVIDER,
		});
	}
	return parsed;
}

export async function mintMuseCodeApiKey(
	accessToken: string,
	fetchImpl: FetchImpl = fetch,
	signal?: AbortSignal,
	identity?: Pick<OAuthCredentials, "accountId" | "email">,
): Promise<MintedMuseKey> {
	return parseMintedKey(await requestMuseCodeKey(accessToken, fetchImpl, signal), identity);
}

function credentialsFromGrant(grant: TokenGrant, minted: MintedMuseKey): OAuthCredentials {
	return {
		access: grant.accessToken,
		refresh: grant.refreshToken,
		expires: Date.now() + grant.expiresInSeconds * 1000 - ACCESS_TOKEN_CLIENT_SKEW_MS,
		apiKey: minted.apiKey,
		email: minted.email,
		accountId: minted.accountId,
	};
}

export async function loginMetaMuse(ctrl: OAuthController): Promise<OAuthCredentials> {
	const fetchImpl = ctrl.fetch ?? fetch;
	const device = await requestDeviceAuthorization(fetchImpl, ctrl.signal);
	ctrl.onAuth?.({
		url: device.verificationUri,
		instructions: prompt.render(metaDeviceCodePrompt, { userCode: device.userCode }).trim(),
	});
	ctrl.onProgress?.("Waiting for Meta device authorization...");
	const grant = await pollOAuthDeviceCodeFlow({
		poll: () => pollDeviceToken(device.deviceCode, fetchImpl, ctrl.signal),
		intervalSeconds: device.intervalSeconds,
		expiresInSeconds: device.expiresInSeconds,
		signal: ctrl.signal,
	});
	const minted = await mintMuseCodeApiKey(grant.accessToken, fetchImpl, ctrl.signal);
	return credentialsFromGrant(grant, minted);
}

export async function refreshMetaMuseToken(
	credentials: OAuthCredentials,
	fetchImpl: FetchImpl = fetch,
	signal?: AbortSignal,
): Promise<OAuthCredentials> {
	const refreshToken = credentials.refresh.trim();
	if (!refreshToken) {
		throw new AIError.OAuthError("Meta OAuth credential is missing refresh_token", {
			kind: "validation",
			provider: PROVIDER,
		});
	}
	const { response, payload } = await requestToken(
		new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: CLIENT_ID }),
		fetchImpl,
		signal,
	);
	if (!response.ok) {
		const errorResponse = parseTokenResponse(payload);
		const code = errorResponse.error?.trim();
		const description = errorResponse.error_description?.trim();
		const detail = [code, description].filter(Boolean).join(": ");
		throw new AIError.OAuthError(`Meta token refresh failed: ${response.status}${detail ? ` ${detail}` : ""}`, {
			kind: "token-refresh",
			provider: PROVIDER,
			status: response.status,
		});
	}
	const grant = parseTokenGrant(payload, refreshToken);
	try {
		const minted = await mintMuseCodeApiKey(grant.accessToken, fetchImpl, signal, credentials);
		return credentialsFromGrant(grant, minted);
	} catch (error) {
		const existingApiKey = credentials.apiKey;
		const transientNetworkFailure =
			error instanceof TypeError ||
			(error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError"));
		const transient =
			!signal?.aborted &&
			(error instanceof AIError.OAuthError ? AIError.isTransientStatus(error.status) : transientNetworkFailure);
		if (!existingApiKey || !transient) throw error;
		return credentialsFromGrant(grant, {
			apiKey: existingApiKey,
			accountId: credentials.accountId,
			email: credentials.email,
		});
	}
}
