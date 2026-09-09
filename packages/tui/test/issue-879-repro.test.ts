import { describe, expect, it } from "bun:test";
import { matchesKey, parseKey, setKittyProtocolActive } from "@oh-my-pi/pi-tui/keys";

// Issue #879: On Windows (legacy keyboard mode), pressing Alt+Shift+P emits
// the two-byte sequence ESC + 'P' (0x1B 0x50). The native key parser only
// recognised legacy `Alt+letter` for lowercase ASCII, so neither
// `matchesKey("\x1bP", "alt+shift+p")` nor `parseKey("\x1bP")` resolved the
// shortcut, breaking the `app.plan.toggle` keybinding on Windows Terminal.
describe("issue #879: legacy Alt+Shift+letter parsing", () => {
	it("matchesKey accepts ESC+UPPERCASE as alt+shift+<letter> in legacy mode", () => {
		setKittyProtocolActive(false);
		expect(matchesKey("\x1bP", "alt+shift+p")).toBe(true);
		// Order of modifiers in keyId must not matter.
		expect(matchesKey("\x1bP", "shift+alt+p")).toBe(true);
		// A different uppercase letter must not match alt+shift+p.
		expect(matchesKey("\x1bQ", "alt+shift+p")).toBe(false);
		// Lowercase ESC pair is still alt+<letter>, not alt+shift+<letter>.
		expect(matchesKey("\x1bp", "alt+shift+p")).toBe(false);
		expect(matchesKey("\x1bp", "alt+p")).toBe(true);
	});

	it("parseKey reports alt+shift+<letter> for ESC+UPPERCASE in legacy mode", () => {
		setKittyProtocolActive(false);
		expect(parseKey("\x1bP")).toBe("alt+shift+p");
		expect(parseKey("\x1bA")).toBe("alt+shift+a");
		expect(parseKey("\x1bZ")).toBe("alt+shift+z");
	});
});
