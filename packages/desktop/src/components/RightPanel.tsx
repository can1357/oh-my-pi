import type { RpcBridge } from "../rpc/bridge";
import type { TodoPhase } from "../rpc/protocol";
import { AgentsPanel } from "./AgentsPanel";
import { DiffPanel } from "./DiffPanel";
import { FileTree } from "./FileTree";
import { openTaskCount, TodoPanel } from "./TodoPanel";

export type PanelTab = "changes" | "files" | "todos" | "agents";

const TABS: Array<{ id: PanelTab; label: string }> = [
	{ id: "changes", label: "Changes" },
	{ id: "files", label: "Files" },
	// "Tasks", not "Plan": omp's plan *mode* is a different thing, and one window
	// cannot have the word mean both.
	{ id: "todos", label: "Tasks" },
	{ id: "agents", label: "Agents" },
];

export function RightPanel({
	bridge,
	ready,
	streaming,
	todoPhases,
	subagentCount,
	tab,
	onTab,
}: {
	bridge: RpcBridge;
	ready: boolean;
	/** Lets the diff re-read itself when the agent stops changing files. */
	streaming: boolean;
	todoPhases: readonly TodoPhase[];
	subagentCount: number;
	/*
	 * Controlled from the route, so the plan strip above the composer can bring
	 * this panel to the Plan tab. A tab that only the panel can change is fine
	 * until something outside it needs to point at one.
	 */
	tab: PanelTab;
	onTab(tab: PanelTab): void;
}) {
	return (
		<aside className="omp-panel">
			<div className="omp-panel__tabs" role="tablist">
				{TABS.map(entry => (
					<button
						className="omp-panel__tab"
						key={entry.id}
						type="button"
						role="tab"
						aria-selected={tab === entry.id}
						onClick={() => onTab(entry.id)}
					>
						{entry.label}
						{/* A count is context, not part of the name — it gets its own weight. */}
						{/* Open tasks, not phases: ten headings say nothing, three left does. */}
						{entry.id === "todos" && openTaskCount(todoPhases) > 0 ? (
							<span className="omp-panel__count">{openTaskCount(todoPhases)}</span>
						) : null}
						{entry.id === "agents" && subagentCount > 0 ? (
							<span className="omp-panel__count">{subagentCount}</span>
						) : null}
					</button>
				))}
			</div>

			<div className="omp-panel__body" role="tabpanel">
				{/*
				 * Panels stay mounted across tab switches only where remounting is
				 * cheap. Diff and tree each cost a shell round trip, so they unmount
				 * — the data is re-fetched on demand rather than kept warm.
				 */}
				{tab === "changes" ? <DiffPanel bridge={bridge} ready={ready} streaming={streaming} /> : null}
				{tab === "files" ? <FileTree bridge={bridge} ready={ready} /> : null}
				{tab === "todos" ? <TodoPanel phases={todoPhases} /> : null}
				{tab === "agents" ? <AgentsPanel bridge={bridge} /> : null}
			</div>
		</aside>
	);
}
