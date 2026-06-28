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
	type AuthStorage,
	resolveUsedFraction,
	type UsageHistoryEntry,
	type UsageLimit,
	type UsageReport,
	type UsageUnit,
} from "@pk-nerdsaver-ai/pi-ai";
import { formatDuration, formatNumber, sanitizeText } from "@pk-nerdsaver-ai/pi-utils";
import chalk from "chalk";
import { ModelRegistry } from "../config/model-registry";
import { discoverAuthStorage } from "../sdk";

const BAR_WIDTH = 28;

export interface UsageCommandArgs {
	json?: boolean;
	provider?: string;
	redact?: boolean;
	/** Show recorded usage-limit history instead of a live snapshot. */
	history?: boolean;
	/** History window in days (with `history`). */
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
function collectIdentityStrings(reports: UsageReport[], accounts: UsageAccountIdentity[]): string[] {
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
		add(account.enterpriseUrl);
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
	if (absoluteUnit && amount.used !== undefined && amount.limit !== undefined) {
		parts.push(
			`${formatUnitValue(amount.used, amount.unit)} / ${formatUnitValue(amount.limit, amount.unit)}${UNIT_SUFFIX[amount.unit]}`,
		);
	} else if (absoluteUnit && amount.remaining !== undefined) {
		parts.push(`${formatUnitValue(amount.remaining, amount.unit)}${UNIT_SUFFIX[amount.unit]} left`);
	}
	const fraction = resolveUsedFraction(limit);
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
		const ids = [account.email, account.accountId, account.projectId]
			.filter((value): value is string => typeof value === "string" && value.length > 0)
			.map(value => value.toLowerCase());
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

function accountIdentityLabel(account: UsageAccountIdentity): string {
	if (account.type === "api_key") return "API key";
	return account.email ?? account.accountId ?? account.projectId ?? account.enterpriseUrl ?? "OAuth account";
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
		details.push(`resets in ${formatDuration(resetsAt - nowMs)}`);
	}
	const lines = [
		`      ${STATUS_COLOR[status]("●")} ${padded}  ${renderBar(limit)}  ${chalk.dim(details.join(" · "))}`,
	];
	if (limit.notes && limit.notes.length > 0) {
		lines.push(`        ${chalk.dim(limit.notes.join(" · "))}`);
	}
	return lines;
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

	const providers = [...new Set([...reportsByProvider.keys(), ...unreportedByProvider.keys()])].sort((a, b) =>
		a.localeCompare(b),
	);

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

		const labelWidth = providerReports
			.flatMap(report => report.limits)
			.reduce((max, limit) => Math.max(max, limitTitle(limit).length), 0);

		providerReports.forEach((report, index) => {
			lines.push(`  ${formatAccountHeader(report, index, nowMs, redaction)}`);
			if (report.limits.length === 0) {
				lines.push(`      ${chalk.dim("no limits reported")}`);
				return;
			}
			for (const limit of report.limits) {
				lines.push(...formatLimitLine(limit, labelWidth, nowMs));
			}
		});

		for (const account of providerUnreported) {
			const label = accountIdentityLabel(account);
			lines.push(`  ${chalk.dim("○")} ${chalk.dim(`${redaction?.get(label) ?? label} — no usage data`)}`);
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

const IDENTITY_METADATA_KEYS = ["email", "accountId", "projectId", "orgId"] as const;

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

export async function runUsageCommand(cmd: UsageCommandArgs): Promise<void> {
	const authStorage = await discoverAuthStorage();
	try {
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
		const storedAccounts = collectStoredAccounts(authStorage);
		let accounts = selectReportableAccounts(
			storedAccounts,
			provider => authStorage.usageProviderFor(provider) !== undefined,
			cmd.provider,
		);
		let filteredReports = reports;
		if (cmd.provider) {
			const wanted = cmd.provider.toLowerCase();
			filteredReports = reports.filter(report => report.provider.toLowerCase() === wanted);
			accounts = accounts.filter(account => account.provider.toLowerCase() === wanted);
		}

		const redaction = cmd.redact ? buildRedactionMap(collectIdentityStrings(filteredReports, accounts)) : undefined;

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
				}));
			}
			const capacity: Record<string, ProviderWindowStat[]> = {};
			for (const report of filteredReports) {
				if (capacity[report.provider]) continue;
				const stats = computeProviderWindowStats(filteredReports.filter(peer => peer.provider === report.provider));
				if (stats.length > 0) capacity[report.provider] = stats;
			}
			const payload = {
				generatedAt: Date.now(),
				reports: trimmed,
				accountsWithoutUsage: unreportedAccounts,
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

		process.stdout.write(`${formatUsageBreakdown(filteredReports, accounts, Date.now(), redaction)}\n`);
	} finally {
		authStorage.close();
	}
}
