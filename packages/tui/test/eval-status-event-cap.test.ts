import { beforeAll, describe, expect, it } from "bun:test";
import { getThemeByName, type Theme } from "@oh-my-pi/pi-tui/theme";
import {
	type EvalStatusEvent,
	type EvalToolDetails,
	evalToolRenderer,
	MAX_STATUS_EVENTS,
	recordStatusEvent,
	type StatusEventLog,
} from "@oh-my-pi/pi-tui/tools/eval";

/**
 * A cell that calls a helper in a loop emits one status event per call. The
 * log keeps the newest discrete events and counts the rest, so live updates
 * and the persisted tool result stay small, while agent progress cards and
 * committed `todo` results (read by the session todo panel) survive.
 */
describe("eval status event log", () => {
	let theme: Theme;

	beforeAll(async () => {
		theme = (await getThemeByName("dark"))!;
	});

	it("keeps the newest discrete events and counts the dropped ones", () => {
		const log: StatusEventLog = {};
		const calls = MAX_STATUS_EVENTS + 1000;
		for (let i = 0; i < calls; i++) recordStatusEvent(log, { op: "browser", detail: `call ${i}` });

		expect(log.statusEvents).toHaveLength(MAX_STATUS_EVENTS);
		expect(log.statusEventsElided).toBe(1000);
		expect(log.statusEvents![0]!.detail).toBe("call 1000");
		expect(log.statusEvents!.at(-1)!.detail).toBe(`call ${calls - 1}`);
	});

	it("keeps agent snapshots and the committed todo result behind a flood", () => {
		const log: StatusEventLog = {};
		recordStatusEvent(log, { op: "todo", committed: true, call: "first" });
		recordStatusEvent(log, { op: "agent", id: "Scout", status: "running" });
		for (let i = 0; i < MAX_STATUS_EVENTS * 3; i++) recordStatusEvent(log, { op: "browser", detail: `call ${i}` });
		recordStatusEvent(log, { op: "agent", id: "Scout", status: "completed" });

		expect(log.statusEvents).toContainEqual({ op: "todo", committed: true, call: "first" });
		expect(log.statusEvents!.filter(event => event.op === "agent")).toEqual([
			{ op: "agent", id: "Scout", status: "completed" },
		]);
		expect(log.statusEvents).toHaveLength(MAX_STATUS_EVENTS);
	});

	it("bounds a loop of todo calls while keeping the newest committed one", () => {
		const log: StatusEventLog = {};
		const calls = 50_000;
		for (let i = 0; i < calls; i++) recordStatusEvent(log, { op: "todo", committed: i % 1000 === 0, call: i });

		expect(log.statusEvents).toHaveLength(MAX_STATUS_EVENTS);
		expect(log.statusEventsElided).toBe(calls - MAX_STATUS_EVENTS);
		// The newest committed call (49,000) is older than the kept tail but survives.
		expect(log.statusEvents!.filter(event => event.committed === true).map(event => event.call)).toEqual([49_000]);
	});

	function renderCell(statusEvents: EvalStatusEvent[], statusEventsElided: number): string {
		const details: EvalToolDetails = {
			language: "js",
			languages: ["js"],
			cells: [
				{
					index: 0,
					code: "while (true) await tab.evaluate('1')",
					language: "js",
					output: "",
					status: "complete",
					statusEvents,
					statusEventsElided,
				},
			],
		};
		const component = evalToolRenderer.renderResult(
			{ content: [{ type: "text", text: "" }], details },
			{ expanded: false, isPartial: false, spinnerFrame: 0 },
			theme,
		);
		return Bun.stripANSI(component.render(120).join("\n"));
	}

	it("includes dropped events in the rendered earlier-events count", () => {
		const rendered = renderCell(
			[
				{ op: "browser", detail: "tab.evaluate one" },
				{ op: "browser", detail: "tab.evaluate two" },
				{ op: "browser", detail: "tab.evaluate three" },
				{ op: "browser", detail: "tab.evaluate four" },
			],
			5000,
		);

		// Collapsed shows the newest 3; the 4th plus 5,000 dropped are counted.
		expect(rendered).toContain("… 5001 earlier");
		expect(rendered).toContain("tab.evaluate four");
	});

	it("shows the dropped count when only agent snapshots remain", () => {
		const rendered = renderCell([{ op: "agent", id: "Scout", status: "completed" }], 5000);

		expect(rendered).toContain("… 5000 earlier");
	});
});
