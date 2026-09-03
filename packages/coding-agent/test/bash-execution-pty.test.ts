import { beforeAll, describe, expect, it } from "bun:test";
import { BashExecutionComponent } from "@oh-my-pi/pi-coding-agent/modes/components/bash-execution";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { TUI } from "@oh-my-pi/pi-tui";

const ui = { requestRender: () => {}, requestComponentRender: () => {} } as unknown as TUI;

// Condition-driven poll, not a fixed wait: xterm's write pipeline completes on
// its own internal scheduling (no promise/event exposed to the component), so
// fake timers cannot drive it; mirrors pollUntil in bash-executor.test.ts.
async function renderUntil(component: BashExecutionComponent, predicate: (text: string) => boolean): Promise<string> {
	const deadline = Date.now() + 2_000;
	let text = component.render(100).join("\n");
	while (!predicate(text) && Date.now() < deadline) {
		await Bun.sleep(10);
		text = component.render(100).join("\n");
	}
	return text;
}

describe("BashExecutionComponent PTY rendering", () => {
	beforeAll(async () => {
		const theme = await getThemeByName("dark");
		if (!theme) throw new Error("Expected dark theme");
		setThemeInstance(theme);
	});

	it("replays raw PTY bytes with safe color preserved through completion", async () => {
		const component = new BashExecutionComponent("lg", ui, false);
		component.appendPtyChunk("\u001b[31mred\u001b[0m plain\r\nsecond\r\n");

		const streaming = await renderUntil(component, text => text.includes("second"));
		// SGR 31 survives the vterm replay as a palette style instead of being stripped.
		expect(streaming).toContain("\u001b[38;5;1m");
		expect(streaming).toContain("red");

		// Completion must keep the vterm rows — not replace them with the
		// sanitized (colorless) capture the model receives.
		component.setComplete(0, false, { output: "red plain\nsecond" });
		const finalText = await renderUntil(component, text => text.includes("second"));
		expect(finalText).toContain("\u001b[38;5;1m");
	});

	it("collapses carriage-return progress overwrites to the final frame", async () => {
		const component = new BashExecutionComponent("progress", ui, false);
		component.appendPtyChunk("10%\r50%\r100%\r\ndone\r\n");
		component.setComplete(0, false);

		const text = await renderUntil(component, t => t.includes("done"));
		expect(text).toContain("100%");
		expect(text).not.toContain("50%");
	});
});
