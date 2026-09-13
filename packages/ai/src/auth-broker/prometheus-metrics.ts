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
 * with zero renderer change. Bounded means bounded in CARDINALITY too: the
 * provider-authored `limit_id`/`window` values pass through
 * {@link stableLabelId} so a provider that derives an id from a reset instant
 * cannot mint a fresh series set on every quota reset.
 */
import type { UsageLimit, UsageReport, UsageStatus } from "../usage";
import { canonicalizePlan, resolveUsedFraction } from "../usage";

/** Content-type for a Prometheus v0.0.4 text exposition response. */
export const PROMETHEUS_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";

/** Sentinel account label when a report carries no stable account id. */
export const UNIDENTIFIED_ACCOUNT = "unidentified";

/**
 * First non-empty trimmed string among `metadata[key]` for the given keys,
 * returned under `namespace` so two different metadata keys holding the same
 * opaque string stay two identities.
 */
function metadataIdentity(report: UsageReport, namespace: string, keys: readonly string[]): string | undefined {
	for (const key of keys) {
		const value = report.metadata?.[key];
		if (typeof value === "string" && value.trim().length > 0) return `${namespace}:${value.trim()}`;
	}
	return undefined;
}

/**
 * Namespaces {@link accountLabelOf}'s fallback chain claims, plus the sentinel.
 * A primary `accountId` whose own value falls inside one of these is ambiguous
 * with a fallback identity and must be lifted out — see {@link primaryIdentity}.
 */
const RESERVED_IDENTITY = /^(?:project|account):/;

/**
 * Label value for a primary `accountId`: the trimmed id itself, kept BARE so
 * the dashboard's existing join key is unchanged — unless the id would occupy
 * an identity the fallback chain owns, in which case it is lifted into
 * `account:` (the storage layer's own spelling for an `accountId`) so a
 * credential whose `accountId` is literally `"project:foo"` and one whose
 * `projectId` is `"foo"` stay two series instead of one plus a dropped
 * duplicate. Also covers the sentinel: an `accountId` equal to
 * {@link UNIDENTIFIED_ACCOUNT} would otherwise merge a real account into the
 * unattributable bucket.
 */
function primaryIdentity(id: string): string {
	const trimmed = id.trim();
	if (RESERVED_IDENTITY.test(trimmed) || trimmed === UNIDENTIFIED_ACCOUNT) return `account:${trimmed}`;
	return trimmed;
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
 * Those fallback values are namespaced — `project:` for `metadata.projectId`
 * and `limit.scope.projectId`, `account:` for the `account`/`user`/`username`
 * aliases — mirroring the storage layer's own namespaces so the two layers
 * agree on what counts as one credential. The values are bare strings from
 * unrelated metadata keys, so without a namespace a credential keyed by
 * `projectId="foo"` and one keyed by `account="foo"` (two identities in
 * storage: `project:foo` and `account:foo`) would collapse to the same
 * `account="foo"` label and one of them would again be dropped as a duplicate.
 *
 * The two primary `accountId` paths stay BARE: those labels are the join key
 * the dashboard already binds, and prefixing them wholesale would re-key every
 * existing series. But bare is not enough on its own. `accountId` outranks the
 * fallback chain only WITHIN one report; across reports it is just another
 * opaque provider string, and it can literally BE `"project:foo"` — the Codex
 * and Claude paths copy it from a credential, and `auth-broker import` reads it
 * straight out of a provider's `auth.json` `account_id`. Then one credential's
 * primary and another's `projectId="foo"` fallback both render
 * `account="project:foo"`, and `add()` drops the second report's samples as
 * duplicates — the exact loss the namespaces were introduced to prevent, only
 * now reached from the primary side. Storage keeps those two apart
 * (`account:project:foo` vs `project:foo`), so both do reach this renderer.
 *
 * So a primary value that would land inside a namespace it does not own is
 * lifted into `account:` — again the storage layer's own spelling for an
 * `accountId`, so the two layers still agree. This is a guard on values that
 * could never have rendered unambiguously, not a re-keying: a provider account
 * id is a UUID, an email-like login, or a username, and none of them begins
 * with `project:`/`account:` or equals the sentinel, so every series that
 * exists today keeps its exact label value.
 *
 * Every source here is a provider-assigned identifier that survives a process
 * restart, so a series keeps its identity across broker restarts. Deliberately
 * NOT included: anything derived from a token/secret (rotates on OAuth
 * refresh), report position, or `fetchedAt`. Nor is `email` — it is exported as
 * its own label, never as the account identity. When none of them exist the
 * sentinel is still correct — such reports are genuinely indistinguishable from
 * report data alone, and inventing an unstable key would churn series identity
 * on every restart.
 */
export function accountLabelOf(report: UsageReport): string {
	// Trimmed, and a value that trims to empty falls THROUGH rather than becoming
	// the identity: the Claude and Codex paths can copy a padded `accountId`
	// straight from an imported credential, while the subscription parser and
	// AuthStorage both treat these ids as trimmed. Preserving padding here makes
	// the plan/renewal lookup miss and silently omits that account's series.
	const metaId = report.metadata?.accountId;
	if (typeof metaId === "string" && metaId.trim().length > 0) return primaryIdentity(metaId);
	// A scope fallback applies only when every scoped value AGREES. The label is
	// per-report but the scope is per-limit, so taking the first would export the
	// other accounts' limits — and run the subscription lookup — under one
	// account's identity. `AuthStorage.#getUsageReportScopeAccountId` already
	// requires the same agreement for the same reason, so a mixed report is
	// representable and genuinely ambiguous.
	//
	// Disagreement is TERMINAL, not just "no scoped account": falling through
	// would reach `metadata.projectId`, the account aliases, or a shared
	// `scope.projectId` and label the whole report — every limit, plus the
	// subscription lookup — with one of those instead. Those fallbacks answer
	// "this report has no account identity", which is a different question from
	// "this report has several".
	const scopeAccount = uniqueScopeValue(report, limit => limit.scope.accountId);
	if (scopeAccount === CONFLICTING_SCOPE) return UNIDENTIFIED_ACCOUNT;
	if (scopeAccount !== undefined) return primaryIdentity(scopeAccount);
	// Identity-less: reach for a stable per-credential distinguisher so distinct
	// credentials do not collapse into one dropped-duplicate series. Namespaced
	// per source, and not case-folded — these are opaque provider ids.
	const projectFallback = metadataIdentity(report, "project", ["projectId"]);
	if (projectFallback !== undefined) return projectFallback;
	const accountFallback = metadataIdentity(report, "account", ["account", "user", "username"]);
	if (accountFallback !== undefined) return accountFallback;
	const scopeProject = uniqueScopeValue(report, limit => limit.scope.projectId);
	if (scopeProject === CONFLICTING_SCOPE || scopeProject === undefined) return UNIDENTIFIED_ACCOUNT;
	return `project:${scopeProject}`;
}

/**
 * {@link uniqueScopeValue}'s third outcome: the limits carry several different
 * values. Distinct from `undefined` (none carries one) because a caller must be
 * able to stop rather than try a lower-priority identity — a report with two
 * accounts in it does not have a missing account.
 *
 * A unique symbol, so it cannot collide with a provider-supplied id.
 */
const CONFLICTING_SCOPE = Symbol("conflicting-scope");

/**
 * The one trimmed, non-empty value `read` yields across every limit;
 * `undefined` when no limit carries one, and {@link CONFLICTING_SCOPE} when
 * they disagree.
 *
 * Scope fields are per-limit while every label here is per-report, so a
 * disagreement has no correct single answer: emitting one limit's value would
 * attribute the others' usage to it. Unattributed is recoverable;
 * misattributed is not.
 */
function uniqueScopeValue(
	report: UsageReport,
	read: (limit: UsageReport["limits"][number]) => unknown,
): string | typeof CONFLICTING_SCOPE | undefined {
	let found: string | undefined;
	for (const limit of report.limits) {
		const raw = read(limit);
		if (typeof raw !== "string") continue;
		const value = raw.trim();
		if (value.length === 0) continue;
		if (found !== undefined && found !== value) return CONFLICTING_SCOPE;
		found = value;
	}
	return found;
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
 * Organization/workspace scope label, read from `report.metadata?.orgId` and
 * falling back to the first `limit.scope.orgId`.
 *
 * One account (Anthropic email, ChatGPT workspace) can hold several org-scoped
 * subscriptions; the storage layer preserves them as separate reports keyed by
 * `metadata.orgId` (see `#getUsageReportIdentifiers`), so the exported series
 * must carry the org too or two subscriptions collapse to one `{provider,
 * account, email}` identity and one org's usage is silently dropped in `add()`.
 *
 * The scope fallback matters because `UsageScope` carries `orgId` too, and an
 * embedding caller can build a report whose org lives only there. Without it
 * two different orgs produce the same empty `org=""` identity and the second
 * is dropped, and the subscription `lookup` is called with the wrong scope.
 * `accountLabelOf` already falls back to `limit.scope.accountId` for the same
 * reason; this keeps the two labels reading the same sources.
 *
 * The scope fallback applies ONLY when every scoped org agrees. The label is
 * per-report but `scope.orgId` is per-limit, so picking the first one would
 * stamp one org onto every other org's limits — and onto the subscription
 * `lookup` — misattributing their usage and plan. Disagreement therefore falls
 * through to `org=""`, which is merely unattributed rather than wrong; the
 * report-level `metadata.orgId` remains authoritative when present.
 *
 * Canonicalized (trim + lowercase) to match the storage layer's org keying, and
 * emitted as `org=""` when absent (single-org accounts) so the label set stays
 * consistent across every sample of a family — an inconsistent set fails the
 * scrape at parse. A value that trims to empty falls THROUGH rather than
 * winning, mirroring the account label's trim-then-test order.
 */
export function orgLabelOf(report: UsageReport): string {
	const orgId = report.metadata?.orgId;
	if (typeof orgId === "string" && orgId.trim().length > 0) return orgId.trim().toLowerCase();
	// Lowercased before the comparison, so two spellings of one org still agree;
	// `uniqueScopeValue` does the trimming and the disagreement check. Both of
	// its non-answers mean the same thing here — this label's own absent value
	// IS `""`, so there is no lower-priority source to guard against.
	const scoped = uniqueScopeValue(report, limit =>
		typeof limit.scope.orgId === "string" ? limit.scope.orgId.toLowerCase() : undefined,
	);
	return typeof scoped === "string" ? scoped : "";
}

/**
 * Run of digits long enough to be a timestamp (or an equally unbounded
 * counter) rather than a window duration or a model version.
 *
 * Ten is the discriminating threshold: epoch seconds are 10 digits and epoch
 * milliseconds 13, while every bounded numeric run the providers actually put
 * in an id is far shorter — window durations (`5h`, `7d`, `1mo`, `3u7`),
 * billing periods (`billing-period`), and the longest legitimate run of all,
 * a dated model id (`claude-opus-4-20250514`, 8 digits).
 */
const TIMESTAMP_DIGITS = /\d{10,}/g;

/** Fixed stand-in for an elided timestamp run; a bounded, PromQL-safe token. */
const TIMESTAMP_PLACEHOLDER = "ts";

/**
 * Collapse the timestamp-bearing part of a provider-supplied id so it is safe
 * to use as a Prometheus label value.
 *
 * `limit.id` and `limit.window.id` are both provider-authored strings, and some
 * providers derive them from the window's reset instant: the Gemini CLI path
 * builds `window.id` as `reset-${resetsAt}` and folds it straight into the
 * limit id (`usage/gemini.ts` `parseWindow`). Emitted verbatim, EVERY quota
 * reset re-keys both labels and starts a brand-new set of time series, and the
 * abandoned ones linger for the whole retention window — the classic unbounded
 * cardinality footgun. The reset instant is already exported properly as a
 * VALUE on `llm_usage_limit_resets_at_seconds`, so eliding it from the identity
 * loses nothing.
 *
 * Deliberately a normalization of the provider's own id rather than a new
 * taxonomy: the surrounding structure survives, so `reset-<ms>` becomes
 * `reset-ts` and stays distinguishable from Gemini's own reset-less `quota`
 * window and from every other provider's window id. It is applied to whatever
 * flows through the emit site, so a provider added later cannot reintroduce the
 * same growth, and it is a no-op for the bounded ids every other provider
 * already produces (see {@link TIMESTAMP_DIGITS}).
 *
 * Unconditional by design. `UsageLimit.id` is opaque and providers are
 * extensible, so a provider MAY hold genuinely stable long numeric ids
 * (`quota-1234567890`) that this collapses together — but narrowing elision to
 * known reset-derived shapes would let the next provider reintroduce the
 * unbounded growth this exists to stop. The caller disambiguates a collision
 * with a bounded per-report suffix instead, so no limit's samples are dropped.
 */
export function stableLabelId(id: string): string {
	return id.replace(TIMESTAMP_DIGITS, TIMESTAMP_PLACEHOLDER);
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
 * Re-exported so the metrics renderer's callers keep one import site. The
 * implementation is shared with the storage layer's plan classification — see
 * {@link canonicalizePlan} in `../usage`.
 */
export { canonicalizePlan };

/**
 * Given a renewal ANCHOR (unix seconds, a known past-or-future bill date) and
 * the current time (unix seconds), return the next renewal at or after `now`,
 * advancing by whole calendar months, or `undefined` when either input is not a
 * representable date. Anniversary billing: the anchor's day-of-month is
 * preserved and clamped to the last day of a shorter target month (e.g. a 31st
 * anchor renews on Feb 28). Day-granularity in UTC — on the renewal day itself
 * the anchor is returned (the bill is today), and only a strictly-past day
 * rolls forward. Matches the parser's UTC date-only anchors.
 *
 * `SubscriptionLookup` is an interface an embedder implements, so
 * `renewsAtSeconds` is only nominally a number: `NaN`, `±Infinity`, or a
 * magnitude beyond the ±8.64e15 ms `Date` range all reach here. Each makes
 * every derived date component `NaN`, and `NaN >= nowDayMs` is false forever —
 * a search that advanced month-by-month until the candidate caught up would
 * never terminate and would wedge the event loop for the whole `/metrics`
 * scrape. So the anchor is validated up front and the month offset is computed
 * arithmetically: the target month is known from the two dates directly, and at
 * most one extra month is needed when the anchor's day already passed within
 * that month. Bounded work per call, no search.
 */
export function nextRenewalSeconds(anchorSec: number, nowSec: number): number | undefined {
	if (!Number.isFinite(anchorSec) || !Number.isFinite(nowSec)) return undefined;
	const anchor = new Date(anchorSec * 1000);
	const now = new Date(nowSec * 1000);
	// Finite seconds can still exceed the `Date` range (±8.64e15 ms), which
	// yields an Invalid Date whose every component is NaN.
	if (Number.isNaN(anchor.getTime()) || Number.isNaN(now.getTime())) return undefined;
	const y = anchor.getUTCFullYear();
	const m = anchor.getUTCMonth();
	const d = anchor.getUTCDate();
	// Floor `now` to its UTC calendar day so the comparison is day-granular.
	const nowDayMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
	// Whole calendar months from the anchor's month to `now`'s month. Negative
	// (a future anchor) clamps to 0: the anchor itself is already the next bill.
	const monthsElapsed = (now.getUTCFullYear() - y) * 12 + (now.getUTCMonth() - m);
	// Candidate in the k-th month after the anchor month, day clamped to that
	// month's length.
	const candidateAt = (k: number): number => {
		const lastDay = new Date(Date.UTC(y, m + k + 1, 0)).getUTCDate();
		return Date.UTC(y, m + k, Math.min(d, lastDay));
	};
	const k = Math.max(0, monthsElapsed);
	// Only `now`'s own month can hold a candidate that is already past: every
	// earlier month is wholly past and every later one wholly future.
	const candidateMs = candidateAt(k);
	const next = candidateMs >= nowDayMs ? candidateMs : candidateAt(k + 1);
	// A candidate month past the `Date` range makes `Date.UTC` NaN; emit no
	// sample rather than a NaN gauge.
	return Number.isFinite(next) ? next / 1000 : undefined;
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
		// Canonicalized at the boundary, once: the same value drives the
		// subscription lookup AND every per-account label, and an SDK caller can
		// supply a `UsageReport` whose provider never passed through the CLI
		// parser. Raw, a padded or mis-cased id missed the lookup (so the
		// subscription and renewal series vanished) and labelled the usage series
		// so it could not join the canonicalized plan table.
		const provider = canonicalizeProviderId(report.provider);
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

		// Two limits whose ids differ ONLY inside an elided digit run collapse to
		// the same `limit_id`. Elision has to stay unconditional — restricting it
		// to known reset-derived shapes reopens the unbounded-cardinality hole for
		// the next provider — so the collision falls through to `add()`, which
		// drops the second and records a note.
		//
		// A rank suffix among the colliding ids is NOT an option: the rank is
		// derived from the current report's collision membership, so a limit's
		// series identity would change whenever a peer appears or disappears —
		// `quota-ts#1` becoming `quota-ts` when its lexically-earlier peer drops
		// out silently inherits the other limit's history, which is worse than a
		// gap. Keeping `add()`'s drop-and-note leaves the surviving series' own
		// identity invariant and surfaces the loss in the exposition.
		for (const limit of report.limits) {
			const base: readonly Label[] = [
				["provider", provider],
				["account", account],
				["org", org],
				["email", email],
				// Both ids are provider-authored and some providers derive them
				// from the window's reset instant, which would re-key every
				// series on each reset — see stableLabelId.
				["limit_id", stableLabelId(limit.id)],
				["window", limit.window === undefined ? "" : stableLabelId(limit.window.id)],
			];
			addLimit(add, base, limit);
		}
	}

	// Subscription layer: per-plan facts, emitted EXACTLY once per {provider, plan}
	// outside the per-report loop. Emitting inside the loop would produce one
	// duplicate per account on the plan and break the `group_left` join. Plan
	// labels are canonicalized to match the info series' `plan` label.
	for (const { provider, plan, capacityWeight, monthlyPriceUsd } of subscriptions.plans) {
		// `subscriptions` is a public option, so an embedder can supply a plan the
		// CLI parser's empty-plan rejection never saw. Skip it for the same reason
		// the per-account info series above does: `plan=""` rows join nothing.
		const canonicalPlan = canonicalizePlan(plan);
		if (canonicalPlan.length === 0) continue;
		// Same reasoning for the VALUES: a capacity multiplier and a list price
		// are exported straight to `/metrics`, and the CLI parser rejects a
		// negative or non-finite one at parse time. An embedder bypasses that
		// parser entirely, so re-check here rather than publishing `-1`, `NaN`,
		// or `+Inf` into a gauge every consumer divides by.
		if (!isPublishablePlanFact(capacityWeight) || !isPublishablePlanFact(monthlyPriceUsd)) continue;
		// The provider label needs the same treatment as the plan: the info series
		// carries the canonical id a live usage report arrives with, so a padded
		// or mis-cased embedder value like " Anthropic" publishes capacity and
		// price under a label the documented `on(provider, plan)` join never
		// matches, and the facts vanish from every downstream calculation.
		const canonicalProvider = canonicalizeProviderId(provider);
		if (canonicalProvider.length === 0) continue;
		const planLabels: readonly Label[] = [
			["provider", canonicalProvider],
			["plan", canonicalPlan],
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

/**
 * Canonical provider id for a metric label: trimmed and case-folded.
 *
 * Every provider that reaches a label has to pass through this — a usage
 * report, an embedder's plan table, an operator's config key — because the
 * documented `on(provider, plan)` join is a string match, so one unfolded
 * source silently drops its facts out of every downstream calculation.
 *
 * Normalizing beats rejecting: the `org`, `email`, and `plan` labels are
 * already folded on both sides of the join, so making `provider` the one field
 * where casing is fatal would be the surprising rule.
 */
export function canonicalizeProviderId(provider: string): string {
	return provider.trim().toLowerCase();
}

/**
 * Whether a plan fact may be published: finite and non-negative, matching the
 * CLI parser's rejection. A whole plan is skipped when either fact fails, so
 * `capacity_weight` and `price_usd` cannot disagree about which plans exist.
 */
function isPublishablePlanFact(value: number): boolean {
	return Number.isFinite(value) && value >= 0;
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
