import { describe, expect, it } from "bun:test";
import {
	getEditorTheme,
	getSelectListTheme,
	getSettingsListTheme,
	getSymbolTheme,
	theme,
} from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

/**
 * Contract for issue #2998: the exported theme-getter functions must not crash
 * when `theme` is undefined (the state before `initTheme()` assigns the global,
 * or when a plugin calls them from a separate module instance under npm-global
 * installs where the live binding was never initialized). They must return a
 * usable plain-text fallback instead of throwing "undefined is not an object".
 *
 * These tests intentionally do NOT call `initTheme()`. However, `theme` is a
 * module-global shared across the test run; if another test file already
 * initialized it, the guard path is skipped and we assert the styled path
 * still works. Either way, the contract holds: the functions never throw.
 */
describe("theme-getters before initTheme (no crash when theme is undefined)", () => {
	it("getSettingsListTheme returns a usable theme without throwing", () => {
		const t = getSettingsListTheme();
		expect(typeof t.cursor).toBe("string");
		expect(t.label("x", false, false)).toBe("x");
		expect(t.value("y", false, false)).toBeTypeOf("string");
	});

	it("getEditorTheme returns a usable theme without throwing", () => {
		const t = getEditorTheme();
		expect(typeof t.borderColor("x")).toBe("string");
		expect(t.selectList).toBeDefined();
		expect(t.symbols).toBeDefined();
	});

	it("getSelectListTheme returns a usable theme without throwing", () => {
		const t = getSelectListTheme();
		expect(typeof t.selectedPrefix(">")).toBe("string");
		expect(t.symbols).toBeDefined();
	});

	it("getSymbolTheme returns ASCII fallback symbols without throwing", () => {
		const t = getSymbolTheme();
		expect(t.cursor).toBeTypeOf("string");
		expect(t.spinnerFrames.length).toBeGreaterThan(0);
		expect(t.boxSharp.horizontal).toBeTypeOf("string");
	});

	it("styled path still works when theme is initialized", () => {
		if (typeof theme === "undefined") return; // guard not exercisable in this run
		const t = getSettingsListTheme();
		// When theme is loaded, cursor is a styled string (non-empty, contains the
		// accent color ANSI sequence or at least the cursor glyph).
		expect(t.cursor.length).toBeGreaterThan(0);
	});
});
