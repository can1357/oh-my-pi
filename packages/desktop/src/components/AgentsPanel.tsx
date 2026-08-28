import { useEffect, useState, useSyncExternalStore } from "react";
import type { RpcBridge } from "../rpc/bridge";
import type { SubagentSnapshot } from "../rpc/protocol";

/**
 * Live roster of `task` subagents.
 *
 * Written against the RPC shapes rather than reusing collab-web's `AgentsPanel`,
 * which takes pi-wire's `AgentSnapshot` — a different shape with a different
 * status enum and two companion maps. Adapting three shapes without being able
 * to verify them against a live fan-out would have been guesswork; the RPC
 * `progress` payload already carries current tool, recent tools and output, so
 * reading it directly is both smaller and checkable.
 */
export function AgentsPanel({ bridge }: { bridge: RpcBridge }) {
	const snapshot = useSyncExternalStore(bridge.subscribe, bridge.getSnapshot, bridge.getSnapshot);
	const [selected, setSelected] = useState<string | null>(null);

	// The roster arrives on `subagent_*` frames, but a tab opened mid-run needs a
	// starting point.
	useEffect(() => {
		void bridge.getSubagents().catch(() => {});
	}, [bridge]);

	const agents = snapshot.subagents;

	if (agents.length === 0) {
		return <div className="omp-empty">No subagents. The task tool spawns them.</div>;
	}

	return (
		<div className="omp-agents">
			{agents.map(agent => (
				<AgentRow
					key={agent.id}
					agent={agent}
					expanded={selected === agent.id}
					onToggle={() => setSelected(selected === agent.id ? null : agent.id)}
				/>
			))}
		</div>
	);
}

function AgentRow({ agent, expanded, onToggle }: { agent: SubagentSnapshot; expanded: boolean; onToggle(): void }) {
	const progress = agent.progress;
	const label = agent.description || agent.task || agent.agent;

	return (
		<div className="omp-agent" data-status={agent.status}>
			<button className="omp-agent__head" type="button" onClick={onToggle}>
				<span className={`omp-dot omp-dot--${dotStatus(agent.status)}`} aria-label={agent.status} />
				<span className="omp-agent__name">{agent.agent}</span>
				<span className="omp-agent__status">{agent.status}</span>
			</button>

			<div className="omp-agent__task" title={label}>
				{label}
			</div>

			{progress?.currentTool ? (
				<div className="omp-agent__tool">
					<span className="omp-agent__tool-name">{progress.currentTool}</span>
					{progress.currentToolArgs ? (
						<span className="omp-agent__tool-args">{progress.currentToolArgs}</span>
					) : null}
				</div>
			) : null}

			{progress?.lastIntent && !progress.currentTool ? (
				<div className="omp-agent__tool">{progress.lastIntent}</div>
			) : null}

			{expanded && progress ? (
				<div className="omp-agent__detail">
					<div className="omp-agent__counts">
						{progress.toolCount ?? 0} tools · {progress.requests ?? 0} requests
					</div>
					{(progress.recentTools ?? []).slice(-6).map((entry, index) => (
						<div className="omp-agent__recent" key={`${entry.tool}:${entry.endMs}:${index}`}>
							<span className="omp-agent__tool-name">{entry.tool}</span>
							<span className="omp-agent__tool-args">{entry.args}</span>
						</div>
					))}
					{(progress.recentOutput ?? []).length > 0 ? (
						<pre className="omp-agent__output">{(progress.recentOutput ?? []).slice(-8).join("\n")}</pre>
					) : null}
				</div>
			) : null}
		</div>
	);
}

/**
 * Map onto the sidebar's four dot states.
 *
 * It used to emit `pending`/`complete`/`error`/`aborted` against a
 * `.omp-status-dot` class the terminal restyle deleted, so every subagent row
 * rendered an unstyled empty span — zero pixels, no indicator at all.
 */
function dotStatus(status: SubagentSnapshot["status"]): string {
	switch (status) {
		case "running":
			return "working";
		case "completed":
			return "done";
		case "failed":
			return "attention";
		default:
			return "idle";
	}
}
