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
	type AuthStorage,
	type DisabledCredentialSummary,
	resolveUsedFraction,
	type UsageHistoryEntry,
	type UsageLimit,
	type UsageReport,
	type UsageUnit,
} from "@oh-my-pi/pi-ai";
import { AuthBrokerClient } from "@oh-my-pi/pi-ai/auth-broker";
import type { ClientUsageClientSummary } from "@oh-my-pi/pi-ai/usage";
import { formatDuration, formatNumber, sanitizeText } from "@oh-my-pi/pi-utils";
import chalk from "@oh-my-pi/pi-utils/chalk";
import { ModelRegistry } from "../config/model-registry";
import { discoverAuthStorage } from "../sdk";
import { resolveAuthBrokerConfig } from "../session/auth-broker-config";

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
}

/** Identity slice of a stored credential, for "every account" coverage. */
export interface UsageAccountIdentity {
	provider: string;
	type: "api_key" | "oauth";
	email?: string;
	accountId?: string;
	projectId?: string;
	enterpriseUrl?: string;
	/** Organization/workspace the credential is scoped to (Anthropic multi-subscription). */
	orgId?: string;
	orgName?: string;
	/** Epoch ms of the interactive login that minted the OAuth grant (see `OAuthCredentials.authorizedAt`). */
	authorizedAt?: number;
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

function formatProviderName(provider: string): string {
	return provider
		.split(/[-_]/g)
		.map(part => (part ? part[0].toUpperCase() + part.slice(1) : ""))
		.join(" ");
}

function formatUnitValue(value: number, unit: UsageUnit): string {
	if (unit === "usd") return `$${value.toFixed(2)}`;
	return formatNumber(value);
}

const UNIT_SUFFIX: Record<UsageUnit, string> = {
	tokens: " tokens",
	requests: " requests",
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

/** Lowercased identity strings a report can be attributed to. */
function reportIdentifiers(report: UsageReport): Set<string> {
	const ids = new Set<string>();
	const add = (value: unknown): void => {
		if (typeof value === "string" && value) ids.add(value.toLowerCase());
	};
	const meta = report.metadata ?? {};
	add(meta.email);
	add(meta.accountId);
	add(meta.projectId);
	add(meta.orgId);
	for (const limit of report.limits) {
		add(limit.scope.accountId);
		add(limit.scope.projectId);
		add(limit.scope.orgId);
	}
	return ids;
}

/**
 * Stored credentials that no usage report could be attributed to.
 *
 * Conservative on purpose: when a provider's reports carry no identity at
 * all (or the credential is an API key alongside existing reports), we
 * can't attribute, so we don't claim the account is missing.
 */
export function collectUnreportedAccounts(
	reports: UsageReport[],
	accounts: UsageAccountIdentity[],
): UsageAccountIdentity[] {
	const byProvider = new Map<string, UsageReport[]>();
	for (const report of reports) {
		const list = byProvider.get(report.provider) ?? [];
		list.push(report);
		byProvider.set(report.provider, list);
	}
	return accounts.filter(account => {
		const providerReports = byProvider.get(account.provider) ?? [];
		if (providerReports.length === 0) return true;
		if (account.type === "api_key") return false;
		// Org-decisive attribution when EITHER side carries an org (Anthropic
		// multi-subscription): two orgs share every other identifier, so an
		// org-scoped account is covered only by its own org's report, and an
		// org-less legacy account is never covered by an org-attributed sibling
		// report — its own fetch failing must surface as "no usage data". Its
		// own ORG-LESS report still covers it, though: a mixed pool (fresh
		// org-scoped logins beside pre-org-capture rows) must not duplicate
		// every legacy account. The shared org is a GATE, not a match: two Team
		// members share the org id while drawing on per-user pools, so coverage
		// also requires the account's own base identity inside the same-org
		// subset (an org-only account, with no base identifiers, is covered by
		// any same-org report). The email/account fallback below applies only
		// when both sides are org-less.
		const accountOrg = account.orgId?.toLowerCase();
		const ids = [account.email, account.accountId, account.projectId]
			.filter((value): value is string => typeof value === "string" && value.length > 0)
			.map(value => value.toLowerCase());
		const sameOrgReports: UsageReport[] = [];
		let sawReportOrg = false;
		for (const report of providerReports) {
			const metaOrg = report.metadata?.orgId;
			if (typeof metaOrg === "string" && metaOrg) {
				sawReportOrg = true;
				if (accountOrg !== undefined && metaOrg.toLowerCase() === accountOrg) sameOrgReports.push(report);
			}
		}
		if (accountOrg || sawReportOrg) {
			const candidates = accountOrg
				? sameOrgReports
				: providerReports.filter(report => {
						const metaOrg = report.metadata?.orgId;
						return !(typeof metaOrg === "string" && metaOrg);
					});
			if (candidates.length === 0) return true;
			if (ids.length === 0) return false;
			return !candidates.some(report => {
				const identifiers = reportIdentifiers(report);
				return ids.some(id => identifiers.has(id));
			});
		}
		if (ids.length === 0) return false;
		const reported = new Set<string>();
		let anyIdentified = false;
		for (const report of providerReports) {
			const identifiers = reportIdentifiers(report);
			if (identifiers.size > 0) anyIdentified = true;
			for (const id of identifiers) reported.add(id);
		}
		if (!anyIdentified) return false;
		return !ids.some(id => reported.has(id));
	});
}

/** Compose the account label from parts, masking each part individually so `--redact` cannot be bypassed by the composite string. */
function accountIdentityLabel(account: UsageAccountIdentity, redaction?: Map<string, string>): string {
	if (account.type === "api_key") return "API key";
	const base = account.email ?? account.accountId ?? account.projectId ?? account.enterpriseUrl ?? "OAuth account";
	const masked = redaction?.get(base) ?? base;
	// orgId fallback: the uuid is the actual scoped identity; a token response
	// can carry it without a display name, and two same-email rows must still
	// be tellable apart.
	const org = account.orgName ?? account.orgId;
	if (!org || org === base) return masked;
	return `${masked} · ${redaction?.get(org) ?? org}`;
}

function formatAccountHeader(
	report: UsageReport,
	index: number,
	nowMs: number,
	redaction?: Map<string, string>,
): string {
	const status = aggregateStatus(report.limits);
	const icon = STATUS_COLOR[status]("●");
	const label = reportAccountLabel(report, index);
	let header = `${icon} ${chalk.bold(redaction?.get(label) ?? label)}`;
	const metaOrgName = report.metadata?.orgName;
	const metaOrgId = report.metadata?.orgId;
	const org = typeof metaOrgName === "string" && metaOrgName ? metaOrgName : metaOrgId;
	if (typeof org === "string" && org && org !== label) {
		header += chalk.dim(` · ${redaction?.get(org) ?? org}`);
	}
	const planType = report.metadata?.planType;
	if (typeof planType === "string" && planType) header += chalk.dim(` · plan: ${planType}`);
	const savedResets = report.resetCredits?.availableCount ?? 0;
	if (savedResets > 0) {
		header += chalk.cyan(` · ✦ ${savedResets} saved reset${savedResets === 1 ? "" : "s"}`);
		const credits = report.resetCredits?.credits;
		if (credits) {
			const expiries = credits
				.filter(c => c.expiresAt)
				.map(c => ({ date: c.expiresAt!, ms: Date.parse(c.expiresAt!) }))
				.filter(c => !Number.isNaN(c.ms))
				.sort((a, b) => a.ms - b.ms);
			const upcoming = expiries.find(c => c.ms > nowMs);
			if (upcoming) {
				header += chalk.dim(
					` · soonest expires in ${formatDuration(upcoming.ms - nowMs)} (${upcoming.date.slice(0, 10)})`,
				);
			} else {
				const lastExpired = expiries.at(-1);
				if (lastExpired) header += chalk.dim(` · expired (${lastExpired.date.slice(0, 10)})`);
			}
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
	id: string;
	title: string;
}

function collectProviderLimitTemplates(reports: UsageReport[]): ProviderLimitTemplate[] {
	const seen = new Set<string>();
	const templates: ProviderLimitTemplate[] = [];
	for (const report of reports) {
		for (const limit of report.limits) {
			if (seen.has(limit.id)) continue;
			seen.add(limit.id);
			templates.push({ id: limit.id, title: limitTitle(limit) });
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
	/** Accounts reporting a limit in this window. */
	accounts: number;
	/** Sum of each account's binding used fraction — accounts' worth of quota burned. */
	usedAccounts: number;
	/** Accounts' worth of quota still available across reporting accounts. */
	remainingAccounts: number;
}

/**
 * Aggregate one provider's reports into per-window quota capacity stats.
 *
 * Limits are bucketed by window duration (5h, 7d, ...). Within a bucket each
 * account contributes its single highest used fraction — when an account has
 * several meters on the same window (tiered/metered limits), the most-burned
 * one is what binds.
 */
export function computeProviderWindowStats(reports: UsageReport[]): ProviderWindowStat[] {
	const buckets = new Map<string, { window: string; durationMs?: number; fractions: number[] }>();
	for (const report of reports) {
		const accountMax = new Map<string, number>();
		for (const limit of report.limits) {
			const fraction = resolveUsedFraction(limit);
			if (fraction === undefined) continue;
			const durationMs = limit.window?.durationMs;
			const key =
				durationMs !== undefined ? `d:${durationMs}` : (limit.scope.windowId ?? limit.window?.label ?? limit.label);
			const previous = accountMax.get(key);
			if (previous === undefined || fraction > previous) accountMax.set(key, fraction);
			if (!buckets.has(key)) {
				const window =
					durationMs !== undefined
						? formatDuration(durationMs)
						: (limit.window?.label ?? limit.scope.windowId ?? limit.label);
				buckets.set(key, { window, durationMs, fractions: [] });
			}
		}
		for (const [key, fraction] of accountMax) buckets.get(key)!.fractions.push(fraction);
	}
	return [...buckets.values()]
		.sort((a, b) => (a.durationMs ?? Number.POSITIVE_INFINITY) - (b.durationMs ?? Number.POSITIVE_INFINITY))
		.map(bucket => {
			const usedAccounts = bucket.fractions.reduce((sum, fraction) => sum + fraction, 0);
			return {
				window: bucket.window,
				durationMs: bucket.durationMs,
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

/**
 * Render the full text breakdown: per provider, per account, every limit
 * with a bar, amounts, and reset times; unattributed credentials trail
 * each provider section as "no usage data" rows.
 */
export function formatUsageBreakdown(
	reports: UsageReport[],
	accounts: UsageAccountIdentity[],
	nowMs: number,
	redaction?: Map<string, string>,
	disabled: DisabledCredentialSummary[] = [],
): string {
	const reportsByProvider = new Map<string, UsageReport[]>();
	for (const report of reports) {
		const list = reportsByProvider.get(report.provider) ?? [];
		list.push(report);
		reportsByProvider.set(report.provider, list);
	}
	const unreported = collectUnreportedAccounts(reports, accounts);
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
	const latestFetchedAt = Math.max(0, ...reports.map(report => report.fetchedAt ?? 0));
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

		const providerLimitTemplates = collectProviderLimitTemplates(providerReports);
		const labelWidth = providerLimitTemplates.reduce((max, template) => Math.max(max, template.title.length), 0);

		providerReports.forEach((report, index) => {
			lines.push(`  ${formatAccountHeader(report, index, nowMs, redaction)}`);
			if (report.limits.length === 0) {
				lines.push(`      ${chalk.dim("no limits reported")}`);
				return;
			}
			const limitsById = new Map<string, UsageLimit>();
			for (const limit of report.limits) limitsById.set(limit.id, limit);
			for (const template of providerLimitTemplates) {
				const limit = limitsById.get(template.id);
				if (limit) {
					lines.push(...formatLimitLine(limit, labelWidth, nowMs));
				} else {
					lines.push(formatMissingLimitLine(template, labelWidth));
				}
			}
		});

		for (const account of providerUnreported) {
			const label = accountIdentityLabel(account, redaction);
			lines.push(`  ${chalk.dim("○")} ${chalk.dim(`${label} — no usage data`)}`);
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
			const parts = stats.map(
				stat =>
					`${stat.window} → ${stat.usedAccounts.toFixed(2)}/${stat.accounts} ${stat.accounts === 1 ? "account" : "accounts"} used (${stat.remainingAccounts.toFixed(2)}× quota left)`,
			);
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

function historyAccountLabel(entry: UsageHistoryEntry): string {
	return entry.email ?? entry.accountId ?? entry.accountKey;
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
function collectHistoryIdentityStrings(entries: UsageHistoryEntry[]): string[] {
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
			account = { label: historyAccountLabel(entry), series: new Map() };
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
		for (const account of sortedAccounts) {
			lines.push(`  ${chalk.bold(redaction?.get(account.label) ?? account.label)}`);
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

function collectStoredAccounts(authStorage: AuthStorage): UsageAccountIdentity[] {
	const accounts: UsageAccountIdentity[] = [];
	const all = authStorage.getAll();
	for (const provider in all) {
		const entry = all[provider];
		const credentials = Array.isArray(entry) ? entry : [entry];
		for (const credential of credentials) {
			if (credential.type === "oauth") {
				accounts.push({
					provider,
					type: "oauth",
					email: credential.email,
					accountId: credential.accountId,
					projectId: credential.projectId,
					enterpriseUrl: credential.enterpriseUrl,
					orgId: credential.orgId,
					orgName: credential.orgName,
					authorizedAt: credential.authorizedAt,
				});
			} else {
				accounts.push({ provider, type: "api_key" });
			}
		}
	}
	return accounts;
}

/**
 * Keep only accounts worth a usage row: those whose provider has a usage
 * provider, so a missing report is a real gap rather than the absence of any
 * usage concept. Providers with no usage endpoint (web-search keys, local /
 * keyless servers, inference providers without a usage API) would only ever
 * render as noise, so they are dropped.
 *
 * `hasUsageProvider` is injected (in practice {@link AuthStorage.usageProviderFor})
 * so custom/broker resolvers stay authoritative — no provider list is duplicated
 * here. An explicit `--provider` request bypasses the cull, so
 * `omp usage --provider xai` can still confirm the stored credential has no
 * usage endpoint.
 */
export function selectReportableAccounts(
	accounts: UsageAccountIdentity[],
	hasUsageProvider: (provider: string) => boolean,
	explicitProvider?: string,
): UsageAccountIdentity[] {
	if (explicitProvider) return accounts;
	return accounts.filter(account => hasUsageProvider(account.provider));
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

export async function runUsageCommand(cmd: UsageCommandArgs): Promise<void> {
	const authStorage = await discoverAuthStorage();
	try {
		if (cmd.action === "invalidate") {
			const provider = cmd.provider?.toLowerCase();
			await authStorage.invalidateUsageCache(provider);
			if (provider) {
				process.stdout.write(`Invalidated cached usage reports for provider "${provider}".\n`);
			} else {
				process.stdout.write("Invalidated cached usage reports for all providers.\n");
			}
			return;
		}
		if (cmd.action === "clients") {
			const days = cmd.days !== undefined && Number.isFinite(cmd.days) && cmd.days > 0 ? cmd.days : 7;
			const nowMs = Date.now();
			const sinceMs = nowMs - days * 86_400_000;
			// Prefer the broker's fleet-wide record; fall back to the local agent
			// DB, which has rows only when this machine hosts the broker.
			const brokerConfig = await resolveAuthBrokerConfig();
			let clients: ClientUsageClientSummary[];
			if (brokerConfig) {
				const client = new AuthBrokerClient({ url: brokerConfig.url, token: brokerConfig.token });
				clients = (await client.fetchClientUsageSummary({ sinceMs })).clients;
			} else {
				clients = authStorage.getClientUsageSummary(sinceMs).clients;
			}
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
			const entries = authStorage.listUsageHistory({ sinceMs, provider: cmd.provider?.toLowerCase() });
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
		const modelRegistry = new ModelRegistry(authStorage);
		const reports =
			(await authStorage.fetchUsageReports({
				baseUrlResolver: provider => modelRegistry.getProviderBaseUrl(provider),
			})) ?? [];
		// Reports are always fresh (broker-side fetch) but the account list can
		// come from a disk-cached snapshot up to an hour old — revalidate so a
		// just-logged-in (or just-rotated-identity) credential isn't rendered
		// as a stale duplicate. Best-effort: offline broker keeps the cache.
		try {
			await authStorage.revalidateCredentials();
		} catch {
			// Stale identities beat no output.
		}
		const storedAccounts = collectStoredAccounts(authStorage);
		let accounts = selectReportableAccounts(
			storedAccounts,
			provider => authStorage.usageProviderFor(provider) !== undefined,
			cmd.provider,
		);
		// Tombstones ride alongside the live pool so an auto-disabled account
		// (e.g. an expired Anthropic grant) is loudly visible instead of just
		// missing. Best-effort: a broker predating the endpoint yields [].
		let disabled: DisabledCredentialSummary[] = [];
		try {
			disabled = await authStorage.listDisabledCredentials();
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
			const scope = cmd.provider ? ` for provider "${cmd.provider}"` : "";
			// Credentials exist but every one is for a provider without a usage
			// endpoint — say so rather than implying nothing is logged in.
			const message =
				storedAccounts.length > 0
					? `No usage data${scope}. Stored credentials are for providers without a usage endpoint.\n`
					: `No credentials found${scope}. Run \`omp\` and use /login to add accounts.\n`;
			process.stderr.write(chalk.yellow(message));
			process.exitCode = 1;
			return;
		}

		process.stdout.write(`${formatUsageBreakdown(filteredReports, accounts, Date.now(), redaction, disabled)}\n`);
	} finally {
		authStorage.close();
	}
}
