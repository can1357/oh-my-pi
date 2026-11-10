import { beforeAll, describe, expect, it } from "bun:test";
import { ToolExecutionComponent } from "@oh-my-pi/pi-tui/chat/tool-execution";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { TUI } from "@oh-my-pi/pi-tui";

describe("soft requirement skip rendering", () => {
	beforeAll(async () => {
		await initTheme();
	});

	it("renders a single muted waiting row instead of a failed tool card", () => {
		const ui = { requestRender() {}, requestComponentRender() {}, resetDisplay() {} } as unknown as TUI;
		const component = new ToolExecutionComponent("read", { path: "skill://bitbucket-prs" }, {}, undefined, ui);
		try {
			component.updateResult(
				{
					content: [{ type: "text", text: "Tool call was skipped: Skipped: waiting for the `todo` tool first." }],
					details: { __synthetic: true, source: "soft_requirement_skipped", waitingFor: "todo", executed: false },
					isError: true,
				},
				false,
			);
			const rendered = Bun.stripANSI(component.render(100).join("\n"));
			expect(rendered).toContain("Skipped (waiting for todo)");
			expect(rendered).not.toContain("skill://bitbucket-prs");
			expect(rendered).not.toContain("Tool call was skipped");
			expect(rendered.trim().split("\n")).toHaveLength(1);
		} finally {
			component.stopAnimation();
		}
	});

	it("keeps the waiting status for a soft-skipped wait call", () => {
		const ui = { requestRender() {}, requestComponentRender() {}, resetDisplay() {} } as unknown as TUI;
		const component = new ToolExecutionComponent("wait", {}, {}, undefined, ui);
		try {
			component.updateResult(
				{
					content: [{ type: "text", text: "Tool call was skipped: waiting for todo." }],
					details: { __synthetic: true, source: "soft_requirement_skipped", waitingFor: "todo", executed: false },
					isError: true,
				},
				false,
			);
			const described = component.describe();
			expect(described.k).toBe("card");
			expect(JSON.stringify(described)).toContain("Tool call was skipped: waiting for todo.");
			const rendered = Bun.stripANSI(component.render(100).join("\n"));
			expect(rendered).toContain("Skipped (waiting for todo)");
		} finally {
			component.stopAnimation();
		}
	});

	it("still hides an interrupt-skipped wait call", () => {
		const ui = { requestRender() {}, requestComponentRender() {}, resetDisplay() {} } as unknown as TUI;
		const component = new ToolExecutionComponent("wait", {}, {}, undefined, ui);
		try {
			component.updateResult(
				{
					content: [{ type: "text", text: "Tool call was skipped: interrupted." }],
					details: { __synthetic: true, source: "interrupt_skipped" },
					isError: true,
				},
				false,
			);
			expect(component.render(100)).toEqual([]);
		} finally {
			component.stopAnimation();
		}
	});
});
