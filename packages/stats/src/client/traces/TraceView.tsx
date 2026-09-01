/**
 * Single-session trace viewer: summary strip, axis-mode toolbar, minimap,
 * flamegraph canvas, transcript list, tool aggregates, and the span drawer.
 * Owns the shared viewport/selection state so all pieces stay in sync.
 */

import { ArrowLeft, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getSessionTrace } from "../api";
import { useResource } from "../data/useResource";
import type { TraceSpan, TraceTrack } from "../types";
import { AsyncBoundary } from "../ui/AsyncBoundary";
import { SegmentedControl } from "../ui/SegmentedControl";
import { AggregatesPanel } from "./AggregatesPanel";
import { Minimap } from "./Minimap";
import { SpanDrawer } from "./SpanDrawer";
import { SummaryStrip } from "./SummaryStrip";
import { TimelineCanvas, type TimelineViewport } from "./TimelineCanvas";
import { TranscriptList } from "./TranscriptList";
import { type AxisMode, buildScale } from "./time-scale";

export interface TraceViewProps {
	file: string;
	active: boolean;
	onBack: () => void;
}

const MODE_OPTIONS: Array<{ value: AxisMode; label: string; title?: string }> = [
	{ value: "time", label: "Duration", title: "Real wall-clock time" },
	{ value: "turns", label: "Turns", title: "Equal width per user turn" },
	{ value: "calls", label: "Calls", title: "Equal width per model/tool call boundary" },
];

export function TraceView({ file, active, onBack }: TraceViewProps) {
	const {
		data: trace,
		error,
		loading,
		refetch,
		refreshing,
	} = useResource(["trace", file], signal => getSessionTrace(file, signal), {
		pollMs: 15000,
		enabled: active,
	});

	const [mode, setMode] = useState<AxisMode>("time");
	const [compressIdle, setCompressIdle] = useState(true);
	const [selection, setSelection] = useState<string | null>(null);
	const [drawerOpen, setDrawerOpen] = useState(false);
	const [search, setSearch] = useState("");
	const [matchIndex, setMatchIndex] = useState(0);
	const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
	const [viewport, setViewport] = useState<TimelineViewport | null>(null);

	const tracks = useMemo(() => trace?.tracks ?? [], [trace]);
	const scale = useMemo(() => buildScale(tracks, mode, compressIdle), [tracks, mode, compressIdle]);
	const scaleRef = useRef(scale);

	// File change: reset viewport/selection and default-collapse deep tracks.
	const lastFileRef = useRef<string | null>(null);
	useEffect(() => {
		if (!trace) return;
		if (lastFileRef.current === trace.file) return;
		lastFileRef.current = trace.file;
		setSelection(null);
		setSearch("");
		setViewport(null);
		const deep = new Set<string>();
		for (const track of trace.tracks) {
			const depth = track.id === "main" ? 0 : track.id.split("/").length;
			if (depth >= 1) deep.add(track.id);
		}
		setCollapsed(deep);
	}, [trace]);

	// Axis-mode / compression switches remap the viewport through wall time so
	// the visible window stays put; selection survives untouched.
	useEffect(() => {
		const prev = scaleRef.current;
		scaleRef.current = scale;
		setViewport(current => {
			if (!current) return current;
			const t0 = prev.toT(current.u0);
			const t1 = prev.toT(current.u1);
			const u0 = scale.toU(t0);
			const u1 = scale.toU(t1);
			return u1 - u0 > 0 ? { u0, u1 } : null;
		});
	}, [scale]);

	const effectiveViewport: TimelineViewport = viewport ?? { u0: scale.domain[0], u1: scale.domain[1] };

	const allSpans = useMemo(() => {
		const spans: Array<{ span: TraceSpan; track: TraceTrack }> = [];
		for (const track of tracks) {
			for (const span of track.spans) spans.push({ span, track });
		}
		spans.sort((a, b) => a.span.start - b.span.start);
		return spans;
	}, [tracks]);

	const matches = useMemo(() => {
		const needle = search.trim().toLowerCase();
		if (!needle) return [];
		return allSpans.filter(({ span }) => `${span.label} ${span.detail ?? ""}`.toLowerCase().includes(needle));
	}, [allSpans, search]);

	const centerOnSpan = useCallback(
		(span: TraceSpan) => {
			const u = scale.toU(span.start);
			const uEnd = scale.toU(span.end);
			setViewport(current => {
				const vp = current ?? { u0: scale.domain[0], u1: scale.domain[1] };
				if (u >= vp.u0 && uEnd <= vp.u1) return current;
				const window = vp.u1 - vp.u0;
				const mid = (u + uEnd) / 2;
				const [d0, d1] = scale.domain;
				let u0 = mid - window / 2;
				if (u0 < d0) u0 = d0;
				if (u0 + window > d1) u0 = Math.max(d0, d1 - window);
				return { u0, u1: u0 + window };
			});
		},
		[scale],
	);

	const selectAndReveal = useCallback(
		(spanId: string) => {
			setSelection(spanId);
			const found = allSpans.find(({ span }) => span.id === spanId);
			if (found) centerOnSpan(found.span);
		},
		[allSpans, centerOnSpan],
	);
	// Canvas click / transcript click: select AND open the detail drawer.
	// Search cycling only selects, so the timeline stays visible.
	const selectAndOpen = useCallback((spanId: string | null) => {
		setSelection(spanId);
		setDrawerOpen(spanId !== null);
	}, []);

	const cycleMatch = useCallback(
		(direction: 1 | -1) => {
			if (matches.length === 0) return;
			const next = (((matchIndex + direction) % matches.length) + matches.length) % matches.length;
			setMatchIndex(next);
			selectAndReveal(matches[next].span.id);
		},
		[matches, matchIndex, selectAndReveal],
	);

	const toggleCollapse = useCallback((trackId: string) => {
		setCollapsed(current => {
			const next = new Set(current);
			if (next.has(trackId)) next.delete(trackId);
			else next.add(trackId);
			return next;
		});
	}, []);

	const selected = useMemo(() => {
		if (!selection) return null;
		return allSpans.find(({ span }) => span.id === selection) ?? null;
	}, [selection, allSpans]);

	const openChildTrack = useCallback(
		(childTrackId: string) => {
			const child = tracks.find(track => track.id === childTrackId);
			const first = child?.spans[0];
			// Expand ancestors so the track is visible.
			setCollapsed(current => {
				const next = new Set(current);
				let cursor = child;
				while (cursor?.parentId) {
					next.delete(cursor.parentId);
					cursor = tracks.find(track => track.id === cursor?.parentId);
				}
				return next;
			});
			if (first) selectAndReveal(first.id);
		},
		[tracks, selectAndReveal],
	);

	const collapseAll = useCallback(
		(collapse: boolean) => {
			if (!collapse) {
				setCollapsed(new Set());
				return;
			}
			const all = new Set<string>();
			for (const track of tracks) {
				if (track.id !== "main") all.add(track.id);
			}
			setCollapsed(all);
		},
		[tracks],
	);

	const traceStart = trace?.startedAt ?? 0;

	return (
		<div className="stats-trace-view">
			<div className="stats-trace-header">
				<button type="button" onClick={onBack} className="stats-trace-back">
					<ArrowLeft size={13} aria-hidden="true" />
					Sessions
				</button>
				<h2 className="stats-trace-title" style={{ maxWidth: 480, margin: 0 }}>
					{trace?.title ?? file.split("/").pop()}
				</h2>
				{trace?.cwd && <span className="stats-trace-cwd">{trace.cwd}</span>}
				<button
					type="button"
					onClick={() => void refetch()}
					className="stats-trace-icon-btn"
					aria-label="Refresh trace"
					title="Refresh trace"
					style={{ marginLeft: "auto" }}
				>
					<RefreshCw size={14} className={refreshing ? "stats-spin" : undefined} />
				</button>
			</div>

			<AsyncBoundary loading={loading} error={error} data={trace}>
				{trace && (
					<>
						<SummaryStrip summary={trace.summary} />

						<div className="stats-trace-toolbar">
							<SegmentedControl options={MODE_OPTIONS} value={mode} onChange={setMode} />
							{mode === "time" && (
								<label className="stats-trace-check">
									<input
										type="checkbox"
										checked={compressIdle}
										onChange={event => setCompressIdle(event.target.checked)}
									/>
									Compress idle
								</label>
							)}
							<div style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
								<input
									type="search"
									value={search}
									onChange={event => {
										setSearch(event.target.value);
										setMatchIndex(0);
									}}
									placeholder="Search spans…"
									aria-label="Search spans"
									spellCheck={false}
									className="stats-trace-input"
									style={{ width: 190 }}
								/>
								{search.trim() && (
									<>
										<span
											className="stats-text-muted"
											style={{ fontSize: 11, fontVariantNumeric: "tabular-nums" }}
										>
											{matches.length === 0
												? "0"
												: `${(matchIndex % Math.max(matches.length, 1)) + 1}/${matches.length}`}
										</span>
										<button
											type="button"
											onClick={() => cycleMatch(-1)}
											className="stats-trace-icon-btn"
											aria-label="Previous match"
											disabled={matches.length === 0}
										>
											‹
										</button>
										<button
											type="button"
											onClick={() => cycleMatch(1)}
											className="stats-trace-icon-btn"
											aria-label="Next match"
											disabled={matches.length === 0}
										>
											›
										</button>
									</>
								)}
							</div>
							<div style={{ marginLeft: "auto", display: "inline-flex", gap: 6 }}>
								<button type="button" onClick={() => collapseAll(false)} className="stats-trace-back">
									Expand all
								</button>
								<button type="button" onClick={() => collapseAll(true)} className="stats-trace-back">
									Collapse all
								</button>
							</div>
						</div>

						<div className="stats-trace-timeline-card">
							<Minimap
								tracks={tracks}
								scale={scale}
								viewport={effectiveViewport}
								onViewportChange={setViewport}
							/>
							<TimelineCanvas
								tracks={tracks}
								scale={scale}
								viewport={effectiveViewport}
								onViewportChange={setViewport}
								selection={selection}
								onSelect={selectAndOpen}
								search={search}
								collapsed={collapsed}
								onToggleCollapse={toggleCollapse}
								traceStart={traceStart}
							/>
							<div className="stats-trace-toolbar-hint" style={{ marginLeft: 0 }}>
								W/S zoom · A/D pan · drag pan · wheel zoom · 0 fit · F focus selection · dbl-click focus · Esc
								deselect
							</div>
						</div>
						<TranscriptList
							tracks={tracks}
							selection={selection}
							onSelect={spanId => {
								selectAndReveal(spanId);
								setDrawerOpen(true);
							}}
							search={search}
							traceStart={traceStart}
						/>
						<AggregatesPanel toolStats={trace.summary.toolStats} />
					</>
				)}
			</AsyncBoundary>

			<SpanDrawer
				span={drawerOpen ? (selected?.span ?? null) : null}
				track={selected?.track ?? null}
				onClose={() => setDrawerOpen(false)}
				onOpenChildTrack={openChildTrack}
			/>
		</div>
	);
}
