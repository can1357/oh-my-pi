import { beforeAll, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ToolExecutionComponent } from "@oh-my-pi/pi-tui/chat/tool-execution";
import { getThemeByName, initTheme } from "@oh-my-pi/pi-tui/theme";
import { formatStatusIcon } from "@oh-my-pi/pi-tui/render/render-utils";
import { TUI } from "@oh-my-pi/pi-tui";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true, cwd: process.cwd() });
	await initTheme(false, undefined, undefined, "dark", "light");
}, 15_000);

const SKIP_TEXT = "Skipped due to a queued background completion (job or supervised process).";

function renderSkippedEdit(details: unknown): string {
	const tui = new TUI(new VirtualTerminal(120, 20));
	const component = new ToolExecutionComponent("edit", { path: "hub/src/viewer/session.ts" }, {}, undefined, tui);
	component.updateResult({ content: [{ type: "text", text: SKIP_TEXT }], details, isError: true }, false);
	return Bun.stripANSI(component.render(120).join("\n"));
}

describe("mid-turn steering skip rendering", () => {
	it("renders pending and in-flight interrupt skips as nothing", () => {
		const skipDetails = [
			{ __synthetic: true, source: "interrupt_skipped", executed: false },
			{ __interrupted: true, source: "interrupt_skipped", execution: "started" },
		];

		for (const details of skipDetails) {
			expect(renderSkippedEdit(details)).toBe("");
		}
	});

	it("still renders a genuine edit failure as an error", async () => {
		const uiTheme = await getThemeByName("dark");
		if (!uiTheme) throw new Error("dark theme missing");
		const errorIcon = Bun.stripANSI(formatStatusIcon("error", uiTheme));

		// A real tool failure carries no synthetic discriminator and remains visible.
		const rendered = renderSkippedEdit({});

		expect(rendered).toContain(errorIcon);
	}, 15_000);
});
