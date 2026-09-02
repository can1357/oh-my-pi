/**
 * Antigravity OAuth flow (Gemini 3, Claude, GPT-OSS via Google Cloud)
 * Uses different OAuth credentials than google-gemini-cli for access to additional models.
 */
import { type } from "@oh-my-pi/omptype";
import { getAntigravityUserAgent } from "@oh-my-pi/pi-catalog/wire/gemini-headers";
import * as AIError from "../../error";
import { raceWithSignal } from "../../utils/abort";
import { oauthFetch, runGoogleOAuthLogin, throwIfLoginCancelled } from "./google-oauth-shared";
import type { OAuthController, OAuthCredentials } from "./types";

const CLIENT_ID = atob(
	"MTA3MTAwNjA2MDU5MS10bWhzc2luMmgyMWxjcmUyMzV2dG9sb2poNGc0MDNlcC5hcHBzLmdvb2dsZXVzZXJjb250ZW50LmNvbQ==",
);
const CLIENT_SECRET = atob("R09DU1BYLUs1OEZXUjQ4NkxkTEoxbUxCOHNYQzR6NnFEQWY=");
const CALLBACK_PORT = 51121;
const CALLBACK_PATH = "/oauth-callback";

const SCOPES = [
	"https://www.googleapis.com/auth/cloud-platform",
	"https://www.googleapis.com/auth/userinfo.email",
	"https://www.googleapis.com/auth/userinfo.profile",
	"https://www.googleapis.com/auth/cclog",
	"https://www.googleapis.com/auth/experimentsandconfigs",
];

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const CLOUD_CODE_ASSIST_ENDPOINT = "https://daily-cloudcode-pa.googleapis.com";
const LOAD_CODE_ASSIST_URL = `${CLOUD_CODE_ASSIST_ENDPOINT}/v1internal:loadCodeAssist`;
const ONBOARD_USER_URL = `${CLOUD_CODE_ASSIST_ENDPOINT}/v1internal:onboardUser`;
const OPERATIONS_URL = `${CLOUD_CODE_ASSIST_ENDPOINT}/v1internal`;
const FREE_TIER_ID = "free-tier";
const ONBOARD_TIMEOUT_MS = 30_000;
const ONBOARD_POLL_INTERVAL_MS = 1_000;
const PROVIDER = "google-antigravity";

/** Cloud Code Assist metadata sent by native Antigravity control-plane requests. */
export const ANTIGRAVITY_LOAD_CODE_ASSIST_METADATA = Object.freeze({
	ideType: "ANTIGRAVITY",
});

interface CloudCodeContext {
	headers: Record<string, string>;
	signal?: AbortSignal;
}

interface CloudCodeRequest extends CloudCodeContext {
	label: string;
	url: string;
	method: "GET" | "POST";
	body?: string;
	timeoutMs?: number;
}

const userTierSchema = type({
	"id?": "string",
});

const ineligibleTierSchema = type({
	"tierId?": "string",
	"reasonMessage?": "string",
	"validationUrl?": "string",
});

const loadCodeAssistResponseSchema = type({
	"currentTier?": userTierSchema.or("null"),
	"paidTier?": userTierSchema.or("null"),
	"allowedTiers?": userTierSchema.array(),
	"ineligibleTiers?": ineligibleTierSchema.array(),
	"cloudaicompanionProject?": "string",
});
type LoadCodeAssistResponse = typeof loadCodeAssistResponseSchema.infer;

const operationErrorSchema = type({
	"code?": "number",
	"message?": "string",
});
type OperationError = typeof operationErrorSchema.infer;

const onboardUserResponseSchema = type({
	"@type": "string",
	"cloudaicompanionProject?": "string",
});

const onboardOperationSchema = type({
	"name?": "string",
	"done?": "boolean",
	"error?": operationErrorSchema.or("null"),
	"response?": onboardUserResponseSchema.or("null"),
});
type OnboardOperation = typeof onboardOperationSchema.infer;

function parseLoadCodeAssistResponse(payload: unknown): LoadCodeAssistResponse {
	const result = loadCodeAssistResponseSchema(payload);
	if (result instanceof type.errors) {
		throw new AIError.OAuthError(`failed to unmarshal LoadCodeAssistResponse: ${result.summary}`, {
			kind: "provisioning",
			provider: PROVIDER,
		});
	}
	return result;
}

function parseOnboardOperation(payload: unknown): OnboardOperation {
	const result = onboardOperationSchema(payload);
	if (result instanceof type.errors) {
		throw new AIError.OAuthError(`failed to unmarshal OnboardUser operation: ${result.summary}`, {
			kind: "provisioning",
			provider: PROVIDER,
		});
	}
	return result;
}

function extractProjectId(payload: LoadCodeAssistResponse): string | undefined {
	const projectId = payload.cloudaicompanionProject;
	return projectId && projectId.length > 0 ? projectId : undefined;
}

function hasMessageField(payload: LoadCodeAssistResponse, field: "currentTier" | "paidTier"): boolean {
	return payload[field] !== undefined && payload[field] !== null;
}

function isFreeTierAllowed(payload: LoadCodeAssistResponse): boolean {
	return payload.allowedTiers?.some(tier => tier.id === FREE_TIER_ID) === true;
}

function getFreeTierIneligibility(
	payload: LoadCodeAssistResponse,
): { reasonMessage: string; validationUrl: string | undefined } | undefined {
	const tier = payload.ineligibleTiers?.find(candidate => candidate.tierId === FREE_TIER_ID);
	if (!tier?.reasonMessage) return undefined;
	return {
		reasonMessage: tier.reasonMessage,
		validationUrl: tier.validationUrl && tier.validationUrl.length > 0 ? tier.validationUrl : undefined,
	};
}

function assertFreeTierEligible(payload: LoadCodeAssistResponse): void {
	if (isFreeTierAllowed(payload)) return;
	const ineligibility = getFreeTierIneligibility(payload);
	if (!ineligibility) return;
	const validation = ineligibility.validationUrl ? `\n${ineligibility.validationUrl}` : "";
	throw new AIError.OAuthError(`${ineligibility.reasonMessage}${validation}`, {
		kind: "provisioning",
		provider: PROVIDER,
	});
}

async function requestCloudCodeAssist({
	label,
	url,
	method,
	headers,
	body,
	signal,
	timeoutMs,
}: CloudCodeRequest): Promise<unknown> {
	throwIfLoginCancelled(signal);
	const init: RequestInit = body === undefined ? { method, headers } : { method, headers, body };
	const response = await oauthFetch(url, init, { provider: PROVIDER, signal, timeoutMs });
	if (response.status !== 200) {
		const errorText = await response.text();
		throw new AIError.OAuthError(`${label} failed: ${response.status} ${response.statusText}: ${errorText}`, {
			kind: "provisioning",
			provider: PROVIDER,
			status: response.status,
		});
	}
	return response.json();
}

async function postLoadCodeAssist(
	context: CloudCodeContext,
	body: Record<string, unknown>,
): Promise<LoadCodeAssistResponse> {
	const payload = await requestCloudCodeAssist({
		...context,
		label: "loadCodeAssist",
		url: LOAD_CODE_ASSIST_URL,
		method: "POST",
		body: JSON.stringify(body),
	});
	return parseLoadCodeAssistResponse(payload);
}

async function loadCodeAssist(context: CloudCodeContext): Promise<LoadCodeAssistResponse> {
	let payload = await postLoadCodeAssist(context, {
		metadata: ANTIGRAVITY_LOAD_CODE_ASSIST_METADATA,
	});
	const projectId = extractProjectId(payload);
	if (!hasMessageField(payload, "paidTier") && projectId) {
		payload = await postLoadCodeAssist(context, {
			cloudaicompanionProject: projectId,
			metadata: ANTIGRAVITY_LOAD_CODE_ASSIST_METADATA,
		});
	}
	return payload;
}

function remainingOnboardTime(deadline: number): number {
	const remaining = deadline - Date.now();
	if (remaining > 0) return remaining;
	throw new AIError.OAuthError(`onboardUser timed out after ${ONBOARD_TIMEOUT_MS}ms`, {
		kind: "timeout",
		provider: PROVIDER,
	});
}

function describeOperationError(error: OperationError): string {
	if (error.message) {
		return typeof error.code === "number" ? `${error.code}: ${error.message}` : error.message;
	}
	return JSON.stringify(error) ?? String(error);
}

async function onboardUser(context: CloudCodeContext): Promise<void> {
	const deadline = Date.now() + ONBOARD_TIMEOUT_MS;
	let operation = parseOnboardOperation(
		await requestCloudCodeAssist({
			...context,
			label: "onboardUser",
			url: ONBOARD_USER_URL,
			method: "POST",
			body: JSON.stringify({
				tierId: FREE_TIER_ID,
				metadata: ANTIGRAVITY_LOAD_CODE_ASSIST_METADATA,
			}),
			timeoutMs: remainingOnboardTime(deadline),
		}),
	);

	while (true) {
		if (operation.done === true) {
			if (operation.error !== undefined && operation.error !== null) {
				throw new AIError.OAuthError(`OnboardUser operation failed: ${describeOperationError(operation.error)}`, {
					kind: "provisioning",
					provider: PROVIDER,
				});
			}
			if (operation.response === undefined || operation.response === null) {
				throw new AIError.OAuthError("failed to unmarshal OnboardUserResponse", {
					kind: "provisioning",
					provider: PROVIDER,
				});
			}
			return;
		}

		await raceWithSignal(
			Bun.sleep(Math.min(ONBOARD_POLL_INTERVAL_MS, remainingOnboardTime(deadline))),
			context.signal,
		);
		throwIfLoginCancelled(context.signal);
		const operationName = operation.name ?? "";
		if (operationName.length === 0) {
			throw new AIError.OAuthError("onboardUser returned an operation without a name", {
				kind: "provisioning",
				provider: PROVIDER,
			});
		}
		operation = parseOnboardOperation(
			await requestCloudCodeAssist({
				...context,
				label: "onboardUser operation",
				url: `${OPERATIONS_URL}/${operationName}`,
				method: "GET",
				timeoutMs: remainingOnboardTime(deadline),
			}),
		);
	}
}

async function discoverProject(
	accessToken: string,
	onProgress?: (message: string) => void,
	signal?: AbortSignal,
): Promise<string> {
	const context: CloudCodeContext = {
		headers: {
			Authorization: `Bearer ${accessToken}`,
			"Content-Type": "application/json",
			"User-Agent": getAntigravityUserAgent(),
		},
		signal,
	};

	onProgress?.("Checking Cloud Code Assist account status...");
	try {
		const initial = await loadCodeAssist(context);
		assertFreeTierEligible(initial);
		if (!hasMessageField(initial, "currentTier")) {
			onProgress?.("Provisioning the Antigravity free tier...");
			await onboardUser(context);
		}

		onProgress?.("Refreshing Cloud Code Assist project...");
		const refreshed = await loadCodeAssist(context);
		const projectId = extractProjectId(refreshed);
		if (projectId) return projectId;
		throw new AIError.OAuthError("loadCodeAssist did not return a cloudaicompanionProject", {
			kind: "provisioning",
			provider: PROVIDER,
		});
	} catch (error) {
		throwIfLoginCancelled(signal);
		if (error instanceof AIError.LoginCancelledError || error instanceof AIError.OAuthError) {
			throw error;
		}
		throw new AIError.OAuthError(
			`Could not discover an Antigravity project. ${error instanceof Error ? error.message : String(error)}`,
			{ kind: "discovery", provider: PROVIDER, cause: error },
		);
	}
}

/** Authenticate an Antigravity account and resolve its Cloud Code Assist project. */
export async function loginAntigravity(ctrl: OAuthController): Promise<OAuthCredentials> {
	return runGoogleOAuthLogin(ctrl, {
		provider: "google-antigravity",
		clientId: CLIENT_ID,
		clientSecret: CLIENT_SECRET,
		authUrl: AUTH_URL,
		tokenUrl: TOKEN_URL,
		scopes: SCOPES,
		callbackPort: CALLBACK_PORT,
		callbackPath: CALLBACK_PATH,
		discoverProject,
	});
}

/**
 * Refresh Antigravity token
 */
export async function refreshAntigravityToken(refreshToken: string, projectId: string): Promise<OAuthCredentials> {
	const response = await fetch(TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			client_id: CLIENT_ID,
			client_secret: CLIENT_SECRET,
			refresh_token: refreshToken,
			grant_type: "refresh_token",
		}),
	});

	if (!response.ok) {
		const error = await response.text();
		throw new AIError.OAuthError(`Antigravity token refresh failed: ${error}`, { kind: "token-refresh" });
	}

	const data = (await response.json()) as {
		access_token: string;
		expires_in: number;
		refresh_token?: string;
	};

	return {
		refresh: data.refresh_token || refreshToken,
		access: data.access_token,
		expires: Date.now() + data.expires_in * 1000 - 5 * 60 * 1000,
		projectId,
	};
}
