import { beforeAll, describe, expect, it } from "bun:test";
import {
	buildLogCopyPayload,
	DebugLogViewerComponent,
	DebugLogViewerModel,
	LOAD_OLDER_LABEL,
	SESSION_BOUNDARY_WARNING,
} from "@oh-my-pi/pi-coding-agent/debug/log-viewer";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

beforeAll(async () => {
	const theme = await getThemeByName("dark");
	if (!theme) throw new Error("Expected dark theme");
	setThemeInstance(theme);
});

describe("DebugLogViewerModel", () => {
	const describeRow = (row: { kind: string; logIndex?: number }): string => {
		switch (row.kind) {
			case "warning":
				return SESSION_BOUNDARY_WARNING;
			case "load-older":
				return LOAD_OLDER_LABEL;
			case "log":
				return `log:${row.logIndex}`;
			default:
				return row.kind;
		}
	};
	it("inserts session boundary warning between older and current-session logs", () => {
		const processStartMs = Date.parse("2026-02-14T12:00:00.000Z");
		const logs = [
			'{"timestamp":"2026-02-14T11:59:00.000Z","level":"info","message":"old"}',
			'{"timestamp":"2026-02-14T11:59:30.000Z","level":"info","message":"old-2"}',
			'{"timestamp":"2026-02-14T12:00:05.000Z","level":"info","message":"current"}',
		].join("\n");

		const model = new DebugLogViewerModel(logs, { processStartMs });
		const rowKinds = model.rows.map(row => describeRow(row as { kind: string; logIndex?: number }));

		expect(rowKinds).toEqual(["log:0", "log:1", SESSION_BOUNDARY_WARNING, "log:2"]);
	});

	it("filters logs with case-insensitive substring matching", () => {
		const logs = ["Alpha", "beta", "Gamma", "BETTER"].join("\n");
		const model = new DebugLogViewerModel(logs, { processStartMs: Date.now() });

		model.setFilterQuery("be");
		const rowKinds = model.rows.map(row => describeRow(row as { kind: string; logIndex?: number }));
		expect(rowKinds).toEqual(["log:1", "log:3"]);
		expect(model.visibleLogCount).toBe(2);
	});

	it("filters to current process pid when enabled", () => {
		const logs = [
			'{"pid":42,"level":"info","message":"alpha"}',
			'{"pid":84,"level":"info","message":"beta"}',
			'{"level":"info","message":"missing"}',
		].join("\n");
		const model = new DebugLogViewerModel(logs, { processStartMs: Date.now(), processPid: 42 });

		expect(model.visibleLogCount).toBe(3);
		model.toggleProcessFilter();
		expect(model.visibleLogCount).toBe(1);
		expect(model.rows.map(row => describeRow(row as { kind: string; logIndex?: number }))).toEqual(["log:0"]);
	});

	it("selects all visible log rows", () => {
		const logs = ["alpha", "beta", "gamma"].join("\n");
		const model = new DebugLogViewerModel(logs, { processStartMs: Date.now() });

		model.selectAllVisible();
		expect(model.getSelectedLogIndices()).toEqual([0, 1, 2]);
	});

	it("progressively loads older entries in chunks", async () => {
		const logs = Array.from({ length: 120 }, (_, index) => `log-${index}`).join("\n");
		const model = new DebugLogViewerModel(logs, { processStartMs: Date.now() });

		expect(model.visibleLogCount).toBe(50);
		const initialKinds = model.rows.slice(0, 2).map(row => describeRow(row as { kind: string; logIndex?: number }));
		expect(initialKinds).toEqual([LOAD_OLDER_LABEL, "log:70"]);

		await model.loadOlder(5);
		expect(model.visibleLogCount).toBe(55);
		const expandedKinds = model.rows.slice(0, 2).map(row => describeRow(row as { kind: string; logIndex?: number }));
		expect(expandedKinds).toEqual([LOAD_OLDER_LABEL, "log:65"]);

		await model.loadOlder(50);
		expect(model.visibleLogCount).toBe(105);
		const expandedAgainKinds = model.rows
			.slice(0, 2)
			.map(row => describeRow(row as { kind: string; logIndex?: number }));
		expect(expandedAgainKinds).toEqual([LOAD_OLDER_LABEL, "log:15"]);
	});

	it("loads older entries from external sources while keeping cursor stable", async () => {
		const logs = ["new-1", "new-2", "new-3"].join("\n");
		let hasOlder = true;
		const model = new DebugLogViewerModel(logs, {
			processStartMs: Date.now(),
			hasOlderLogs: () => hasOlder,
			loadOlderLogs: async () => {
				hasOlder = false;
				return ["old-1", "old-2"].join("\n");
			},
		});

		expect(model.rows[0]?.kind).toBe("load-older");
		await model.loadOlder(1);
		expect(model.getRawLine(model.cursorLogIndex ?? 0)).toBe("new-3");
		expect(model.rows[0]?.kind).toBe("load-older");
	});

	it("clamps cursor when filtered list shrinks", () => {
		const logs = ["alpha", "beta", "gamma"].join("\n");
		const model = new DebugLogViewerModel(logs, { processStartMs: Date.now() });

		model.moveCursor(2, false);
		expect(model.cursorLogIndex).toBe(2);

		model.setFilterQuery("alpha");
		expect(model.cursorLogIndex).toBe(0);
		expect(model.visibleLogCount).toBe(1);
	});

	it("resets selection anchor when filtered view drops the anchor log", () => {
		const logs = ["alpha", "beta", "gamma", "delta"].join("\n");
		const model = new DebugLogViewerModel(logs, { processStartMs: Date.now() });

		model.moveCursor(-999, false);
		model.moveCursor(2, true);
		expect(model.getSelectedLogIndices()).toEqual([0, 1, 2]);

		model.setFilterQuery("beta");
		expect(model.getSelectedLogIndices()).toEqual([1]);
	});

	it("shows session boundary warning only when older and newer logs are visible", () => {
		const processStartMs = Date.parse("2026-02-14T12:00:00.000Z");
		const logs = [
			'{"timestamp":"2026-02-14T11:59:00.000Z","level":"info","message":"old"}',
			'{"timestamp":"2026-02-14T12:00:05.000Z","level":"info","message":"current"}',
			'{"timestamp":"2026-02-14T12:00:10.000Z","level":"info","message":"current-2"}',
		].join("\n");
		const model = new DebugLogViewerModel(logs, { processStartMs });

		model.setFilterQuery("old");
		expect(model.rows.map(row => row.kind)).toEqual(["log"]);

		model.setFilterQuery("current-2");
		expect(model.rows.map(row => row.kind)).toEqual(["log"]);

		model.setFilterQuery("current");
		const rowKinds = model.rows.map(row => describeRow(row as { kind: string; logIndex?: number }));
		expect(rowKinds).toEqual(["log:1", "log:2"]);

		model.setFilterQuery("");
		const fullRowKinds = model.rows.map(row => describeRow(row as { kind: string; logIndex?: number }));
		expect(fullRowKinds).toEqual(["log:0", SESSION_BOUNDARY_WARNING, "log:1", "log:2"]);
	});

	it("copies only selected visible entries", () => {
		const logs = ["alpha", "bar", "baz"].join("\n");
		const model = new DebugLogViewerModel(logs, { processStartMs: Date.now() });

		model.setFilterQuery("ba");
		model.moveCursor(-999, false);
		model.moveCursor(1, true);
		const payload = buildLogCopyPayload(model.getSelectedRawLines());
		expect(payload).toBe("bar\nbaz");
	});

	it("supports shift-range selection and reset on plain movement", () => {
		const logs = ["a", "b", "c", "d"].join("\n");
		const model = new DebugLogViewerModel(logs, { processStartMs: Date.now() });

		model.moveCursor(-999, false);
		model.moveCursor(1, true);
		model.moveCursor(1, true);
		expect(model.getSelectedLogIndices()).toEqual([0, 1, 2]);

		model.moveCursor(1, false);
		expect(model.getSelectedLogIndices()).toEqual([3]);
	});

	it("expands and collapses all selected rows", () => {
		const logs = ["a", "b", "c"].join("\n");
		const model = new DebugLogViewerModel(logs, { processStartMs: Date.now() });

		model.moveCursor(-999, false);
		model.moveCursor(1, true);
		model.expandSelected();
		expect(model.isExpanded(0)).toBe(true);
		expect(model.isExpanded(1)).toBe(true);

		model.collapseSelected();
		expect(model.isExpanded(0)).toBe(false);
		expect(model.isExpanded(1)).toBe(false);
	});

	it("selects and expands a clicked visible log row", () => {
		let updates = 0;
		const viewer = new DebugLogViewerComponent({
			logs: ["alpha", "beta", "gamma"].join("\n"),
			terminalRows: 12,
			onExit: () => {},
			onUpdate: () => {
				updates++;
			},
		});

		viewer.render(80);
		viewer.handleInput("\x1b[<0;2;6M");

		const rendered = viewer
			.render(80)
			.map(line => Bun.stripANSI(line))
			.join("\n");
		expect(rendered).toContain("▾ beta");
		expect(updates).toBe(1);
	});
});

describe("buildLogCopyPayload", () => {
	it("joins selected lines and strips control/ansi sequences", () => {
		const payload = buildLogCopyPayload(["plain", "\u001b[31mred\u001b[0m", "ok\u0007", ""]);
		expect(payload).toBe("plain\nred\nok");
	});
});
