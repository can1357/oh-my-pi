/**
 * Timeline overview strip: per-category density over the full virtual domain
 * plus a draggable/resizable viewport brush, mirroring DevTools' overview.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { TraceSpanKind, TraceTrack } from "../types";
import { useSystemTheme } from "../useSystemTheme";
import type { TimelineViewport } from "./TimelineCanvas";
import type { TraceScale } from "./time-scale";
import { TRACE_THEMES } from "./trace-colors";

export interface MinimapProps {
	tracks: TraceTrack[];
	scale: TraceScale;
	viewport: TimelineViewport;
	onViewportChange: (viewport: TimelineViewport) => void;
}

const HEIGHT = 44;
const STRIP_KINDS: TraceSpanKind[] = ["turn", "model", "tool", "subagent"];
const EDGE_PX = 6;
const MIN_WINDOW_U = 10;

type DragMode = "move" | "left" | "right" | "create";

export function Minimap({ tracks, scale, viewport, onViewportChange }: MinimapProps) {
	const theme = useSystemTheme();
	const colors = TRACE_THEMES[theme];
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const [width, setWidth] = useState(800);
	const dragRef = useRef<{ mode: DragMode; startX: number; startViewport: TimelineViewport } | null>(null);

	useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas) return;
		const observer = new ResizeObserver(entries => {
			setWidth(Math.max(100, Math.floor(entries[0].contentRect.width)));
		});
		observer.observe(canvas);
		return () => observer.disconnect();
	}, []);

	const [d0, d1] = scale.domain;
	const dSpan = Math.max(d1 - d0, 1e-9);
	const toX = useCallback((u: number) => ((u - d0) / dSpan) * width, [d0, dSpan, width]);
	const toU = useCallback((x: number) => d0 + (x / Math.max(width, 1)) * dSpan, [d0, dSpan, width]);

	useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas) return;
		const ctx = canvas.getContext("2d");
		if (!ctx) return;
		const dpr = devicePixelRatio;
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.clearRect(0, 0, width, HEIGHT);

		// Density strips: bucket span coverage per pixel per category.
		const stripH = HEIGHT / STRIP_KINDS.length;
		for (let k = 0; k < STRIP_KINDS.length; k++) {
			const kind = STRIP_KINDS[k];
			const buckets = new Float32Array(width);
			for (const track of tracks) {
				for (const span of track.spans) {
					if (span.kind !== kind) continue;
					const x0 = Math.max(0, Math.floor(toX(scale.toU(span.start))));
					const x1 = Math.min(width - 1, Math.ceil(toX(scale.toU(span.end))));
					for (let x = x0; x <= x1; x++) buckets[x] = Math.min(1, buckets[x] + 0.34);
				}
			}
			ctx.fillStyle = colors.category[kind];
			for (let x = 0; x < width; x++) {
				if (buckets[x] <= 0) continue;
				ctx.globalAlpha = 0.25 + buckets[x] * 0.75;
				ctx.fillRect(x, k * stripH + 1, 1, stripH - 2);
			}
			ctx.globalAlpha = 1;
		}

		// Viewport brush.
		const vx0 = toX(viewport.u0);
		const vx1 = toX(viewport.u1);
		ctx.fillStyle = theme === "dark" ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.06)";
		ctx.fillRect(vx0, 0, vx1 - vx0, HEIGHT);
		ctx.strokeStyle = colors.selection;
		ctx.strokeRect(vx0 + 0.5, 0.5, vx1 - vx0 - 1, HEIGHT - 1);
		ctx.fillStyle = colors.selection;
		ctx.fillRect(vx0, 0, 2, HEIGHT);
		ctx.fillRect(vx1 - 2, 0, 2, HEIGHT);
	}, [tracks, scale, viewport, colors, theme, width, toX]);

	const handlePointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
		const rect = event.currentTarget.getBoundingClientRect();
		const x = event.clientX - rect.left;
		const vx0 = toX(viewport.u0);
		const vx1 = toX(viewport.u1);
		let mode: DragMode;
		if (Math.abs(x - vx0) <= EDGE_PX) mode = "left";
		else if (Math.abs(x - vx1) <= EDGE_PX) mode = "right";
		else if (x > vx0 && x < vx1) mode = "move";
		else {
			mode = "create";
			const u = toU(x);
			onViewportChange(clamp({ u0: u, u1: u + MIN_WINDOW_U }, d0, d1));
		}
		dragRef.current = { mode, startX: x, startViewport: viewport };
		event.currentTarget.setPointerCapture(event.pointerId);
	};

	const handlePointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
		const drag = dragRef.current;
		if (!drag) return;
		const rect = event.currentTarget.getBoundingClientRect();
		const x = event.clientX - rect.left;
		const deltaU = toU(x) - toU(drag.startX);
		const { u0, u1 } = drag.startViewport;
		if (drag.mode === "move") {
			onViewportChange(clamp({ u0: u0 + deltaU, u1: u1 + deltaU }, d0, d1));
		} else if (drag.mode === "left") {
			onViewportChange(clamp({ u0: Math.min(u0 + deltaU, u1 - MIN_WINDOW_U), u1 }, d0, d1));
		} else if (drag.mode === "right") {
			onViewportChange(clamp({ u0, u1: Math.max(u1 + deltaU, u0 + MIN_WINDOW_U) }, d0, d1));
		} else {
			const anchor = toU(drag.startX);
			const current = toU(x);
			onViewportChange(
				clamp(
					{
						u0: Math.min(anchor, current),
						u1: Math.max(anchor, current, Math.min(anchor, current) + MIN_WINDOW_U),
					},
					d0,
					d1,
				),
			);
		}
	};

	const handlePointerUp = () => {
		dragRef.current = null;
	};

	return (
		<canvas
			ref={canvasRef}
			width={Math.floor(width * devicePixelRatio)}
			height={Math.floor(HEIGHT * devicePixelRatio)}
			style={{
				width: "100%",
				height: HEIGHT,
				display: "block",
				cursor: "crosshair",
				borderRadius: 4,
				border: "1px solid var(--border)",
				touchAction: "none",
			}}
			role="slider"
			aria-label="Timeline overview brush"
			aria-valuemin={0}
			aria-valuemax={100}
			aria-valuenow={Math.round(((viewport.u0 - d0) / dSpan) * 100)}
			tabIndex={-1}
			onPointerDown={handlePointerDown}
			onPointerMove={handlePointerMove}
			onPointerUp={handlePointerUp}
		/>
	);
}

function clamp(viewport: TimelineViewport, d0: number, d1: number): TimelineViewport {
	let span = Math.max(MIN_WINDOW_U, viewport.u1 - viewport.u0);
	span = Math.min(span, d1 - d0 || MIN_WINDOW_U);
	let start = viewport.u0;
	if (start < d0) start = d0;
	if (start + span > d1) start = d1 - span;
	return { u0: start, u1: start + span };
}
