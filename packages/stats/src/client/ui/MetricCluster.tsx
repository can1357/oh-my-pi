import {
	formatCompact,
	formatDurationMs,
	formatEstimatedCost,
	formatInteger,
	formatPercent,
	formatTokensPerSecond,
} from "../data/formatters";
import { sumConversationTokens } from "../data/view-models";
import { useStatsI18n } from "../i18n";
import type { AggregatedStats } from "../types";

export interface MetricClusterProps {
	stats: AggregatedStats;
}

export function MetricCluster({ stats }: MetricClusterProps) {
	const { i18n } = useStatsI18n();
	const conversationTokens = sumConversationTokens(stats);

	return (
		<div className="stats-metric-cluster">
			<div className="stats-metric-primary-grid">
				<div className="stats-metric-card primary">
					<div className="stats-metric-label">{i18n.t("stats.metrics.apiEstimate")}</div>
					<div className="stats-metric-value">
						{formatEstimatedCost(
							stats.totalCost,
							stats.unpricedRequests,
							stats.totalCost > 0 && stats.totalCost < 0.01 ? 4 : 2,
						)}
					</div>
				</div>
				<div className="stats-metric-card primary">
					<div className="stats-metric-label">{i18n.t("stats.metrics.requests")}</div>
					<div className="stats-metric-value">{formatInteger(stats.totalRequests)}</div>
				</div>
				<div className="stats-metric-card primary" title={i18n.t("stats.metrics.cacheSavingsTitle")}>
					<div className="stats-metric-label">{i18n.t("stats.metrics.cacheSavings")}</div>
					<div className="stats-metric-value">{formatPercent(stats.cacheSavings)}</div>
				</div>
				<div className="stats-metric-card primary" title={i18n.t("stats.metrics.cacheRateTitle")}>
					<div className="stats-metric-label">{i18n.t("stats.metrics.cacheRate")}</div>
					<div className="stats-metric-value">{formatPercent(stats.cacheRate)}</div>
				</div>
				<div className="stats-metric-card primary">
					<div className="stats-metric-label">{i18n.t("stats.metrics.errorRate")}</div>
					<div className="stats-metric-value">{formatPercent(stats.errorRate)}</div>
				</div>
			</div>

			<div className="stats-metric-secondary-grid">
				<div className="stats-metric-card secondary" title={i18n.t("stats.metrics.uncachedInputTitle")}>
					<div className="stats-metric-label">{i18n.t("stats.metrics.uncachedInput")}</div>
					<div className="stats-metric-value">{formatCompact(stats.totalInputTokens)}</div>
				</div>
				<div className="stats-metric-card secondary" title={i18n.t("stats.metrics.cacheReadTitle")}>
					<div className="stats-metric-label">{i18n.t("stats.metrics.cacheRead")}</div>
					<div className="stats-metric-value">{formatCompact(stats.totalCacheReadTokens)}</div>
				</div>
				<div className="stats-metric-card secondary">
					<div className="stats-metric-label">{i18n.t("stats.metrics.outputTokens")}</div>
					<div className="stats-metric-value">{formatCompact(stats.totalOutputTokens)}</div>
				</div>
				<div className="stats-metric-card secondary" title={i18n.t("stats.metrics.conversationTotalTitle")}>
					<div className="stats-metric-label">{i18n.t("stats.metrics.conversationTotal")}</div>
					<div className="stats-metric-value">{formatCompact(conversationTokens)}</div>
				</div>
				<div className="stats-metric-card secondary">
					<div className="stats-metric-label">{i18n.t("stats.metrics.premiumRequests")}</div>
					<div className="stats-metric-value">{formatInteger(stats.totalPremiumRequests)}</div>
				</div>
				<div className="stats-metric-card secondary">
					<div className="stats-metric-label">{i18n.t("stats.metrics.tokensPerSecond")}</div>
					<div className="stats-metric-value">{formatTokensPerSecond(stats.avgTokensPerSecond)}</div>
				</div>
				<div className="stats-metric-card secondary">
					<div className="stats-metric-label">{i18n.t("stats.metrics.avgLatency")}</div>
					<div className="stats-metric-value">{formatDurationMs(stats.avgDuration)}</div>
				</div>
				<div className="stats-metric-card secondary">
					<div className="stats-metric-label">{i18n.t("stats.metrics.avgTtft")}</div>
					<div className="stats-metric-value">{formatDurationMs(stats.avgTtft)}</div>
				</div>
			</div>
		</div>
	);
}
