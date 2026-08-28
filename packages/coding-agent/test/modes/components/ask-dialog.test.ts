import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { KeybindingsManager } from "@oh-my-pi/pi-coding-agent/config/keybindings";
import type { ExtensionAskDialogQuestion } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { AskDialogComponent } from "@oh-my-pi/pi-coding-agent/modes/components/ask-dialog";
import { getThemeByName, setThemeInstance, type Theme, theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { CURSOR_MARKER, setKeybindings } from "@oh-my-pi/pi-tui";

const DOWN = "\x1b[B";
const UP = "\x1b[A";
const PAGE_DOWN = "\x1b[6~";
const ENTER = "\n";
const CANCEL = "\x07";
const SPACE = " ";
const TAB = "\t";
const SHIFT_TAB = "\x1b[Z";
const RIGHT = "\x1b[C";
const LEFT = "\x1b[D";
const BACKSPACE = "\x7f";

let darkTheme = await getThemeByName("dark");
// setThemeInstance replaces process-wide theme state and disables
// auto-detection, so capture the prior instance and restore it after the
// file; otherwise later test files inherit this file's dark theme.
let priorTheme: Theme | undefined;

function render(component: AskDialogComponent): string {
	return stripVTControlCharacters(component.render(80).join("\n"));
}

describe("AskDialogComponent", () => {
	beforeAll(async () => {
		priorTheme = theme;
		darkTheme = await getThemeByName("dark");
		if (!darkTheme) throw new Error("Failed to load dark theme");
	});

	beforeEach(() => {
		if (!darkTheme) throw new Error("Failed to load dark theme");
		setThemeInstance(darkTheme);
		setKeybindings(KeybindingsManager.inMemory({ "tui.select.cancel": "ctrl+g" }));
	});

	afterEach(() => {
		setKeybindings(KeybindingsManager.inMemory());
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	afterAll(() => {
		if (priorTheme) setThemeInstance(priorTheme);
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

	it("multi-question, single-select: Enter on option advances tab, does not submit", () => {
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

		// Press Enter on A1 - should advance tab to Q2 (tab 1), not submit
		component.handleInput(ENTER);
		expect(onSubmit).not.toHaveBeenCalled();

		// On Q2: Down to B2 and Enter - should advance tab to Submit (tab 2), not submit
		component.handleInput(DOWN);
		component.handleInput(ENTER);
		expect(onSubmit).not.toHaveBeenCalled();

		// On Submit tab: Enter on Submit row - should submit
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
		expect(render(component)).toContain("❯ 1 ☑ Generic MLE loop (Recommended)");

		component.handleInput(SPACE);
		expect(render(component)).toContain("❯ 1 ☐ Generic MLE loop (Recommended)");

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

	it("tab-state persistence: answer question 0, Tab forward, Tab back, answer still present", () => {
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

		// Enter on A1 selects it and auto-advances to Q2 (tab 1)
		component.handleInput(ENTER);

		// Shift+Tab back to Q1 (tab 0)
		component.handleInput(SHIFT_TAB);

		// Enter again on Q1's currently selected option (which will re-select/keep it and auto-advance to Q2)
		component.handleInput(ENTER);

		// On Q2: select B2 and advance to Submit
		component.handleInput(DOWN);
		component.handleInput(ENTER);

		// On Submit: Enter to submit
		component.handleInput(ENTER);

		expect(onSubmit).toHaveBeenCalledTimes(1);
		expect(onSubmit.mock.calls[0][0].results[0].selectedOptions).toEqual(["A1"]);
		expect(onSubmit.mock.calls[0][0].results[1].selectedOptions).toEqual(["B2"]);
	});

	it("Tab and Shift+Tab switches tabs", () => {
		const onSubmit = vi.fn();
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
			onCancel: vi.fn(),
			onPrompt: vi.fn(),
		});

		// Tab from Q1 -> Q2
		component.handleInput(TAB);
		// Tab from Q2 -> Submit
		component.handleInput(TAB);
		// Shift+Tab from Submit -> Q2
		component.handleInput(SHIFT_TAB);

		// Down to B2, Enter -> Submit
		component.handleInput(DOWN);
		component.handleInput(ENTER);

		// Enter on Submit
		component.handleInput(ENTER);

		expect(onSubmit).toHaveBeenCalledTimes(1);
		expect(onSubmit.mock.calls[0][0].results[0].selectedOptions).toEqual([]);
		expect(onSubmit.mock.calls[0][0].results[1].selectedOptions).toEqual(["B2"]);
	});

	it("Submit tab shows unanswered warning but Enter still submits", () => {
		const onSubmit = vi.fn();
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
			onCancel: vi.fn(),
			onPrompt: vi.fn(),
		});

		// Tab to Submit
		component.handleInput(TAB);
		component.handleInput(TAB);

		const output = render(component);
		expect(output.toLowerCase()).toContain("unanswered");

		// Enter on Submit
		component.handleInput(ENTER);

		expect(onSubmit).toHaveBeenCalledTimes(1);
		expect(onSubmit.mock.calls[0][0].results[0].selectedOptions).toEqual([]);
		expect(onSubmit.mock.calls[0][0].results[1].selectedOptions).toEqual([]);
	});

	it("Esc/cancel fires onCancel", () => {
		const onCancel = vi.fn();
		const questions: ExtensionAskDialogQuestion[] = [
			{
				id: "q1",
				question: "Choose one?",
				options: [{ label: "Option A" }],
			},
		];

		const component = new AskDialogComponent(questions, {
			onSubmit: vi.fn(),
			onCancel,
			onPrompt: vi.fn(),
		});

		component.handleInput(CANCEL);
		expect(onCancel).toHaveBeenCalledTimes(1);
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
		expect(onPrompt.mock.calls[0][0]).toBe("Note for Option A: Choose one?");

		// Verify note is saved by submitting
		component.handleInput(ENTER);

		expect(onSubmit).toHaveBeenCalledTimes(1);
		expect(onSubmit.mock.calls[0][0].results[0].note).toBe("My Custom Note");
	});

	it("uppercase N (Shift+N or Caps Lock) opens the note prompt under shipped defaults", async () => {
		const onPrompt = vi.fn().mockReturnValue(Promise.resolve("Upper note"));
		const questions: ExtensionAskDialogQuestion[] = [
			{
				id: "q1",
				question: "Choose one?",
				options: [{ label: "Option A" }, { label: "Option B" }],
			},
		];

		const component = new AskDialogComponent(questions, {
			onSubmit: vi.fn(),
			onCancel: vi.fn(),
			onPrompt,
		});

		// Terminals deliver Shift+N as a bare uppercase N; the manager
		// canonicalizes it to `shift+n`, which the bare `n` default must not miss.
		component.handleInput("N");
		await Promise.resolve();
		await Promise.resolve();

		expect(onPrompt).toHaveBeenCalledTimes(1);
		expect(onPrompt.mock.calls[0][0]).toBe("Note for Option A: Choose one?");

		// `n` and `shift+n` are one physical key, so the footer hint collapses
		// the pair instead of advertising a second, nonexistent shortcut.
		const out = render(component);
		expect(out).toContain("N note");
		expect(out).not.toContain("Shift+N");
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
		expect(onPrompt.mock.calls[0][0]).toBe("Note for Option A: Choose one?");
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
		component.handleInput(UP); // UP
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

		// Select Option B and confirm from the Submit tab; the cleared note
		// must not resurface.
		component.handleInput(DOWN);
		component.handleInput(SPACE);
		component.handleInput(TAB);
		component.handleInput(ENTER);

		expect(onSubmit).toHaveBeenCalledTimes(1);
		expect(onSubmit.mock.calls[0][0].results[0].selectedOptions).toEqual(["Option B"]);
		expect(onSubmit.mock.calls[0][0].results[0].note).toBeUndefined();
	});

	it("shows selected multi-select options together with custom input on Submit", async () => {
		const onPrompt = vi.fn().mockReturnValue(Promise.resolve("custom detail"));
		const onSubmit = vi.fn();
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
				options: [{ label: "Option C" }],
			},
		];

		const component = new AskDialogComponent(questions, {
			onSubmit,
			onCancel: vi.fn(),
			onPrompt,
		});

		component.handleInput(SPACE);
		component.handleInput(DOWN);
		component.handleInput(DOWN);
		component.handleInput(ENTER);
		await Promise.resolve();
		await Promise.resolve();

		// Multi questions do not auto-advance after the Other prompt: still on
		// q1, so Tab twice (q2, then Submit) to reach the review.
		component.handleInput(TAB);
		component.handleInput(TAB);
		const review = render(component);
		expect(review).toContain("Option A");
		expect(review).toContain("custom detail");

		component.handleInput(ENTER);

		expect(onSubmit).toHaveBeenCalledTimes(1);
		expect(onSubmit.mock.calls[0][0].results[0].selectedOptions).toEqual(["Option A"]);
		expect(onSubmit.mock.calls[0][0].results[0].customInput).toBe("custom detail");
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
		expect(render(component)).toContain("Space toggle · Enter next");

		// Space toggles Option A; Enter on the plain option row confirms and
		// advances to Q2 instead of submitting the whole dialog (#8265 review).
		component.handleInput(SPACE);
		component.handleInput(ENTER);
		expect(onSubmit).not.toHaveBeenCalled();

		// On Q2: Down to Option D and Enter advances to the Submit tab.
		component.handleInput(DOWN);
		component.handleInput(ENTER);
		expect(onSubmit).not.toHaveBeenCalled();

		// On the Submit tab Enter submits once with both answers.
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

	it("does not reset the countdown while a prompt is active", async () => {
		vi.useFakeTimers();
		const deferred = Promise.withResolvers<string | undefined>();
		const onPrompt = vi.fn().mockReturnValue(deferred.promise);
		const onTimeout = vi.fn();
		const questions: ExtensionAskDialogQuestion[] = [
			{
				id: "q1",
				question: "Choose one?",
				options: [{ label: "Option A" }],
			},
		];

		const component = new AskDialogComponent(
			questions,
			{ onSubmit: vi.fn(), onCancel: vi.fn(), onPrompt },
			{ timeout: 5000, onTimeout },
		);

		// Open the custom-input prompt (DOWN to "Other", ENTER).
		component.handleInput(DOWN);
		component.handleInput(ENTER);
		expect(onPrompt).toHaveBeenCalledTimes(1);

		// While the prompt is pending, input is guarded — no reset.
		component.handleInput(DOWN);
		vi.advanceTimersByTime(5000);
		// Timeout is deferred during prompt, not fired.
		expect(onTimeout).not.toHaveBeenCalled();

		deferred.resolve("answer");
		await Promise.resolve();
		await Promise.resolve();
	});

	it("bounds custom input prompt title for long multi-line questions", async () => {
		const onPrompt = vi.fn().mockReturnValue(Promise.resolve("custom"));
		const longQuestion = "This is a very long question ".repeat(20);
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
		const title = onPrompt.mock.calls[0][0] as string;
		const lines = title.split("\n");
		// Title must be bounded to at most MAX_PROMPT_TITLE_ROWS lines.
		expect(lines.length).toBeLessThanOrEqual(3);
		// Each line must fit within the terminal content width.
		for (const line of lines) {
			expect(stripVTControlCharacters(line).length).toBeLessThanOrEqual((process.stdout.columns ?? 80) - 4);
		}
		// Must contain the prefix and a truncation indicator on the last line.
		expect(stripVTControlCharacters(title)).toContain("Custom answer:");
	});

	it("bounds note prompt title for long multi-line questions", async () => {
		const onPrompt = vi.fn().mockReturnValue(Promise.resolve("note"));
		const longQuestion = "Multi\nline\nquestion ".repeat(30);
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

		// Press 'n' on the highlighted option to trigger the note prompt.
		component.handleInput("n");
		await Promise.resolve();
		await Promise.resolve();

		expect(onPrompt).toHaveBeenCalledTimes(1);
		const title = onPrompt.mock.calls[0][0] as string;
		const lines = title.split("\n");
		// Title must be bounded to at most MAX_PROMPT_TITLE_ROWS lines.
		expect(lines.length).toBeLessThanOrEqual(3);
		// The multi-line question must be flattened (no raw newlines expanding rows).
		expect(stripVTControlCharacters(title)).toContain("Note for Option A:");
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
			// Overflow drops the scroll hint before cancel (F9); the list still pages.
			expect(initial).toContain("cancel");

			for (let i = 0; i < 28; i++) component.handleInput(DOWN);
			const scrolled = renderAt(60);
			expect(scrolled).not.toContain("Option 01");
			expect(scrolled).toContain("Option 29");
		} finally {
			if (originalRows) Object.defineProperty(process.stdout, "rows", originalRows);
			else Reflect.deleteProperty(process.stdout, "rows");
		}
	});

	it("single-question multi-select: Enter submits the current selection immediately", () => {
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
		expect(render(component)).toContain("Space toggle · Enter submit");

		// Space selects Option A; Enter submits right away — no need to
		// discover the Submit tab (issue #8252).
		component.handleInput(SPACE);
		component.handleInput(ENTER);

		expect(onSubmit).toHaveBeenCalledTimes(1);
		expect(onSubmit.mock.calls[0][0].results[0].selectedOptions).toEqual(["Option A"]);
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

	it("renders the focused option preview in the side panel", () => {
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
		// Cursor defaults to option 0; only the focused preview appears in the facet.
		const out = stripVTControlCharacters(component.render(80).join("\n"));
		expect(out).toContain("PREVIEW-ALPHA");
		expect(out).not.toContain("PREVIEW-BRAVO");
		component.handleInput(DOWN);
		const next = stripVTControlCharacters(component.render(80).join("\n"));
		expect(next).toContain("PREVIEW-BRAVO");
		expect(next).not.toContain("PREVIEW-ALPHA");
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
		expect(stripVTControlCharacters(before)).toContain("CACHE-PREVIEW");
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

	it("keeps the cancel hint visible with tabs and a tall preview", () => {
		const originalRows = Object.getOwnPropertyDescriptor(process.stdout, "rows");
		Object.defineProperty(process.stdout, "rows", { configurable: true, value: 24 });
		try {
			const preview = `\`\`\`\n${Array.from({ length: 40 }, (_, index) => `line-${index}`).join("\n")}\n\`\`\``;
			const component = new AskDialogComponent(
				[
					{ id: "q1", question: "Inspect?", options: [{ label: "Alpha", preview }], multi: true },
					{ id: "q2", question: "Continue?", options: [{ label: "Bravo" }] },
				],
				{ onSubmit: vi.fn(), onCancel: vi.fn(), onPrompt: vi.fn() },
			);
			const out = render(component);

			// Tall previews live in the side facet, so the list no longer pages them;
			// the footer must still keep tab and cancel affordances.
			expect(out).toContain("Tab/S-Tab");
			expect(out).not.toContain(" tabs");
			expect(out).toContain("Ctrl+G cancel");
			setKeybindings(
				KeybindingsManager.inMemory({
					"tui.select.cancel": "ctrl+g",
					"tui.select.pageUp": "ctrl+u",
					"tui.select.pageDown": "ctrl+d",
				}),
			);
			const remapped = render(component);
			expect(remapped).toContain("Ctrl+G cancel");
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
			expect(out).not.toContain("PgUp/PgDn");
			expect(out).toMatch(/[↓↑↕] scroll/);
			component.handleInput(PAGE_DOWN);
			out = render(component);
			expect(out).toContain("PREVIEW-SHORT-FIRST");
			expect(out).toContain("PREVIEW-SHORT-LAST");
			expect(out).not.toContain("PgUp/PgDn");
			expect(out).toMatch(/[↓↑↕] scroll/);
		} finally {
			if (originalRows) Object.defineProperty(process.stdout, "rows", originalRows);
			else Reflect.deleteProperty(process.stdout, "rows");
		}
	});

	it("does not repeat the tab chip in the question line", () => {
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
		// Tab bar still shows the chip…
		expect(output).toContain("Alpha");
		// …but the question line is just the question, not "[Alpha] First question?".
		expect(output).toContain("First question?");
		expect(output).not.toContain("[Alpha]");
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
		expect(output).toContain("Ctrl+O expand");
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
		expect(collapsed).toContain("Ctrl+O expand");

		component.handleInput("\x0f");
		const expanded = render(component);
		const expandedCount = expanded.match(/This is a very long question/g)?.length ?? 0;
		expect(expandedCount).toBeGreaterThan(collapsedCount);
		const cap = Math.max(12, Math.floor((process.stdout.rows || 40) * 0.7));
		expect(component.render(80).length).toBeLessThanOrEqual(cap);
		// Wrapping can split a few phrases across lines; require a clearly
		// larger header rather than an exact copy count.
		expect(expandedCount).toBeGreaterThanOrEqual(15);
		expect(expanded).toContain("Ctrl+O collapse");
		expect(expanded).not.toContain("Ctrl+O expand");

		component.handleInput("\x0f");
		const recollapsed = render(component);
		expect(recollapsed.match(/This is a very long question/g)?.length ?? 0).toBe(collapsedCount);
		expect(recollapsed).toContain("Ctrl+O expand");
	});

	it("does not consume expansion while the submit tab hides the question header", () => {
		const component = new AskDialogComponent(
			[
				{
					id: "q1",
					question: "This is a very long question ".repeat(30),
					options: [{ label: "Option A" }],
					multi: true,
				},
			],
			{ onSubmit: vi.fn(), onCancel: vi.fn(), onPrompt: vi.fn() },
		);
		component.render(80);
		expect(component.toggleQuestionExpansion()).toBe(true);

		component.handleInput(SHIFT_TAB);
		expect(component.toggleQuestionExpansion()).toBe(false);
	});

	it("leaves a short question unchanged and does not advertise expand", () => {
		const component = new AskDialogComponent(
			[{ id: "q1", question: "Choose one?", options: [{ label: "Option A" }] }],
			{ onSubmit: vi.fn(), onCancel: vi.fn(), onPrompt: vi.fn() },
		);
		const before = render(component);
		expect(before).not.toContain("Ctrl+O expand");
		expect(component.toggleQuestionExpansion()).toBe(false);
		expect(render(component)).toBe(before);
	});

	it("recomputes header expansion at the filtered title width", () => {
		const options = Array.from({ length: 22 }, (_, i) => ({ label: `Option ${i}` }));
		const make = (n: number) =>
			new AskDialogComponent([{ id: "q1", question: "xxxx ".repeat(n).trim(), options }], {
				onSubmit: vi.fn(),
				onCancel: vi.fn(),
				onPrompt: vi.fn(),
			});
		let found = false;
		for (let n = 8; n < 80; n++) {
			const full = make(n);
			full.render(80);
			if (full.toggleQuestionExpansion()) continue;
			const filtered = make(n);
			filtered.render(80);
			filtered.focused = true;
			filtered.handleInput("/");
			filtered.render(80);
			if (!filtered.toggleQuestionExpansion()) continue;
			found = true;
			break;
		}
		expect(found).toBe(true);
	});

	it("collapses newlines in the preview facet title to a single line", () => {
		const originalRows = Object.getOwnPropertyDescriptor(process.stdout, "rows");
		Object.defineProperty(process.stdout, "rows", { configurable: true, value: 16 });
		try {
			const component = new AskDialogComponent(
				[
					{
						id: "q1",
						question: "Pick?",
						options: [
							{ label: "Alpha\nBravo", preview: "body-one" },
							{ label: "Other", preview: "body-two" },
						],
					},
				],
				{ onSubmit: vi.fn(), onCancel: vi.fn(), onPrompt: vi.fn() },
			);
			const stripped = stripVTControlCharacters(component.render(80).join("\n"));
			expect(stripped).toContain("Alpha Bravo");
			expect(stripped).not.toMatch(/Alpha\nBravo/);
			const previewLines = stripped.split("\n").filter(line => line.includes("│"));
			expect(previewLines.some(line => /Alpha Bravo/.test(line))).toBe(true);
		} finally {
			if (originalRows) Object.defineProperty(process.stdout, "rows", originalRows);
			else Reflect.deleteProperty(process.stdout, "rows");
		}
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
		// The unique label tail must be present on the list side — no ellipsis truncation there.
		expect(output).toContain(tail);
		const listLines = output.split("\n").filter(line => {
			const dividerAt = line.indexOf("│", 1);
			const listPart = dividerAt > 0 ? line.slice(0, dividerAt) : line;
			return listPart.includes("deliberately") || listPart.includes(tail) || listPart.includes("option label");
		});
		expect(
			listLines.some(line => {
				const dividerAt = line.indexOf("│", 1);
				const listPart = dividerAt > 0 ? line.slice(0, dividerAt) : line;
				return listPart.includes("…");
			}),
		).toBe(false);
		// The first line carries the cursor glyph; continuation lines are
		// indented under the marker so the cursor stays visually anchored.
		const lines = output.split("\n");
		const first = lines.find(line => line.includes("This is a deliberately")) ?? "";
		const continuation = lines.find(line => line.includes("option label") && !line.includes("❯")) ?? "";
		expect(first).toMatch(/│ ❯/);
		expect(continuation).toMatch(/│ {3}/);
	});

	it("does not wrap an option label that fits the list facet width", () => {
		const component = new AskDialogComponent(
			[{ id: "q1", question: "Pick one?", options: [{ label: "x".repeat(20) }] }],
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
		component.handleInput(UP); // UP to Option B
		component.handleInput(UP); // UP to Option A
		component.handleInput(ENTER);

		expect(onSubmit).toHaveBeenCalledTimes(1);
		expect(onSubmit.mock.calls[0][0].results[0].selectedOptions).toEqual(["Option A"]);
	});

	it("keeps a fixed spawn-time height across tabs, clamped to 70% of the terminal", () => {
		const questions: ExtensionAskDialogQuestion[] = [
			{
				id: "q1",
				question: "Pick one?",
				options: [{ label: "Option A" }, { label: "Option B" }],
				multi: true,
			},
		];
		const component = new AskDialogComponent(questions, {
			onSubmit: vi.fn(),
			onCancel: vi.fn(),
			onPrompt: vi.fn(),
		});
		const cap = Math.max(12, Math.floor((process.stdout.rows || 40) * 0.7));
		const questionTab = component.render(80);
		expect(questionTab.length).toBeLessThanOrEqual(cap);

		// The submit tab renders at exactly the same height — the box is
		// sized once from the tallest tab, not per-tab content.
		component.handleInput(TAB);
		const submitTab = component.render(80);
		expect(submitTab.length).toBe(questionTab.length);

		// Toggling an option (which changes the review summary) does not
		// resize the box either.
		component.handleInput(SHIFT_TAB);
		component.handleInput(SPACE);
		expect(component.render(80).length).toBe(questionTab.length);
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

		// Reopen Other (prefilled with the current answer) and submit an
		// empty value: the custom answer is unselected.
		onPrompt.mockReturnValueOnce(Promise.resolve(""));
		component.handleInput(ENTER);
		await Promise.resolve();
		await Promise.resolve();
		expect(onPrompt).toHaveBeenNthCalledWith(2, expect.any(String), "my custom answer");
		expect(render(component)).not.toContain("my custom answer");

		// Submitting confirms nothing was kept.
		component.handleInput(TAB);
		component.handleInput(ENTER);
		expect(onSubmit).toHaveBeenCalledTimes(1);
		expect(onSubmit.mock.calls[0][0].results[0].customInput).toBeUndefined();
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

	it("keeps markers and a non-empty footer at a 40-column width", () => {
		const questions: ExtensionAskDialogQuestion[] = [
			{
				id: "q1",
				question: "Pick?",
				options: [{ label: "Alpha choice" }, { label: "Bravo choice" }, { label: "Charlie choice" }],
			},
		];
		const component = new AskDialogComponent(questions, {
			onSubmit: vi.fn(),
			onCancel: vi.fn(),
			onPrompt: vi.fn(),
		});
		const lines = stripVTControlCharacters(component.render(40).join("\n")).split("\n");
		for (const label of ["Alpha", "Bravo", "Charlie"]) {
			expect(lines.some(line => line.includes(label))).toBe(true);
		}
		expect(lines.some(line => line.includes("○"))).toBe(true);
		const footer = [...lines].reverse().find(line => line.includes("cancel") || line.includes("Enter")) ?? "";
		expect(footer.trim().length).toBeGreaterThan(0);
		expect(footer).toContain("cancel");
	});

	it("renders preview inside the expanded row when the side facet collapses", () => {
		const questions: ExtensionAskDialogQuestion[] = [
			{
				id: "q1",
				question: "Pick?",
				options: [{ label: "Alpha", preview: "NARROW-PREVIEW-TEXT" }, { label: "Bravo" }],
			},
		];
		const component = new AskDialogComponent(questions, {
			onSubmit: vi.fn(),
			onCancel: vi.fn(),
			onPrompt: vi.fn(),
		});
		const narrow = stripVTControlCharacters(component.render(50).join("\n"));
		expect(narrow).not.toContain("NARROW-PREVIEW-TEXT");
		const body = narrow.split("\n").filter(line => line.includes("Alpha") || line.includes("Bravo"));
		expect(body.some(line => line.split("│").length > 3)).toBe(false);
		component.handleInput(RIGHT);
		const expanded = stripVTControlCharacters(component.render(50).join("\n"));
		expect(expanded).toContain("NARROW-PREVIEW-TEXT");
	});

	it("reveals a preview longer than the side facet through the expanded row when split", () => {
		const originalRows = Object.getOwnPropertyDescriptor(process.stdout, "rows");
		Object.defineProperty(process.stdout, "rows", { configurable: true, value: 16 });
		try {
			const preview = Array.from({ length: 40 }, (_, index) => `PREVIEW-LINE-${index + 1}`).join("\n");
			const component = new AskDialogComponent(
				[{ id: "q1", question: "Pick?", options: [{ label: "Alpha", preview }, { label: "Bravo" }] }],
				{ onSubmit: vi.fn(), onCancel: vi.fn(), onPrompt: vi.fn() },
			);
			// Wide enough for the side facet, which is a fixed-height glance: the
			// tail lines are unreachable until the row is expanded.
			const glance = stripVTControlCharacters(component.render(120).join("\n"));
			expect(glance).toContain("PREVIEW-LINE-1");
			expect(glance).not.toContain("PREVIEW-LINE-40");
			expect(glance).toContain("more lines");
			component.handleInput(RIGHT);
			const expanded = stripVTControlCharacters(component.render(120).join("\n"));
			// Expanding moves the whole preview into the scrollable list, so the
			// keyboard can now page to the tail the fixed facet could never show.
			expect(expanded).toContain("PREVIEW-LINE-1");
			let reached = expanded.includes("PREVIEW-LINE-40");
			for (let page = 0; page < 12 && !reached; page++) {
				component.handleInput(PAGE_DOWN);
				reached = stripVTControlCharacters(component.render(120).join("\n")).includes("PREVIEW-LINE-40");
			}
			expect(reached).toBe(true);
		} finally {
			if (originalRows) Object.defineProperty(process.stdout, "rows", originalRows);
			else Reflect.deleteProperty(process.stdout, "rows");
		}
	});

	it("keeps the expand key visible in the preview overflow cue at the narrowest split width", () => {
		const originalRows = Object.getOwnPropertyDescriptor(process.stdout, "rows");
		Object.defineProperty(process.stdout, "rows", { configurable: true, value: 16 });
		try {
			const preview = Array.from({ length: 40 }, (_, index) => `PREVIEW-LINE-${index + 1}`).join("\n");
			const component = new AskDialogComponent(
				[{ id: "q1", question: "Pick?", options: [{ label: "Alpha", preview }, { label: "Bravo" }] }],
				{ onSubmit: vi.fn(), onCancel: vi.fn(), onPrompt: vi.fn() },
			);
			// Width 64 → 60 inner columns: the narrowest layout that still splits,
			// leaving the preview facet 29 columns — one less than the full cue.
			// The cue is the only expand hint here: split mode leaves the footer's
			// preview-suppression hint off, so clipping its key would advertise
			// hidden lines with no way to reach them.
			const narrow = stripVTControlCharacters(component.render(64).join("\n"));
			expect(narrow).toContain("PREVIEW-LINE-1");
			expect(narrow).not.toContain("PREVIEW-LINE-40");
			expect(narrow).toMatch(/more( lines)? · Right expand/);

			// A longer user-configured binding sheds the count before the key.
			setKeybindings(
				KeybindingsManager.inMemory({ "tui.select.cancel": "ctrl+g", "app.ask.expand": "ctrl+shift+alt+right" }),
			);
			const custom = stripVTControlCharacters(component.render(64).join("\n"));
			expect(custom).toContain("Ctrl+Shift+Alt+Right expand");
			expect(custom).not.toMatch(/\d+ more/);
		} finally {
			if (originalRows) Object.defineProperty(process.stdout, "rows", originalRows);
			else Reflect.deleteProperty(process.stdout, "rows");
		}
	});

	it("jumps focus to the nth visible row with digit keys", () => {
		const questions: ExtensionAskDialogQuestion[] = [
			{
				id: "q1",
				question: "Pick?",
				options: [{ label: "One" }, { label: "Two" }, { label: "Three" }, { label: "Four" }, { label: "Five" }],
			},
		];
		const component = new AskDialogComponent(questions, {
			onSubmit: vi.fn(),
			onCancel: vi.fn(),
			onPrompt: vi.fn(),
		});
		component.focused = true;
		component.handleInput("4");
		const lines = component.render(80);
		const marked = lines.findIndex(line => line.includes(CURSOR_MARKER));
		expect(marked).toBeGreaterThanOrEqual(0);
		expect(stripVTControlCharacters(lines[marked] ?? "")).toContain("Four");
	});

	it("filters options, renumbers jump digits, and cancels only after clearing the filter", () => {
		const originalRows = Object.getOwnPropertyDescriptor(process.stdout, "rows");
		Object.defineProperty(process.stdout, "rows", { configurable: true, value: 16 });
		try {
			const onCancel = vi.fn();
			const options = Array.from({ length: 20 }, (_, index) => ({
				label: `Option ${String(index + 1).padStart(2, "0")}`,
			}));
			const component = new AskDialogComponent([{ id: "q1", question: "Pick many?", options }], {
				onSubmit: vi.fn(),
				onCancel,
				onPrompt: vi.fn(),
			});
			component.focused = true;
			component.handleInput("/");
			component.handleInput("1");
			let out = stripVTControlCharacters(component.render(80).join("\n")).replaceAll(CURSOR_MARKER, "");
			expect(out).toContain("/ 1");
			expect(out).toMatch(/\d+\/21/);
			const focusedLine = out.split("\n").find(line => line.includes("❯"));
			expect(focusedLine).toContain("Option 01");
			component.handleInput(CANCEL);
			out = stripVTControlCharacters(component.render(80).join("\n")).replaceAll(CURSOR_MARKER, "");
			expect(out).not.toContain("/ 1");
			expect(onCancel).not.toHaveBeenCalled();
			component.handleInput(CANCEL);
			expect(onCancel).toHaveBeenCalledTimes(1);
		} finally {
			if (originalRows) Object.defineProperty(process.stdout, "rows", originalRows);
			else Reflect.deleteProperty(process.stdout, "rows");
		}
	});
	it("declares both cursors while filtering, the filter bar's marker last (bottom-most wins)", () => {
		const originalRows = Object.getOwnPropertyDescriptor(process.stdout, "rows");
		Object.defineProperty(process.stdout, "rows", { configurable: true, value: 16 });
		try {
			const options = Array.from({ length: 8 }, (_, index) => ({
				label: `Option ${String(index + 1).padStart(2, "0")}`,
			}));
			const component = new AskDialogComponent([{ id: "q1", question: "Pick?", options }], {
				onSubmit: vi.fn(),
				onCancel: vi.fn(),
				onPrompt: vi.fn(),
			});
			component.focused = true;
			component.handleInput("/");
			const frame = component.render(80);
			const markerLines: number[] = [];
			frame.forEach((line, index) => {
				if (line.includes(CURSOR_MARKER)) markerLines.push(index);
			});
			expect(markerLines).toHaveLength(2);
			// Focused row marker first; the bottom filter bar's marker follows it,
			// so the TUI's bottom-most marker belongs to the filter while open.
			expect(stripVTControlCharacters(frame[markerLines[0] ?? -1] ?? "")).toContain("❯");
			expect(stripVTControlCharacters(frame[markerLines[1] ?? -1] ?? "")).toContain("/");
			expect(markerLines[1] ?? -1).toBeGreaterThan(markerLines[0] ?? -1);
		} finally {
			if (originalRows) Object.defineProperty(process.stdout, "rows", originalRows);
			else Reflect.deleteProperty(process.stdout, "rows");
		}
	});
	it("keeps the divider and preview facet continuous across the bottom filter bar when split", () => {
		const originalRows = Object.getOwnPropertyDescriptor(process.stdout, "rows");
		Object.defineProperty(process.stdout, "rows", { configurable: true, value: 16 });
		try {
			// At least 5 options so the filter is available and actually opens.
			const options = [
				{ label: "Alpha", preview: "FILTER-ROW-PREVIEW" },
				{ label: "Bravo" },
				{ label: "Charlie" },
				{ label: "Delta" },
				{ label: "Echo" },
			];
			const component = new AskDialogComponent([{ id: "q1", question: "Pick?", options }], {
				onSubmit: vi.fn(),
				onCancel: vi.fn(),
				onPrompt: vi.fn(),
			});
			// Dialog not focused: the focused row emits no cursor marker, so the
			// filter input's marker uniquely locates the bottom bar.
			component.handleInput("/");
			const frame = component.render(80); // width 80 -> split facet active
			const stripped = frame.map(line => stripVTControlCharacters(line));
			// The APC cursor marker survives stripVTControlCharacters, so drop it
			// before measuring columns (it inflates character indexes, not cells).
			const clean = (line: string): string => stripVTControlCharacters(line).replaceAll(CURSOR_MARKER, "");
			const facetDivider = (line: string): number => clean(line).indexOf("│", 1);
			const barIdx = frame.findIndex(line => line.includes(CURSOR_MARKER));
			expect(barIdx).toBeGreaterThanOrEqual(0);
			const previewRowIdx = stripped.findIndex(line => line.includes("FILTER-ROW-PREVIEW"));
			expect(previewRowIdx).toBeGreaterThanOrEqual(0);
			expect(barIdx).toBeGreaterThan(previewRowIdx); // bar sits below the list/preview rows
			// The bar spans only the list width, so the facet divider survives at
			// the same column as a regular split row (finding 2: a full-width bar
			// would push the divider and preview facet off this line).
			const barDivider = facetDivider(stripped[barIdx] ?? "");
			const rowDivider = facetDivider(stripped[previewRowIdx] ?? "");
			expect(barDivider).toBeGreaterThan(0);
			expect(barDivider).toBe(rowDivider);
			// The bar composes the filter cell + divider + preview-facet cell.
			const barList = (stripped[barIdx] ?? "").slice(0, barDivider);
			expect(barList).toContain("/");
		} finally {
			if (originalRows) Object.defineProperty(process.stdout, "rows", originalRows);
			else Reflect.deleteProperty(process.stdout, "rows");
		}
	});

	it("leaves only the focused-row cursor once Escape closes the filter", () => {
		const originalRows = Object.getOwnPropertyDescriptor(process.stdout, "rows");
		Object.defineProperty(process.stdout, "rows", { configurable: true, value: 16 });
		try {
			const options = Array.from({ length: 6 }, (_, index) => ({
				label: `Option ${String(index + 1).padStart(2, "0")}`,
			}));
			const component = new AskDialogComponent([{ id: "q1", question: "Pick?", options }], {
				onSubmit: vi.fn(),
				onCancel: vi.fn(),
				onPrompt: vi.fn(),
			});
			component.focused = true;
			component.handleInput("/");
			expect(component.render(80).filter(line => line.includes(CURSOR_MARKER))).toHaveLength(2);
			component.handleInput(CANCEL);
			const markers = component.render(80).filter(line => line.includes(CURSOR_MARKER));
			expect(markers).toHaveLength(1);
			// The surviving marker belongs to the focused option row after the filter input has closed.
			expect(stripVTControlCharacters(markers[0] ?? "")).toContain("❯");
		} finally {
			if (originalRows) Object.defineProperty(process.stdout, "rows", originalRows);
			else Reflect.deleteProperty(process.stdout, "rows");
		}
	});

	it("keeps a single cursor marker on the focused row and submits it on Enter", () => {
		const onSubmit = vi.fn();
		const questions: ExtensionAskDialogQuestion[] = [
			{
				id: "q1",
				question: "Pick?",
				options: [{ label: "Alpha", preview: "CURSOR-PREVIEW" }, { label: "Bravo" }],
			},
		];
		const component = new AskDialogComponent(questions, {
			onSubmit,
			onCancel: vi.fn(),
			onPrompt: vi.fn(),
		});
		component.focused = true;
		const frame = component.render(80);
		const markerLines = frame.filter(line => line.includes(CURSOR_MARKER));
		expect(markerLines).toHaveLength(1);
		expect(stripVTControlCharacters(markerLines[0] ?? "")).toContain("Alpha");
		const previewOnly = frame.filter(
			line => stripVTControlCharacters(line).includes("CURSOR-PREVIEW") && line.includes(CURSOR_MARKER),
		);
		expect(previewOnly).toHaveLength(0);
		component.handleInput(ENTER);
		expect(onSubmit).toHaveBeenCalledTimes(1);
		expect(onSubmit.mock.calls[0][0].results[0].selectedOptions).toEqual(["Alpha"]);
	});

	it("clamps submit-tab scrolling to the rendered line count", () => {
		const questions: ExtensionAskDialogQuestion[] = [
			{ id: "q1", question: "Q1?", options: [{ label: "A" }], multi: true },
			{ id: "q2", question: "Q2?", options: [{ label: "B" }] },
		];
		const component = new AskDialogComponent(questions, {
			onSubmit: vi.fn(),
			onCancel: vi.fn(),
			onPrompt: vi.fn(),
		});
		component.handleInput(TAB);
		component.handleInput(TAB);
		expect(render(component)).toContain("Review answers");
		for (let i = 0; i < 50; i++) component.handleInput(DOWN);
		const out = render(component);
		expect(out).toContain("Review answers");
		expect(out).toContain("Submit");
	});

	it("timeout auto-select ignores an active filter and keeps the recommended option", () => {
		vi.useFakeTimers();
		const originalRows = Object.getOwnPropertyDescriptor(process.stdout, "rows");
		Object.defineProperty(process.stdout, "rows", { configurable: true, value: 16 });
		try {
			const onSubmit = vi.fn();
			const onTimeout = vi.fn();
			const options = [
				{ label: "Recommended" },
				...Array.from({ length: 20 }, (_, index) => ({ label: `Zzz ${index}` })),
			];
			const component = new AskDialogComponent(
				[{ id: "q1", question: "Pick?", options, recommended: 0 }],
				{ onSubmit, onCancel: vi.fn(), onPrompt: vi.fn() },
				{ timeout: 1000, onTimeout },
			);
			component.handleInput("/");
			for (const ch of "Zzz") component.handleInput(ch);
			const filtered = stripVTControlCharacters(component.render(80).join("\n"));
			expect(filtered).toMatch(/\d+\/22/);
			expect(filtered).not.toContain("❯ 1 ○ Recommended");
			vi.advanceTimersByTime(1000);
			expect(onTimeout).toHaveBeenCalledTimes(1);
			expect(onSubmit).toHaveBeenCalledTimes(1);
			expect(onSubmit.mock.calls[0][0].results[0].selectedOptions).toEqual(["Recommended"]);
			expect(onSubmit.mock.calls[0][0].results[0].timedOut).toBe(true);
		} finally {
			if (originalRows) Object.defineProperty(process.stdout, "rows", originalRows);
			else Reflect.deleteProperty(process.stdout, "rows");
		}
	});

	it("Enter after filtering submits the focused filtered option", () => {
		const originalRows = Object.getOwnPropertyDescriptor(process.stdout, "rows");
		Object.defineProperty(process.stdout, "rows", { configurable: true, value: 16 });
		try {
			const onSubmit = vi.fn();
			const options = [
				{ label: "Alpha" },
				{ label: "Bravo" },
				{ label: "UniqueZebra" },
				...Array.from({ length: 17 }, (_, index) => ({ label: `Filler ${index}` })),
			];
			const component = new AskDialogComponent([{ id: "q1", question: "Pick?", options }], {
				onSubmit,
				onCancel: vi.fn(),
				onPrompt: vi.fn(),
			});
			component.focused = true;
			component.handleInput("/");
			for (const ch of "UniqueZebra") component.handleInput(ch);
			const filtered = stripVTControlCharacters(component.render(80).join("\n")).replaceAll(CURSOR_MARKER, "");
			expect(filtered).toContain("/ UniqueZebra");
			expect(filtered).toContain("UniqueZebra");
			component.handleInput(ENTER);
			expect(onSubmit).toHaveBeenCalledTimes(1);
			expect(onSubmit.mock.calls[0][0].results[0].selectedOptions).toEqual(["UniqueZebra"]);
		} finally {
			if (originalRows) Object.defineProperty(process.stdout, "rows", originalRows);
			else Reflect.deleteProperty(process.stdout, "rows");
		}
	});

	it("up/down while filtering move list focus without typing into the query", () => {
		const originalRows = Object.getOwnPropertyDescriptor(process.stdout, "rows");
		Object.defineProperty(process.stdout, "rows", { configurable: true, value: 16 });
		try {
			const onSubmit = vi.fn();
			const options = [
				{ label: "Alpha match" },
				{ label: "Bravo match" },
				...Array.from({ length: 18 }, (_, index) => ({ label: `Other ${index}` })),
			];
			const component = new AskDialogComponent([{ id: "q1", question: "Pick?", options }], {
				onSubmit,
				onCancel: vi.fn(),
				onPrompt: vi.fn(),
			});
			component.focused = true;
			component.handleInput("/");
			for (const ch of "match") component.handleInput(ch);
			component.handleInput(DOWN);
			const out = stripVTControlCharacters(component.render(80).join("\n")).replaceAll(CURSOR_MARKER, "");
			expect(out).toContain("/ match");
			expect(out).toContain("❯ 2");
			expect(out).toContain("Bravo match");
			component.handleInput(ENTER);
			expect(onSubmit).toHaveBeenCalledTimes(1);
			expect(onSubmit.mock.calls[0][0].results[0].selectedOptions).toEqual(["Bravo match"]);
		} finally {
			if (originalRows) Object.defineProperty(process.stdout, "rows", originalRows);
			else Reflect.deleteProperty(process.stdout, "rows");
		}
	});

	it("pins the cancel hint when the footer overflows at a narrow width", () => {
		const originalRows = Object.getOwnPropertyDescriptor(process.stdout, "rows");
		Object.defineProperty(process.stdout, "rows", { configurable: true, value: 16 });
		try {
			const options = Array.from({ length: 20 }, (_, index) => ({
				label: `Option ${String(index + 1).padStart(2, "0")}`,
				preview: "PREVIEW",
			}));
			const component = new AskDialogComponent(
				[
					{ id: "q1", question: "Pick many?", options, multi: true },
					{ id: "q2", question: "Next?", options: [{ label: "X" }] },
				],
				{ onSubmit: vi.fn(), onCancel: vi.fn(), onPrompt: vi.fn() },
			);
			const out = stripVTControlCharacters(component.render(50).join("\n"));
			expect(out).toContain("cancel");
		} finally {
			if (originalRows) Object.defineProperty(process.stdout, "rows", originalRows);
			else Reflect.deleteProperty(process.stdout, "rows");
		}
	});

	it("Space toggles a filtered multi-select option without closing the filter", () => {
		const originalRows = Object.getOwnPropertyDescriptor(process.stdout, "rows");
		Object.defineProperty(process.stdout, "rows", { configurable: true, value: 16 });
		try {
			const onSubmit = vi.fn();
			const options = [
				{ label: "Alpha match" },
				{ label: "Bravo match" },
				...Array.from({ length: 18 }, (_, index) => ({ label: `Other ${index}` })),
			];
			const component = new AskDialogComponent([{ id: "q1", question: "Pick many?", options, multi: true }], {
				onSubmit,
				onCancel: vi.fn(),
				onPrompt: vi.fn(),
			});
			component.focused = true;
			component.handleInput("/");
			for (const ch of "match") component.handleInput(ch);
			// Space while the filter is open must toggle the focused row, not
			// become query text. The first filtered match ("Alpha match") is
			// focused; toggling it selects it.
			component.handleInput(SPACE);
			const out = stripVTControlCharacters(component.render(80).join("\n")).replaceAll(CURSOR_MARKER, "");
			expect(out).toContain("/ match");
			expect(out).toContain("Alpha match");
			// Submitting the dialog confirms the toggle took effect.
			component.handleInput(ENTER);
			expect(onSubmit).toHaveBeenCalledTimes(1);
			expect(onSubmit.mock.calls[0][0].results[0].selectedOptions).toEqual(["Alpha match"]);
		} finally {
			if (originalRows) Object.defineProperty(process.stdout, "rows", originalRows);
			else Reflect.deleteProperty(process.stdout, "rows");
		}
	});

	it("expand acts on the focused filtered row and the filter key closes the editor keeping the query", async () => {
		const originalRows = Object.getOwnPropertyDescriptor(process.stdout, "rows");
		Object.defineProperty(process.stdout, "rows", { configurable: true, value: 16 });
		try {
			const onPrompt = vi.fn().mockReturnValue(Promise.resolve("kept note"));
			const onSubmit = vi.fn();
			const options = [
				{
					label: "Alpha match",
					description: Array.from({ length: 5 }, (_, index) => `DESC-LINE-${index + 1}`).join("\n"),
				},
				{ label: "Bravo match" },
				...Array.from({ length: 4 }, (_, index) => ({ label: `Filler ${index}` })),
			];
			const component = new AskDialogComponent([{ id: "q1", question: "Pick?", options }], {
				onSubmit,
				onCancel: vi.fn(),
				onPrompt,
			});
			component.focused = true;
			component.handleInput("/");
			for (const ch of "match") component.handleInput(ch);
			// The collapsed focused description hides lines behind a counted
			// cue, with the filter bar open and the query intact.
			const collapsed = stripVTControlCharacters(component.render(80).join("\n"));
			expect(collapsed).toContain("/ match");
			expect(collapsed).toContain("2 more");
			expect(collapsed).not.toContain("DESC-LINE-4");
			// The filter key closes the editor but keeps the query and the
			// filtered focus: while the editor is open Right moves the query
			// caret, so closing it first is the route to the row action.
			component.handleInput("/");
			const closed = stripVTControlCharacters(component.render(80).join("\n"));
			expect(closed).not.toContain("/ match");
			expect(closed).toContain("Alpha match");
			component.handleInput(RIGHT);
			const expanded = stripVTControlCharacters(component.render(80).join("\n"));
			expect(expanded).toContain("DESC-LINE-4");
			// The advertised note shortcut is reachable without activating
			// (Enter) or discarding (Escape) the filter.
			component.handleInput("n");
			await Promise.resolve();
			await Promise.resolve();
			expect(onPrompt).toHaveBeenCalledTimes(1);
			expect(String(onPrompt.mock.calls[0][0])).toContain("Alpha match");
			component.handleInput(ENTER);
			expect(onSubmit).toHaveBeenCalledTimes(1);
			expect(onSubmit.mock.calls[0][0].results[0].selectedOptions).toEqual(["Alpha match"]);
			expect(onSubmit.mock.calls[0][0].results[0].note).toBe("kept note");
		} finally {
			if (originalRows) Object.defineProperty(process.stdout, "rows", originalRows);
			else Reflect.deleteProperty(process.stdout, "rows");
		}
	});

	it("Tab switches tabs while the filter editor is open", () => {
		const originalRows = Object.getOwnPropertyDescriptor(process.stdout, "rows");
		Object.defineProperty(process.stdout, "rows", { configurable: true, value: 16 });
		try {
			const component = new AskDialogComponent(
				[
					{
						id: "q1",
						question: "First?",
						options: Array.from({ length: 8 }, (_, index) => ({ label: `Opt ${index}` })),
					},
					{ id: "q2", question: "Second?", options: [{ label: "B-target" }] },
				],
				{ onSubmit: vi.fn(), onCancel: vi.fn(), onPrompt: vi.fn() },
			);
			component.focused = true;
			component.handleInput("/");
			const markerLineCount = (frame: readonly string[]): number =>
				frame.filter(line => line.includes(CURSOR_MARKER)).length;
			expect(markerLineCount(component.render(80))).toBe(2);
			component.handleInput(TAB);
			const switched = component.render(80);
			// Switching tabs cleared the filter, so only the focused row keeps
			// its cursor marker and the second question's option is on screen.
			expect(markerLineCount(switched)).toBe(1);
			expect(stripVTControlCharacters(switched.join("\n"))).toContain("B-target");
		} finally {
			if (originalRows) Object.defineProperty(process.stdout, "rows", originalRows);
			else Reflect.deleteProperty(process.stdout, "rows");
		}
	});

	it("offers filtering when wrapped rows overflow the viewport despite the option count fitting", () => {
		const originalRows = Object.getOwnPropertyDescriptor(process.stdout, "rows");
		Object.defineProperty(process.stdout, "rows", { configurable: true, value: 16 });
		try {
			const wrappedLabel = (prefix: string): string => `${prefix} ${"wrapped option label ".repeat(8)}`;
			const options = [
				{ label: wrappedLabel("Alpha xxqq") },
				...Array.from({ length: 4 }, (_, index) => ({ label: wrappedLabel(`Beta ${index}`) })),
			];
			const component = new AskDialogComponent([{ id: "q1", question: "Pick?", options }], {
				onSubmit: vi.fn(),
				onCancel: vi.fn(),
				onPrompt: vi.fn(),
			});
			component.focused = true;
			const out = stripVTControlCharacters(component.render(80).join("\n"));
			// Five options plus Other fit the option-count bound, but their
			// wrapped labels overflow the rendered body, so the filter must
			// still be advertised and openable.
			expect(out).toContain("filter");
			component.handleInput("/");
			for (const ch of "xxqq") component.handleInput(ch);
			const filtered = stripVTControlCharacters(component.render(80).join("\n")).replaceAll(CURSOR_MARKER, "");
			expect(filtered).toContain("/ xxqq");
			expect(filtered).toContain("Alpha xxqq");
			expect(filtered).not.toContain("Beta 0");
		} finally {
			if (originalRows) Object.defineProperty(process.stdout, "rows", originalRows);
			else Reflect.deleteProperty(process.stdout, "rows");
		}
	});

	it("kitty keypad digit jumps focus to the nth visible row", () => {
		const questions: ExtensionAskDialogQuestion[] = [
			{
				id: "q1",
				question: "Pick?",
				options: [{ label: "One" }, { label: "Two" }, { label: "Three" }, { label: "Four" }, { label: "Five" }],
			},
		];
		const component = new AskDialogComponent(questions, {
			onSubmit: vi.fn(),
			onCancel: vi.fn(),
			onPrompt: vi.fn(),
		});
		component.focused = true;
		// Kitty CSI-u numpad "4" → codepoint 57403.
		component.handleInput("\x1b[57403u");
		const lines = component.render(80);
		const marked = lines.findIndex(line => line.includes(CURSOR_MARKER));
		expect(marked).toBeGreaterThanOrEqual(0);
		expect(stripVTControlCharacters(lines[marked] ?? "")).toContain("Four");
	});

	it("Enter after narrowing the filter activates the clamped focused row, not a stale index", async () => {
		const originalRows = Object.getOwnPropertyDescriptor(process.stdout, "rows");
		Object.defineProperty(process.stdout, "rows", { configurable: true, value: 16 });
		try {
			const onPrompt = vi.fn().mockReturnValue(Promise.resolve(undefined));
			const onSubmit = vi.fn();
			const options = [
				{ label: "Alpha match" },
				{ label: "Bravo match" },
				...Array.from({ length: 18 }, (_, index) => ({ label: `Other ${index}` })),
			];
			const component = new AskDialogComponent([{ id: "q1", question: "Pick many?", options, multi: true }], {
				onSubmit,
				onCancel: vi.fn(),
				onPrompt,
			});
			component.focused = true;
			// Move cursor to index 10, well beyond the filtered array length.
			for (let i = 0; i < 10; i++) component.handleInput(DOWN);
			component.handleInput("/");
			for (const ch of "match") component.handleInput(ch);
			// Typing into the filter re-anchors the cursor to the first
			// matching option row ("Alpha match"), so Enter activates it
			// and advances — it must not clamp onto the trailing "Other"
			// row and open the custom-input prompt.
			component.handleInput(ENTER);
			expect(onPrompt).not.toHaveBeenCalled();
			expect(onSubmit).toHaveBeenCalledTimes(1);
			await Promise.resolve();
			await Promise.resolve();
		} finally {
			if (originalRows) Object.defineProperty(process.stdout, "rows", originalRows);
			else Reflect.deleteProperty(process.stdout, "rows");
		}
	});

	it("filter reanchor: focus on a later row narrows to an earlier match and activates it, not Other", () => {
		const originalRows = Object.getOwnPropertyDescriptor(process.stdout, "rows");
		Object.defineProperty(process.stdout, "rows", { configurable: true, value: 16 });
		try {
			const onPrompt = vi.fn();
			const onSubmit = vi.fn();
			const options = [
				{ label: "Alpha zebra" },
				{ label: "Bravo zebra" },
				{ label: "Charlie zebra" },
				{ label: "Delta zebra" },
				{ label: "Echo zebra" },
				...Array.from({ length: 18 }, (_, index) => ({ label: `Filler ${index}` })),
			];
			const component = new AskDialogComponent([{ id: "q1", question: "Pick?", options }], {
				onSubmit,
				onCancel: vi.fn(),
				onPrompt,
			});
			component.focused = true;
			// Move focus to a later row (Delta zebra, index 3).
			for (let i = 0; i < 3; i++) component.handleInput(DOWN);
			// Open the filter and type a query that leaves an earlier
			// matching option ("Alpha zebra") as the first visible row.
			component.handleInput("/");
			for (const ch of "Alpha") component.handleInput(ch);
			// Enter must select the first matching option ("Alpha zebra")
			// and advance — not open the custom-input prompt on "Other".
			component.handleInput(ENTER);
			expect(onPrompt).not.toHaveBeenCalled();
			expect(onSubmit).toHaveBeenCalledTimes(1);
			expect(onSubmit.mock.calls[0][0].results[0].selectedOptions).toEqual(["Alpha zebra"]);
		} finally {
			if (originalRows) Object.defineProperty(process.stdout, "rows", originalRows);
			else Reflect.deleteProperty(process.stdout, "rows");
		}
	});

	it("arrow keys move the filter caret instead of expanding the focused row", () => {
		const originalRows = Object.getOwnPropertyDescriptor(process.stdout, "rows");
		Object.defineProperty(process.stdout, "rows", { configurable: true, value: 16 });
		try {
			const component = new AskDialogComponent(
				[
					{
						id: "q1",
						question: "Pick?",
						options: [
							{
								label: "Alpha match",
								description: Array.from({ length: 5 }, (_, index) => `DESC-LINE-${index + 1}`).join("\n"),
							},
							{ label: "Bravo match" },
							...Array.from({ length: 4 }, (_, index) => ({ label: `Filler ${index}` })),
						],
					},
				],
				{ onSubmit: vi.fn(), onCancel: vi.fn(), onPrompt: vi.fn() },
			);
			component.focused = true;
			component.handleInput("/");
			for (const ch of "match") component.handleInput(ch);
			// With the editor open, the default expand binding (Right) must
			// reach the editor as cursor movement, not expand the focused row.
			component.handleInput(RIGHT);
			const afterRight = stripVTControlCharacters(component.render(80).join("\n"));
			expect(afterRight).toContain("/ match");
			expect(afterRight).not.toContain("DESC-LINE-4");
			// Left then a typed character inserts mid-query, proving the
			// caret moved rather than the key being swallowed.
			component.handleInput(LEFT);
			component.handleInput("X");
			expect(stripVTControlCharacters(component.render(80).join("\n"))).toContain("/ matcX");
		} finally {
			if (originalRows) Object.defineProperty(process.stdout, "rows", originalRows);
			else Reflect.deleteProperty(process.stdout, "rows");
		}
	});

	it("filter reanchor: a no-match query focuses Other, and clearing the query returns focus to the first option", () => {
		const originalRows = Object.getOwnPropertyDescriptor(process.stdout, "rows");
		Object.defineProperty(process.stdout, "rows", { configurable: true, value: 16 });
		try {
			const onPrompt = vi.fn();
			const onSubmit = vi.fn();
			const component = new AskDialogComponent(
				[
					{
						id: "q1",
						question: "Pick?",
						options: [
							{ label: "Alpha one" },
							{ label: "Bravo two" },
							{ label: "Charlie three" },
							...Array.from({ length: 18 }, (_, index) => ({ label: `Filler ${index}` })),
						],
					},
				],
				{ onSubmit, onCancel: vi.fn(), onPrompt },
			);
			component.focused = true;
			component.handleInput("/");
			for (const ch of "zzz") component.handleInput(ch);
			// No option matches, so the sole visible row is Other and it takes
			// focus. Backspacing the query away must hand focus back to the
			// first option — Other is always appended, so preserving it would
			// strand Enter on the custom-answer editor.
			for (let i = 0; i < 3; i++) component.handleInput(BACKSPACE);
			component.handleInput(ENTER);
			expect(onPrompt).not.toHaveBeenCalled();
			expect(onSubmit).toHaveBeenCalledTimes(1);
			expect(onSubmit.mock.calls[0][0].results[0].selectedOptions).toEqual(["Alpha one"]);
		} finally {
			if (originalRows) Object.defineProperty(process.stdout, "rows", originalRows);
			else Reflect.deleteProperty(process.stdout, "rows");
		}
	});

	it("keeps the cancel affordance in the guarded footer at narrow widths", () => {
		const originalRows = Object.getOwnPropertyDescriptor(process.stdout, "rows");
		Object.defineProperty(process.stdout, "rows", { configurable: true, value: 16 });
		try {
			const component = new AskDialogComponent(
				[
					{
						id: "q1",
						question: `${"This is a very long question ".repeat(12)}?`,
						options: [{ label: "Alpha" }],
					},
				],
				{
					onSubmit: vi.fn(),
					onCancel: vi.fn(),
					onPrompt: vi.fn(),
				},
				{
					inputGuard: {
						isBlocked: () => true,
						handleInput: () => {},
						hint: "Finish or clear the draft to continue",
					},
				},
			);
			component.focused = true;
			// 80 columns minus the dialog chrome leaves 76 inner columns; the
			// guard hint plus the expand hint exceeds that, and cancel is the
			// affordance that must survive the truncation.
			const frame = stripVTControlCharacters(component.render(80).join("\n"));
			expect(frame).toContain("cancel");
		} finally {
			if (originalRows) Object.defineProperty(process.stdout, "rows", originalRows);
			else Reflect.deleteProperty(process.stdout, "rows");
		}
	});

	it("reopens the filter editor after `/` closes it with a query whose matches fit the viewport", () => {
		const originalRows = Object.getOwnPropertyDescriptor(process.stdout, "rows");
		Object.defineProperty(process.stdout, "rows", { configurable: true, value: 16 });
		try {
			const options = [
				{ label: "Zebra match one" },
				{ label: "Zebra match two" },
				...Array.from({ length: 20 }, (_, index) => ({ label: `Filler ${index}` })),
			];
			const component = new AskDialogComponent([{ id: "q1", question: "Pick?", options }], {
				onSubmit: vi.fn(),
				onCancel: vi.fn(),
				onPrompt: vi.fn(),
			});
			component.focused = true;
			expect(stripVTControlCharacters(component.render(80).join("\n"))).toContain("filter");
			component.handleInput("/");
			for (const ch of "zebra") component.handleInput(ch);
			const narrowed = stripVTControlCharacters(component.render(80).join("\n"));
			expect(narrowed).toContain("/ zebra");
			// The retained query leaves two matches plus Other, which fits the
			// viewport — the very state where a rendered-height-only flag
			// would stop advertising the filter.
			component.handleInput("/");
			const kept = stripVTControlCharacters(component.render(80).join("\n"));
			expect(kept).not.toContain("/ zebra");
			expect(kept).toContain("3/23");
			expect(kept).toContain("filter");
			// `/` must reopen the editor on the retained query; Escape (which
			// discards it) must not be the only way back.
			component.handleInput("/");
			const reopened = stripVTControlCharacters(component.render(80).join("\n"));
			expect(reopened).toContain("/ zebra");
		} finally {
			if (originalRows) Object.defineProperty(process.stdout, "rows", originalRows);
			else Reflect.deleteProperty(process.stdout, "rows");
		}
	});

	it("renders short options at full width once focus leaves an overflowing description", () => {
		const originalRows = Object.getOwnPropertyDescriptor(process.stdout, "rows");
		Object.defineProperty(process.stdout, "rows", { configurable: true, value: 40 });
		try {
			// Exactly 70 columns: one line at the width-80 list's content
			// budget, two lines once the list renders one column narrower.
			const exactFitLabel = `X${"k".repeat(68)}Z`;
			const options = [
				{
					label: "Described",
					description: Array.from({ length: 4 }, (_, index) => `DESC-LINE-${index + 1}`).join("\n"),
				},
				{ label: exactFitLabel },
				...Array.from({ length: 4 }, (_, index) => ({ label: `Short ${index}` })),
			];
			const component = new AskDialogComponent([{ id: "q1", question: "Pick?", options }], {
				onSubmit: vi.fn(),
				onCancel: vi.fn(),
				onPrompt: vi.fn(),
			});
			component.focused = true;
			const overflowing = stripVTControlCharacters(component.render(80).join("\n"));
			// The focused four-line description overflows the body, so the
			// list renders one column narrower with the tail behind a cue.
			// PREVIEW_LIMITS.COLLAPSED_LINES = 3, so one line is hidden.
			expect(overflowing).toContain("1 more");
			component.handleInput(DOWN);
			const refocused = stripVTControlCharacters(component.render(80).join("\n")).replaceAll(CURSOR_MARKER, "");
			// The list now fits: the exact-fit label must stay whole on one
			// full-width line instead of inheriting the previous focus's
			// narrower overflow layout, and the filter hint must drop with
			// the overflow.
			expect(refocused).toContain(exactFitLabel);
			expect(refocused).not.toContain("filter");
		} finally {
			if (originalRows) Object.defineProperty(process.stdout, "rows", originalRows);
			else Reflect.deleteProperty(process.stdout, "rows");
		}
	});

	it("keeps the panel height frozen when the filter count suffix wraps the question title", () => {
		const originalRows = Object.getOwnPropertyDescriptor(process.stdout, "rows");
		Object.defineProperty(process.stdout, "rows", { configurable: true, value: 24 });
		try {
			// 72 columns: one title line at full width, two once the "  5/5"
			// count suffix reserves its columns.
			const title = `${"t".repeat(70)} x`;
			const options = [
				{ label: "Alpha", description: Array.from({ length: 4 }, (_, index) => `D${index + 1}`).join("\n") },
				{ label: "Bravo" },
				{ label: "Charlie" },
				{ label: "Delta" },
			];
			const component = new AskDialogComponent([{ id: "q1", question: title, options, multi: true }], {
				onSubmit: vi.fn(),
				onCancel: vi.fn(),
				onPrompt: vi.fn(),
			});
			component.focused = true;
			const before = component.render(80);
			// The focused description overflows the min-height body, so `/`
			// opens the filter and the header appends the "  5/5" count.
			component.handleInput("/");
			const after = component.render(80);
			const stripped = stripVTControlCharacters(after.join("\n"));
			expect(stripped).toContain("5/5");
			expect(stripped).toContain("/ ");
			// The suffix wraps the title onto a second header line; the
			// frozen panel must absorb it by yielding a body row, not by
			// growing past the height measured at spawn.
			expect(after.length).toBe(before.length);
		} finally {
			if (originalRows) Object.defineProperty(process.stdout, "rows", originalRows);
			else Reflect.deleteProperty(process.stdout, "rows");
		}
	});

	it("renders a noted long row full-width after the note moves to a short row, with no stale filter cue", async () => {
		const originalRows = Object.getOwnPropertyDescriptor(process.stdout, "rows");
		Object.defineProperty(process.stdout, "rows", { configurable: true, value: 40 });
		try {
			// Exactly 70 columns: one line at the width-80 list's content
			// budget, two lines once the list renders one column narrower.
			const exactFitLabel = `X${"k".repeat(68)}Z`;
			const options = [
				{ label: exactFitLabel },
				{ label: "Short" },
				...Array.from({ length: 4 }, (_, index) => ({ label: `Fill ${index}` })),
			];
			const onPrompt = vi.fn();
			const component = new AskDialogComponent([{ id: "q1", question: "Pick?", options }], {
				onSubmit: vi.fn(),
				onCancel: vi.fn(),
				onPrompt,
			});
			component.focused = true;

			// Add a note to the long exact-fit row (cursor starts on it).
			// The note marker adds a line, causing overflow and a one-column
			// narrower list render.
			onPrompt.mockReturnValueOnce(Promise.resolve("note on long"));
			component.handleInput("n");
			await Promise.resolve();
			await Promise.resolve();
			const noted = stripVTControlCharacters(component.render(80).join("\n")).replaceAll(CURSOR_MARKER, "");
			expect(noted).toContain("✎ note");

			// Move to the short row and add a note there, moving the note
			// away from the long row.
			component.handleInput(DOWN);
			onPrompt.mockReturnValueOnce(Promise.resolve("note on short"));
			component.handleInput("n");
			await Promise.resolve();
			await Promise.resolve();
			const shortNoted = stripVTControlCharacters(component.render(80).join("\n")).replaceAll(CURSOR_MARKER, "");
			expect(shortNoted).toContain("✎ note");

			// Move back to the long row. The note is now on the short row,
			// so the long row must render full-width — the exact-fit label
			// stays whole on one line, no stale one-column-narrow overflow
			// verdict is reused, and no filter cue persists.
			component.handleInput(UP);
			const refocused = stripVTControlCharacters(component.render(80).join("\n")).replaceAll(CURSOR_MARKER, "");
			expect(refocused).toContain(exactFitLabel);
			expect(refocused).not.toContain("filter");
		} finally {
			if (originalRows) Object.defineProperty(process.stdout, "rows", originalRows);
			else Reflect.deleteProperty(process.stdout, "rows");
		}
	});
});
