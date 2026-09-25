/**
 * Windowed transcript list under the timeline: all spans + markers flattened
 * chronologically across tracks, bidirectionally synced with the canvas
 * selection. Hand-rolled fixed-row virtualization (32px rows, spacer divs).
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { formatDurationMs } from "../data/formatters";
import type { TraceMarker, TraceSpan, TraceTrack } from "../types";
import { useSystemTheme } from "../useSystemTheme";
import { formatOffset } from "./time-scale";
import { TRACE_THEMES } from "./trace-colors";

export interface TranscriptRow {
	key: string;
	time: number;
	span?: TraceSpan;
	marker?: TraceMarker;
	track: TraceTrack;
	depth: number;
}

export interface TranscriptListProps {
	tracks: TraceTrack[];
	selection: string | null;
	onSelect: (spanId: string) => void;
	search: string;
	traceStart: number;
}

const ROW_H = 28;
const OVERSCAN = 20;
const LIST_H = 340;

/** Flatten all spans and markers across tracks into chronological rows. */
export function buildTranscriptRows(tracks: TraceTrack[]): TranscriptRow[] {
	const rows: TranscriptRow[] = [];
	for (const track of tracks) {
		const depth = track.id === "main" ? 0 : track.id.split("/").length;
		for (const span of track.spans) {
			rows.push({ key: span.id, time: span.start, span, track, depth });
		}
		for (let i = 0; i < track.markers.length; i++) {
			const marker = track.markers[i];
			rows.push({ key: `${track.id}:marker:${i}`, time: marker.time, marker, track, depth });
		}
	}
	rows.sort((a, b) => a.time - b.time);
	return rows;
}

export function TranscriptList({ tracks, selection, onSelect, search, traceStart }: TranscriptListProps) {
	const theme = useSystemTheme();
	const colors = TRACE_THEMES[theme];
	const containerRef = useRef<HTMLDivElement>(null);
	const [scrollTop, setScrollTop] = useState(0);

	const allRows = useMemo(() => buildTranscriptRows(tracks), [tracks]);
	const rows = useMemo(() => {
		const needle = search.trim().toLowerCase();
		if (!needle) return allRows;
		return allRows.filter(row => {
			const text = row.span ? `${row.span.label} ${row.span.detail ?? ""}` : (row.marker?.label ?? "");
			return text.toLowerCase().includes(needle);
		});
	}, [allRows, search]);

	// Scroll the selected row into view when selection changes externally.
	useEffect(() => {
		if (!selection) return;
		const container = containerRef.current;
		if (!container) return;
		const index = rows.findIndex(row => row.span?.id === selection);
		if (index === -1) return;
		const rowTop = index * ROW_H;
		if (rowTop < container.scrollTop || rowTop + ROW_H > container.scrollTop + container.clientHeight) {
			container.scrollTop = Math.max(0, rowTop - container.clientHeight / 2);
		}
	}, [selection, rows]);

	const firstVisible = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
	const lastVisible = Math.min(rows.length, Math.ceil((scrollTop + LIST_H) / ROW_H) + OVERSCAN);
	const visible = rows.slice(firstVisible, lastVisible);

	return (
		<div
			ref={containerRef}
			onScroll={event => setScrollTop(event.currentTarget.scrollTop)}
			className="stats-trace-list"
		>
			<div style={{ height: rows.length * ROW_H, position: "relative" }}>
				<div style={{ position: "absolute", top: firstVisible * ROW_H, left: 0, right: 0 }}>
					{visible.map(row => {
						const span = row.span;
						const isSelected = span !== undefined && span.id === selection;
						const color = row.span ? colors.category[row.span.kind] : colors.marker;
						const label = row.span?.label ?? row.marker?.label ?? "";
						const detail = row.span?.detail;
						const duration = row.span ? formatDurationMs(row.span.end - row.span.start) : "";
						const chipText = row.span?.kind ?? row.marker?.kind ?? "";
						const rowContent = (
							<>
								<span
									className="stats-trace-kind"
									style={{
										color,
										background: `${color}1c`,
									}}
								>
									{chipText}
								</span>
								{row.depth > 0 && (
									<span
										className="stats-text-muted truncate"
										style={{ flexShrink: 0, maxWidth: 90, fontSize: 9 }}
										title={row.track.label}
									>
										{row.track.id}
									</span>
								)}
								<span
									className="stats-text-primary truncate"
									style={{ fontSize: 11, minWidth: 0, flexShrink: 1 }}
								>
									{label}
								</span>
								{detail && (
									<span className="stats-text-muted truncate" style={{ fontSize: 10, minWidth: 0, flex: 1 }}>
										{detail}
									</span>
								)}
								<span className="stats-trace-row-meta">
									{row.span?.isError && <span style={{ color: colors.error }}>error</span>}
									<span>{duration}</span>
									<span>{formatOffset(row.time - traceStart)}</span>
								</span>
							</>
						);
						const indent = { paddingLeft: 12 + row.depth * 12 };
						return span ? (
							<button
								key={row.key}
								type="button"
								onClick={() => onSelect(span.id)}
								className="stats-trace-row"
								data-selected={isSelected ? "true" : "false"}
								style={indent}
							>
								{rowContent}
							</button>
						) : (
							<div key={row.key} className="stats-trace-row stats-trace-row-static" style={indent}>
								{rowContent}
							</div>
						);
					})}
				</div>
			</div>
			{rows.length === 0 && (
				<div className="stats-text-muted" style={{ padding: 16, fontSize: 12 }}>
					No matching events
				</div>
			)}
		</div>
	);
}
