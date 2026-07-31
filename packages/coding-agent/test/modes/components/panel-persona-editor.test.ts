import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { setKeybindings, type TUI } from "@oh-my-pi/pi-tui";
import { KeybindingsManager } from "../../../src/config/keybindings";
import {
	type PanelPersonaEditorCallbacks,
	PanelPersonaEditorComponent,
} from "../../../src/modes/components/panel-persona-editor";
import { getThemeByName, setThemeInstance } from "../../../src/modes/theme/theme";

const DOWN = "\x1b[B";
const UP = "\x1b[A";
const ENTER = "\r";
const ESC = "\x1b";
const CTRL_Q = "\x11";
const BACKSPACE = "\x7f";

const darkTheme = await getThemeByName("dark");

interface Harness {
	component: PanelPersonaEditorComponent;
	callbacks: PanelPersonaEditorCallbacks;
}

function makeHarness(personasRaw: Readonly<Record<string, unknown>> | undefined): Harness {
	const tui = { requestRender: vi.fn() } as unknown as TUI;
	const callbacks: PanelPersonaEditorCallbacks = {
		save: vi.fn(),
		close: vi.fn(),
		notify: vi.fn(),
		requestRender: vi.fn(),
	};
	const component = new PanelPersonaEditorComponent(tui, personasRaw, callbacks);
	return { component, callbacks };
}

function render(component: PanelPersonaEditorComponent): string {
	return stripVTControlCharacters(component.render(120).join("\n"));
}

function type(component: PanelPersonaEditorComponent, text: string): void {
	for (const ch of text) component.handleInput(ch);
}

describe("PanelPersonaEditorComponent", () => {
	beforeAll(() => {
		if (!darkTheme) throw new Error("theme unavailable");
	});

	beforeEach(() => {
		setThemeInstance(darkTheme!);
		setKeybindings(KeybindingsManager.inMemory());
	});

	afterEach(() => {
		setKeybindings(KeybindingsManager.inMemory());
		vi.restoreAllMocks();
	});

	it("creates a persona, sets its required instructions, and persists only through explicit Save", () => {
		const { component, callbacks } = makeHarness(undefined);

		component.handleInput(ENTER); // "+ Add persona"
		type(component, "custom-1");
		component.handleInput(ENTER); // create -> opens detail

		component.handleInput(DOWN); // id -> label
		component.handleInput(DOWN); // label -> modes
		component.handleInput(DOWN); // modes -> instructions
		component.handleInput(ENTER); // open instructions editor
		type(component, "Investigate root cause carefully.");
		component.handleInput(CTRL_Q); // submit
		component.handleInput(ESC); // detail -> list

		expect(callbacks.save).not.toHaveBeenCalled();
		expect(render(component)).toContain("● unsaved");

		component.handleInput(DOWN); // persona row -> add
		component.handleInput(DOWN); // add -> save
		component.handleInput(ENTER); // Save personas

		expect(callbacks.save).toHaveBeenCalledWith({
			"custom-1": {
				label: "custom-1",
				modes: ["answer", "plan"],
				instructions: "Investigate root cause carefully.",
				tools: "workspace-read",
			},
		});
		expect(callbacks.notify).toHaveBeenCalledWith("Panel personas saved.");
		expect(render(component)).not.toContain("unsaved");
	});

	it("offers only none/workspace-read for tools and persists the updated choice on Save", () => {
		const { component, callbacks } = makeHarness({
			existing: { label: "Existing", modes: ["answer", "plan"], instructions: "Do work.", tools: "workspace-read" },
		});

		component.handleInput(ENTER); // persona row -> detail
		component.handleInput(DOWN); // id -> label
		component.handleInput(DOWN); // label -> modes
		component.handleInput(DOWN); // modes -> instructions
		component.handleInput(DOWN); // instructions -> tools
		component.handleInput(ENTER); // open tools picker

		const toolsScreen = render(component);
		expect(toolsScreen).toContain("(•) workspace-read");
		expect(toolsScreen).toContain("( ) none");
		expect(toolsScreen).not.toContain("read-write");

		component.handleInput(UP); // workspace-read -> none
		component.handleInput(ENTER); // pick "none"
		component.handleInput(ESC); // detail -> list

		component.handleInput(DOWN); // persona row -> add
		component.handleInput(DOWN); // add -> save
		component.handleInput(ENTER);

		expect(callbacks.save).toHaveBeenCalledWith({
			existing: { label: "Existing", modes: ["answer", "plan"], instructions: "Do work.", tools: "none" },
		});
	});

	it("deletes a persona and persists the resulting empty record on Save", () => {
		const { component, callbacks } = makeHarness({
			existing: { label: "Existing", modes: ["answer", "plan"], instructions: "Do work.", tools: "workspace-read" },
		});

		component.handleInput(ENTER); // persona row -> detail
		for (let i = 0; i < 5; i++) component.handleInput(DOWN); // id -> ... -> delete
		component.handleInput(ENTER); // delete this persona -> back to list

		expect(render(component)).not.toContain("Existing");

		component.handleInput(DOWN); // add -> save
		component.handleInput(ENTER);

		expect(callbacks.save).toHaveBeenCalledWith({});
	});

	it("blocks Done in the modes editor when every task mode is deselected", () => {
		const { component, callbacks } = makeHarness({
			existing: { label: "Existing", modes: ["answer", "plan"], instructions: "Do work.", tools: "workspace-read" },
		});

		component.handleInput(ENTER); // persona row -> detail
		component.handleInput(DOWN); // id -> label
		component.handleInput(DOWN); // label -> modes
		component.handleInput(ENTER); // open modes editor

		component.handleInput(ENTER); // toggle "answer" off (cursor starts on it)
		component.handleInput(DOWN); // -> "plan"
		component.handleInput(ENTER); // toggle "plan" off
		component.handleInput(DOWN); // -> "Done"
		component.handleInput(ENTER); // attempt Done with nothing selected

		expect(callbacks.notify).toHaveBeenCalledWith("Personas must support at least one task mode.");
		expect(render(component)).toContain("Enter / click toggle · Done apply · Esc discard");

		component.handleInput(ESC); // discard back to detail
		expect(render(component)).toContain("answer, plan");
	});

	it("rejects an empty new persona id", () => {
		const { component, callbacks } = makeHarness(undefined);
		component.handleInput(ENTER); // "+ Add persona"
		component.handleInput(ENTER); // submit empty id

		expect(callbacks.notify).toHaveBeenCalledWith("Persona id must be a non-empty string.");
		expect(render(component)).toContain("Type a new persona id");
	});

	it("rejects a reserved new persona id", () => {
		const { component, callbacks } = makeHarness(undefined);
		component.handleInput(ENTER); // "+ Add persona"
		type(component, "__proto__");
		component.handleInput(ENTER);

		expect(callbacks.notify).toHaveBeenCalledWith('Persona id "__proto__" is a reserved key name.');
	});

	it("rejects a duplicate new persona id", () => {
		const { component, callbacks } = makeHarness({
			existing: { label: "Existing", modes: ["answer", "plan"], instructions: "Do work.", tools: "workspace-read" },
		});
		component.handleInput(DOWN); // persona row -> add
		component.handleInput(ENTER); // "+ Add persona"
		type(component, "existing");
		component.handleInput(ENTER);

		expect(callbacks.notify).toHaveBeenCalledWith('Persona id "existing" already exists.');
	});

	it("quarantines a malformed entry, exposes its parse error, and saves it back unchanged", () => {
		const brokenRaw = { label: "Broken", modes: ["answer"], tools: "workspace-read" };
		const { component, callbacks } = makeHarness({
			ok: { label: "Ok", modes: ["answer", "plan"], instructions: "Do the thing.", tools: "workspace-read" },
			broken: brokenRaw,
		});

		const listView = render(component);
		expect(listView).toContain("⚠ broken");

		component.handleInput(DOWN); // ok -> broken
		component.handleInput(ENTER); // open quarantine screen (not editable)
		expect(render(component)).toContain("panel.personas.broken.instructions: must be a non-empty string");

		component.handleInput(ESC); // keep quarantined, back to list

		component.handleInput(DOWN); // ok -> broken
		component.handleInput(DOWN); // broken -> add
		component.handleInput(DOWN); // add -> save
		component.handleInput(ENTER);

		expect(callbacks.save).toHaveBeenCalledWith({
			ok: { label: "Ok", modes: ["answer", "plan"], instructions: "Do the thing.", tools: "workspace-read" },
			broken: brokenRaw,
		});
	});

	it("blocks Save when a valid entry is edited into an invalid shape until it is fixed or deleted", () => {
		const { component, callbacks } = makeHarness({
			ok: { label: "Ok", modes: ["answer", "plan"], instructions: "x", tools: "workspace-read" },
		});

		component.handleInput(ENTER); // persona row -> detail
		component.handleInput(DOWN); // id -> label
		component.handleInput(DOWN); // label -> modes
		component.handleInput(DOWN); // modes -> instructions
		component.handleInput(ENTER); // open instructions editor (prefilled "x")
		component.handleInput(BACKSPACE); // clear to empty
		component.handleInput(CTRL_Q); // submit empty instructions

		expect(callbacks.notify).toHaveBeenLastCalledWith("Instructions are required; save fails until they are set.");

		component.handleInput(ESC); // detail -> list
		component.handleInput(DOWN); // persona row -> add
		component.handleInput(DOWN); // add -> save
		component.handleInput(ENTER); // attempt Save with the now-invalid entry

		expect(callbacks.save).not.toHaveBeenCalled();
		expect(callbacks.notify).toHaveBeenLastCalledWith("panel.personas.ok.instructions: must be a non-empty string");
		expect(render(component)).toContain('Editing "ok"');
	});

	it("requires a second Close to discard unsaved edits, but closes immediately when clean", () => {
		const { component: dirtyComponent, callbacks: dirtyCallbacks } = makeHarness(undefined);
		dirtyComponent.handleInput(ENTER); // "+ Add persona"
		type(dirtyComponent, "custom-1");
		dirtyComponent.handleInput(ENTER); // create -> detail (dirty)
		dirtyComponent.handleInput(ESC); // detail -> list

		dirtyComponent.handleInput(ESC); // first Close attempt: warns instead of closing
		expect(dirtyCallbacks.notify).toHaveBeenCalledWith(
			"Unsaved persona edits: pick Save personas to keep them, or Close again to discard.",
		);
		expect(dirtyCallbacks.close).not.toHaveBeenCalled();

		dirtyComponent.handleInput(ESC); // second Close attempt: discards
		expect(dirtyCallbacks.close).toHaveBeenCalledTimes(1);

		const { component: cleanComponent, callbacks: cleanCallbacks } = makeHarness(undefined);
		cleanComponent.handleInput(ESC);
		expect(cleanCallbacks.close).toHaveBeenCalledTimes(1);
		expect(cleanCallbacks.notify).not.toHaveBeenCalled();
	});
});
