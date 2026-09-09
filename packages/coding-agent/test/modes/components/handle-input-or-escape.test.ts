import { afterEach, describe, expect, it } from "bun:test";
import { handleInputOrEscape } from "@oh-my-pi/pi-coding-agent/modes/components/plugin-settings";
import { setKittyProtocolActive } from "@oh-my-pi/pi-tui";

afterEach(() => {
	setKittyProtocolActive(false);
});

describe("handleInputOrEscape", () => {
	it("cancels on a kitty CSI-u escape (the fullscreen settings overlay encoding)", () => {
		// Ghostty/kitty report Escape as `\x1b[27u` once the keyboard protocol is
		// active (which it is inside the fullscreen settings overlay). A raw `\x1b`
		// compare misses it, so Esc looked dead in the text-input submenu.
		setKittyProtocolActive(true);
		let cancelled = false;
		const forwarded: string[] = [];
		handleInputOrEscape("\x1b[27u", { handleInput: data => forwarded.push(data) }, () => {
			cancelled = true;
		});
		expect(cancelled).toBe(true);
		expect(forwarded).toEqual([]);
	});

	it("cancels on a legacy bare escape", () => {
		let cancelled = false;
		const forwarded: string[] = [];
		handleInputOrEscape("\x1b", { handleInput: data => forwarded.push(data) }, () => {
			cancelled = true;
		});
		expect(cancelled).toBe(true);
		expect(forwarded).toEqual([]);
	});

	it("forwards a printable keystroke to the input instead of cancelling", () => {
		setKittyProtocolActive(true);
		let cancelled = false;
		const forwarded: string[] = [];
		handleInputOrEscape("g", { handleInput: data => forwarded.push(data) }, () => {
			cancelled = true;
		});
		expect(cancelled).toBe(false);
		expect(forwarded).toEqual(["g"]);
	});
});
