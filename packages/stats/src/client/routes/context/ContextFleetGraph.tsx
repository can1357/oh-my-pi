import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { formatCompact, formatCost } from "../../data/formatters";
import type { ContextAgentUsage, ContextTimeline } from "../../types";

interface Connector {
	trackId: string;
	path: string;
}

/** Flat-fan fleet graph: one anchored main node and a scrollable child lane. */
export function ContextFleetGraph({
	timeline,
	onOpenAgent,
}: {
	timeline: ContextTimeline;
	onOpenAgent: (agent: ContextAgentUsage) => void;
}) {
	const mainAgent = timeline.agents.find(agent => agent.trackId === "main");
	const ordered = useMemo(
		() =>
			timeline.agents
				.filter(agent => agent.trackId !== "main")
				.sort((a, b) => b.requests - a.requests || a.label.localeCompare(b.label)),
		[timeline.agents],
	);
	const canvasRef = useRef<HTMLDivElement | null>(null);
	const laneRef = useRef<HTMLDivElement | null>(null);
	const mainRef = useRef<HTMLDivElement | null>(null);
	const cards = useRef(new Map<string, HTMLButtonElement>());
	const [connectors, setConnectors] = useState<Connector[]>([]);
	const [hovered, setHovered] = useState<string | null>(null);
	const [laneClip, setLaneClip] = useState({ x: 0, y: 0, width: 0, height: 0 });

	useLayoutEffect(() => {
		const canvas = canvasRef.current;
		const lane = laneRef.current;
		const main = mainRef.current;
		if (!canvas || !lane || !main) return;
		let frame = 0;
		const measure = () => {
			frame = 0;
			const canvasRect = canvas.getBoundingClientRect();
			const laneRect = lane.getBoundingClientRect();
			const mainRect = main.getBoundingClientRect();
			if (!canvasRect.width || !mainRect.width || !laneRect.height) return;
			const mainX = mainRect.right - canvasRect.left;
			const mainY = mainRect.top - canvasRect.top + mainRect.height / 2;
			const next: Connector[] = [];
			for (const agent of ordered) {
				const card = cards.current.get(agent.trackId);
				if (!card) continue;
				const cardRect = card.getBoundingClientRect();
				if (!cardRect.width) continue;
				const visible = cardRect.bottom > laneRect.top && cardRect.top < laneRect.bottom;
				if (!visible) continue;
				const childX = cardRect.left - canvasRect.left;
				const childY = cardRect.top - canvasRect.top + cardRect.height / 2;
				const bend = Math.max(24, (childX - mainX) / 2);
				next.push({
					trackId: agent.trackId,
					path: `M ${mainX} ${mainY} C ${mainX + bend} ${mainY}, ${childX - bend} ${childY}, ${childX} ${childY}`,
				});
			}
			setConnectors(next);
			const clipLeft = Math.min(laneRect.left, mainRect.right) - canvasRect.left;
			setLaneClip({
				x: clipLeft,
				y: laneRect.top - canvasRect.top,
				width: laneRect.right - canvasRect.left - clipLeft,
				height: laneRect.height,
			});
		};
		const schedule = () => {
			if (frame) return;
			frame = requestAnimationFrame(measure);
		};
		measure();
		const observer = new ResizeObserver(schedule);
		observer.observe(canvas);
		observer.observe(lane);
		lane.addEventListener("scroll", schedule, { passive: true });
		window.addEventListener("resize", schedule);
		return () => {
			if (frame) cancelAnimationFrame(frame);
			observer.disconnect();
			lane.removeEventListener("scroll", schedule);
			window.removeEventListener("resize", schedule);
		};
	}, [ordered]);

	const requests = mainAgent?.requests ?? timeline.agents.reduce((total, agent) => total + agent.requests, 0);
	const peak = mainAgent?.peakTokens ?? timeline.agents.reduce((max, agent) => Math.max(max, agent.peakTokens), 0);
	const cost = mainAgent?.costTotal ?? timeline.agents.reduce((total, agent) => total + (agent.costTotal ?? 0), 0);
	const logicalEdges = ordered.map(agent => `main->${agent.trackId}`).join(",");
	return (
		<div className="context-fleet-graph-scroll">
			<div
				className="context-fleet-graph"
				role="group"
				aria-label="Fleet graph: one session and its child transcripts"
				data-testid="fleet-graph"
				data-logical-edges={logicalEdges}
			>
				<div className="context-fleet-canvas" ref={canvasRef}>
					<div
						className="context-fleet-main"
						ref={mainRef}
						data-testid="fleet-main"
						data-track-id={mainAgent?.trackId ?? "main"}
						aria-label={`Main session, ${mainAgent?.model ?? "unknown model"}, ${requests} requests`}
					>
						<span className="context-fleet-identity">
							<strong>{mainAgent?.label ?? "Session"}</strong>
							<span className="badge context-fleet-status" data-status="main">
								main
							</span>
						</span>
						<span className="context-fleet-values">
							<span>
								<small>req</small>
								{formatCompact(requests)}
							</span>
							<span>
								<small>peak</small>
								{formatCompact(peak)}
							</span>
							<span>
								<small>cost</small>
								{formatCost(cost)}
							</span>
						</span>
						{mainAgent?.model && <span className="context-fleet-model">{mainAgent.model}</span>}
					</div>
					<div className="context-fleet-lane" ref={laneRef} data-testid="fleet-lane">
						{ordered.map(agent => (
							<button
								type="button"
								className="context-fleet-node"
								key={agent.trackId}
								data-track-id={agent.trackId}
								data-status={agent.status}
								aria-label={`${agent.label}, ${agent.agent ?? "unknown agent"}, ${agent.model ?? "unknown model"}, ${agent.requests} requests, ${agent.lastTokens === undefined ? "unknown" : formatCompact(agent.lastTokens)} last tokens`}
								onClick={() => onOpenAgent(agent)}
								onMouseEnter={() => setHovered(agent.trackId)}
								onMouseLeave={() => setHovered(null)}
								ref={element => {
									if (element) cards.current.set(agent.trackId, element);
									else cards.current.delete(agent.trackId);
								}}
							>
								<span className="context-fleet-identity">
									<strong className="truncate">{agent.label}</strong>
									<span className="context-fleet-agent">{agent.agent ?? "-"}</span>
									<span className="badge context-fleet-status" data-status={agent.status}>
										{agent.status}
									</span>
								</span>
								<span className="context-fleet-values">
									<span>
										<small>req</small>
										{formatCompact(agent.requests)}
									</span>
									<span>
										<small>peak</small>
										{formatCompact(agent.peakTokens)}
									</span>
									<span>
										<small>cost</small>
										{agent.costTotal === undefined ? "-" : formatCost(agent.costTotal)}
									</span>
								</span>
								<span className="context-fleet-model">{agent.model ?? "-"}</span>
							</button>
						))}
						{ordered.length === 0 && <p className="dim context-fleet-empty">No child transcripts recorded.</p>}
					</div>
					<svg className="context-fleet-edges" aria-hidden="true">
						<defs>
							<clipPath id="context-fleet-lane-clip">
								<rect x={laneClip.x} y={laneClip.y} width={laneClip.width} height={laneClip.height} />
							</clipPath>
						</defs>
						<g clipPath="url(#context-fleet-lane-clip)">
							{connectors.map(connector => (
								<path
									key={connector.trackId}
									data-edge-for={connector.trackId}
									className="context-fleet-edge"
									data-hovered={hovered === connector.trackId}
									data-status={ordered.find(agent => agent.trackId === connector.trackId)?.status}
									d={connector.path}
								/>
							))}
						</g>
					</svg>
				</div>
			</div>
		</div>
	);
}
