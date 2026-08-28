import { memo } from "react";
import type { TodoPhase } from "../rpc/protocol";
import { phaseLabel, planSummary } from "../rpc/todo";

/**
 * One line of plan, always in view.
 *
 * The panel holds the detail, but the panel is one of four tabs and the plan is
 * the thing you most want to not forget while reading a diff. The terminal
 * keeps the same summary pinned above its prompt for the same reason.
 *
 * Clicking it points the side panel at the Plan tab, opening the panel if it
 * was hidden — otherwise the click would appear to do nothing.
 */
export const PlanStrip = memo(function PlanStrip({ phases, onOpen }: { phases: readonly TodoPhase[]; onOpen(): void }) {
	if (phases.length === 0) return null;

	const summary = planSummary(phases);
	if (summary.total === 0) return null;

	const label = summary.activePhase
		? phaseLabel(summary.activePhase.name, summary.activeIndex + 1, phases.length > 1)
		: "Plan";

	return (
		<button className="omp-plan-strip" type="button" onClick={onOpen} title="Show the plan">
			<span className="omp-plan-strip__phase">{label}</span>
			<span className="omp-plan-strip__count">
				{summary.done}/{summary.total}
			</span>
			{summary.activeTask ? <span className="omp-plan-strip__task">{summary.activeTask.content}</span> : null}
			{/* Blocked work is the one state that will not resolve on its own. */}
			{summary.blocked > 0 ? <span className="omp-plan-strip__blocked">{summary.blocked} blocked</span> : null}
		</button>
	);
});
