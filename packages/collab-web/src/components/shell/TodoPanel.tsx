import type { ReactNode } from "react";
import type { TodoPhase } from "../../lib/client";
import { Board } from "../../tool-render/tools/todo";

export interface TodoPanelProps {
	phases: readonly TodoPhase[];
}

/** Count tasks the host still has open (pending / in_progress / blocked). */
function openCount(phases: readonly TodoPhase[]): number {
	let open = 0;
	for (const phase of phases) {
		for (const task of phase.tasks) {
			if (task.status !== "completed" && task.status !== "abandoned") open++;
		}
	}
	return open;
}

/**
 * Live todo board mirrored from the host's `todo_updated` broadcast. It is the
 * guest's only representation of eval-bridged todo mutations, whose persisted
 * `user_todo_edit` entry is not among the replicated session-entry types.
 */
export function TodoPanel({ phases }: TodoPanelProps): ReactNode {
	if (phases.length === 0) return null;
	const total = phases.reduce((sum, phase) => sum + phase.tasks.length, 0);
	if (total === 0) return null;
	const open = openCount(phases);

	return (
		<details className="sh-todo" open>
			<summary className="sh-todo-summary">
				todos · {total - open}/{total} done
			</summary>
			<div className="sh-todo-body">
				<Board phases={phases as unknown[]} />
			</div>
		</details>
	);
}
