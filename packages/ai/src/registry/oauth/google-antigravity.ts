/**
 * Antigravity OAuth flow (Gemini 3, Claude, GPT-OSS via Google Cloud)
 * Uses different OAuth credentials than google-gemini-cli for access to additional models.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { getAntigravityUserAgent } from "@oh-my-pi/pi-catalog/wire/gemini-headers";
import { isEnoent } from "@oh-my-pi/pi-utils";
import type { OAuthCredential } from "../../auth-storage";
import * as AIError from "../../error";
import { raceWithSignal } from "../../utils/abort";
import { extractGoogleValidationUrl, formatGoogleValidationRequiredMessage } from "../../utils/google-validation";
import type { AfterExchangeHook } from "../hooks/types";
import { oauthFetch, throwIfLoginCancelled } from "./google-oauth-shared";
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

/** Resolves the Antigravity project after login and preserves it across refresh responses. */
export const googleAntigravityProjectHook: AfterExchangeHook = async (credentials, context) => {
	if (context.phase === "refresh") {
		return context.stored?.projectId ? { ...credentials, projectId: context.stored.projectId } : credentials;
	}
	const raw = context.raw;
	if (
		raw === null ||
		typeof raw !== "object" ||
		typeof (raw as Record<string, unknown>).refresh_token !== "string" ||
		(raw as Record<string, unknown>).refresh_token === ""
	) {
		throw new AIError.OAuthError("No refresh token received. Please try again.", {
			kind: "validation",
			provider: context.provider,
		});
	}
	let projectId: string;
	try {
		projectId = await discoverProject(credentials.access, context.onProgress, context.signal);
	} catch (error) {
		const validationUrl = extractGoogleValidationUrl(error instanceof Error ? error.message : String(error));
		if (!validationUrl) throw error;
		throw new AIError.OAuthError(
			formatGoogleValidationRequiredMessage(validationUrl, "sign in again", credentials.email),
			{ kind: "validation", provider: context.provider },
		);
	}
	return { ...credentials, projectId };
};

/** Default filename for official Google Antigravity OAuth tokens (`antigravity-oauth-token`). */
export const DEFAULT_ANTIGRAVITY_TOKEN_FILENAME = "antigravity-oauth-token";

/** Secondary candidate filename for Antigravity OAuth tokens (`antigravity-auth-token`). */
export const LEGACY_ANTIGRAVITY_TOKEN_FILENAME = "antigravity-auth-token";

/**
 * Default path for official Google Antigravity OAuth tokens.
 *
 * Checks primary `antigravity-oauth-token` first, falling back to `antigravity-auth-token` if present.
 */
export function getDefaultAntigravityTokenPath(): string {
	const dir = path.join(os.homedir(), ".gemini", "antigravity-cli");
	const primary = path.join(dir, DEFAULT_ANTIGRAVITY_TOKEN_FILENAME);
	const fallback = path.join(dir, LEGACY_ANTIGRAVITY_TOKEN_FILENAME);
	if (fs.existsSync(fallback) && !fs.existsSync(primary)) {
		return fallback;
	}
	return primary;
}

/** Default path for official Google OAuth client credentials (contains id_token with email). */
export function getDefaultAntigravityCredsPath(): string {
	return path.join(os.homedir(), ".gemini", "oauth_creds.json");
}

export interface ReadLocalAntigravityCredentialOptions {
	tokenPath?: string;
	credsPath?: string;
}

/**
 * Reads active first-party Google Antigravity CLI OAuth credentials from disk.
 *
 * Extracts the access token, refresh token, expiry, and (if present in oauth_creds.json) user email.
 * Defaults the project to `aicode-consumers` which is the standard quota pool for personal/pro accounts.
 */
export async function readLocalAntigravityCredential(
	options?: ReadLocalAntigravityCredentialOptions,
): Promise<OAuthCredential> {
	const explicitTokenPath = options?.tokenPath;
	const tokenPath = explicitTokenPath ?? getDefaultAntigravityTokenPath();
	const credsPath = options?.credsPath ?? getDefaultAntigravityCredsPath();

	let rawTokenContent: string | undefined;
	try {
		rawTokenContent = await Bun.file(tokenPath).text();
	} catch (error) {
		if (isEnoent(error)) {
			if (!explicitTokenPath) {
				const dir = path.join(os.homedir(), ".gemini", "antigravity-cli");
				const altFilename =
					path.basename(tokenPath) === DEFAULT_ANTIGRAVITY_TOKEN_FILENAME
						? LEGACY_ANTIGRAVITY_TOKEN_FILENAME
						: DEFAULT_ANTIGRAVITY_TOKEN_FILENAME;
				const altPath = path.join(dir, altFilename);
				try {
					rawTokenContent = await Bun.file(altPath).text();
				} catch (altError) {
					if (!isEnoent(altError)) throw altError;
				}
			}
		} else {
			throw error;
		}

		if (rawTokenContent === undefined) {
			throw new AIError.OAuthError(
				`Antigravity OAuth token file not found at ${tokenPath}. Please log in with the Google Antigravity CLI first.`,
				{ kind: "validation", provider: PROVIDER, cause: error },
			);
		}
	}

	let tokenData: {
		token?: {
			access_token?: string;
			refresh_token?: string;
			expiry?: string | number;
			token_type?: string;
		};
		auth_method?: string;
	};
	try {
		tokenData = JSON.parse(rawTokenContent);
	} catch (error) {
		throw new AIError.OAuthError(`Failed to parse Antigravity OAuth token at ${tokenPath}: ${String(error)}`, {
			kind: "validation",
			provider: PROVIDER,
			cause: error,
		});
	}

	const token = tokenData.token;
	if (!token?.access_token || !token?.refresh_token) {
		throw new AIError.OAuthError(`Antigravity token file at ${tokenPath} is missing access_token or refresh_token.`, {
			kind: "validation",
			provider: PROVIDER,
		});
	}

	let expires = Date.now() + 3600_000;
	if (token.expiry) {
		const parsed = typeof token.expiry === "number" ? token.expiry : Date.parse(token.expiry);
		if (Number.isFinite(parsed) && parsed > 0) {
			expires = parsed;
		}
	}

	let email: string | undefined;
	try {
		const rawCreds = await Bun.file(credsPath).text();
		const credsData = JSON.parse(rawCreds) as { id_token?: string };
		if (credsData.id_token) {
			const parts = credsData.id_token.split(".");
			if (parts.length >= 2) {
				const payloadJson = Buffer.from(parts[1]!, "base64url").toString("utf-8");
				const payload = JSON.parse(payloadJson);
				if (typeof payload.email === "string" && payload.email.length > 0) {
					email = payload.email;
				}
			}
		}
	} catch (error) {
		if (!isEnoent(error) && !(error instanceof SyntaxError)) {
			// oauth_creds.json is optional; email can be omitted
		}
	}

	return {
		type: "oauth",
		access: token.access_token,
		refresh: token.refresh_token,
		expires,
		projectId: "aicode-consumers",
		...(email ? { email } : {}),
	};
}
