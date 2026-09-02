/**
 * Provider subscription-window analytics for the stats dashboard.
 *
 * The auth layer appends one row to `usage_history` in agent.db every time a
 * provider usage report is fetched (see AuthStorage's usage recording). This
 * module reads those snapshots read-only and derives:
 *   - utilization series (used fraction over time per account and limit window),
 *   - per-window subscription insights: window-equivalents consumed, an
 *     estimate of how many tokens one full window buys, peak concurrent
 *     utilization across accounts, and the account count that peak implies.
 *
 * A missing agent DB or `usage_history` table yields empty results — the
 * dashboard must keep working for API-key-only setups that never record usage.
 */
import { Database } from "bun:sqlite";
import { AuthBrokerClient, resolveAuthBrokerConfig } from "@oh-my-pi/pi-ai/auth-broker";
import type { ClientUsageClientSummary } from "@oh-my-pi/pi-ai/usage";
import { getAgentDbPath, logger } from "@oh-my-pi/pi-utils";
import type { ProviderWindowInsight, UsageWindowPoint, UsageWindowSeries } from "./shared-types";

/** Subset of a `usage_history` row consumed by the window analytics. */
export interface UsageSnapshotRow {
	/** Epoch ms the report was fetched. */
	recordedAt: number;
	provider: string;
	/** Stable credential identity key. */
	accountKey: string;
	email: string | null;
	accountId: string | null;
	limitId: string;
	label: string;
	windowLabel: string | null;
	/** Used fraction (0..1, >1 = overage) when the provider reported one. */
	usedFraction: number | null;
	status: string | null;
}

/** Utilization series + derived insights for every provider window in range. */
export interface UsageWindowStats {
	usageSeries: UsageWindowSeries[];
	windowInsights: ProviderWindowInsight[];
}

/** Usage snapshots plus, in broker mode, fleet-wide token burn per provider. */
export interface UsageDataSnapshot {
	rows: UsageSnapshotRow[];
	/**
	 * Total tokens (input + output + cache read/write) per provider summed
	 * across every install reporting to the auth broker, or `null` when no
	 * broker is configured or no client reports exist for the range. Matches
	 * the fleet-wide window fractions in `rows`, unlike local message stats
	 * which only see this install's burn.
	 */
	fleetTokensByProvider: Map<string, number> | null;
}

/** A used-fraction drop smaller than this is jitter, not a window reset. */
const RESET_DROP_THRESHOLD = 0.05;
/** Minimum window-equivalents consumed before extrapolating tokens/window. */
const MIN_EXTRAPOLATION_FRACTION = 0.1;
/** Fleet-capacity headroom target: peak demand should stay under 90%. */
const TARGET_PEAK_UTILIZATION = 0.9;
/** Used fraction at or above this counts as exhausted even without a status. */
const EXHAUSTED_FRACTION = 0.999;
/** Utilization series are downsampled (peak per bucket) to at most this many points. */
const MAX_SERIES_POINTS = 400;

/**
 * Read usage-limit snapshots recorded at or after `sinceMs`, oldest first.
 * Opens the agent DB read-only; returns `[]` when the DB or table is absent.
 */
export function readUsageSnapshots(sinceMs: number, dbPath = getAgentDbPath()): UsageSnapshotRow[] {
	let db: Database | null = null;
	try {
		db = new Database(dbPath, { readonly: true });
		db.run("PRAGMA busy_timeout = 5000");
		const rows = db
			.prepare(
				`SELECT recorded_at, provider, account_key, email, account_id, limit_id, label, window_label, used_fraction, status
				 FROM usage_history
				 WHERE recorded_at >= ?
				 ORDER BY recorded_at ASC`,
			)
			.all(sinceMs) as Array<{
			recorded_at: number;
			provider: string;
			account_key: string;
			email: string | null;
			account_id: string | null;
			limit_id: string;
			label: string;
			window_label: string | null;
			used_fraction: number | null;
			status: string | null;
		}>;
		return rows.map(row => ({
			recordedAt: row.recorded_at,
			provider: row.provider,
			accountKey: row.account_key,
			email: row.email,
			accountId: row.account_id,
			limitId: row.limit_id,
			label: row.label,
			windowLabel: row.window_label,
			usedFraction: row.used_fraction,
			status: row.status,
		}));
	} catch (err) {
		// Expected for fresh installs (no agent.db) or pre-usage-history schemas.
		logger.debug("usage_history unavailable for provider stats", { dbPath, error: String(err) });
		return [];
	} finally {
		db?.close();
	}
}

/**
 * Fetch usage data from wherever it actually accumulates: the auth broker's
 * durable history plus per-client observed-usage reports when a broker is
 * configured (the broker performs every upstream usage fetch in that mode, so
 * the local `usage_history` stays frozen), else the local agent DB. Broker
 * errors fall back to the local read so the dashboard degrades to
 * stale-but-present data instead of failing.
 */
export async function fetchUsageData(sinceMs: number): Promise<UsageDataSnapshot> {
	try {
		const brokerConfig = await resolveAuthBrokerConfig();
		if (brokerConfig) {
			const client = new AuthBrokerClient({ url: brokerConfig.url, token: brokerConfig.token });
			const [response, fleetTokensByProvider] = await Promise.all([
				client.fetchUsageHistory({ sinceMs }),
				fetchFleetTokens(client, sinceMs),
			]);
			return {
				rows: response.entries.map(entry => ({
					recordedAt: entry.recordedAt,
					provider: entry.provider,
					accountKey: entry.accountKey,
					email: entry.email ?? null,
					accountId: entry.accountId ?? null,
					limitId: entry.limitId,
					label: entry.label,
					windowLabel: entry.windowLabel ?? null,
					usedFraction: entry.usedFraction ?? null,
					status: entry.status ?? null,
				})),
				fleetTokensByProvider,
			};
		}
	} catch (err) {
		logger.debug("broker usage history unavailable, falling back to local", { error: String(err) });
	}
	return { rows: readUsageSnapshots(sinceMs), fleetTokensByProvider: null };
}

/**
 * Sum broker-recorded client token burn per provider since `sinceMs`.
 * Returns `null` on fetch failure or when no client has reported usage, so
 * callers fall back to local message stats instead of zeroing estimates.
 */
async function fetchFleetTokens(client: AuthBrokerClient, sinceMs: number): Promise<Map<string, number> | null> {
	try {
		const summary = await client.fetchClientUsageSummary({ sinceMs });
		return sumFleetTokens(summary.clients);
	} catch (err) {
		logger.debug("broker client usage summary unavailable", { error: String(err) });
		return null;
	}
}

/**
 * Fold per-client provider aggregates into total tokens per provider
 * (input + output + cache read/write, matching message-stat `totalTokens`).
 * Returns `null` when no client reported anything, signalling "no data"
 * rather than "zero burn".
 */
export function sumFleetTokens(clients: ClientUsageClientSummary[]): Map<string, number> | null {
	const tokens = new Map<string, number>();
	for (const client of clients) {
		for (const p of client.providers) {
			const total = p.inputTokens + p.outputTokens + p.cacheReadTokens + p.cacheWriteTokens;
			tokens.set(p.provider, (tokens.get(p.provider) ?? 0) + total);
		}
	}
	return tokens.size > 0 ? tokens : null;
}

/** True when a snapshot reports an exhausted window, by status or by fraction. */
function isExhausted(fraction: number | null, status: string | null): boolean {
	if (status === "exhausted") return true;
	return fraction !== null && fraction >= EXHAUSTED_FRACTION;
}

/**
 * Reduce a point list to at most {@link MAX_SERIES_POINTS} by keeping the
 * peak-fraction point per time bucket, so utilization peaks survive downsampling.
 */
function downsamplePoints(points: UsageWindowPoint[]): UsageWindowPoint[] {
	if (points.length <= MAX_SERIES_POINTS) return points;
	const first = points[0].timestamp;
	const span = points[points.length - 1].timestamp - first;
	const bucketMs = Math.max(1, Math.ceil(span / MAX_SERIES_POINTS));
	const out: UsageWindowPoint[] = [];
	let bucket = -1;
	for (const point of points) {
		const b = Math.floor((point.timestamp - first) / bucketMs);
		if (b !== bucket) {
			out.push(point);
			bucket = b;
			continue;
		}
		const last = out[out.length - 1];
		if ((point.usedFraction ?? -1) >= (last.usedFraction ?? -1)) out[out.length - 1] = point;
	}
	return out;
}

interface AccountSeries {
	accountKey: string;
	accountLabel: string;
	rows: UsageSnapshotRow[];
}

interface WindowGroup {
	provider: string;
	windowKey: string;
	windowLabel: string;
	accounts: Map<string, AccountSeries>;
}

/**
 * Display label for one limit window: the limit label, plus the window label
 * when it adds information ("Usage (Google) · Daily"). The limit label alone
 * distinguishes same-duration windows ("Claude 7 Day" vs "Claude 7 Day
 * (Fable)"); the window-label suffix distinguishes same-named limits with
 * different durations (Antigravity's daily vs weekly "Usage (Google)").
 */
function windowDisplayLabel(row: UsageSnapshotRow): string {
	const { label, windowLabel } = row;
	if (!windowLabel || label.toLowerCase().includes(windowLabel.toLowerCase())) return label;
	return `${label} · ${windowLabel}`;
}

/**
 * Derive utilization series and per-window insights from raw snapshots.
 *
 * Windows are grouped by `(provider, limitId)` — never by display label.
 * Distinct limits can share a duration label (Anthropic's overall and
 * model-scoped 7-day windows, Codex's base and Spark weeklies); merging them
 * interleaves unrelated fractions per account and wildly inflates consumption.
 *
 * `tokensByProvider` supplies each provider's token burn over the same time
 * range (fleet-wide broker client reports when available, else local message
 * stats); it converts consumed window fraction into an estimated token
 * capacity per window. Attribution note: tokens are per provider, not per
 * account, so the estimate treats the account fleet as one pooled
 * subscription — which is exactly how round-robin auth uses it.
 */
export function computeUsageWindowStats(
	rows: UsageSnapshotRow[],
	tokensByProvider: ReadonlyMap<string, number>,
): UsageWindowStats {
	const groups = new Map<string, WindowGroup>();
	for (const row of rows) {
		const groupKey = `${row.provider}\u0000${row.limitId}`;
		let group = groups.get(groupKey);
		if (!group) {
			group = {
				provider: row.provider,
				windowKey: row.limitId,
				windowLabel: windowDisplayLabel(row),
				accounts: new Map(),
			};
			groups.set(groupKey, group);
		}
		// Labels can change across snapshots (provider renames); latest wins.
		group.windowLabel = windowDisplayLabel(row);
		let account = group.accounts.get(row.accountKey);
		if (!account) {
			account = { accountKey: row.accountKey, accountLabel: row.email ?? row.accountId ?? row.accountKey, rows: [] };
			group.accounts.set(row.accountKey, account);
		}
		if (row.email || row.accountId) account.accountLabel = row.email ?? row.accountId ?? row.accountKey;
		account.rows.push(row);
	}

	const usageSeries: UsageWindowSeries[] = [];
	const windowInsights: ProviderWindowInsight[] = [];

	for (const group of groups.values()) {
		let fractionConsumed = 0;
		let cycles = 0;
		let exhaustedEvents = 0;

		for (const account of group.accounts.values()) {
			const points: UsageWindowPoint[] = account.rows.map(row => ({
				timestamp: row.recordedAt,
				usedFraction: row.usedFraction,
				exhausted: isExhausted(row.usedFraction, row.status),
			}));
			usageSeries.push({
				provider: group.provider,
				accountKey: account.accountKey,
				accountLabel: account.accountLabel,
				windowKey: group.windowKey,
				windowLabel: group.windowLabel,
				points: downsamplePoints(points),
			});

			let prevFraction: number | null = null;
			let prevExhausted = false;
			for (const row of account.rows) {
				const exhausted = isExhausted(row.usedFraction, row.status);
				if (exhausted && !prevExhausted) exhaustedEvents++;
				prevExhausted = exhausted;
				if (row.usedFraction === null) continue;
				if (prevFraction !== null) {
					const delta = row.usedFraction - prevFraction;
					if (delta > 0) fractionConsumed += delta;
					else if (delta < -RESET_DROP_THRESHOLD) cycles++;
				}
				prevFraction = row.usedFraction;
			}
		}

		const providerTokens = tokensByProvider.get(group.provider) ?? 0;
		const peak = peakConcurrentFraction(group);
		windowInsights.push({
			provider: group.provider,
			windowKey: group.windowKey,
			windowLabel: group.windowLabel,
			accounts: group.accounts.size,
			cycles,
			fractionConsumed,
			estTokensPerWindow:
				providerTokens > 0 && fractionConsumed >= MIN_EXTRAPOLATION_FRACTION
					? Math.round(providerTokens / fractionConsumed)
					: null,
			peakConcurrentFraction: peak,
			idealAccounts: Math.max(1, Math.ceil(peak / TARGET_PEAK_UTILIZATION)),
			exhaustedEvents,
		});
	}

	usageSeries.sort(
		(a, b) =>
			a.provider.localeCompare(b.provider) ||
			a.windowKey.localeCompare(b.windowKey) ||
			a.accountLabel.localeCompare(b.accountLabel),
	);
	windowInsights.sort((a, b) => a.provider.localeCompare(b.provider) || b.fractionConsumed - a.fractionConsumed);
	return { usageSeries, windowInsights };
}

/**
 * Peak of sum-across-accounts used fraction at any sampled instant: sweep all
 * snapshot times, forward-filling each account's last known fraction. A peak
 * of 1.7 means demand simultaneously held 1.7 windows' worth of quota.
 */
function peakConcurrentFraction(group: WindowGroup): number {
	type Event = { timestamp: number; account: string; fraction: number };
	const events: Event[] = [];
	for (const account of group.accounts.values()) {
		for (const row of account.rows) {
			if (row.usedFraction === null) continue;
			events.push({ timestamp: row.recordedAt, account: account.accountKey, fraction: row.usedFraction });
		}
	}
	events.sort((a, b) => a.timestamp - b.timestamp);

	const current = new Map<string, number>();
	let sum = 0;
	let peak = 0;
	for (const event of events) {
		sum += event.fraction - (current.get(event.account) ?? 0);
		current.set(event.account, event.fraction);
		if (sum > peak) peak = sum;
	}
	return peak;
}
