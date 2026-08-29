import { describe, expect, it } from "bun:test";
import {
	capIncompleteTodoRows,
	collectIncompleteTodoRows,
	formatIncompleteTodoSnapshotLines,
	formatIncompleteTodosSection,
	INCOMPLETE_TODOS_SNAPSHOT_CAP,
	parseIncompleteTodosFromSummary,
	upsertIncompleteTodosSection,
} from "@oh-my-pi/pi-coding-agent/session/incomplete-todos";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { getLatestTodoPhasesFromEntries, type TodoPhase } from "@oh-my-pi/pi-coding-agent/tools/todo";

function phase(
	name: string,
	...tasks: Array<{ content: string; status: TodoPhase["tasks"][number]["status"] }>
): TodoPhase {
	return { name, tasks };
}

describe("incomplete todo snapshot helpers", () => {
	it("collects pending and in_progress rows with phase, status, and title", () => {
		const rows = collectIncompleteTodoRows([
			phase(
				"Work",
				{ content: "do the thing", status: "pending" },
				{ content: "wire it", status: "in_progress" },
				{ content: "shipped", status: "completed" },
				{ content: "blocked wait", status: "blocked" },
				{ content: "dropped", status: "abandoned" },
			),
			phase("Later", { content: "docs", status: "pending" }),
		]);
		expect(rows).toEqual([
			{ phase: "Work", status: "pending", title: "do the thing" },
			{ phase: "Work", status: "in_progress", title: "wire it" },
			{ phase: "Later", status: "pending", title: "docs" },
		]);
	});

	it("caps snapshot lines and appends + N more", () => {
		const rows = Array.from({ length: INCOMPLETE_TODOS_SNAPSHOT_CAP + 7 }, (_, index) => ({
			phase: "Work",
			status: index === 0 ? ("in_progress" as const) : ("pending" as const),
			title: `item ${index + 1}`,
		}));
		const lines = formatIncompleteTodoSnapshotLines(rows);
		expect(lines).toHaveLength(INCOMPLETE_TODOS_SNAPSHOT_CAP + 1);
		expect(lines[0]).toBe("[Work] [in_progress] item 1");
		expect(lines[1]).toBe("[Work] [pending] item 2");
		expect(lines.at(-1)).toBe("+ 7 more");
		expect(capIncompleteTodoRows(rows).overflow).toBe(7);
	});

	it("replaces an Incomplete Todos heading that has a trailing colon or extra text", () => {
		const stale = [
			"## Goal",
			"Ship the parser",
			"",
			"## Incomplete Todos: leftover work",
			"These pending/in_progress items remain after compaction; continue them. A text-only stop is not completion.",
			"- Work",
			"  - [pending] old leftover",
			"",
			"## Next Steps",
			"1. Keep going",
			"",
		].join("\n");

		const replaced = upsertIncompleteTodosSection(
			stale,
			formatIncompleteTodosSection([{ phase: "Work", status: "in_progress", title: "new leftover" }]),
		);
		expect(replaced).toContain("## Goal");
		expect(replaced).toContain("## Next Steps");
		expect(replaced).toContain("[in_progress] new leftover");
		expect(replaced).not.toContain("old leftover");
		expect(replaced).not.toContain("## Incomplete Todos:");
		expect([...replaced.matchAll(/## Incomplete Todos/g)]).toHaveLength(1);

		const reconstructed = parseIncompleteTodosFromSummary(
			["## Goal", "", "## Incomplete Todos leftover", "- Work", "  - [pending] still open", ""].join("\n"),
		);
		expect(reconstructed).toEqual([{ name: "Work", tasks: [{ content: "still open", status: "pending" }] }]);
	});

	it("replaces a stale Incomplete Todos section and strips it when empty", () => {
		const stale = [
			"## Goal",
			"Ship the parser",
			"",
			"## Incomplete Todos",
			"These pending/in_progress items remain after compaction; continue them. A text-only stop is not completion.",
			"- Work",
			"  - [pending] old leftover",
			"",
			"## Next Steps",
			"1. Keep going",
			"",
		].join("\n");

		const replaced = upsertIncompleteTodosSection(
			stale,
			formatIncompleteTodosSection([{ phase: "Work", status: "in_progress", title: "new leftover" }]),
		);
		expect(replaced).toContain("## Goal");
		expect(replaced).toContain("## Next Steps");
		expect(replaced).toContain("[in_progress] new leftover");
		expect(replaced).not.toContain("old leftover");
		expect(replaced.indexOf("## Incomplete Todos")).toBeLessThan(replaced.indexOf("## Next Steps"));

		const stripped = upsertIncompleteTodosSection(replaced, undefined);
		expect(stripped).toContain("## Goal");
		expect(stripped).toContain("## Next Steps");
		expect(stripped).not.toContain("## Incomplete Todos");
		expect(stripped).not.toContain("new leftover");
	});

	it("reconstructs leftover phases from the standing Incomplete Todos section", () => {
		const summary = [
			"## Goal",
			"Ship the parser",
			"",
			formatIncompleteTodosSection([
				{ phase: "Work", status: "in_progress", title: "do the thing" },
				{ phase: "Work", status: "pending", title: "wire it" },
				{ phase: "Later", status: "pending", title: "docs" },
			]),
			"",
			"## Next Steps",
			"1. Keep going",
			"",
		].join("\n");

		expect(parseIncompleteTodosFromSummary(summary)).toEqual([
			{
				name: "Work",
				tasks: [
					{ content: "do the thing", status: "in_progress" },
					{ content: "wire it", status: "pending" },
				],
			},
			{ name: "Later", tasks: [{ content: "docs", status: "pending" }] },
		]);
	});
});

describe("getLatestTodoPhasesFromEntries reconstructs leftover todos after compact", () => {
	const TIMESTAMP = "2026-08-18T00:00:00.000Z";

	function compaction(id: string, parentId: string | null, summary: string): SessionEntry {
		return {
			type: "compaction",
			id,
			parentId,
			timestamp: TIMESTAMP,
			summary,
			firstKeptEntryId: "kept",
			tokensBefore: 1000,
		};
	}

	it("reads leftover pending/in_progress from the latest compaction summary", () => {
		const summary = [
			"Earlier work was summarized.",
			"",
			formatIncompleteTodosSection([
				{ phase: "Work", status: "pending", title: "do the thing" },
				{ phase: "Work", status: "in_progress", title: "wire it" },
			]),
		].join("\n");

		const entries = [
			{
				type: "message",
				id: "user",
				parentId: null,
				timestamp: TIMESTAMP,
				message: { role: "user", content: [{ type: "text", text: "go" }], timestamp: 1 },
			},
			compaction("c1", "user", summary),
		] as SessionEntry[];

		expect(getLatestTodoPhasesFromEntries(entries)).toEqual([
			{
				name: "Work",
				tasks: [
					{ content: "do the thing", status: "pending" },
					{ content: "wire it", status: "in_progress" },
				],
			},
		]);
	});

	it("prefers a newer todo toolResult over an older compaction leftover section", () => {
		const leftover = formatIncompleteTodosSection([{ phase: "Work", status: "pending", title: "stale leftover" }]);
		const entries = [
			compaction("c1", null, leftover ?? ""),
			{
				type: "message",
				id: "todo",
				parentId: "c1",
				timestamp: TIMESTAMP,
				message: {
					role: "toolResult",
					toolName: "todo",
					toolCallId: "call-1",
					content: [{ type: "text", text: "ok" }],
					isError: false,
					details: {
						phases: [{ name: "Work", tasks: [{ content: "fresh item", status: "in_progress" }] }],
					},
					timestamp: 2,
				},
			},
		] as SessionEntry[];

		expect(getLatestTodoPhasesFromEntries(entries)).toEqual([
			{ name: "Work", tasks: [{ content: "fresh item", status: "in_progress" }] },
		]);
	});

	it("does not revive leftovers from an older compaction once the latest compact stripped the section", () => {
		const stale = formatIncompleteTodosSection([{ phase: "Work", status: "pending", title: "old leftover" }]);
		const entries = [
			compaction("c1", null, stale ?? ""),
			compaction("c2", "c1", "## Goal\nAll caught up.\n"),
		] as SessionEntry[];

		expect(getLatestTodoPhasesFromEntries(entries)).toEqual([]);
	});
});
