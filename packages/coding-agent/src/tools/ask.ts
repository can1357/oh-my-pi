import type { AskToolDetails, QuestionResult } from "@oh-my-pi/pi-tui/tools/ask";
/**
 * Ask Tool - Interactive user prompting during execution
 *
 * Use this tool when you need to ask the user questions during execution.
 * This allows you to:
 *   1. Gather user preferences or requirements
 *   2. Clarify ambiguous instructions
 *   3. Get decisions on implementation choices as you work
 *   4. Offer choices to the user about what direction to take
 *
 * Usage notes:
 *   - Users will always be able to select "Other" to provide custom text input
 *   - Use multi: true to allow multiple answers to be selected for a question
 *   - Use recommended: <index> to mark the default option; "(Recommended)" suffix is added automatically
 *   - Questions may time out and auto-select the recommended option (configurable, disabled in plan mode)
 */

import { type as arkType } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import type { ToolExample } from "@oh-my-pi/pi-ai";
import { Ellipsis, replaceTabs, TERMINAL, truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import { prompt, untilAborted } from "@oh-my-pi/pi-utils";

import type { ExtensionUISelectItem } from "../extensibility/extensions";
import { theme } from "@oh-my-pi/pi-tui/theme";
import askDescription from "../prompts/tools/ask.md" with { type: "text" };
import { vocalizer } from "../tts/vocalizer";

import type { ToolSession } from ".";
import {
	disambiguateDisplayLabels,
	sanitizeCarriageReturns,
	TRUNCATE_LENGTHS,
} from "@oh-my-pi/pi-tui/render/render-utils";
import { ToolAbortError } from "./tool-errors";

import { cfgAskNotify, cfgAskTimeout } from "../modes/settings";
import { cfgSpeechEnabled } from "../tts/settings";

// =============================================================================
// Types
// =============================================================================

export const OTHER_OPTION = "Other (type your own)";
const CHAT_ABOUT_THIS_OPTION = "Chat about this";
const NEXT_OPTION = "Next →";
const RESERVED_OPTION_LABELS: Record<string, true> = {
	[OTHER_OPTION]: true,
	[CHAT_ABOUT_THIS_OPTION]: true,
	[NEXT_OPTION]: true,
};

const OptionItem = arkType({
	label: arkType("string"),
	"description?": arkType("string"),
	"preview?": arkType("string").describe("rich preview"),
});

const QuestionItem = arkType({
	id: arkType("string"),
	question: arkType("string"),
	"header?": arkType("string").describe("display chip"),
	options: OptionItem.array(),
	"multi?": arkType("boolean"),
	"recommended?": arkType("number").describe("0-based default index"),
}).narrow((question, ctx) => {
	const reserved = question.options.find(option => RESERVED_OPTION_LABELS[option.label] === true);
	return (
		reserved === undefined ||
		ctx.mustBe(`defined with option labels that do not collide with reserved runtime labels: ${reserved.label}`)
	);
});

const askSchema = arkType({
	questions: QuestionItem.array().atLeastLength(1),
});

export type AskToolInput = typeof askSchema.infer;

/**
 * Recover a validated `questions` payload from a persisted `ask` toolCall's
 * `arguments`. Used by `/tree` re-answer (issue #5642): selecting a past
 * `ask` toolResult re-opens the picker with the *original* questions, so the
 * new answer branches as a sibling instead of mutating the old one. Runs the
 * same schema the live tool call validated against — legacy/corrupted
 * persisted args fail closed (`undefined`) rather than feeding malformed
 * data back into the picker.
 */
export function recoverAskQuestions(toolCallArguments: unknown): AskToolInput["questions"] | undefined {
	const parsed = askSchema(toolCallArguments);
	if (parsed instanceof arkType.errors) return undefined;
	return parsed.questions;
}

interface AskOption {
	label: string;
	description?: string;
}

function getAskOptionLabel(option: AskOption): string {
	return option.label;
}

function getSelectOptionLabel(option: ExtensionUISelectItem): string {
	return typeof option === "string" ? option : option.label;
}

function toSelectOption(option: AskOption, label = option.label): ExtensionUISelectItem {
	return option.description ? { label, description: option.description } : label;
}

// =============================================================================
// Constants
// =============================================================================

const RECOMMENDED_SUFFIX = " (Recommended)";
// Window after the timeout deadline within which an `undefined` selection is
// attributed to a UI-enforced timeout (for surfaces that close the dialog at
// the deadline but never invoke `onTimeout`). Cancels beyond it are user Esc.
const TIMEOUT_DETECTION_TOLERANCE_MS = 1_000;

function getDoneOptionLabel(): string {
	return `${theme.status.success} Done selecting`;
}

/** Add "(Recommended)" suffix to the option at the given index if not already present */
function addRecommendedSuffix(options: AskOption[], recommendedIndex?: number): ExtensionUISelectItem[] {
	if (recommendedIndex === undefined || recommendedIndex < 0 || recommendedIndex >= options.length) {
		return options.map(option => toSelectOption(option));
	}
	return options.map((option, i) => {
		const label =
			i === recommendedIndex && !option.label.endsWith(RECOMMENDED_SUFFIX)
				? option.label + RECOMMENDED_SUFFIX
				: option.label;
		return toSelectOption(option, label);
	});
}

function getAutoSelectionOnTimeout(options: AskOption[], recommended?: number): string[] {
	if (options.length === 0) return [];
	if (typeof recommended === "number" && recommended >= 0 && recommended < options.length) {
		return [options[recommended]!.label];
	}
	return [options[0]!.label];
}

/** Strip "(Recommended)" suffix from a label */
function stripRecommendedSuffix(label: string): string {
	return label.endsWith(RECOMMENDED_SUFFIX) ? label.slice(0, -RECOMMENDED_SUFFIX.length) : label;
}

interface CustomInputContext {
	selectionMarker: "radio" | "checkbox";
	checkedIndices?: readonly number[];
	markableCount: number;
}

/** Hard caps for the editor title rendered while the user types an `Other`
 *  custom answer. {@link HookEditorComponent} renders the title via a single
 *  `Text` child stacked above the prompt editor with no `maxVisible` windowing,
 *  so the title MUST fit a normal terminal:
 *  - {@link MAX_CUSTOM_INPUT_OPTION_ROWS}: at most this many option-row entries
 *    survive {@link pickCustomInputOptionWindow}, regardless of total options.
 *  - {@link MAX_CUSTOM_INPUT_TITLE_ROWS}: hard cap on rendered title rows after
 *    every line is pre-truncated to one row at the live terminal width. Sized
 *    so a 24-row terminal still has space for the input row, hint, and chrome.
 */
const MAX_CUSTOM_INPUT_OPTION_ROWS = 8;
const MAX_CUSTOM_INPUT_TITLE_ROWS = 16;
const MIN_CUSTOM_INPUT_CONTENT_WIDTH = 20;
/** Subtracted from the terminal width to leave room for `Text` padding and
 *  surrounding {@link OverlayPanel} chrome. */
const CUSTOM_INPUT_CHROME_COLUMNS = 8;
const CUSTOM_INPUT_DESCRIPTION_INDENT = "    ";

function customInputContentWidth(): number {
	const cols = process.stdout.columns ?? 80;
	return Math.max(MIN_CUSTOM_INPUT_CONTENT_WIDTH, cols - CUSTOM_INPUT_CHROME_COLUMNS);
}

function clampLineToWidth(line: string, width: number): string {
	if (visibleWidth(line) <= width) return line;
	return truncateToWidth(line, width, Ellipsis.Unicode);
}

function flattenDescription(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function getSelectOptionDescription(option: ExtensionUISelectItem): string | undefined {
	return typeof option === "string" ? undefined : option.description;
}

interface CustomInputOptionGap {
	total: number;
	checked: number;
}

interface CustomInputOptionWindow {
	indices: number[];
	gapBefore: Map<number, CustomInputOptionGap>;
}

/** Window the option list so the title stays bounded. Required rows are the
 *  selected `Other` row and the first option as an anchor; checked rows fill
 *  the remaining budget before unselected leading rows. Hidden checked options
 *  are summarized in gap markers so the rendered option-row count still never
 *  exceeds {@link MAX_CUSTOM_INPUT_OPTION_ROWS}. */
function pickCustomInputOptionWindow(
	total: number,
	selectedIndex: number,
	checked: ReadonlySet<number>,
): CustomInputOptionWindow {
	if (total === 0) return { indices: [], gapBefore: new Map() };
	if (total <= MAX_CUSTOM_INPUT_OPTION_ROWS) {
		return {
			indices: Array.from({ length: total }, (_, i) => i),
			gapBefore: new Map(),
		};
	}
	const keep = new Set<number>();
	const addIfRoom = (index: number) => {
		if (index >= 0 && index < total && keep.size < MAX_CUSTOM_INPUT_OPTION_ROWS) {
			keep.add(index);
		}
	};
	addIfRoom(selectedIndex);
	addIfRoom(0);
	for (const i of [...checked].sort((a, b) => a - b)) {
		addIfRoom(i);
	}
	for (let i = 0; i < total && keep.size < MAX_CUSTOM_INPUT_OPTION_ROWS; i++) {
		addIfRoom(i);
	}
	const indices = [...keep].sort((a, b) => a - b);
	const gapBefore = new Map<number, CustomInputOptionGap>();
	const countCheckedBetween = (startInclusive: number, endExclusive: number): number => {
		let count = 0;
		for (const i of checked) {
			if (i >= startInclusive && i < endExclusive) count++;
		}
		return count;
	};
	let prev = -1;
	for (const idx of indices) {
		if (idx > prev + 1) {
			gapBefore.set(idx, {
				total: idx - prev - 1,
				checked: countCheckedBetween(prev + 1, idx),
			});
		}
		prev = idx;
	}
	if (prev < total - 1) {
		gapBefore.set(total, {
			total: total - 1 - prev,
			checked: countCheckedBetween(prev + 1, total),
		});
	}
	return { indices, gapBefore };
}

interface CustomInputRow {
	text: string;
	/** Lower priority drops first when over budget; negative values are pinned.
	 *  Gap markers are budgeted rows too so sparse checked selections cannot
	 *  push the editor input off-screen. */
	priority: number;
}

function buildCustomInputRows(
	question: string,
	options: ExtensionUISelectItem[],
	context: CustomInputContext,
	contentWidth: number,
): CustomInputRow[] {
	const selectedIndex = options.findIndex(option => getSelectOptionLabel(option) === OTHER_OPTION);
	const checked = new Set(context.checkedIndices ?? []);
	const window = pickCustomInputOptionWindow(options.length, selectedIndex, checked);
	const rows: CustomInputRow[] = [];
	rows.push({ text: clampLineToWidth(question, contentWidth), priority: -1 });
	rows.push({ text: "", priority: -1 });

	const emitGap = (gap: CustomInputOptionGap) => {
		const checkedSuffix = gap.checked > 0 ? `, ${gap.checked} checked` : "";
		rows.push({
			text: clampLineToWidth(
				`    … ${gap.total} more option${gap.total === 1 ? "" : "s"}${checkedSuffix} …`,
				contentWidth,
			),
			priority: 2,
		});
	};

	for (const index of window.indices) {
		const gap = window.gapBefore.get(index);
		if (gap !== undefined) emitGap(gap);
		const option = options[index]!;
		const label = getSelectOptionLabel(option);
		const isSelected = index === selectedIndex;
		const isMarkable = index < context.markableCount;
		const prefix =
			context.selectionMarker === "radio" && (isMarkable || isSelected)
				? `${isSelected ? theme.radio.selected : theme.radio.unselected} `
				: context.selectionMarker === "checkbox" && isMarkable
					? `${checked.has(index) ? theme.checkbox.checked : theme.checkbox.unchecked} `
					: isSelected
						? `${theme.nav.cursor} `
						: "  ";
		rows.push({ text: clampLineToWidth(prefix + label, contentWidth), priority: -1 });
		const description = getSelectOptionDescription(option);
		if (description) {
			const flat = flattenDescription(description);
			if (flat) {
				rows.push({
					text: clampLineToWidth(`${CUSTOM_INPUT_DESCRIPTION_INDENT}${flat}`, contentWidth),
					// Selected (Other) carries no description; favor checked rows
					// when budget pressure forces description rows to be dropped.
					priority: isSelected ? 2 : checked.has(index) ? 1 : 0,
				});
			}
		}
	}

	const trailingGap = window.gapBefore.get(options.length);
	if (trailingGap !== undefined) emitGap(trailingGap);
	rows.push({ text: "", priority: -1 });
	rows.push({ text: "Enter your response:", priority: -1 });
	return rows;
}

function applyCustomInputRowBudget(rows: CustomInputRow[], budget: number): CustomInputRow[] {
	if (rows.length <= budget) return rows;
	// Drop droppable rows lowest priority first; on ties, drop later rows first
	// so the user still sees the earliest options' descriptions.
	const droppable = rows
		.map((row, index) => ({ row, index }))
		.filter(entry => entry.row.priority >= 0)
		.sort((a, b) => a.row.priority - b.row.priority || b.index - a.index);
	const removed = new Set<number>();
	for (const { index } of droppable) {
		if (rows.length - removed.size <= budget) break;
		removed.add(index);
	}
	return rows.filter((_, i) => !removed.has(i));
}

function formatCustomInputTitle(
	question: string,
	options: ExtensionUISelectItem[],
	context: CustomInputContext,
): string {
	const contentWidth = customInputContentWidth();
	const rows = buildCustomInputRows(question, options, context, contentWidth);
	return applyCustomInputRowBudget(rows, MAX_CUSTOM_INPUT_TITLE_ROWS)
		.map(row => row.text)
		.join("\n");
}

// =============================================================================
// Question Selection Logic
// =============================================================================

interface SelectionResult {
	selectedOptions: string[];
	customInput?: string;
	note?: string;
	timedOut: boolean;
	navigation?: "back" | "forward";
	cancelled?: boolean;
}

interface NavigationControls {
	allowBack: boolean;
	allowForward: boolean;
	progressText?: string;
}
interface AskSingleQuestionOptions {
	recommended?: number;
	timeout?: number;
	signal?: AbortSignal;
	initialSelection?: Pick<SelectionResult, "selectedOptions" | "customInput" | "note">;
	navigation?: NavigationControls;
}

interface UIContext {
	timeoutStartsOnPresentation?: boolean;
	select(
		prompt: string,
		options: ExtensionUISelectItem[],
		options_?: {
			initialIndex?: number;
			timeout?: number;
			signal?: AbortSignal;
			outline?: boolean;
			onTimeout?: () => void;
			onTimeoutStart?: () => void;
			onTimeoutReset?: () => void;
			onLeft?: () => void;
			onRight?: () => void;
			helpText?: string;
			selectionMarker?: "radio" | "checkbox";
			checkedIndices?: readonly number[];
			markableCount?: number;
		},
	): Promise<string | undefined>;
	editor(
		title: string,
		prefill?: string,
		dialogOptions?: { signal?: AbortSignal },
		editorOptions?: { promptStyle?: boolean },
	): Promise<string | undefined>;
}

async function askSingleQuestion(
	ui: UIContext,
	question: string,
	questionOptions: AskOption[],
	multi: boolean,
	options: AskSingleQuestionOptions = {},
): Promise<SelectionResult> {
	const { recommended, timeout, signal, initialSelection, navigation } = options;
	const doneLabel = getDoneOptionLabel();
	let selectedOptions = [...(initialSelection?.selectedOptions ?? [])];
	let customInput = initialSelection?.customInput;
	const note = initialSelection?.note;
	let timedOut = false;

	const selectOption = async (
		prompt: string,
		optionsToShow: ExtensionUISelectItem[],
		initialIndex?: number,
		marker?: { selectionMarker: "radio" | "checkbox"; checkedIndices?: readonly number[]; markableCount: number },
	): Promise<{ choice: string | undefined; timedOut: boolean; navigation?: "back" | "forward" }> => {
		let timeoutTriggered = false;
		const onTimeout = () => {
			timeoutTriggered = true;
		};
		let navigationAction: "back" | "forward" | undefined;
		const helpText = navigation
			? "up/down navigate  enter select  ←/→ question  esc cancel"
			: "up/down navigate  enter select  esc cancel";
		const timeoutMs = typeof timeout === "number" && timeout > 0 ? timeout : undefined;
		const timeoutController = timeoutMs === undefined ? undefined : new AbortController();
		const dialogSignal =
			signal && timeoutController
				? AbortSignal.any([signal, timeoutController.signal])
				: (timeoutController?.signal ?? signal);
		let timeoutId: NodeJS.Timeout | undefined;
		let timeoutStartedMs = Date.now();
		const armFallbackTimeout = (durationMs: number) => {
			clearTimeout(timeoutId);
			timeoutStartedMs = Date.now();
			timeoutId = setTimeout(() => {
				timeoutTriggered = true;
				timeoutController?.abort();
			}, durationMs);
		};
		const dialogOptions = {
			initialIndex,
			timeout,
			signal: dialogSignal,
			outline: true,
			onTimeout,
			onTimeoutStart: timeoutMs === undefined ? undefined : () => armFallbackTimeout(timeoutMs),
			onTimeoutReset: timeoutMs === undefined ? undefined : () => armFallbackTimeout(timeoutMs),
			helpText,
			selectionMarker: marker?.selectionMarker,
			checkedIndices: marker?.checkedIndices,
			markableCount: marker?.markableCount,
			onLeft: navigation?.allowBack
				? () => {
						navigationAction = "back";
					}
				: undefined,
			onRight: navigation?.allowForward
				? () => {
						navigationAction = "forward";
					}
				: undefined,
		};
		try {
			const runSelect = () => {
				const selection = ui.select(prompt, optionsToShow, dialogOptions);
				if (timeoutMs !== undefined && !ui.timeoutStartsOnPresentation) {
					armFallbackTimeout(timeoutMs);
				}
				return selection;
			};
			const choice = dialogSignal ? await untilAborted(dialogSignal, runSelect) : await runSelect();
			if (!timeoutTriggered && choice === undefined && typeof timeout === "number") {
				// Fallback for UI surfaces that enforce `timeout` without invoking
				// `onTimeout`: their auto-cancel resolves right at the deadline. A
				// cancel arriving well past the deadline is a deliberate user Esc on
				// a surface that kept the dialog open — keep treating it as a cancel.
				const elapsed = Date.now() - timeoutStartedMs;
				timeoutTriggered = elapsed >= timeout && elapsed <= timeout + TIMEOUT_DETECTION_TOLERANCE_MS;
			}
			return { choice, timedOut: timeoutTriggered, navigation: navigationAction };
		} catch (error) {
			if (timeoutTriggered && error instanceof Error && error.name === "AbortError") {
				return { choice: undefined, timedOut: true, navigation: navigationAction };
			}
			throw error;
		} finally {
			clearTimeout(timeoutId);
		}
	};

	const promptForCustomInput = async (
		title: string,
		optionsToShow: ExtensionUISelectItem[],
		context: CustomInputContext,
	): Promise<{ input: string | undefined }> => {
		const dialogOptions = signal ? { signal } : undefined;
		const editorTitle = formatCustomInputTitle(title, optionsToShow, context);
		const showCustomInput = () => ui.editor(editorTitle, undefined, dialogOptions, { promptStyle: true });
		const input = signal ? await untilAborted(signal, showCustomInput) : await showCustomInput();
		return { input };
	};

	const promptWithProgress = navigation?.progressText ? `${question} (${navigation.progressText})` : question;
	if (multi) {
		const selected = new Set<string>(selectedOptions);
		let cursorIndex = Math.min(Math.max(recommended ?? 0, 0), Math.max(questionOptions.length - 1, 0));
		const firstSelected = selectedOptions[0];
		if (firstSelected) {
			const selectedIndex = questionOptions.findIndex(option => option.label === firstSelected);
			if (selectedIndex >= 0) cursorIndex = selectedIndex;
		}
		while (true) {
			const opts: ExtensionUISelectItem[] = questionOptions.map(opt => toSelectOption(opt));

			if (!navigation?.allowForward && selected.size > 0) {
				opts.push(doneLabel);
			}
			opts.push(OTHER_OPTION);

			const checkedIndices: number[] = [];
			for (let i = 0; i < questionOptions.length; i++) {
				if (selected.has(questionOptions[i]!.label)) checkedIndices.push(i);
			}
			const prefix = selected.size > 0 ? `(${selected.size} selected) ` : "";
			const {
				choice,
				timedOut: selectTimedOut,
				navigation: arrowNavigation,
			} = await selectOption(`${prefix}${promptWithProgress}`, opts, cursorIndex, {
				selectionMarker: "checkbox",
				checkedIndices,
				markableCount: questionOptions.length,
			});

			if (arrowNavigation) {
				return { selectedOptions: Array.from(selected), customInput, note, timedOut, navigation: arrowNavigation };
			}
			if (choice === undefined) {
				if (selectTimedOut) {
					timedOut = true;
					break;
				}
				return { selectedOptions: Array.from(selected), customInput, note, timedOut, cancelled: true };
			}
			if (choice === doneLabel) break;

			if (choice === OTHER_OPTION) {
				if (selectTimedOut) {
					timedOut = true;
					break;
				}
				const customResult = await promptForCustomInput(`${prefix}${promptWithProgress}`, opts, {
					selectionMarker: "checkbox",
					checkedIndices,
					markableCount: questionOptions.length,
				});
				if (customResult.input === undefined) {
					continue;
				}
				customInput = customResult.input;
				break;
			}

			const selectedIdx = opts.findIndex(opt => getSelectOptionLabel(opt) === choice);
			if (selectedIdx >= 0) {
				cursorIndex = selectedIdx;
			}

			if (selected.has(choice)) {
				selected.delete(choice);
			} else {
				selected.add(choice);
			}

			if (selectTimedOut) {
				timedOut = true;
				break;
			}
		}
		selectedOptions = Array.from(selected);
	} else {
		while (true) {
			const baseDisplay = addRecommendedSuffix(questionOptions, recommended);
			// Badging can collide rows (recommended `Retry now` vs a literal
			// `Retry now (Recommended)`); disambiguate display copies like
			// the rich dialog and map the choice back by identity below.
			const displayLabels = disambiguateDisplayLabels(baseDisplay.map(getSelectOptionLabel), [OTHER_OPTION]);
			const displayOptions: ExtensionUISelectItem[] = baseDisplay.map((option, index) =>
				typeof option === "string" ? displayLabels[index]! : { ...option, label: displayLabels[index]! },
			);
			const optionsWithNavigation: ExtensionUISelectItem[] = [...displayOptions, OTHER_OPTION];

			let initialIndex = recommended;
			const previouslySelected = selectedOptions[0];
			if (previouslySelected) {
				const selectedIndex = questionOptions.findIndex(option => option.label === previouslySelected);
				if (selectedIndex >= 0) initialIndex = selectedIndex;
			} else if (customInput !== undefined) {
				initialIndex = displayOptions.length;
			}
			if (initialIndex !== undefined) {
				const maxIndex = Math.max(optionsWithNavigation.length - 1, 0);
				initialIndex = Math.max(0, Math.min(initialIndex, maxIndex));
			}

			const {
				choice,
				timedOut: selectTimedOut,
				navigation: arrowNavigation,
			} = await selectOption(promptWithProgress, optionsWithNavigation, initialIndex, {
				selectionMarker: "radio",
				markableCount: displayOptions.length,
			});
			timedOut = selectTimedOut;

			if (arrowNavigation) {
				return { selectedOptions, customInput, note, timedOut, navigation: arrowNavigation };
			}
			if (choice === undefined) {
				if (!timedOut) {
					return { selectedOptions, customInput, note, timedOut, cancelled: true };
				}
				break;
			}
			if (choice === OTHER_OPTION) {
				if (selectTimedOut) {
					break;
				}
				const customResult = await promptForCustomInput(promptWithProgress, optionsWithNavigation, {
					selectionMarker: "radio",
					markableCount: displayOptions.length,
				});
				if (customResult.input === undefined) {
					continue;
				}
				customInput = customResult.input;
				selectedOptions = [];
				break;
			}
			// Map the displayed choice back to the offered option by identity:
			// the label itself may end with the recommendation suffix
			// (intrinsic or via `\r` normalization), so stripping would
			// corrupt it. First display match wins on identical rows.
			const pickedIndex = displayOptions.findIndex(option => getSelectOptionLabel(option) === choice);
			selectedOptions = [pickedIndex >= 0 ? questionOptions[pickedIndex]!.label : stripRecommendedSuffix(choice)];
			customInput = undefined;
			break;
		}
		if (timedOut && selectedOptions.length === 0 && customInput === undefined) {
			selectedOptions = getAutoSelectionOnTimeout(questionOptions, recommended);
		}
		if (navigation?.allowForward) {
			return { selectedOptions, customInput, note, timedOut, navigation: "forward" };
		}
	}

	if (timedOut && selectedOptions.length === 0 && customInput === undefined) {
		selectedOptions = getAutoSelectionOnTimeout(questionOptions, recommended);
	}

	return { selectedOptions, customInput, note, timedOut };
}

function formatQuestionResult(result: QuestionResult): string {
	const noteSuffix = result.note ? ` (note: ${result.note})` : "";
	if (result.customInput !== undefined) {
		return `${result.id}: "${result.customInput}"${noteSuffix}`;
	}
	if (result.selectedOptions.length > 0) {
		const suffix = `${result.timedOut ? " (auto-selected after timeout)" : ""}${noteSuffix}`;
		return result.multi
			? `${result.id}: [${result.selectedOptions.join(", ")}]${suffix}`
			: `${result.id}: ${result.selectedOptions[0]}${suffix}`;
	}
	return result.multi ? `${result.id}: []${noteSuffix}` : `${result.id}: (cancelled)${noteSuffix}`;
}

function formatSingleQuestionResponse(result: {
	selectedOptions: string[];
	customInput?: string;
	note?: string;
	timedOut?: boolean;
	multi: boolean;
}): string {
	const responseParts: string[] = [];
	if (result.selectedOptions.length > 0) {
		const selectedText = result.multi
			? `User selected: ${result.selectedOptions.join(", ")}`
			: `User selected: ${result.selectedOptions[0]}`;
		responseParts.push(result.timedOut ? `${selectedText} (auto-selected after timeout)` : selectedText);
	}
	if (result.customInput !== undefined) {
		responseParts.push(
			result.customInput.includes("\n")
				? `User provided custom input:\n${result.customInput
						.split("\n")
						.map(line => `  ${line}`)
						.join("\n")}`
				: `User provided custom input: ${result.customInput}`,
		);
	}
	if (result.note) {
		responseParts.push(
			result.note.includes("\n")
				? `User added note:\n${result.note
						.split("\n")
						.map(line => `  ${line}`)
						.join("\n")}`
				: `User added note: ${result.note}`,
		);
	}
	if (responseParts.length > 0) return responseParts.join("\n");
	return result.multi ? "User did not select any options" : "User cancelled the selection";
}

// =============================================================================
// Tool Class
// =============================================================================

type AskParams = AskToolInput;

/**
 * Ask tool for interactive user prompting during execution.
 *
 * Allows gathering user preferences, clarifying instructions, and getting decisions
 * on implementation choices as the agent works.
 */
export class AskTool implements AgentTool<typeof askSchema, AskToolDetails> {
	readonly name = "ask";
	readonly approval = "read" as const;
	readonly label = "Ask";
	readonly summary = "Ask the user a clarifying question";
	readonly description: string;
	readonly parameters = askSchema;
	readonly strict = true;

	readonly examples: readonly ToolExample<typeof askSchema.infer>[] = [
		{
			caption: "Choice",
			call: {
				questions: [
					{
						id: "storage",
						question: "Database?",
						options: [{ label: "SQLite" }, { label: "Postgres" }],
						recommended: 0,
					},
				],
			},
		},
	];
	// Run alone in its tool batch. The interactive selector/editor is a single
	// shared UI surface (`ExtensionUiController.showHookSelector` has no queue and
	// overwrites `ctx.hookSelector` on each call), so two concurrent `ask` calls
	// would clobber each other: the second steals focus and orphans the first,
	// whose promise then hangs until the user aborts the whole turn.
	readonly concurrency = "exclusive";
	readonly loadMode = "discoverable";

	constructor(private readonly session: ToolSession) {
		this.description = prompt.render(askDescription);
	}

	static createIf(session: ToolSession): AskTool | null {
		return (session.canPromptUser ?? session.hasUI) ? new AskTool(session) : null;
	}

	/** Send terminal notification when ask tool is waiting for input */
	#sendAskNotification(): void {
		if (!this.session.hasUI) return;
		const method = cfgAskNotify.get(this.session.settings);
		if (method === "off") return;
		TERMINAL.sendNotification({
			title: "omp",
			body: "Waiting for input",
			type: "ask",
			urgency: "normal",
			actions: "focus",
		});
	}

	async execute(
		_toolCallId: string,
		params: AskParams,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<AskToolDetails>,
		context?: AgentToolContext,
	): Promise<AgentToolResult<AskToolDetails>> {
		// Headless fallback
		if (!context?.hasUI || !context.ui) {
			context?.abort();
			throw new ToolAbortError("Ask tool requires interactive mode");
		}
		// Models occasionally inject `\r` runs into string values (observed with
		// GLM via OpenRouter); sanitize before the dialog renders or the answer
		// echoes back into session history.
		params = sanitizeAskParams(params);
		// Sanitizing `\r` runs can collapse a crafted label into a reserved
		// runtime label (`Other\r(type your own)` → `Other (type your own)`),
		// which would hijack the custom-input branch and duplicate the rich
		// dialog row — fail closed like schema validation does.
		const reservedCollision = params.questions
			.flatMap(question => question.options)
			.find(option => RESERVED_OPTION_LABELS[option.label] === true);
		if (reservedCollision !== undefined) {
			return {
				content: [
					{
						type: "text" as const,
						text: `Error: option labels must not collide with reserved runtime labels: ${formatErrorValue(reservedCollision.label)}`,
					},
				],
				details: {},
			};
		}
		// The degraded multi-select completion row is theme-labeled and only
		// appended after an answer exists, but the choice handler matches it
		// unconditionally — a sanitized model label would exit instead of
		// selecting. Fail closed like the other sentinels (multi-select only;
		// single-select has no Done row).
		const doneActionLabel = getDoneOptionLabel();
		const doneCollision = params.questions
			.filter(question => question.multi === true)
			.flatMap(question => question.options)
			.find(option => option.label === doneActionLabel);
		if (doneCollision !== undefined) {
			return {
				content: [
					{
						type: "text" as const,
						text: `Error: option labels must not collide with reserved runtime labels: ${formatErrorValue(doneCollision.label)}`,
					},
				],
				details: {},
			};
		}
		// Sanitizing `\r` runs can also merge distinct labels (`Retry\rnow` and
		// `Retry now` become one); dialog selection is label-keyed, so one row
		// would check both — fail closed like schema validation does. The same
		// holds for question ids (`deploy\rmode`/`deploy mode`), which the
		// model uses to correlate multi-question answers.
		const seenIds = new Set<string>();
		for (const question of params.questions) {
			if (seenIds.has(question.id)) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Error: question ids must be unique: ${formatErrorValue(question.id)}`,
						},
					],
					details: {},
				};
			}
			seenIds.add(question.id);
			const seenLabels = new Set<string>();
			for (const option of question.options) {
				if (seenLabels.has(option.label)) {
					return {
						content: [
							{
								type: "text" as const,
								text: `Error: option labels must be unique within a question: ${formatErrorValue(option.label)}`,
							},
						],
						details: {},
					};
				}
				seenLabels.add(option.label);
			}
		}

		const extensionUi = context.ui;
		const ui: UIContext = {
			timeoutStartsOnPresentation: extensionUi.timeoutStartsOnPresentation,
			select: (prompt, options, dialogOptions) => extensionUi.select(prompt, options, dialogOptions),
			editor: (title, prefill, dialogOptions, editorOptions) =>
				extensionUi.editor(title, prefill, dialogOptions, editorOptions),
		};

		// Determine timeout based on settings and plan mode
		const planModeEnabled = this.session.getPlanModeState?.()?.enabled ?? false;
		// `ask.timeout` is in seconds (0 = disabled); convert to ms
		const timeoutSeconds = cfgAskTimeout.get(this.session.settings);
		const settingsTimeout = timeoutSeconds === 0 ? null : timeoutSeconds * 1000;
		const timeout = planModeEnabled ? null : settingsTimeout;

		// Send notification if waiting and not suppressed
		this.#sendAskNotification();

		if (params.questions.length === 0) {
			return {
				content: [{ type: "text" as const, text: "Error: questions must not be empty" }],
				details: {},
			};
		}

		// Speak the question(s) aloud before surfacing them. Ask vocalizes in every
		// mode — it's the assistant addressing the user — gated only by speech.enabled
		// (the vocalizer re-checks the setting and no-ops when disabled).
		if (cfgSpeechEnabled.get(this.session.settings)) {
			vocalizer.speak(params.questions.map(q => q.question).join("\n"));
		}

		const richAskDialog = extensionUi.askDialog;
		if (richAskDialog) {
			try {
				const showRichDialog = () =>
					richAskDialog(
						params.questions.map(q => ({
							id: q.id,
							question: q.question,
							...(q.header?.trim() ? { header: q.header } : {}),
							options: q.options.map(option => ({
								label: option.label,
								...(option.description?.trim() ? { description: option.description.trim() } : {}),
								...(option.preview?.trim() ? { preview: option.preview } : {}),
							})),
							...(q.multi !== undefined ? { multi: q.multi } : {}),
							...(q.recommended !== undefined ? { recommended: q.recommended } : {}),
						})),
						{ timeout: timeout ?? undefined, signal },
					);
				const richResult = signal ? await untilAborted(signal, showRichDialog) : await showRichDialog();
				if (!richResult) {
					context.abort();
					throw new ToolAbortError("Ask tool was cancelled by the user");
				}
				if (richResult.kind === "chat") {
					const questionText = params.questions.map(q => q.question).join("\n");
					return {
						content: [
							{
								type: "text" as const,
								text: `User chose to chat about this instead of answering.\n\nQuestions asked:\n${questionText}`,
							},
						],
						details: { chatRedirect: true, questions: params.questions.map(q => q.question) },
					};
				}
				if (richResult.results.length !== params.questions.length) {
					throw new Error("Ask dialog returned a result count that does not match the requested questions");
				}
				const results: QuestionResult[] = [];
				for (let index = 0; index < params.questions.length; index++) {
					const question = params.questions[index];
					const result = richResult.results[index];
					if (!question || !result || result.id !== question.id) {
						throw new Error("Ask dialog returned results that do not match the requested question order");
					}
					results.push({
						id: question.id,
						question: question.question,
						options: question.options.map(option => option.label),
						multi: question.multi ?? false,
						selectedOptions: result.selectedOptions,
						customInput: result.customInput,
						note: result.note,
						timedOut: result.timedOut,
					});
				}
				if (params.questions.length === 1) {
					const result = results[0];
					// An empty multi-select submission is a valid "select none"
					// answer (#8265 review); only a truly empty single-select
					// result counts as cancellation.
					if (
						!result ||
						(!result.timedOut &&
							!result.multi &&
							result.selectedOptions.length === 0 &&
							result.customInput === undefined)
					) {
						context.abort();
						throw new ToolAbortError("Ask tool was cancelled by the user");
					}
					const details: AskToolDetails = {
						question: result.question,
						options: result.options,
						multi: result.multi,
						selectedOptions: result.selectedOptions,
						customInput: result.customInput,
						note: result.note,
						timedOut: result.timedOut,
					};
					const responseText = formatSingleQuestionResponse(result);
					return { content: [{ type: "text" as const, text: responseText }], details };
				}
				const details: AskToolDetails = { results };
				const responseText = `User answers:\n${results.map(formatQuestionResult).join("\n")}`;
				return { content: [{ type: "text" as const, text: responseText }], details };
			} catch (error) {
				if (error instanceof Error && error.name === "AbortError") {
					throw new ToolAbortError("Ask input was cancelled");
				}
				throw error;
			}
		}

		const askQuestion = async (
			q: AskParams["questions"][number],
			options?: { previous?: QuestionResult; navigation?: NavigationControls },
		) => {
			const questionOptions = q.options.map(option => ({
				label: option.label,
				...(option.description?.trim() ? { description: option.description.trim() } : {}),
			}));
			const optionLabels = questionOptions.map(getAskOptionLabel);
			try {
				const { selectedOptions, customInput, note, navigation, cancelled, timedOut } = await askSingleQuestion(
					ui,
					q.question,
					questionOptions,
					q.multi ?? false,
					{
						recommended: q.recommended,
						timeout: timeout ?? undefined,
						signal,
						initialSelection: options?.previous,
						navigation: options?.navigation,
					},
				);
				return { optionLabels, selectedOptions, customInput, note, navigation, cancelled, timedOut };
			} catch (error) {
				if (error instanceof Error && error.name === "AbortError") {
					throw new ToolAbortError("Ask input was cancelled");
				}
				throw error;
			}
		};

		if (params.questions.length === 1) {
			const [q] = params.questions;
			const { optionLabels, selectedOptions, customInput, note, cancelled, timedOut } = await askQuestion(q);

			if (!timedOut && (cancelled || (selectedOptions.length === 0 && customInput === undefined))) {
				context.abort();
				throw new ToolAbortError("Ask tool was cancelled by the user");
			}
			const details: AskToolDetails = {
				question: q.question,
				options: optionLabels,
				multi: q.multi ?? false,
				selectedOptions,
				customInput,
				note,
				timedOut: timedOut || undefined,
			};

			const responseText = formatSingleQuestionResponse({
				selectedOptions,
				customInput,
				note,
				timedOut: timedOut || undefined,
				multi: q.multi ?? false,
			});

			return { content: [{ type: "text" as const, text: responseText }], details };
		}

		const resultsByIndex: Array<QuestionResult | undefined> = Array.from({ length: params.questions.length });
		let questionIndex = 0;
		while (questionIndex < params.questions.length) {
			const q = params.questions[questionIndex];
			if (!q) throw new Error("Ask question index exceeded the requested question list");
			const previous = resultsByIndex[questionIndex];
			const navigation: NavigationControls = {
				allowBack: questionIndex > 0,
				allowForward: true,
				progressText: `${questionIndex + 1}/${params.questions.length}`,
			};
			const {
				optionLabels,
				selectedOptions,
				customInput,
				note,
				navigation: navAction,
				cancelled,
				timedOut,
			} = await askQuestion(q, { previous, navigation });

			if (cancelled && !timedOut) {
				context.abort();
				throw new ToolAbortError("Ask tool was cancelled by the user");
			}

			resultsByIndex[questionIndex] = {
				id: q.id,
				question: q.question,
				options: optionLabels,
				multi: q.multi ?? false,
				selectedOptions,
				customInput,
				note,
				timedOut: timedOut || undefined,
			};

			if (navAction === "back") {
				questionIndex = Math.max(0, questionIndex - 1);
				continue;
			}

			questionIndex += 1;
		}

		const results = params.questions.map((q, index) => {
			const result = resultsByIndex[index];
			if (result) return result;
			return {
				id: q.id,
				question: q.question,
				options: q.options.map(o => o.label),
				multi: q.multi ?? false,
				selectedOptions: [],
			};
		});

		const details: AskToolDetails = { results };
		const responseLines = results.map(formatQuestionResult);
		const responseText = `User answers:\n${responseLines.join("\n")}`;

		return { content: [{ type: "text" as const, text: responseText }], details };
	}
}

/**
 * Format a model-provided id/label for a validation error. Degenerate input
 * can carry tabs or kilobytes of text, and the error echoes through the
 * plain `Text` fallback renderer — expand tabs FIRST so the width bound
 * applies to displayed cells, then clamp like every other error display
 * path (`formatErrorMessage`).
 */
function formatErrorValue(value: string): string {
	return truncateToWidth(replaceTabs(value), TRUNCATE_LENGTHS.LINE);
}
/** Strip the `\r` runs degenerate models inject, so persisted call args render as prose. */
function sanitizeAskParams(params: AskParams): AskParams {
	return {
		...params,
		questions: params.questions.map(question => ({
			...question,
			id: sanitizeCarriageReturns(question.id),
			question: sanitizeCarriageReturns(question.question),
			...(question.header !== undefined ? { header: sanitizeCarriageReturns(question.header) } : {}),
			options: question.options.map(option => ({
				...option,
				label: sanitizeCarriageReturns(option.label),
				...(option.description !== undefined ? { description: sanitizeCarriageReturns(option.description) } : {}),
				...(option.preview !== undefined ? { preview: sanitizeCarriageReturns(option.preview) } : {}),
			})),
		})),
	};
}
