/**
 * The trace flamegraph: a DPR-scaled scene canvas with DOM hover/selection
 * boxes on top, a DOM gutter (track/lane labels, collapse chevrons) and a
 * DOM tooltip. Implements the Chrome DevTools interaction contract:
 * cursor-anchored wheel zoom, drag pan, WASD, fit/focus keys, hover tooltips,
 * click-to-select, double-click-to-zoom.
 */

import { ChevronDown, ChevronRight } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { formatDurationMs, formatInteger } from "../data/formatters";
import type { TraceMarker, TraceSpan, TraceSpanKind, TraceTrack } from "../types";
import { buildTicks, formatOffset, type TraceScale } from "./time-scale";
import { type TraceTheme, useTraceTheme } from "./trace-colors";

export interface TimelineViewport {
	u0: number;
	u1: number;
}

export interface TimelineCanvasProps {
	tracks: TraceTrack[];
	scale: TraceScale;
	viewport: TimelineViewport;
	onViewportChange: (viewport: TimelineViewport) => void;
	/** The selected span with its track (resolved by the trace view). */
	selected: { span: TraceSpan; track: TraceTrack } | null;
	onSelect: (spanId: string | null) => void;
	/** Spans matching the search; `null` when not searching (everything at full opacity). */
	matchIds: ReadonlySet<string> | null;
	collapsed: ReadonlySet<string>;
	onToggleCollapse: (trackId: string) => void;
	traceStart: number;
}

const RULER_H = 28;
const HEADER_H = 22;
const LANE_H = 18;
const LANE_GAP = 3;
const TRACK_GAP = 14;
const GUTTER_W = 200;
const MIN_WINDOW_U = 10;
const MIN_SPAN_PX = 2;
const HIT_SLOP_PX = 4;
const LABEL_MIN_PX = 56;
const SPAN_RADIUS = 3;
/** Opacity of spans that don't match the search. */
const DIM_ALPHA = 0.3;

const LANE_ORDER: Array<{ kind: TraceSpanKind; label: string }> = [
	{ kind: "turn", label: "Input" },
	{ kind: "model", label: "Model" },
	{ kind: "tool", label: "Tools" },
	{ kind: "subagent", label: "Agents" },
	{ kind: "background", label: "Bg" },
];

interface LaneRow {
	track: TraceTrack;
	kind: TraceSpanKind;
	label: string;
	y: number;
	spans: TraceSpan[];
}

interface TrackBlock {
	track: TraceTrack;
	depth: number;
	hasChildren: boolean;
	headerY: number;
	lanes: LaneRow[];
	/** Turn spans of the track (start order), for the alternating turn bands. */
	turnSpans: TraceSpan[];
	/** Full vertical extent of the block (header top → last lane bottom). */
	y0: number;
	y1: number;
}

interface TimelineLayout {
	blocks: TrackBlock[];
	lanes: LaneRow[];
	totalHeight: number;
}

/** Compute vertical layout for the visible (non-collapsed) track tree. */
function buildLayout(tracks: TraceTrack[], collapsed: ReadonlySet<string>): TimelineLayout {
	const byId = new Map(tracks.map(track => [track.id, track]));
	const hasChildren = new Set<string>();
	for (const track of tracks) {
		if (track.parentId) hasChildren.add(track.parentId);
	}

	const isHidden = (track: TraceTrack): boolean => {
		let parentId = track.parentId;
		while (parentId) {
			if (collapsed.has(parentId)) return true;
			parentId = byId.get(parentId)?.parentId ?? null;
		}
		return false;
	};

	const blocks: TrackBlock[] = [];
	const lanes: LaneRow[] = [];
	let y = RULER_H + 6;
	for (const track of tracks) {
		if (isHidden(track)) continue;
		const depth = track.id === "main" ? 0 : track.id.split("/").length;
		const byKind: Record<TraceSpanKind, TraceSpan[]> = {
			turn: [],
			model: [],
			tool: [],
			subagent: [],
			background: [],
		};
		for (const span of track.spans) byKind[span.kind].push(span);
		const block: TrackBlock = {
			track,
			depth,
			hasChildren: hasChildren.has(track.id),
			headerY: y,
			lanes: [],
			turnSpans: byKind.turn,
			y0: y,
			y1: y,
		};
		y += HEADER_H;
		for (const { kind, label } of LANE_ORDER) {
			const spans = byKind[kind];
			// Main always shows the core lanes; optional lanes appear when populated.
			const isCore = kind === "turn" || kind === "model" || kind === "tool";
			if (spans.length === 0 && !(track.id === "main" && isCore)) continue;
			const lane: LaneRow = { track, kind, label, y, spans };
			block.lanes.push(lane);
			lanes.push(lane);
			y += LANE_H + LANE_GAP;
		}
		block.y1 = y - LANE_GAP;
		blocks.push(block);
		y += TRACK_GAP;
	}
	return { blocks, lanes, totalHeight: Math.max(y, RULER_H + 48) };
}

/** Per-lane span positions on the virtual axis, parallel to `LaneRow.spans`. */
interface LaneAxis {
	startU: Float64Array;
	endU: Float64Array;
	/** Running max of `endU`; monotonic, so the first visible span is a binary search away. */
	maxEndU: Float64Array;
}

export function buildLaneAxes(
	layout: { lanes: ReadonlyArray<{ spans: ReadonlyArray<Pick<TraceSpan, "start" | "end">> }> },
	scale: Pick<TraceScale, "toU">,
): LaneAxis[] {
	return layout.lanes.map(lane => {
		const n = lane.spans.length;
		const startU = new Float64Array(n);
		const endU = new Float64Array(n);
		const maxEndU = new Float64Array(n);
		let maxEnd = Number.NEGATIVE_INFINITY;
		for (let i = 0; i < n; i++) {
			const span = lane.spans[i];
			startU[i] = scale.toU(span.start);
			endU[i] = scale.toU(span.end);
			maxEnd = Math.max(maxEnd, endU[i]);
			maxEndU[i] = maxEnd;
		}
		return { startU, endU, maxEndU };
	});
}

/** First index whose running-max end reaches `u0`: every earlier span ends before the viewport. */
export function firstVisible(maxEndU: Float64Array, u0: number): number {
	let lo = 0;
	let hi = maxEndU.length;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		if (maxEndU[mid] < u0) lo = mid + 1;
		else hi = mid;
	}
	return lo;
}

interface SpanHit {
	kind: "span";
	x: number;
	y: number;
	w: number;
	h: number;
	span: TraceSpan;
	track: TraceTrack;
}

interface MarkerHit {
	kind: "marker";
	x: number;
	y: number;
	w: number;
	h: number;
	marker: TraceMarker;
	track: TraceTrack;
}

type Hit = SpanHit | MarkerHit;

function sameTarget(a: Hit | null, b: Hit | null): boolean {
	if (a === null || b === null) return a === b;
	if (a.kind === "span") return b.kind === "span" && a.span === b.span;
	return b.kind === "marker" && a.marker === b.marker;
}

export function TimelineCanvas({
	tracks,
	scale,
	viewport,
	onViewportChange,
	selected,
	onSelect,
	matchIds,
	collapsed,
	onToggleCollapse,
	traceStart,
}: TimelineCanvasProps) {
	const colors = useTraceTheme();
	const containerRef = useRef<HTMLDivElement>(null);
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const tooltipRef = useRef<HTMLDivElement>(null);
	const [canvasWidth, setCanvasWidth] = useState(800);
	// Hovered target only; the pointer position lives in a ref and moves the
	// tooltip directly, so moving within one span doesn't re-render.
	const [hover, setHover] = useState<Hit | null>(null);
	const hoverRef = useRef<Hit | null>(null);
	hoverRef.current = hover;
	const pointerRef = useRef({ clientX: 0, clientY: 0 });
	const hitsRef = useRef<Hit[]>([]);
	const dragRef = useRef<{ pointerId: number; lastX: number; moved: boolean } | null>(null);
	const hoverXRef = useRef<number | null>(null);
	// Authoritative viewport for input handlers: wheel/drag events fire faster
	// than React re-renders, and computing each step from the stale `viewport`
	// prop would drop deltas within a frame (sluggish, jumpy zoom).
	const viewportRef = useRef(viewport);
	viewportRef.current = viewport;

	const layout = useMemo(() => buildLayout(tracks, collapsed), [tracks, collapsed]);
	const laneAxes = useMemo(() => buildLaneAxes(layout, scale), [layout, scale]);

	// Observe container width (gutter excluded).
	useEffect(() => {
		const container = containerRef.current;
		if (!container) return;
		const observer = new ResizeObserver(entries => {
			const width = Math.max(100, Math.floor(entries[0].contentRect.width - GUTTER_W));
			setCanvasWidth(width);
		});
		observer.observe(container);
		return () => observer.disconnect();
	}, []);

	const clampViewport = useCallback(
		(u0: number, u1: number): TimelineViewport => {
			const [d0, d1] = scale.domain;
			let span = Math.max(MIN_WINDOW_U, u1 - u0);
			span = Math.min(span, d1 - d0 || MIN_WINDOW_U);
			let start = u0;
			if (start < d0) start = d0;
			if (start + span > d1) start = d1 - span;
			return { u0: start, u1: start + span };
		},
		[scale],
	);
	const applyViewport = useCallback(
		(next: TimelineViewport) => {
			viewportRef.current = next;
			onViewportChange(next);
		},
		[onViewportChange],
	);

	const zoomAt = useCallback(
		(factor: number, anchorPx: number | null) => {
			const width = canvasWidth;
			const { u0, u1 } = viewportRef.current;
			const span = u1 - u0;
			const anchorFrac = anchorPx === null ? 0.5 : Math.min(1, Math.max(0, anchorPx / width));
			const anchorU = u0 + span * anchorFrac;
			const nextSpan = span * factor;
			applyViewport(clampViewport(anchorU - nextSpan * anchorFrac, anchorU + nextSpan * (1 - anchorFrac)));
		},
		[canvasWidth, applyViewport, clampViewport],
	);

	const panBy = useCallback(
		(deltaU: number) => {
			const { u0, u1 } = viewportRef.current;
			applyViewport(clampViewport(u0 + deltaU, u1 + deltaU));
		},
		[applyViewport, clampViewport],
	);

	const zoomToSpan = useCallback(
		(span: TraceSpan) => {
			const s = scale.toU(span.start);
			const e = scale.toU(span.end);
			const pad = Math.max((e - s) * 0.1, MIN_WINDOW_U / 2);
			applyViewport(clampViewport(s - pad, e + pad));
		},
		[scale, applyViewport, clampViewport],
	);

	// Native wheel listener: React's synthetic wheel is passive, preventDefault needs this.
	useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas) return;
		const handleWheel = (event: WheelEvent) => {
			event.preventDefault();
			const rect = canvas.getBoundingClientRect();
			const x = event.clientX - rect.left;
			hoverXRef.current = x;
			setHover(null);
			const width = canvas.clientWidth || 1;
			const spanU = () => viewportRef.current.u1 - viewportRef.current.u0;
			if (event.shiftKey) {
				// Shift+wheel: pan by the dominant delta.
				const deltaPx = Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
				panBy((deltaPx / width) * spanU());
				return;
			}
			// Trackpads emit mixed deltas: horizontal component pans, vertical
			// component zooms at the cursor (pinch arrives as ctrl+wheel deltaY).
			if (event.deltaX !== 0) panBy((event.deltaX / width) * spanU());
			if (event.deltaY !== 0) zoomAt(1.0015 ** event.deltaY, x);
		};
		canvas.addEventListener("wheel", handleWheel, { passive: false });
		return () => canvas.removeEventListener("wheel", handleWheel);
	}, [zoomAt, panBy]);

	const hitAt = useCallback((clientX: number, clientY: number): Hit | null => {
		const canvas = canvasRef.current;
		if (!canvas) return null;
		const rect = canvas.getBoundingClientRect();
		const x = clientX - rect.left;
		const y = clientY - rect.top;
		const hits = hitsRef.current;
		// Last drawn wins (topmost).
		for (let i = hits.length - 1; i >= 0; i--) {
			const hit = hits[i];
			if (x >= hit.x && x <= hit.x + hit.w && y >= hit.y && y <= hit.y + hit.h) return hit;
		}
		return null;
	}, []);

	// Fixed positioning escapes the scroll frame's clipping; clamp to the window.
	const positionTooltip = useCallback(() => {
		const tooltip = tooltipRef.current;
		if (!tooltip) return;
		const { clientX, clientY } = pointerRef.current;
		const left = Math.min(clientX + 14, window.innerWidth - 320);
		const top = clientY + 16 > window.innerHeight - 140 ? clientY - 120 : clientY + 16;
		tooltip.style.transform = `translate(${left}px, ${top}px)`;
	}, []);

	const handlePointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
		event.currentTarget.setPointerCapture(event.pointerId);
		dragRef.current = { pointerId: event.pointerId, lastX: event.clientX, moved: false };
		event.currentTarget.focus();
	};

	const handlePointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
		const rect = event.currentTarget.getBoundingClientRect();
		hoverXRef.current = event.clientX - rect.left;
		const drag = dragRef.current;
		if (drag && drag.pointerId === event.pointerId) {
			const deltaX = event.clientX - drag.lastX;
			if (Math.abs(deltaX) > 0) {
				if (Math.abs(deltaX) > 2) drag.moved = true;
				drag.lastX = event.clientX;
				const span = viewportRef.current.u1 - viewportRef.current.u0;
				panBy((-deltaX / (canvasWidth || 1)) * span);
			}
			setHover(null);
			return;
		}
		pointerRef.current = { clientX: event.clientX, clientY: event.clientY };
		const hit = hitAt(event.clientX, event.clientY);
		if (sameTarget(hit, hoverRef.current)) positionTooltip();
		else setHover(hit);
	};

	const handlePointerUp = (event: React.PointerEvent<HTMLCanvasElement>) => {
		const drag = dragRef.current;
		dragRef.current = null;
		if (drag?.moved) return;
		const hit = hitAt(event.clientX, event.clientY);
		if (hit?.kind === "span") onSelect(hit.span.id);
		else onSelect(null);
	};

	const handleDoubleClick = (event: React.MouseEvent<HTMLCanvasElement>) => {
		const hit = hitAt(event.clientX, event.clientY);
		if (hit?.kind === "span") zoomToSpan(hit.span);
	};

	const selectSibling = useCallback(
		(direction: 1 | -1) => {
			const selectedId = selected?.span.id;
			if (!selectedId) return;
			for (const lane of layout.lanes) {
				const index = lane.spans.findIndex(span => span.id === selectedId);
				if (index === -1) continue;
				const next = lane.spans[index + direction];
				if (!next) return;
				onSelect(next.id);
				// Center offscreen selections.
				const u = scale.toU(next.start);
				if (u < viewport.u0 || u > viewport.u1) {
					const span = viewport.u1 - viewport.u0;
					onViewportChange(clampViewport(u - span / 2, u + span / 2));
				}
				return;
			}
		},
		[selected, layout, onSelect, scale, viewport, onViewportChange, clampViewport],
	);

	const handleKeyDown = (event: React.KeyboardEvent<HTMLCanvasElement>) => {
		const span = viewport.u1 - viewport.u0;
		switch (event.key) {
			case "w":
			case "W":
				zoomAt(1 / 1.3, hoverXRef.current);
				break;
			case "s":
			case "S":
				zoomAt(1.3, hoverXRef.current);
				break;
			case "a":
			case "A":
				panBy(-span * 0.2);
				break;
			case "d":
			case "D":
				panBy(span * 0.2);
				break;
			case "0":
				onViewportChange({ u0: scale.domain[0], u1: scale.domain[1] });
				break;
			case "f":
			case "F":
				if (selected) zoomToSpan(selected.span);
				break;
			case "Escape":
				onSelect(null);
				break;
			case ",":
				selectSibling(-1);
				break;
			case ".":
				selectSibling(1);
				break;
			default:
				return;
		}
		event.preventDefault();
	};

	// Focus the canvas on mount so keyboard navigation works immediately.
	useEffect(() => {
		canvasRef.current?.focus({ preventScroll: true });
	}, []);

	// Scene: everything except hover/selection, so pointer moves never repaint it.
	useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas) return;
		const raf = requestAnimationFrame(() => {
			hitsRef.current = drawScene(canvas, layout, laneAxes, scale, viewport, colors, canvasWidth, matchIds);
		});
		return () => cancelAnimationFrame(raf);
	}, [layout, laneAxes, scale, viewport, colors, canvasWidth, matchIds]);

	// Hover tint + selection outline are DOM boxes over the scene, so pointer
	// moves never repaint it and need no second full-size bitmap.
	const hoverBox = hover?.kind === "span" ? placeSpan(hover, layout, scale, viewport, canvasWidth) : null;
	const selectedBox = selected ? placeSpan(selected, layout, scale, viewport, canvasWidth) : null;

	// A new tooltip target mounts at the latest pointer position.
	useLayoutEffect(() => {
		if (hover) positionTooltip();
	}, [hover, positionTooltip]);

	const tooltip = hover ? renderTooltip(hover, traceStart, tooltipRef) : null;
	const pixelWidth = Math.floor(canvasWidth * devicePixelRatio);
	const pixelHeight = Math.floor(layout.totalHeight * devicePixelRatio);
	const cssSize = { width: canvasWidth, height: layout.totalHeight };

	return (
		<div ref={containerRef} className="traces-timeline">
			{/* Gutter: track/lane labels + collapse chevrons (DOM, not canvas). */}
			<div style={{ width: GUTTER_W, flexShrink: 0, position: "relative", height: layout.totalHeight }}>
				{layout.blocks.map(block => (
					<div key={block.track.id}>
						<div
							style={{
								position: "absolute",
								top: block.headerY,
								left: 4 + block.depth * 14,
								right: 8,
								height: HEADER_H,
								display: "flex",
								alignItems: "center",
								gap: 5,
								minWidth: 0,
							}}
						>
							{block.hasChildren ? (
								<button
									type="button"
									onClick={() => onToggleCollapse(block.track.id)}
									aria-label={
										collapsed.has(block.track.id)
											? `Expand ${block.track.label}`
											: `Collapse ${block.track.label}`
									}
									className="traces-chevron"
								>
									{collapsed.has(block.track.id) ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
								</button>
							) : (
								<span style={{ width: 12, flexShrink: 0 }} />
							)}
							<span className="traces-gutter-track truncate" style={{ minWidth: 0 }}>
								{block.track.label}
							</span>
							{block.track.model && (
								<span className="traces-gutter-model mono truncate" style={{ flexShrink: 1, minWidth: 0 }}>
									{block.track.model}
								</span>
							)}
						</div>
						{block.lanes.map(lane => (
							<div
								key={`${lane.track.id}:${lane.kind}`}
								className="traces-gutter-lane"
								style={{ top: lane.y, left: 20 + block.depth * 14, lineHeight: `${LANE_H}px` }}
							>
								{lane.label}
							</div>
						))}
					</div>
				))}
			</div>

			<div className="traces-canvas-stack" style={cssSize}>
				<canvas
					ref={canvasRef}
					className="traces-canvas"
					width={pixelWidth}
					height={pixelHeight}
					style={cssSize}
					tabIndex={0}
					role="application"
					aria-label="Trace timeline. W and S zoom, A and D pan, 0 fits all, F focuses the selection."
					onPointerDown={handlePointerDown}
					onPointerMove={handlePointerMove}
					onPointerUp={handlePointerUp}
					onPointerLeave={() => {
						hoverXRef.current = null;
						setHover(null);
					}}
					onDoubleClick={handleDoubleClick}
					onKeyDown={handleKeyDown}
				/>
				{hoverBox && hover?.kind === "span" && (
					<div
						className="traces-canvas-hover"
						aria-hidden="true"
						style={{
							left: hoverBox.x,
							top: hoverBox.y,
							width: hoverBox.w,
							height: LANE_H,
							borderRadius: SPAN_RADIUS,
							opacity: matchIds === null || matchIds.has(hover.span.id) ? 1 : DIM_ALPHA,
						}}
					/>
				)}
				{selectedBox && selected && (
					<div
						className="traces-canvas-selection"
						aria-hidden="true"
						style={{
							left: selectedBox.x - 1,
							top: selectedBox.y - 1,
							width: selectedBox.w + 2,
							height: LANE_H + 2,
							borderRadius: SPAN_RADIUS,
							borderColor: colors.selection,
							opacity: matchIds === null || matchIds.has(selected.span.id) ? 1 : DIM_ALPHA,
						}}
					/>
				)}
			</div>

			{tooltip && createPortal(tooltip, document.body)}
		</div>
	);
}

/** Rounded span rect, degrading to a plain rect for slivers. */
function spanPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
	ctx.beginPath();
	if (w >= SPAN_RADIUS * 2 + 1) ctx.roundRect(x, y, w, h, SPAN_RADIUS);
	else ctx.rect(x, y, w, h);
}

/** Paint the scene and return the hit-test boxes, topmost last. */
function drawScene(
	canvas: HTMLCanvasElement,
	layout: TimelineLayout,
	laneAxes: LaneAxis[],
	scale: TraceScale,
	viewport: TimelineViewport,
	colors: TraceTheme,
	width: number,
	matchIds: ReadonlySet<string> | null,
): Hit[] {
	const nextHits: Hit[] = [];
	const ctx = canvas.getContext("2d");
	if (!ctx) return nextHits;
	const height = layout.totalHeight;
	const dpr = devicePixelRatio;
	ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
	ctx.clearRect(0, 0, width, height);

	const { u0, u1 } = viewport;
	const uSpan = Math.max(u1 - u0, 1e-9);
	const toX = (u: number) => ((u - u0) / uSpan) * width;

	// Turn bands: alternating fill between turn boundaries per track.
	for (const block of layout.blocks) {
		const turnSpans = block.turnSpans;
		for (let i = 0; i < turnSpans.length; i++) {
			const bandStart = toX(scale.toU(turnSpans[i].start));
			const bandEnd = i + 1 < turnSpans.length ? toX(scale.toU(turnSpans[i + 1].start)) : width;
			if (bandEnd < 0 || bandStart > width) continue;
			if (i % 2 === 1) {
				ctx.fillStyle = colors.turnBand;
				ctx.fillRect(
					Math.max(0, bandStart),
					block.y0,
					Math.min(width, bandEnd) - Math.max(0, bandStart),
					block.y1 - block.y0,
				);
			}
			if (bandStart >= 0 && bandStart <= width) {
				ctx.strokeStyle = colors.grid;
				ctx.beginPath();
				ctx.moveTo(Math.round(bandStart) + 0.5, block.y0);
				ctx.lineTo(Math.round(bandStart) + 0.5, block.y1);
				ctx.stroke();
			}
		}
	}

	// Idle-gap bridges and the ruler share the mono label font.
	ctx.font = `9px ${colors.fontMono}`;
	for (const gap of scale.gaps) {
		const x = toX(gap.uMid);
		if (x < -24 || x > width + 24) continue;
		ctx.save();
		ctx.strokeStyle = colors.grid;
		ctx.setLineDash([2, 4]);
		ctx.beginPath();
		ctx.moveTo(x, RULER_H);
		ctx.lineTo(x, height);
		ctx.stroke();
		ctx.restore();
		ctx.fillStyle = colors.tick;
		ctx.textAlign = "center";
		ctx.fillText(`⋯ ${formatDurationMs(gap.t1 - gap.t0)}`, x, RULER_H - 4);
		ctx.textAlign = "left";
	}

	// Ruler: major ticks get a full-height gridline, minors stay in the ruler.
	for (const tick of buildTicks(scale, u0, u1, width)) {
		const x = Math.round(toX(tick.u)) + 0.5;
		ctx.strokeStyle = colors.grid;
		ctx.beginPath();
		if (tick.major) {
			ctx.moveTo(x, 4);
			ctx.lineTo(x, height);
		} else {
			ctx.moveTo(x, RULER_H - 8);
			ctx.lineTo(x, RULER_H);
		}
		ctx.stroke();
		ctx.fillStyle = colors.tick;
		if (tick.major) {
			ctx.fillText(tick.label, x + 4, 11);
		} else {
			ctx.globalAlpha = 0.75;
			ctx.fillText(tick.label, x + 3, RULER_H - 10);
			ctx.globalAlpha = 1;
		}
	}
	ctx.strokeStyle = colors.grid;
	ctx.beginPath();
	ctx.moveTo(0, RULER_H + 0.5);
	ctx.lineTo(width, RULER_H + 0.5);
	ctx.stroke();

	// Spans per lane. Labels are the only text from here on.
	ctx.font = `10px ${colors.fontSans}`;
	for (let laneIndex = 0; laneIndex < layout.lanes.length; laneIndex++) {
		const lane = layout.lanes[laneIndex];
		const { startU, endU, maxEndU } = laneAxes[laneIndex];
		const isTurnLane = lane.kind === "turn";
		for (let i = firstVisible(maxEndU, u0); i < lane.spans.length; i++) {
			const uStart = startU[i];
			if (uStart > u1) break; // spans sorted by start
			const uEnd = endU[i];
			if (uEnd < u0) continue;
			const span = lane.spans[i];
			const x = toX(uStart);
			const w = Math.max(MIN_SPAN_PX, toX(uEnd) - x);
			const y = lane.y;
			const alpha = matchIds === null || matchIds.has(span.id) ? 1 : DIM_ALPHA;
			const color = colors.category[span.kind];

			ctx.globalAlpha = alpha;
			if (isTurnLane) {
				// Turn ranges read as context, not work: soft fill + solid start cap.
				ctx.fillStyle = color;
				ctx.globalAlpha = alpha * 0.23;
				spanPath(ctx, x, y, w, LANE_H);
				ctx.fill();
				ctx.globalAlpha = alpha;
				ctx.fillStyle = color;
				ctx.fillRect(x, y, 2, LANE_H);
			} else {
				ctx.fillStyle = color;
				spanPath(ctx, x, y, w, LANE_H);
				ctx.fill();
			}
			if (span.isError) {
				ctx.fillStyle = colors.errorSoft;
				spanPath(ctx, x, y, w, LANE_H);
				ctx.fill();
				ctx.fillStyle = colors.error;
				ctx.fillRect(x, y, 2, LANE_H);
			}
			if (span.kind === "model" && typeof span.ttft === "number" && span.ttft > 0 && w > 20) {
				const ttftX = toX(scale.toU(span.start + span.ttft));
				if (ttftX > x + 1 && ttftX < x + w - 1) {
					ctx.fillStyle = "rgba(0,0,0,0.5)";
					ctx.fillRect(ttftX, y + 3, 1, LANE_H - 6);
				}
			}
			if (span.unterminated) {
				ctx.save();
				ctx.strokeStyle = colors.tick;
				ctx.setLineDash([2, 2]);
				ctx.beginPath();
				ctx.moveTo(x + w - 0.5, y);
				ctx.lineTo(x + w - 0.5, y + LANE_H);
				ctx.stroke();
				ctx.restore();
			}
			if (w > LABEL_MIN_PX) {
				ctx.save();
				ctx.beginPath();
				ctx.rect(x + 3, y, w - 6, LANE_H);
				ctx.clip();
				ctx.fillStyle = isTurnLane ? colors.tick : colors.spanText;
				ctx.fillText(span.label, x + 5, y + LANE_H - 5);
				ctx.restore();
			}
			ctx.globalAlpha = 1;

			const hitW = Math.max(w, HIT_SLOP_PX);
			nextHits.push({ kind: "span", x: x - (hitW - w) / 2, y, w: hitW, h: LANE_H, span, track: lane.track });
		}
	}

	// Markers: diamonds on track header rows.
	for (const block of layout.blocks) {
		for (const marker of block.track.markers) {
			const x = toX(scale.toU(marker.time));
			if (x < -6 || x > width + 6) continue;
			const cy = block.headerY + HEADER_H / 2;
			ctx.fillStyle = colors.marker;
			ctx.beginPath();
			ctx.moveTo(x, cy - 4);
			ctx.lineTo(x + 4, cy);
			ctx.lineTo(x, cy + 4);
			ctx.lineTo(x - 4, cy);
			ctx.closePath();
			ctx.fill();
			nextHits.push({ kind: "marker", x: x - 5, y: cy - 5, w: 10, h: 10, marker, track: block.track });
		}
	}

	return nextHits;
}

interface SpanBox {
	x: number;
	y: number;
	w: number;
}

/** Scene geometry of a drawn span, or null when it isn't on screen. */
function placeSpan(
	{ span, track }: { span: TraceSpan; track: TraceTrack },
	layout: TimelineLayout,
	scale: TraceScale,
	viewport: TimelineViewport,
	width: number,
): SpanBox | null {
	const { u0, u1 } = viewport;
	const uStart = scale.toU(span.start);
	const uEnd = scale.toU(span.end);
	if (uStart > u1 || uEnd < u0) return null;
	const lane = layout.lanes.find(candidate => candidate.track === track && candidate.kind === span.kind);
	if (!lane) return null;
	const uSpan = Math.max(u1 - u0, 1e-9);
	const x = ((uStart - u0) / uSpan) * width;
	const xEnd = ((uEnd - u0) / uSpan) * width;
	return { x, y: lane.y, w: Math.max(MIN_SPAN_PX, xEnd - x) };
}

function renderTooltip(hover: Hit, traceStart: number, ref: React.RefObject<HTMLDivElement | null>) {
	// Positioned by `transform` from the pointer handler (see positionTooltip).
	const style: React.CSSProperties = { left: 0, top: 0 };

	if (hover.kind === "marker") {
		const { marker } = hover;
		return (
			<div ref={ref} className="traces-tooltip" style={style}>
				<div className="traces-tooltip-title">{marker.label}</div>
				<div className="muted num">
					{new Date(marker.time).toLocaleTimeString()} ({formatOffset(marker.time - traceStart)})
				</div>
			</div>
		);
	}

	const { span } = hover;
	return (
		<div ref={ref} className="traces-tooltip" style={style}>
			<div className="traces-tooltip-title truncate">{span.label}</div>
			<div className="muted num">
				{formatDurationMs(span.end - span.start)} · {new Date(span.start).toLocaleTimeString()} (
				{formatOffset(span.start - traceStart)}){span.unterminated ? " · unterminated" : ""}
			</div>
			{span.kind === "model" && (
				<div className="muted num">
					{span.tokens !== undefined && <>{formatInteger(span.tokens)} tok</>}
					{span.cost !== undefined && <> · ${span.cost.toFixed(4)}</>}
					{span.ttft !== undefined && <> · TTFT {formatDurationMs(span.ttft)}</>}
					{span.isError && <> · error</>}
				</div>
			)}
			{span.kind === "subagent" && span.model && <div className="muted num">{span.model}</div>}
			{span.detail && <div className="traces-tooltip-detail">{span.detail}</div>}
		</div>
	);
}
