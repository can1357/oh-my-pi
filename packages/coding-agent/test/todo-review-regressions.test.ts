import { expect, it } from "bun:test";
import {
	collectIncompleteTodoRows,
	formatIncompleteTodosSection,
	parseIncompleteTodosFromSummary,
} from "../src/session/incomplete-todos";
import { applyOpsToPhases, applyUserMarkdownPhases, type TodoPhase } from "../src/tools/todo";

it("lets a model finish a reintroduced drop without leaving an unreachable sibling", () => {
	const prior: TodoPhase[] = [{ name: "Work", tasks: [{ content: "ship", status: "abandoned" }] }];
	const initialized = applyOpsToPhases(prior, [{ op: "init", list: [{ phase: "Work", items: ["ship"] }] }]);
	const completed = applyOpsToPhases(initialized.phases, [{ op: "done", task: "ship" }]);
	expect(completed.errors).toEqual([]);
	expect(completed.phases[0]?.tasks).toEqual([{ content: "ship", status: "completed" }]);
});

it("moves a reintroduced model drop without retaining a stranded old-phase duplicate", () => {
	const prior: TodoPhase[] = [{ name: "Old", tasks: [{ content: "ship", status: "abandoned" }] }];
	const initialized = applyOpsToPhases(prior, [{ op: "init", list: [{ phase: "New", items: ["ship"] }] }]);

	expect(initialized.errors).toEqual([]);
	expect(initialized.phases).toEqual([{ name: "New", tasks: [{ content: "ship", status: "in_progress" }] }]);

	const completed = applyOpsToPhases(initialized.phases, [{ op: "done", task: "ship" }]);
	expect(completed.errors).toEqual([]);
	expect(completed.phases).toEqual([{ name: "New", tasks: [{ content: "ship", status: "completed" }] }]);
});

it("keeps a newly inserted cancellation user-authored before an unchanged model drop", () => {
	const prior: TodoPhase[] = [{ name: "Work", tasks: [{ content: "old", status: "abandoned" }] }];
	const parsed: TodoPhase[] = [
		{
			name: "Work",
			tasks: [
				{ content: "new", status: "abandoned" },
				{ content: "old", status: "abandoned" },
			],
		},
	];
	expect(applyUserMarkdownPhases(prior, parsed)[0]?.tasks).toEqual([
		{ content: "new", status: "abandoned", droppedBy: "user" },
		{ content: "old", status: "abandoned" },
	]);
});

it("reserves moved content matches before assigning renamed drop provenance", () => {
	const prior: TodoPhase[] = [{ name: "Old", tasks: [{ content: "old", status: "abandoned" }] }];
	const parsed: TodoPhase[] = [
		{
			name: "New",
			tasks: [
				{ content: "inserted", status: "abandoned" },
				{ content: "old", status: "abandoned" },
			],
		},
	];
	expect(applyUserMarkdownPhases(prior, parsed)[0]?.tasks).toEqual([
		{ content: "inserted", status: "abandoned", droppedBy: "user" },
		{ content: "old", status: "abandoned" },
	]);
});

it("preserves trailing title and blocker whitespace through compaction", () => {
	const phases: TodoPhase[] = [{ name: "Work", tasks: [{ content: "ship  \t", status: "blocked", blocker: "CI  " }] }];
	expect(parseIncompleteTodosFromSummary(formatIncompleteTodosSection(collectIncompleteTodoRows(phases)))).toEqual(
		phases,
	);
});
