import { beforeAll, describe, expect, it } from "bun:test";
import { ToolExecutionComponent } from "@oh-my-pi/pi-tui/chat/tool-execution";
import type { DescribeContext } from "@oh-my-pi/pi-tui/native/node";
import { initTheme } from "@oh-my-pi/pi-tui/theme";

const context = (tray: boolean): DescribeContext => ({
	cols: 120,
	reduceMotion: false,
	dark: true,
	supports: () => false,
	feature: name => tray && name === "tray",
});

const ui = { requestRender: () => {}, requestComponentRender: () => {}, resetDisplay: () => {} };

const running = { id: "bg_1", type: "bash" as const, status: "running" as const, label: "npm test", durationMs: 1_200 };
const settled = { ...running, status: "completed" as const, resultText: "ok" };

function waitCard(): ToolExecutionComponent {
	const tool = new ToolExecutionComponent("wait", { ids: ["bg_1"] }, {}, undefined, ui);
	tool.setArgsComplete("call-1");
	tool.setExecutionStarted("call-1");
	// An expanded transcript (Ctrl+O): only the tray host's fold keeps the running card closed.
	tool.setExpanded(true);
	return tool;
}

describe("wait card on a host with the tray", () => {
	beforeAll(async () => {
		await initTheme();
	});

	it("starts folded while it waits, then reads as on any host once settled", () => {
		const tool = waitCard();
		try {
			tool.updateResult({ content: [{ type: "text", text: "" }], details: { op: "wait", jobs: [running] } }, true);
			expect(tool.describe(context(true)).p).toMatchObject({ collapsible: true, collapsed: true });
			expect(tool.describe(context(false)).p).toMatchObject({ collapsible: true, collapsed: false });

			tool.updateResult({ content: [{ type: "text", text: "" }], details: { op: "wait", jobs: [settled] } }, false);
			const onTray = tool.describe(context(true));
			expect(onTray.p).toMatchObject({ collapsed: false });
			expect(JSON.stringify(onTray)).toBe(JSON.stringify(tool.describe(context(false))));
		} finally {
			tool.dispose();
		}
	});
});
