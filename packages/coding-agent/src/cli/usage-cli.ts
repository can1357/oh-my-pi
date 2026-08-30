/**
 * Usage CLI command handler.
 *
 * Handles `omp usage` — fetches provider usage reports for every
 * authenticated account and prints a detailed per-account breakdown
 * (limits, windows, reset times, plan metadata). Accounts whose
 * credentials produced no usage report are listed too, so the output
 * always covers the full credential pool.
 */
import type { DisabledCredentialSummary, UsageHistoryEntry, UsageReport } from "@oh-my-pi/pi-ai";
import { AuthBrokerClient } from "@oh-my-pi/pi-ai/auth-broker";
import type { ClientUsageClientSummary } from "@oh-my-pi/pi-ai/usage";
import { formatDuration, formatNumber } from "@oh-my-pi/pi-utils";
import chalk from "@oh-my-pi/pi-utils/chalk";
import { ModelRegistry } from "../config/model-registry";
import { discoverAuthStorage } from "../sdk";
import { resolveAuthBrokerConfig } from "../session/auth-broker-config";
import {
	applyUsageRedaction,
	collectStoredAccounts,
	collectUnreportedAccounts,
	computeProviderWindowStats,
	formatProviderName,
	formatUsageBreakdown,
	hasRenderableUsageBreakdown,
	isActionableDisabledCredential,
	type LimitStatus,
	type ProviderWindowStat,
	STATUS_COLOR,
	selectReportableAccounts,
	type UsageAccountIdentity,
} from "../usage/usage-breakdown";

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

/** Append a history window label when the series label does not already contain it. */
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
			let disabledForJson = disabled.filter(summary => isActionableDisabledCredential(summary, accounts));
			if (redaction) {
				disabledForJson = disabledForJson.map(summary => ({
					...summary,
					cause: applyUsageRedaction(summary.cause, redaction),
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

		if (!hasRenderableUsageBreakdown(filteredReports, accounts, disabled)) {
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
