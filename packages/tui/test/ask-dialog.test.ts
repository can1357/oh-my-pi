import type { ImageContent } from "@oh-my-pi/pi-ai";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { KeybindingsManager } from "@oh-my-pi/pi-tui/app-keybindings";
import type { ExtensionAskDialogQuestion } from "@oh-my-pi/pi-tui/overlays/ask-dialog";
import { AskDialogComponent } from "@oh-my-pi/pi-tui/overlays/ask-dialog";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-tui/theme";
import { setKeybindings, type TerminalFrameProvider } from "@oh-my-pi/pi-tui";
import type { NativeSurfaceProvider, NativeUiEvent } from "../src/native/node";
import { TspHarness } from "./native/tsp-harness";

const DOWN = "\x1b[B";
const UP = "\x1b[A";
const PAGE_DOWN = "\x1b[6~";
const PAGE_UP = "\x1b[5~";
const ENTER = "\n";
const CANCEL = "\x07";
const SPACE = " ";
const TAB = "\t";
const SHIFT_TAB = "\x1b[Z";

let darkTheme = await getThemeByName("dark");

function render(component: AskDialogComponent): string {
	return stripVTControlCharacters(component.render(80).join("\n"));
}

describe("AskDialogComponent", () => {
	beforeAll(async () => {
		darkTheme = await getThemeByName("dark");
		if (!darkTheme) throw new Error("Failed to load dark theme");
	});

	beforeEach(() => {
		setThemeInstance(darkTheme!);
		setKeybindings(KeybindingsManager.inMemory({ "tui.select.cancel": "ctrl+g" }));
	});

	afterEach(() => {
		setKeybindings(KeybindingsManager.inMemory());
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("draws no footer: the key hints come from keyHints() for the host's composer", () => {
		const questions: ExtensionAskDialogQuestion[] = [
			{ id: "q1", question: "First?", options: [{ label: "A1" }, { label: "A2" }] },
			{ id: "q2", question: "Second?", options: [{ label: "B1" }, { label: "B2" }] },
		];
		const component = new AskDialogComponent(questions, {
			onSubmit: vi.fn(),
			onCancel: vi.fn(),
			onPrompt: vi.fn(),
		});
		const lines = component.render(80).map(line => stripVTControlCharacters(line));
		// The panel ends with its body: no divider, no hint row.
		expect(lines.some(line => line.startsWith("├"))).toBe(false);
		expect(lines.some(line => line.includes("select"))).toBe(false);
		expect(lines.at(-1)).toMatch(/^╰─+╯$/);
		const hints = stripVTControlCharacters(component.keyHints());
		expect(hints).toContain("⏎ select · n note · ↑/↓ move · ⇥/←/→ question · ");
		expect(hints).toContain("composer");
		expect(hints).not.toContain("cancel");
	});

	it("key hints say edit instead of note while Other is highlighted", () => {
		const component = new AskDialogComponent(
			[{ id: "q1", question: "Choose one?", options: [{ label: "A1" }, { label: "A2" }] }],
			{ onSubmit: vi.fn(), onCancel: vi.fn(), onPrompt: vi.fn() },
		);
		expect(stripVTControlCharacters(component.keyHints())).toContain("n note");
		component.handleInput(DOWN);
		component.handleInput(DOWN);
		const hints = stripVTControlCharacters(component.keyHints());
		expect(hints).toContain("n edit");
		expect(hints).not.toContain("n note");
	});

	it("single-question, single-select: Enter on option submits immediately", () => {
		const onSubmit = vi.fn();
		const onCancel = vi.fn();
		const onPrompt = vi.fn();

		const questions: ExtensionAskDialogQuestion[] = [
			{
				id: "q1",
				question: "Choose one?",
				options: [{ label: "Option A" }, { label: "Option B" }],
			},
		];

		const component = new AskDialogComponent(questions, {
			onSubmit,
			onCancel,
			onPrompt,
		});

		component.handleInput(ENTER);

		expect(onSubmit).toHaveBeenCalledTimes(1);
		expect(onSubmit.mock.calls[0][0]).toEqual({
			kind: "submit",
			results: [
				{
					id: "q1",
					question: "Choose one?",
					options: ["Option A", "Option B"],
					multi: false,
					selectedOptions: ["Option A"],
					customInput: undefined,
					note: undefined,
					timedOut: undefined,
				},
			],
		});
	});

	it("single-question, single-select: Space does not submit the highlighted answer", () => {
		const onSubmit = vi.fn();
		const questions: ExtensionAskDialogQuestion[] = [
			{
				id: "q1",
				question: "Choose one?",
				options: [{ label: "Option A" }, { label: "Option B" }],
			},
		];
		const component = new AskDialogComponent(questions, {
			onSubmit,
			onCancel: vi.fn(),
			onPrompt: vi.fn(),
		});

		component.handleInput(SPACE);
		expect(onSubmit).not.toHaveBeenCalled();

		component.handleInput(ENTER);
		expect(onSubmit).toHaveBeenCalledTimes(1);
		expect(onSubmit.mock.calls[0][0].results[0].selectedOptions).toEqual(["Option A"]);
	});

	it("single-question, single-select: DOWN then Enter selects second option and submits", () => {
		const onSubmit = vi.fn();
		const onCancel = vi.fn();
		const onPrompt = vi.fn();

		const questions: ExtensionAskDialogQuestion[] = [
			{
				id: "q1",
				question: "Choose one?",
				options: [{ label: "Option A" }, { label: "Option B" }],
			},
		];

		const component = new AskDialogComponent(questions, {
			onSubmit,
			onCancel,
			onPrompt,
		});

		component.handleInput(DOWN);
		component.handleInput(ENTER);

		expect(onSubmit).toHaveBeenCalledTimes(1);
		expect(onSubmit.mock.calls[0][0].results[0].selectedOptions).toEqual(["Option B"]);
	});

	it("multi-question, single-select: Enter opens the next question, and on the last one submits", () => {
		const onSubmit = vi.fn();
		const onCancel = vi.fn();
		const onPrompt = vi.fn();

		const questions: ExtensionAskDialogQuestion[] = [
			{
				id: "q1",
				question: "Q1?",
				options: [{ label: "A1" }, { label: "B1" }],
			},
			{
				id: "q2",
				question: "Q2?",
				options: [{ label: "A2" }, { label: "B2" }],
			},
		];

		const component = new AskDialogComponent(questions, {
			onSubmit,
			onCancel,
			onPrompt,
		});

		// Enter on A1 opens Q2, without submitting.
		component.handleInput(ENTER);
		expect(onSubmit).not.toHaveBeenCalled();
		expect(render(component)).toContain("❯ ○ A2");

		// On Q2, the last question with every one answered: Enter on B2 submits.
		component.handleInput(DOWN);
		component.handleInput(ENTER);
		expect(onSubmit).toHaveBeenCalledTimes(1);
		expect(onSubmit.mock.calls[0][0].results).toEqual([
			{
				id: "q1",
				question: "Q1?",
				options: ["A1", "B1"],
				multi: false,
				selectedOptions: ["A1"],
				customInput: undefined,
				note: undefined,
				timedOut: undefined,
			},
			{
				id: "q2",
				question: "Q2?",
				options: ["A2", "B2"],
				multi: false,
				selectedOptions: ["B2"],
				customInput: undefined,
				note: undefined,
				timedOut: undefined,
			},
		]);
	});

	it("multi-select: Space toggles options; Enter submits the current selection", () => {
		const onSubmit = vi.fn();
		const onCancel = vi.fn();
		const onPrompt = vi.fn();

		const questions: ExtensionAskDialogQuestion[] = [
			{
				id: "q1",
				question: "Choose multiple?",
				options: [{ label: "Option A" }, { label: "Option B" }],
				multi: true,
			},
		];

		const component = new AskDialogComponent(questions, {
			onSubmit,
			onCancel,
			onPrompt,
		});

		// Space toggles without submitting.
		component.handleInput(SPACE);
		expect(onSubmit).not.toHaveBeenCalled();

		// Space again toggles the same option back off.
		component.handleInput(SPACE);
		expect(onSubmit).not.toHaveBeenCalled();

		// Space once more re-selects it.
		component.handleInput(SPACE);
		expect(onSubmit).not.toHaveBeenCalled();

		// Enter submits the current selection without toggling the focused
		// option (issue #8252).
		component.handleInput(ENTER);

		expect(onSubmit).toHaveBeenCalledTimes(1);
		expect(onSubmit.mock.calls[0][0].results[0].selectedOptions).toEqual(["Option A"]);
	});

	it("multi-select: intrinsic Recommended suffix visibly follows selection state", () => {
		const onSubmit = vi.fn();
		const component = new AskDialogComponent(
			[
				{
					id: "target",
					question: "Choose multiple?",
					options: [{ label: "Generic MLE loop (Recommended)" }, { label: "Amazon-style (LPs)" }],
					multi: true,
				},
			],
			{ onSubmit, onCancel: vi.fn(), onPrompt: vi.fn() },
		);

		component.handleInput(SPACE);
		expect(render(component)).toContain("❯ ☑ Generic MLE loop (Recommended)");

		component.handleInput(SPACE);
		expect(render(component)).toContain("❯ ☐ Generic MLE loop (Recommended)");

		component.handleInput(SPACE);
		component.handleInput(ENTER);
		expect(onSubmit.mock.calls[0][0].results[0].selectedOptions).toEqual(["Generic MLE loop (Recommended)"]);
	});

	it("renders an intrinsic Recommended suffix only once for the recommended option", () => {
		const component = new AskDialogComponent(
			[
				{
					id: "target",
					question: "Choose one?",
					options: [{ label: "Generic MLE loop (Recommended)" }, { label: "Amazon-style (LPs)" }],
					recommended: 0,
				},
			],
			{ onSubmit: vi.fn(), onCancel: vi.fn(), onPrompt: vi.fn() },
		);

		expect(render(component)).toContain("Generic MLE loop (Recommended)");
		expect(render(component)).not.toContain("Generic MLE loop (Recommended) (Recommended)");
	});

	it("keeps an answer when its question is left and opened again", () => {
		const onSubmit = vi.fn();
		const onCancel = vi.fn();
		const onPrompt = vi.fn();

		const questions: ExtensionAskDialogQuestion[] = [
			{
				id: "q1",
				question: "Q1?",
				options: [{ label: "A1" }, { label: "B1" }],
			},
			{
				id: "q2",
				question: "Q2?",
				options: [{ label: "A2" }, { label: "B2" }],
			},
		];

		const component = new AskDialogComponent(questions, {
			onSubmit,
			onCancel,
			onPrompt,
		});

		// Enter on A1 selects it and opens Q2.
		component.handleInput(ENTER);

		// Shift+Tab back to Q1: its answer is still checked.
		component.handleInput(SHIFT_TAB);
		expect(render(component)).toContain("❯ ◉ A1");

		// Enter keeps it and opens Q2 again; B2 there submits.
		component.handleInput(ENTER);
		component.handleInput(DOWN);
		component.handleInput(ENTER);

		expect(onSubmit).toHaveBeenCalledTimes(1);
		expect(onSubmit.mock.calls[0][0].results[0].selectedOptions).toEqual(["A1"]);
		expect(onSubmit.mock.calls[0][0].results[1].selectedOptions).toEqual(["B2"]);
	});

	it("Tab and Shift+Tab open the next and previous question; Tab stops at the last", () => {
		const questions: ExtensionAskDialogQuestion[] = [
			{ id: "q1", question: "Q1?", options: [{ label: "A1" }, { label: "B1" }] },
			{ id: "q2", question: "Q2?", options: [{ label: "A2" }, { label: "B2" }] },
		];
		const component = new AskDialogComponent(questions, {
			onSubmit: vi.fn(),
			onCancel: vi.fn(),
			onPrompt: vi.fn(),
		});

		component.handleInput(TAB);
		expect(render(component)).toContain("❯ ○ A2");
		component.handleInput(TAB);
		expect(render(component)).toContain("❯ ○ A2");
		component.handleInput(SHIFT_TAB);
		expect(render(component)).toContain("❯ ○ A1");
		expect(render(component)).not.toContain("❯ ○ A2");
	});

	it("Enter on the last question opens the first unanswered one instead of submitting", () => {
		const onSubmit = vi.fn();
		const questions: ExtensionAskDialogQuestion[] = [
			{ id: "q1", question: "First?", options: [{ label: "A1" }, { label: "B1" }] },
			{ id: "q2", question: "Second?", options: [{ label: "A2" }, { label: "B2" }] },
			{ id: "q3", question: "Third?", options: [{ label: "A3" }, { label: "B3" }] },
		];
		const component = new AskDialogComponent(questions, {
			onSubmit,
			onCancel: vi.fn(),
			onPrompt: vi.fn(),
		});

		component.handleInput(TAB);
		component.handleInput(TAB);
		component.handleInput(ENTER); // A3 on the last question; First? and Second? have no answer
		expect(onSubmit).not.toHaveBeenCalled();
		const output = render(component);
		expect(output).toContain("❯ ○ A1");
		expect(output).toContain("✓ Third?");

		component.handleInput(ENTER); // A1, on to Second?
		component.handleInput(ENTER); // A2, on to Third?
		expect(onSubmit).not.toHaveBeenCalled();
		component.handleInput(ENTER); // A3 again, every question answered: submits
		expect(onSubmit).toHaveBeenCalledTimes(1);
		expect(
			onSubmit.mock.calls[0][0].results.map((result: { selectedOptions: string[] }) => result.selectedOptions),
		).toEqual([["A1"], ["A2"], ["A3"]]);
	});

	it("Esc hands the keys to the composer without cancelling", () => {
		const onCancel = vi.fn();
		const releaseKeys = vi.fn();
		const questions: ExtensionAskDialogQuestion[] = [
			{
				id: "q1",
				question: "Choose one?",
				options: [{ label: "Option A" }],
			},
		];

		const component = new AskDialogComponent(
			questions,
			{ onSubmit: vi.fn(), onCancel, onPrompt: vi.fn() },
			{ releaseKeys },
		);

		component.handleInput(CANCEL);
		expect(releaseKeys).toHaveBeenCalledTimes(1);
		expect(onCancel).not.toHaveBeenCalled();
		// The ask stays pending: it still answers once the keys come back.
		expect(render(component)).toContain("❯ ○ Option A");
	});

	it("n on an option calls onPrompt and stores note with marker", async () => {
		const onPrompt = vi.fn().mockReturnValue(Promise.resolve("My Custom Note"));
		const onSubmit = vi.fn();
		const questions: ExtensionAskDialogQuestion[] = [
			{
				id: "q1",
				question: "Choose one?",
				options: [{ label: "Option A" }],
			},
		];

		const component = new AskDialogComponent(questions, {
			onSubmit,
			onCancel: vi.fn(),
			onPrompt,
		});

		// Highlight is on Option A. Press 'n'.
		component.handleInput("n");

		// Await microtasks so the async #promptForNote runs
		await Promise.resolve();
		await Promise.resolve();

		expect(onPrompt).toHaveBeenCalledTimes(1);
		expect(onPrompt.mock.calls[0][0]).toEqual({ title: "Note for Option A", question: "Choose one?" });

		// Verify note is saved by submitting
		component.handleInput(ENTER);

		expect(onSubmit).toHaveBeenCalledTimes(1);
		expect(onSubmit.mock.calls[0][0].results[0].note).toBe("My Custom Note");
	});

	it("drops note images together with the note when that option is deselected", async () => {
		const image: ImageContent = { type: "image", data: "image-data", mimeType: "image/png" };
		const onSubmit = vi.fn();
		const component = new AskDialogComponent(
			[{ id: "q1", question: "Choose?", multi: true, options: [{ label: "Option A" }] }],
			{
				onSubmit,
				onCancel: vi.fn(),
				onPrompt: vi.fn(),
				onImagePrompt: vi.fn().mockResolvedValue({ text: "[Image #1]", images: [image] }),
			},
		);

		component.handleInput("n");
		await Promise.resolve();
		await Promise.resolve();
		component.handleInput(SPACE);
		component.handleInput(SPACE);
		component.handleInput(ENTER);

		const submitted = onSubmit.mock.calls[0][0].results[0];
		expect(submitted).toMatchObject({
			note: undefined,
			selectedOptions: [],
		});
		expect(submitted.noteImages).toBeUndefined();
	});

	it.each(["n", "N", ENTER])("%j on Other preserves the custom answer and images", async key => {
		const image: ImageContent = { type: "image", data: "image-data", mimeType: "image/png" };
		const onSubmit = vi.fn();
		const component = new AskDialogComponent(
			[{ id: "q1", question: "Choose?", multi: true, options: [{ label: "Option A" }] }],
			{
				onSubmit,
				onCancel: vi.fn(),
				onPrompt: vi.fn(),
				onImagePrompt: vi.fn().mockResolvedValue({ text: "[Image #1]", images: [image] }),
			},
		);

		component.handleInput(DOWN); // Other
		component.handleInput(key);
		await Promise.resolve();
		await Promise.resolve();
		component.handleInput(UP); // Option A: Enter on Other would edit the answer again
		component.handleInput(ENTER);

		const submitted = onSubmit.mock.calls[0][0].results[0];
		expect(submitted.customInput).toBe("[Image #1]");
		expect(submitted.customInputImages).toEqual([image]);
		expect(submitted.note).toBeUndefined();
		expect(submitted.noteImages).toBeUndefined();
	});

	it("returns note images and supplies them again when re-editing the same row", async () => {
		const image: ImageContent = { type: "image", data: "image-data", mimeType: "image/png" };
		const onImagePrompt = vi
			.fn()
			.mockResolvedValueOnce({ text: "[Image #1]", images: [image] })
			.mockResolvedValueOnce({ text: "Updated [Image #1]", images: [image] });
		const onSubmit = vi.fn();
		const component = new AskDialogComponent([{ id: "q1", question: "Choose?", options: [{ label: "Option A" }] }], {
			onSubmit,
			onCancel: vi.fn(),
			onPrompt: vi.fn(),
			onImagePrompt,
		});

		component.handleInput("n");
		await Promise.resolve();
		await Promise.resolve();
		component.handleInput("n");
		await Promise.resolve();
		await Promise.resolve();
		component.handleInput(ENTER);

		expect(onImagePrompt.mock.calls[1][1]).toEqual({ text: "[Image #1]", images: [image] });
		expect(onSubmit.mock.calls[0][0].results[0]).toMatchObject({
			note: "Updated [Image #1]",
			noteImages: [image],
		});
	});

	describe("Note target", () => {
		const questions: ExtensionAskDialogQuestion[] = [
			{ id: "q1", question: "Q1?", options: [{ label: "Alpha" }, { label: "Beta" }] },
			{ id: "q2", question: "Q2?", options: [{ label: "Gamma" }, { label: "Delta" }] },
			{ id: "q3", question: "Q3?", options: [{ label: "Epsilon" }, { label: "Zeta" }] },
		];
		const action = (act: string): NativeUiEvent => ({ type: "action", key: `actions/${act}`, act, mods: [] });
		const flush = async (): Promise<void> => {
			for (let i = 0; i < 4; i++) await Promise.resolve();
		};
		const click = (component: AskDialogComponent, question: number, option: number): void =>
			component.handleNativeEvent({ type: "activate", key: `q${question}`, item: `option:${option}` });
		const rowMenuNote = (component: AskDialogComponent, question: number, row: string): void =>
			component.handleNativeEvent({ type: "action", key: `q${question}/${row}`, act: "note", mods: [] });

		it("TUI: Enter then `n` annotates the highlighted row of the question shown", async () => {
			const onPrompt = vi.fn().mockResolvedValue("why Gamma");
			const onSubmit = vi.fn();
			const component = new AskDialogComponent(questions, { onSubmit, onCancel: vi.fn(), onPrompt });

			component.handleInput(DOWN);
			component.handleInput(ENTER); // Beta, on to Q2
			component.handleInput("n");
			await flush();
			expect(onPrompt.mock.calls[0][0]).toEqual({ title: "Note for Gamma", question: "Q2?" });

			component.handleInput(ENTER); // Gamma, on to Q3
			component.handleInput(ENTER); // Epsilon, every question answered: submits
			const [first, second] = onSubmit.mock.calls[0][0].results;
			expect(first).toMatchObject({ selectedOptions: ["Beta"], note: undefined, noteOption: undefined });
			expect(second).toMatchObject({ selectedOptions: ["Gamma"], note: "why Gamma", noteOption: "Gamma" });
		});

		it("TUI: annotates the middle answer after a cancelled note on the last question and going back (A > B > C)", async () => {
			const onPrompt = vi.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce("why Gamma");
			const onSubmit = vi.fn();
			const component = new AskDialogComponent(questions, { onSubmit, onCancel: vi.fn(), onPrompt });

			component.handleInput(ENTER); // Alpha, on to Q2
			component.handleInput(ENTER); // Gamma, on to Q3
			component.handleInput("n"); // cancelled
			await flush();
			component.handleInput(SHIFT_TAB); // back to Q2
			component.handleInput("n");
			await flush();

			expect(onPrompt.mock.calls[0][0]).toEqual({ title: "Note for Epsilon", question: "Q3?" });
			expect(onPrompt.mock.calls[1][0]).toEqual({ title: "Note for Gamma", question: "Q2?" });

			component.handleInput(TAB); // Q3
			component.handleInput(ENTER); // Epsilon, every question answered: submits
			const [first, second, third] = onSubmit.mock.calls[0][0].results;
			expect(first.note).toBeUndefined();
			expect(second).toMatchObject({ selectedOptions: ["Gamma"], note: "why Gamma", noteOption: "Gamma" });
			expect(third).toMatchObject({ selectedOptions: ["Epsilon"], note: undefined });
		});

		it("Tern: the Note button after a click annotates the highlighted row of the question shown", async () => {
			const onPrompt = vi.fn().mockResolvedValue("why Gamma");
			const component = new AskDialogComponent(questions, { onSubmit: vi.fn(), onCancel: vi.fn(), onPrompt });

			click(component, 0, 1); // Beta, on to Q2
			component.handleNativeEvent(action("note"));
			await flush();
			expect(onPrompt.mock.calls[0][0]).toEqual({ title: "Note for Gamma", question: "Q2?" });
		});

		it("Tern: a row's menu Note annotates that row without picking it, and the pick keeps the note", async () => {
			const onPrompt = vi.fn().mockResolvedValue("why Beta");
			const onSubmit = vi.fn();
			const component = new AskDialogComponent(questions, { onSubmit, onCancel: vi.fn(), onPrompt });

			rowMenuNote(component, 0, "option:1");
			await flush();
			expect(onPrompt.mock.calls[0][0]).toEqual({ title: "Note for Beta", question: "Q1?" });
			click(component, 0, 1); // Beta, the row the menu highlighted, on to Q2
			click(component, 1, 0);
			click(component, 2, 0); // the last question, every one answered: submits

			const [first, second] = onSubmit.mock.calls[0][0].results;
			expect(first).toMatchObject({ selectedOptions: ["Beta"], note: "why Beta", noteOption: "Beta" });
			expect(second).toMatchObject({ selectedOptions: ["Gamma"], note: undefined });
		});

		it("Tern: a menu Note from a list the dialog has moved past does nothing", async () => {
			const onPrompt = vi.fn().mockResolvedValue("late");
			const component = new AskDialogComponent(questions, { onSubmit: vi.fn(), onCancel: vi.fn(), onPrompt });

			click(component, 0, 1); // Beta, on to Q2
			rowMenuNote(component, 0, "option:0");
			await flush();
			expect(onPrompt).not.toHaveBeenCalled();
		});

		it("Tern: a row's menu Note sent over the wire reaches that row", async () => {
			const onPrompt = vi.fn().mockResolvedValue("why Beta");
			const dialog = new AskDialogComponent(questions, { onSubmit: vi.fn(), onCancel: vi.fn(), onPrompt });
			const provider: TerminalFrameProvider & NativeSurfaceProvider = {
				renderFrame: () => ({ viewport: [] }),
				acknowledgeHistory: () => {},
				describeSurface: () => ({ main: [], dock: [dialog] }),
			};
			const harness = await TspHarness.start(tui => {
				tui.setFrameProvider(provider);
				tui.setFocus(dialog);
			});
			try {
				const beta = harness.find(node => node.k === "item" && node.id.endsWith("/option:1"));
				expect(beta?.p).toMatchObject({ actions: { menu: ["note"] } });
				harness.event({ ev: "action", sf: harness.terminal.surface!, id: beta!.id, act: "note" });
				await flush();
				expect(onPrompt.mock.calls[0][0]).toEqual({ title: "Note for Beta", question: "Q1?" });
				expect(harness.errors).toEqual([]);
			} finally {
				harness.stop();
			}
		});
	});

	it("note prefill is empty when editing a different row after noting another option", async () => {
		const onPrompt = vi.fn();
		const onSubmit = vi.fn();
		const questions: ExtensionAskDialogQuestion[] = [
			{
				id: "q1",
				question: "Choose one?",
				options: [{ label: "Option A" }, { label: "Option B" }],
			},
		];

		const component = new AskDialogComponent(questions, {
			onSubmit,
			onCancel: vi.fn(),
			onPrompt,
		});

		// Cursor starts on Option A. Add a note for A.
		onPrompt.mockReturnValueOnce(Promise.resolve("Note for A"));
		component.handleInput("n");
		await Promise.resolve();
		await Promise.resolve();

		expect(onPrompt).toHaveBeenCalledTimes(1);
		expect(onPrompt.mock.calls[0][0]).toEqual({ title: "Note for Option A", question: "Choose one?" });
		// No prior note → prefill is undefined.
		expect(onPrompt.mock.calls[0][1]).toBeUndefined();

		// Move down to Option B and open its note.
		component.handleInput(DOWN);
		onPrompt.mockReturnValueOnce(Promise.resolve("Note for B"));
		component.handleInput("n");
		await Promise.resolve();
		await Promise.resolve();

		expect(onPrompt).toHaveBeenCalledTimes(2);
		// Prefill for Option B must be undefined — not the note from Option A.
		expect(onPrompt.mock.calls[1][1]).toBeUndefined();

		// Move back up to Option A and re-open its note.
		component.handleInput("\x1b[A"); // UP
		onPrompt.mockReturnValueOnce(Promise.resolve("Updated note"));
		component.handleInput("n");
		await Promise.resolve();
		await Promise.resolve();

		expect(onPrompt).toHaveBeenCalledTimes(3);
		// Note now belongs to Option B, so re-editing Option A starts empty.
		expect(onPrompt.mock.calls[2][1]).toBeUndefined();
	});

	it("note prefill reuses the existing note when re-editing the same row", async () => {
		const onPrompt = vi.fn();
		const questions: ExtensionAskDialogQuestion[] = [
			{
				id: "q1",
				question: "Choose one?",
				options: [{ label: "Option A" }],
			},
		];

		const component = new AskDialogComponent(questions, {
			onSubmit: vi.fn(),
			onCancel: vi.fn(),
			onPrompt,
		});

		// Add a note on Option A.
		onPrompt.mockReturnValueOnce(Promise.resolve("My note"));
		component.handleInput("n");
		await Promise.resolve();
		await Promise.resolve();

		// Re-open the note on the same row (cursor still on Option A).
		onPrompt.mockReturnValueOnce(Promise.resolve("Updated note"));
		component.handleInput("n");
		await Promise.resolve();
		await Promise.resolve();

		expect(onPrompt).toHaveBeenCalledTimes(2);
		// Same row → prefill reuses the existing note.
		expect(onPrompt.mock.calls[1][1]).toBe("My note");
	});

	it("omits a note when a single-select answer changes to a different option", async () => {
		const onPrompt = vi.fn().mockReturnValue(Promise.resolve("Note for A"));
		const onSubmit = vi.fn();
		const questions: ExtensionAskDialogQuestion[] = [
			{
				id: "q1",
				question: "Choose one?",
				options: [{ label: "Option A" }, { label: "Option B" }],
			},
		];

		const component = new AskDialogComponent(questions, {
			onSubmit,
			onCancel: vi.fn(),
			onPrompt,
		});

		component.handleInput("n");
		await Promise.resolve();
		await Promise.resolve();

		component.handleInput(DOWN);
		component.handleInput(ENTER);

		expect(onSubmit).toHaveBeenCalledTimes(1);
		expect(onSubmit.mock.calls[0][0].results[0].selectedOptions).toEqual(["Option B"]);
		expect(onSubmit.mock.calls[0][0].results[0].note).toBeUndefined();
	});

	it("clears the note when a noted multi-select option is toggled off", async () => {
		const onPrompt = vi.fn().mockReturnValue(Promise.resolve("Note for A"));
		const onSubmit = vi.fn();
		const questions: ExtensionAskDialogQuestion[] = [
			{
				id: "q1",
				question: "Choose multiple?",
				options: [{ label: "Option A" }, { label: "Option B" }],
				multi: true,
			},
		];

		const component = new AskDialogComponent(questions, {
			onSubmit,
			onCancel: vi.fn(),
			onPrompt,
		});

		component.handleInput("n");
		await Promise.resolve();
		await Promise.resolve();

		component.handleInput(SPACE);
		component.handleInput(SPACE);
		expect(render(component)).not.toContain("✎ note");

		// Select Option B and confirm with Enter; the cleared note must not resurface.
		component.handleInput(DOWN);
		component.handleInput(SPACE);
		component.handleInput(ENTER);

		expect(onSubmit).toHaveBeenCalledTimes(1);
		expect(onSubmit.mock.calls[0][0].results[0].selectedOptions).toEqual(["Option B"]);
		expect(onSubmit.mock.calls[0][0].results[0].note).toBeUndefined();
	});

	it("saves multi-select choices and custom input, then advances exactly one question", async () => {
		const onPrompt = vi.fn().mockResolvedValue("custom detail");
		const onSubmit = vi.fn();
		const component = new AskDialogComponent(
			[
				{
					id: "q1",
					question: "Choose multiple?",
					options: [{ label: "Option A" }, { label: "Option B" }],
					multi: true,
				},
				{
					id: "q2",
					question: "Second question?",
					options: [{ label: "Option C" }, { label: "Option D" }],
				},
			],
			{ onSubmit, onCancel: vi.fn(), onPrompt },
		);

		component.handleInput(SPACE);
		component.handleInput(DOWN);
		component.handleInput(SPACE);
		component.handleInput(DOWN);
		component.handleInput(ENTER);
		await Promise.resolve();
		await Promise.resolve();

		expect(onSubmit).not.toHaveBeenCalled();
		expect(render(component)).toContain("❯ ○ Option C");
		component.handleInput(DOWN);
		component.handleInput(ENTER);

		expect(onPrompt).toHaveBeenCalledTimes(1);
		expect(onSubmit).toHaveBeenCalledTimes(1);
		expect(onSubmit.mock.calls[0][0].results).toMatchObject([
			{ id: "q1", selectedOptions: ["Option A", "Option B"], customInput: "custom detail" },
			{ id: "q2", selectedOptions: ["Option D"] },
		]);
	});

	it("keeps a lone multi-select open after its custom answer so it can be edited", async () => {
		const onPrompt = vi.fn().mockResolvedValueOnce("first draft").mockResolvedValueOnce("revised answer");
		const onSubmit = vi.fn();
		const component = new AskDialogComponent(
			[
				{
					id: "q1",
					question: "Choose multiple?",
					options: [{ label: "Option A" }, { label: "Option B" }],
					multi: true,
				},
			],
			{ onSubmit, onCancel: vi.fn(), onPrompt },
		);

		component.handleInput(SPACE);
		component.handleInput(DOWN);
		component.handleInput(DOWN);
		component.handleInput(ENTER);
		await Promise.resolve();
		await Promise.resolve();
		expect(onSubmit).not.toHaveBeenCalled();

		component.handleInput(UP);
		component.handleInput(SPACE);
		component.handleInput(DOWN);
		component.handleInput(ENTER);
		await Promise.resolve();
		await Promise.resolve();
		expect(onSubmit).not.toHaveBeenCalled();
		component.handleInput(UP);
		component.handleInput(ENTER);

		expect(onPrompt).toHaveBeenCalledTimes(2);
		expect(onSubmit).toHaveBeenCalledTimes(1);
		expect(onSubmit.mock.calls[0][0].results).toMatchObject([
			{ id: "q1", selectedOptions: ["Option A", "Option B"], customInput: "revised answer" },
		]);
	});

	it("multi-question, multi-select: Enter on a plain option advances, does not submit", () => {
		const onSubmit = vi.fn();
		const onCancel = vi.fn();
		const onPrompt = vi.fn();

		const questions: ExtensionAskDialogQuestion[] = [
			{
				id: "q1",
				question: "Choose multiple?",
				options: [{ label: "Option A" }, { label: "Option B" }],
				multi: true,
			},
			{
				id: "q2",
				question: "Second question?",
				options: [{ label: "Option C" }, { label: "Option D" }],
			},
		];

		const component = new AskDialogComponent(questions, {
			onSubmit,
			onCancel,
			onPrompt,
		});

		// Space toggles Option A; Enter on the plain option row confirms and
		// opens Q2 instead of submitting the whole dialog (#8265 review).
		component.handleInput(SPACE);
		component.handleInput(ENTER);
		expect(onSubmit).not.toHaveBeenCalled();

		// On Q2, the last: Option D answers it, and with every question answered Enter submits once.
		component.handleInput(DOWN);
		component.handleInput(ENTER);
		expect(onSubmit).toHaveBeenCalledTimes(1);
		expect(onSubmit.mock.calls[0][0].results).toEqual([
			{
				id: "q1",
				question: "Choose multiple?",
				options: ["Option A", "Option B"],
				multi: true,
				selectedOptions: ["Option A"],
				customInput: undefined,
				note: undefined,
				timedOut: undefined,
			},
			{
				id: "q2",
				question: "Second question?",
				options: ["Option C", "Option D"],
				multi: false,
				selectedOptions: ["Option D"],
				customInput: undefined,
				note: undefined,
				timedOut: undefined,
			},
		]);
	});

	it("defers a timeout that fires during a pending prompt and honors the resolved custom input", async () => {
		vi.useFakeTimers();
		const deferred = Promise.withResolvers<string | undefined>();
		const onPrompt = vi.fn().mockReturnValue(deferred.promise);
		const onSubmit = vi.fn();
		const onTimeout = vi.fn();
		const questions: ExtensionAskDialogQuestion[] = [
			{
				id: "q1",
				question: "First?",
				options: [{ label: "Option A" }, { label: "Option B" }],
			},
			{
				id: "q2",
				question: "Second?",
				options: [{ label: "Option C" }, { label: "Option D" }],
				recommended: 1,
			},
		];

		const component = new AskDialogComponent(
			questions,
			{ onSubmit, onCancel: vi.fn(), onPrompt },
			{ timeout: 1000, onTimeout },
		);

		// Open the "Other (type your own)" prompt on question 1.
		component.handleInput(DOWN);
		component.handleInput(DOWN);
		component.handleInput(ENTER);
		expect(onPrompt).toHaveBeenCalledTimes(1);

		// Timer expires while the prompt is pending: the timeout must be deferred,
		// not submit the recommended fallback out from under the user.
		vi.advanceTimersByTime(1000);
		expect(onTimeout).not.toHaveBeenCalled();
		expect(onSubmit).not.toHaveBeenCalled();

		// Resolving the prompt honors the typed answer, then runs the deferred
		// timeout handling exactly once.
		deferred.resolve("my answer");
		await Promise.resolve();
		await Promise.resolve();

		expect(onTimeout).toHaveBeenCalledTimes(1);
		expect(onSubmit).toHaveBeenCalledTimes(1);
		const results = onSubmit.mock.calls[0][0].results;
		expect(results[0].customInput).toBe("my answer");
		expect(results[0].selectedOptions).toEqual([]);
		expect(results[0].timedOut).toBeUndefined();
		expect(results[1].selectedOptions).toEqual(["Option D"]);
		expect(results[1].timedOut).toBe(true);
	});

	it("keeps a single-question custom prompt answer when timeout expires while the prompt is pending", async () => {
		vi.useFakeTimers();
		const deferred = Promise.withResolvers<string | undefined>();
		const onPrompt = vi.fn().mockReturnValue(deferred.promise);
		const onSubmit = vi.fn();
		const onTimeout = vi.fn();
		const questions: ExtensionAskDialogQuestion[] = [
			{
				id: "q1",
				question: "Only question?",
				options: [{ label: "Fallback" }],
			},
		];

		const component = new AskDialogComponent(
			questions,
			{ onSubmit, onCancel: vi.fn(), onPrompt },
			{ timeout: 1000, onTimeout },
		);

		component.handleInput(DOWN);
		component.handleInput(ENTER);
		expect(onPrompt).toHaveBeenCalledTimes(1);

		vi.advanceTimersByTime(1000);
		expect(onTimeout).not.toHaveBeenCalled();
		expect(onSubmit).not.toHaveBeenCalled();

		deferred.resolve("my answer");
		await Promise.resolve();
		await Promise.resolve();

		expect(onSubmit).toHaveBeenCalledTimes(1);
		expect(onTimeout).not.toHaveBeenCalled();
		const result = onSubmit.mock.calls[0][0].results[0];
		expect(result.customInput).toBe("my answer");
		expect(result.selectedOptions).toEqual([]);
		expect(result.timedOut).toBeUndefined();
	});

	it("uses a noted non-recommended option as the timeout fallback", async () => {
		vi.useFakeTimers();
		const onPrompt = vi.fn().mockReturnValue(Promise.resolve("why B"));
		const onSubmit = vi.fn();
		const onTimeout = vi.fn();
		const questions: ExtensionAskDialogQuestion[] = [
			{
				id: "q1",
				question: "Choose one?",
				options: [{ label: "Option A" }, { label: "Option B" }],
				recommended: 0,
			},
		];

		const component = new AskDialogComponent(
			questions,
			{ onSubmit, onCancel: vi.fn(), onPrompt },
			{ timeout: 1000, onTimeout },
		);

		component.handleInput(DOWN);
		component.handleInput("n");
		await Promise.resolve();
		await Promise.resolve();

		vi.advanceTimersByTime(1000);

		expect(onTimeout).toHaveBeenCalledTimes(1);
		expect(onSubmit).toHaveBeenCalledTimes(1);
		const result = onSubmit.mock.calls[0][0].results[0];
		expect(result.selectedOptions).toEqual(["Option B"]);
		expect(result.note).toBe("why B");
		expect(result.timedOut).toBe(true);
	});

	it("preserves a pending note on a non-recommended option when deferred timeout submits", async () => {
		vi.useFakeTimers();
		const deferred = Promise.withResolvers<string | undefined>();
		const onPrompt = vi.fn().mockReturnValue(deferred.promise);
		const onSubmit = vi.fn();
		const onTimeout = vi.fn();
		const questions: ExtensionAskDialogQuestion[] = [
			{
				id: "q1",
				question: "Choose one?",
				options: [{ label: "Option A" }, { label: "Option B" }],
				recommended: 0,
			},
		];

		const component = new AskDialogComponent(
			questions,
			{ onSubmit, onCancel: vi.fn(), onPrompt },
			{ timeout: 1000, onTimeout },
		);

		component.handleInput(DOWN);
		component.handleInput("n");
		expect(onPrompt).toHaveBeenCalledTimes(1);

		vi.advanceTimersByTime(1000);
		expect(onTimeout).not.toHaveBeenCalled();
		expect(onSubmit).not.toHaveBeenCalled();

		deferred.resolve("why B");
		await Promise.resolve();
		await Promise.resolve();

		expect(onTimeout).toHaveBeenCalledTimes(1);
		expect(onSubmit).toHaveBeenCalledTimes(1);
		const result = onSubmit.mock.calls[0][0].results[0];
		expect(result.selectedOptions).toEqual(["Option B"]);
		expect(result.note).toBe("why B");
		expect(result.timedOut).toBe(true);
	});

	it("resets the inactivity countdown on user input after the closed/prompt guard", () => {
		vi.useFakeTimers();
		const onTimeout = vi.fn();
		const onSubmit = vi.fn();
		const questions: ExtensionAskDialogQuestion[] = [
			{
				id: "q1",
				question: "Choose one?",
				options: [{ label: "Option A" }, { label: "Option B" }],
			},
		];

		const component = new AskDialogComponent(
			questions,
			{ onSubmit, onCancel: vi.fn(), onPrompt: vi.fn() },
			{ timeout: 5000, onTimeout },
		);

		// Advance most of the timeout window.
		vi.advanceTimersByTime(4000);
		expect(onTimeout).not.toHaveBeenCalled();

		// User input (DOWN) should reset the countdown.
		component.handleInput(DOWN);

		// Advancing past the *original* deadline must NOT fire the timeout —
		// the reset moved the deadline forward by the interaction.
		vi.advanceTimersByTime(2000);
		expect(onTimeout).not.toHaveBeenCalled();

		// Advancing the remaining time after the reset DOES fire.
		vi.advanceTimersByTime(3000);
		expect(onTimeout).toHaveBeenCalledTimes(1);
	});

	it("hands the custom answer prompt the whole question, unwrapped", async () => {
		const onPrompt = vi.fn().mockReturnValue(Promise.resolve("custom"));
		const longQuestion = "This is a very long\nmulti-line question ".repeat(20);
		const questions: ExtensionAskDialogQuestion[] = [
			{
				id: "q1",
				question: longQuestion,
				options: [{ label: "Option A" }],
			},
		];

		const component = new AskDialogComponent(questions, {
			onSubmit: vi.fn(),
			onCancel: vi.fn(),
			onPrompt,
		});

		// Navigate to "Other" and press Enter to trigger the custom prompt.
		component.handleInput(DOWN);
		component.handleInput(ENTER);
		await Promise.resolve();
		await Promise.resolve();

		expect(onPrompt).toHaveBeenCalledTimes(1);
		// Bounding to the terminal is the prompt's job (HookEditorOptions.question): native hosts show all of it.
		expect(onPrompt.mock.calls[0][0]).toEqual({ title: "Custom answer", question: longQuestion });
	});

	it("scrolls question rows when cursor moves below the viewport", () => {
		const originalRows = Object.getOwnPropertyDescriptor(process.stdout, "rows");
		Object.defineProperty(process.stdout, "rows", { configurable: true, value: 24 });
		try {
			const options = Array.from({ length: 30 }, (_, i) => ({
				label: `Option ${String(i + 1).padStart(2, "0")}`,
			}));
			const questions: ExtensionAskDialogQuestion[] = [{ id: "q1", question: "Pick one?", options }];
			const component = new AskDialogComponent(questions, {
				onSubmit: vi.fn(),
				onCancel: vi.fn(),
				onPrompt: vi.fn(),
			});
			const renderAt = (width: number): string => stripVTControlCharacters(component.render(width).join("\n"));

			const initial = renderAt(60);
			expect(initial).toContain("Option 01");
			expect(initial).not.toContain("Option 30");
			expect(initial).toContain("█");

			for (let i = 0; i < 28; i++) component.handleInput(DOWN);
			const scrolled = renderAt(60);
			expect(scrolled).not.toContain("Option 01");
			expect(scrolled).toContain("Option 29");
		} finally {
			if (originalRows) Object.defineProperty(process.stdout, "rows", originalRows);
			else Reflect.deleteProperty(process.stdout, "rows");
		}
	});

	it("multi-select: Enter submits an empty selection instead of dead-ending", () => {
		const onSubmit = vi.fn();
		const questions: ExtensionAskDialogQuestion[] = [
			{
				id: "q1",
				question: "Choose multiple?",
				options: [{ label: "Option A" }, { label: "Option B" }],
				multi: true,
			},
		];

		const component = new AskDialogComponent(questions, {
			onSubmit,
			onCancel: vi.fn(),
			onPrompt: vi.fn(),
		});

		// Enter with nothing selected submits the empty selection rather than
		// toggling or blocking on the Submit tab.
		component.handleInput(ENTER);

		expect(onSubmit).toHaveBeenCalledTimes(1);
		expect(onSubmit.mock.calls[0][0].results[0].selectedOptions).toEqual([]);
	});

	it("renders every option's preview inline, not only the highlighted one", () => {
		const questions: ExtensionAskDialogQuestion[] = [
			{
				id: "q1",
				question: "Pick one?",
				options: [
					{ label: "Alpha", preview: "PREVIEW-ALPHA" },
					{ label: "Bravo", preview: "PREVIEW-BRAVO" },
					{ label: "Charlie" },
				],
			},
		];
		const component = new AskDialogComponent(questions, {
			onSubmit: vi.fn(),
			onCancel: vi.fn(),
			onPrompt: vi.fn(),
		});
		// Cursor defaults to option 0; both previews must be visible without navigating.
		const out = stripVTControlCharacters(component.render(80).join("\n"));
		expect(out).toContain("PREVIEW-ALPHA");
		expect(out).toContain("PREVIEW-BRAVO");
	});

	it("refreshes cached preview styling after theme invalidation", async () => {
		const createComponent = (): AskDialogComponent =>
			new AskDialogComponent(
				[{ id: "q1", question: "Pick one?", options: [{ label: "Alpha", preview: "CACHE-PREVIEW" }] }],
				{ onSubmit: vi.fn(), onCancel: vi.fn(), onPrompt: vi.fn() },
			);
		const previewLine = (component: AskDialogComponent): string =>
			component.render(80).find(line => line.includes("CACHE-PREVIEW")) ?? "";
		const originalTheme = darkTheme;
		if (!originalTheme) throw new Error("Failed to load dark theme");
		const lightTheme = await getThemeByName("light");
		if (!lightTheme) throw new Error("Failed to load light theme");
		const cachedComponent = createComponent();
		const before = previewLine(cachedComponent);
		expect(stripVTControlCharacters(before)).toContain("│ CACHE-PREVIEW");
		try {
			setThemeInstance(lightTheme);
			const stale = previewLine(cachedComponent);
			const fresh = previewLine(createComponent());
			expect(stripVTControlCharacters(stale)).toBe(stripVTControlCharacters(fresh));
			expect(stale).not.toBe(fresh);

			cachedComponent.invalidate();
			expect(previewLine(cachedComponent)).toBe(fresh);
		} finally {
			setThemeInstance(originalTheme);
			cachedComponent.invalidate();
		}
	});

	it("keeps the memoized overflowing render identical to the initial width-adjusted render", () => {
		const originalRows = Object.getOwnPropertyDescriptor(process.stdout, "rows");
		Object.defineProperty(process.stdout, "rows", { configurable: true, value: 24 });
		try {
			const edgeLine = `${"X".repeat(67)}Ω`;
			const filler = Array.from({ length: 30 }, (_, index) => `filler-${index}`).join("\n");
			const component = new AskDialogComponent(
				[
					{
						id: "q1",
						question: "Inspect?",
						options: [{ label: "Alpha", preview: `\`\`\`\n${edgeLine}\n${filler}\n\`\`\`` }],
					},
				],
				{ onSubmit: vi.fn(), onCancel: vi.fn(), onPrompt: vi.fn() },
			);

			const initial = render(component);
			const cached = render(component);
			expect(initial).toContain("Ω");
			expect(cached).toBe(initial);
		} finally {
			if (originalRows) Object.defineProperty(process.stdout, "rows", originalRows);
			else Reflect.deleteProperty(process.stdout, "rows");
		}
	});

	it("pages through an inline preview taller than the question viewport", () => {
		const originalRows = Object.getOwnPropertyDescriptor(process.stdout, "rows");
		Object.defineProperty(process.stdout, "rows", { configurable: true, value: 24 });
		try {
			const previewLines = Array.from({ length: 80 }, (_, index) => {
				if (index === 0) return "PREVIEW-FIRST";
				if (index === 40) return "PREVIEW-MIDDLE";
				if (index === 79) return "PREVIEW-LAST";
				return `preview-line-${index}`;
			});
			const questions: ExtensionAskDialogQuestion[] = [
				{
					id: "q1",
					question: "Inspect the preview?",
					options: [{ label: "Plain" }, { label: "Alpha", preview: `\`\`\`\n${previewLines.join("\n")}\n\`\`\`` }],
				},
			];
			const component = new AskDialogComponent(questions, {
				onSubmit: vi.fn(),
				onCancel: vi.fn(),
				onPrompt: vi.fn(),
			});

			let out = render(component);
			expect(out).toContain("PREVIEW-FIRST");
			expect(out).not.toContain("PREVIEW-MIDDLE");
			expect(out).not.toContain("PREVIEW-LAST");
			expect(component.keyHints()).not.toContain("page");
			component.handleInput(DOWN);
			render(component);
			expect(stripVTControlCharacters(component.keyHints())).toContain("PgUp/PgDn page");
			for (let page = 0; page < 3; page++) component.handleInput(PAGE_DOWN);
			out = render(component);
			expect(out).toContain("PREVIEW-MIDDLE");
			component.handleInput(DOWN);
			out = render(component);
			expect(out).toContain("Other (type your own)");
			expect(out).not.toContain("PREVIEW-MIDDLE");
			component.handleInput(UP);
			out = render(component);
			expect(out).toContain("PREVIEW-FIRST");
			for (let page = 0; page < 10; page++) {
				component.handleInput(PAGE_DOWN);
				out = render(component);
			}
			expect(out).toContain("PREVIEW-LAST");
			expect(out).not.toContain("Other (type your own)");
			component.handleInput(DOWN);
			out = render(component);
			expect(out).toContain("Other (type your own)");
			component.handleInput(UP);
			out = render(component);
			for (let page = 0; page < 10; page++) {
				component.handleInput(PAGE_UP);
				out = render(component);
			}
			expect(out).toContain("PREVIEW-FIRST");
		} finally {
			if (originalRows) Object.defineProperty(process.stdout, "rows", originalRows);
			else Reflect.deleteProperty(process.stdout, "rows");
		}
	});

	it("keeps a selected inline preview visible when its row fits the viewport", () => {
		const originalRows = Object.getOwnPropertyDescriptor(process.stdout, "rows");
		Object.defineProperty(process.stdout, "rows", { configurable: true, value: 24 });
		try {
			const options = [
				...Array.from({ length: 8 }, (_, index) => ({ label: `Plain ${index}` })),
				{ label: "Target", preview: "```\nPREVIEW-SHORT-FIRST\npreview-short-middle\nPREVIEW-SHORT-LAST\n```" },
				...Array.from({ length: 8 }, (_, index) => ({ label: `After ${index}` })),
			];
			const component = new AskDialogComponent([{ id: "q1", question: "Pick one?", options }], {
				onSubmit: vi.fn(),
				onCancel: vi.fn(),
				onPrompt: vi.fn(),
			});

			for (let index = 0; index < 8; index++) component.handleInput(DOWN);
			let out = render(component);
			expect(out).toContain("PREVIEW-SHORT-FIRST");
			expect(out).toContain("PREVIEW-SHORT-LAST");
			expect(out).toContain("█");
			component.handleInput(PAGE_DOWN);
			out = render(component);
			expect(out).toContain("PREVIEW-SHORT-FIRST");
			expect(out).toContain("PREVIEW-SHORT-LAST");
			expect(out).toContain("█");
		} finally {
			if (originalRows) Object.defineProperty(process.stdout, "rows", originalRows);
			else Reflect.deleteProperty(process.stdout, "rows");
		}
	});

	it("shows the open question's header over its question, not inside it", () => {
		const questions: ExtensionAskDialogQuestion[] = [
			{ id: "q1", question: "First question?", header: "Alpha", options: [{ label: "A" }] },
			{ id: "q2", question: "Second question?", header: "Beta", options: [{ label: "B" }] },
		];
		const component = new AskDialogComponent(questions, {
			onSubmit: vi.fn(),
			onCancel: vi.fn(),
			onPrompt: vi.fn(),
		});
		const output = render(component);
		// The open question shows its header on its own line…
		expect(output).toContain("Alpha");
		// …so the question line is just the question, not "[Alpha] First question?".
		expect(output).toContain("○ First question?");
		expect(output).not.toContain("[Alpha]");
		// A folded question shows only its question.
		expect(output).toContain("○ Second question?");
		expect(output).not.toContain("Beta");
	});

	it("renders fenced diff questions as blocks separate from prose", () => {
		const component = new AskDialogComponent(
			[
				{
					id: "diff",
					question: "Review this patch:\n```diff\n-old()\n+new()\n```",
					options: [{ label: "Apply" }, { label: "Reject" }],
				},
			],
			{ onSubmit: vi.fn(), onCancel: vi.fn(), onPrompt: vi.fn() },
		);

		const rows = render(component).split("\n");
		const questionRow = rows.findIndex(row => row.includes("Review this patch:"));
		const deletionRow = rows.findIndex(row => row.includes("-old()"));
		const additionRow = rows.findIndex(row => row.includes("+new()"));
		expect(questionRow).toBeGreaterThanOrEqual(0);
		expect(deletionRow).toBeGreaterThanOrEqual(0);
		expect(deletionRow).toBeGreaterThan(questionRow);
		expect(additionRow).toBeGreaterThan(deletionRow);
		expect(rows[deletionRow]).not.toContain("+new()");
	});

	it("bounds in-body question header for long multi-line questions", () => {
		const onSubmit = vi.fn();
		const longQuestion = "This is a very long question ".repeat(30);
		const questions: ExtensionAskDialogQuestion[] = [
			{
				id: "q1",
				question: longQuestion,
				options: [{ label: "Option A" }, { label: "Option B" }],
			},
		];

		const component = new AskDialogComponent(questions, {
			onSubmit,
			onCancel: vi.fn(),
			onPrompt: vi.fn(),
		});

		// The rendered body must not blow out with the full 30-line question.
		// The header is capped to MAX_HEADER_ROWS lines.
		const output = render(component);
		// The question text should appear but be truncated — verify it does
		// not contain the full repeated text (30 copies would be ~870 chars).
		expect(output).toContain("This is a very long question");
		// Count occurrences of the repeated phrase — should be far fewer than 30.
		const matches = output.match(/This is a very long question/g);
		expect(matches?.length ?? 0).toBeLessThan(10);
	});

	it("expands a truncated question header on Ctrl+O and collapses on a second press", () => {
		const longQuestion = "This is a very long question ".repeat(200);
		const component = new AskDialogComponent(
			[
				{
					id: "q1",
					question: longQuestion,
					options: [{ label: "Option A" }, { label: "Option B" }],
				},
			],
			{
				onSubmit: vi.fn(),
				onCancel: vi.fn(),
				onPrompt: vi.fn(),
			},
		);

		const collapsed = render(component);
		const collapsedCount = collapsed.match(/This is a very long question/g)?.length ?? 0;
		expect(collapsedCount).toBeLessThan(10);

		component.handleInput("\x0f");
		const expanded = render(component);
		const expandedCount = expanded.match(/This is a very long question/g)?.length ?? 0;
		expect(expandedCount).toBeGreaterThan(collapsedCount);
		const cap = Math.max(12, Math.floor((process.stdout.rows || 40) * 0.7));
		expect(component.render(80).length).toBeLessThanOrEqual(cap);
		// Wrapping can split a few phrases across lines; require a clearly
		// larger header rather than an exact copy count.
		expect(expandedCount).toBeGreaterThanOrEqual(15);

		component.handleInput("\x0f");
		const recollapsed = render(component);
		expect(recollapsed.match(/This is a very long question/g)?.length ?? 0).toBe(collapsedCount);
	});

	it("leaves a short question unchanged and does not advertise expand", () => {
		const component = new AskDialogComponent(
			[{ id: "q1", question: "Choose one?", options: [{ label: "Option A" }] }],
			{ onSubmit: vi.fn(), onCancel: vi.fn(), onPrompt: vi.fn() },
		);
		const before = render(component);
		expect(component.toggleQuestionExpansion()).toBe(false);
		expect(render(component)).toBe(before);
	});
	it("expands truncated option descriptions on Ctrl+O and collapses on a second press", () => {
		const longDescription = "This is a very long description ".repeat(30);
		const component = new AskDialogComponent(
			[
				{
					id: "q1",
					question: "Choose one?",
					options: [{ label: "Option A", description: longDescription }, { label: "Option B" }],
				},
			],
			{ onSubmit: vi.fn(), onCancel: vi.fn(), onPrompt: vi.fn() },
		);

		const collapsed = render(component);
		const collapsedCount = collapsed.match(/This is a very long description/g)?.length ?? 0;
		expect(collapsedCount).toBeLessThan(10);
		expect(component.toggleQuestionExpansion()).toBe(true);

		const expanded = render(component);
		const expandedCount = expanded.match(/This is a very long description/g)?.length ?? 0;
		expect(expandedCount).toBeGreaterThan(collapsedCount);
		expect(expandedCount).toBeGreaterThanOrEqual(10);

		component.handleInput("\x0f");
		const recollapsed = render(component);
		expect(recollapsed.match(/This is a very long description/g)?.length ?? 0).toBe(collapsedCount);
	});

	it("does not advertise expand for short option descriptions", () => {
		const component = new AskDialogComponent(
			[
				{
					id: "q1",
					question: "Choose one?",
					options: [{ label: "Option A", description: "Short description." }],
				},
			],
			{ onSubmit: vi.fn(), onCancel: vi.fn(), onPrompt: vi.fn() },
		);
		const before = render(component);
		expect(component.toggleQuestionExpansion()).toBe(false);
		expect(render(component)).toBe(before);
	});

	it("wraps long option labels onto indented continuation lines instead of truncating", () => {
		const onSubmit = vi.fn();
		const tail = "UNIQUE_TAIL_MARKER_8654";
		const longLabel = `${"This is a deliberately long option label ".repeat(4)}${tail}`;
		const questions: ExtensionAskDialogQuestion[] = [
			{
				id: "q1",
				question: "Pick one?",
				options: [{ label: longLabel }, { label: "Short" }],
			},
		];

		const component = new AskDialogComponent(questions, {
			onSubmit,
			onCancel: vi.fn(),
			onPrompt: vi.fn(),
		});

		const output = render(component);
		// The unique label tail must be present — no ellipsis truncation.
		expect(output).toContain(tail);
		expect(output).not.toContain("…");
		// The first line carries the cursor glyph; continuation lines are
		// indented under the marker so the cursor stays visually anchored.
		const lines = output.split("\n");
		const first = lines.find(line => line.includes("This is a deliberately")) ?? "";
		const continuation = lines.find(line => line.includes("option label") && !line.includes("❯")) ?? "";
		expect(first).toMatch(/│ ❯/);
		expect(continuation).toMatch(/│ {3}/);
	});

	it("does not wrap an option label that fits the dialog content width", () => {
		const component = new AskDialogComponent(
			[{ id: "q1", question: "Pick one?", options: [{ label: "x".repeat(70) }] }],
			{ onSubmit: vi.fn(), onCancel: vi.fn(), onPrompt: vi.fn() },
		);

		const output = render(component);
		expect(output.split("\n").filter(line => line.includes("x"))).toHaveLength(1);
	});

	it("Other editor cancel returns to the option list without submitting", async () => {
		const onPrompt = vi.fn().mockReturnValue(Promise.resolve(undefined));
		const onSubmit = vi.fn();
		const onCancel = vi.fn();
		const questions: ExtensionAskDialogQuestion[] = [
			{
				id: "q1",
				question: "Choose one?",
				options: [{ label: "Option A" }, { label: "Option B" }],
			},
		];

		const component = new AskDialogComponent(questions, {
			onSubmit,
			onCancel,
			onPrompt,
		});

		// Navigate to "Other" and press Enter to open the custom input prompt.
		component.handleInput(DOWN);
		component.handleInput(DOWN);
		component.handleInput(ENTER);
		await Promise.resolve();
		await Promise.resolve();

		// The prompt was cancelled (returns undefined). The dialog must stay
		// open — no submit, no cancel.
		expect(onPrompt).toHaveBeenCalledTimes(1);
		expect(onSubmit).not.toHaveBeenCalled();
		expect(onCancel).not.toHaveBeenCalled();

		// The dialog should still be usable: select Option A and submit.
		component.handleInput("\x1b[A"); // UP to Option B
		component.handleInput("\x1b[A"); // UP to Option A
		component.handleInput(ENTER);

		expect(onSubmit).toHaveBeenCalledTimes(1);
		expect(onSubmit.mock.calls[0][0].results[0].selectedOptions).toEqual(["Option A"]);
	});

	it("keeps a fixed spawn-time height whichever question is open, clamped to 70% of the terminal", () => {
		const questions: ExtensionAskDialogQuestion[] = [
			{
				id: "q1",
				question: "Pick some?",
				options: [{ label: "Option A" }, { label: "Option B" }],
				multi: true,
			},
			{
				id: "q2",
				question: "Pick one?",
				options: Array.from({ length: 6 }, (_, index) => ({ label: `Choice ${index}`, description: "Detail" })),
			},
		];
		const component = new AskDialogComponent(questions, {
			onSubmit: vi.fn(),
			onCancel: vi.fn(),
			onPrompt: vi.fn(),
		});
		const cap = Math.max(12, Math.floor((process.stdout.rows || 40) * 0.7));
		const first = component.render(80);
		expect(first.length).toBeLessThanOrEqual(cap);

		// Opening the taller question renders at exactly the same height — the
		// box is sized once from the tallest column, not per open question.
		component.handleInput(TAB);
		expect(component.render(80).length).toBe(first.length);

		// Toggling an option (which changes the folded summary) does not
		// resize the box either.
		component.handleInput(SHIFT_TAB);
		component.handleInput(SPACE);
		expect(component.render(80).length).toBe(first.length);
	});

	it("clears the custom answer when the Other prompt is submitted empty", async () => {
		const onPrompt = vi.fn();
		const onSubmit = vi.fn();
		const questions: ExtensionAskDialogQuestion[] = [
			{
				id: "q1",
				question: "Choose multiple?",
				options: [{ label: "Option A" }, { label: "Option B" }],
				multi: true,
			},
		];
		const component = new AskDialogComponent(questions, {
			onSubmit,
			onCancel: vi.fn(),
			onPrompt,
		});

		// Set a custom answer via Other.
		onPrompt.mockReturnValueOnce(Promise.resolve("my custom answer"));
		component.handleInput(DOWN); // Option B
		component.handleInput(DOWN); // Other
		component.handleInput(ENTER);
		await Promise.resolve();
		await Promise.resolve();
		expect(render(component)).toContain("my custom answer");

		// The lone multi-select stays open: Enter on Other again edits the saved custom answer.
		onPrompt.mockReturnValueOnce(Promise.resolve(""));
		component.handleInput(ENTER);
		await Promise.resolve();
		await Promise.resolve();
		expect(onSubmit).not.toHaveBeenCalled();
		expect(render(component)).not.toContain("my custom answer");

		// Submitting confirms nothing was kept.
		component.handleInput(UP);
		component.handleInput(ENTER);
		expect(onSubmit).toHaveBeenCalledTimes(1);
		expect(onSubmit.mock.calls[0][0].results[0].customInput).toBeUndefined();
	});

	it("returns images pasted into the custom answer and supplies them again when it is edited", async () => {
		const image: ImageContent = { type: "image", data: "image-data", mimeType: "image/png" };
		const onImagePrompt = vi
			.fn()
			.mockResolvedValueOnce({ text: "see [Image #1]", images: [image] })
			.mockResolvedValueOnce({ text: "see [Image #1] again", images: [image] });
		const onSubmit = vi.fn();
		const component = new AskDialogComponent(
			[{ id: "q1", question: "Choose multiple?", options: [{ label: "Option A" }], multi: true }],
			{ onSubmit, onCancel: vi.fn(), onPrompt: vi.fn(), onImagePrompt },
		);

		component.handleInput(DOWN); // Other
		component.handleInput(ENTER);
		await Promise.resolve();
		await Promise.resolve();
		component.handleInput(ENTER);
		await Promise.resolve();
		await Promise.resolve();
		component.handleInput(UP);
		component.handleInput(ENTER);

		expect(onImagePrompt.mock.calls[1][1]).toEqual({ text: "see [Image #1]", images: [image] });
		expect(onSubmit.mock.calls[0][0].results[0]).toMatchObject({
			customInput: "see [Image #1] again",
			customInputImages: [image],
		});
	});

	it("reopens a cancelled Other prompt with its draft, leaving the submitted answer unchanged (#18211)", async () => {
		const onPrompt = vi
			.fn()
			.mockResolvedValueOnce("first")
			.mockResolvedValueOnce({ draft: { text: "first, then more" } })
			.mockResolvedValueOnce({ draft: { text: "  " } })
			.mockResolvedValueOnce(undefined);
		const onSubmit = vi.fn();
		const component = new AskDialogComponent(
			[{ id: "q1", question: "Choose multiple?", options: [{ label: "Option A" }], multi: true }],
			{ onSubmit, onCancel: vi.fn(), onPrompt },
		);
		const openOther = async () => {
			component.handleInput(ENTER);
			await Promise.resolve();
			await Promise.resolve();
		};

		component.handleInput(DOWN); // Other
		await openOther();
		await openOther(); // cancelled with a draft
		await openOther(); // cancelled after blanking it
		await openOther();

		expect(onPrompt.mock.calls.map(call => call[1])).toEqual([undefined, "first", "first, then more", "first"]);
		component.handleInput(UP);
		component.handleInput(ENTER);
		expect(onSubmit.mock.calls[0][0].results[0].customInput).toBe("first");
	});

	it("drops custom-answer images when the custom answer is cleared", async () => {
		const image: ImageContent = { type: "image", data: "image-data", mimeType: "image/png" };
		const onImagePrompt = vi
			.fn()
			.mockResolvedValueOnce({ text: "[Image #1]", images: [image] })
			.mockResolvedValueOnce({ text: "" });
		const onSubmit = vi.fn();
		const component = new AskDialogComponent(
			[{ id: "q1", question: "Choose multiple?", options: [{ label: "Option A" }], multi: true }],
			{ onSubmit, onCancel: vi.fn(), onPrompt: vi.fn(), onImagePrompt },
		);

		component.handleInput(DOWN); // Other
		component.handleInput(ENTER);
		await Promise.resolve();
		await Promise.resolve();
		component.handleInput(ENTER);
		await Promise.resolve();
		await Promise.resolve();
		component.handleInput(UP);
		component.handleInput(ENTER);

		const submitted = onSubmit.mock.calls[0][0].results[0];
		expect(submitted.customInput).toBeUndefined();
		expect(submitted.customInputImages).toBeUndefined();
	});

	it("normalizes malformed questions so render and submit do not crash", () => {
		const onSubmit = vi.fn();
		// A question entry that reaches the live dialog without a string
		// `question` field (e.g. via the askDialog extension surface) used to
		// throw `replaceTabs(undefined)` and take down the whole TUI.
		const questions = [{ id: "q1", options: [{ label: "Option A" }] }] as unknown as ExtensionAskDialogQuestion[];

		const component = new AskDialogComponent(questions, {
			onSubmit,
			onCancel: vi.fn(),
			onPrompt: vi.fn(),
		});

		expect(() => render(component)).not.toThrow();

		component.handleInput(ENTER);
		expect(onSubmit).toHaveBeenCalledTimes(1);
		const result = onSubmit.mock.calls[0][0].results[0];
		expect(result.question).toBe("");
		expect(result.selectedOptions).toEqual(["Option A"]);
	});

	it("sanitizes carriage-return runs so degenerate model args render as prose", () => {
		// GLM-via-OpenRouter degeneration: `\r` runs injected between words in
		// JSON string values. CommonMark treats a lone `\r` as a line ending, so
		// an unsanitized description/preview used to splatter one word per row.
		const component = new AskDialogComponent(
			[
				{
					id: "q3a",
					question: "Q3\r\rA\r\r —\r\r Fallback\r\r path\r\r.\r\r What\r\r happens\r\r?",
					header: "Fallback\r\r path",
					options: [
						{
							label: "Abort\r\r \r\r+\r\r log",
							description: "The\r\r worker\r\r pool\r\r sees\r\r nothing\r\r.",
							preview: 'idle\r\r loop\r\r:\r\n\r\r \r\r if\r\r "done"\r\r in\r\r state',
						},
						{ label: "Continue\r\r anyway" },
					],
				},
			],
			{ onSubmit: vi.fn(), onCancel: vi.fn(), onPrompt: vi.fn() },
		);

		const rendered = render(component);
		expect(rendered).not.toContain("\r");
		expect(rendered).toContain("Q3 A  —  Fallback  path .  What  happens ?");
		expect(rendered).toContain("Abort   +  log");
		expect(rendered).toContain("The  worker  pool  sees  nothing .");
		expect(rendered).toContain("idle  loop :");
		expect(rendered).toContain('if  "done"  in  state');
	});

	it("echoes extension-supplied question ids verbatim in results", () => {
		// The id is a caller correlation key the dialog never shows:
		// submitted results must carry the original value or code indexing
		// the response by request id will miss.
		const onSubmit = vi.fn();
		const component = new AskDialogComponent(
			[{ id: "q\r\r3a", question: "Pick one?", options: [{ label: "Alpha" }, { label: "Beta" }] }],
			{ onSubmit, onCancel: vi.fn(), onPrompt: vi.fn() },
		);

		expect(render(component)).not.toContain("\r");

		component.handleInput(ENTER);
		expect(onSubmit).toHaveBeenCalledTimes(1);
		expect(onSubmit.mock.calls[0][0].results[0].id).toBe("q\r\r3a");
	});

	it("echoes the extension-supplied question verbatim in results", () => {
		// The question text is echoed in results like ids and labels: the
		// guest path returns it verbatim, so the local dialog must too —
		// display sanitizes (title rows), results echo the original.
		const onSubmit = vi.fn();
		const component = new AskDialogComponent(
			[{ id: "q1", question: "Pick\rnow?", options: [{ label: "Alpha" }, { label: "Beta" }] }],
			{ onSubmit, onCancel: vi.fn(), onPrompt: vi.fn() },
		);

		const rendered = render(component);
		expect(rendered).not.toContain("\r");
		expect(rendered).toContain("Pick now?");

		component.handleInput(ENTER);
		expect(onSubmit).toHaveBeenCalledTimes(1);
		expect(onSubmit.mock.calls[0][0].results[0].question).toBe("Pick\rnow?");
	});

	it("disambiguates local rows that sanitize alike, echoing originals", () => {
		// Same display contract as the guest selector: colliding rows take a
		// numeric suffix and sentinel matches never mimic the action row —
		// results still echo the original correlation values.
		const onSubmit = vi.fn();
		const component = new AskDialogComponent(
			[
				{
					id: "q1",
					question: "Pick?",
					options: [{ label: "Retry\rnow" }, { label: "Retry now" }, { label: "Chat\rabout this" }],
				},
			],
			{ onSubmit, onCancel: vi.fn(), onPrompt: vi.fn() },
		);

		const rendered = render(component);
		expect(rendered).not.toContain("\r");
		expect(rendered).toContain("Retry now (2)");
		expect(rendered).toContain("Chat about this (2)");

		component.handleInput(ENTER);
		expect(onSubmit).toHaveBeenCalledTimes(1);
		const result = onSubmit.mock.calls[0][0].results[0];
		expect(result.options).toEqual(["Retry\rnow", "Retry now", "Chat\rabout this"]);
		expect(result.selectedOptions).toEqual(["Retry\rnow"]);
	});

	it("disambiguates rows the recommendation badge collides", () => {
		// Badging happens before disambiguation: a recommended `Retry\rnow`
		// and a literal `Retry now (Recommended)` would otherwise render two
		// identical rows with different result values.
		const component = new AskDialogComponent(
			[
				{
					id: "q1",
					question: "Pick?",
					options: [{ label: "Retry\rnow" }, { label: "Retry now (Recommended)" }],
					recommended: 0,
				},
			],
			{ onSubmit: vi.fn(), onCancel: vi.fn(), onPrompt: vi.fn() },
		);

		const rendered = render(component);
		expect(rendered).not.toContain("\r");
		const rows = rendered.split("\n").filter(line => line.includes("Retry now (Recommended)"));
		expect(rows).toHaveLength(2);
		expect(rows[1]).toContain("Retry now (Recommended) (2)");
	});

	describe("stacked rows", () => {
		const lines = (component: AskDialogComponent, width = 80): string[] =>
			component.render(width).map(line => stripVTControlCharacters(line));
		const withTerminalRows = (rows: number, run: () => void): void => {
			const original = Object.getOwnPropertyDescriptor(process.stdout, "rows");
			Object.defineProperty(process.stdout, "rows", { configurable: true, value: rows });
			try {
				run();
			} finally {
				if (original) Object.defineProperty(process.stdout, "rows", original);
				else Reflect.deleteProperty(process.stdout, "rows");
			}
		};

		it("folds every question but the open one to its question over its summary", async () => {
			const onPrompt = vi.fn().mockResolvedValue("my own words");
			const rollout = ["Behind a flag", "Default on", "Next minor release", "Canary", "Beta", "Never"];
			const component = new AskDialogComponent(
				[
					{ id: "q1", question: "First?", options: [{ label: "A1" }, { label: "B1" }] },
					{ id: "q2", question: "Rollout?", options: rollout.map(label => ({ label })) },
					{ id: "q3", question: "Third?", options: [{ label: "C1" }] },
				],
				{ onSubmit: vi.fn(), onCancel: vi.fn(), onPrompt },
			);

			// Nothing chosen: a folded question lists its first four options and how many more.
			let shown = lines(component);
			expect(shown).toContainEqual(expect.stringContaining("│ ○ Rollout?"));
			expect(shown).toContainEqual(
				expect.stringContaining("│    Behind a flag   Default on   Next minor release   Canary   +2"),
			);
			expect(shown).not.toContainEqual(expect.stringContaining("○ Behind a flag"));

			// A custom answer folds to its text; a chosen option shows marked among its options.
			component.handleInput(DOWN);
			component.handleInput(DOWN);
			component.handleInput(ENTER);
			await Promise.resolve();
			await Promise.resolve();
			component.handleInput(DOWN);
			component.handleInput(ENTER);
			shown = lines(component);
			expect(shown).toContainEqual(expect.stringContaining("│ ✓ First?"));
			expect(shown.join("\n")).toContain("Other: “my own words”");
			expect(shown).toContainEqual(expect.stringContaining("│ ✓ Rollout?"));
			expect(shown).toContainEqual(
				expect.stringContaining("│    Behind a flag   ✓ Default on   Next minor release   Canary   +2"),
			);
			expect(shown).toContainEqual(expect.stringContaining("❯ ○ C1"));
			expect(shown[0]).toContain("Ask · 2 of 3 answered");
		});

		it("↓ past a question's last row opens the next question; ↑ comes back to that row", () => {
			const component = new AskDialogComponent(
				[
					{ id: "q1", question: "First?", options: [{ label: "A1" }, { label: "B1" }] },
					{ id: "q2", question: "Second?", options: [{ label: "A2" }, { label: "B2" }] },
				],
				{ onSubmit: vi.fn(), onCancel: vi.fn(), onPrompt: vi.fn() },
			);

			component.handleInput(DOWN);
			component.handleInput(DOWN);
			expect(render(component)).toContain("❯ ○ Other (type your own)");

			component.handleInput(DOWN);
			let out = render(component);
			expect(out).toContain("❯ ○ A2");
			expect(out).toContain("○ First?");
			expect(out).toContain("A1   B1");
			expect(out).not.toContain("○ B1");

			component.handleInput(UP);
			out = render(component);
			expect(out).toContain("❯ ○ Other (type your own)");
			expect(out).toContain("○ B1");
			expect(out).toContain("A2   B2");
		});

		// A 16-row terminal leaves 8 rows to the panel (ASK_RESERVED_ROWS under it); a 10-row one only
		// the minimum: the borders and five body rows.
		for (const [terminalRows, panelRows] of [
			[16, 8],
			[10, 7],
		] as const) {
			it(`fits a ${terminalRows}-row terminal in ${panelRows} rows, scrolling to the focused row and its question both ways`, () => {
				withTerminalRows(terminalRows, () => {
					const names = ["First", "Second", "Third", "Fourth"];
					const component = new AskDialogComponent(
						names.map((name, index) => ({
							id: `q${index}`,
							question: `${name}?`,
							options: Array.from({ length: 3 }, (_, option) => ({ label: `${name} option ${option}` })),
						})),
						{ onSubmit: vi.fn(), onCancel: vi.fn(), onPrompt: vi.fn() },
					);
					// Each question has four rows (three options and Other).
					const expectFocusShown = (step: number): void => {
						const shown = lines(component);
						expect(shown).toHaveLength(panelRows);
						const open = names[Math.floor(step / 4)];
						expect(shown).toContainEqual(expect.stringContaining(`○ ${open}?`));
						const cursor = shown.find(line => line.includes("❯")) ?? "";
						const row = step % 4;
						expect(cursor).toContain(row === 3 ? "Other (type your own)" : `${open} option ${row}`);
					};

					for (let step = 0; step < 16; step++) {
						expectFocusShown(step);
						if (step < 15) component.handleInput(DOWN);
					}
					expect(lines(component)).not.toContainEqual(expect.stringContaining("First?"));

					for (let step = 15; step >= 0; step--) {
						expectFocusShown(step);
						if (step > 0) component.handleInput(UP);
					}
					expect(lines(component)).not.toContainEqual(expect.stringContaining("Fourth?"));
				});
			});
		}

		it("shows the skip notice as one warning line under the body, keeping the panel's height", () => {
			const skip: { notice?: string } = {};
			const component = new AskDialogComponent(
				[
					{ id: "q1", question: "First?", options: [{ label: "A1" }] },
					{ id: "q2", question: "Second?", options: [{ label: "A2" }] },
				],
				{ onSubmit: vi.fn(), onCancel: vi.fn(), onPrompt: vi.fn() },
				{ skipNotice: () => skip.notice },
			);
			const plain = lines(component);
			expect(plain.join("\n")).not.toContain("⚠");

			skip.notice = "Sending your draft skips this ask";
			const warned = lines(component);
			expect(warned).toHaveLength(plain.length);
			const at = warned.findIndex(line => line.includes("⚠ Sending your draft skips this ask"));
			expect(at).toBe(warned.length - 2);
			expect(warned.at(-1)).toMatch(/^╰─+╯$/);
		});
	});
});
