import { useEffect, useMemo, useState } from "react";
import { getFolderStats } from "../api";
import { formatDurationMs, formatEstimatedCost, formatInteger, formatPercent } from "../data/formatters";
import { useResource } from "../data/useResource";
import { buildFolderRows } from "../data/view-models";
import type { FolderStats, TimeRange } from "../types";
import { AsyncBoundary } from "../ui";

export interface ProjectsRouteProps {
	active: boolean;
	range: TimeRange;
	refreshTrigger: number;
}

type SortKey = "requests" | "cost" | "folder";
type SortDir = "asc" | "desc";
const SORT_KEY = "omp-stats:projects-sort";
function load(): { key: SortKey; dir: SortDir } {
	try {
		const raw = sessionStorage.getItem(SORT_KEY);
		if (raw) return JSON.parse(raw) as never;
	} catch {}
	return { key: "requests", dir: "desc" };
}
function save(v: { key: SortKey; dir: SortDir }) {
	try {
		sessionStorage.setItem(SORT_KEY, JSON.stringify(v));
	} catch {}
}

export function ProjectsRoute({ active, range, refreshTrigger }: ProjectsRouteProps) {
	const {
		data: foldersData,
		error,
		loading,
	} = useResource(["projects", range, refreshTrigger], signal => getFolderStats(range, signal), {
		pollMs: 30000,
		enabled: active,
	});

	return (
		<div className="stats-route-container">
			<div className="omp-hero">
				<div className="omp-hero-head">
					<h2 className="omp-hero-title">
						Projects <span>{range} · folder rows</span>
					</h2>
					<span className="omp-hero-range">{foldersData ? `${foldersData.length} projects` : "loading"}</span>
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
					Folder rows like Overview’s Projects section — ranked by requests with cost context. Same open layout, no
					card grid, just rows with share bars.
				</p>
			</div>

			<AsyncBoundary loading={loading} error={error} data={foldersData}>
				{foldersData && <ProjectsRanked folders={foldersData} />}
			</AsyncBoundary>
		</div>
	);
}

function ProjectsRanked({ folders }: { folders: FolderStats[] }) {
	const base = useMemo(() => buildFolderRows(folders), [folders]);
	const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>(() => load());
	useEffect(() => save(sort), [sort]);

	const rows = useMemo(() => {
		const mul = sort.dir === "asc" ? 1 : -1;
		return [...base].sort((a, b) => {
			let cmp = 0;
			switch (sort.key) {
				case "requests":
					cmp = a.totalRequests - b.totalRequests;
					break;
				case "cost":
					cmp = a.totalCost - b.totalCost;
					break;
				case "folder":
					cmp = a.folder.localeCompare(b.folder);
					break;
			}
			if (cmp !== 0) return cmp * mul;
			return b.totalRequests - a.totalRequests;
		});
	}, [base, sort]);

	const toggle = (key: SortKey) =>
		setSort(prev =>
			prev.key === key
				? { key, dir: prev.dir === "asc" ? "desc" : "asc" }
				: { key, dir: key === "folder" ? "asc" : "desc" },
		);
	const btn = (label: string, key: SortKey) => {
		const active = sort.key === key;
		return (
			<button type="button" data-active={active ? "true" : "false"} onClick={() => toggle(key)}>
				{label}{" "}
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
					<div className="omp-section-title">Folders ranked</div>
					<p className="omp-section-desc">Click header to sort. Share bar shows requests vs busiest folder.</p>
				</div>
				<span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--dim)" }}>
					{rows.length} folders
				</span>
			</div>
			<div className="omp-section-rule" />
			<div className="omp-section-body">
				<div
					className="omp-ranked-head"
					style={{
						display: "grid",
						gridTemplateColumns: "22px minmax(0, 1.6fr) 84px 96px 96px 84px 76px",
						gap: 10,
					}}
				>
					<span>#</span>
					<span>{btn("Project", "folder")}</span>
					<span style={{ textAlign: "center" }}>Share</span>
					<span style={{ textAlign: "right" }}>{btn("Requests", "requests")}</span>
					<span style={{ textAlign: "right" }}>{btn("Est. cost", "cost")}</span>
					<span style={{ textAlign: "right" }}>Avg dur</span>
					<span style={{ textAlign: "right" }}>Cache</span>
				</div>
				<div className="omp-ranked-list">
					{rows.map((f, i) => (
						<div
							key={f.folder}
							className="omp-ranked-row"
							style={{ gridTemplateColumns: "22px minmax(0, 1.6fr) 84px 96px 96px 84px 76px" }}
						>
							<span className="omp-ranked-row-rank">{i + 1}</span>
							<span className="omp-ranked-row-main">
								<span
									className="omp-ranked-row-title"
									title={f.folder}
									style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}
								>
									{f.folder}
								</span>
								<span className="omp-ranked-row-sub">
									{formatPercent(f.errorRate, 1)} err ·{" "}
									{f.totalRequests ? `${((f.cacheRate ?? 0) * 100).toFixed(1)}% cache` : ""}
								</span>
							</span>
							<span className="omp-ranked-bar">
								<span className="omp-ranked-bar-fill" style={{ width: `${f.requestsPercentage}%` }} />
							</span>
							<span className="omp-ranked-metric">
								<strong>{formatInteger(f.totalRequests)}</strong>
							</span>
							<span className="omp-ranked-metric">
								{formatEstimatedCost(f.totalCost, f.unpricedRequests, 2)}
							</span>
							<span className="omp-ranked-metric">{f.avgDuration ? formatDurationMs(f.avgDuration) : "—"}</span>
							<span className="omp-ranked-metric">{formatPercent(f.cacheRate)}</span>
						</div>
					))}
				</div>
			</div>
		</div>
	);
}
