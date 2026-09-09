import { beforeAll, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ToolExecutionComponent } from "@oh-my-pi/pi-coding-agent/modes/components/tool-execution";
import { getThemeByName, initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { formatStatusIcon } from "@oh-my-pi/pi-coding-agent/tools/render-utils";
import { TUI } from "@oh-my-pi/pi-tui";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true, cwd: process.cwd() });
	await initTheme(false, undefined, undefined, "dark", "light");
}, 15_000);

const SKIP_TEXT =
	"Skipped due to pending peer interrupt. Do not count this skipped result as completed work or verification. After the interrupt is handled on the next step, retry the skipped tool if it is still needed.";

function renderSkippedEdit(details: unknown): string {
	const tui = new TUI(new VirtualTerminal(120, 20));
	const component = new ToolExecutionComponent("edit", { path: "hub/src/viewer/session.ts" }, {}, undefined, tui);
	component.updateResult({ content: [{ type: "text", text: SKIP_TEXT }], details, isError: true }, false);
	return Bun.stripANSI(component.render(120).join("\n"));
}

describe("mid-turn steering skip rendering", () => {
	it("renders both pending and in-flight interrupt skips as info, not errors", async () => {
		const uiTheme = await getThemeByName("dark");
		if (!uiTheme) throw new Error("dark theme missing");
		const errorIcon = Bun.stripANSI(formatStatusIcon("error", uiTheme));
		const infoIcon = Bun.stripANSI(formatStatusIcon("info", uiTheme));
		const skipDetails = [
			{ __synthetic: true, source: "interrupt_skipped", executed: false },
			{ __interrupted: true, source: "interrupt_skipped", execution: "started" },
		];

		for (const details of skipDetails) {
			const rendered = renderSkippedEdit(details);

			expect(rendered).toContain(infoIcon);
			expect(rendered).not.toContain(errorIcon);
			// The bespoke edit error frame must be gone — a skip is not a failure.
			expect(rendered).not.toContain("╭");
			expect(rendered).toContain("Skipped due to pending peer interrupt");
		}
	}, 15_000);

	it("still renders a genuine edit failure as an error", async () => {
		const uiTheme = await getThemeByName("dark");
		if (!uiTheme) throw new Error("dark theme missing");
		const errorIcon = Bun.stripANSI(formatStatusIcon("error", uiTheme));

		// A real tool failure carries no synthetic discriminator and must keep the
		// error styling — the fix only neutralizes benign interrupt skips.
		const rendered = renderSkippedEdit({});

		expect(rendered).toContain(errorIcon);
	}, 15_000);
});
