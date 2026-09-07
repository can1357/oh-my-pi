/**
 * Prometheus text-exposition renderer for the auth-broker `/metrics` endpoint.
 * Pure `UsageReport[] -> string`: no I/O and no metrics library, so
 * it stays dependency-free on the broker and unit-testable in isolation.
 *
 * Emits the `llm_usage_*` gauge family a monitoring dashboard binds to.
 * Those names are the cross-repo contract — the dashboard exprs use them
 * verbatim, so the renderer must not rename a family. The label set is bounded:
 * {provider, account, email, limit_id, window} (+ unit on the raw-amount
 * families). `email` is exported to the monitoring backend by design so the
 * subscription accounts are human-readable on the dashboard. Windows are
 * rows, never hardcoded tiers, so a new limit window appears as a new series
 * with zero renderer change.
 */
import type { UsageLimit, UsageReport, UsageStatus } from "../usage";
import { resolveUsedFraction } from "../usage";

/** Content-type for a Prometheus v0.0.4 text exposition response. */
export const PROMETHEUS_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";

/** Sentinel account label when a report carries no stable account id. */
export const UNIDENTIFIED_ACCOUNT = "unidentified";

/** First non-empty trimmed string among `metadata[key]` for the given keys. */
function metadataIdentity(report: UsageReport, keys: readonly string[]): string | undefined {
	for (const key of keys) {
		const value = report.metadata?.[key];
		if (typeof value === "string" && value.trim().length > 0) return value.trim();
	}
	return undefined;
}

/**
 * Stable, opaque account label derived from report data alone.
 *
 * The renderer sees only the {@link UsageReport}, never the credential, so the
 * label must come from the report. `accountId` placement is inconsistent across
 * providers: Codex sets `metadata.accountId` (and `scope.accountId` on its
 * additional limits); Claude's profile path sets `metadata.accountId`; Claude's
 * ratelimit-header path carries none. So check `metadata.accountId`, then fall
 * back to any `limit.scope.accountId`. Stays the opaque stable id because it is
 * the series/join key the dashboard joins on — the human-readable address rides
 * as its own `email` label. Never a report ordinal (unstable under the
 * null-filtered report fan-out — a dropped credential would remap every later
 * account).
 *
 * When no accountId exists anywhere, fall through the SAME stable-identity
 * chain the storage layer already trusts to tell credentials apart
 * (`AuthStorage.#getUsageReportIdentifiers`): `metadata.projectId`, then the
 * `account`/`user`/`username` aliases various providers populate instead of
 * `accountId`, then any `limit.scope.projectId`. Without this, several
 * credentials of one provider that carry no accountId (a Gemini pool keyed only
 * by GCP project, the Claude ratelimit-header path) all render
 * `account="unidentified"`; with the same empty org/email they become one
 * series identity and `renderUsageMetrics`'s duplicate detection DROPS every
 * report after the first, silently losing that credential's usage entirely.
 *
 * Every source here is a provider-assigned identifier that survives a process
 * restart, so a series keeps its identity across broker restarts. Deliberately
 * NOT included: anything derived from a token/secret (rotates on OAuth refresh),
 * report position, or `fetchedAt`. When none of them exist the sentinel is still
 * correct — such reports are genuinely indistinguishable from report data alone,
 * and inventing an unstable key would churn series identity on every restart.
 */
export function accountLabelOf(report: UsageReport): string {
	// Trimmed, and a value that trims to empty falls THROUGH rather than becoming
	// the identity: the Claude and Codex paths can copy a padded `accountId`
	// straight from an imported credential, while the subscription parser and
	// AuthStorage both treat these ids as trimmed. Preserving padding here makes
	// the plan/renewal lookup miss and silently omits that account's series.
	const metaId = report.metadata?.accountId;
	if (typeof metaId === "string" && metaId.trim().length > 0) return metaId.trim();
	for (const limit of report.limits) {
		const scopeId = limit.scope.accountId;
		if (typeof scopeId === "string" && scopeId.trim().length > 0) return scopeId.trim();
	}
	// Identity-less: reach for a stable per-credential distinguisher so distinct
	// credentials do not collapse into one dropped-duplicate series.
	const fallback = metadataIdentity(report, ["projectId", "account", "user", "username"]);
	if (fallback !== undefined) return fallback;
	for (const limit of report.limits) {
		const scopeProject = limit.scope.projectId;
		if (typeof scopeProject === "string" && scopeProject.trim().length > 0) return scopeProject.trim();
	}
	return UNIDENTIFIED_ACCOUNT;
}

/**
 * Human-readable account email label, read from `report.metadata?.email`.
 *
 * `metadata` is untyped (`Record<string, unknown>`), so type-guard it; a missing
 * or non-string value emits `email=""` rather than dropping the label, since an
 * inconsistent label set across samples of one family fails the scrape at parse.
 * Canonicalized here (trim + lowercase) because the providers disagree: the
 * Codex path normalizes through `normalizeEmail` (trim + lowercase), while the
 * Claude payload path only trims and never case-folds. `email` is part of every
 * `llm_usage_*` series identity, so a case or whitespace divergence would split
 * one account into two timeseries. Exported to Grafana Cloud by design (Matt's
 * call).
 */
export function emailLabelOf(report: UsageReport): string {
	const email = report.metadata?.email;
	if (typeof email === "string") return email.trim().toLowerCase();
	return "";
}

/**
 * Organization/workspace scope label, read from `report.metadata?.orgId`.
 *
 * One account (Anthropic email, ChatGPT workspace) can hold several org-scoped
 * subscriptions; the storage layer preserves them as separate reports keyed by
 * `metadata.orgId` (see `#getUsageReportIdentifiers`), so the exported series
 * must carry the org too or two subscriptions collapse to one `{provider,
 * account, email}` identity and one org's usage is silently dropped in `add()`.
 * Canonicalized (trim + lowercase) to match the storage layer's org keying, and
 * emitted as `org=""` when absent (single-org accounts) so the label set stays
 * consistent across every sample of a family — an inconsistent set fails the
 * scrape at parse.
 */
export function orgLabelOf(report: UsageReport): string {
	const orgId = report.metadata?.orgId;
	if (typeof orgId === "string") return orgId.trim().toLowerCase();
	return "";
}

/** Numeric gauge value per usage status; absent AND `unknown` both map to -1. */
const STATUS_VALUE: Record<UsageStatus, number> = {
	ok: 0,
	warning: 1,
	exhausted: 2,
	unknown: -1,
};

/** Format a numeric sample value; Go-parseable floats incl. the Inf/NaN forms. */
function formatValue(value: number): string {
	if (Number.isNaN(value)) return "NaN";
	if (value === Number.POSITIVE_INFINITY) return "+Inf";
	if (value === Number.NEGATIVE_INFINITY) return "-Inf";
	return String(value);
}

type Label = readonly [string, string];

/** Escape a label value for text exposition: backslash, quote, then newline. */
function escapeLabelValue(value: string): string {
	return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function renderLabels(labels: readonly Label[]): string {
	if (labels.length === 0) return "";
	const inner = labels.map(([k, v]) => `${k}="${escapeLabelValue(v)}"`).join(",");
	return `{${inner}}`;
}

interface Sample {
	readonly labels: readonly Label[];
	readonly value: number;
}

interface MetricFamily {
	readonly name: string;
	readonly help: string;
	readonly samples: Sample[];
}

/**
 * Static subscription-config lookup injected into {@link renderUsageMetrics}
 * (subscription layer). It carries both a per-account lookup (plan + renewal
 * clock, keyed by the opaque `{provider, account, org}` identity) and the
 * per-plan table (capacity weight + monthly price). Plan strings arrive raw; the
 * renderer canonicalizes them via {@link canonicalizePlan} so a config plan and
 * a Codex-derived `planType` collapse to one series.
 */
export interface SubscriptionLookup {
	/**
	 * Per-account facts, or `undefined` when the account is not configured. `org`
	 * is the canonicalized organization scope ({@link orgLabelOf}), empty for a
	 * single-org account, so one account email's several org-scoped subscriptions
	 * each resolve to their own plan/renewal.
	 */
	lookup(provider: string, account: string, org: string): { plan?: string; renewsAtSeconds?: number } | undefined;
	/** Per-plan facts; emitted once per `{provider, plan}`, outside the per-report loop. */
	plans: ReadonlyArray<{ provider: string; plan: string; capacityWeight: number; monthlyPriceUsd: number }>;
}

/**
 * Canonicalize a plan string the same way the storage layer's `getUsagePlanType`
 * does (`auth-storage.ts` trim / lowercase / whitespace-and-hyphen-to-`_` /
 * strip leading `chatgpt_`), so a config-declared plan and a Codex-derived
 * `planType` produce the identical `plan` label and the `on(provider, plan)`
 * join matches.
 */
export function canonicalizePlan(plan: string): string {
	const normalized = plan
		.trim()
		.toLowerCase()
		.replace(/[\s-]+/g, "_");
	return normalized.startsWith("chatgpt_") ? normalized.slice("chatgpt_".length) : normalized;
}

/**
 * Given a renewal ANCHOR (unix seconds, a known past-or-future bill date) and
 * the current time (unix seconds), return the next renewal at or after `now`,
 * advancing by whole calendar months. Anniversary billing: the anchor's
 * day-of-month is preserved and clamped to the last day of a shorter target
 * month (e.g. a 31st anchor renews on Feb 28). Day-granularity in UTC — on the
 * renewal day itself the anchor is returned (the bill is today), and only a
 * strictly-past day rolls forward. Matches the parser's UTC date-only anchors.
 */
export function nextRenewalSeconds(anchorSec: number, nowSec: number): number {
	const anchor = new Date(anchorSec * 1000);
	const y = anchor.getUTCFullYear();
	const m = anchor.getUTCMonth();
	const d = anchor.getUTCDate();
	// Floor `now` to its UTC calendar day so the comparison is day-granular.
	const now = new Date(nowSec * 1000);
	const nowDayMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
	for (let k = 0; ; k += 1) {
		// Last day of the k-th month after the anchor month, to clamp the day.
		const lastDay = new Date(Date.UTC(y, m + k + 1, 0)).getUTCDate();
		const candidateMs = Date.UTC(y, m + k, Math.min(d, lastDay));
		if (candidateMs >= nowDayMs) return candidateMs / 1000;
	}
}

/**
 * Render usage reports as Prometheus text. `opts.accountLabel` and
 * `opts.emailLabel` are injectable for tests; they default to
 * {@link accountLabelOf} and {@link emailLabelOf}. `opts.subscriptions` supplies
 * the four `llm_subscription_*` families; it defaults to an
 * empty lookup so an absent config yields byte-identical output. Returns an
 * empty string when there are no samples (the endpoint still answers 200 — an
 * absent series set is the signal the dashboard's expected-accounts panel reads).
 */
export function renderUsageMetrics(
	reports: readonly UsageReport[],
	opts: {
		accountLabel?: (report: UsageReport) => string;
		orgLabel?: (report: UsageReport) => string;
		emailLabel?: (report: UsageReport) => string;
		subscriptions?: SubscriptionLookup;
		/** Override clock (tests); epoch ms. */
		now?: () => number;
	} = {},
): string {
	const accountLabel = opts.accountLabel ?? accountLabelOf;
	const orgLabel = opts.orgLabel ?? orgLabelOf;
	const emailLabel = opts.emailLabel ?? emailLabelOf;
	const subscriptions = opts.subscriptions ?? { lookup: () => undefined, plans: [] };
	const nowSec = Math.floor((opts.now ?? Date.now)() / 1000);

	// Families in canonical emission order. `_used`/`_max`/`_remaining` carry an
	// extra `unit` label; the others key on {provider, account, org, email,
	// limit_id, window} (or {provider, account, org, email} for the per-report
	// families).
	const families: MetricFamily[] = [
		{
			name: "llm_usage_limit_used_fraction",
			help: "Fraction (0..1) of a usage limit consumed; >1 means overage.",
			samples: [],
		},
		{ name: "llm_usage_limit_used", help: "Amount used for a usage limit, in the series unit label.", samples: [] },
		{ name: "llm_usage_limit_max", help: "Maximum for a usage limit, in the series unit label.", samples: [] },
		{
			name: "llm_usage_limit_remaining",
			help: "Remaining amount for a usage limit, in the series unit label.",
			samples: [],
		},
		{
			name: "llm_usage_limit_resets_at_seconds",
			help: "Unix time (seconds) at which a usage-limit window resets.",
			samples: [],
		},
		{
			name: "llm_usage_limit_status",
			help: "Usage-limit status: 0 ok, 1 warning, 2 exhausted, -1 unknown.",
			samples: [],
		},
		{
			name: "llm_usage_reset_credits_available",
			help: "Saved rate-limit resets an account can redeem right now.",
			samples: [],
		},
		{
			name: "llm_usage_report_fetched_at_seconds",
			help: "Unix time (seconds) the usage report for an account was last fetched.",
			samples: [],
		},
		{
			name: "llm_subscription_info",
			help: "Subscription plan for an account; value 1, plan carried as a label.",
			samples: [],
		},
		{
			name: "llm_subscription_renews_at_seconds",
			help: "Unix time (seconds) at which a subscription next renews (bills).",
			samples: [],
		},
		{
			name: "llm_subscription_plan_capacity_weight",
			help: "Relative capacity multiple of a subscription plan vs the baseline plan.",
			samples: [],
		},
		{
			name: "llm_subscription_plan_price_usd",
			help: "Monthly list price (USD) of a subscription plan.",
			samples: [],
		},
	];
	const byName = new Map(families.map(f => [f.name, f]));
	// Per-family seen-key set: a duplicate {name, labels} fails the WHOLE scrape
	// at parse, so drop-and-note the collision rather than emit it or suffix it.
	const seen = new Map<string, Set<string>>(families.map(f => [f.name, new Set<string>()]));
	const notes: string[] = [];

	const add = (name: string, labels: readonly Label[], value: number | undefined): void => {
		if (value === undefined) return;
		const family = byName.get(name);
		const seenSet = seen.get(name);
		if (!family || !seenSet) return;
		// Serialize the sorted tuple with JSON so label values containing `,` or
		// `=` cannot forge a fragment boundary: a raw `k=v` comma-join lets
		// (account="x,email=y") collide with (account="x", email="y,...").
		const key = JSON.stringify([...labels].sort(([a], [b]) => a.localeCompare(b)));
		if (seenSet.has(key)) {
			// Identify the collided family and its `limit_id` only: a note is a
			// comment line, so any raw label value here would both escape the
			// exposition escaping and leak the address into a non-sample line.
			const limitId = labels.find(([k]) => k === "limit_id")?.[1];
			notes.push(
				limitId === undefined
					? `duplicate series dropped: ${name}`
					: `duplicate series dropped: ${name}{limit_id="${escapeLabelValue(limitId)}"}`,
			);
			return;
		}
		seenSet.add(key);
		family.samples.push({ labels, value });
	};

	for (const report of reports) {
		const provider = report.provider;
		const account = accountLabel(report);
		const org = orgLabel(report);
		const email = emailLabel(report);
		const perAccount: readonly Label[] = [
			["provider", provider],
			["account", account],
			["org", org],
			["email", email],
		];

		add("llm_usage_report_fetched_at_seconds", perAccount, report.fetchedAt / 1000);
		if (report.resetCredits) {
			add("llm_usage_reset_credits_available", perAccount, report.resetCredits.availableCount);
		}

		// Subscription layer: per-account subscription info + renewal clock. Look
		// the account up by its opaque {provider, account, org} identity — one
		// account email can hold several org-scoped subscriptions, each its own
		// plan/renewal, so the org must scope the lookup or one org's config
		// applies to both. The config `plan` is the source for Claude and the
		// override for Codex; when it is absent the Codex-parsed
		// `metadata.planType` is the default. Both are canonicalized identically
		// so the `on(provider, plan)` join matches the per-plan table below.
		// `add()` no-ops on `undefined`, so a missing plan or renewal date is
		// skipped and a lookup miss emits neither. `renewsAtSeconds` is an ANCHOR
		// bill date rolled forward whole calendar months to the next occurrence
		// at-or-after scrape time (see nextRenewalSeconds), so the gauge never
		// reports a past renewal.
		const subscription = subscriptions.lookup(provider, account, org);
		if (subscription) {
			const rawPlan = subscription.plan ?? report.metadata?.planType;
			const plan = typeof rawPlan === "string" ? canonicalizePlan(rawPlan) : undefined;
			// A provider-derived fallback (a renewal-only config entry whose plan
			// comes from the Codex report's `planType`) bypasses the config
			// parser's empty-plan rejection. An empty/whitespace `planType`
			// canonicalizes to "" and would emit `llm_subscription_info{plan=""}`,
			// a series that joins no valid plan table row — skip it when the
			// canonical plan is empty.
			if (plan !== undefined && plan.length > 0) {
				add("llm_subscription_info", [...perAccount, ["plan", plan]], 1);
			}
			add(
				"llm_subscription_renews_at_seconds",
				perAccount,
				subscription.renewsAtSeconds === undefined
					? undefined
					: nextRenewalSeconds(subscription.renewsAtSeconds, nowSec),
			);
		}

		for (const limit of report.limits) {
			const base: readonly Label[] = [
				["provider", provider],
				["account", account],
				["org", org],
				["email", email],
				["limit_id", limit.id],
				["window", limit.window?.id ?? ""],
			];
			addLimit(add, base, limit);
		}
	}

	// Subscription layer: per-plan facts, emitted EXACTLY once per {provider, plan}
	// outside the per-report loop. Emitting inside the loop would produce one
	// duplicate per account on the plan and break the `group_left` join. Plan
	// labels are canonicalized to match the info series' `plan` label.
	for (const { provider, plan, capacityWeight, monthlyPriceUsd } of subscriptions.plans) {
		const planLabels: readonly Label[] = [
			["provider", provider],
			["plan", canonicalizePlan(plan)],
		];
		add("llm_subscription_plan_capacity_weight", planLabels, capacityWeight);
		add("llm_subscription_plan_price_usd", planLabels, monthlyPriceUsd);
	}

	const lines: string[] = [];
	for (const family of families) {
		if (family.samples.length === 0) continue;
		lines.push(`# HELP ${family.name} ${family.help}`);
		lines.push(`# TYPE ${family.name} gauge`);
		for (const sample of family.samples) {
			lines.push(`${family.name}${renderLabels(sample.labels)} ${formatValue(sample.value)}`);
		}
	}
	for (const note of notes) lines.push(`# note ${note}`);
	return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

/** Emit the per-limit families for one {@link UsageLimit} under `base` labels. */
function addLimit(
	add: (name: string, labels: readonly Label[], value: number | undefined) => void,
	base: readonly Label[],
	limit: UsageLimit,
): void {
	add("llm_usage_limit_used_fraction", base, resolveUsedFraction(limit));

	const withUnit: readonly Label[] = [...base, ["unit", limit.amount.unit]];
	add("llm_usage_limit_used", withUnit, limit.amount.used);
	add("llm_usage_limit_max", withUnit, limit.amount.limit);
	add("llm_usage_limit_remaining", withUnit, limit.amount.remaining);

	if (limit.window?.resetsAt !== undefined) {
		add("llm_usage_limit_resets_at_seconds", base, limit.window.resetsAt / 1000);
	}
	add("llm_usage_limit_status", base, STATUS_VALUE[limit.status ?? "unknown"]);
}
