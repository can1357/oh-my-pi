import { ProviderHttpError } from "../error";
import type {
	CredentialRankingStrategy,
	UsageFetchContext,
	UsageFetchParams,
	UsageLimit,
	UsageProvider,
	UsageReport,
	UsageStatus,
	UsageWindow,
} from "../usage";
import { isRecord } from "../utils";
import { DAY_MS, HOUR_MS } from "./shared";

const OPENCODE_GO_PROVIDER = "opencode-go";
const DEFAULT_ENDPOINT = "https://opencode.ai/zen/go";
const USAGE_PATH = "/v1/usage";

/**
 * `GET /zen/go/v1/usage` response windows. The route is first-party but
 * undocumented (`anomalyco/opencode` `packages/console/app/src/routes/zen/go/v1/usage.ts`)
 * and its shape changed once on merge day, so each window is decoded
 * defensively and malformed windows are skipped rather than failing the report.
 *
 * Per window: `status` is `"ok" | "rate-limited"`, `percent` is a floored,
 * clamped integer 0-100, and `resetsAt` is an ISO timestamp computed server
 * side. The monthly window anchors on the subscription anniversary — not a
 * 30-day rolling span — so it deliberately carries no `durationMs`.
 */
const OPENCODE_GO_WINDOWS = [
	{ key: "rolling", limitId: "rolling-5h", windowId: "5h", label: "5 Hour", durationMs: 5 * HOUR_MS },
	{ key: "weekly", limitId: "weekly", windowId: "7d", label: "Weekly", durationMs: 7 * DAY_MS },
	{ key: "monthly", limitId: "monthly", windowId: "monthly", label: "Monthly", durationMs: undefined },
] as const;

function normalizeBaseUrl(baseUrl?: string): string {
	if (!baseUrl?.trim()) return DEFAULT_ENDPOINT;
	// Strip a trailing `/v1` (models.json carries both `zen/go` and
	// `zen/go/v1` base URLs) so the usage path doesn't double it, while
	// preserving any path-mounted gateway prefix.
	const withoutTrailingSlash = baseUrl.trim().replace(/\/+$/, "");
	return withoutTrailingSlash.replace(/\/v1$/i, "") || DEFAULT_ENDPOINT;
}

function resolveStatus(windowStatus: unknown, usedFraction: number): UsageStatus {
	if (windowStatus === "rate-limited") return "exhausted";
	if (usedFraction >= 1) return "exhausted";
	if (usedFraction >= 0.8) return "warning";
	return "ok";
}

function buildWindowLimit(descriptor: (typeof OPENCODE_GO_WINDOWS)[number], payload: unknown): UsageLimit | undefined {
	if (!isRecord(payload)) return undefined;
	const percent = payload.percent;
	const status = payload.status;
	if (
		typeof percent !== "number" ||
		!Number.isFinite(percent) ||
		percent < 0 ||
		percent > 100 ||
		(status !== "ok" && status !== "rate-limited")
	) {
		return undefined;
	}
	const resetsAtMs = typeof payload.resetsAt === "string" ? Date.parse(payload.resetsAt) : Number.NaN;
	if (!Number.isFinite(resetsAtMs)) return undefined;
	const usedFraction = percent / 100;
	const window: UsageWindow = { id: descriptor.windowId, label: descriptor.label, resetsAt: resetsAtMs };
	if (descriptor.durationMs !== undefined) window.durationMs = descriptor.durationMs;
	return {
		id: descriptor.limitId,
		label: `${descriptor.label} limit`,
		scope: {
			provider: OPENCODE_GO_PROVIDER,
			windowId: descriptor.windowId,
			shared: true,
		},
		window,
		amount: {
			used: percent,
			usedFraction,
			remainingFraction: Math.max(0, 1 - usedFraction),
			unit: "percent",
		},
		status: resolveStatus(status, usedFraction),
	};
}

async function readUpstreamErrorMessage(response: Response): Promise<string | undefined> {
	try {
		const payload = (await response.json()) as unknown;
		if (!isRecord(payload) || !isRecord(payload.error)) return undefined;
		return typeof payload.error.message === "string" ? payload.error.message : undefined;
	} catch {
		return undefined;
	}
}

async function fetchOpenCodeGoUsage(params: UsageFetchParams, ctx: UsageFetchContext): Promise<UsageReport | null> {
	if (params.provider !== OPENCODE_GO_PROVIDER) return null;
	const credential = params.credential;
	if (credential.type !== "api_key" || !credential.apiKey) return null;

	const url = `${normalizeBaseUrl(params.baseUrl)}${USAGE_PATH}`;
	let payload: unknown;
	try {
		const response = await ctx.fetch(url, {
			headers: {
				accept: "application/json",
				authorization: `Bearer ${credential.apiKey}`,
			},
			signal: params.signal,
		});
		if (!response.ok) {
			// 401 (missing/invalid key) and 403 (no Go subscription) must throw
			// so checkCredentials flags the credential as ok:false rather than
			// ok:null (unknown). Other non-ok statuses are transient — return
			// null so the cached last-good report serves through them.
			if (response.status === 401 || response.status === 403) {
				const detail = await readUpstreamErrorMessage(response);
				throw new ProviderHttpError(
					`OpenCode Go usage endpoint returned ${response.status}${detail ? `: ${detail}` : ""}`,
					response.status,
				);
			}
			ctx.logger?.warn("OpenCode Go usage fetch failed", {
				status: response.status,
				statusText: response.statusText,
			});
			return null;
		}
		payload = (await response.json()) as unknown;
	} catch (error) {
		if (error instanceof ProviderHttpError) throw error;
		ctx.logger?.warn("OpenCode Go usage fetch error", { error: String(error) });
		return null;
	}

	if (!isRecord(payload) || !isRecord(payload.usage)) {
		ctx.logger?.warn("OpenCode Go usage response had no usage object");
		return null;
	}
	const usage = payload.usage;
	const limits: UsageLimit[] = [];
	for (const descriptor of OPENCODE_GO_WINDOWS) {
		const limit = buildWindowLimit(descriptor, usage[descriptor.key]);
		if (limit) limits.push(limit);
	}
	// All-or-nothing: a partial report would overwrite the complete last-good
	// report in the usage cache, silently dropping the windows used for
	// ranking and display. Treat any malformed/missing window like a
	// transient failure so the cached report keeps serving instead.
	if (limits.length !== OPENCODE_GO_WINDOWS.length) {
		ctx.logger?.warn("OpenCode Go usage response missing or malformed windows", {
			decoded: limits.map(limit => limit.id),
		});
		return null;
	}

	return {
		provider: OPENCODE_GO_PROVIDER,
		fetchedAt: Date.now(),
		limits,
		metadata: {
			planType: "OpenCode Go",
			endpoint: url,
		},
		raw: payload,
	};
}

export const opencodeGoUsageProvider: UsageProvider = {
	id: OPENCODE_GO_PROVIDER,
	fetchUsage: fetchOpenCodeGoUsage,
	supports: params => params.provider === OPENCODE_GO_PROVIDER && params.credential.type === "api_key",
	validatesCredentials: true,
};

/**
 * Multi-key pools rank by real headroom on the rolling and weekly windows.
 *
 * The monthly window is deliberately display-only: an exhausted monthly can
 * still serve requests when the account's console "Use balance" fallback is
 * enabled, and the usage endpoint does not report that flag — blocking on it
 * would bench a working key until the subscription anniversary. Hard monthly
 * failures still rotate credentials via the `401 Insufficient balance`
 * usage-limit classification ([#3169](https://github.com/can1357/oh-my-pi/issues/3169)).
 */
export const opencodeGoRankingStrategy: CredentialRankingStrategy = {
	findWindowLimits: report => ({
		primary: report.limits.find(limit => limit.id === "rolling-5h"),
		secondary: report.limits.find(limit => limit.id === "weekly"),
	}),
	scopeLimits: report => report.limits.filter(limit => limit.id !== "monthly"),
	windowDefaults: {
		primaryMs: 5 * HOUR_MS,
		secondaryMs: 7 * DAY_MS,
	},
};
