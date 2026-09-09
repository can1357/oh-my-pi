/**
 * The trace flamegraph: one DPR-scaled canvas with a DOM gutter (track/lane
 * labels, collapse chevrons) and a DOM tooltip. Implements the Chrome
 * DevTools interaction contract: cursor-anchored wheel zoom, drag pan, WASD,
 * fit/focus keys, hover tooltips, click-to-select, double-click-to-zoom.
 */

import { ChevronDown, ChevronRight } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatDurationMs } from "../data/formatters";
import type { TraceMarker, TraceSpan, TraceSpanKind, TraceTrack } from "../types";
import { useSystemTheme } from "../useSystemTheme";
import { buildTicks, formatOffset, type TraceScale } from "./time-scale";
import { TRACE_THEMES, type TraceTheme } from "./trace-colors";

export interface TimelineViewport {
	u0: number;
	u1: number;
}

export interface TimelineCanvasProps {
	tracks: TraceTrack[];
	scale: TraceScale;
	viewport: TimelineViewport;
	onViewportChange: (viewport: TimelineViewport) => void;
	selection: string | null;
	onSelect: (spanId: string | null) => void;
	search: string;
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
		const block: TrackBlock = {
			track,
			depth,
			hasChildren: hasChildren.has(track.id),
			headerY: y,
			lanes: [],
			y0: y,
			y1: y,
		};
		y += HEADER_H;
		for (const { kind, label } of LANE_ORDER) {
			const spans = track.spans.filter(span => span.kind === kind);
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

interface HoverState {
	hit: Hit;
	clientX: number;
	clientY: number;
}

export function TimelineCanvas({
	tracks,
	scale,
	viewport,
	onViewportChange,
	selection,
	onSelect,
	search,
	collapsed,
	onToggleCollapse,
	traceStart,
}: TimelineCanvasProps) {
	const theme = useSystemTheme();
	const colors = TRACE_THEMES[theme];
	const containerRef = useRef<HTMLDivElement>(null);
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const [canvasWidth, setCanvasWidth] = useState(800);
	const [hover, setHover] = useState<HoverState | null>(null);
	const hitsRef = useRef<Hit[]>([]);
	const dragRef = useRef<{ pointerId: number; lastX: number; moved: boolean } | null>(null);
	const hoverXRef = useRef<number | null>(null);
	// Authoritative viewport for input handlers: wheel/drag events fire faster
	// than React re-renders, and computing each step from the stale `viewport`
	// prop would drop deltas within a frame (sluggish, jumpy zoom).
	const viewportRef = useRef(viewport);
	viewportRef.current = viewport;

	const layout = useMemo(() => buildLayout(tracks, collapsed), [tracks, collapsed]);

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
		const hit = hitAt(event.clientX, event.clientY);
		setHover(hit ? { hit, clientX: event.clientX, clientY: event.clientY } : null);
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
			if (!selection) return;
			for (const lane of layout.lanes) {
				const index = lane.spans.findIndex(span => span.id === selection);
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
		[selection, layout, onSelect, scale, viewport, onViewportChange, clampViewport],
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
			case "F": {
				if (!selection) break;
				const selected = tracks.flatMap(track => track.spans).find(s => s.id === selection);
				if (selected) zoomToSpan(selected);
				break;
			}
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

	// Draw.
	useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas) return;
		const raf = requestAnimationFrame(() => {
			draw(canvas, layout, scale, viewport, colors, {
				width: canvasWidth,
				selection,
				hoverId: hover?.hit.kind === "span" ? hover.hit.span.id : null,
				search,
				hits: hitsRef,
			});
		});
		return () => cancelAnimationFrame(raf);
	}, [layout, scale, viewport, colors, canvasWidth, selection, hover, search]);

	const tooltip = hover ? renderTooltip(hover, traceStart) : null;

	return (
		<div ref={containerRef} className="stats-trace-timeline">
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
									className="stats-trace-chevron"
								>
									{collapsed.has(block.track.id) ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
								</button>
							) : (
								<span style={{ width: 12, flexShrink: 0 }} />
							)}
							<span className="stats-trace-gutter-track truncate" style={{ minWidth: 0 }}>
								{block.track.label}
							</span>
							{block.track.model && (
								<span className="stats-trace-gutter-model truncate" style={{ flexShrink: 1, minWidth: 0 }}>
									{block.track.model}
								</span>
							)}
						</div>
						{block.lanes.map(lane => (
							<div
								key={`${lane.track.id}:${lane.kind}`}
								className="stats-trace-gutter-lane"
								style={{ top: lane.y, left: 20 + block.depth * 14, lineHeight: `${LANE_H}px` }}
							>
								{lane.label}
							</div>
						))}
					</div>
				))}
			</div>

			<canvas
				ref={canvasRef}
				className="stats-trace-canvas"
				width={Math.floor(canvasWidth * devicePixelRatio)}
				height={Math.floor(layout.totalHeight * devicePixelRatio)}
				style={{ width: canvasWidth, height: layout.totalHeight }}
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

			{tooltip}
		</div>
	);
}

interface DrawOptions {
	width: number;
	selection: string | null;
	hoverId: string | null;
	search: string;
	hits: React.MutableRefObject<Hit[]>;
}

/** Rounded span rect, degrading to a plain rect for slivers. */
function spanPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
	ctx.beginPath();
	if (w >= SPAN_RADIUS * 2 + 1) ctx.roundRect(x, y, w, h, SPAN_RADIUS);
	else ctx.rect(x, y, w, h);
}

function draw(
	canvas: HTMLCanvasElement,
	layout: TimelineLayout,
	scale: TraceScale,
	viewport: TimelineViewport,
	colors: TraceTheme,
	options: DrawOptions,
): void {
	const ctx = canvas.getContext("2d");
	if (!ctx) return;
	const { width, selection, hoverId, search, hits } = options;
	const height = layout.totalHeight;
	const dpr = devicePixelRatio;
	ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
	ctx.clearRect(0, 0, width, height);

	const { u0, u1 } = viewport;
	const uSpan = Math.max(u1 - u0, 1e-9);
	const toX = (u: number) => ((u - u0) / uSpan) * width;
	const needle = search.trim().toLowerCase();
	const nextHits: Hit[] = [];

	// Turn bands: alternating fill between turn boundaries per track.
	for (const block of layout.blocks) {
		const turnSpans = block.track.spans.filter(span => span.kind === "turn");
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

	// Idle-gap bridges.
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
		ctx.font = "9px system-ui, sans-serif";
		ctx.textAlign = "center";
		ctx.fillText(`⋯ ${formatDurationMs(gap.t1 - gap.t0)}`, x, RULER_H - 4);
		ctx.textAlign = "left";
	}

	// Ruler: major ticks get a full-height gridline, minors stay in the ruler.
	ctx.font = "9px system-ui, sans-serif";
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

	// Spans per lane.
	for (const lane of layout.lanes) {
		const isTurnLane = lane.kind === "turn";
		for (const span of lane.spans) {
			const uStart = scale.toU(span.start);
			if (uStart > u1) break; // spans sorted by start
			const uEnd = scale.toU(span.end);
			if (uEnd < u0) continue;
			const x = toX(uStart);
			const w = Math.max(MIN_SPAN_PX, toX(uEnd) - x);
			const y = lane.y;
			const matches = needle === "" || `${span.label} ${span.detail ?? ""}`.toLowerCase().includes(needle);
			const color = colors.category[span.kind];

			ctx.globalAlpha = matches ? 1 : 0.3;
			if (isTurnLane) {
				// Turn ranges read as context, not work: soft fill + solid start cap.
				ctx.fillStyle = `${color}3a`;
				spanPath(ctx, x, y, w, LANE_H);
				ctx.fill();
				ctx.fillStyle = color;
				ctx.fillRect(x, y, 2, LANE_H);
			} else {
				ctx.fillStyle = color;
				spanPath(ctx, x, y, w, LANE_H);
				ctx.fill();
			}
			if (span.isError) {
				ctx.fillStyle = `${colors.error}55`;
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
			if (hoverId === span.id) {
				ctx.fillStyle = "rgba(255,255,255,0.16)";
				spanPath(ctx, x, y, w, LANE_H);
				ctx.fill();
			}
			if (selection === span.id) {
				ctx.strokeStyle = colors.selection;
				ctx.lineWidth = 1.5;
				spanPath(ctx, x - 1, y - 1, w + 2, LANE_H + 2);
				ctx.stroke();
				ctx.lineWidth = 1;
			}
			if (w > LABEL_MIN_PX) {
				ctx.save();
				ctx.beginPath();
				ctx.rect(x + 3, y, w - 6, LANE_H);
				ctx.clip();
				ctx.fillStyle = isTurnLane ? colors.tick : colors.spanText;
				ctx.font = "10px system-ui, sans-serif";
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

	hits.current = nextHits;
}

function renderTooltip(hover: HoverState, traceStart: number) {
	// Fixed positioning escapes the scroll frame's clipping; clamp to the window.
	const left = Math.min(hover.clientX + 14, window.innerWidth - 320);
	const top = hover.clientY + 16 > window.innerHeight - 140 ? hover.clientY - 120 : hover.clientY + 16;
	const style: React.CSSProperties = {
		position: "fixed",
		left,
		top,
		zIndex: 60,
		maxWidth: 300,
		pointerEvents: "none",
		background: "var(--surface-2)",
		border: "1px solid var(--border-strong)",
		borderRadius: 6,
		padding: "7px 10px",
		fontSize: 11,
		lineHeight: 1.5,
		boxShadow: "0 1px 2px rgba(0,0,0,0.2), 0 4px 16px rgba(0,0,0,0.25)",
	};

	if (hover.hit.kind === "marker") {
		const { marker } = hover.hit;
		return (
			<div style={style}>
				<div className="stats-font-medium stats-text-primary">{marker.label}</div>
				<div className="stats-text-muted">
					{new Date(marker.time).toLocaleTimeString()} ({formatOffset(marker.time - traceStart)})
				</div>
			</div>
		);
	}

	const { span } = hover.hit;
	return (
		<div style={style}>
			<div className="stats-font-medium stats-text-primary truncate">{span.label}</div>
			<div className="stats-text-muted">
				{formatDurationMs(span.end - span.start)} · {new Date(span.start).toLocaleTimeString()} (
				{formatOffset(span.start - traceStart)}){span.unterminated ? " · unterminated" : ""}
			</div>
			{span.kind === "model" && (
				<div className="stats-text-muted">
					{span.tokens !== undefined && <>{span.tokens.toLocaleString()} tok</>}
					{span.cost !== undefined && <> · ${span.cost.toFixed(4)}</>}
					{span.ttft !== undefined && <> · TTFT {formatDurationMs(span.ttft)}</>}
					{span.isError && <> · error</>}
				</div>
			)}
			{span.kind === "subagent" && span.model && <div className="stats-text-muted">{span.model}</div>}
			{span.detail && (
				<div className="stats-text-secondary" style={{ wordBreak: "break-word" }}>
					{span.detail}
				</div>
			)}
		</div>
	);
}
