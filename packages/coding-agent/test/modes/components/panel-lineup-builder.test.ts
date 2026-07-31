import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { setKeybindings, type TUI } from "@oh-my-pi/pi-tui";
import { KeybindingsManager } from "../../../src/config/keybindings";
import { Settings } from "../../../src/config/settings";
import {
	type PanelLineupBuilderCallbacks,
	PanelLineupBuilderOverlayComponent,
} from "../../../src/modes/components/panel-lineup-builder";
import { getThemeByName, setThemeInstance } from "../../../src/modes/theme/theme";
import type { PanelPersona, PanelSettings } from "../../../src/panel/types";

const DOWN = "\x1b[B";
const UP = "\x1b[A";
const ENTER = "\r";
const ESC = "\x07";

const darkTheme = await getThemeByName("dark");

function makeModel(provider: string, id: string): Model {
	return buildModel({
		id,
		name: id,
		api: "mock",
		provider,
		baseUrl: "mock://",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 32_768,
	});
}

const ANTHROPIC_A = makeModel("anthropic-fam", "claude-opus-4-7");
const ANTHROPIC_B = makeModel("anthropic-fam2", "claude-opus-4-8");
const OPENAI = makeModel("openai-fam", "gpt-5.4");
const GEMINI = makeModel("gemini-fam", "gemini-3-pro");
const GLM = makeModel("glm-fam", "glm-5.2");

function selectorOf(model: Model): string {
	return `${model.provider}/${model.id}`;
}

function panelSettings(personas: Readonly<Record<string, PanelPersona>> = {}): PanelSettings {
	return { defaultRole: undefined, roles: {}, personas };
}

interface Harness {
	component: PanelLineupBuilderOverlayComponent;
	callbacks: PanelLineupBuilderCallbacks;
}

function makeHarness(
	models: readonly Model[],
	options?: { personas?: Readonly<Record<string, PanelPersona>> },
): Harness {
	const tui = { terminal: { rows: 40 }, requestRender: vi.fn() } as unknown as TUI;
	const callbacks: PanelLineupBuilderCallbacks = {
		onSubmit: vi.fn(async () => {}),
		onAbort: vi.fn(async () => {}),
		onClose: vi.fn(),
		notify: vi.fn(),
		requestRender: vi.fn(),
	};
	const component = new PanelLineupBuilderOverlayComponent(
		tui,
		{ modelRegistry: {} as never, settings: Settings.isolated({}), scopedModels: models.map(model => ({ model })) },
		{ panelSettings: panelSettings(options?.personas), taskMode: "answer", request: "Investigate the outage." },
		callbacks,
	);
	return { component, callbacks };
}

function render(component: PanelLineupBuilderOverlayComponent): string {
	return stripVTControlCharacters(component.render(140).join("\n"));
}

/** Assumes the list cursor is on the "+ Add member" row. */
function addMember(component: PanelLineupBuilderOverlayComponent, selector: string): void {
	component.handleInput(ENTER);
	for (const ch of selector) component.handleInput(ch);
	component.handleInput(ENTER);
}

/** Assumes the list cursor is on the "+ Add member" row and the strategy is `personas`. */
function addPersonaMember(component: PanelLineupBuilderOverlayComponent, selector: string, personaDowns = 0): void {
	component.handleInput(ENTER);
	for (const ch of selector) component.handleInput(ch);
	component.handleInput(ENTER); // activate model -> persona picker
	for (let i = 0; i < personaDowns; i++) component.handleInput(DOWN);
	component.handleInput(ENTER); // pick persona
}

describe("PanelLineupBuilderOverlayComponent", () => {
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

	it("blocks Run below two members and never dispatches", () => {
		const { component, callbacks } = makeHarness([ANTHROPIC_A, OPENAI]);
		component.handleInput(DOWN); // add -> run (0 members)
		component.handleInput(ENTER);
		expect(callbacks.notify).toHaveBeenCalledWith("Panel lineup: needs at least 2 members (0 configured)");
		expect(callbacks.onSubmit).not.toHaveBeenCalled();
	});

	it("dispatches the exact frozen lineup once two independent members clear family diversity", async () => {
		const { component, callbacks } = makeHarness([ANTHROPIC_A, OPENAI]);
		addMember(component, selectorOf(ANTHROPIC_A));
		component.handleInput(DOWN); // member row -> add row
		addMember(component, selectorOf(OPENAI));
		component.handleInput(DOWN);
		component.handleInput(DOWN); // member row -> add -> run
		component.handleInput(ENTER);
		await Promise.resolve();

		expect(callbacks.onSubmit).toHaveBeenCalledTimes(1);
		expect(callbacks.onSubmit).toHaveBeenCalledWith({
			strategy: "independent",
			members: [{ model: selectorOf(ANTHROPIC_A) }, { model: selectorOf(OPENAI) }],
		});
		expect(callbacks.notify).not.toHaveBeenCalled();
	});

	it("aborts a deferred panel submission once and keeps other controls locked until it settles", async () => {
		const { component, callbacks } = makeHarness([ANTHROPIC_A, OPENAI]);
		let release: (() => void) | undefined;
		callbacks.onSubmit = vi.fn(
			() =>
				new Promise<void>(resolve => {
					release = resolve;
				}),
		);
		addMember(component, selectorOf(ANTHROPIC_A));
		component.handleInput(DOWN);
		addMember(component, selectorOf(OPENAI));
		component.handleInput(DOWN);
		component.handleInput(DOWN);
		component.handleInput(ENTER);
		await Promise.resolve();

		component.handleInput(ESC);
		component.handleInput(ESC);
		expect(callbacks.onAbort).toHaveBeenCalledTimes(1);
		expect(render(component)).toContain("Cancelling panel");
		component.handleInput(DOWN);
		component.handleInput(ENTER);
		expect(callbacks.onClose).not.toHaveBeenCalled();
		expect(render(component)).not.toContain("Close");

		if (!release) throw new Error("panel submit did not begin");
		release();
		await Promise.resolve();
		await Promise.resolve();

		component.handleInput(DOWN);
		component.handleInput(ENTER);
		expect(callbacks.onClose).toHaveBeenCalledTimes(1);
	});

	it("blocks Run when two independent members share a model family", () => {
		const { component, callbacks } = makeHarness([ANTHROPIC_A, ANTHROPIC_B]);
		addMember(component, selectorOf(ANTHROPIC_A));
		component.handleInput(DOWN);
		addMember(component, selectorOf(ANTHROPIC_B));
		component.handleInput(DOWN);
		component.handleInput(DOWN);
		component.handleInput(ENTER);

		expect(callbacks.notify).toHaveBeenCalledWith('Panel lineup: members 1 and 2 share the "anthropic" model family');
		expect(callbacks.onSubmit).not.toHaveBeenCalled();
	});

	it("caps the lineup at four members and hides the add row once full", () => {
		const { component } = makeHarness([ANTHROPIC_A, OPENAI, GEMINI, GLM]);
		addMember(component, selectorOf(ANTHROPIC_A));
		component.handleInput(DOWN);
		addMember(component, selectorOf(OPENAI));
		component.handleInput(DOWN);
		addMember(component, selectorOf(GEMINI));
		component.handleInput(DOWN);
		addMember(component, selectorOf(GLM));

		const out = render(component);
		expect(out).not.toContain("+ Add member");
		expect(out).toContain("Member 4");
	});

	it("filters persona choices by task mode and forwards the exact persona lineup on Run", async () => {
		const { component, callbacks } = makeHarness([ANTHROPIC_A, OPENAI], {
			personas: {
				"planner-only": { label: "Planner", modes: ["plan"], instructions: "plan only", tools: "none" },
			},
		});
		component.handleInput(UP); // add -> strategy
		component.handleInput(ENTER); // toggle to personas
		component.handleInput(DOWN); // strategy -> add

		component.handleInput(ENTER); // open model browser
		for (const ch of selectorOf(ANTHROPIC_A)) component.handleInput(ch);
		component.handleInput(ENTER); // activate model -> persona picker

		const personaScreen = render(component);
		expect(personaScreen).toContain("analyst");
		expect(personaScreen).toContain("workspace read");
		expect(personaScreen).not.toContain("planner-only");

		component.handleInput(ENTER); // pick "analyst" (first eligible choice)
		component.handleInput(DOWN); // member row -> add row
		addPersonaMember(component, selectorOf(OPENAI), 1); // pick "implementer" (second eligible choice)

		component.handleInput(DOWN);
		component.handleInput(DOWN); // member row -> add -> run
		component.handleInput(ENTER);
		await Promise.resolve();

		expect(callbacks.onSubmit).toHaveBeenCalledWith({
			strategy: "personas",
			members: [
				{ model: selectorOf(ANTHROPIC_A), persona: "analyst" },
				{ model: selectorOf(OPENAI), persona: "implementer" },
			],
		});
	});
});
