/**
 * Sequential steps of one task spawn (`steps` on a task item, instead of `task`).
 *
 * The steps go out in at most {@link MAX_STEPS} prompts ({@link renderStepPrompts}): the first is
 * the initial prompt, each later one is sent once the child delivered the previous (a terminal
 * `yield`, or without `yield` its final message), so the child works one stage at a time instead of
 * planning against the whole list. The last prompt's result is the run's result.
 *
 * A run records the prompts it sent as {@link TASK_STEPS_ENTRY} entries, so `omp --restore` goes on
 * with the prompts an interrupted run had left ({@link readStepProgress}).
 *
 * @example
 * renderStepPrompts(["a", "b", "c", "d", "e"], true).length; // 4: steps 1–2, then 3, 4, 5
 */
import { isRecord, prompt } from "@oh-my-pi/pi-utils";
import stepTemplate from "../prompts/system/subagent-step.md" with { type: "text" };
import stepsBriefTemplate from "../prompts/system/subagent-steps-brief.md" with { type: "text" };
import type { FileEntry } from "../session/session-entries";
import type { SessionManager } from "../session/session-manager";

/** Most prompts one stepped spawn sends; more steps share prompts, earlier prompts taking the extra. */
export const MAX_STEPS = 4;

/** Custom entry type of a run's step progress: the prompts on its first record, `sent` on every one. */
export const TASK_STEPS_ENTRY = "task-steps";

/** A stepped run's prompts and how many it has sent; the rest follow one per delivered prompt. */
export interface StepProgress {
	/** Every step prompt ({@link renderStepPrompts}), in order. */
	prompts: readonly string[];
	/** Leading prompts already sent; at least 1, since the first is the initial prompt. */
	sent: number;
}

/**
 * Sizes of the prompts `count` steps go out in: at most {@link MAX_STEPS}, as even as possible,
 * earlier prompts one step larger (5 → 2-1-1-1, 9 → 3-2-2-2).
 */
function promptSizes(count: number): number[] {
	const prompts = Math.min(count, MAX_STEPS);
	const base = Math.floor(count / prompts);
	const larger = count % prompts;
	return Array.from({ length: prompts }, (_, index) => base + (index < larger ? 1 : 0));
}

/** Stands in for step `index`'s text while a template is formatted; `format()` leaves it untouched. */
function textSlot(index: number): string {
	return `\u0000step-${index}\u0000`;
}

/** Insert each step's text verbatim (interior whitespace intact, like the assignment) into its slot. */
function fillTextSlots(rendered: string, steps: readonly string[], first: number): string {
	let filled = rendered;
	for (let index = first; index < first + steps.length; index++) {
		const text = steps[index - first].trim().replace(/\r\n?/g, "\n");
		filled = filled.replace(textSlot(index), () => text);
	}
	return filled;
}

/**
 * The prompts `steps` go out in, at most {@link MAX_STEPS}; `structured` selects whether a prompt
 * ends with a terminal `yield` or the final message.
 */
export function renderStepPrompts(steps: readonly string[], structured: boolean): string[] {
	const prompts: string[] = [];
	let first = 0;
	const sizes = promptSizes(steps.length);
	for (const [index, size] of sizes.entries()) {
		const chunk = steps.slice(first, first + size);
		const rendered = prompt.render(stepTemplate, {
			steps: chunk.map((_, offset) => ({
				number: first + offset + 1,
				total: steps.length,
				text: textSlot(first + offset),
			})),
			multiple: size > 1,
			last: index === sizes.length - 1,
			next: first + size + 1,
			structured,
		});
		prompts.push(fillTextSlots(rendered, chunk, first));
		first += size;
	}
	return prompts;
}

/** Every step as one Markdown brief: the run's `assignment` for labels and display, never sent whole. */
export function renderStepsBrief(steps: readonly string[]): string {
	const rendered = prompt.render(stepsBriefTemplate, { steps: steps.map((_, index) => textSlot(index)) });
	return fillTextSlots(rendered, steps, 0);
}

/** Persists that the first `sent` prompts went out; pass `prompts` on a run's first record only. */
export function recordStepsSent(sessionManager: SessionManager, sent: number, prompts?: readonly string[]): void {
	sessionManager.appendCustomEntry(TASK_STEPS_ENTRY, prompts ? { prompts, sent } : { sent });
}

/** The step progress a transcript recorded, or undefined when its run had no steps. */
export function readStepProgress(entries: readonly FileEntry[]): StepProgress | undefined {
	let prompts: string[] | undefined;
	let sent = 0;
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== TASK_STEPS_ENTRY || !isRecord(entry.data)) continue;
		const data = entry.data;
		if (Array.isArray(data.prompts) && data.prompts.every(text => typeof text === "string")) prompts = data.prompts;
		if (typeof data.sent === "number") sent = data.sent;
	}
	return prompts && sent >= 1 ? { prompts, sent } : undefined;
}
