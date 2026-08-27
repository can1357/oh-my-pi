import { useEffect, useMemo, useState } from "react";
import { getToolDashboardStats } from "../api";
import {
	formatCompact,
	formatEstimatedCost,
	formatInteger,
	formatPercent,
	formatRelativeTime,
} from "../data/formatters";
import { useResource } from "../data/useResource";
import { buildToolRows } from "../data/view-models";
import type { TimeRange, ToolUsageStats } from "../types";
import { AsyncBoundary, StatusPill } from "../ui";

export interface ToolsRouteProps {
	active: boolean;
	range: TimeRange;
	refreshTrigger: number;
}

type SortKey = "calls" | "errorRate" | "resultChars" | "tokens" | "cost" | "tool";
type SortDir = "asc" | "desc";
const SORT_KEY = "omp-stats:tools-sort";
function load(): { key: SortKey; dir: SortDir } {
	try {
		const raw = sessionStorage.getItem(SORT_KEY);
		if (raw) return JSON.parse(raw) as never;
	} catch {}
	return { key: "calls", dir: "desc" };
}
function save(v: { key: SortKey; dir: SortDir }) {
	try {
		sessionStorage.setItem(SORT_KEY, JSON.stringify(v));
	} catch {}
}

export function ToolsRoute({ active, range, refreshTrigger }: ToolsRouteProps) {
	const {
		data: stats,
		error,
		loading,
	} = useResource(["tools", range, refreshTrigger], signal => getToolDashboardStats(range, signal), {
		pollMs: 30000,
		enabled: active,
	});

	return (
		<div className="stats-route-container">
			<div className="omp-hero">
				<div className="omp-hero-head">
					<h2 className="omp-hero-title">
						Tools <span>{range} · behavior</span>
					</h2>
					<span className="omp-hero-range">
						{stats
							? `${stats.byTool.length} tools · ${formatInteger(stats.byTool.reduce((s, t) => s + t.calls, 0))} calls`
							: "loading"}
					</span>
				</div>
				<p
					style={{
						fontFamily: "var(--font-sans)",
						fontSize: 12,
						color: "var(--muted)",
						margin: 0,
						maxWidth: 720,
						lineHeight: 1.5,
					}}
				>
					Tool behavior — calls, error rate, result size (chars fed back), tokens induced and cost share from
					invoking turns. No invented latency or context-residency; honest attribution only.
				</p>
			</div>

			<AsyncBoundary loading={loading} error={error} data={stats}>
				{stats && <ToolsRanked byTool={stats.byTool} />}
			</AsyncBoundary>
		</div>
	);
}

function ToolsRanked({ byTool }: { byTool: ToolUsageStats[] }) {
	const baseRows = useMemo(() => buildToolRows(byTool), [byTool]);
	const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>(() => load());
	useEffect(() => save(sort), [sort]);

	const rows = useMemo(() => {
		const mul = sort.dir === "asc" ? 1 : -1;
		return [...baseRows].sort((a, b) => {
			let cmp = 0;
			switch (sort.key) {
				case "calls":
					cmp = a.calls - b.calls;
					break;
				case "errorRate":
					cmp = a.errorRate - b.errorRate;
					break;
				case "resultChars":
					cmp = a.resultChars - b.resultChars;
					break;
				case "tokens":
					cmp = a.totalTokensShare - b.totalTokensShare;
					break;
				case "cost":
					cmp = a.costShare - b.costShare;
					break;
				case "tool":
					cmp = a.tool.localeCompare(b.tool);
					break;
			}
			if (cmp !== 0) return cmp * mul;
			return b.calls - a.calls;
		});
	}, [baseRows, sort]);

	const toggle = (key: SortKey) =>
		setSort(prev =>
			prev.key === key
				? { key, dir: prev.dir === "asc" ? "desc" : "asc" }
				: { key, dir: key === "tool" ? "asc" : "desc" },
		);
	const btn = (label: string, key: SortKey) => {
		const active = sort.key === key;
		return (
			<button type="button" data-active={active ? "true" : "false"} onClick={() => toggle(key)}>
				{label}
				<span style={{ fontSize: 10, opacity: active ? 1 : 0.35 }}>
					{active ? (sort.dir === "asc" ? "↑" : "↓") : "↕"}
				</span>
			</button>
		);
	};

	return (
		<div className="omp-section">
			<div className="omp-section-head">
				<div>
					<div className="omp-section-title">Tool calls ranked</div>
					<p className="omp-section-desc">
						Share bar = calls vs busiest tool. Tokens/cost are invoking-turn attribution (split evenly per turn).
					</p>
				</div>
				<span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--dim)" }}>
					{rows.length} tools
				</span>
			</div>
			<div className="omp-section-rule" />
			<div className="omp-section-body">
				<div
					className="omp-ranked-head"
					style={{
						display: "grid",
						gridTemplateColumns: "22px minmax(0, 1.4fr) 84px 90px 90px 90px 90px 70px",
						gap: 10,
					}}
				>
					<span>#</span>
					<span>{btn("Tool", "tool")}</span>
					<span style={{ textAlign: "center" }}>Share</span>
					<span style={{ textAlign: "right" }}>{btn("Calls", "calls")}</span>
					<span style={{ textAlign: "right" }}>{btn("Error", "errorRate")}</span>
					<span style={{ textAlign: "right" }}>{btn("Result chars", "resultChars")}</span>
					<span style={{ textAlign: "right" }}>{btn("Tokens", "tokens")}</span>
					<span style={{ textAlign: "right" }}>{btn("Cost", "cost")}</span>
				</div>

				<div className="omp-ranked-list">
					{rows.map((t, idx) => (
						<div
							key={t.tool}
							className="omp-ranked-row"
							style={{ gridTemplateColumns: "22px minmax(0, 1.4fr) 84px 90px 90px 90px 90px 70px" }}
						>
							<span className="omp-ranked-row-rank">{idx + 1}</span>
							<span className="omp-ranked-row-main">
								<span
									className="omp-ranked-row-title"
									title={t.tool}
									style={{ fontFamily: "var(--font-mono)" }}
								>
									{t.tool}
								</span>
								<span className="omp-ranked-row-sub">last {formatRelativeTime(t.lastUsed)}</span>
							</span>
							<span className="omp-ranked-bar">
								<span className="omp-ranked-bar-fill" style={{ width: `${t.callsPercentage}%` }} />
							</span>
							<span className="omp-ranked-metric">
								<strong>{formatInteger(t.calls)}</strong>
							</span>
							<span className="omp-ranked-metric">
								<StatusPill variant={t.errorRate > 0.1 ? "danger" : t.errorRate > 0 ? "warning" : "success"}>
									{formatPercent(t.errorRate, 1)}
								</StatusPill>
							</span>
							<span className="omp-ranked-metric">{formatCompact(t.resultChars)}</span>
							<span className="omp-ranked-metric">{formatCompact(Math.round(t.totalTokensShare))}</span>
							<span className="omp-ranked-metric">
								{formatEstimatedCost(t.costShare, t.unpricedRequestsShare, 2)}
							</span>
						</div>
					))}
				</div>
			</div>
		</div>
	);
}
