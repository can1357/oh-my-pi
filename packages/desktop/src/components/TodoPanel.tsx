import { memo } from "react";
import type { TodoItem, TodoPhase } from "../rpc/protocol";
import { activePhaseIndex, isOpen, phaseLabel, phaseProgress } from "../rpc/todo";

/**
 * The agent's plan.
 *
 * Read-only on purpose: the plan has one author. `set_todos` exists on the
 * protocol, but it writes the tracker without appending the session entry the
 * terminal's own `/todo` path does, so an edit made here would not survive a
 * rehydrate and the agent would never be told about it.
 *
 * The active phase is open and the rest collapse to their heading, which is how
 * the terminal handles a plan too long for the space it has.
 */
export const TodoPanel = memo(function TodoPanel({ phases }: { phases: readonly TodoPhase[] }) {
	if (phases.length === 0) {
		return <div className="omp-empty">No plan yet. The agent adds one with the todo tool.</div>;
	}

	const active = activePhaseIndex(phases);
	const multi = phases.length > 1;

	return (
		<div className="omp-todo">
			{phases.map((phase, index) => {
				const { done, total } = phaseProgress(phase);
				const label = phaseLabel(phase.name, index + 1, multi);
				const isActive = index === active;

				const heading = (
					<>
						<span className="omp-todo__name">{label}</span>
						<span className="omp-todo__count">
							{done}/{total}
						</span>
					</>
				);

				/*
				 * `<details>` rather than a click handler: the open/closed state is
				 * per phase and the browser already owns it, so collapsing one does
				 * not need a piece of React state that has to survive re-renders of
				 * a panel that repaints on every tool call.
				 */
				return (
					<section className="omp-todo__phase" data-active={isActive || undefined} key={phase.name}>
						<details open={isActive}>
							<summary className="omp-todo__title">{heading}</summary>
							<ul className="omp-todo__list">
								{phase.tasks.map(task => (
									<Task task={task} key={task.content} />
								))}
							</ul>
						</details>
					</section>
				);
			})}
		</div>
	);
});

function Task({ task }: { task: TodoItem }) {
	return (
		<li className="omp-todo__item" data-status={task.status}>
			<span className="omp-todo__mark" aria-hidden="true">
				{task.status === "completed" ? "☑" : "☐"}
			</span>
			<span className="omp-todo__text">
				{task.content}
				{/*
				 * The terminal's plan strip prints a bare "(blocked)" and drops the
				 * reason. It is the one thing worth knowing about a stopped task, and
				 * a panel has the room the status line does not.
				 */}
				{task.blocker ? <span className="omp-todo__blocker">{task.blocker}</span> : null}
			</span>
		</li>
	);
}

/** Open tasks — what is left, which is what a badge on a plan should say. */
export function openTaskCount(phases: readonly TodoPhase[]): number {
	return phases.reduce((sum, phase) => sum + phase.tasks.filter(isOpen).length, 0);
}
