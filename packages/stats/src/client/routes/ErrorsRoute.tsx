import { useMemo, useState } from "react";
import { getRecentErrors } from "../api";
import { formatDurationMs, formatInteger } from "../data/formatters";
import { useResource } from "../data/useResource";
import { type ErrorGroupBy, groupErrors, normalizeErrorMessage } from "../data/view-models";
import type { MessageStats, TimeRange } from "../types";
import { AsyncBoundary } from "../ui";

export interface ErrorsRouteProps {
	active: boolean;
	range: TimeRange;
	refreshTrigger: number;
	onRequestClick: (id: number) => void;
}

export function ErrorsRoute({ active, range, refreshTrigger, onRequestClick }: ErrorsRouteProps) {
	const {
		data: recentErrors,
		error,
		loading,
	} = useResource(["recent-errors-dense", range, refreshTrigger], signal => getRecentErrors(range, 50, signal), {
		pollMs: 30000,
		enabled: active,
	});
	return (
		<div className="stats-route-container">
			<div className="omp-hero">
				<div className="omp-hero-head">
					<h2 className="omp-hero-title">
						Errors <span>{range} · grouped explorer</span>
					</h2>
					<span className="omp-hero-range">
						{recentErrors ? `${recentErrors.length} failures · grouped by signature` : "loading"}
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
					Repeated failures collapse into one row per provider + signature — e.g. “Key limit exceeded · OpenRouter
					· 31 occurrences” — with expandable occurrences. Filters refine without losing context.
				</p>
			</div>

			<AsyncBoundary loading={loading} error={error} data={recentErrors}>
				{recentErrors && <ErrorsExplorer errors={recentErrors} onRequestClick={onRequestClick} />}
			</AsyncBoundary>
		</div>
	);
}

function ErrorsExplorer({ errors, onRequestClick }: { errors: MessageStats[]; onRequestClick: (id: number) => void }) {
	const [groupBy, setGroupBy] = useState<ErrorGroupBy>("error");
	const [providerFilter, setProviderFilter] = useState<string>("all");
	const [modelFilter, setModelFilter] = useState<string>("all");
	const [expanded, setExpanded] = useState<string | null>(null);

	const providers = useMemo(
		() => [...new Set(errors.filter(e => e.errorMessage).map(e => e.provider))].sort(),
		[errors],
	);
	const models = useMemo(() => [...new Set(errors.filter(e => e.errorMessage).map(e => e.model))].sort(), [errors]);

	const filtered = useMemo(() => {
		return errors.filter(e => {
			if (!e.errorMessage) return false;
			if (providerFilter !== "all" && e.provider !== providerFilter) return false;
			if (modelFilter !== "all" && e.model !== modelFilter) return false;
			return true;
		});
	}, [errors, providerFilter, modelFilter]);

	const groups = useMemo(() => groupErrors(filtered, groupBy), [filtered, groupBy]);

	return (
		<div className="omp-section">
			<div className="omp-section-head">
				<div>
					<div className="omp-section-title">Error groups</div>
					<p className="omp-section-desc">
						{groups.length} groups · {filtered.length} occurrences · group-by controls signature. Occurrence list
						shows timestamp, model and latency per event.
					</p>
				</div>
				<div className="omp-error-controls">
					<div className="stats-segmented-control" role="group" aria-label="Group by">
						{(["error", "provider", "model"] as const).map(v => (
							<button
								key={v}
								type="button"
								className="stats-segmented-control-btn"
								data-active={groupBy === v ? "true" : "false"}
								onClick={() => {
									setGroupBy(v);
									setExpanded(null);
								}}
							>
								{v}
							</button>
						))}
					</div>
				</div>
			</div>
			<div className="omp-section-rule" />
			<div className="omp-section-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
				<div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
					<div style={{ display: "flex", gap: 4, alignItems: "center", flexWrap: "wrap" }}>
						<span
							style={{
								fontFamily: "var(--font-sans)",
								fontSize: 11,
								fontWeight: 600,
								color: "var(--dim)",
								textTransform: "uppercase",
								letterSpacing: "0.04em",
							}}
						>
							Provider
						</span>
						<div className="stats-segmented-control" style={{ display: "inline-flex", flexWrap: "wrap" }}>
							<button
								type="button"
								className="stats-segmented-control-btn"
								data-active={providerFilter === "all" ? "true" : "false"}
								onClick={() => setProviderFilter("all")}
							>
								All
							</button>
							{providers.slice(0, 8).map(p => (
								<button
									key={p}
									type="button"
									className="stats-segmented-control-btn"
									data-active={providerFilter === p ? "true" : "false"}
									onClick={() => setProviderFilter(p)}
									title={p}
								>
									{p}
								</button>
							))}
						</div>
					</div>
					<div style={{ display: "flex", gap: 4, alignItems: "center", flexWrap: "wrap" }}>
						<span
							style={{
								fontFamily: "var(--font-sans)",
								fontSize: 11,
								fontWeight: 600,
								color: "var(--dim)",
								textTransform: "uppercase",
								letterSpacing: "0.04em",
							}}
						>
							Model
						</span>
						<div className="stats-segmented-control" style={{ display: "inline-flex", flexWrap: "wrap" }}>
							<button
								type="button"
								className="stats-segmented-control-btn"
								data-active={modelFilter === "all" ? "true" : "false"}
								onClick={() => setModelFilter("all")}
							>
								All
							</button>
							{models.slice(0, 6).map(m => (
								<button
									key={m}
									type="button"
									className="stats-segmented-control-btn"
									data-active={modelFilter === m ? "true" : "false"}
									onClick={() => setModelFilter(m)}
									title={m}
									style={{ maxWidth: 140, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
								>
									{m}
								</button>
							))}
						</div>
					</div>
					<span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--dim)", marginLeft: "auto" }}>
						{filtered.length} / {errors.filter(e => e.errorMessage).length} shown
					</span>
				</div>
				{groups.length === 0 ? (
					<div className="stats-table-empty">No failures matching filters in this window.</div>
				) : (
					<div>
						{groups.map(g => {
							const isExpanded = expanded === g.key;
							return (
								<div key={g.key} className="omp-error-group" data-expanded={isExpanded ? "true" : "false"}>
									<div style={{ minWidth: 0, flex: 1, display: "flex", flexDirection: "column", gap: 4 }}>
										<div className="omp-error-sig" title={g.representativeMessage}>
											{g.signature}
											{groupBy === "error" && (
												<span
													style={{
														fontWeight: 400,
														color: "var(--dim)",
														fontFamily: "var(--font-mono)",
														fontSize: 11,
														marginLeft: 6,
													}}
												>
													· {g.provider}
												</span>
											)}
										</div>
										<div className="omp-error-meta">
											<span>
												<strong>{g.count}</strong> occurrence{g.count === 1 ? "" : "s"}
											</span>
											<span>· {g.provider}</span>
											<span>· {g.model}</span>
											<span>· last {new Date(g.latestTimestamp).toLocaleString()}</span>
										</div>
										{isExpanded && (
											<div className="omp-error-occ">
												{g.items.map(item => (
													<div
														key={item.id ?? `${item.entryId}-${item.timestamp}`}
														className="omp-error-occ-row"
														role="button"
														tabIndex={0}
														onClick={() => item.id && onRequestClick(item.id)}
														onKeyDown={e => {
															if ((e.key === "Enter" || e.key === " ") && item.id) {
																e.preventDefault();
																onRequestClick(item.id);
															}
														}}
														style={{ cursor: item.id ? "pointer" : undefined }}
													>
														<span>{new Date(item.timestamp).toLocaleString()}</span>
														<span
															className="hide-sm"
															style={{
																fontFamily: "var(--font-mono)",
																color: "var(--text)",
																overflow: "hidden",
																textOverflow: "ellipsis",
																whiteSpace: "nowrap",
															}}
															title={item.model}
														>
															{item.model}
														</span>
														<span>{formatDurationMs(item.duration)}</span>
														<span
															className="hide-sm"
															style={{
																color: "var(--dim)",
																overflow: "hidden",
																textOverflow: "ellipsis",
																whiteSpace: "nowrap",
															}}
															title={normalizeErrorMessage(item.errorMessage)}
														>
															{normalizeErrorMessage(item.errorMessage).slice(0, 80)}
														</span>
													</div>
												))}
											</div>
										)}
									</div>
									<div
										style={{
											display: "flex",
											flexDirection: "column",
											gap: 6,
											alignItems: "flex-end",
											justifyContent: "flex-start",
										}}
									>
										<span
											style={{
												fontFamily: "var(--font-mono)",
												fontSize: 11,
												color: "var(--text)",
												background: "var(--surface-2)",
												border: "1px solid var(--border)",
												borderRadius: "var(--radius-sm)",
												padding: "3px 7px",
												fontVariantNumeric: "tabular-nums",
											}}
										>
											{formatInteger(g.count)}×
										</span>
										<button
											type="button"
											className="omp-ranked-expand"
											aria-label={isExpanded ? "Collapse" : "Expand"}
											onClick={() => setExpanded(isExpanded ? null : g.key)}
											style={{ width: 28, height: 28 }}
										>
											{isExpanded ? "−" : "+"}
										</button>
									</div>
								</div>
							);
						})}
					</div>
				)}
			</div>
		</div>
	);
}
