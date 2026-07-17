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

import type {
	AgentTool,
	AgentToolContext,
	AgentToolResult,
	AgentToolUpdateCallback,
} from "@pk-nerdsaver-ai/pi-agent-core";
import type { ToolExample } from "@pk-nerdsaver-ai/pi-ai";
import {
	type Component,
	Markdown,
	type MarkdownTheme,
	renderInlineMarkdown,
	TERMINAL,
	Text,
} from "@pk-nerdsaver-ai/pi-tui";
import { prompt, untilAborted } from "@pk-nerdsaver-ai/pi-utils";
import { type as arkType } from "arktype";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import type { ExtensionUISelectItem } from "../extensibility/extensions";
import { getMarkdownTheme, type Theme, theme } from "../modes/theme/theme";
import askDescription from "../prompts/tools/ask.md" with { type: "text" };
import { vocalizer } from "../tts/vocalizer";
import { framedBlock, renderStatusLine } from "../tui";
import type { ToolSession } from ".";
import { formatErrorMessage, formatMeta, formatTitle } from "./render-utils";
import { ToolAbortError } from "./tool-errors";

// =============================================================================
// Types
// =============================================================================

const OptionItem = arkType({
	label: arkType("string").describe("display label"),
	"description?": arkType("string").describe("optional explanatory text displayed below the label"),
});

const QuestionItem = arkType({
	id: arkType("string").describe("question id"),
	question: arkType("string").describe("question text"),
	options: OptionItem.array().describe("available options"),
	"multi?": arkType("boolean").describe("allow multiple selections"),
	"recommended?": arkType("number").describe("recommended option index"),
});

const askSchema = arkType({
	questions: QuestionItem.array().atLeastLength(1).describe("questions to ask"),
});

export type AskToolInput = typeof askSchema.infer;

/** Result for a single question */
export interface QuestionResult {
	id: string;
	question: string;
	options: string[];
	multi: boolean;
	selectedOptions: string[];
	customInput?: string;
	/** True when the answer was auto-selected because the dialog timed out. */
	timedOut?: boolean;
}

export interface AskToolDetails {
	question?: string;
	options?: string[];
	multi?: boolean;
	selectedOptions?: string[];
	customInput?: string;
	/** True when the answer was auto-selected because the dialog timed out. */
	timedOut?: boolean;
	/** Multi-part question mode */
	results?: QuestionResult[];
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

const OTHER_OPTION = "Other (type your own)";
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
	initialSelection?: Pick<SelectionResult, "selectedOptions" | "customInput">;
	navigation?: NavigationControls;
}

interface UIContext {
	select(
		prompt: string,
		options: ExtensionUISelectItem[],
		options_?: {
			initialIndex?: number;
			timeout?: number;
			signal?: AbortSignal;
			outline?: boolean;
			onTimeout?: () => void;
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
		const dialogOptions = {
			initialIndex,
			timeout,
			signal,
			outline: true,
			onTimeout,
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
		const startMs = Date.now();
		const choice = signal
			? await untilAborted(signal, () => ui.select(prompt, optionsToShow, dialogOptions))
			: await ui.select(prompt, optionsToShow, dialogOptions);
		if (!timeoutTriggered && choice === undefined && typeof timeout === "number") {
			// Fallback for UI surfaces that enforce `timeout` without invoking
			// `onTimeout`: their auto-cancel resolves right at the deadline. A
			// cancel arriving well past the deadline is a deliberate user Esc on
			// a surface that kept the dialog open — keep treating it as a cancel.
			const elapsed = Date.now() - startMs;
			timeoutTriggered = elapsed >= timeout && elapsed <= timeout + TIMEOUT_DETECTION_TOLERANCE_MS;
		}
		return { choice, timedOut: timeoutTriggered, navigation: navigationAction };
	};

	const promptForCustomInput = async (): Promise<{ input: string | undefined }> => {
		const dialogOptions = signal ? { signal } : undefined;
		const showCustomInput = () => ui.editor("Enter your response:", undefined, dialogOptions, { promptStyle: true });
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
				return { selectedOptions: Array.from(selected), customInput, timedOut, navigation: arrowNavigation };
			}
			if (choice === undefined) {
				if (selectTimedOut) {
					timedOut = true;
					break;
				}
				return { selectedOptions: Array.from(selected), customInput, timedOut, cancelled: true };
			}
			if (choice === doneLabel) break;

			if (choice === OTHER_OPTION) {
				if (selectTimedOut) {
					timedOut = true;
					break;
				}
				const customResult = await promptForCustomInput();
				if (customResult.input === undefined) {
					break;
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
		const displayOptions = addRecommendedSuffix(questionOptions, recommended);
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

		while (true) {
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
				return { selectedOptions, customInput, timedOut, navigation: arrowNavigation };
			}
			if (choice === undefined) {
				if (!timedOut) {
					return { selectedOptions, customInput, timedOut, cancelled: true };
				}
			} else if (choice === OTHER_OPTION) {
				if (!selectTimedOut) {
					const customResult = await promptForCustomInput();
					if (customResult.input === undefined) {
						initialIndex = displayOptions.length;
						continue;
					}
					customInput = customResult.input;
					selectedOptions = [];
				}
			} else {
				selectedOptions = [stripRecommendedSuffix(choice)];
				customInput = undefined;
			}
			break;
		}
		if (navigation?.allowForward) {
			return { selectedOptions, customInput, timedOut, navigation: "forward" };
		}
	}

	if (timedOut && selectedOptions.length === 0 && customInput === undefined) {
		selectedOptions = getAutoSelectionOnTimeout(questionOptions, recommended);
	}

	return { selectedOptions, customInput, timedOut };
}

function formatQuestionResult(result: QuestionResult): string {
	if (result.customInput !== undefined) {
		return `${result.id}: "${result.customInput}"`;
	}
	if (result.selectedOptions.length > 0) {
		const suffix = result.timedOut ? " (auto-selected after timeout)" : "";
		return result.multi
			? `${result.id}: [${result.selectedOptions.join(", ")}]${suffix}`
			: `${result.id}: ${result.selectedOptions[0]}${suffix}`;
	}
	return `${result.id}: (cancelled)`;
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
			caption: "Single question",
			call: {
				questions: [
					{
						id: "auth_method",
						question: "Which authentication method should this API use?",
						options: [
							{ label: "JWT", description: "Bearer tokens for stateless API clients." },
							{ label: "OAuth2", description: "Delegated authorization with external identity providers." },
							{
								label: "Session cookies",
								description: "Browser-first authentication backed by server-side sessions.",
							},
						],
						recommended: 0,
					},
				],
			},
		},
		{
			caption: "Multiple questions",
			call: {
				questions: [
					{
						id: "storage_type",
						question: "Which storage backend?",
						options: [{ label: "SQLite" }, { label: "PostgreSQL" }],
					},
					{
						id: "auth_method",
						question: "Which auth method?",
						options: [{ label: "JWT" }, { label: "Session cookies" }],
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
		return session.hasUI ? new AskTool(session) : null;
	}

	/** Send terminal notification when ask tool is waiting for input */
	#sendAskNotification(): void {
		const method = this.session.settings.get("ask.notify");
		if (method === "off") return;
		TERMINAL.sendNotification({
			title: "Oh My Pi",
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

		const extensionUi = context.ui;
		const ui: UIContext = {
			select: (prompt, options, dialogOptions) => extensionUi.select(prompt, options, dialogOptions),
			editor: (title, prefill, dialogOptions, editorOptions) =>
				extensionUi.editor(title, prefill, dialogOptions, editorOptions),
		};

		// Determine timeout based on settings and plan mode
		const planModeEnabled = this.session.getPlanModeState?.()?.enabled ?? false;
		// Settings.get("ask.timeout") returns seconds (0 = disabled), convert to ms
		const timeoutSeconds = this.session.settings.get("ask.timeout");
		const settingsTimeout = timeoutSeconds === 0 ? null : timeoutSeconds * 1000;
		const timeout = planModeEnabled ? null : settingsTimeout;

		// Send notification if waiting and not suppressed
		this.#sendAskNotification();

		// Flag this agent as needing user attention in the Agent Hub
		const agentId = this.session.getAgentId?.();
		const registry = this.session.agentRegistry;
		if (agentId && registry) {
			const preview = params.questions[0]?.question;
			registry.setAttention(agentId, preview ? `ask: ${preview}` : "ask: waiting for input");
		}

		if (params.questions.length === 0) {
			return {
				content: [{ type: "text" as const, text: "Error: questions must not be empty" }],
				details: {},
			};
		}

		// Speak the question(s) aloud before surfacing them. Ask vocalizes in every
		// mode — it's the assistant addressing the user — gated only by speech.enabled
		// (the vocalizer re-checks the setting and no-ops when disabled).
		if (this.session.settings.get("speech.enabled")) {
			vocalizer.speak(params.questions.map(q => q.question).join("\n"));
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
				const { selectedOptions, customInput, navigation, cancelled, timedOut } = await askSingleQuestion(
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
				return { optionLabels, selectedOptions, customInput, navigation, cancelled, timedOut };
			} catch (error) {
				if (error instanceof Error && error.name === "AbortError") {
					throw new ToolAbortError("Ask input was cancelled");
				}
				throw error;
			}
		};

		try {
			if (params.questions.length === 1) {
				const [q] = params.questions;
				const { optionLabels, selectedOptions, customInput, cancelled, timedOut } = await askQuestion(q);

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
					timedOut: timedOut || undefined,
				};

				const responseParts: string[] = [];
				if (selectedOptions.length > 0) {
					const selectedText = q.multi
						? `User selected: ${selectedOptions.join(", ")}`
						: `User selected: ${selectedOptions[0]}`;
					responseParts.push(timedOut ? `${selectedText} (auto-selected after timeout)` : selectedText);
				}
				if (customInput !== undefined) {
					responseParts.push(
						customInput.includes("\n")
							? `User provided custom input:\n${customInput
									.split("\n")
									.map(line => `  ${line}`)
									.join("\n")}`
							: `User provided custom input: ${customInput}`,
					);
				}
				const responseText = responseParts.length > 0 ? responseParts.join("\n") : "User cancelled the selection";

				return { content: [{ type: "text" as const, text: responseText }], details };
			}

			const resultsByIndex: Array<QuestionResult | undefined> = Array.from({ length: params.questions.length });
			let questionIndex = 0;
			while (questionIndex < params.questions.length) {
				const q = params.questions[questionIndex]!;
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
					timedOut: timedOut || undefined,
				};

				if (navAction === "back") {
					questionIndex = Math.max(0, questionIndex - 1);
					continue;
				}

				questionIndex += 1;
			}

			const results = resultsByIndex.map((result, index) => {
				if (result) return result;
				const q = params.questions[index]!;
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
		} finally {
			if (agentId && registry) {
				registry.clearAttention(agentId);
			}
		}
	}
}

// =============================================================================
// TUI Renderer
// =============================================================================

interface AskRenderOption {
	label: string;
	description?: string;
}

interface AskRenderArgs {
	question?: string;
	options?: AskRenderOption[];
	multi?: boolean;
	questions?: Array<{
		id: string;
		question: string;
		options: AskRenderOption[];
		multi?: boolean;
	}>;
}

/**
 * Coerce an untrusted option list (streamed or model-mangled call args) into
 * well-formed render options. Bare strings become labels; entries without a
 * string label are dropped.
 */
function normalizeRenderOptions(raw: unknown): AskRenderOption[] | undefined {
	if (!Array.isArray(raw)) return undefined;
	const out: AskRenderOption[] = [];
	for (const entry of raw) {
		if (typeof entry === "string") {
			out.push({ label: entry });
			continue;
		}
		if (!entry || typeof entry !== "object") continue;
		const { label, description } = entry as Partial<AskRenderOption>;
		if (typeof label !== "string") continue;
		out.push(typeof description === "string" ? { label, description } : { label });
	}
	return out;
}

/**
 * Coerce untrusted `questions` call args into a renderable array. Models
 * occasionally double-encode the array as a JSON string — a bare string passes
 * a truthy `.length` check but has no `.map`, which used to crash the TUI
 * render loop. Partially streamed args can also be missing fields.
 */
function normalizeRenderQuestions(raw: unknown): NonNullable<AskRenderArgs["questions"]> | undefined {
	if (typeof raw === "string") {
		try {
			raw = JSON.parse(raw);
		} catch {
			return undefined;
		}
	}
	if (!Array.isArray(raw)) return undefined;
	const out: NonNullable<AskRenderArgs["questions"]> = [];
	for (const entry of raw) {
		if (!entry || typeof entry !== "object") continue;
		const q = entry as Partial<NonNullable<AskRenderArgs["questions"]>[number]>;
		out.push({
			id: typeof q.id === "string" ? q.id : "?",
			question: typeof q.question === "string" ? q.question : "",
			options: normalizeRenderOptions(q.options) ?? [],
			multi: q.multi === true,
		});
	}
	return out;
}

/** Render a custom free-text answer as a status line plus indented continuation rows. */
function renderCustomInputLines(uiTheme: Theme, customInput: string): string[] {
	const lines = customInput.split("\n");
	const out: string[] = [
		` ${uiTheme.styledSymbol("status.success", "success")} ${uiTheme.fg("toolOutput", lines[0] ?? "")}`,
	];
	for (let i = 1; i < lines.length; i++) out.push(`   ${uiTheme.fg("toolOutput", lines[i])}`);
	return out;
}

/**
 * Marker glyph for a question option. Single-choice questions render circular radio
 * buttons (pick one); multi-select questions render rectangular checkboxes (pick many).
 */
function optionMarker(uiTheme: Theme, multi: boolean | undefined, selected: boolean): string {
	if (multi) return selected ? uiTheme.checkbox.checked : uiTheme.checkbox.unchecked;
	return selected ? uiTheme.radio.selected : uiTheme.radio.unselected;
}

/** Render the offered options for a question form as flat marker bullets (no tree guides). */
function renderQuestionOptionLines(
	uiTheme: Theme,
	mdTheme: MarkdownTheme,
	options: AskRenderOption[],
	multi: boolean | undefined,
): string[] {
	const out: string[] = [];
	for (const opt of options) {
		const optLabel = renderInlineMarkdown(opt.label, mdTheme, t => uiTheme.fg("muted", t));
		out.push(` ${uiTheme.fg("dim", optionMarker(uiTheme, multi, false))} ${optLabel}`);
		if (opt.description?.trim()) {
			const description = renderInlineMarkdown(opt.description.trim(), mdTheme, t => uiTheme.fg("dim", t));
			out.push(`   ${uiTheme.fg("dim", "↳")} ${description}`);
		}
	}
	return out;
}

/**
 * Render the answered option list for a question: every offered option with its
 * selection marker filled in, plus any custom free-text answer. Flat marker
 * bullets — the frame is the container, so no tree guides are drawn.
 */
function renderAnswerOptionLines(
	uiTheme: Theme,
	mdTheme: MarkdownTheme,
	options: string[] | undefined,
	selectedOptions: string[] | undefined,
	multi: boolean | undefined,
	customInput: string | undefined,
): string[] {
	const selected = new Set(selectedOptions ?? []);
	// Prefer the full recorded option set; fall back to the selected labels when
	// details omit the options array.
	const list = options && options.length > 0 ? options : (selectedOptions ?? []);

	// Nothing was chosen (and no custom answer) → a lone cancelled marker.
	if (selected.size === 0 && customInput === undefined) {
		return [` ${uiTheme.styledSymbol("status.warning", "warning")} ${uiTheme.fg("warning", "Cancelled")}`];
	}

	const out: string[] = [];
	for (const label of list) {
		const isSelected = selected.has(label);
		const marker = optionMarker(uiTheme, multi, isSelected);
		const markerStyled = isSelected ? uiTheme.fg("success", marker) : uiTheme.fg("dim", marker);
		const labelStyled = renderInlineMarkdown(label, mdTheme, t =>
			isSelected ? uiTheme.fg("toolOutput", t) : uiTheme.fg("muted", t),
		);
		out.push(` ${markerStyled} ${labelStyled}`);
	}
	if (customInput !== undefined) out.push(...renderCustomInputLines(uiTheme, customInput));
	return out;
}

export const askToolRenderer = {
	mergeCallAndResult: true,
	renderCall(args: AskRenderArgs, _options: RenderResultOptions, uiTheme: Theme): Component {
		const label = formatTitle("Ask", uiTheme);
		const mdTheme = getMarkdownTheme();
		const accentStyle = { color: (t: string) => uiTheme.fg("accent", t) };
		const md = (text: string, width: number) =>
			new Markdown(text, 1, 0, mdTheme, accentStyle).render(Math.max(1, width - 3 + 1));

		// Multi-part questions: one divider-labelled section per question.
		// Call args are untrusted (partially streamed or model-mangled) and a
		// throw here takes down the whole TUI render loop — normalize first.
		const questions = normalizeRenderQuestions(args.questions);
		if (questions && questions.length > 0) {
			const header = `${label} ${uiTheme.fg("muted", `${questions.length} questions`)}`;
			return framedBlock(uiTheme, width => {
				const sections = questions.map(q => {
					const meta: string[] = [];
					if (q.multi) meta.push("multi");
					if (q.options?.length) meta.push(`options:${q.options.length}`);
					const metaStr = meta.length > 0 ? uiTheme.fg("dim", ` · ${meta.join(" · ")}`) : "";
					// md() returns a shared cached array (module-level Markdown LRU) — copy before appending.
					const mdLines = md(q.question, width);
					const lines = q.options?.length
						? [...mdLines, ...renderQuestionOptionLines(uiTheme, mdTheme, q.options, q.multi)]
						: mdLines;
					return { label: `${uiTheme.fg("dim", `[${q.id}]`)}${metaStr}`, lines };
				});
				return { header, sections, state: "pending", borderColor: "borderMuted", width };
			});
		}

		// Single question
		if (typeof args.question !== "string" || !args.question) {
			const errorLine = formatErrorMessage("No question provided", uiTheme);
			return framedBlock(uiTheme, width => ({
				header: errorLine,
				sections: [],
				state: "error",
				borderColor: "error",
				width,
			}));
		}

		const question = args.question;
		const meta: string[] = [];
		if (args.multi) meta.push("multi");
		const questionOptions = normalizeRenderOptions(args.options);
		if (questionOptions?.length) meta.push(`options:${questionOptions.length}`);
		const header = `${label}${formatMeta(meta, uiTheme)}`;
		const multi = args.multi;
		return framedBlock(uiTheme, width => {
			// md() returns a shared cached array (module-level Markdown LRU) — copy before appending.
			const mdLines = md(question, width);
			const bodyLines = questionOptions?.length
				? [...mdLines, ...renderQuestionOptionLines(uiTheme, mdTheme, questionOptions, multi)]
				: mdLines;
			return {
				header,
				sections: bodyLines.length > 0 ? [{ lines: bodyLines }] : [],
				state: "pending",
				borderColor: "borderMuted",
				width,
			};
		});
	},

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: AskToolDetails },
		_options: RenderResultOptions,
		uiTheme: Theme,
	): Component {
		const { details } = result;
		const mdTheme = getMarkdownTheme();
		const accentStyle = { color: (t: string) => uiTheme.fg("accent", t) };
		const md = (text: string, width: number) =>
			new Markdown(text, 1, 0, mdTheme, accentStyle).render(Math.max(1, width - 3 + 1));

		if (!details) {
			const txt = result.content[0];
			const fallback = txt?.type === "text" && txt.text ? txt.text : "";
			const header = renderStatusLine({ icon: "warning", title: "Ask" }, uiTheme);
			const body = fallback ? `\n${uiTheme.fg("dim", fallback)}` : "";
			return new Text(`${header}${body}`, 0, 0);
		}

		// Multi-part results: one divider-labelled section per question.
		if (details.results && details.results.length > 0) {
			const results = details.results;
			const hasAnySelection = results.some(
				r => r.customInput !== undefined || (r.selectedOptions && r.selectedOptions.length > 0),
			);
			const header = renderStatusLine(
				{
					icon: hasAnySelection ? "success" : "warning",
					title: "Ask",
					meta: [`${results.length} questions`],
				},
				uiTheme,
			);
			return framedBlock(uiTheme, width => {
				const sections = results.map(r => {
					// md() returns a shared cached array (module-level Markdown LRU) — copy before appending.
					const lines = [
						...md(r.question, width),
						...renderAnswerOptionLines(uiTheme, mdTheme, r.options, r.selectedOptions, r.multi, r.customInput),
					];
					return { label: uiTheme.fg("dim", `[${r.id}]`), lines };
				});
				return {
					header,
					sections,
					state: hasAnySelection ? "success" : "warning",
					borderColor: "borderMuted",
					width,
				};
			});
		}

		// Single question result
		if (!details.question) {
			const txt = result.content[0];
			const fallback = txt?.type === "text" && txt.text ? txt.text : "";
			return new Text(fallback, 0, 0);
		}

		const question = details.question;
		const hasSelection =
			details.customInput !== undefined || (details.selectedOptions && details.selectedOptions.length > 0);
		const header = renderStatusLine(
			hasSelection
				? { iconOverride: uiTheme.styledSymbol("tool.ask", "accent"), title: "Ask" }
				: { icon: "warning", title: "Ask" },
			uiTheme,
		);
		const dOptions = details.options;
		const dSelected = details.selectedOptions;
		const dMulti = details.multi;
		const dCustom = details.customInput;
		const dTimedOut = details.timedOut;
		return framedBlock(uiTheme, width => {
			// md() returns a shared cached array (module-level Markdown LRU) — copy before appending.
			const bodyLines = [
				...md(question, width),
				...renderAnswerOptionLines(uiTheme, mdTheme, dOptions, dSelected, dMulti, dCustom),
			];
			if (dTimedOut) {
				// Distinguish auto-selection from a real user choice in the transcript.
				bodyLines.push(uiTheme.fg("dim", "auto-selected after timeout — not a user choice"));
			}
			return {
				header,
				sections: bodyLines.length > 0 ? [{ lines: bodyLines }] : [],
				state: hasSelection ? "success" : "warning",
				borderColor: "borderMuted",
				width,
			};
		});
	},
};
