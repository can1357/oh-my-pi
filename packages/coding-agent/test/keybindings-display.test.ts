import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	getKeybindings,
	KeybindingsManager,
	setKeybindings,
} from "@oh-my-pi/pi-coding-agent/config/keybindings/keybindings";
import { keyText } from "@oh-my-pi/pi-coding-agent/extensibility/legacy-pi-coding-agent-shim";
import { setKeyHintPlatform } from "@oh-my-pi/pi-coding-agent/ui/keys/format";

describe("legacy keyText", () => {
	let previous: KeybindingsManager;

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
