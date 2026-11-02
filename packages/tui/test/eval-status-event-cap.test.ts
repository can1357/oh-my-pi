import { beforeAll, describe, expect, it } from "bun:test";
import * as os from "node:os";
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

	it("replaces one MCP call's progress in place rather than accumulating heartbeats", () => {
		const log: StatusEventLog = {};
		recordStatusEvent(log, { op: "mcp_progress", id: "call-1", tool: "mcp__search", progress: 1 });
		recordStatusEvent(log, { op: "read", chars: 10 });
		recordStatusEvent(log, {
			op: "mcp_progress",
			id: "call-1",
			tool: "mcp__search",
			progress: 2,
			message: "fetching",
		});

		expect(log.statusEvents).toEqual([
			{ op: "mcp_progress", id: "call-1", tool: "mcp__search", progress: 2, message: "fetching" },
			{ op: "read", chars: 10 },
		]);
		expect(log.statusEventsElided).toBeUndefined();
	});

	it("evicts old MCP snapshots under the cap while protecting agent, batch, and committed todo snapshots", () => {
		const log: StatusEventLog = {};
		const protectedEvents: EvalStatusEvent[] = [
			{ op: "agent", id: "Scout", status: "running" },
			{ op: "judge_batch", id: "batch", done: 1, total: 2 },
			{ op: "todo", committed: true },
		];
		for (const event of protectedEvents) recordStatusEvent(log, event);
		for (let i = 0; i < MAX_STATUS_EVENTS * 3; i++) {
			recordStatusEvent(log, { op: "mcp_progress", id: `call-${i}`, tool: "mcp__search", progress: i });
		}

		expect(log.statusEvents).toHaveLength(MAX_STATUS_EVENTS);
		expect(log.statusEventsElided).toBe(MAX_STATUS_EVENTS * 2 + protectedEvents.length);
		for (const event of protectedEvents) expect(log.statusEvents).toContainEqual(event);
		expect(log.statusEvents!.at(-1)?.id).toBe(`call-${MAX_STATUS_EVENTS * 3 - 1}`);
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

	it("shows the MCP tool and its progress text, with home paths shortened and no internal call id, in either renderer", () => {
		const event: EvalStatusEvent = {
			op: "mcp_progress",
			id: "internal-call-id",
			tool: "mcp__search",
			progress: 2,
			total: 4,
			message: `Fetching rows from ${os.homedir()}/private/data`,
		};
		const rendered = renderCell([event], 0);
		expect(rendered).toContain("mcp__search");
		expect(rendered).toContain("Fetching rows from ~/private/data (2/4)");
		expect(rendered).not.toContain(os.homedir());
		expect(rendered).not.toContain("internal-call-id");

		const view = evalToolRenderer.describeResult(
			{
				content: [],
				details: {
					cells: [
						{
							index: 0,
							code: "await tool.mcp__search({})",
							output: "",
							status: "running",
							statusEvents: [event],
						},
					],
				},
			},
			{ expanded: false, isPartial: true },
		);
		const native = JSON.stringify(view.body);
		expect(native).toContain("mcp__search");
		expect(native).toContain("Fetching rows from ~/private/data (2/4)");
		expect(native).not.toContain(os.homedir());
		expect(native).not.toContain("internal-call-id");
	});
});
