import { beforeAll, describe, expect, it } from "bun:test";
import { BashInteractiveOverlayComponent } from "@oh-my-pi/pi-tui/tools/bash-interactive";
import { loadXtermTerminal } from "@oh-my-pi/pi-tui/tools/terminal-output";
import { getThemeByName, setThemeInstance, type Theme } from "@oh-my-pi/pi-tui/theme";
import type * as XtermModule from "@oh-my-pi/pi-utils/vterm";

const TERMINAL_ROWS = 40;

let theme: Theme;
let terminalCtor: typeof XtermModule.Terminal;

function build(compact: boolean): BashInteractiveOverlayComponent {
	return new BashInteractiveOverlayComponent(
		"doas pacman -Syu",
		theme,
		() => TERMINAL_ROWS,
		terminalCtor,
		{ resize: () => {} },
		compact,
	);
}

describe("BashInteractiveOverlayComponent sheet", () => {
	beforeAll(async () => {
		const loaded = await getThemeByName("dark");
		if (!loaded) throw new Error("Expected dark theme");
		setThemeInstance(loaded);
		theme = loaded;
		terminalCtor = await loadXtermTerminal();
	});

	it("fills the pane for an explicit pty request", () => {
		const component = build(false);

		expect(component.nativeOverlay.size).toBe("full");
		// Two borders, the command head and the footer around a grid of 80% rows.
		expect(component.render(80)).toHaveLength(Math.floor(TERMINAL_ROWS * 0.8) - 4 + 4);
	});

	it("opens a small card for a password prompt", () => {
		const component = build(true);

		expect(component.nativeOverlay.size).toBe("sm");
		expect(component.render(80)).toHaveLength(6 + 4);
	});
});
