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
import { type ImageContent, type TextContent, type ToolExample, validateToolArguments } from "@oh-my-pi/pi-ai";
import { replaceTabs, TERMINAL, truncateToWidth } from "@oh-my-pi/pi-tui";
import { isRecord, logger, prompt, sanitizeText, untilAborted } from "@oh-my-pi/pi-utils";
import { flattenLine } from "@oh-my-pi/pi-tui/render/render-utils";

import type { ExtensionUIContext, ExtensionUISelectItem } from "../extensibility/extensions";
import { formatKeyHint, formatKeyHints } from "@oh-my-pi/pi-tui/app-keybindings";
import { editorKey, editorKeys } from "@oh-my-pi/pi-tui/chrome/keybinding-hints";
import { theme } from "@oh-my-pi/pi-tui/theme";
import askDescription from "../prompts/tools/ask.md" with { type: "text" };
import askHeadlessForkMessage from "../prompts/tools/ask-headless-fork.md" with { type: "text" };
import askDismissedMessage from "../prompts/tools/ask-dismissed.md" with { type: "text" };
import askYieldTemplate from "../prompts/tools/ask-yield.md" with { type: "text" };
import { vocalizer } from "../tts/vocalizer";

import type { ToolSession } from ".";
import {
	disambiguateDisplayLabels,
	sanitizeCarriageReturns,
	TRUNCATE_LENGTHS,
} from "@oh-my-pi/pi-tui/render/render-utils";
import { imageAttachmentSource } from "@oh-my-pi/pi-tui/prompt/image-source";
import type { AttachmentTextPart } from "@oh-my-pi/pi-tui/prompt/composer-attachments";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { ToolAbortError } from "./tool-errors";
import { cfgAsyncEnabled } from "./settings";
import { hasWaitTool } from "./wait";

import { sessionLocalProtocolOptions } from "../internal-urls/context";
import { cfgAskNotify, askTimeoutMs } from "../modes/settings";
import { type ImageMarkedPart, markSuppliedParts, renderImageMarkedText } from "../session/image-marked-text";
import { cfgSpeechEnabled } from "../tts/settings";
import { describeAttachedImagesForTextModel, shouldDescribeImagesForTextModel } from "../utils/image-vision-fallback";

// =============================================================================
// Types
// =============================================================================

/** Returned to a headless fork's model instead of aborting its run. */
const HEADLESS_FORK_ASK_ERROR = prompt.render(askHeadlessForkMessage);

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

const askRecoveryTool = { name: "ask", description: "", parameters: askSchema };

export type AskToolInput = typeof askSchema.infer;

/**
 * Recover valid questions from a persisted `ask` tool call for `/tree` re-answer.
 * Apply live tool-call normalization first so optional null placeholders in saved
 * arguments do not prevent reopening; malformed questions still fail closed.
 */
export function recoverAskQuestions(toolCallArguments: unknown): AskToolInput["questions"] | undefined {
	if (!isRecord(toolCallArguments)) return undefined;
	let normalized: Record<string, unknown>;
	try {
		normalized = validateToolArguments(askRecoveryTool, {
			type: "toolCall",
			id: "",
			name: "ask",
			arguments: toolCallArguments,
		});
	} catch {
		return undefined;
	}
	const parsed = askSchema(normalized);
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
		const questionHint = navigation ? `${formatKeyHints(["left", "right"])} question  ` : "";
		const helpText = `${editorKeys("tui.select.up", "tui.select.down")} navigate  ${formatKeyHint("enter")} select  ${questionHint}${editorKey("tui.select.cancel")} cancel`;
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

	const promptForCustomInput = async (title: string): Promise<{ input: string | undefined }> => {
		const dialogOptions = signal ? { signal } : undefined;
		const showCustomInput = () => ui.editor(title, undefined, dialogOptions, { promptStyle: true });
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

			// Arrow-key forward navigation is TUI-only; RPC clients need the Done row to advance.
			if (selected.size > 0) {
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
				const customResult = await promptForCustomInput(`${prefix}${promptWithProgress}`);
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
				const customResult = await promptForCustomInput(promptWithProgress);
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

/** A question's answer with its free-text fields kept as marked text (see {@link markAnswerField}). */
type MarkedQuestionResult = Omit<QuestionResult, "customInput" | "note"> & {
	customInput?: ImageMarkedPart[];
	note?: ImageMarkedPart[];
};

/** A typed field with no images as marked text: one literal run, none for an empty field. */
function plainField(text: string | undefined): ImageMarkedPart[] | undefined {
	if (text === undefined) return undefined;
	return text ? [text] : [];
}

/**
 * One answer field as marked text, numbered from `offset + 1` among the answer's images.
 *
 * `parts` is what the prompt reported: which runs of `text` carried the attachment tokens it
 * inserted. Only those are renumbered, and no marker is ever found by its characters. A host
 * that attaches images to an answer without recording it (none in this repo does — see
 * `docs/tools/ask.md`) gets one literal run: its text reaches the model exactly as written,
 * keeping that answer's own numbering.
 */
function markAnswerField(
	text: string | undefined,
	parts: readonly AttachmentTextPart[] | undefined,
	offset: number,
	imageCount: number,
): ImageMarkedPart[] | undefined {
	if (text === undefined) return undefined;
	if (parts === undefined || imageCount === 0) return plainField(text);
	return markSuppliedParts(parts, offset, imageCount);
}

/** Indent every line of `parts` by two spaces; markers never span lines. */
function indentLines(parts: ImageMarkedPart[]): ImageMarkedPart[] {
	return ["  ", ...parts.map(part => (typeof part === "string" ? part.replaceAll("\n", "\n  ") : part))];
}

function hasLineBreak(parts: ImageMarkedPart[]): boolean {
	return parts.some(part => typeof part === "string" && part.includes("\n"));
}

/** Join marked-text lines with line breaks. */
function joinLines(lines: ImageMarkedPart[][]): ImageMarkedPart[] {
	return lines.flatMap((line, index) => (index === 0 ? line : ["\n", ...line]));
}

function formatQuestionResult(result: MarkedQuestionResult): ImageMarkedPart[] {
	const noteOn = result.noteOption === undefined ? "" : ` on ${result.noteOption}`;
	const noteSuffix: ImageMarkedPart[] = result.note?.length ? [` (note${noteOn}: `, ...result.note, ")"] : [];
	const custom = result.customInput === undefined ? undefined : ['"', ...result.customInput, '"'];
	if (result.selectedOptions.length === 0) {
		if (custom !== undefined) return [`${result.id}: `, ...custom, ...noteSuffix];
		return [result.multi ? `${result.id}: []` : `${result.id}: (cancelled)`, ...noteSuffix];
	}
	const picked = result.multi ? `[${result.selectedOptions.join(", ")}]` : result.selectedOptions[0]!;
	const answer = custom === undefined ? [picked] : [`${picked} + `, ...custom];
	const timeoutSuffix = result.timedOut ? " (auto-selected after timeout)" : "";
	return [`${result.id}: `, ...answer, timeoutSuffix, ...noteSuffix];
}

function formatSingleQuestionResponse(result: {
	selectedOptions: string[];
	customInput?: ImageMarkedPart[];
	note?: ImageMarkedPart[];
	noteOption?: string;
	timedOut?: boolean;
	multi: boolean;
}): ImageMarkedPart[] {
	const responseParts: ImageMarkedPart[][] = [];
	if (result.selectedOptions.length > 0) {
		const selectedText = result.multi
			? `User selected: ${result.selectedOptions.join(", ")}`
			: `User selected: ${result.selectedOptions[0]}`;
		responseParts.push([result.timedOut ? `${selectedText} (auto-selected after timeout)` : selectedText]);
	}
	if (result.customInput !== undefined) {
		responseParts.push(
			hasLineBreak(result.customInput)
				? ["User provided custom input:\n", ...indentLines(result.customInput)]
				: ["User provided custom input: ", ...result.customInput],
		);
	}
	if (result.note?.length) {
		const label = `User added note${result.noteOption === undefined ? "" : ` on ${result.noteOption}`}:`;
		responseParts.push(
			hasLineBreak(result.note) ? [`${label}\n`, ...indentLines(result.note)] : [`${label} `, ...result.note],
		);
	}
	if (responseParts.length > 0) return joinLines(responseParts);
	return [result.multi ? "User did not select any options" : "User cancelled the selection"];
}

// =============================================================================
// Tool Class
// =============================================================================

type AskParams = AskToolInput;

/** What one `ask` call's dialog shows, independent of who waits on it. */
interface AskDialogRun {
	params: AskParams;
	extensionUi: ExtensionUIContext;
	ui: UIContext;
	timeout: number | null;
	abortError: () => ToolAbortError;
}

/** How a dialog run that backs a job settled. */
type AskJobOutcome = { kind: "answered"; result: AgentToolResult<AskToolDetails> } | { kind: "failed"; error: unknown };

/**
 * A dialog's answer, plus its text blocks joined as the job's result text with the image markers
 * the answer inserted kept as structure, so a delivery can renumber them.
 */
interface AskAnswer {
	result: AgentToolResult<AskToolDetails>;
	text: ImageMarkedPart[];
}

/** Build an answer from text blocks (marked text) and images in result order. */
function askAnswer(blocks: Array<ImageMarkedPart[] | ImageContent>, details: AskToolDetails): AskAnswer {
	const text: ImageMarkedPart[] = [];
	const content: Array<TextContent | ImageContent> = [];
	for (const block of blocks) {
		if (!Array.isArray(block)) {
			content.push(block);
			continue;
		}
		if (text.length > 0) text.push("\n\n");
		text.push(...block);
		content.push({ type: "text", text: renderImageMarkedText(block) });
	}
	return { result: { content, details }, text };
}

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
	// Run alone in its tool batch: two dialogs opened by one batch would race
	// for the shared UI surface. A dialog a call handed to the background stays
	// open; a later `ask` queues behind it (the interactive controller presents
	// one dialog at a time).
	readonly concurrency = "exclusive";
	readonly loadMode = "discoverable";

	constructor(private readonly session: ToolSession) {
		this.description = prompt.render(askDescription);
	}

	static createIf(session: ToolSession): AskTool | null {
		return (session.canPromptUser ?? session.hasUI) || session.advertiseHeadlessAsk ? new AskTool(session) : null;
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

	/**
	 * Blocks for answer images: each image with its source-path notice and, for a text-only model,
	 * the vision description a pasted prompt image gets (best effort).
	 */
	async #answerImageBlocks(
		images: ImageContent[],
		signal: AbortSignal | undefined,
	): Promise<Array<ImageMarkedPart[] | ImageContent>> {
		if (images.length === 0) return [];
		let descriptions: TextContent[] | undefined;
		const model = this.session.getActiveModel?.();
		const modelRegistry = this.session.modelRegistry;
		if (modelRegistry && shouldDescribeImagesForTextModel(model, this.session.settings)) {
			try {
				descriptions = await describeAttachedImagesForTextModel(
					images,
					{
						activeModel: model,
						modelRegistry,
						settings: this.session.settings,
						localProtocolOptions: sessionLocalProtocolOptions(this.session),
						activeModelString: this.session.getActiveModelString?.(),
						telemetryConfig: this.session.getTelemetry?.(),
						sessionId: this.session.getSessionId?.() ?? undefined,
						costGate: this.session.costGate,
					},
					signal,
				);
			} catch (error) {
				logger.warn("ask answer image description failed; image left undescribed", {
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
		const blocks: Array<ImageMarkedPart[] | ImageContent> = [];
		for (const [index, image] of images.entries()) {
			const source = imageAttachmentSource(image);
			if (source)
				blocks.push([{ type: "notice", index: index + 1, source: { path: source.path, kind: source.kind } }]);
			// Keep the source tag: `attachment://N` resolves this result's images to their files.
			blocks.push(image);
			const description = descriptions?.[index];
			if (description) blocks.push([description.text]);
		}
		return blocks;
	}

	async execute(
		toolCallId: string,
		params: AskParams,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<AskToolDetails>,
		context?: AgentToolContext,
	): Promise<AgentToolResult<AskToolDetails>> {
		// Headless fallback
		if (!context?.hasUI || !context.ui) {
			// A headless fork (`/tan`) keeps `ask` advertised only to share the parent's
			// prompt-cache prefix. Aborting would end its run with no final answer, and the
			// parent would receive an empty result; let the model put the question there.
			if (this.session.advertiseHeadlessAsk) throw new ToolError(HEADLESS_FORK_ASK_ERROR);
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
		const settingsTimeout = askTimeoutMs(this.session.settings) ?? null;
		const timeout = planModeEnabled ? null : settingsTimeout;
		// A message the user queues closes the dialog without cancelling the turn: they moved on, and the
		// message reaches the agent at the batch boundary. Other messages (peer IRC, asides, finished
		// background jobs, other steering) are not the user's answer: with async jobs on, the call hands the
		// open dialog to a background job and returns so the agent reads the message now; with them off,
		// the dialog stays open and the call keeps waiting.
		const steeringSignal = context?.toolCall?.steeringSignal;
		const userSteering = new AbortController();
		const onSteer = () => {
			if (steeringSignal?.reason === "user") userSteering.abort();
		};
		if (steeringSignal?.aborted) onSteer();
		else steeringSignal?.addEventListener("abort", onSteer, { once: true });
		const abortError = (): ToolAbortError =>
			new ToolAbortError(userSteering.signal.aborted ? "Ask interrupted by message" : "Ask input was cancelled");
		const cancelInline = (): never => {
			if (userSteering.signal.aborted) throw abortError();
			context.abort();
			throw new ToolAbortError("Ask tool was cancelled by the user");
		};

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

		const run: AskDialogRun = { params, extensionUi, ui, timeout, abortError };
		const manager = cfgAsyncEnabled.get(this.session.settings) ? this.session.asyncJobManager : undefined;
		if (!manager) {
			// Async jobs off: the dialog holds the call until the user answers.
			const dialogSignal = signal ? AbortSignal.any([signal, userSteering.signal]) : userSteering.signal;
			return (await this.#runDialog(run, dialogSignal, signal, cancelInline)).result;
		}

		// Async jobs on: the dialog runs as a foreground job the call waits on.
		let backgrounded = false;
		const callAbort = new AbortController();
		const onCallAbort = () => callAbort.abort(signal?.reason);
		if (signal?.aborted) onCallAbort();
		else signal?.addEventListener("abort", onCallAbort, { once: true });
		const completion = Promise.withResolvers<AskJobOutcome>();
		const jobId = manager.register(
			"ask",
			// The job label is a one-line name in job lists: the model-written question
			// loses terminal controls, tabs and line breaks (the dialog keeps it whole).
			flattenLine(sanitizeText(params.questions[0]!.question)),
			async ({ signal: jobSignal, reportProgress }) => {
				// Once backgrounded, the finished call's abort and steering no longer
				// reach the dialog; the job's own signal (cancel, `proc://<id>/kill`) does.
				const workSignal = AbortSignal.any([jobSignal, callAbort.signal]);
				const dialogSignal = AbortSignal.any([workSignal, userSteering.signal]);
				try {
					const { result, text: markedText } = await this.#runDialog(run, dialogSignal, workSignal, () => {
						if (!backgrounded) return cancelInline();
						// The turn that asked is over: a dismissal ends only the question.
						throw new ToolError(prompt.render(askDismissedMessage));
					});
					completion.resolve({ kind: "answered", result });
					const text = renderImageMarkedText(markedText);
					// Answer images ride the delivery, as a backgrounded command's images do; the
					// marked text lets a delivery shared with other answers renumber their markers.
					const images = result.content.filter((block): block is ImageContent => block.type === "image");
					if (images.length > 0) await reportProgress(text, { images, imageMarkedText: markedText });
					return text;
				} catch (error) {
					completion.resolve({ kind: "failed", error });
					throw error;
				}
			},
			{
				ownerId: this.session.getAgentId?.() ?? undefined,
				foreground: true,
				intent: this.session.getToolCallIntent?.(toolCallId),
			},
		);
		// Any wake but the user's own steering (which closes the dialog) hands it
		// to the background, a wake raised before the call started included.
		const wakeSignal = context?.toolCall?.wakeSignal;
		const wake = Promise.withResolvers<"wake">();
		const onWake = () => {
			if (wakeSignal?.reason !== "user") wake.resolve("wake");
		};
		if (wakeSignal?.aborted) onWake();
		else wakeSignal?.addEventListener("abort", onWake, { once: true });
		let outcome: AskJobOutcome | "wake";
		try {
			outcome = await Promise.race([completion.promise, wake.promise]);
		} finally {
			wakeSignal?.removeEventListener("abort", onWake);
		}
		// Cancellation and the user's own steering win over a wake that landed
		// with them: the dialog is already closing, so report how it closed
		// instead of handing a dead question to the background.
		if (outcome === "wake" && (signal?.aborted || userSteering.signal.aborted)) outcome = await completion.promise;
		signal?.removeEventListener("abort", onCallAbort);
		if (outcome !== "wake") {
			manager.releaseForegroundJob(jobId);
			if (outcome.kind === "answered") return outcome.result;
			throw outcome.error;
		}
		// The question stays open for the user; the answer arrives as the job's result.
		backgrounded = true;
		steeringSignal?.removeEventListener("abort", onSteer);
		manager.backgroundJob(jobId);
		return {
			content: [
				{ type: "text", text: prompt.render(askYieldTemplate, { jobId, waitTool: hasWaitTool(this.session) }) },
			],
			details: {},
		};
	}

	/**
	 * Show the questions and build the answer result. `dialogSignal` closes the
	 * dialog; `workSignal` bounds the answer's follow-up work (image
	 * descriptions); `cancelAsk` decides what the user's dismissal means for
	 * whoever waits on the answer, and throws.
	 */
	async #runDialog(
		run: AskDialogRun,
		dialogSignal: AbortSignal,
		workSignal: AbortSignal | undefined,
		cancelAsk: () => never,
	): Promise<AskAnswer> {
		const { params, extensionUi, ui, timeout, abortError } = run;

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
						{ timeout: timeout ?? undefined, signal: dialogSignal, acceptImages: true },
					);
				const richResult = await untilAborted(dialogSignal, showRichDialog);
				if (!richResult) return cancelAsk();
				if (richResult.kind === "chat") {
					const questionText = params.questions.map(q => q.question).join("\n");
					return askAnswer(
						[[`User chose to chat about this instead of answering.\n\nQuestions asked:\n${questionText}`]],
						{ chatRedirect: true, questions: params.questions.map(q => q.question) },
					);
				}
				if (richResult.results.length !== params.questions.length) {
					throw new Error("Ask dialog returned a result count that does not match the requested questions");
				}
				const results: QuestionResult[] = [];
				const marked: MarkedQuestionResult[] = [];
				// Each prompt numbers the markers it inserted from 1; shift them so `[Image #N]`
				// indexes all result images.
				const answerImages: ImageContent[] = [];
				for (let index = 0; index < params.questions.length; index++) {
					const question = params.questions[index];
					const result = richResult.results[index];
					if (!question || !result || result.id !== question.id) {
						throw new Error("Ask dialog returned results that do not match the requested question order");
					}
					const customOffset = answerImages.length;
					if (result.customInputImages) answerImages.push(...result.customInputImages);
					const noteOffset = answerImages.length;
					if (result.noteImages) answerImages.push(...result.noteImages);
					const customInput = markAnswerField(
						result.customInput,
						result.customInputParts,
						customOffset,
						result.customInputImages?.length ?? 0,
					);
					const note = markAnswerField(result.note, result.noteParts, noteOffset, result.noteImages?.length ?? 0);
					const answer = {
						id: question.id,
						question: question.question,
						options: question.options.map(option => option.label),
						multi: question.multi ?? false,
						selectedOptions: result.selectedOptions,
						noteOption: result.noteOption,
						timedOut: result.timedOut,
					};
					results.push({
						...answer,
						customInput: customInput && renderImageMarkedText(customInput),
						note: note && renderImageMarkedText(note),
					});
					marked.push({ ...answer, customInput, note });
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
					)
						cancelAsk();
					const details: AskToolDetails = {
						question: result.question,
						options: result.options,
						multi: result.multi,
						selectedOptions: result.selectedOptions,
						customInput: result.customInput,
						note: result.note,
						noteOption: result.noteOption,
						timedOut: result.timedOut,
					};
					const imageBlocks = await this.#answerImageBlocks(answerImages, workSignal);
					return askAnswer([formatSingleQuestionResponse(marked[0]!), ...imageBlocks], details);
				}
				const details: AskToolDetails = { results };
				const response = ["User answers:\n", ...joinLines(marked.map(formatQuestionResult))];
				const imageBlocks = await this.#answerImageBlocks(answerImages, workSignal);
				return askAnswer([response, ...imageBlocks], details);
			} catch (error) {
				if (error instanceof Error && error.name === "AbortError") throw abortError();
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
						signal: dialogSignal,
						initialSelection: options?.previous,
						navigation: options?.navigation,
					},
				);
				return { optionLabels, selectedOptions, customInput, note, navigation, cancelled, timedOut };
			} catch (error) {
				if (error instanceof Error && error.name === "AbortError") throw abortError();
				throw error;
			}
		};

		if (params.questions.length === 1) {
			const [q] = params.questions;
			const { optionLabels, selectedOptions, customInput, note, cancelled, timedOut } = await askQuestion(q);

			if (!timedOut && (cancelled || (selectedOptions.length === 0 && customInput === undefined))) cancelAsk();
			const details: AskToolDetails = {
				question: q.question,
				options: optionLabels,
				multi: q.multi ?? false,
				selectedOptions,
				customInput,
				note,
				timedOut: timedOut || undefined,
			};

			const response = formatSingleQuestionResponse({
				selectedOptions,
				customInput: plainField(customInput),
				note: plainField(note),
				timedOut: timedOut || undefined,
				multi: q.multi ?? false,
			});

			return askAnswer([response], details);
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

			if (cancelled && !timedOut) cancelAsk();

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
		const response = [
			"User answers:\n",
			...joinLines(
				results.map(result =>
					formatQuestionResult({
						...result,
						customInput: plainField(result.customInput),
						note: plainField(result.note),
					}),
				),
			),
		];
		return askAnswer([response], details);
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
