import { useEffect, useMemo, useState } from "react";
import { getRequestsPaginated } from "../api";
import { formatDurationMs, formatInteger, formatMessageCost } from "../data/formatters";
import { useResource } from "../data/useResource";
import { type RequestSortKey, type SortDir, sortRequests } from "../data/view-models";
import type { MessageStats, TimeRange } from "../types";
import { AsyncBoundary, StatusPill } from "../ui";

export interface RequestsRouteProps {
	active: boolean;
	range: TimeRange;
	refreshTrigger: number;
	onRequestClick: (id: number) => void;
}

const PAGE_SIZE = 25;
const SORT_KEY = "omp-stats:requests-sort";
type Stored = { key: RequestSortKey; dir: SortDir };
function loadSort(): Stored {
	try {
		const raw = sessionStorage.getItem(SORT_KEY);
		if (raw) return JSON.parse(raw) as Stored;
	} catch {}
	return { key: "timestamp", dir: "desc" };
}
function saveSort(v: Stored) {
	try {
		sessionStorage.setItem(SORT_KEY, JSON.stringify(v));
	} catch {}
}

export function RequestsRoute({ active, range, refreshTrigger, onRequestClick }: RequestsRouteProps) {
	const [offset, setOffset] = useState(0);
	useEffect(() => setOffset(0), [range, refreshTrigger]);

	const {
		data: page,
		error,
		loading,
	} = useResource(
		["requests", range, refreshTrigger, offset],
		signal => getRequestsPaginated(range, PAGE_SIZE, offset, signal),
		{ pollMs: 30000, enabled: active },
	);

	return (
		<div className="stats-route-container">
			<div className="omp-hero">
				<div className="omp-hero-head">
					<h2 className="omp-hero-title">
						Requests <span>{range} · explorer</span>
					</h2>
					<span className="omp-hero-range">
						{page ? `${page.total} total · page ${Math.floor(offset / PAGE_SIZE) + 1}` : "loading"}
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
					Serious explorer — time, model, provider, input/output, cache, latency, cost, status. Row click opens the
					drawer (reuses RequestDrawer). Sorted client-side within the loaded page; paginated server-side.
				</p>
			</div>

			<AsyncBoundary loading={loading} error={error} data={page}>
				{page && (
					<RequestsExplorer
						requests={page.requests}
						total={page.total}
						offset={offset}
						setOffset={setOffset}
						onRequestClick={onRequestClick}
					/>
				)}
			</AsyncBoundary>
		</div>
	);
}

function RequestsExplorer({
	requests,
	total,
	offset,
	setOffset,
	onRequestClick,
}: {
	requests: MessageStats[];
	total: number;
	offset: number;
	setOffset: (n: number) => void;
	onRequestClick: (id: number) => void;
}) {
	const [sort, setSort] = useState<Stored>(() => loadSort());
	useEffect(() => saveSort(sort), [sort]);

	const sorted = useMemo(() => sortRequests(requests, sort.key, sort.dir), [requests, sort]);
	const toggle = (key: RequestSortKey) =>
		setSort(prev => (prev.key === key ? { key, dir: prev.dir === "asc" ? "desc" : "asc" } : { key, dir: "desc" }));
	const headBtn = (label: string, key: RequestSortKey) => {
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
					<div className="omp-section-title">Request stream</div>
					<p className="omp-section-desc">
						Click any row for full request detail. Cache columns distinguish prompt caching from plain tokens.
					</p>
				</div>
				<span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--dim)" }}>
					{formatInteger(total)} total
				</span>
			</div>
			<div className="omp-section-rule" />
			<div className="omp-section-body">
				<div className="omp-explorer-wrap">
					<div className="omp-explorer-head">
						<span>{headBtn("Time", "timestamp")}</span>
						<span>{headBtn("Model", "model")}</span>
						<span className="hide-md">Provider</span>
						<span style={{ textAlign: "right" }}>{headBtn("In", "tokens")}</span>
						<span style={{ textAlign: "right" }}>Out</span>
						<span style={{ textAlign: "right" }} className="hide-md">
							Cache
						</span>
						<span style={{ textAlign: "right" }}>{headBtn("Latency", "duration")}</span>
						<span style={{ textAlign: "right" }}>{headBtn("Cost", "cost")}</span>
						<span style={{ textAlign: "center" }}>Status</span>
					</div>
					{sorted.length === 0 ? (
						<div className="stats-table-empty">No requests in this window.</div>
					) : (
						sorted.map(r => {
							const isError = !!r.errorMessage;
							return (
								<div
									key={r.id ?? `${r.entryId}-${r.timestamp}`}
									className="omp-explorer-row"
									role="button"
									tabIndex={0}
									onClick={() => r.id && onRequestClick(r.id)}
									onKeyDown={e => {
										if ((e.key === "Enter" || e.key === " ") && r.id) {
											e.preventDefault();
											onRequestClick(r.id);
										}
									}}
								>
									<span className="mono" style={{ color: "var(--dim)" }}>
										{new Date(r.timestamp).toLocaleString()}
									</span>
									<span
										style={{
											fontFamily: "var(--font-mono)",
											fontSize: 11,
											color: "var(--text)",
											fontWeight: 600,
											overflow: "hidden",
											textOverflow: "ellipsis",
											whiteSpace: "nowrap",
										}}
										title={r.model}
									>
										{r.model}
									</span>
									<span
										className="mono hide-md"
										title={r.provider}
										style={{ overflow: "hidden", textOverflow: "ellipsis" }}
									>
										{r.provider}
									</span>
									<span className="mono" style={{ textAlign: "right" }}>
										{formatInteger(r.usage.input)}
									</span>
									<span className="mono" style={{ textAlign: "right" }}>
										{formatInteger(r.usage.output)}
									</span>
									<span className="mono hide-md" style={{ textAlign: "right" }}>
										{formatInteger(r.usage.cacheRead)}
									</span>
									<span className="mono" style={{ textAlign: "right" }}>
										{formatDurationMs(r.duration)}
									</span>
									<span className="mono" style={{ textAlign: "right", color: "var(--amber)" }}>
										{formatMessageCost(r, 4)}
									</span>
									<span style={{ textAlign: "center" }}>
										<StatusPill variant={isError ? "danger" : "success"}>
											{isError ? "Fail" : "OK"}
										</StatusPill>
									</span>
								</div>
							);
						})
					)}
					<div className="omp-explorer-pager">
						<span>
							Showing {sorted.length === 0 ? 0 : offset + 1}–{offset + sorted.length} of {formatInteger(total)}
						</span>
						<div style={{ display: "flex", gap: 6 }}>
							<button
								type="button"
								className="stats-button stats-button-secondary"
								style={{ fontSize: 11, padding: "5px 10px" }}
								disabled={offset === 0}
								onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
							>
								← Prev
							</button>
							<button
								type="button"
								className="stats-button stats-button-secondary"
								style={{ fontSize: 11, padding: "5px 10px" }}
								disabled={offset + PAGE_SIZE >= total}
								onClick={() => setOffset(offset + PAGE_SIZE)}
							>
								Next →
							</button>
						</div>
					</div>
				</div>
			</div>
		</div>
	);
}
