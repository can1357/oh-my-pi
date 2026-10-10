/**
 * Windowed transcript list under the timeline: all spans + markers flattened
 * chronologically across tracks, bidirectionally synced with the canvas
 * selection. Hand-rolled fixed-row virtualization (32px rows, spacer divs).
 */

import { memo, useEffect, useMemo, useRef, useState } from "react";
import { formatDurationMs } from "../data/formatters";
import { EmptyState } from "../ui";
import type { TraceMarker, TraceSpan, TraceTrack } from "../types";
import { formatOffset } from "./time-scale";
import { useTraceTheme } from "./trace-colors";

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
	/** Spans matching `search` (from the trace view); `null` when not searching. */
	matchIds: ReadonlySet<string> | null;
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

export const TranscriptList = memo(function TranscriptList({
	tracks,
	selection,
	onSelect,
	search,
	matchIds,
	traceStart,
}: TranscriptListProps) {
	const colors = useTraceTheme();
	const containerRef = useRef<HTMLDivElement>(null);
	const [scrollTop, setScrollTop] = useState(0);

	const allRows = useMemo(() => buildTranscriptRows(tracks), [tracks]);
	const rows = useMemo(() => {
		if (!matchIds) return allRows;
		const needle = search.trim().toLowerCase();
		return allRows.filter(row =>
			row.span ? matchIds.has(row.span.id) : (row.marker?.label ?? "").toLowerCase().includes(needle),
		);
	}, [allRows, search, matchIds]);

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
		<div ref={containerRef} onScroll={event => setScrollTop(event.currentTarget.scrollTop)} className="traces-list">
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
								<span className="traces-kind" style={{ "--traces-kind-color": color } as React.CSSProperties}>
									{chipText}
								</span>
								{row.depth > 0 && (
									<span className="traces-row-track mono truncate" title={row.track.label}>
										{row.track.id}
									</span>
								)}
								<span className="traces-row-label truncate">{label}</span>
								{detail && <span className="traces-row-detail truncate">{detail}</span>}
								<span className="traces-row-meta num">
									{row.span?.isError && <span className="tone-bad">error</span>}
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
								className="traces-row"
								data-selected={isSelected ? "true" : "false"}
								style={indent}
							>
								{rowContent}
							</button>
						) : (
							<div key={row.key} className="traces-row" data-static="true" style={indent}>
								{rowContent}
							</div>
						);
					})}
				</div>
			</div>
			{rows.length === 0 && <EmptyState title="No matching events" />}
		</div>
	);
});
