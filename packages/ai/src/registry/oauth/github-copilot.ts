/**
 * GitHub Copilot OAuth flow using the official Copilot CLI app.
 */
import { scheduler } from "node:timers/promises";
import { getBundledModels } from "@oh-my-pi/pi-catalog/models";
import {
	COPILOT_API_HEADERS,
	discoverGitHubCopilotApiEndpoint,
	getGitHubCopilotBaseUrl,
	isPublicGitHubHost,
	normalizeDomain,
	normalizeGitHubCopilotEnterpriseDomain,
} from "@oh-my-pi/pi-catalog/wire/github-copilot";
import * as AIError from "../../error";
import type { FetchImpl } from "../../types";
import type { OAuthCredentials } from "./types";

const CLIENT_ID = "Ov23ctDVkRmgkPke0Mmm";
const OAUTH_SCOPE = "read:user,read:org,repo,gist,codespace";
const OAUTH_HEADERS = {
	Accept: "application/json",
	"Content-Type": "application/x-www-form-urlencoded",
	"User-Agent": "copilot-developer-action/0.0.1",
} as const;

const INITIAL_POLL_INTERVAL_MULTIPLIER = 1.2;
const SLOW_DOWN_POLL_INTERVAL_MULTIPLIER = 1.4;

type GitHubCopilotLoginOptions = {
	onAuth: (url: string, instructions?: string) => void;
	onPrompt: (prompt: { message: string; placeholder?: string; allowEmpty?: boolean }) => Promise<string>;
	onProgress?: (message: string) => void;
	signal?: AbortSignal;
	pollIntervalFloorMs?: number;
	pollIntervalScaleMs?: number;
	fetch?: FetchImpl;
};
type DeviceCodeResponse = {
	device_code: string;
	user_code: string;
	verification_uri: string;
	interval: number;
	expires_in: number;
};

type DeviceTokenSuccessResponse = {
	access_token: string;
	token_type?: string;
	scope?: string;
};

type DeviceTokenErrorResponse = {
	error: string;
	error_description?: string;
	interval?: number;
};

function getUrls(domain: string): {
	deviceCodeUrl: string;
	accessTokenUrl: string;
} {
	return {
		deviceCodeUrl: `https://${domain}/login/device/code`,
		accessTokenUrl: `https://${domain}/login/oauth/access_token`,
	};
}

async function fetchJson(url: string, init: RequestInit, fetchImpl: FetchImpl): Promise<unknown> {
	const response = await fetchImpl(url, init);
	if (!response.ok) {
		const text = await response.text();
		throw new AIError.ProviderHttpError(`${response.status} ${response.statusText}: ${text}`, response.status);
	}
	return response.json();
}

async function startDeviceFlow(domain: string, fetchImpl: FetchImpl): Promise<DeviceCodeResponse> {
	const urls = getUrls(domain);
	const data = await fetchJson(
		urls.deviceCodeUrl,
		{
			method: "POST",
			headers: OAUTH_HEADERS,
			body: new URLSearchParams({
				client_id: CLIENT_ID,
				scope: OAUTH_SCOPE,
			}),
		},
		fetchImpl,
	);

	if (!data || typeof data !== "object") {
		throw new AIError.OAuthError("Invalid device code response", { kind: "validation", provider: "github-copilot" });
	}

	const deviceCode = (data as Record<string, unknown>).device_code;
	const userCode = (data as Record<string, unknown>).user_code;
	const verificationUri = (data as Record<string, unknown>).verification_uri;
	const interval = (data as Record<string, unknown>).interval;
	const expiresIn = (data as Record<string, unknown>).expires_in;

	if (
		typeof deviceCode !== "string" ||
		typeof userCode !== "string" ||
		typeof verificationUri !== "string" ||
		typeof interval !== "number" ||
		typeof expiresIn !== "number"
	) {
		throw new AIError.OAuthError("Invalid device code response fields", {
			kind: "validation",
			provider: "github-copilot",
		});
	}

	return {
		device_code: deviceCode,
		user_code: userCode,
		verification_uri: verificationUri,
		interval,
		expires_in: expiresIn,
	};
}

async function pollForGitHubAccessToken(
	domain: string,
	deviceCode: string,
	intervalSeconds: number,
	expiresIn: number,
	signal: AbortSignal | undefined,
	fetchImpl: FetchImpl,
	pollIntervalFloorMs = 1000,
	pollIntervalScaleMs = 1000,
) {
	const urls = getUrls(domain);
	const deadline = Date.now() + expiresIn * 1000;
	let intervalMs = Math.max(pollIntervalFloorMs, Math.floor(intervalSeconds * pollIntervalScaleMs));
	let intervalMultiplier = INITIAL_POLL_INTERVAL_MULTIPLIER;
	let slowDownResponses = 0;

	while (Date.now() < deadline) {
		if (signal?.aborted) {
			throw new AIError.LoginCancelledError();
		}

		const remainingMs = deadline - Date.now();
		const waitMs = Math.min(Math.ceil(intervalMs * intervalMultiplier), remainingMs);
		try {
			await scheduler.wait(waitMs, { signal });
		} catch {
			throw new AIError.LoginCancelledError();
		}

		const raw = await fetchJson(
			urls.accessTokenUrl,
			{
				method: "POST",
				headers: OAUTH_HEADERS,
				body: new URLSearchParams({
					client_id: CLIENT_ID,
					device_code: deviceCode,
					grant_type: "urn:ietf:params:oauth:grant-type:device_code",
				}),
			},
			fetchImpl,
		);

		if (raw && typeof raw === "object" && typeof (raw as DeviceTokenSuccessResponse).access_token === "string") {
			return (raw as DeviceTokenSuccessResponse).access_token;
		}

		if (raw && typeof raw === "object" && typeof (raw as DeviceTokenErrorResponse).error === "string") {
			const { error, error_description: description, interval } = raw as DeviceTokenErrorResponse;
			if (error === "authorization_pending") {
				continue;
			}

			if (error === "slow_down") {
				slowDownResponses += 1;
				intervalMs =
					typeof interval === "number" && interval > 0
						? Math.max(pollIntervalFloorMs, interval * pollIntervalScaleMs)
						: Math.max(pollIntervalFloorMs, intervalMs + 5 * pollIntervalScaleMs);
				intervalMultiplier = SLOW_DOWN_POLL_INTERVAL_MULTIPLIER;
				continue;
			}

			const descriptionSuffix = description ? `: ${description}` : "";
			throw new AIError.OAuthError(`Device flow failed: ${error}${descriptionSuffix}`, {
				kind: "polling",
				provider: "github-copilot",
			});
		}
	}

	if (slowDownResponses > 0) {
		throw new AIError.OAuthError(
			"Device flow timed out after one or more slow_down responses. This is often caused by clock drift in WSL or VM environments. Please sync or restart the VM clock and try again.",
			{ kind: "timeout", provider: "github-copilot" },
		);
	}

	throw new AIError.OAuthError("Device flow timed out", { kind: "timeout", provider: "github-copilot" });
}

/** Far-future expiry (10 years). GitHub OAuth tokens are long-lived; no JWT exchange needed. */
const FAR_FUTURE_MS = Date.now() + 10 * 365.25 * 24 * 60 * 60 * 1000;

/**
 * Refresh GitHub Copilot token.
 * GitHub OAuth tokens from both the former OpenCode app and the Copilot CLI app
 * remain directly usable, so existing logins need no token exchange or migration.
 */
export function refreshGitHubCopilotToken(
	refreshToken: string,
	enterpriseDomain?: string,
	apiEndpoint?: string,
): OAuthCredentials {
	return {
		refresh: refreshToken,
		access: refreshToken,
		expires: FAR_FUTURE_MS,
		enterpriseUrl: enterpriseDomain,
		apiEndpoint,
	};
}

/**
 * Enable a model for the user's GitHub Copilot account.
 * This is required for some models (like Claude, Grok) before they can be used.
 */
async function enableGitHubCopilotModel(
	token: string,
	modelId: string,
	fetchImpl: FetchImpl,
	enterpriseDomain: string | undefined,
	apiEndpoint: string | undefined,
): Promise<boolean> {
	const baseUrl = apiEndpoint ?? getGitHubCopilotBaseUrl(enterpriseDomain);
	const url = `${baseUrl}/models/${modelId}/policy`;

	try {
		const response = await fetchImpl(url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${token}`,
				...COPILOT_API_HEADERS,
				"Openai-Intent": "chat-policy",
				"X-Initiator": "user",
				"X-Interaction-Type": "chat-policy",
			},
			body: JSON.stringify({ state: "enabled" }),
		});
		return response.ok;
	} catch {
		return false;
	}
}

/**
 * Enable all known GitHub Copilot models that may require policy acceptance.
 * Called after successful login to ensure all models are available.
 */
async function enableAllGitHubCopilotModels(
	token: string,
	enterpriseDomain: string | undefined,
	apiEndpoint: string | undefined,
	fetchImpl: FetchImpl,
	onProgress?: (model: string, success: boolean) => void,
): Promise<void> {
	// Synthesized catalog variants (Copilot long-context `-1m` entries) share
	// the upstream model id; enable each wire id exactly once.
	const wireModelIds = [...new Set(getBundledModels("github-copilot").map(model => model.requestModelId ?? model.id))];
	const BATCH_SIZE = 5;
	for (let i = 0; i < wireModelIds.length; i += BATCH_SIZE) {
		const batch = wireModelIds.slice(i, i + BATCH_SIZE);
		await Promise.all(
			batch.map(async modelId => {
				const success = await enableGitHubCopilotModel(token, modelId, fetchImpl, enterpriseDomain, apiEndpoint);
				onProgress?.(modelId, success);
			}),
		);
	}
}

/**
 * Login with GitHub Copilot OAuth (device code flow)
 *
 * @param options.onAuth - Callback with URL and optional instructions (user code)
 * @param options.onPrompt - Callback to prompt user for input
 * @param options.onProgress - Optional progress callback
 * @param options.signal - Optional AbortSignal for cancellation
 */
export async function loginGitHubCopilot(options: GitHubCopilotLoginOptions): Promise<OAuthCredentials> {
	const fetchImpl = options.fetch ?? fetch;
	const input = await options.onPrompt({
		message: "GitHub Enterprise URL/domain (blank for github.com)",
		placeholder: "company.ghe.com",
		allowEmpty: true,
	});

	if (options.signal?.aborted) {
		throw new AIError.LoginCancelledError();
	}

	const trimmed = input.trim();
	const normalizedDomain = normalizeDomain(input);
	if (trimmed && !normalizedDomain) {
		throw new AIError.OAuthError("Invalid GitHub Enterprise URL/domain", {
			kind: "validation",
			provider: "github-copilot",
		});
	}
	const enterpriseDomain = normalizeGitHubCopilotEnterpriseDomain(normalizedDomain ?? undefined);
	const domain =
		normalizedDomain && isPublicGitHubHost(normalizedDomain) ? "github.com" : (normalizedDomain ?? "github.com");

	const device = await startDeviceFlow(domain, fetchImpl);
	options.onAuth(device.verification_uri, `Enter code: ${device.user_code}`);

	const githubAccessToken = await pollForGitHubAccessToken(
		domain,
		device.device_code,
		device.interval,
		device.expires_in,
		options.signal,
		fetchImpl,
		options.pollIntervalFloorMs,
		options.pollIntervalScaleMs,
	);

	const apiEndpoint = await discoverGitHubCopilotApiEndpoint(githubAccessToken, fetchImpl);

	// Keep storing the GitHub token directly so credentials minted by the former
	// OpenCode OAuth app remain valid alongside new Copilot CLI app logins.
	const credentials: OAuthCredentials = {
		refresh: githubAccessToken,
		access: githubAccessToken,
		expires: FAR_FUTURE_MS,
		enterpriseUrl: enterpriseDomain ?? undefined,
		apiEndpoint,
	};

	// Enable all models after successful login
	options.onProgress?.("Enabling models...");
	await enableAllGitHubCopilotModels(githubAccessToken, enterpriseDomain ?? undefined, apiEndpoint, fetchImpl);
	return credentials;
}
