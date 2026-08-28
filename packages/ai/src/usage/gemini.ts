import { getGeminiCliHeaders } from "@oh-my-pi/pi-catalog/wire/gemini-headers";
import type {
	UsageAmount,
	UsageFetchContext,
	UsageFetchParams,
	UsageLimit,
	UsageProvider,
	UsageReport,
	UsageWindow,
} from "../usage";
import { parseIsoTimestamp } from "./shared";

// (Refresh is the sole responsibility of AuthStorage; no provider-direct refresh here.)

const DEFAULT_ENDPOINT = "https://cloudcode-pa.googleapis.com";

const GEMINI_TIER_MAP: Array<{ tier: string; models: string[] }> = [
	{
		tier: "3-Flash",
		models: ["gemini-3-flash-preview", "gemini-3-flash", "gemini-3.5-flash"],
	},
	{
		tier: "Flash",
		models: ["gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-2.0-flash", "gemini-1.5-flash"],
	},
	{
		tier: "Pro",
		models: [
			"gemini-2.5-pro",
			"gemini-3-pro-preview",
			"gemini-3.1-pro-preview",
			"gemini-3-pro",
			"gemini-3.1-pro",
			"gemini-pro-agent",
			"gemini-1.5-pro",
		],
	},
];

interface LoadCodeAssistResponse {
	cloudaicompanionProject?: string | { id?: string };
	currentTier?: { id?: string; name?: string };
}

interface RetrieveUserQuotaResponse {
	buckets?: Array<{
		modelId?: string;
		remainingFraction?: number;
		resetTime?: string;
	}>;
}

function getProjectId(payload: LoadCodeAssistResponse | undefined): string | undefined {
	if (!payload) return undefined;
	if (typeof payload.cloudaicompanionProject === "string") {
		return payload.cloudaicompanionProject;
	}
	if (payload.cloudaicompanionProject && typeof payload.cloudaicompanionProject === "object") {
		return payload.cloudaicompanionProject.id;
	}
	return undefined;
}

function getModelTier(modelId: string): string | undefined {
	for (const entry of GEMINI_TIER_MAP) {
		if (entry.models.includes(modelId)) {
			return entry.tier;
		}
	}
	const normalized = modelId.toLowerCase();
	if (normalized.includes("flash")) return "Flash";
	if (normalized.includes("pro")) return "Pro";
	return undefined;
}

function parseWindow(resetTime: string | undefined): UsageWindow {
	if (!resetTime) {
		return {
			id: "quota",
			label: "Quota window",
		};
	}
	const resetsAt = parseIsoTimestamp(resetTime);
	if (resetsAt === undefined) {
		return {
			id: "quota",
			label: "Quota window",
		};
	}
	return {
		id: `reset-${resetsAt}`,
		label: "Quota window",
		resetsAt,
	};
}

function buildAmount(remainingFraction: number | undefined): UsageAmount {
	if (remainingFraction === undefined || !Number.isFinite(remainingFraction)) {
		return { unit: "percent" };
	}
	const remaining = Math.min(Math.max(remainingFraction, 0), 1);
	const used = Math.min(Math.max(1 - remaining, 0), 1);
	return {
		unit: "percent",
		used: Math.round(used * 1000) / 10,
		remaining: Math.round(remaining * 1000) / 10,
		limit: 100,
		usedFraction: used,
		remainingFraction: remaining,
	};
}

/**
 * Return the OAuth access token to use against `/v1internal:*`. AuthStorage is
 * the sole refresh authority (broker-aware, single-flighted, rotation-safe);
 * if the token landed here expired or near-expired, the next usage cycle will
 * carry a freshly-refreshed credential. Returning `undefined` short-circuits
 * the probe rather than POSTing a stale token to Google.
 */
function resolveAccessToken(params: UsageFetchParams): string | undefined {
	const { credential } = params;
	if (credential.type !== "oauth") return undefined;
	if (!credential.accessToken) return undefined;
	if (credential.expiresAt !== undefined && credential.expiresAt <= Date.now()) {
		return undefined;
	}
	return credential.accessToken;
}

async function loadCodeAssist(
	params: UsageFetchParams,
	ctx: UsageFetchContext,
	accessToken: string,
	baseUrl: string,
	projectId?: string,
): Promise<LoadCodeAssistResponse | undefined> {
	const response = await ctx.fetch(`${baseUrl}/v1internal:loadCodeAssist`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${accessToken}`,
			"Content-Type": "application/json",
			...getGeminiCliHeaders(),
		},
		body: JSON.stringify({
			...(projectId ? { cloudaicompanionProject: projectId } : {}),
			metadata: {
				ideType: "IDE_UNSPECIFIED",
				platform: "PLATFORM_UNSPECIFIED",
				pluginType: "GEMINI",
			},
		}),
		signal: params.signal,
	});

	if (!response.ok) {
		const errorText = await response.text();
		ctx.logger?.warn("Gemini CLI loadCodeAssist failed", {
			status: response.status,
			error: errorText,
		});
		return undefined;
	}

	return (await response.json()) as LoadCodeAssistResponse;
}

async function fetchQuota(
	params: UsageFetchParams,
	ctx: UsageFetchContext,
	accessToken: string,
	baseUrl: string,
	projectId?: string,
): Promise<RetrieveUserQuotaResponse | undefined> {
	const response = await ctx.fetch(`${baseUrl}/v1internal:retrieveUserQuota`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${accessToken}`,
			"Content-Type": "application/json",
			...getGeminiCliHeaders(),
		},
		body: JSON.stringify(projectId ? { project: projectId } : {}),
		signal: params.signal,
	});

	if (!response.ok) {
		const errorText = await response.text();
		ctx.logger?.warn("Gemini CLI retrieveUserQuota failed", {
			status: response.status,
			error: errorText,
		});
		return undefined;
	}

	return (await response.json()) as RetrieveUserQuotaResponse;
}

export const googleGeminiCliUsageProvider: UsageProvider = {
	id: "google-gemini-cli",
	supports: ({ credential }) => credential.type === "oauth" && !!credential.accessToken,
	async fetchUsage(params, ctx) {
		const { credential } = params;
		if (credential.type !== "oauth") {
			return null;
		}
		const accessToken = resolveAccessToken(params);
		if (!accessToken) {
			return null;
		}

		const baseUrl = (params.baseUrl?.trim() || DEFAULT_ENDPOINT).replace(/\/$/, "");

		const loadResponse = await loadCodeAssist(params, ctx, accessToken, baseUrl, credential.projectId);
		const projectId = credential.projectId ?? getProjectId(loadResponse);
		const quotaResponse = await fetchQuota(params, ctx, accessToken, baseUrl, projectId);
		if (!quotaResponse) {
			return null;
		}

		const limits: UsageLimit[] = [];
		const buckets = quotaResponse.buckets ?? [];

		buckets.forEach((bucket, index) => {
			const modelId = bucket.modelId;
			const window = parseWindow(bucket.resetTime);
			const amount = buildAmount(bucket.remainingFraction);
			const tier = modelId ? getModelTier(modelId) : undefined;
			const label = modelId ? `Gemini ${modelId}` : "Gemini quota";
			const id = `${modelId ?? "unknown"}:${window?.id ?? index}`;

			limits.push({
				id,
				label,
				scope: {
					provider: params.provider,
					accountId: credential.accountId,
					projectId,
					modelId,
					tier,
					windowId: window?.id,
				},
				window,
				amount,
			});
		});

		const report: UsageReport = {
			provider: params.provider,
			fetchedAt: Date.now(),
			limits,
			metadata: {
				currentTierId: loadResponse?.currentTier?.id,
				currentTierName: loadResponse?.currentTier?.name,
			},
			raw: quotaResponse,
		};

		return report;
	},
};
