import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { KeybindingsManager } from "@oh-my-pi/pi-coding-agent/config/keybindings";
import type { ExtensionAskDialogQuestion } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { AskDialogComponent } from "@oh-my-pi/pi-coding-agent/modes/components/ask-dialog";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { setKeybindings } from "@oh-my-pi/pi-tui";

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
			expect(initial).toContain("↓ scroll");

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

			expect(out).toContain("PgUp/PgDn");
			expect(out).toContain("Tab/←/→");
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
			expect(remapped).toContain("Ctrl+U/Ctrl+D");
			expect(remapped).toContain("Ctrl+G cancel");
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
			expect(out).not.toContain("PgUp/PgDn");
			expect(out).toContain("↓ scroll");
			component.handleInput(DOWN);
			for (let page = 0; page < 4; page++) component.handleInput(PAGE_DOWN);
			out = render(component);
			expect(out).toContain("PgUp/PgDn");
			expect(out).toContain("PREVIEW-MIDDLE");
			component.handleInput(DOWN);
			out = render(component);
			expect(out).toContain("Other (type your own)");
			expect(out).not.toContain("PREVIEW-MIDDLE");
			expect(out).not.toContain("PgUp/PgDn");
			component.handleInput(UP);
			out = render(component);
			expect(out).toContain("PREVIEW-FIRST");
			expect(out).toContain("PgUp/PgDn");
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
});
