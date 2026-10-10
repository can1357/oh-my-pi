/**
 * Usage CLI command handler.
 *
 * Handles `omp usage` — fetches provider usage reports for every
 * authenticated account and prints a detailed per-account breakdown
 * (limits, windows, reset times, plan metadata). Accounts whose
 * credentials produced no usage report are listed too, so the output
 * always covers the full credential pool.
 */
import {
	ANTHROPIC_OAUTH_GRANT_TTL_MS,
	type AuthAccountPolicy,
	type AuthStorage,
	type DisabledCredentialSummary,
	type OAuthAccountIdentity,
	isWithinUsageReserve,
	resolveCredentialIdentityKey,
	resolveUsedFraction,
	type UsageHistoryEntry,
	type UsageLimit,
	type UsageReport,
	type UsageUnit,
} from "@oh-my-pi/pi-ai";
import { AuthBrokerClient, AuthBrokerError } from "@oh-my-pi/pi-ai/auth-broker";
import type { ClientUsageClientSummary } from "@oh-my-pi/pi-ai/usage";
import { formatProviderName } from "@oh-my-pi/pi-tui/chrome/format";
import { formatDuration, formatNumber, getProjectDir, sanitizeText } from "@oh-my-pi/pi-utils";
import chalk from "@oh-my-pi/pi-utils/chalk";
import { ModelRegistry } from "../config/model-registry";
import { Settings } from "../config/settings";
import { discoverAuthStorage, loadCliExtensionProviders } from "../sdk";
import { resolveAuthBrokerConfig } from "../session/auth-broker-config";
import { collapseSharedUsageReports, summarizeUsageResetCredits } from "@oh-my-pi/pi-tui/overlays/usage-display";
import { formatCodexUsageReportLabel } from "../slash-commands/helpers/active-oauth-account";
import {
	accountIdentityLabel,
	collectStoredAccounts,
	collectUnreportedAccounts,
	selectReportableAccounts,
	type UsageAccountIdentity,
} from "../slash-commands/helpers/usage-accounts";
import { cfgRetryUsageReservePct } from "../session/settings";
import { cfgDisplayShowZeroUsageMeters } from "../modes/settings";
import { filterUsageReportsForDisplay, type UsageDisplayOptions } from "../utils/usage-display";

const BAR_WIDTH = 28;

export interface UsageCommandArgs {
	action?: string;
	json?: boolean;
	provider?: string;
	redact?: boolean;
	/** Show recorded usage-limit history instead of a live snapshot. */
	history?: boolean;
	/** History window in days (with `history` or the `clients` action). */
	days?: number;
	/** CLI `-e <path>` extension paths to load before fetching live reports. */
	extensions?: string[];
	/** Skip extension discovery; only load explicit `extensions`. */
	noExtensions?: boolean;
}

export interface UsagePolicyDiagnosticsOptions {
	/** Existing global fallback used when an account has no reserve override. */
	globalReservePct: number;
	/** Delegates selector matching to AuthStorage's authoritative policy matcher. */
	getAccountPolicy: (provider: string, identity: OAuthAccountIdentity) => AuthAccountPolicy | undefined;
}

/**
 * Minimal-reveal masks for identity strings (`--redact`).
 *
 * Every mask shows a two-character anchor. When two identities share the
 * anchor, the mask additionally reveals the shortest "middle-out"
 * differentiator — the shortest substring (closest to the string's middle on
 * ties) that no colliding identity contains — as `an*`, `ca*9*`, `ca*nb*`.
 * Prefix growth is deliberately avoided: it leaks the start of the local
 * part (`can.boluk@*`) when a couple of mid-string characters suffice.
 * Duplicate strings (same account on two providers) share a mask.
 */
export function buildRedactionMap(values: Iterable<string>): Map<string, string> {
	const unique = [...new Set(values)];
	const map = new Map<string, string>();
	const byAnchor = new Map<string, string[]>();
	for (const value of unique) {
		const anchor = value.slice(0, 2);
		const list = byAnchor.get(anchor) ?? [];
		list.push(value);
		byAnchor.set(anchor, list);
	}
	for (const value of unique) {
		const anchor = value.slice(0, 2);
		const peers = (byAnchor.get(anchor) ?? []).filter(other => other !== value);
		if (peers.length === 0) {
			map.set(value, `${anchor}*`);
			continue;
		}
		const infix = findDistinguishingInfix(value, peers);
		map.set(value, infix === undefined ? `${anchor}*` : `${anchor}*${infix}*`);
	}
	// Residual collisions (a value whose every substring also occurs in a
	// peer gets the bare anchor mask) fall back to prefix extension.
	const byMask = new Map<string, string[]>();
	for (const value of unique) {
		const mask = map.get(value)!;
		const list = byMask.get(mask) ?? [];
		list.push(value);
		byMask.set(mask, list);
	}
	for (const collided of byMask.values()) {
		if (collided.length < 2) continue;
		for (const value of collided) {
			let length = Math.min(2, value.length);
			while (
				length < value.length &&
				collided.some(other => other !== value && other.startsWith(value.slice(0, length)))
			) {
				length++;
			}
			map.set(value, `${value.slice(0, length)}*`);
		}
	}
	return map;
}

/**
 * Shortest substring of `value` (past the revealed two-char anchor) that no
 * peer contains. Among equal-length candidates, picks the one centered
 * closest to the middle of the string. Returns undefined when every
 * substring also occurs in a peer (e.g. `value` is contained in a peer —
 * that peer's own differentiator keeps the masks distinct).
 */
function findDistinguishingInfix(value: string, peers: string[]): string | undefined {
	const start = Math.min(2, value.length);
	const center = value.length / 2;
	for (let length = 1; length <= value.length - start; length++) {
		let best: { infix: string; distance: number } | undefined;
		for (let pos = start; pos + length <= value.length; pos++) {
			const candidate = value.slice(pos, pos + length);
			if (peers.some(peer => peer.includes(candidate))) continue;
			const distance = Math.abs(pos + length / 2 - center);
			if (!best || distance < best.distance) best = { infix: candidate, distance };
		}
		if (best) return best.infix;
	}
	return undefined;
}

/** Every identity string the output could surface — input for {@link buildRedactionMap}. */
function collectIdentityStrings(
	reports: UsageReport[],
	accounts: UsageAccountIdentity[],
	disabled: DisabledCredentialSummary[] = [],
): string[] {
	const values: string[] = [];
	const add = (value: unknown): void => {
		if (typeof value === "string" && value) values.push(value);
	};
	for (const report of reports) {
		const meta = report.metadata ?? {};
		add(meta.email);
		add(meta.accountId);
		add(meta.projectId);
		add(meta.orgId);
		add(meta.orgName);
		for (const limit of report.limits) {
			add(limit.scope.accountId);
			add(limit.scope.projectId);
			add(limit.scope.orgId);
		}
	}
	for (const account of accounts) {
		add(account.email);
		add(account.accountId);
		add(account.projectId);
		add(account.orgId);
		add(account.orgName);
		add(account.enterpriseUrl);
	}
	for (const summary of disabled) {
		add(summary.email);
		add(summary.accountId);
		add(summary.orgId);
		add(summary.orgName);
	}
	return values;
}

type LimitStatus = NonNullable<UsageLimit["status"]>;

function resolveStatus(limit: UsageLimit): LimitStatus {
	if (limit.status && limit.status !== "unknown") return limit.status;
	const fraction = resolveUsedFraction(limit);
	if (fraction === undefined) return "unknown";
	if (fraction >= 1) return "exhausted";
	if (fraction >= 0.8) return "warning";
	return "ok";
}

const STATUS_COLOR: Record<LimitStatus, (text: string) => string> = {
	exhausted: chalk.red,
	warning: chalk.yellow,
	ok: chalk.green,
	unknown: chalk.dim,
};

/** Worst-of aggregation: exhausted > warning > ok > unknown. */
function aggregateStatus(limits: UsageLimit[]): LimitStatus {
	const statuses = limits.map(resolveStatus);
	if (statuses.includes("exhausted")) return "exhausted";
	if (statuses.includes("warning")) return "warning";
	if (statuses.includes("ok")) return "ok";
	return "unknown";
}

function formatUnitValue(value: number, unit: UsageUnit): string {
	if (unit === "usd") return `$${value.toFixed(2)}`;
	return formatNumber(value);
}

const UNIT_SUFFIX: Record<UsageUnit, string> = {
	tokens: " tokens",
	requests: " requests",
	credits: " credits",
	minutes: " min",
	bytes: " bytes",
	percent: "",
	usd: "",
	unknown: "",
};

function describeAmount(limit: UsageLimit): string {
	const amount = limit.amount;
	const parts: string[] = [];
	const absoluteUnit = amount.unit !== "percent" && amount.unit !== "unknown";
	const fraction = resolveUsedFraction(limit);
	if (absoluteUnit && amount.used !== undefined && amount.limit !== undefined) {
		parts.push(
			`${formatUnitValue(amount.used, amount.unit)} / ${formatUnitValue(amount.limit, amount.unit)}${UNIT_SUFFIX[amount.unit]}`,
		);
	} else if (absoluteUnit && amount.remaining !== undefined) {
		parts.push(`${formatUnitValue(amount.remaining, amount.unit)}${UNIT_SUFFIX[amount.unit]} left`);
	} else if (
		absoluteUnit &&
		amount.used !== undefined &&
		Number.isFinite(amount.used) &&
		amount.limit === undefined &&
		amount.remaining === undefined &&
		fraction === undefined
	) {
		parts.push(`${formatUnitValue(amount.used, amount.unit)}${UNIT_SUFFIX[amount.unit]} used`);
	}
	if (fraction !== undefined) {
		parts.push(`${(fraction * 100).toFixed(1)}% used`);
	} else if (amount.remainingFraction !== undefined) {
		parts.push(`${(amount.remainingFraction * 100).toFixed(1)}% left`);
	}
	if (parts.length === 0) parts.push("no data");
	return parts.join(" · ");
}

function renderBar(limit: UsageLimit): string {
	const fraction = resolveUsedFraction(limit);
	if (fraction === undefined) return chalk.dim("·".repeat(BAR_WIDTH));
	const clamped = Math.min(Math.max(fraction, 0), 1);
	const filled = Math.round(clamped * BAR_WIDTH);
	const color = STATUS_COLOR[resolveStatus(limit)];
	return color("█".repeat(filled)) + chalk.dim("░".repeat(BAR_WIDTH - filled));
}

/** Append the window label when the limit label doesn't already carry it. */
function limitTitle(limit: UsageLimit): string {
	let label = limit.label;
	const tier = limit.scope.tier;
	if (tier && !label.toLowerCase().includes(tier.toLowerCase())) label = `${label} (${tier})`;
	const windowLabel = limit.window?.label ?? limit.scope.windowId;
	if (!windowLabel) return label;
	if (windowLabel.toLowerCase() === "quota window") return label;
	if (label.toLowerCase().includes(windowLabel.toLowerCase())) return label;
	return `${label} (${windowLabel})`;
}

function reportAccountLabel(report: UsageReport, index: number): string {
	const meta = report.metadata ?? {};
	for (const key of ["email", "accountId", "projectId"] as const) {
		const value = meta[key];
		if (typeof value === "string" && value) return value;
	}
	for (const limit of report.limits) {
		const scoped = limit.scope.accountId ?? limit.scope.projectId;
		if (scoped) return scoped;
	}
	return `account ${index + 1}`;
}

/** Bold identity plus the dim same-email qualifier and plan the main view shows. */
function formatQualifiedIdentity(
	report: UsageReport,
	peers: readonly UsageReport[],
	label: string,
	redaction?: Map<string, string>,
): string {
	const identity = sanitizeText((redaction?.get(label) ?? label).replace(/[\r\n\t]+/g, " "));
	const rendered = formatCodexUsageReportLabel(report, peers, label, redaction, true, "inline");
	return `${chalk.bold(identity)}${chalk.dim(rendered.slice(identity.length))}`;
}

function formatAccountHeader(
	report: UsageReport,
	peers: readonly UsageReport[],
	index: number,
	nowMs: number,
	redaction?: Map<string, string>,
): string {
	const status = aggregateStatus(report.limits);
	const icon = STATUS_COLOR[status]("●");
	const label = reportAccountLabel(report, index);
	let header = `${icon} ${chalk.bold(redaction?.get(label) ?? label)}`;
	if (report.provider === "openai-codex") {
		header = `${icon} ${formatQualifiedIdentity(report, peers, label, redaction)}`;
	} else {
		const metaOrgName = report.metadata?.orgName;
		const metaOrgId = report.metadata?.orgId;
		const org = typeof metaOrgName === "string" && metaOrgName ? metaOrgName : metaOrgId;
		if (typeof org === "string" && org && org !== label) header += chalk.dim(` · ${redaction?.get(org) ?? org}`);
		const plan = report.metadata?.planType;
		if (typeof plan === "string" && plan.trim()) header += chalk.dim(` · plan: ${plan.trim()}`);
	}
	if (report.metadata?.daybreak === true) header += chalk.cyan(" · daybreak");
	const resets = summarizeUsageResetCredits(report.resetCredits, nowMs);
	if (resets && resets.bankedCount > 0) {
		header += chalk.cyan(` · ✦ ${resets.bankedCount} saved reset${resets.bankedCount === 1 ? "" : "s"}`);
		if (resets.redeemableCount !== resets.bankedCount) {
			header += chalk.dim(` · ${resets.redeemableCount} usable now`);
		}
		if (resets.soonestExpiry) {
			const expiryMs = Date.parse(resets.soonestExpiry);
			if (expiryMs > nowMs) {
				header += chalk.dim(
					` · soonest expires in ${formatDuration(expiryMs - nowMs)} (${resets.soonestExpiry.slice(0, 10)})`,
				);
			} else {
				header += chalk.dim(` · expired (${resets.soonestExpiry.slice(0, 10)})`);
			}
		}
		if (resets.redeemableCount === 0 && resets.unavailableReason) {
			const reason = sanitizeText(resets.unavailableReason.replace(/[\r\n\t]+/g, " "));
			header += chalk.dim(` · unavailable: ${reason}`);
		}
	}
	if (report.fetchedAt && nowMs - report.fetchedAt > 90_000) {
		header += chalk.dim(` · fetched ${formatDuration(nowMs - report.fetchedAt)} ago`);
	}
	return header;
}

function formatLimitLine(limit: UsageLimit, labelWidth: number, nowMs: number): string[] {
	const status = resolveStatus(limit);
	const title = limitTitle(limit);
	const padded = title.padEnd(labelWidth);
	const details: string[] = [describeAmount(limit)];
	const resetsAt = limit.window?.resetsAt;
	if (resetsAt !== undefined && resetsAt > nowMs) {
		details.push(`${limit.window?.resetLabel ?? "resets"} in ${formatDuration(resetsAt - nowMs)}`);
	}
	const lines = [
		`      ${STATUS_COLOR[status]("●")} ${padded}  ${renderBar(limit)}  ${chalk.dim(details.join(" · "))}`,
	];
	if (limit.notes && limit.notes.length > 0) {
		lines.push(`        ${chalk.dim(limit.notes.join(" · "))}`);
	}
	return lines;
}

interface ProviderLimitTemplate {
	key: string;
	title: string;
}

/**
 * One row per meter (label and window), not per limit id: Codex ids name a slot, and an
 * account without a 5-hour window reports its 7-day one as `primary`. Most providers put the
 * subscription plan in the tier (see {@link meterForLimit}), so the tier joins the key only for
 * meters a single report repeats per tier (e.g. Antigravity's `Usage (<tier>)` rows).
 */
function meterKey(limit: UsageLimit): string {
	return `${limit.label}|${limit.window?.id ?? limit.scope.windowId ?? ""}`;
}

function createLimitRowKey(reports: UsageReport[]): (limit: UsageLimit) => string {
	const tiered = new Set<string>();
	for (const report of reports) {
		const seen = new Set<string>();
		for (const limit of report.limits) {
			const key = meterKey(limit);
			if (seen.has(key)) tiered.add(key);
			seen.add(key);
		}
	}
	return limit => {
		const key = meterKey(limit);
		return tiered.has(key) ? `${key}|${limit.scope.tier ?? ""}` : key;
	};
}

function collectProviderLimitTemplates(
	reports: UsageReport[],
	rowKey: (limit: UsageLimit) => string,
): ProviderLimitTemplate[] {
	const templates: ProviderLimitTemplate[] = [];
	for (const report of reports) {
		// A row first seen in a later report goes right after its predecessor in that report,
		// so each account keeps its own row order.
		let insertAt = 0;
		for (const limit of report.limits) {
			const key = rowKey(limit);
			const existing = templates.findIndex(template => template.key === key);
			if (existing >= 0) {
				insertAt = existing + 1;
				continue;
			}
			templates.splice(insertAt, 0, { key, title: limitTitle(limit) });
			insertAt++;
		}
	}
	return templates;
}

function formatMissingLimitLine(template: ProviderLimitTemplate, labelWidth: number): string {
	const padded = template.title.padEnd(labelWidth);
	return `      ${chalk.dim("○")} ${padded}  ${chalk.dim("·".repeat(BAR_WIDTH))}  ${chalk.dim("not reported")}`;
}

/** Per-window capacity stat: how much account quota is burned and left. */
export interface ProviderWindowStat {
	/** Compact window label, e.g. "5h", "7d". */
	window: string;
	durationMs?: number;
	/** Meter identity when a provider keeps independent meters in one window. */
	meter?: string;
	/** Accounts reporting a limit in this window. */
	accounts: number;
	/** Sum of each account's binding used fraction - accounts' worth of quota burned. */
	usedAccounts: number;
	/** Accounts' worth of quota still available across reporting accounts. */
	remainingAccounts: number;
}

/**
 * Meter identity for a limit that holds its own quota pool inside a window. A model-scoped
 * allowance is a separate pool from the umbrella window it caps - `claude.ts` marks the Fable
 * weekly cap `tier` without `shared` precisely so it cannot gate Opus or Sonnet requests - and
 * reporting it separately keeps a spent scoped cap visible next to the umbrella remainder.
 * Only Anthropic and Codex use `tier` for such a pool; other providers (Copilot, Devin, Muse Code)
 * put the subscription plan there, which must not split one window per plan. Codex meters that
 * carry no tier fall back to the limit-id slug.
 */
function meterForLimit(report: UsageReport, limit: UsageLimit): string | undefined {
	if (report.provider !== "anthropic" && report.provider !== "openai-codex") return undefined;
	const tier = limit.scope.tier?.trim().toLowerCase();
	if (tier) return tier;
	if (report.provider !== "openai-codex") return undefined;
	const slug = limit.id.toLowerCase().split(":")[1];
	return slug && slug !== "primary" && slug !== "secondary" ? slug : "chat";
}

/**
 * Aggregate one provider's reports into per-window quota capacity stats.
 *
 * Limits are bucketed by window duration (5h, 7d, ...). Within a bucket each
 * account contributes its single highest used fraction. Limits that hold their
 * own pool inside a window keep their own bucket: a model-scoped tier cap, and
 * Codex chat versus Spark, which can share a window duration.
 */
export function computeProviderWindowStats(reports: UsageReport[]): ProviderWindowStat[] {
	const buckets = new Map<string, { window: string; durationMs?: number; meter?: string; fractions: number[] }>();
	for (const report of reports) {
		const accountMax = new Map<string, number>();
		for (const limit of report.limits) {
			const fraction = resolveUsedFraction(limit);
			if (fraction === undefined) continue;
			const durationMs = limit.window?.durationMs;
			const windowKey =
				durationMs !== undefined ? `d:${durationMs}` : (limit.scope.windowId ?? limit.window?.label ?? limit.label);
			const meter = meterForLimit(report, limit);
			const key = meter === undefined ? windowKey : `m:${meter}\0${windowKey}`;
			const previous = accountMax.get(key);
			if (previous === undefined || fraction > previous) accountMax.set(key, fraction);
			if (!buckets.has(key)) {
				const window =
					durationMs !== undefined
						? formatDuration(durationMs)
						: (limit.window?.label ?? limit.scope.windowId ?? limit.label);
				buckets.set(key, { window, durationMs, meter, fractions: [] });
			}
		}
		for (const [key, fraction] of accountMax) buckets.get(key)!.fractions.push(fraction);
	}
	return [...buckets.values()]
		.sort((a, b) => {
			const duration = (a.durationMs ?? Number.POSITIVE_INFINITY) - (b.durationMs ?? Number.POSITIVE_INFINITY);
			return duration !== 0 ? duration : (a.meter ?? "").localeCompare(b.meter ?? "");
		})
		.map(bucket => {
			const usedAccounts = bucket.fractions.reduce((sum, fraction) => sum + fraction, 0);
			return {
				window: bucket.window,
				durationMs: bucket.durationMs,
				...(bucket.meter === undefined ? {} : { meter: bucket.meter }),
				accounts: bucket.fractions.length,
				usedAccounts,
				remainingAccounts: Math.max(0, bucket.fractions.length - usedAccounts),
			};
		});
}

/** Re-login warnings render once remaining grant life drops below this. */
const RELOGIN_WARN_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Re-login deadline line for providers whose OAuth grants expire a fixed
 * period after the interactive login (today: Anthropic, ~30 days regardless
 * of refresh rotation). Silent until the deadline is under a week out — a
 * nudge before the broker auto-disables the row, not a permanent countdown.
 */
function formatReloginDeadline(
	account: UsageAccountIdentity,
	nowMs: number,
	redaction?: Map<string, string>,
): string | undefined {
	if (account.provider !== "anthropic" || account.type !== "oauth" || !account.authorizedAt) return undefined;
	const remaining = account.authorizedAt + ANTHROPIC_OAUTH_GRANT_TTL_MS - nowMs;
	if (remaining > RELOGIN_WARN_WINDOW_MS) return undefined;
	const label = accountIdentityLabel(account, redaction);
	if (remaining <= 0) {
		return `  ${chalk.red(`⚠ ${label} — grant is past Anthropic's ~30d lifetime; re-login now`)}`;
	}
	return `  ${chalk.yellow(`⚠ ${label} — re-login within ${formatDuration(remaining)} (Anthropic expires OAuth grants ~30d after login)`)}`;
}

/**
 * Tombstones worth a row in `omp usage`: OAuth credentials torn down
 * automatically (refresh failure, upstream invalidation). Rows the user
 * replaced or deleted deliberately are lifecycle noise, not lost capacity.
 */
function isActionableDisable(summary: DisabledCredentialSummary, activeAccounts: UsageAccountIdentity[] = []): boolean {
	if (summary.type !== "oauth") return false;
	if (/^(replaced by|deleted by user)/i.test(summary.cause)) return false;

	// Do not display tombstone if there is an active account for the same provider
	// matching the same identity (email, accountId, or org).
	const summaryEmail = summary.email?.toLowerCase();
	const summaryAccountId = summary.accountId?.toLowerCase();
	const summaryOrgId = summary.orgId?.toLowerCase();

	const matchesActive = activeAccounts.some(account => {
		if (account.provider !== summary.provider) return false;

		const accountEmail = account.email?.toLowerCase();
		const accountAccountId = account.accountId?.toLowerCase();
		const accountOrgId = account.orgId?.toLowerCase();

		// If email or accountId match, it's the same identity
		if (summaryEmail && accountEmail && summaryEmail === accountEmail) return true;
		if (summaryAccountId && accountAccountId && summaryAccountId === accountAccountId) return true;

		// Fallback: if orgId matches and neither email nor accountId contradicts
		if (summaryOrgId && accountOrgId && summaryOrgId === accountOrgId) return true;

		return false;
	});

	return !matchesActive;
}

/** Human-sized disable cause: the upstream `error_description` when embedded, else the first clause. */
function shortDisableCause(cause: string): string {
	const description = cause.match(/\\?"error_description\\?"\s*:\s*\\?"([^"\\]+)/)?.[1];
	if (description) return description;
	const stripped = cause.replace(/^oauth refresh failed:\s*/i, "");
	const clause = stripped.split(/[;\n]/, 1)[0] ?? stripped;
	return clause.length > 80 ? `${clause.slice(0, 77)}…` : clause;
}

/** Label for a disabled tombstone, masking each identity part under `--redact`. */
function disabledIdentityLabel(summary: DisabledCredentialSummary, redaction?: Map<string, string>): string {
	const base = summary.email ?? summary.accountId ?? "OAuth account";
	const masked = redaction?.get(base) ?? base;
	const org = summary.orgName ?? summary.orgId;
	if (!org || org === base) return masked;
	return `${masked} · ${redaction?.get(org) ?? org}`;
}

function metadataIdentity(report: UsageReport): OAuthAccountIdentity {
	const metadata = report.metadata ?? {};
	const read = (key: keyof OAuthAccountIdentity): string | undefined => {
		const value = metadata[key];
		return typeof value === "string" && value.length > 0 ? value : undefined;
	};
	const firstScoped = (key: "accountId" | "projectId" | "orgId"): string | undefined => {
		for (const limit of report.limits) {
			const value = limit.scope[key];
			if (value) return value;
		}
		return undefined;
	};
	return {
		email: read("email"),
		accountId: read("accountId") ?? firstScoped("accountId"),
		projectId: read("projectId") ?? firstScoped("projectId"),
		orgId: read("orgId") ?? firstScoped("orgId"),
		orgName: read("orgName"),
	};
}

function accountOAuthIdentity(account: UsageAccountIdentity): OAuthAccountIdentity {
	return {
		email: account.email,
		accountId: account.accountId,
		projectId: account.projectId,
		orgId: account.orgId,
		orgName: account.orgName,
	};
}

function policyEnabledProviders(
	reports: UsageReport[],
	accounts: UsageAccountIdentity[],
	options: UsagePolicyDiagnosticsOptions | undefined,
): Set<string> {
	const providers = new Set<string>();
	if (!options) return providers;
	for (const account of accounts) {
		if (account.type === "oauth" && options.getAccountPolicy(account.provider, accountOAuthIdentity(account))) {
			providers.add(account.provider);
		}
	}
	for (const report of reports) {
		if (options.getAccountPolicy(report.provider, metadataIdentity(report))) providers.add(report.provider);
	}
	return providers;
}

function formatPolicyLine(
	provider: string,
	identity: OAuthAccountIdentity,
	limits: UsageLimit[] | undefined,
	options: UsagePolicyDiagnosticsOptions,
): string {
	const policy = options.getAccountPolicy(provider, identity);
	const priority = policy?.priority ?? 0;
	const configuredReservePct = policy?.reservePct;
	const inherited = configuredReservePct === undefined;
	const reservePct = Math.max(0, Math.min(100, configuredReservePct ?? options.globalReservePct));
	const reserveLabel = `${reservePct}% ${inherited ? "(global)" : "(override)"}`;
	// `omp usage` has no model/session context, so report the conservative
	// account-wide state from the most-consumed visible window. Actual routing
	// still scopes limits and selection in AuthStorage.
	// Exhaustion follows the same status-first rule as the limit rows and routing's
	// `isUsageLimitReached`: a provider-reported "exhausted" wins over the fraction.
	const exhausted = (limits ?? []).some(limit => resolveStatus(limit) === "exhausted");
	const usedFractions = (limits ?? [])
		.map(resolveUsedFraction)
		.filter((fraction): fraction is number => fraction !== undefined && Number.isFinite(fraction));
	if (usedFractions.length === 0) {
		const unmeasured = exhausted ? "exhausted" : "reserve unknown";
		return `policy: priority ${priority} · reserve ${reserveLabel} · ${unmeasured}`;
	}
	const remainingFraction = Math.max(0, 1 - Math.max(...usedFractions));
	let state = "eligible";
	if (exhausted || remainingFraction <= 0) state = "exhausted";
	else if (isWithinUsageReserve(remainingFraction, reservePct / 100)) state = "inside reserve";
	return `policy: priority ${priority} · reserve ${reserveLabel} · ${state} · ${(remainingFraction * 100).toFixed(1)}% left`;
}

/**
 * Render the full text breakdown: per provider, per account, every limit
 * with a bar, amounts, and reset times; unattributed credentials trail
 * each provider section as "no usage data" rows.
 */
export function formatUsageBreakdown(
	inputReports: UsageReport[],
	accounts: UsageAccountIdentity[],
	nowMs: number,
	redaction?: Map<string, string>,
	disabled: DisabledCredentialSummary[] = [],
	policyOptions?: UsagePolicyDiagnosticsOptions,
	options: UsageDisplayOptions = {},
): string {
	const displayReports = filterUsageReportsForDisplay(collapseSharedUsageReports(inputReports), options);
	const reportsByProvider = new Map<string, UsageReport[]>();
	for (const report of displayReports) {
		const list = reportsByProvider.get(report.provider) ?? [];
		list.push(report);
		reportsByProvider.set(report.provider, list);
	}
	const unreported = collectUnreportedAccounts(displayReports, accounts);
	const policyProviders = policyEnabledProviders(displayReports, accounts, policyOptions);
	const unreportedByProvider = new Map<string, UsageAccountIdentity[]>();
	for (const account of unreported) {
		const list = unreportedByProvider.get(account.provider) ?? [];
		list.push(account);
		unreportedByProvider.set(account.provider, list);
	}
	const disabledByProvider = new Map<string, DisabledCredentialSummary[]>();
	for (const summary of disabled) {
		if (!isActionableDisable(summary, accounts)) continue;
		const list = disabledByProvider.get(summary.provider) ?? [];
		list.push(summary);
		disabledByProvider.set(summary.provider, list);
	}

	const providers = [
		...new Set([...reportsByProvider.keys(), ...unreportedByProvider.keys(), ...disabledByProvider.keys()]),
	].sort((a, b) => a.localeCompare(b));

	const lines: string[] = [];
	const latestFetchedAt = Math.max(0, ...displayReports.map(report => report.fetchedAt ?? 0));
	const headerSuffix = latestFetchedAt ? chalk.dim(` · fetched ${formatDuration(nowMs - latestFetchedAt)} ago`) : "";
	lines.push(`${chalk.bold("Usage")}${headerSuffix}`);

	for (const provider of providers) {
		const providerReports = reportsByProvider.get(provider) ?? [];
		const providerUnreported = unreportedByProvider.get(provider) ?? [];
		const accountCount = providerReports.length + providerUnreported.length;
		lines.push("");
		lines.push(
			`${chalk.bold.cyan(formatProviderName(provider))} ${chalk.dim(`— ${accountCount} ${accountCount === 1 ? "account" : "accounts"}`)}`,
		);
		// Provider-wide disclaimers render once per provider, not per limit.
		const providerNotes = [...new Set(providerReports.flatMap(report => report.notes ?? []))];
		for (const note of providerNotes)
			lines.push(`  ${chalk.dim(sanitizeText(note.replace(/[\r\n]+/g, " ").replace(/\t/g, "  ")))}`);

		const limitRowKey = createLimitRowKey(providerReports);
		const providerLimitTemplates = collectProviderLimitTemplates(providerReports, limitRowKey);
		// Rows sharing a key can carry different titles (plan tiers), so measure every rendered title.
		const labelWidth = Math.max(
			0,
			...providerLimitTemplates.map(template => template.title.length),
			...providerReports.flatMap(report => report.limits.map(limit => limitTitle(limit).length)),
		);

		providerReports.forEach((report, index) => {
			lines.push(`  ${formatAccountHeader(report, providerReports, index, nowMs, redaction)}`);
			if (policyOptions && policyProviders.has(provider)) {
				lines.push(
					`      ${chalk.dim(formatPolicyLine(provider, metadataIdentity(report), report.limits, policyOptions))}`,
				);
			}
			if (report.limits.length === 0) {
				lines.push(`      ${chalk.dim("no limits reported")}`);
				return;
			}
			const limitsByKey = Map.groupBy(report.limits, limitRowKey);
			for (const template of providerLimitTemplates) {
				const limits = limitsByKey.get(template.key);
				if (!limits) {
					lines.push(formatMissingLimitLine(template, labelWidth));
					continue;
				}
				for (const limit of limits) lines.push(...formatLimitLine(limit, labelWidth, nowMs));
			}
		});

		for (const account of providerUnreported) {
			const label = accountIdentityLabel(account, redaction);
			lines.push(`  ${chalk.dim("○")} ${chalk.dim(`${label} — no usage data`)}`);
			if (policyOptions && account.type === "oauth" && policyProviders.has(provider)) {
				lines.push(
					`      ${chalk.dim(formatPolicyLine(provider, accountOAuthIdentity(account), undefined, policyOptions))}`,
				);
			}
		}

		for (const summary of disabledByProvider.get(provider) ?? []) {
			const label = disabledIdentityLabel(summary, redaction);
			const ago = summary.disabledAtMs !== undefined ? ` ${formatDuration(nowMs - summary.disabledAtMs)} ago` : "";
			lines.push(
				`  ${chalk.red(`✗ ${label} — disabled${ago}: ${sanitizeText(shortDisableCause(summary.cause))}`)} ${chalk.dim("(re-login to restore)")}`,
			);
		}

		for (const account of accounts) {
			if (account.provider !== provider) continue;
			const warning = formatReloginDeadline(account, nowMs, redaction);
			if (warning) lines.push(warning);
		}

		const stats = computeProviderWindowStats(providerReports);
		if (stats.length > 0) {
			const parts = stats.map(stat => {
				const meterLabel = stat.meter ? ` (${stat.meter.charAt(0).toUpperCase()}${stat.meter.slice(1)})` : "";
				return `${stat.window}${meterLabel} → ${stat.usedAccounts.toFixed(2)}/${stat.accounts} ${stat.accounts === 1 ? "account" : "accounts"} used (${stat.remainingAccounts.toFixed(2)}× quota left)`;
			});
			lines.push(`  ${chalk.dim(`capacity: ${parts.join(" · ")}`)}`);
		}
	}

	return lines.join("\n");
}

const HISTORY_SPARK_WIDTH = 48;
const SPARK_LEVELS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const;

interface HistorySeries {
	title: string;
	/** Snapshots ascending by recordedAt (listUsageHistory order). */
	entries: UsageHistoryEntry[];
}

interface HistoryAccount {
	label: string;
	provider: string;
	email?: string;
	accountId?: string;
	recordedAt: number;
	series: Map<string, HistorySeries>;
}

/** Mirror of {@link limitTitle} for history rows (no scope/tier available). */
function historySeriesTitle(entry: UsageHistoryEntry): string {
	const label = entry.label;
	const windowLabel = entry.windowLabel;
	if (!windowLabel) return label;
	if (windowLabel.toLowerCase() === "quota window") return label;
	if (label.toLowerCase().includes(windowLabel.toLowerCase())) return label;
	return `${label} (${windowLabel})`;
}

function historyAccount(entry: UsageHistoryEntry): HistoryAccount {
	return {
		label: entry.email ?? entry.accountId ?? entry.accountKey,
		provider: entry.provider,
		email: entry.email,
		accountId: entry.accountId,
		recordedAt: entry.recordedAt,
		series: new Map(),
	};
}

/** Identity stand-in so same-email accounts get the main view's qualifier. */
function historyIdentityReport(account: HistoryAccount): UsageReport {
	return {
		provider: account.provider,
		fetchedAt: account.recordedAt,
		limits: [],
		metadata: { email: account.email, accountId: account.accountId },
	};
}

function historyStatus(fraction: number | undefined, status: UsageHistoryEntry["status"]): LimitStatus {
	if (status && status !== "unknown") return status;
	if (fraction === undefined) return "unknown";
	if (fraction >= 1) return "exhausted";
	if (fraction >= 0.8) return "warning";
	return "ok";
}

/** Peak-per-bucket sparkline over [sinceMs, nowMs]; empty buckets render dim dots. */
function renderHistorySparkline(entries: UsageHistoryEntry[], sinceMs: number, nowMs: number): string {
	const span = Math.max(1, nowMs - sinceMs);
	// oxlint-disable-next-line unicorn/no-new-array -- length preallocation
	const buckets: Array<number | undefined> = new Array(HISTORY_SPARK_WIDTH).fill(undefined);
	for (const entry of entries) {
		if (entry.usedFraction === undefined) continue;
		const offset = Math.floor(((entry.recordedAt - sinceMs) / span) * HISTORY_SPARK_WIDTH);
		const index = Math.min(HISTORY_SPARK_WIDTH - 1, Math.max(0, offset));
		const prev = buckets[index];
		buckets[index] = prev === undefined ? entry.usedFraction : Math.max(prev, entry.usedFraction);
	}
	return buckets
		.map(fraction => {
			if (fraction === undefined) return chalk.dim("·");
			const clamped = Math.min(Math.max(fraction, 0), 1);
			const level = SPARK_LEVELS[Math.min(SPARK_LEVELS.length - 1, Math.floor(clamped * SPARK_LEVELS.length))];
			return STATUS_COLOR[historyStatus(clamped, undefined)](level);
		})
		.join("");
}

/** Identity strings a history rendering could surface — input for {@link buildRedactionMap}. */
export function collectHistoryIdentityStrings(entries: UsageHistoryEntry[]): string[] {
	const values: string[] = [];
	for (const entry of entries) {
		if (entry.email) values.push(entry.email);
		if (entry.accountId) values.push(entry.accountId);
		values.push(entry.accountKey);
	}
	return values;
}

/**
 * Render recorded usage-limit history: per provider, per account, one
 * peak-per-bucket sparkline per limit window plus latest/peak percentages.
 */
export function formatUsageHistory(
	entries: UsageHistoryEntry[],
	sinceMs: number,
	nowMs: number,
	redaction?: Map<string, string>,
): string {
	const providers = new Map<string, Map<string, HistoryAccount>>();
	for (const entry of entries) {
		let accounts = providers.get(entry.provider);
		if (!accounts) {
			accounts = new Map();
			providers.set(entry.provider, accounts);
		}
		let account = accounts.get(entry.accountKey);
		if (!account) {
			account = historyAccount(entry);
			accounts.set(entry.accountKey, account);
		}
		let series = account.series.get(entry.limitId);
		if (!series) {
			series = { title: historySeriesTitle(entry), entries: [] };
			account.series.set(entry.limitId, series);
		}
		// Labels can change across snapshots (provider renames); latest wins.
		series.title = historySeriesTitle(entry);
		series.entries.push(entry);
	}

	const lines: string[] = [];
	lines.push(
		`${chalk.bold("Usage history")}${chalk.dim(` · last ${formatDuration(nowMs - sinceMs)} · peak per bucket`)}`,
	);

	for (const provider of [...providers.keys()].sort((a, b) => a.localeCompare(b))) {
		const accounts = providers.get(provider) ?? new Map<string, HistoryAccount>();
		lines.push("");
		lines.push(
			`${chalk.bold.cyan(formatProviderName(provider))} ${chalk.dim(`— ${accounts.size} ${accounts.size === 1 ? "account" : "accounts"}`)}`,
		);
		const sortedAccounts = [...accounts.values()].sort((a, b) => a.label.localeCompare(b.label));
		const reports = provider === "openai-codex" ? sortedAccounts.map(historyIdentityReport) : undefined;
		for (const [index, account] of sortedAccounts.entries()) {
			const identity = reports
				? formatQualifiedIdentity(reports[index], reports, account.label, redaction)
				: chalk.bold(redaction?.get(account.label) ?? account.label);
			lines.push(`  ${identity}`);
			const labelWidth = [...account.series.values()].reduce((max, series) => Math.max(max, series.title.length), 0);
			const sortedSeries = [...account.series.values()].sort((a, b) => a.title.localeCompare(b.title));
			for (const series of sortedSeries) {
				const fractions = series.entries
					.map(entry => entry.usedFraction)
					.filter((fraction): fraction is number => fraction !== undefined);
				const latestEntry = series.entries[series.entries.length - 1];
				const latestFraction = fractions.length > 0 ? fractions[fractions.length - 1] : undefined;
				const peakFraction = fractions.length > 0 ? Math.max(...fractions) : undefined;
				const status = historyStatus(latestFraction, latestEntry?.status);
				const details: string[] = [];
				if (latestFraction !== undefined) details.push(`latest ${(latestFraction * 100).toFixed(1)}%`);
				if (peakFraction !== undefined) details.push(`peak ${(peakFraction * 100).toFixed(1)}%`);
				details.push(`${series.entries.length} snapshot${series.entries.length === 1 ? "" : "s"}`);
				lines.push(
					`      ${STATUS_COLOR[status]("●")} ${series.title.padEnd(labelWidth)}  ${renderHistorySparkline(series.entries, sinceMs, nowMs)}  ${chalk.dim(details.join(" · "))}`,
				);
			}
		}
	}

	return lines.join("\n");
}

/**
 * Load extension usage providers and refresh broker credentials, so usage
 * lookups see every provider and account the live session would.
 */
async function loadUsageSources(
	cmd: UsageCommandArgs,
	settings: Settings,
	authStorage: AuthStorage,
): Promise<ModelRegistry> {
	const modelRegistry = new ModelRegistry(authStorage);
	// Extensions contribute usage providers via `registerProvider(name, { usage })`;
	// without loading them their accounts land in `accountsWithoutUsage`.
	await loadCliExtensionProviders(modelRegistry, settings, getProjectDir(), {
		additionalExtensionPaths: cmd.extensions,
		disableExtensionDiscovery: cmd.noExtensions,
		includeAmbientHooks: false,
		discoverModels: false,
	});
	// The broker may serve reports for credentials newer than the local
	// snapshot. Refresh before probing extension providers with local keys
	// and before labeling accounts; offline brokers keep the cached snapshot.
	try {
		await authStorage.credentials.revalidate();
	} catch {
		// Stale identities beat no output.
	}
	return modelRegistry;
}

/** Name the providers that do hold credentials so a mistyped `--provider` id is easy to correct. */
function formatNoProviderCredentials(provider: string, storedAccounts: UsageAccountIdentity[]): string {
	const stored = [...new Set(storedAccounts.map(account => account.provider))].sort();
	const hint =
		stored.length > 0
			? `Providers with stored credentials: ${stored.join(", ")}.`
			: "Run `omp` and use /login to add accounts.";
	return `No credentials stored for provider "${provider}". ${hint}\n`;
}

/** Apply a redaction mask to an optional identity field. */
function maskIdentity(redaction: Map<string, string>, value: string | undefined): string | undefined {
	return value === undefined ? undefined : (redaction.get(value) ?? value);
}

const IDENTITY_METADATA_KEYS = ["email", "accountId", "projectId", "orgId", "orgName"] as const;

/** Mask identity fields in a raw-stripped report for `--redact --json`. */
function redactReportForJson(
	report: Omit<UsageReport, "raw">,
	redaction: Map<string, string>,
): Omit<UsageReport, "raw"> {
	let metadata = report.metadata;
	if (metadata) {
		metadata = { ...metadata };
		for (const key of IDENTITY_METADATA_KEYS) {
			const value = metadata[key];
			if (typeof value === "string") metadata[key] = redaction.get(value) ?? value;
		}
	}
	const limits = report.limits.map(limit => ({
		...limit,
		scope: {
			...limit.scope,
			accountId: maskIdentity(redaction, limit.scope.accountId),
			projectId: maskIdentity(redaction, limit.scope.projectId),
			orgId: maskIdentity(redaction, limit.scope.orgId),
		},
	}));
	return { ...report, metadata, limits };
}

/** Compact token count for burn tables: 1234 → "1.2k", 4_500_000_000 → "4.50B". */
function formatTokenCount(value: number): string {
	if (value >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
	if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
	if (value >= 1e3) return `${(value / 1e3).toFixed(1)}k`;
	return String(Math.round(value));
}

/**
 * Render per-client token burn: one section per install (hostname, short
 * install id, last-seen), one row per (app, provider) aggregate, plus a
 * per-client total. Data comes from broker `/v1/usage/clients` or the local
 * agent DB when this machine hosts the broker.
 */
export function formatClientUsage(clients: ClientUsageClientSummary[], sinceMs: number, nowMs: number): string {
	const lines: string[] = [];
	lines.push(chalk.bold(`Per-client token burn since ${new Date(sinceMs).toISOString().slice(0, 10)}`));
	const headers = ["app", "provider", "requests", "input", "output", "cache r", "cache w", "total", "est cost"];
	for (const client of clients) {
		const label = client.hostname ?? client.installId;
		const idNote = client.hostname ? ` · ${client.installId.slice(0, 8)}` : "";
		const lastSeen = `last seen ${formatDuration(Math.max(0, nowMs - client.lastSeen))} ago`;
		lines.push("");
		lines.push(`${chalk.cyan(label)}${chalk.dim(idNote)} ${chalk.dim(`· ${lastSeen}`)}`);
		if (client.providers.length === 0) {
			lines.push(chalk.dim("  no usage in this window"));
			continue;
		}
		const rows: string[][] = client.providers.map(usage => [
			usage.app ?? "—",
			usage.provider,
			formatNumber(usage.requests),
			formatTokenCount(usage.inputTokens),
			formatTokenCount(usage.outputTokens),
			formatTokenCount(usage.cacheReadTokens),
			formatTokenCount(usage.cacheWriteTokens),
			formatTokenCount(usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens),
			`$${usage.costUsd.toFixed(2)}`,
		]);
		const total = client.providers.reduce(
			(acc, usage) => {
				acc.requests += usage.requests;
				acc.tokens += usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
				acc.costUsd += usage.costUsd;
				return acc;
			},
			{ requests: 0, tokens: 0, costUsd: 0 },
		);
		rows.push([
			"",
			"total",
			formatNumber(total.requests),
			"",
			"",
			"",
			"",
			formatTokenCount(total.tokens),
			`$${total.costUsd.toFixed(2)}`,
		]);
		const widths = headers.map((header, column) => Math.max(header.length, ...rows.map(row => row[column].length)));
		const renderRow = (cells: string[]): string =>
			`  ${cells.map((cell, column) => (column < 2 ? cell.padEnd(widths[column]) : cell.padStart(widths[column]))).join("  ")}`;
		lines.push(chalk.dim(renderRow(headers)));
		for (const [index, row] of rows.entries()) {
			const rendered = renderRow(row);
			lines.push(index === rows.length - 1 ? chalk.bold(rendered) : rendered);
		}
	}
	return lines.join("\n");
}

/** The configured auth broker's client, or undefined when this machine reads its own store. */
async function resolveBrokerClient(): Promise<AuthBrokerClient | undefined> {
	const config = await resolveAuthBrokerConfig();
	return config ? new AuthBrokerClient({ url: config.url, token: config.token }) : undefined;
}

/** One OAuth account as `omp usage accounts` lists it. */
interface OAuthIdentityKeyRow {
	provider: string;
	/** `null` when the credential carries no account identity, so no pool can name it. */
	identityKey: string | null;
	/** Organization or workspace display name, when the provider reports one. */
	orgName?: string;
}

/**
 * Every OAuth account this process sees (after any broker account pool), with
 * the identity key that `task.agentAccountPools`, `sessions.restrict`, and
 * broker account pools match. Only the provider, the key, and the
 * organization's display name leave each credential; tokens never do.
 */
function collectOAuthIdentityKeys(authStorage: AuthStorage, provider: string | undefined): OAuthIdentityKeyRow[] {
	const rows: OAuthIdentityKeyRow[] = [];
	for (const { provider: rowProvider, credential } of authStorage.credentials.list(provider)) {
		if (credential.type !== "oauth") continue;
		const identityKey = resolveCredentialIdentityKey(rowProvider, credential);
		rows.push(
			credential.orgName
				? { provider: rowProvider, identityKey, orgName: credential.orgName }
				: { provider: rowProvider, identityKey },
		);
	}
	return rows;
}

/** Render {@link collectOAuthIdentityKeys} rows grouped under their provider, one key per line. */
function formatOAuthIdentityKeys(rows: readonly OAuthIdentityKeyRow[]): string {
	const width = Math.max(...rows.map(row => row.identityKey?.length ?? 0));
	const lines: string[] = [];
	let provider: string | undefined;
	for (const row of rows) {
		if (row.provider !== provider) {
			provider = row.provider;
			lines.push(chalk.bold(provider));
		}
		if (row.identityKey === null) {
			lines.push(chalk.dim("  (no identity key: no pool can name this account)"));
			continue;
		}
		const orgName = row.orgName ? sanitizeText(row.orgName.replace(/[\r\n\t]+/g, " ")) : undefined;
		lines.push(orgName ? `  ${row.identityKey.padEnd(width)}  ${chalk.dim(orgName)}` : `  ${row.identityKey}`);
	}
	return lines.join("\n");
}

export async function runUsageCommand(cmd: UsageCommandArgs): Promise<void> {
	const settings = await Settings.loadReadOnly();
	const authStorage = await discoverAuthStorage(undefined, { settings });
	try {
		if (cmd.action === "invalidate") {
			const provider = cmd.provider?.toLowerCase();
			if (provider) {
				// Usage providers registered by extensions and broker credentials newer than
				// the cached snapshot count too, so load both before rejecting the id.
				await loadUsageSources(cmd, settings, authStorage);
				const storedAccounts = collectStoredAccounts(authStorage);
				const known =
					authStorage.usage.providerFor(provider) !== undefined ||
					storedAccounts.some(account => account.provider.toLowerCase() === provider);
				if (!known) {
					process.stderr.write(chalk.yellow(formatNoProviderCredentials(provider, storedAccounts)));
					process.exitCode = 1;
					return;
				}
			}
			await authStorage.usage.invalidate(provider);
			if (provider) {
				process.stdout.write(`Invalidated cached usage reports for provider "${provider}".\n`);
			} else {
				process.stdout.write("Invalidated cached usage reports for all providers.\n");
			}
			return;
		}
		if (cmd.action === "accounts") {
			if (cmd.redact) {
				process.stderr.write(
					chalk.red(
						"`omp usage accounts` prints identity keys verbatim for configuration; --redact does not apply.\n",
					),
				);
				process.exitCode = 1;
				return;
			}
			// The listed keys get pasted into task.agentAccountPools, so read the
			// broker's current accounts, not a cached snapshot; offline brokers
			// keep the snapshot.
			try {
				await authStorage.credentials.revalidate();
			} catch {
				// Stale identities beat no output.
			}
			const rows = collectOAuthIdentityKeys(authStorage, cmd.provider?.toLowerCase());
			if (cmd.json) {
				process.stdout.write(`${JSON.stringify({ accounts: rows }, null, 2)}\n`);
				return;
			}
			if (rows.length === 0) {
				const scope = cmd.provider ? ` for provider "${cmd.provider}"` : "";
				process.stderr.write(
					chalk.yellow(`No OAuth accounts found${scope}. Run \`omp\` and use /login to add accounts.\n`),
				);
				process.exitCode = 1;
				return;
			}
			process.stdout.write(`${formatOAuthIdentityKeys(rows)}\n`);
			return;
		}
		if (cmd.action === "clients") {
			const days = cmd.days !== undefined && Number.isFinite(cmd.days) && cmd.days > 0 ? cmd.days : 7;
			const nowMs = Date.now();
			const sinceMs = nowMs - days * 86_400_000;
			// Prefer the broker's fleet-wide record; fall back to the local agent
			// DB, which has rows only when this machine hosts the broker.
			const broker = await resolveBrokerClient();
			const clients = broker
				? (await broker.fetchClientUsageSummary({ sinceMs })).clients
				: authStorage.usage.clientSummary(sinceMs).clients;
			if (cmd.json) {
				process.stdout.write(`${JSON.stringify({ generatedAt: nowMs, sinceMs, clients }, null, 2)}\n`);
				return;
			}
			if (clients.length === 0) {
				process.stderr.write(
					chalk.yellow(
						"No per-client usage recorded yet. Broker-connected clients and the auth-gateway report token burn automatically; set OMP_AUTH_BROKER_URL (or run this on the broker host).\n",
					),
				);
				process.exitCode = 1;
				return;
			}
			process.stdout.write(`${formatClientUsage(clients, sinceMs, nowMs)}\n`);
			return;
		}
		if (cmd.history) {
			const days = cmd.days !== undefined && Number.isFinite(cmd.days) && cmd.days > 0 ? cmd.days : 7;
			const nowMs = Date.now();
			const sinceMs = nowMs - days * 86_400_000;
			const provider = cmd.provider?.toLowerCase();
			// The broker host records every upstream usage fetch; a broker client's own store holds none.
			const broker = await resolveBrokerClient();
			const entries = broker
				? (await broker.fetchUsageHistory({ sinceMs, provider })).entries
				: authStorage.usage.history({ sinceMs, provider });
			const redaction = cmd.redact ? buildRedactionMap(collectHistoryIdentityStrings(entries)) : undefined;
			if (cmd.json) {
				const masked = redaction
					? entries.map(entry => ({
							...entry,
							accountKey: redaction.get(entry.accountKey) ?? entry.accountKey,
							email: maskIdentity(redaction, entry.email),
							accountId: maskIdentity(redaction, entry.accountId),
						}))
					: entries;
				process.stdout.write(`${JSON.stringify({ generatedAt: nowMs, sinceMs, entries: masked }, null, 2)}\n`);
				return;
			}
			if (entries.length === 0) {
				const scope = cmd.provider ? ` for provider "${cmd.provider}"` : "";
				process.stderr.write(
					chalk.yellow(
						`No usage history recorded${scope} yet. Snapshots accumulate whenever usage is fetched (TUI footer, /usage, omp usage).\n`,
					),
				);
				process.exitCode = 1;
				return;
			}
			process.stdout.write(`${formatUsageHistory(entries, sinceMs, nowMs, redaction)}\n`);
			return;
		}
		const policyOptions: UsagePolicyDiagnosticsOptions = {
			globalReservePct: cfgRetryUsageReservePct.get(settings),
			getAccountPolicy: (provider, identity) => authStorage.oauth.policy(provider, identity),
		};
		const modelRegistry = await loadUsageSources(cmd, settings, authStorage);
		const reports =
			(await authStorage.usage.reports({
				baseUrlResolver: provider => modelRegistry.getProviderBaseUrl(provider),
			})) ?? [];
		const storedAccounts = collectStoredAccounts(authStorage);
		let accounts = selectReportableAccounts(
			storedAccounts,
			provider => authStorage.usage.providerFor(provider) !== undefined,
			cmd.provider,
		);
		// Tombstones ride alongside the live pool so an auto-disabled account
		// (e.g. an expired Anthropic grant) is loudly visible instead of just
		// missing. Best-effort: a broker predating the endpoint yields [].
		let disabled: DisabledCredentialSummary[] = [];
		try {
			disabled = await authStorage.credentials.listDisabled();
		} catch {
			// Usage output must not fail because tombstone listing did.
		}
		let filteredReports = reports;
		if (cmd.provider) {
			const wanted = cmd.provider.toLowerCase();
			filteredReports = reports.filter(report => report.provider.toLowerCase() === wanted);
			accounts = accounts.filter(account => account.provider.toLowerCase() === wanted);
			disabled = disabled.filter(summary => summary.provider.toLowerCase() === wanted);
		}

		const redaction = cmd.redact
			? buildRedactionMap(collectIdentityStrings(filteredReports, accounts, disabled))
			: undefined;

		if (cmd.json) {
			// Drop the heavy provider-specific `raw` payload — same shape as the
			// broker/gateway `/v1/usage` endpoints.
			let trimmed = filteredReports.map(({ raw: _raw, ...rest }) => rest);
			let unreportedAccounts = collectUnreportedAccounts(filteredReports, accounts);
			if (redaction) {
				trimmed = trimmed.map(report => redactReportForJson(report, redaction));
				unreportedAccounts = unreportedAccounts.map(account => ({
					...account,
					email: maskIdentity(redaction, account.email),
					accountId: maskIdentity(redaction, account.accountId),
					projectId: maskIdentity(redaction, account.projectId),
					enterpriseUrl: maskIdentity(redaction, account.enterpriseUrl),
					orgId: maskIdentity(redaction, account.orgId),
					orgName: maskIdentity(redaction, account.orgName),
				}));
			}
			const capacity: Record<string, ProviderWindowStat[]> = {};
			for (const report of filteredReports) {
				if (capacity[report.provider]) continue;
				const stats = computeProviderWindowStats(filteredReports.filter(peer => peer.provider === report.provider));
				if (stats.length > 0) capacity[report.provider] = stats;
			}
			let disabledForJson = disabled.filter(summary => isActionableDisable(summary, accounts));
			if (redaction) {
				disabledForJson = disabledForJson.map(summary => ({
					...summary,
					email: maskIdentity(redaction, summary.email),
					accountId: maskIdentity(redaction, summary.accountId),
					orgId: maskIdentity(redaction, summary.orgId),
					orgName: maskIdentity(redaction, summary.orgName),
				}));
			}
			const payload = {
				generatedAt: Date.now(),
				reports: trimmed,
				accountsWithoutUsage: unreportedAccounts,
				disabledCredentials: disabledForJson,
				capacity,
			};
			process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
			return;
		}

		if (filteredReports.length === 0 && accounts.length === 0) {
			// An explicit --provider keeps every stored account of that provider, so
			// reaching here with one means none is stored for it. Without one,
			// credentials may exist only for providers without a usage endpoint.
			let message: string;
			if (cmd.provider) {
				message = formatNoProviderCredentials(cmd.provider, storedAccounts);
			} else if (storedAccounts.length > 0) {
				message = "No usage data. Stored credentials are for providers without a usage endpoint.\n";
			} else {
				message = "No credentials found. Run `omp` and use /login to add accounts.\n";
			}
			process.stderr.write(chalk.yellow(message));
			process.exitCode = 1;
			return;
		}

		process.stdout.write(
			`${formatUsageBreakdown(filteredReports, accounts, Date.now(), redaction, disabled, policyOptions, {
				showZeroUsageMeters: cfgDisplayShowZeroUsageMeters.get(settings),
			})}\n`,
		);
	} catch (error) {
		// Broker-backed reads (`clients`, `--history`) fail on an unreachable or
		// pre-endpoint broker; report one line instead of a stack dump.
		if (!(error instanceof AuthBrokerError)) throw error;
		process.stderr.write(`${chalk.red(`Error: auth broker request failed: ${error.message}`)}\n`);
		process.exitCode = 1;
	} finally {
		authStorage.close();
	}
}
