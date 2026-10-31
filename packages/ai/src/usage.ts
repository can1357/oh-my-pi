/**
 * Usage reporting types for provider quota/limit endpoints.
 *
 * Provides a normalized schema to represent multiple limit windows, model tiers,
 * and shared quotas across providers.
 */
import { type } from "@oh-my-pi/omptype";
import type { FetchImpl, Provider } from "./types";
export type UsageUnit = "percent" | "tokens" | "requests" | "credits" | "usd" | "minutes" | "bytes" | "unknown";

export type UsageStatus = "ok" | "warning" | "exhausted" | "unknown";

/** Time window for a limit (e.g. 5h, 7d, monthly). */
export interface UsageWindow {
	/** Stable identifier (e.g. "5h", "7d", "monthly"). */
	id: string;
	/** Human label (e.g. "5 Hour", "7 Day"). */
	label: string;
	/** Window duration in milliseconds, when known. */
	durationMs?: number;
	/** Absolute reset timestamp in milliseconds since epoch. */
	resetsAt?: number;
	/**
	 * Verb rendered before the {@link resetsAt} countdown (e.g. "tick", "regen").
	 * Defaults to "resets" — override for rolling windows where the timestamp is
	 * an incremental regeneration step rather than a full window reset.
	 */
	resetLabel?: string;
}

/** Quantitative usage data. */
export interface UsageAmount {
	/** Amount used in the given unit. */
	used?: number;
	/** Maximum limit in the given unit. */
	limit?: number;
	/** Remaining amount in the given unit. */
	remaining?: number;
	/** Fraction used (0..1). */
	usedFraction?: number;
	/** Fraction remaining (0..1). */
	remainingFraction?: number;
	/** Unit for the amounts (percent, tokens, etc.). */
	unit: UsageUnit;
}

/** Scope metadata describing what the limit applies to. */
export interface UsageScope {
	provider: Provider;
	accountId?: string;
	projectId?: string;
	orgId?: string;
	modelId?: string;
	tier?: string;
	windowId?: string;
	shared?: boolean;
	/** Stable identity shared by routing-specific copies of one upstream quota. */
	sharedGroup?: string;
}

/** Normalized limit entry for a single window or quota bucket. */
export interface UsageLimit {
	/** Stable identifier for this limit entry. */
	id: string;
	/** Human label for display. */
	label: string;
	scope: UsageScope;
	window?: UsageWindow;
	amount: UsageAmount;
	status?: UsageStatus;
	notes?: string[];
}

/**
 * Per-credit detail for a saved/banked rate-limit reset.
 *
 * Populated when the provider's listing endpoint returns individual credit
 * metadata (e.g. OpenAI Codex credits or Claude Cedar grants). Callers that
 * only need the count can ignore this; display layers use `expiresAt` to show
 * when banked resets expire ([#3339](https://github.com/can1357/oh-my-pi/issues/3339)).
 */
export interface UsageResetCreditDetail {
	/** Opaque provider credit/grant identifier. */
	id?: string;
	/** Human-facing name for the reset. */
	title?: string;
	/** Provider reset program/family. */
	program?: string;
	/** Resets still banked in this credit/grant. */
	remainingCount?: number;
	/** Whether the provider says this credit can be redeemed now. */
	usable?: boolean;
	/** Whether redemption requires an exhausted covered limit. */
	requiresLimit?: boolean;
	/** Normalized {@link UsageLimit.id}s this credit resets. */
	clears?: string[];
	/** Normalized limit ids currently preventing redemption. */
	blocking?: string[];
	/** Used fractions for covered limits, keyed by normalized limit id. */
	usedFractions?: Record<string, number>;
	/** ISO timestamp when the credit was granted. */
	grantedAt?: string;
	/** ISO timestamp when the credit expires and can no longer be redeemed. */
	expiresAt?: string;
	/** Backend status, e.g. `available`, `redeemed`. */
	status?: string;
}

/** Reset credit carrying the provider id required by its consume endpoint. */
export interface UsageResetCredit extends UsageResetCreditDetail {
	id: string;
}

/**
 * Saved/banked rate-limit resets an account can redeem on demand.
 *
 * Surfaced by providers that let users defer a usage-window reset and spend it
 * later (OpenAI Codex and Claude Cedar resets). The redeem itself is a
 * separate, provider-specific action; this is the read-only state for display.
 */
export interface UsageResetCredits {
	/** Number of banked resets, including grants that are not currently usable. */
	availableCount: number;
	/** Number of resets the provider says can be redeemed now. */
	redeemableCount?: number;
	/** Provider-selected credit/grant eligible for the next redemption. */
	nextCreditId?: string;
	/** Whether this account is eligible for the reset program. */
	eligible?: boolean;
	/** Provider reason the program or its credits are unavailable. */
	reason?: string;
	/** ISO timestamp until which redemption is cooling down. */
	cooldownUntil?: string;
	/** Individual credit details (expiry dates, coverage, etc.) when exposed. */
	credits?: UsageResetCreditDetail[];
}

/** Aggregated usage report for a provider. */
export interface UsageReport {
	provider: Provider;
	fetchedAt: number;
	limits: UsageLimit[];
	/** Saved rate-limit resets the account can redeem, when the provider reports them. */
	resetCredits?: UsageResetCredits;
	/**
	 * Provider-wide disclaimers shown once above per-account sections.
	 * Use this for caveats that apply to every limit (e.g. "OMP-observed
	 * spend only"). Per-limit notes that differ per window (e.g. "Overage
	 * requests: N") stay on {@link UsageLimit.notes}.
	 */
	notes?: string[];
	metadata?: Record<string, unknown>;
	raw?: unknown;
}

/**
 * How {@link copyUsageReport} copies one value of a report.
 *
 * - `data`: an open value — a record whose keys are its content (`metadata`, `usedFractions`),
 *   a list, or a primitive. Copied as JSON copies it: each own enumerable string key and each
 *   array element, read once.
 * - `fields`: a known shape — the report, a limit, its window. Copied by reading each field the
 *   shape has, the way a field read reads it, so an inherited or non-enumerable field and a
 *   prototype getter arrive as they would for the host. Nothing else on the object is read.
 * - `items`: a list whose items all have one schema.
 */
type ReportSchema =
	| { readonly kind: "data" }
	| { readonly kind: "fields"; readonly fields: readonly (readonly [field: string, schema: ReportSchema])[] }
	| { readonly kind: "items"; readonly items: ReportSchema };

const DATA: ReportSchema = { kind: "data" };

/** A known shape: one entry for every field of `T`, so a field added to `T` does not compile until
 *  it says how it is copied. */
function fieldsOf<T>(fields: { readonly [K in keyof T]-?: ReportSchema }): ReportSchema {
	return { kind: "fields", fields: Object.entries<ReportSchema>(fields) };
}

const USAGE_LIMIT = fieldsOf<UsageLimit>({
	id: DATA,
	label: DATA,
	scope: fieldsOf<UsageScope>({
		provider: DATA,
		accountId: DATA,
		projectId: DATA,
		orgId: DATA,
		modelId: DATA,
		tier: DATA,
		windowId: DATA,
		shared: DATA,
		sharedGroup: DATA,
	}),
	window: fieldsOf<UsageWindow>({ id: DATA, label: DATA, durationMs: DATA, resetsAt: DATA, resetLabel: DATA }),
	amount: fieldsOf<UsageAmount>({
		used: DATA,
		limit: DATA,
		remaining: DATA,
		usedFraction: DATA,
		remainingFraction: DATA,
		unit: DATA,
	}),
	status: DATA,
	notes: DATA,
});

const USAGE_REPORT = fieldsOf<UsageReport>({
	provider: DATA,
	fetchedAt: DATA,
	limits: { kind: "items", items: USAGE_LIMIT },
	resetCredits: fieldsOf<UsageResetCredits>({
		availableCount: DATA,
		redeemableCount: DATA,
		nextCreditId: DATA,
		eligible: DATA,
		reason: DATA,
		cooldownUntil: DATA,
		credits: {
			kind: "items",
			items: fieldsOf<UsageResetCreditDetail>({
				id: DATA,
				title: DATA,
				program: DATA,
				remainingCount: DATA,
				usable: DATA,
				requiresLimit: DATA,
				clears: DATA,
				blocking: DATA,
				usedFractions: DATA,
				grantedAt: DATA,
				expiresAt: DATA,
				status: DATA,
			}),
		},
	}),
	notes: DATA,
	metadata: DATA,
	raw: DATA,
});

/** Where a copy is taken, for the error that refuses a function where data belongs. */
interface ReportSite {
	readonly provider: string;
	/** The path walked to the value, the provider method whose result it is first. */
	readonly path: (string | number)[];
	/** What the refusal tells the reader to do instead. */
	readonly advice: string;
}

function renderReportPath(path: readonly (string | number)[]): string {
	let rendered = "";
	for (const step of path) {
		if (rendered === "") rendered = String(step);
		else if (typeof step === "number") rendered += `[${step}]`;
		else if (/^[A-Za-z_$][\w$]*$/.test(step)) rendered += `.${step}`;
		else rendered += `[${JSON.stringify(step)}]`;
	}
	return rendered;
}

function copyReportValue(
	value: unknown,
	schema: ReportSchema,
	site: ReportSite,
	copies: Map<ReportSchema, Map<object, unknown>>,
): unknown {
	if (typeof value === "function") {
		throw new Error(
			`Usage provider ${site.provider}: ${renderReportPath(site.path)} is a function, but it must be data. ${site.advice}`,
		);
	}
	if (typeof value !== "object" || value === null) return value;
	let copied = copies.get(schema);
	if (!copied) {
		copied = new Map();
		copies.set(schema, copied);
	}
	const known = copied.get(value);
	if (known !== undefined) return known;
	if (Array.isArray(value)) {
		const itemSchema = schema.kind === "items" ? schema.items : DATA;
		const copy: unknown[] = [];
		copied.set(value, copy);
		const length = value.length;
		for (let index = 0; index < length; index++) {
			site.path.push(index);
			copy[index] = copyReportValue(value[index], itemSchema, site, copies);
			site.path.pop();
		}
		return copy;
	}
	const copy: Record<string, unknown> = {};
	copied.set(value, copy);
	if (schema.kind === "fields") {
		for (const [key, fieldSchema] of schema.fields) {
			site.path.push(key);
			const item = copyReportValue((value as Record<string, unknown>)[key], fieldSchema, site, copies);
			site.path.pop();
			if (item !== undefined) copy[key] = item;
		}
		return copy;
	}
	for (const key of Object.keys(value)) {
		site.path.push(key);
		const item = copyReportValue((value as Record<string, unknown>)[key], DATA, site, copies);
		site.path.pop();
		// Assigning an own `__proto__` key would set the copy's prototype; defined, it stays data.
		if (key === "__proto__") {
			Object.defineProperty(copy, key, { value: item, enumerable: true, writable: true, configurable: true });
		} else {
			copy[key] = item;
		}
	}
	return copy;
}

/**
 * A host-owned plain copy of a usage report a session's provider returned, taken inside that
 * provider's admission. Call it inside the admitted call the report came back from, then use only
 * the copy: the author's report is that author's code as much as its methods are — a getter or a
 * Proxy trap runs whenever the host reads it, and the host reads a report long after the call,
 * caching, merging and ranking it — and the host never writes into it. What the host adds goes on
 * the copy.
 *
 * The report is copied by its schema, each value read once: the fields a report has, inherited
 * or not, and nothing else on it. A function where data belongs is author code the host would
 * otherwise run later with no admission, so it is refused, naming the field it was found at.
 *
 * This mirrors the copy coding-agent's `ModelRegistry` takes of a session's model data
 * (`snapshotAuthorData` in `config/model-registry.ts`), one implementation per package. A host
 * registration's report is the host's data and is not copied.
 */
export function copyUsageReport(
	report: UsageReport | null,
	provider: string,
	method: "fetchUsage" | "parseRateLimitHeaders",
): UsageReport | null {
	return copyReportValue(
		report,
		USAGE_REPORT,
		{ provider, path: [`${method}() result`], advice: "Compute the value before returning it." },
		new Map(),
	) as UsageReport | null;
}

const USAGE_CREDENTIAL = fieldsOf<UsageCredential>({
	type: DATA,
	apiKey: DATA,
	accessToken: DATA,
	refreshToken: DATA,
	expiresAt: DATA,
	accountId: DATA,
	projectId: DATA,
	email: DATA,
	orgId: DATA,
	orgName: DATA,
	enterpriseUrl: DATA,
	region: DATA,
	inferenceRegion: DATA,
	activeOrganizationId: DATA,
	metadata: DATA,
	apiEndpoint: DATA,
});

/**
 * The copy of a usage credential a session's provider is handed — by `supports` and by
 * `fetchUsage` — in place of the host's.
 *
 * The host keeps the credential it puts in a request: after the call it attributes the report to
 * the credential's organization, keys the cache by its identity, and hands its bearer to a
 * completion probe. Handed that object, an author's getter or assignment on it would decide all
 * of those, read outside the session's admission. So the provider gets this copy and the host
 * never reads it again. Copied by its schema, as {@link copyUsageReport} copies a report; the
 * credential is the host's data, so a function in it would be the host's own mistake.
 */
export function handUsageCredential(credential: UsageCredential, provider: string): UsageCredential {
	return copyReportValue(
		credential,
		USAGE_CREDENTIAL,
		{ provider, path: ["credential"], advice: "A usage credential is handed to a provider as data." },
		new Map(),
	) as UsageCredential;
}

/**
 * The logger a session's provider is handed in its fetch context, in place of the storage's.
 *
 * The storage's logger is a capability the host keeps calling: after the provider's call it logs
 * a failed usage-path refresh, and it is handed on to report deduplication. An author handed that
 * object could reassign its methods, and every later host log call would run the author's code,
 * with host arguments, outside the session's admission and after its retirement. This one is the
 * author's own object: each method calls the storage's logger at the moment it is invoked, and
 * nothing else of the storage's logger is copied, so a reassignment reaches only this object.
 */
export function handUsageLogger(logger: UsageLogger): UsageLogger {
	return {
		debug: (message, meta) => logger.debug(message, meta),
		warn: (message, meta) => logger.warn(message, meta),
	};
}

/**
 * Resolve a limit's used fraction (0..1; >1 means overage) from whichever
 * amount fields the provider populated. Precedence mirrors the usage UIs:
 * explicit fraction > used/limit > percent-unit used > inverted remaining.
 */
export function resolveUsedFraction(limit: UsageLimit): number | undefined {
	const amount = limit.amount;
	if (amount.usedFraction !== undefined) return amount.usedFraction;
	if (amount.used !== undefined && amount.limit !== undefined && amount.limit > 0) {
		return amount.used / amount.limit;
	}
	if (amount.unit === "percent" && amount.used !== undefined) return amount.used / 100;
	if (amount.remainingFraction !== undefined) return Math.max(0, 1 - amount.remainingFraction);
	return undefined;
}

/** Float slack so a remaining fraction derived as `1 - used` still matches a reserve it sits exactly on. */
const RESERVE_BOUNDARY_EPSILON = 1e-9;

/** Whether remaining quota is at or below the reserve (both 0..1 fractions). */
export function isWithinUsageReserve(remainingFraction: number, reserveFraction: number): boolean {
	return remainingFraction <= reserveFraction + RESERVE_BOUNDARY_EPSILON;
}

/**
 * One recorded usage-limit snapshot: a single limit window of one account at
 * a point in time. The usage cache itself is latest-snapshot-only; history
 * rows are appended by the auth storage layer whenever a fresh report is
 * fetched, so limit utilization stays inspectable over time.
 */
export interface UsageHistoryEntry {
	/** Epoch ms the report was fetched. */
	recordedAt: number;
	provider: Provider;
	/** Stable credential identity key (account/email/project derived). */
	accountKey: string;
	email?: string;
	accountId?: string;
	/** {@link UsageLimit.id} of the recorded window. */
	limitId: string;
	/** Human label of the limit. */
	label: string;
	windowLabel?: string;
	/** Used fraction (0..1) when resolvable. */
	usedFraction?: number;
	status?: UsageStatus;
	/** Epoch ms the window resets, when known. */
	resetsAt?: number;
}

/** Filter for reading recorded usage history. */
export interface UsageHistoryQuery {
	provider?: string;
	/** Inclusive lower bound on {@link UsageHistoryEntry.recordedAt} (epoch ms). */
	sinceMs?: number;
}

/**
 * Aggregated request usage a client observed for one (provider, model) pair.
 * Clients fold every completed request into per-pair buckets and flush them to
 * the auth broker on a short cadence, so the broker can attribute token burn
 * to the install that produced it.
 */
export interface ObservedUsageEntry {
	/** Epoch ms of the newest request folded into this bucket. */
	at: number;
	provider: Provider;
	model: string;
	/** Completed requests folded into this bucket. */
	requests: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	/** Estimated USD cost of the folded requests (0 when unknown). */
	costUsd: number;
}

/** One client's observed-usage report, keyed by its stable install id. */
export interface ClientUsageReport {
	/** Stable per-machine install id — the client primary key. */
	installId: string;
	/** Human-readable machine name for display surfaces. */
	hostname?: string;
	/** Application label for the process that burned the tokens (e.g. `omp`, `robomp`). */
	app?: string;
	entries: ObservedUsageEntry[];
}

/**
 * Identity a client presents for usage attribution. Defaults to this
 * process's install id / hostname / app label; the auth-gateway overrides it
 * with the identity its caller sent so token burn lands on the originating
 * machine and application instead of the gateway host.
 */
export interface ClientUsageIdentity {
	installId: string;
	hostname?: string;
	app?: string;
}

/** Per-provider aggregate of one client's recorded usage. */
export interface ClientProviderUsage {
	/** Application label the usage was reported under; absent for legacy rows. */
	app?: string;
	provider: string;
	requests: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	costUsd: number;
}

/** One known client with its usage aggregates over the queried window. */
export interface ClientUsageClientSummary {
	installId: string;
	hostname?: string;
	firstSeen: number;
	lastSeen: number;
	providers: ClientProviderUsage[];
}

/** Aggregated per-client usage recorded by the broker host. */
export interface ClientUsageSummary {
	clients: ClientUsageClientSummary[];
}

// ─── Zod schemas (wire-shape validation for the broker `/v1/usage` endpoint) ─

export const usageUnitSchema = type(
	"'percent' | 'tokens' | 'requests' | 'credits' | 'usd' | 'minutes' | 'bytes' | 'unknown'",
);
export const usageStatusSchema = type("'ok' | 'warning' | 'exhausted' | 'unknown'");

export const usageWindowSchema = type({
	id: "string",
	label: "string",
	"durationMs?": "number",
	"resetsAt?": "number",
	"resetLabel?": "string",
});

export const usageAmountSchema = type({
	"used?": "number",
	"limit?": "number",
	"remaining?": "number",
	"usedFraction?": "number",
	"remainingFraction?": "number",
	unit: usageUnitSchema,
});

export const usageScopeSchema = type({
	provider: "string",
	"accountId?": "string",
	"projectId?": "string",
	"orgId?": "string",
	"modelId?": "string",
	"tier?": "string",
	"windowId?": "string",
	"shared?": "boolean",
	"sharedGroup?": "string",
});

export const usageLimitSchema = type({
	id: "string",
	label: "string",
	scope: usageScopeSchema,
	"window?": usageWindowSchema,
	amount: usageAmountSchema,
	"status?": usageStatusSchema,
	"notes?": "string[]",
});

export const usageResetCreditDetailSchema = type({
	"id?": "string",
	"title?": "string",
	"program?": "string",
	"remainingCount?": "number",
	"usable?": "boolean",
	"requiresLimit?": "boolean",
	"clears?": "string[]",
	"blocking?": "string[]",
	"usedFractions?": { "[string]": "number" },
	"grantedAt?": "string",
	"expiresAt?": "string",
	"status?": "string",
});

export const usageResetCreditsSchema = type({
	availableCount: "number",
	"redeemableCount?": "number",
	"nextCreditId?": "string",
	"eligible?": "boolean",
	"reason?": "string",
	"cooldownUntil?": "string",
	"credits?": usageResetCreditDetailSchema.array(),
});

export const usageReportSchema = type({
	provider: "string",
	fetchedAt: "number",
	limits: usageLimitSchema.array(),
	"resetCredits?": usageResetCreditsSchema,
	"notes?": "string[]",
	"metadata?": { "[string]": "unknown" },
	// `raw` is provider-specific and may be anything; the broker strips it before
	// sending the report over the wire, so accept-but-ignore here.
	"raw?": "unknown",
});

/** Optional logger for usage fetchers. */
export interface UsageLogger {
	debug(message: string, meta?: Record<string, unknown>): void;
	warn(message: string, meta?: Record<string, unknown>): void;
}

/** Credential bundle for usage endpoints. */
export interface UsageCredential {
	type: "api_key" | "oauth";
	apiKey?: string;
	accessToken?: string;
	refreshToken?: string;
	expiresAt?: number;
	accountId?: string;
	projectId?: string;
	email?: string;
	/** Organization/workspace the credential is scoped to (see OAuthCredentials.orgId). */
	orgId?: string;
	/** Human-readable organization name for display. */
	orgName?: string;
	enterpriseUrl?: string;
	/** Account residency used for region-aware provider routing. */
	region?: string;
	inferenceRegion?: "global" | "eu" | "us";
	activeOrganizationId?: string;
	metadata?: Record<string, unknown>;
	apiEndpoint?: string;
}

/** Parameters provided to a usage fetcher. */
export interface UsageFetchParams {
	provider: Provider;
	credential: UsageCredential;
	/** Stable credential identity key derived by the auth storage layer. */
	accountKey?: string;
	baseUrl?: string;
	signal?: AbortSignal;
}

/** Shared runtime utilities for fetchers. */
export interface UsageFetchContext {
	fetch: FetchImpl;
	logger?: UsageLogger;
	retryWait?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
	/**
	 * Last report cached for this exact credential cache key, when one exists.
	 * Lets a fetcher keep a field it could not re-read this time (a failed
	 * secondary probe) instead of reporting it as absent.
	 */
	previousReport?: UsageReport;
}

/** Provider implementation for fetching usage information. */
export interface UsageProvider {
	id: Provider;
	/** Bump to retire cached reports of an older shape during last-good retention. */
	cacheVersion?: number;
	fetchUsage(params: UsageFetchParams, ctx: UsageFetchContext): Promise<UsageReport | null>;
	/** Parse provider rate-limit response headers (lowercased keys) into a usage report, if supported. */
	parseRateLimitHeaders?(
		headers: Record<string, string>,
		now?: number,
		context?: { responseStatus?: number },
	): UsageReport | null;
	supports?(params: UsageFetchParams): boolean;
	/** True when fetchUsage contacts upstream and can authenticate the credential for health checks. */
	validatesCredentials?: boolean;
	/** Whether a failed refresh may serve the previous successful report. Defaults to true. */
	retainLastGoodOnFailure?: boolean;
	/** Provider-specific cool-down after a failed refresh. Defaults to the shared short backoff. */
	failureBackoffMs?: number;
}

/** Request context used when ranking usage for a specific model. */
export interface CredentialRankingContext {
	/** Provider model id, when the caller is selecting a credential for one model. */
	modelId?: string;
}

/** Classify an account report as eligible, ineligible, or unknown for a model's plan gate. */
export type PlanGate = (report: UsageReport | null) => boolean | undefined;

/** Strategy for usage-based credential ranking. Providers implement this to opt into smart credential selection. */
export interface CredentialRankingStrategy {
	/**
	 * Account-plan gate for `context.modelId`: a classifier for the account behind a usage report —
	 * eligible (`true`), ineligible (`false`), or unknown (`undefined`, plan not reported) — or
	 * `undefined` when every plan may serve the model.
	 */
	planGate?(context: CredentialRankingContext): PlanGate | undefined;
	/** Idle window after which a session pin stops suppressing usage re-ranking because the provider's prompt cache cannot still be warm; omit for indefinite stickiness. */
	stickyWarmMs?: number;
	/** Extract the primary (short) and secondary (long) window limits from a usage report. */
	findWindowLimits(
		report: UsageReport,
		context?: CredentialRankingContext,
	): {
		primary?: UsageLimit;
		secondary?: UsageLimit;
	};
	/**
	 * Restrict limits to the ones relevant for the requested model before
	 * credential-wide exhaustion checks and ranking. Providers with shared
	 * account-wide quotas can omit this and use all limits.
	 */
	scopeLimits?(report: UsageReport, context?: CredentialRankingContext): UsageLimit[];
	/**
	 * Restrict limits for the opt-in, non-destructive usage-reserve health
	 * check ({@link AuthStorage.health.model}). Distinct from
	 * {@link scopeLimits}, which gates credential-wide hard blocks: a provider
	 * whose model/tier counters are trusted only at confirmed exhaustion for
	 * hard-blocking can still expose them here so the reserve margin protects
	 * the mapped quota before it hits the cap. Falls back to {@link scopeLimits}
	 * when omitted.
	 */
	scopeLimitsForReserve?(report: UsageReport, context?: CredentialRankingContext): UsageLimit[];
	/**
	 * Return a provider-local backoff scope for the requested model. Providers
	 * with backend-specific quotas use this so one exhausted model family does
	 * not block unrelated families on the same OAuth credential.
	 */
	blockScope?(context?: CredentialRankingContext): string | undefined;
	/**
	 * Scopes that apply to a request, most specific first. With a context, the
	 * request's own scope plus any legacy catch-all scope whose blocks still
	 * apply to everything. Without one — reconciliation runs with no request —
	 * every scope whose blocks must be healed.
	 *
	 * A provider that scopes backoff by model family must implement this, or a
	 * block written under one scope is invisible to requests and to healing.
	 */
	blockScopes?(context?: CredentialRankingContext): string[];
	/**
	 * Backoff scopes a fresh usage report can vouch for, each with the limits
	 * gating it. {@link AuthStorage} clears a stale block under a returned scope
	 * once every listed limit is below exhaustion, so a 429 whose retry-after
	 * overstated the real reset does not sideline a recovered account until the
	 * clock runs out. Scopes not returned expire by clock only.
	 *
	 * `healthy` is the provider's own verdict for the scope (e.g. meter metadata):
	 * false never heals; true heals even with empty limits; absent requires
	 * non-empty limits with none exhausted.
	 */
	healableBlockScopes?(report: UsageReport): { blockScope: string; limits: UsageLimit[]; healthy?: boolean }[];
	/** Whether fresh reports can heal legacy account-wide quota backoffs. */
	healsGlobalBlocks?: boolean;
	/** Fallback window durations (ms) when limits don't specify durationMs. */
	windowDefaults: {
		primaryMs: number;
		secondaryMs: number;
	};
	/**
	 * Optional: priority boost for specific credential states (e.g., fresh 5h
	 * ticker start). `primaryUncapped` is true only when the fetched report has
	 * an applicable secondary window but no applicable primary window.
	 */
	hasPriorityBoost?(
		primary: UsageLimit | undefined,
		primaryUncapped?: boolean,
		context?: CredentialRankingContext,
	): boolean;
}
