import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { setKeybindings } from "@oh-my-pi/pi-tui";
import { KeybindingsManager } from "../../../src/config/keybindings";
import { PanelConfirmationComponent } from "../../../src/modes/components/panel-confirmation";
import { getThemeByName, setThemeInstance } from "../../../src/modes/theme/theme";

const DOWN = "\x1b[B";
const ENTER = "\r";
const CANCEL = "\x07";
const darkTheme = await getThemeByName("dark");

describe("PanelConfirmationComponent", () => {
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

	it("renders a resolved lineup and confirms the explicit primary action", () => {
		const onConfirm = vi.fn();
		const component = new PanelConfirmationComponent({
			title: "Run panel?",
			details: ["Role: @frontier · independent", "1. anthropic/claude-opus-4-5"],
			confirmLabel: "Run 2-member panel",
			cancelLabel: "Cancel",
			onConfirm,
			onCancel: vi.fn(),
		});

		expect(stripVTControlCharacters(component.render(100).join("\n"))).toContain("Role: @frontier · independent");
		component.getSelectList().handleInput(ENTER);
		expect(onConfirm).toHaveBeenCalledTimes(1);
	});

	it("takes the cancel path for the secondary action and Escape", () => {
		const onCancel = vi.fn();
		const component = new PanelConfirmationComponent({
			title: "Panel cancelled",
			details: ["1 completed · 0 failed · 1 aborted"],
			confirmLabel: "Synthesize partial results",
			cancelLabel: "Discard partial results",
			onConfirm: vi.fn(),
			onCancel,
		});

		component.getSelectList().handleInput(DOWN);
		component.getSelectList().handleInput(ENTER);
		expect(onCancel).toHaveBeenCalledTimes(1);

		const escaped = new PanelConfirmationComponent({
			title: "Panel cancelled",
			details: [],
			confirmLabel: "Synthesize partial results",
			cancelLabel: "Discard partial results",
			onConfirm: vi.fn(),
			onCancel,
		});
		escaped.getSelectList().handleInput(CANCEL);
		expect(onCancel).toHaveBeenCalledTimes(2);
	});
});
