import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import {
	getKeybindings,
	KeybindingsManager,
	setKeybindings,
} from "@oh-my-pi/pi-coding-agent/config/keybindings/keybindings";
import { loadThemeSync } from "@oh-my-pi/pi-tui/theme/loader";
import { Settings } from "../../../src/config/settings";
import { SessionInfo } from "../../../src/ui/overlays/panels/session-info";
import { mountOverlay } from "../../helpers/overlay-terminal";
import { currentTheme, setCurrentTheme } from "@oh-my-pi/pi-tui/theme/runtime";

const restoreTheme = currentTheme();
afterAll(() => setCurrentTheme(restoreTheme));

const previousKeybindings = getKeybindings();

beforeAll(async () => {
	await Settings.init({ inMemory: true });
});

afterEach(() => {
	setKeybindings(previousKeybindings);
	vi.restoreAllMocks();
});

describe("session info overlay", () => {
	it("scrolls long details and closes on the configured cancel key", () => {
		setKeybindings(KeybindingsManager.inMemory({ "tui.select.cancel": "ctrl+g" }));
		const onClose = vi.fn();
		const report = Array.from({ length: 20 }, (_, index) => `Detail ${index}`).join("\n");
		const term = mountOverlay(() => SessionInfo({ report, theme: loadThemeSync("dark"), rows: () => 8, onClose }), {
			columns: 40,
			rows: 8,
			focusKind: "col",
		});
		try {
			const initial = term.screen().join("\n");
			term.press("down");
			term.render();
			const scrolled = term.screen().join("\n");

			expect(scrolled).not.toBe(initial);
			expect(onClose).not.toHaveBeenCalled();
			term.press("ctrl+g");
			expect(onClose).toHaveBeenCalledTimes(1);
			term.press("escape");
			expect(onClose).toHaveBeenCalledTimes(2);
		} finally {
			term.dispose();
		}
	});
});
