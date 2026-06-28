/**
 * Antigravity OAuth flow (Gemini 3, Claude, GPT-OSS via Google Cloud)
 * Uses different OAuth credentials than google-gemini-cli for access to additional models.
 */
import { getAntigravityUserAgent } from "@pk-nerdsaver-ai/pi-catalog/wire/gemini-headers";
import * as AIError from "../../error";
import { runGoogleOAuthLogin } from "./google-oauth-shared";
import type { OAuthController, OAuthCredentials } from "./types";

const decode = (s: string) => atob(s);
const CLIENT_ID = decode(
	"MTA3MTAwNjA2MDU5MS10bWhzc2luMmgyMWxjcmUyMzV2dG9sb2poNGc0MDNlcC5hcHBzLmdvb2dsZXVzZXJjb250ZW50LmNvbQ==",
);
const CLIENT_SECRET = decode("R09DU1BYLUs1OEZXUjQ4NkxkTEoxbUxCOHNYQzR6NnFEQWY=");
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
const CLOUD_CODE_ENDPOINT = "https://cloudcode-pa.googleapis.com";
const TIER_LEGACY = "legacy-tier";
const PROJECT_ONBOARD_MAX_ATTEMPTS = 5;
const PROJECT_ONBOARD_INTERVAL_MS = 2000;

interface LoadCodeAssistPayload {
	cloudaicompanionProject?: string | { id?: string };
	currentTier?: { id?: string };
	allowedTiers?: Array<{ id?: string; isDefault?: boolean }>;
}

interface LongRunningOperationResponse {
	done?: boolean;
	response?: {
		cloudaicompanionProject?: string | { id?: string };
	};
}

export const ANTIGRAVITY_LOAD_CODE_ASSIST_METADATA = Object.freeze({
	ideType: "ANTIGRAVITY",
	platform: "PLATFORM_UNSPECIFIED",
	pluginType: "GEMINI",
});

function readProjectId(value: string | { id?: string } | undefined): string | undefined {
	if (typeof value === "string" && value.length > 0) {
		return value;
	}
	if (value && typeof value === "object" && typeof value.id === "string" && value.id.length > 0) {
		return value.id;
	}
	return undefined;
}

function getDefaultTierId(allowedTiers?: Array<{ id?: string; isDefault?: boolean }>): string {
	if (!allowedTiers || allowedTiers.length === 0) {
		return TIER_LEGACY;
	}
	const defaultTier = allowedTiers.find(tier => tier.isDefault && typeof tier.id === "string" && tier.id.length > 0);
	if (defaultTier?.id) {
		return defaultTier.id;
	}
	return TIER_LEGACY;
}

async function onboardProjectWithRetries(
	endpoint: string,
	headers: Record<string, string>,
	onboardBody: { tierId: string; metadata: typeof ANTIGRAVITY_LOAD_CODE_ASSIST_METADATA },
	onProgress?: (message: string) => void,
): Promise<string> {
	for (let attempt = 1; attempt <= PROJECT_ONBOARD_MAX_ATTEMPTS; attempt += 1) {
		if (attempt > 1) {
			onProgress?.(`Waiting for project provisioning (attempt ${attempt}/${PROJECT_ONBOARD_MAX_ATTEMPTS})...`);
			await Bun.sleep(PROJECT_ONBOARD_INTERVAL_MS);
		}

		const onboardResponse = await fetch(`${endpoint}/v1internal:onboardUser`, {
			method: "POST",
			headers,
			body: JSON.stringify(onboardBody),
		});

		if (!onboardResponse.ok) {
			const errorText = await onboardResponse.text();
			throw new AIError.OAuthError(
				`onboardUser failed: ${onboardResponse.status} ${onboardResponse.statusText}: ${errorText}`,
				{ kind: "provisioning", status: onboardResponse.status },
			);
		}

		const operation = (await onboardResponse.json()) as LongRunningOperationResponse;
		if (!operation.done) {
			continue;
		}

		const projectId = readProjectId(operation.response?.cloudaicompanionProject);
		if (projectId) {
			return projectId;
		}
	}

	throw new AIError.OAuthError(
		`onboardUser did not return a provisioned project id after ${PROJECT_ONBOARD_MAX_ATTEMPTS} attempts`,
		{ kind: "provisioning" },
	);
}

async function discoverProject(accessToken: string, onProgress?: (message: string) => void): Promise<string> {
	const headers = {
		Authorization: `Bearer ${accessToken}`,
		"Content-Type": "application/json",
		"User-Agent": getAntigravityUserAgent(),
	};

	onProgress?.("Checking for existing project...");
	const endpoint = CLOUD_CODE_ENDPOINT;
	try {
		const loadResponse = await fetch(`${endpoint}/v1internal:loadCodeAssist`, {
			method: "POST",
			headers,
			body: JSON.stringify({
				metadata: ANTIGRAVITY_LOAD_CODE_ASSIST_METADATA,
			}),
		});

		if (!loadResponse.ok) {
			const errorText = await loadResponse.text();
			throw new AIError.OAuthError(
				`loadCodeAssist failed: ${loadResponse.status} ${loadResponse.statusText}: ${errorText}`,
				{ kind: "discovery", status: loadResponse.status },
			);
		}

		const loadPayload = (await loadResponse.json()) as LoadCodeAssistPayload;
		const existingProject = readProjectId(loadPayload.cloudaicompanionProject);
		if (existingProject) {
			return existingProject;
		}

		const tierId = getDefaultTierId(loadPayload.allowedTiers);
		onProgress?.("Provisioning project...");
		const onboardBody = {
			tierId,
			metadata: ANTIGRAVITY_LOAD_CODE_ASSIST_METADATA,
		};
		const provisionedProject = await onboardProjectWithRetries(endpoint, headers, onboardBody, onProgress);
		return provisionedProject;
	} catch (error) {
		throw new AIError.OAuthError(
			`Could not discover or provision an Antigravity project. ${error instanceof Error ? error.message : String(error)}`,
			{ kind: "discovery", cause: error },
		);
	}
}

export async function loginAntigravity(ctrl: OAuthController): Promise<OAuthCredentials> {
	return runGoogleOAuthLogin(ctrl, {
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
