import { afterEach, describe, expect, it } from "bun:test";
import { KeybindingsManager, setKeybindings } from "@oh-my-pi/pi-coding-agent/config/keybindings/keybindings";
import { listKeyId, selectKeyId } from "@oh-my-pi/pi-coding-agent/config/keybindings/matchers";
import { widgetKeys } from "@oh-my-pi/pi-tui/term/keymap";

afterEach(() => {
	setKeybindings(KeybindingsManager.inMemory());
});

describe("pi-tui widget keymap", () => {
	it("follows the active keymap's tui bindings as key event ids", () => {
		setKeybindings(
			KeybindingsManager.inMemory({
				"tui.select.down": "ctrl+n",
				"tui.select.pageUp": "ctrl+pageUp",
				"tui.editor.deleteWordBackward": "super+alt+backspace",
				"tui.input.newLine": [],
			}),
		);
		expect(widgetKeys("select.down")).toEqual(["ctrl+n"]);
		expect(widgetKeys("select.pageUp")).toEqual(["ctrl+pageUp"]);
		expect(widgetKeys("editor.deleteWordBackward")).toEqual(["alt+super+backspace"]);
		expect(widgetKeys("editor.newLine")).toEqual([]);
		expect(widgetKeys("select.cancel")).toEqual(["escape", "ctrl+c"]);
	});

	it("re-applies when the active keymap's bindings change", () => {
		const keybindings = KeybindingsManager.inMemory();
		setKeybindings(keybindings);
		expect(widgetKeys("select.up")).toEqual(["up"]);
		keybindings.setUserBindings({ "tui.select.up": "ctrl+p" });
		expect(widgetKeys("select.up")).toEqual(["ctrl+p"]);
		// A keymap that is not the active one leaves the widgets alone.
		KeybindingsManager.inMemory({ "tui.select.up": "alt+k" });
		expect(widgetKeys("select.up")).toEqual(["ctrl+p"]);
	});
});

describe("selector key ids", () => {
	it("recognizes swapped cancel/confirm chords by what was pressed, not the translated key", () => {
		const bindings = KeybindingsManager.inMemory({ "tui.select.cancel": "enter", "tui.select.confirm": "escape" });
		expect(listKeyId("escape", bindings)).toBe("enter");
		expect(listKeyId("enter", bindings)).toBe("escape");
	});
	it("read remapped keys as the action's default id and moved defaults as nothing", () => {
		setKeybindings(KeybindingsManager.inMemory({ "tui.select.down": "ctrl+n", "tui.select.cancel": "ctrl+g" }));
		expect(selectKeyId("ctrl+n")).toBe("down");
		expect(selectKeyId("down")).toBe("");
		expect(selectKeyId("up")).toBe("up");
		expect(selectKeyId("tab")).toBe("tab");
		expect(listKeyId("ctrl+g")).toBe("escape");
		expect(listKeyId("escape")).toBe("");
		expect(listKeyId("ctrl+n")).toBe("down");
	});
});
