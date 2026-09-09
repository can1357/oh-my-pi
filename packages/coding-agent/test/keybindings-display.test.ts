import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	getDefaultPasteImageKeys,
	KeybindingsManager,
	setKeyHintPlatform,
} from "@oh-my-pi/pi-coding-agent/config/keybindings";
import { keyText } from "@oh-my-pi/pi-coding-agent/extensibility/legacy-pi-coding-agent-shim";
import { getKeybindings, setKeybindings, type KeybindingsManager as TuiKeybindingsManager } from "@oh-my-pi/pi-tui";

describe("KeybindingsManager.getDisplayString", () => {
	beforeEach(() => setKeyHintPlatform("linux"));
	afterEach(() => setKeyHintPlatform(undefined));

	it("formats a single binding as a human-readable key hint", () => {
		const keybindings = KeybindingsManager.inMemory({
			"app.message.dequeue": "alt+up",
		});

		expect(keybindings.getDisplayString("app.message.dequeue")).toBe("Alt+Up");
	});

	it("defaults retry to F5 with the Alt+R fallback", () => {
		const keybindings = KeybindingsManager.inMemory();

		expect(keybindings.getDisplayString("app.retry")).toBe("F5/Alt+R");
	});

	it("formats multiple bindings with the existing separator", () => {
		const keybindings = KeybindingsManager.inMemory({
			"app.clipboard.copyPrompt": ["alt+shift+c", "ctrl+shift+c"],
		});

		expect(keybindings.getDisplayString("app.clipboard.copyPrompt")).toBe("Alt+Shift+C/Ctrl+Shift+C");
	});

	it("returns an empty string when the action has no binding", () => {
		const keybindings = KeybindingsManager.inMemory({
			"app.clipboard.copyPrompt": [],
		});

		expect(keybindings.getDisplayString("app.clipboard.copyPrompt")).toBe("");
	});

	it("renders macOS modifier labels for alt and super", () => {
		setKeyHintPlatform("darwin");
		const keybindings = KeybindingsManager.inMemory({
			"app.display.reset": "alt+l",
			"app.clipboard.pasteImage": ["ctrl+v", "super+v"],
		});

		expect(keybindings.getDisplayString("app.display.reset")).toBe("Option+L");
		expect(keybindings.getDisplayString("app.clipboard.pasteImage")).toBe("Ctrl+V/Cmd+V");
	});

	it("keeps Alt and Super labels off macOS", () => {
		setKeyHintPlatform("linux");
		const keybindings = KeybindingsManager.inMemory({
			"app.display.reset": "alt+l",
			"app.clipboard.pasteImage": ["ctrl+v", "super+v"],
		});

		expect(keybindings.getDisplayString("app.display.reset")).toBe("Alt+L");
		expect(keybindings.getDisplayString("app.clipboard.pasteImage")).toBe("Ctrl+V/Super+V");
	});
});

describe("legacy keyText", () => {
	let previous: TuiKeybindingsManager;

	beforeEach(() => {
		previous = getKeybindings();
		setKeyHintPlatform("linux");
	});

	afterEach(() => {
		setKeybindings(previous);
		setKeyHintPlatform(undefined);
	});

	it("formats the active binding for legacy extensions", () => {
		setKeybindings(KeybindingsManager.inMemory({ "app.tools.expand": "alt+e" }));

		expect(keyText("app.tools.expand")).toBe("Alt+E");
	});
});

describe("getDefaultPasteImageKeys", () => {
	it("keeps Ctrl+V registered for image paste on Windows alongside the terminal-safe fallback", () => {
		expect(getDefaultPasteImageKeys("win32")).toEqual(["ctrl+v", "alt+v"]);
	});

	it("adds the macOS Command key event to Ctrl+V for image paste", () => {
		expect(getDefaultPasteImageKeys("linux")).toEqual(["ctrl+v"]);
		expect(getDefaultPasteImageKeys("darwin")).toEqual(["ctrl+v", "super+v"]);
	});
});
