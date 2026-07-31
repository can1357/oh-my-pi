import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { setKeybindings } from "@oh-my-pi/pi-tui";
import { KeybindingsManager } from "../../../src/config/keybindings";
import { PanelRolePickerComponent } from "../../../src/modes/components/panel-role-picker";
import { getThemeByName, setThemeInstance } from "../../../src/modes/theme/theme";
import type { PanelRole } from "../../../src/panel/types";

const DOWN = "\x1b[B";
const ENTER = "\r";
const CANCEL = "\x07";

const darkTheme = await getThemeByName("dark");

function render(component: PanelRolePickerComponent): string {
	return stripVTControlCharacters(component.render(100).join("\n"));
}

function roles(): Record<string, PanelRole> {
	return {
		frontier: {
			strategy: "independent",
			members: [{ model: "anthropic/claude-opus-4-7" }, { model: "openai/gpt-5.5" }],
		},
		quick: {
			strategy: "personas",
			members: [{ model: "openai/gpt-5.5", persona: "analyst" }],
		},
	};
}

describe("PanelRolePickerComponent", () => {
	beforeAll(() => {
		if (!darkTheme) throw new Error("theme unavailable");
	});

	beforeEach(() => {
		setThemeInstance(darkTheme!);
		setKeybindings(KeybindingsManager.inMemory({ "tui.select.cancel": "ctrl+g" }));
	});

	afterEach(() => {
		setKeybindings(KeybindingsManager.inMemory());
		vi.restoreAllMocks();
	});

	it("keeps configured rows stable and marks and preselects the default role", () => {
		const onSelect = vi.fn();
		const component = new PanelRolePickerComponent({
			roles: roles(),
			defaultRole: "frontier",
			onSelect,
			onCancel: vi.fn(),
		});

		const out = render(component);
		expect(out.indexOf("frontier ✓")).toBeLessThan(out.indexOf("quick"));
		expect(out).toContain("default · independent · 2 members");
		expect(out).toContain("personas · 1 member");
		expect(component.getSelectList().getSelectedItem()?.value).toBe("frontier");

		component.getSelectList().handleInput(ENTER);
		expect(onSelect).toHaveBeenCalledTimes(1);
		expect(onSelect).toHaveBeenCalledWith("frontier");
	});

	it("forwards the selected role and cancels without selecting", () => {
		const onSelect = vi.fn();
		const onCancel = vi.fn();
		const component = new PanelRolePickerComponent({
			roles: roles(),
			onSelect,
			onCancel,
		});

		component.getSelectList().handleInput(DOWN);
		component.getSelectList().handleInput(ENTER);
		expect(onSelect).toHaveBeenCalledWith("quick");

		const cancelled = new PanelRolePickerComponent({ roles: roles(), onSelect, onCancel });
		cancelled.getSelectList().handleInput(CANCEL);
		expect(onCancel).toHaveBeenCalledTimes(1);
		expect(onSelect).toHaveBeenCalledTimes(1);
	});
});
