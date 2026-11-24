import { beforeAll, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { currentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import { toolText } from "./helpers/tool-text";

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true, cwd: process.cwd() });
}, 15_000);

const SKIP_TEXT = "Skipped due to a queued background completion (job or supervised process).";

function renderTool(
	name: "edit" | "wait",
	result: {
		content: Array<{ type: string; text: string }>;
		details?: unknown;
		isError?: boolean;
	},
	options: { expanded?: boolean } = {},
): string {
	return toolText({
		name,
		args: name === "edit" ? { path: "hub/src/viewer/session.ts" } : {},
		result,
		expanded: options.expanded,
	}).trim();
}

describe("mid-turn steering skip rendering", () => {
	it("hides skipped waits collapsed and expanded", () => {
		const skipDetails = [
			{ __synthetic: true, source: "interrupt_skipped", executed: false },
			{
				__interrupted: true,
				source: "interrupt_skipped",
				execution: "started",
			},
		];

		for (const details of skipDetails) {
			const result = {
				content: [{ type: "text", text: SKIP_TEXT }],
				details,
				isError: true,
			};
			expect(renderTool("wait", result)).toBe("");
			expect(renderTool("wait", result, { expanded: true })).toBe("");
		}
	});

	it("preserves other skipped tool cards and real wait results", () => {
		const skippedEdit = renderTool("edit", {
			content: [{ type: "text", text: SKIP_TEXT }],
			details: {
				__synthetic: true,
				source: "interrupt_skipped",
				executed: false,
			},
			isError: true,
		});
		expect(skippedEdit).toContain(currentTheme().symbols.symbol("status.info"));

		const realWait = renderTool("wait", {
			content: [{ type: "text", text: "No background work to wait for" }],
			details: { op: "wait", jobs: [] },
		});
		expect(realWait).toContain("No background work to wait for");
	});

	it("still renders a genuine edit failure as an error", () => {
		const rendered = renderTool("edit", {
			content: [{ type: "text", text: SKIP_TEXT }],
			details: {},
			isError: true,
		});
		expect(rendered).toContain(currentTheme().symbols.symbol("status.error"));
	});
});
