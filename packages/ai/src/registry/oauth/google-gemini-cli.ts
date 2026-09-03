/**
 * Gemini CLI OAuth flow (Google Cloud Code Assist)
 * Standard Gemini models only (gemini-2.0-flash, gemini-2.5-*)
 */

import { getGeminiCliHeaders } from "@oh-my-pi/pi-catalog/wire/gemini-headers";
import { $env } from "@oh-my-pi/pi-utils";
import * as AIError from "../../error";
import { extractGoogleValidationUrl, formatGoogleValidationRequiredMessage } from "../../utils/google-validation";
import type { AfterExchangeHook } from "../hooks/types";
import { oauthFetch, throwIfLoginCancelled } from "./google-oauth-shared";
const CODE_ASSIST_ENDPOINT = "https://cloudcode-pa.googleapis.com";

interface LoadCodeAssistPayload {
	cloudaicompanionProject?: string;
	currentTier?: { id?: string };
	allowedTiers?: Array<{ id?: string; isDefault?: boolean }>;
}

interface LongRunningOperationResponse {
	name?: string;
	done?: boolean;
	response?: {
		cloudaicompanionProject?: { id?: string };
	};
}

const TIER_FREE = "free-tier";
const TIER_LEGACY = "legacy-tier";
const TIER_STANDARD = "standard-tier";

interface GoogleRpcErrorResponse {
	error?: {
		details?: Array<{ reason?: string }>;
	};
}

function getDefaultTier(allowedTiers?: Array<{ id?: string; isDefault?: boolean }>): { id?: string } {
	if (!allowedTiers || allowedTiers.length === 0) return { id: TIER_LEGACY };
	const defaultTier = allowedTiers.find(t => t.isDefault);
	return defaultTier ?? { id: TIER_LEGACY };
}

function isVpcScAffectedUser(payload: unknown): boolean {
	if (!payload || typeof payload !== "object") return false;
	if (!("error" in payload)) return false;
	const error = (payload as GoogleRpcErrorResponse).error;
	if (!error?.details || !Array.isArray(error.details)) return false;
	return error.details.some(detail => detail.reason === "SECURITY_POLICY_VIOLATED");
}

/**
 * LRO poll cadence and bound. Cloud Code Assist project provisioning normally
 * completes within a handful of polls; the attempt cap converts a stuck
 * `done: false` operation (or a service incident) into a bounded login error
 * instead of the previous unbounded loop.
 */
const POLL_INTERVAL_MS = 5000;
export const POLL_MAX_ATTEMPTS = 24;

export async function pollOperation(
	operationName: string,
	headers: Record<string, string>,
	signal: AbortSignal | undefined,
	onProgress?: (message: string) => void,
): Promise<LongRunningOperationResponse> {
	for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt += 1) {
		if (attempt > 0) {
			onProgress?.(`Waiting for project provisioning (attempt ${attempt + 1}/${POLL_MAX_ATTEMPTS})...`);
			throwIfLoginCancelled(signal);
			await Bun.sleep(POLL_INTERVAL_MS);
		}

		throwIfLoginCancelled(signal);
		const response = await oauthFetch(
			`${CODE_ASSIST_ENDPOINT}/v1internal/${operationName}`,
			{ method: "GET", headers },
			{ provider: "google-gemini-cli", signal },
		);

		if (!response.ok) {
			throw new AIError.OAuthError(`Failed to poll operation: ${response.status} ${response.statusText}`, {
				kind: "polling",
				provider: "google-gemini-cli",
				status: response.status,
			});
		}

		const data = (await response.json()) as LongRunningOperationResponse;
		if (data.done) {
			return data;
		}
	}

	throw new AIError.OAuthError(`Project provisioning did not complete after ${POLL_MAX_ATTEMPTS} attempts`, {
		kind: "timeout",
		provider: "google-gemini-cli",
	});
}

async function discoverProject(
	accessToken: string,
	onProgress?: (message: string) => void,
	signal?: AbortSignal,
): Promise<string> {
	const envProjectId = $env.GOOGLE_CLOUD_PROJECT || $env.GOOGLE_CLOUD_PROJECT_ID;

	const headers = {
		Authorization: `Bearer ${accessToken}`,
		"Content-Type": "application/json",
		...getGeminiCliHeaders(),
	};

	onProgress?.("Checking for existing Cloud Code Assist project...");
	const loadResponse = await oauthFetch(
		`${CODE_ASSIST_ENDPOINT}/v1internal:loadCodeAssist`,
		{
			method: "POST",
			headers,
			body: JSON.stringify({
				cloudaicompanionProject: envProjectId,
				metadata: {
					ideType: "IDE_UNSPECIFIED",
					platform: "PLATFORM_UNSPECIFIED",
					pluginType: "GEMINI",
					duetProject: envProjectId,
				},
			}),
		},
		{ provider: "google-gemini-cli", signal },
	);

	let data: LoadCodeAssistPayload;

	if (!loadResponse.ok) {
		let errorPayload: unknown;
		try {
			errorPayload = await loadResponse.clone().json();
		} catch {
			errorPayload = undefined;
		}

		if (isVpcScAffectedUser(errorPayload)) {
			data = { currentTier: { id: TIER_STANDARD } };
		} else {
			const errorText = await loadResponse.text();
			throw new AIError.OAuthError(
				`loadCodeAssist failed: ${loadResponse.status} ${loadResponse.statusText}: ${errorText}`,
				{ kind: "discovery", provider: "google-gemini-cli", status: loadResponse.status },
			);
		}
	} else {
		data = (await loadResponse.json()) as LoadCodeAssistPayload;
	}

	if (data.currentTier) {
		if (data.cloudaicompanionProject) {
			return data.cloudaicompanionProject;
		}
		if (envProjectId) {
			return envProjectId;
		}
		throw new AIError.OAuthError(
			"This account requires setting the GOOGLE_CLOUD_PROJECT or GOOGLE_CLOUD_PROJECT_ID environment variable. " +
				"See https://goo.gle/gemini-cli-auth-docs#workspace-gca",
			{ kind: "configuration", provider: "google-gemini-cli" },
		);
	}

	const tier = getDefaultTier(data.allowedTiers);
	const tierId = tier?.id ?? TIER_FREE;

	if (tierId !== TIER_FREE && !envProjectId) {
		throw new AIError.OAuthError(
			"This account requires setting the GOOGLE_CLOUD_PROJECT or GOOGLE_CLOUD_PROJECT_ID environment variable. " +
				"See https://goo.gle/gemini-cli-auth-docs#workspace-gca",
			{ kind: "configuration", provider: "google-gemini-cli" },
		);
	}

	onProgress?.("Provisioning Cloud Code Assist project (this may take a moment)...");

	const onboardBody: Record<string, unknown> = {
		tierId,
		metadata: {
			ideType: "IDE_UNSPECIFIED",
			platform: "PLATFORM_UNSPECIFIED",
			pluginType: "GEMINI",
		},
	};

	if (tierId !== TIER_FREE && envProjectId) {
		onboardBody.cloudaicompanionProject = envProjectId;
		(onboardBody.metadata as Record<string, unknown>).duetProject = envProjectId;
	}

	const onboardResponse = await oauthFetch(
		`${CODE_ASSIST_ENDPOINT}/v1internal:onboardUser`,
		{ method: "POST", headers, body: JSON.stringify(onboardBody) },
		{ provider: "google-gemini-cli", signal },
	);

	if (!onboardResponse.ok) {
		const errorText = await onboardResponse.text();
		throw new AIError.OAuthError(
			`onboardUser failed: ${onboardResponse.status} ${onboardResponse.statusText}: ${errorText}`,
			{ kind: "provisioning", provider: "google-gemini-cli", status: onboardResponse.status },
		);
	}

	let lroData = (await onboardResponse.json()) as LongRunningOperationResponse;

	if (!lroData.done && lroData.name) {
		lroData = await pollOperation(lroData.name, headers, signal, onProgress);
	}

	const projectId = lroData.response?.cloudaicompanionProject?.id;
	if (projectId) {
		return projectId;
	}

	if (envProjectId) {
		return envProjectId;
	}

	throw new AIError.OAuthError(
		"Could not discover or provision a Google Cloud project. " +
			"Try setting the GOOGLE_CLOUD_PROJECT or GOOGLE_CLOUD_PROJECT_ID environment variable. " +
			"See https://goo.gle/gemini-cli-auth-docs#workspace-gca",
		{ kind: "validation", provider: "google-gemini-cli" },
	);
}

/** Resolves the project after login and preserves it across refresh responses. */
export const googleGeminiCliProjectHook: AfterExchangeHook = async (credentials, context) => {
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
