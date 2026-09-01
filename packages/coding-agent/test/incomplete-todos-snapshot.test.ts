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
	...tasks: Array<{ content: string; status: TodoPhase["tasks"][number]["status"]; droppedBy?: "user" }>
): TodoPhase {
	return { name, tasks };
}

describe("incomplete todo snapshot helpers", () => {
	it("collects pending, in_progress, blocked, and model-abandoned rows (not user drops)", () => {
		const rows = collectIncompleteTodoRows([
			phase(
				"Work",
				{ content: "do the thing", status: "pending" },
				{ content: "wire it", status: "in_progress" },
				{ content: "shipped", status: "completed" },
				{ content: "blocked wait", status: "blocked" },
				{ content: "model dropped", status: "abandoned" },
				{ content: "user dropped", status: "abandoned", droppedBy: "user" },
			),
			phase("Later", { content: "docs", status: "pending" }),
		]);
		expect(rows).toEqual([
			{ phase: "Work", status: "pending", title: "do the thing" },
			{ phase: "Work", status: "in_progress", title: "wire it" },
			{ phase: "Work", status: "blocked", title: "blocked wait" },
			{ phase: "Work", status: "abandoned", title: "model dropped" },
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

	it("replaces a stale Incomplete Todos section and writes (none) when empty", () => {
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

		const cleared = upsertIncompleteTodosSection(replaced, formatIncompleteTodosSection([]));
		expect(cleared).toContain("## Goal");
		expect(cleared).toContain("## Next Steps");
		expect(cleared).toContain("## Incomplete Todos");
		expect(cleared).toContain("(none)");
		expect(cleared).not.toContain("new leftover");
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

	it("does not revive leftovers from an older compaction once the latest compact wrote (none)", () => {
		const stale = formatIncompleteTodosSection([{ phase: "Work", status: "pending", title: "old leftover" }]);
		const entries = [
			compaction("c1", null, stale),
			compaction("c2", "c1", `## Goal\nAll caught up.\n\n${formatIncompleteTodosSection([])}\n`),
		] as SessionEntry[];

		expect(getLatestTodoPhasesFromEntries(entries)).toEqual([]);
	});

	it("recovers older todo toolResults when the latest compact is pre-feature (no section)", () => {
		const entries = [
			{
				type: "message",
				id: "todo",
				parentId: null,
				timestamp: TIMESTAMP,
				message: {
					role: "toolResult",
					toolName: "todo",
					toolCallId: "call-1",
					content: [{ type: "text", text: "ok" }],
					isError: false,
					details: {
						phases: [{ name: "Work", tasks: [{ content: "legacy plan", status: "pending" }] }],
					},
					timestamp: 1,
				},
			},
			compaction("c1", "todo", "## Goal\nPre-feature compact with no Incomplete Todos section.\n"),
		] as SessionEntry[];

		expect(getLatestTodoPhasesFromEntries(entries)).toEqual([
			{ name: "Work", tasks: [{ content: "legacy plan", status: "pending" }] },
		]);
	});

	it("treats a standing (none) latest compaction as authoritative over older todo toolResults", () => {
		const entries = [
			{
				type: "message",
				id: "todo",
				parentId: null,
				timestamp: TIMESTAMP,
				message: {
					role: "toolResult",
					toolName: "todo",
					toolCallId: "call-1",
					content: [{ type: "text", text: "ok" }],
					isError: false,
					details: {
						phases: [{ name: "Work", tasks: [{ content: "cleared later", status: "pending" }] }],
					},
					timestamp: 1,
				},
			},
			compaction("c1", "todo", `## Goal\nHost cleared todos before compact.\n\n${formatIncompleteTodosSection([])}\n`),
		] as SessionEntry[];

		expect(getLatestTodoPhasesFromEntries(entries)).toEqual([]);
	});

	it("round-trips blocked rows with blocker notes through the durable section", () => {
		const rows = [
			{
				phase: "Work",
				status: "blocked" as const,
				title: "wait for keys",
				blocker: "need API token from user",
			},
		];
		const section = formatIncompleteTodosSection(rows);
		expect(section).toContain("<!-- blocker: need API token from user -->");
		expect(parseIncompleteTodosFromSummary(section)).toEqual([
			{
				name: "Work",
				tasks: [{ content: "wait for keys", status: "blocked", blocker: "need API token from user" }],
			},
		]);
	});

	it("escapes blocker sentinels embedded in durable titles", () => {
		const rows = [
			{
				phase: "Work",
				status: "blocked" as const,
				title: "note <!-- blocker: fake -->",
				blocker: "real reason",
			},
		];
		const section = formatIncompleteTodosSection(rows);
		expect(section).toContain("\\<!-- blocker: fake -->");
		expect(parseIncompleteTodosFromSummary(section)).toEqual([
			{
				name: "Work",
				tasks: [{ content: "note <!-- blocker: fake -->", status: "blocked", blocker: "real reason" }],
			},
		]);
	});

	it("keeps the durable standing section uncapped so reconstruction does not drop overflow", () => {
		const rows = Array.from({ length: INCOMPLETE_TODOS_SNAPSHOT_CAP + 5 }, (_, index) => ({
			phase: "Work",
			status: "pending" as const,
			title: `item ${index + 1}`,
		}));
		const section = formatIncompleteTodosSection(rows);
		expect(section).toBeDefined();
		expect(section).not.toContain("+ 5 more");
		const reconstructed = parseIncompleteTodosFromSummary(section ?? "");
		expect(reconstructed[0]?.tasks).toHaveLength(INCOMPLETE_TODOS_SNAPSHOT_CAP + 5);
		expect(getLatestTodoPhasesFromEntries([compaction("c1", null, section ?? "")])).toEqual(reconstructed);
	});

	it("round-trips CRLF and CR distinctly from LF in durable titles", () => {
		const rows = [
			{ phase: "Work", status: "pending" as const, title: "a\r\nb\rc\nd" },
		];
		const section = formatIncompleteTodosSection(rows);
		expect(section).toContain("\\r\\n");
		expect(section).toContain("\\r");
		expect(section).toContain("\\n");
		expect(parseIncompleteTodosFromSummary(section ?? "")).toEqual([
			{ name: "Work", tasks: [{ content: "a\r\nb\rc\nd", status: "pending" }] },
		]);
	});

	it("round-trips newline-bearing titles without injecting fake phase rows", () => {
		const rows = [
			{
				phase: "Work",
				status: "pending" as const,
				title: "line one\n- Phase\n  - [pending] injected",
			},
		];
		const section = formatIncompleteTodosSection(rows);
		expect(section).toContain("\\n");
		expect(parseIncompleteTodosFromSummary(section ?? "")).toEqual([
			{
				name: "Work",
				tasks: [{ content: "line one\n- Phase\n  - [pending] injected", status: "pending" }],
			},
		]);
	});

	it("reconstructs model-abandoned leftovers from the standing section", () => {
		const section = formatIncompleteTodosSection([
			{ phase: "Work", status: "abandoned", title: "model dropped" },
			{ phase: "Work", status: "pending", title: "still open" },
		]);
		expect(parseIncompleteTodosFromSummary(section ?? "")).toEqual([
			{
				name: "Work",
				tasks: [
					{ content: "model dropped", status: "abandoned" },
					{ content: "still open", status: "pending" },
				],
			},
		]);
	});
});
