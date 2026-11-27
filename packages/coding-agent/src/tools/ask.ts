/**
 * Ask Tool - the model asks the user to fill in one HTML `<form>`.
 *
 * Hosts with a form surface (`ui.formDialog`: the interactive TUI, ACP, RPC)
 * render the form whole; every other host walks its named fields one prompt
 * at a time through `select`/`input`/`editor`, each prompt
 * titled with the form text around its field and then its question. The model
 * receives the submitted form data as JSON. Outside plan mode a configurable
 * timeout submits the form's preselected values.
 */

import { type as arkType } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import type { ImageContent, TextContent } from "@oh-my-pi/pi-ai";
import { notifyTerminal } from "@oh-my-pi/pi-tui/driver/session";
import { actionKey, formatKeyHint } from "../ui/keys/hints";
import {
	choiceValue,
	defaultFormData,
	fieldContexts,
	fieldQuestions,
	fieldError,
	formAnswers,
	type HtmlFormData,
	type HtmlFormValue,
	isArrayChoice,
	type OptionNote,
	OTHER_LABEL,
	textValue,
} from "./html-form/data";
import {
	type ChoiceField,
	type FormField,
	type HtmlForm,
	parseHtmlForm,
	spansText,
	type TextField,
} from "./html-form/parse";
import { shiftImageMarkers } from "../modes/view-model/prompt/composer-attachments";
import { disambiguateDisplayLabels } from "../utils/render-utils";
import type { AskToolDetails } from "./details/ask";
import { ToolError } from "./tool-errors";
import { isRecord, logger, prompt, untilAborted } from "@oh-my-pi/pi-utils";
import type { PendingPrompt } from "../extensibility/extensions/pending-interactions";
import type {
	AskFieldSummary,
	ExtensionAskAnswer,
	ExtensionFormDialogResult,
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	ExtensionUISelectItem,
} from "../extensibility/extensions";
import { sessionLocalProtocolOptions } from "../internal-urls/context";
import { askTimeoutMs, cfgAskNotify } from "../modes/settings";
import askDescription from "../prompts/tools/ask.md" with { type: "text" };
import askHeadlessForkMessage from "../prompts/tools/ask-headless-fork.md" with { type: "text" };
import askResultTemplate from "../prompts/tools/ask-result.md" with { type: "text" };
import askSplitRadioGroupsTemplate from "../prompts/tools/ask-split-radio-groups.md" with { type: "text" };
import { renderAttachmentSourceNotice } from "../session/attachment-source-notice";
import { cfgSpeechEnabled } from "../tts/settings";
import { vocalizer } from "../tts/vocalizer";
import { describeAttachedImagesForTextModel, shouldDescribeImagesForTextModel } from "../utils/image-vision-fallback";
import type { ToolSession } from ".";
import { ToolAbortError } from "./tool-errors";
import { currentTheme } from "@oh-my-pi/pi-tui/theme/runtime";

/** Returned to a headless fork's model instead of aborting its run. */
const HEADLESS_FORK_ASK_ERROR = prompt.render(askHeadlessForkMessage);

const NO_NAMED_CONTROLS_ERROR =
	"Error: the form has no named controls. Put at least one <input>, <select> or <textarea> with a `name` attribute inside the <form>.";

const ASK_TIMED_OUT_UNANSWERED = "The ask timed out before the user answered its required fields; no answer was given.";
const INVALID_ASK_ERROR = "Error: ask takes one `html` string holding a <form>.";

// Window after the timeout deadline within which an `undefined` answer is
// attributed to a UI-enforced timeout (for surfaces that close the dialog at
// the deadline but never invoke `onTimeout`). Cancels beyond it are user Esc.
const TIMEOUT_DETECTION_TOLERANCE_MS = 1_000;

const askSchema = arkType({
	html: arkType("string").describe("one HTML <form>"),
});

export type AskParams = typeof askSchema.infer;

/**
 * The form an `ask` call asks: its `html`, a bare string, or the pre-HTML `questions` list
 * (`[{id, question, options: [{label, description?}], multi?, recommended?}]`) rebuilt as a form.
 * Also reads persisted and streamed calls for `/tree` re-answer and status lines.
 */
export function recoverAskHtml(toolCallArguments: unknown): string | undefined {
	if (typeof toolCallArguments === "string") return toolCallArguments;
	if (!isRecord(toolCallArguments)) return undefined;
	const html = toolCallArguments.html;
	if (typeof html === "string") return html;
	const questions = toolCallArguments.questions;
	return Array.isArray(questions) && questions.length > 0 ? legacyQuestionsHtml(questions) : undefined;
}

function legacyQuestionsHtml(questions: unknown[]): string | undefined {
	const fieldsets: string[] = [];
	for (const [index, item] of questions.entries()) {
		if (!isRecord(item) || typeof item.question !== "string") return undefined;
		const name = Bun.escapeHTML(typeof item.id === "string" && item.id ? item.id : `q${index + 1}`);
		const kind = item.multi === true ? "checkbox" : "radio";
		const options = Array.isArray(item.options) ? item.options : [];
		const inputs: string[] = [];
		for (const [optionIndex, option] of options.entries()) {
			const label = isRecord(option) ? option.label : option;
			if (typeof label !== "string") return undefined;
			const description =
				isRecord(option) && typeof option.description === "string"
					? ` — ${Bun.escapeHTML(option.description)}`
					: "";
			const checked = item.recommended === optionIndex ? " checked" : "";
			inputs.push(
				`<label><input type="${kind}" name="${name}" value="${Bun.escapeHTML(label)}"${checked}> ${Bun.escapeHTML(label)}${description}</label>`,
			);
		}
		const control = inputs.length > 0 ? inputs.join("") : `<textarea name="${name}"></textarea>`;
		fieldsets.push(`<fieldset><legend>${Bun.escapeHTML(item.question)}</legend>${control}</fieldset>`);
	}
	return `<form>${fieldsets.join("")}</form>`;
}

/**
 * Fieldsets whose radios each sit in a group of their own — one `name` per
 * input. HTML submits every checked radio under its own name, so a preselected
 * option returns next to the user's pick as a second answer to one question.
 * Separate questions belong in separate fieldsets, so this is an authoring slip.
 */
function splitRadioFieldsets(form: HtmlForm): { legend: string; names: string[] }[] {
	const split: { legend: string; names: string[] }[] = [];
	for (const section of form.sections) {
		if (!section.fieldset) continue;
		const names: string[] = [];
		for (const block of section.blocks) {
			if (block.kind !== "field") continue;
			const field = block.field;
			if (field.kind !== "choice" || field.multi || field.select) continue;
			if (field.name && field.options.length === 1) names.push(field.name);
		}
		if (names.length > 1) split.push({ legend: spansText(section.title), names });
	}
	return split;
}

// =============================================================================
// Field-by-field fallback
// =============================================================================

/** The dialog primitives the fallback walks a form with. */
type FallbackUI = Pick<ExtensionUIContext, "select" | "input" | "editor" | "timeoutStartsOnPresentation">;

/** One prompt's outcome: the answer, or undefined with `timedOut` telling a deadline from a cancel. */
interface PromptOutcome<T> {
	value: T | undefined;
	timedOut: boolean;
}

/** A choice field's answer: its checked option indices and, when the user chose "Other", that text. */
interface ChoiceAnswer {
	checked: Set<number>;
	other?: string;
}

/** One field's prompt text: its question and the form text around it ({@link fieldContexts}). */
interface FieldText {
	question: string;
	context: string;
}

/** Title of a field's prompt: the form context, then `line` (the question, maybe annotated). */
function promptTitle(text: FieldText, line: string): string {
	return text.context ? `${text.context}\n\n${line}` : line;
}

/** Row a radio or checkbox group's free-text "Other" answer takes in the fallback select. */
const OTHER_ROW = `${OTHER_LABEL} (type your own)`;

/**
 * Show one deadline-bound prompt. Surfaces that run the countdown report it via
 * `onTimeout`/`onTimeoutStart`/`onTimeoutReset`; for the rest a local timer
 * aborts the prompt at the deadline.
 */
async function promptWithTimeout<T>(
	ui: FallbackUI,
	timeout: number | undefined,
	signal: AbortSignal,
	show: (dialogOptions: ExtensionUIDialogOptions) => Promise<T | undefined>,
): Promise<PromptOutcome<T>> {
	let timedOut = false;
	const timeoutController = timeout === undefined ? undefined : new AbortController();
	const dialogSignal = timeoutController ? AbortSignal.any([signal, timeoutController.signal]) : signal;
	let timeoutId: NodeJS.Timeout | undefined;
	let timeoutStartedMs = Date.now();
	const armFallbackTimeout = (durationMs: number) => {
		clearTimeout(timeoutId);
		timeoutStartedMs = Date.now();
		timeoutId = setTimeout(() => {
			timedOut = true;
			timeoutController?.abort();
		}, durationMs);
	};
	const dialogOptions: ExtensionUIDialogOptions = {
		timeout,
		signal: dialogSignal,
		onTimeout: () => {
			timedOut = true;
		},
		onTimeoutStart: timeout === undefined ? undefined : () => armFallbackTimeout(timeout),
		onTimeoutReset: timeout === undefined ? undefined : () => armFallbackTimeout(timeout),
	};
	try {
		const value = await untilAborted(dialogSignal, () => {
			const shown = show(dialogOptions);
			if (timeout !== undefined && !ui.timeoutStartsOnPresentation) armFallbackTimeout(timeout);
			return shown;
		});
		if (!timedOut && value === undefined && timeout !== undefined) {
			// Fallback for surfaces that enforce `timeout` without invoking
			// `onTimeout`: their auto-cancel resolves right at the deadline. A
			// cancel arriving well past it is a deliberate user Esc.
			const elapsed = Date.now() - timeoutStartedMs;
			timedOut = elapsed >= timeout && elapsed <= timeout + TIMEOUT_DETECTION_TOLERANCE_MS;
		}
		return { value, timedOut };
	} catch (error) {
		if (timedOut && error instanceof Error && error.name === "AbortError")
			return { value: undefined, timedOut: true };
		throw error;
	} finally {
		clearTimeout(timeoutId);
	}
}

/**
 * Checked option indices for a choice field. Radios and single selects take
 * one pick, opening on the preselected option; checkbox groups, lone
 * checkboxes and multi-selects toggle rows until a Done row. Radio and
 * checkbox groups end with an "Other" row that asks for free text; a blank
 * or cancelled answer returns to the options.
 */
async function askChoice(
	ui: FallbackUI,
	field: ChoiceField,
	text: FieldText,
	timeout: number | undefined,
	signal: AbortSignal,
): Promise<PromptOutcome<ChoiceAnswer>> {
	const { question } = text;
	// The options the user can pick, by index, with one-line labels.
	const options = field.options.flatMap((option, index) =>
		option.disabled ? [] : [{ index, label: spansText(option.label).replace(/\s+/g, " ").trim() || option.value }],
	);
	const labels = disambiguateDisplayLabels(
		options.map(option => option.label),
		[],
	);
	const preselected = new Set(field.options.flatMap((option, index) => (option.checked ? [index] : [])));
	const helpText = `${actionKey("tui.select.up")}/${actionKey("tui.select.down")} navigate  ${formatKeyHint("enter")} select  ${actionKey("tui.select.cancel")} cancel`;
	const otherRow = field.other ? disambiguateDisplayLabels([OTHER_ROW], labels)[0] : undefined;
	const choiceRows = otherRow === undefined ? labels : [...labels, otherRow];

	if (!field.multi) {
		let initialIndex = Math.max(
			0,
			options.findIndex(option => preselected.has(option.index)),
		);
		while (true) {
			const outcome = await promptWithTimeout(ui, timeout, signal, dialogOptions =>
				ui.select(promptTitle(text, question), choiceRows, {
					...dialogOptions,
					initialIndex,
					outline: true,
					helpText,
					selectionMarker: "radio",
				}),
			);
			if (otherRow !== undefined && outcome.value === otherRow) {
				const typed = await promptWithTimeout(ui, timeout, signal, dialogOptions =>
					ui.input(promptTitle(text, question), undefined, dialogOptions),
				);
				if (typed.timedOut) return { value: undefined, timedOut: true };
				initialIndex = labels.length;
				if (!typed.value?.trim()) continue;
				return { value: { checked: new Set(), other: typed.value }, timedOut: false };
			}
			const picked = outcome.value === undefined ? -1 : labels.indexOf(outcome.value);
			const option = options[picked];
			return { value: option ? { checked: new Set([option.index]) } : undefined, timedOut: outcome.timedOut };
		}
	}

	const doneLabel = disambiguateDisplayLabels(
		[`${currentTheme().symbols.symbol("status.success")} Done selecting`],
		choiceRows,
	)[0]!;
	const checked = new Set(preselected);
	let other: string | undefined;
	let cursor = Math.max(
		0,
		options.findIndex(option => checked.has(option.index)),
	);
	while (true) {
		const answered = checked.size + (other === undefined ? 0 : 1);
		const canFinish = !field.required || answered > 0;
		const rows: ExtensionUISelectItem[] = canFinish ? [...choiceRows, doneLabel] : [...choiceRows];
		const checkedIndices = options.flatMap((option, row) => (checked.has(option.index) ? [row] : []));
		if (other !== undefined) checkedIndices.push(labels.length);
		const prefix = answered > 0 ? `(${answered} selected) ` : "";
		const outcome = await promptWithTimeout(ui, timeout, signal, dialogOptions =>
			ui.select(promptTitle(text, `${prefix}${question}`), rows, {
				...dialogOptions,
				initialIndex: cursor,
				outline: true,
				helpText,
				selectionMarker: "checkbox",
				checkedIndices,
				markableCount: choiceRows.length,
			}),
		);
		// A deadline keeps whatever the user had checked so far.
		if (outcome.timedOut) return { value: { checked, other }, timedOut: true };
		if (outcome.value === undefined) return { value: undefined, timedOut: false };
		if (outcome.value === doneLabel) return { value: { checked, other }, timedOut: false };
		if (otherRow !== undefined && outcome.value === otherRow) {
			cursor = labels.length;
			if (other !== undefined) {
				other = undefined;
				continue;
			}
			const typed = await promptWithTimeout(ui, timeout, signal, dialogOptions =>
				ui.input(promptTitle(text, question), undefined, dialogOptions),
			);
			if (typed.timedOut) return { value: { checked }, timedOut: true };
			// A blank or cancelled answer leaves Other unchecked.
			if (typed.value?.trim()) other = typed.value;
			continue;
		}
		const row = labels.indexOf(outcome.value);
		const option = options[row];
		if (!option) continue;
		cursor = row;
		if (checked.has(option.index)) checked.delete(option.index);
		else checked.add(option.index);
	}
}

/**
 * Text for a text field, re-asking with the validation error until it is
 * valid. Textareas and prefilled inputs open the editor on their current
 * value (a re-ask keeps the rejected text); empty inputs prompt with their
 * placeholder.
 */
async function askText(
	ui: FallbackUI,
	field: TextField,
	text: FieldText,
	timeout: number | undefined,
	signal: AbortSignal,
): Promise<PromptOutcome<string>> {
	const useEditor = field.multiline || field.value !== "";
	let error: string | undefined;
	let current = field.value;
	while (true) {
		const title = promptTitle(text, error ? `${text.question} (${error})` : text.question);
		let outcome: PromptOutcome<string>;
		if (useEditor) {
			// The editor has no countdown: typing a long answer must not race a deadline.
			const prefill = current;
			const value = await untilAborted(signal, () =>
				ui.editor(title, prefill, { signal }, field.multiline ? undefined : { promptStyle: true }),
			);
			outcome = { value, timedOut: false };
		} else {
			outcome = await promptWithTimeout(ui, timeout, signal, dialogOptions =>
				ui.input(title, field.placeholder || undefined, dialogOptions),
			);
		}
		if (outcome.value === undefined) return outcome;
		error = fieldError(field, outcome.value);
		if (!error) return outcome;
		current = outcome.value;
	}
}

/**
 * Walk the form's named fields in order. Undefined when the user cancels; a
 * deadline stops the walk and leaves the remaining fields at their defaults.
 */
async function askFieldByField(
	ui: FallbackUI,
	form: HtmlForm,
	timeout: number | undefined,
	signal: AbortSignal,
): Promise<{ data: HtmlFormData; timedOut: boolean } | undefined> {
	const data = defaultFormData(form);
	const questions = fieldQuestions(form);
	const contexts = fieldContexts(form);
	for (const field of form.fields) {
		if (!field.name) continue;
		const text = { question: questions.get(field) ?? field.name, context: contexts.get(field) ?? "" };
		if (field.kind === "choice") {
			const outcome = await askChoice(ui, field, text, timeout, signal);
			if (outcome.value !== undefined) {
				const value = choiceValue(field, outcome.value.checked, outcome.value.other);
				if (value === undefined) delete data[field.name];
				else data[field.name] = value;
			}
			if (outcome.timedOut) return { data, timedOut: true };
			if (outcome.value === undefined) return undefined;
			continue;
		}
		const outcome = await askText(ui, field, text, timeout, signal);
		if (outcome.timedOut) return { data, timedOut: true };
		if (outcome.value === undefined) return undefined;
		data[field.name] = textValue(field, outcome.value);
	}
	return { data, timedOut: false };
}

// =============================================================================
// Extension answers
// =============================================================================

/** The form's named controls as `ask_requested` reports them. */
function askFieldSummaries(form: HtmlForm, questions: Map<FormField, string>): AskFieldSummary[] {
	return form.fields.flatMap((field): AskFieldSummary[] => {
		if (!field.name) return [];
		const question = questions.get(field) ?? field.name;
		if (field.kind === "text") {
			return [
				{
					name: field.name,
					kind: "text",
					question,
					required: field.required,
					type: field.type,
					value: field.value,
				},
			];
		}
		return [
			{
				name: field.name,
				kind: "choice",
				question,
				required: field.required,
				multi: isArrayChoice(field),
				other: field.other,
				options: field.options.map(option => ({
					value: option.value,
					label: spansText(option.label).replace(/\s+/g, " ").trim() || option.value,
					disabled: option.disabled,
				})),
			},
		];
	});
}

/** A choice field's value from an extension, or `undefined` when the field cannot take it. */
function extensionChoiceValue(field: ChoiceField, value: unknown): HtmlFormValue | undefined {
	const enabled = new Set(field.options.flatMap(option => (option.disabled ? [] : [option.value])));
	const all = new Set(field.options.map(option => option.value));
	// "Other" text: one answer outside the options, when the field offers it.
	const fits = (values: string[]): boolean =>
		values.filter(item => !enabled.has(item)).every(item => field.other && !all.has(item) && item.trim() !== "") &&
		values.filter(item => !enabled.has(item)).length <= 1;
	if (isArrayChoice(field)) {
		if (!Array.isArray(value) || !value.every(item => typeof item === "string")) return undefined;
		const values = [...new Set(value)];
		return fits(values) ? values : undefined;
	}
	// A lone checkbox submits a string when checked and nothing when not: `[]` unchecks it (even a
	// preselected one, as the dialog can), and `[value]` checks it like `value`.
	if (field.multi && Array.isArray(value)) {
		if (value.length === 0) return [];
		if (value.length !== 1) return undefined;
		value = value[0];
	}
	if (typeof value !== "string") return undefined;
	return fits([value]) ? value : undefined;
}

/**
 * The data `form` submits for an extension's answer: its defaults with `data`'s fields applied.
 * `undefined` when `data` names no such field, gives a value the field cannot take, or leaves the
 * form invalid (a required field empty, failed text validation).
 */
function extensionFormData(form: HtmlForm, data: Record<string, unknown>): HtmlFormData | undefined {
	const submitted = defaultFormData(form);
	const named = new Map(form.fields.flatMap(field => (field.name ? [[field.name, field] as const] : [])));
	for (const [name, value] of Object.entries(data)) {
		const field = named.get(name);
		if (!field) return undefined;
		if (field.kind === "choice") {
			const choice = extensionChoiceValue(field, value);
			if (choice === undefined) return undefined;
			if (Array.isArray(choice) && choice.length === 0) delete submitted[name];
			else submitted[name] = choice;
			continue;
		}
		if (typeof value !== "string" && typeof value !== "number") return undefined;
		submitted[name] = textValue(field, String(value));
	}
	for (const field of named.values()) {
		if (fieldError(field, submitted[field.name]) !== undefined) return undefined;
	}
	return submitted;
}

// =============================================================================
// Tool Class
// =============================================================================

/** Asks the user to fill in one HTML form and returns the submitted form data. */
export class AskTool implements AgentTool<typeof askSchema, AskToolDetails> {
	readonly name = "ask";
	readonly approval = "read" as const;
	readonly label = "Ask";
	readonly summary = "Ask the user to fill in a form";
	readonly parameters = askSchema;
	readonly strict = true;
	// Raw args reach execute() on schema failure, so a bare string or a legacy `questions` list still asks.
	readonly lenientArgValidation = true;

	// Run alone in its tool batch. The interactive dialog is a single shared UI
	// surface (`ExtensionUiController` has no queue and overwrites the active
	// dialog on each call), so two concurrent `ask` calls would clobber each
	// other: the second steals focus and orphans the first, whose promise then
	// hangs until the user aborts the whole turn.
	readonly concurrency = "exclusive";
	readonly loadMode = "discoverable";

	constructor(private readonly session: ToolSession) {}

	readonly description = prompt.render(askDescription);

	static createIf(session: ToolSession): AskTool | null {
		return (session.canPromptUser ?? session.hasUI) || session.advertiseHeadlessAsk ? new AskTool(session) : null;
	}

	/** Send terminal notification when ask tool is waiting for input */
	#sendAskNotification(): void {
		if (!this.session.hasUI) return;
		const method = cfgAskNotify.get(this.session.settings);
		if (method === "off") return;
		notifyTerminal({
			title: "omp",
			body: "Waiting for input",
			type: "ask",
			urgency: "normal",
			actions: "focus",
		});
	}

	async #answerImageBlocks(
		images: ImageContent[],
		signal: AbortSignal | undefined,
	): Promise<Array<TextContent | ImageContent>> {
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
						usageLedger: this.session.sessionManager,
					},
					signal,
				);
			} catch (error) {
				logger.warn("ask answer image description failed; image left undescribed", {
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
		const blocks: Array<TextContent | ImageContent> = [];
		for (const [index, image] of images.entries()) {
			const notice = renderAttachmentSourceNotice(image, index + 1, { askAnswer: true });
			if (notice) blocks.push({ type: "text", text: notice.content });
			blocks.push({ type: "image", data: image.data, mimeType: image.mimeType });
			const description = descriptions?.[index];
			if (description) blocks.push(description);
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

		const html = recoverAskHtml(params);
		if (html === undefined) {
			return { content: [{ type: "text", text: INVALID_ASK_ERROR }], details: { answers: [] }, isError: true };
		}
		const form = parseHtmlForm(html);
		const questions = fieldQuestions(form);
		const named = form.fields.filter(field => field.name);
		if (named.length === 0) {
			return { content: [{ type: "text", text: NO_NAMED_CONTROLS_ERROR }], details: { answers: [] } };
		}
		const splitRadios = splitRadioFieldsets(form);
		if (splitRadios.length > 0) {
			return {
				content: [{ type: "text", text: prompt.render(askSplitRadioGroupsTemplate, { fieldsets: splitRadios }) }],
				details: { answers: [] },
			};
		}

		const extensionUi = context.ui;

		// Determine timeout based on settings and plan mode
		const planModeEnabled = this.session.getPlanModeState?.()?.enabled ?? false;
		const timeout = planModeEnabled ? undefined : askTimeoutMs(this.session.settings);
		// A message the user queues closes the dialog without cancelling the turn: they moved on, and the
		// message reaches the agent at the batch boundary. Peer IRC, asides and finished background jobs are
		// not the user's answer, so the dialog stays open for it.
		const steeringSignal = context.toolCall?.steeringSignal;
		const userSteering = new AbortController();
		const onSteer = () => {
			if (steeringSignal?.reason === "user") userSteering.abort();
		};
		if (steeringSignal?.aborted) onSteer();
		else steeringSignal?.addEventListener("abort", onSteer, { once: true });
		const dialogSignal = signal ? AbortSignal.any([signal, userSteering.signal]) : userSteering.signal;
		// What the user answered before a message closed the form; the model gets it with the interruption.
		let given: ExtensionFormDialogResult | undefined;
		const abortError = (): ToolAbortError => {
			if (!userSteering.signal.aborted) return new ToolAbortError("Ask input was cancelled");
			if (!given) return new ToolAbortError("Ask interrupted by message");
			const notes = given.notes?.map(({ images: _images, ...note }) => ({
				...note,
				text: note.text.replace(/\s+/g, " ").trim(),
			}));
			return new ToolAbortError(
				prompt.render(askResultTemplate, {
					interrupted: true,
					json: JSON.stringify(given.data, null, 2),
					notes: notes?.length ? notes : undefined,
				}),
			);
		};
		const cancelAsk = (): never => {
			if (userSteering.signal.aborted) throw abortError();
			context.abort();
			throw new ToolAbortError("Ask tool was cancelled by the user");
		};

		// Send notification if waiting and not suppressed
		this.#sendAskNotification();

		// Speak the questions aloud before surfacing them. Ask vocalizes in every
		// mode — it's the assistant addressing the user — gated only by speech.enabled
		// (the vocalizer re-checks the setting and no-ops when disabled).
		if (cfgSpeechEnabled.get(this.session.settings)) {
			vocalizer.speak(named.map(field => questions.get(field) ?? field.name).join("\n"));
		}

		// Extensions may answer the form too; the first answer wins and closes the other.
		const sessionId = this.session.getSessionId?.() ?? "";
		// Provider tool call ids can repeat across concurrent loops sharing the runner; the form's own id cannot.
		const askId = crypto.randomUUID();
		let pending: PendingPrompt<ExtensionAskAnswer> | undefined;
		let by: "user" | "extension" = "user";
		let answered: { data: HtmlFormData; notes?: OptionNote[]; timedOut?: boolean } | undefined;
		try {
			// Rejects at once when the call is aborted or a message interrupts it while handlers still run.
			pending = await context.extensionAsk?.open(
				{
					type: "ask_requested",
					sessionId,
					askId,
					toolCallId,
					html,
					fields: askFieldSummaries(form, questions),
				},
				data => extensionFormData(form, data),
				dialogSignal,
			);
			const early = pending?.given();
			if (early !== undefined) {
				// Cancelled or interrupted while a handler ran: take that path, not the late answer.
				if (dialogSignal.aborted) throw abortError();
				by = "extension";
				extensionUi.notify("Question answered by extension", "info");
				answered = early === "cancel" ? undefined : { data: early.data };
			} else {
				const extensionClose = new AbortController();
				const formSignal = AbortSignal.any([dialogSignal, extensionClose.signal]);
				const fromUser = (async () => {
					if (extensionUi.formDialog) {
						const formDialog = extensionUi.formDialog.bind(extensionUi);
						return untilAborted(formSignal, () =>
							formDialog(html, {
								timeout,
								signal: formSignal,
								acceptImages: true,
								onAbandon: partial => {
									given = partial;
								},
							}),
						);
					}
					return askFieldByField(extensionUi, form, timeout, formSignal);
				})().then(value => ({ by: "user" as const, value }));
				const fromExtension = pending?.answer.then(value => ({ by: "extension" as const, value }));
				const first = await (fromExtension ? Promise.race([fromUser, fromExtension]) : fromUser);
				if (first.by === "extension") {
					extensionClose.abort();
					// The closed dialog settles (cancel or abort) with nobody to read it.
					fromUser.catch(() => {});
					if (dialogSignal.aborted) throw abortError();
					by = "extension";
					extensionUi.notify("Question answered by extension", "info");
					answered = first.value === "cancel" ? undefined : { data: first.value.data };
				} else {
					answered = first.value;
				}
			}
		} catch (error) {
			if (error instanceof Error && error.name === "AbortError") throw abortError();
			throw error;
		} finally {
			pending?.close();
			const settled = answered;
			const reported = context.extensionAsk?.resolved({
				type: "ask_resolved",
				sessionId,
				askId,
				toolCallId,
				// A timeout is never an answer, even when it submits valid values the form already held.
				answered: settled !== undefined && !settled.timedOut,
				by,
			});
			// Handlers are awaited, but an abort or interrupting message does not wait on them: they finish
			// in the background while the ask takes its abort path below.
			if (reported) {
				await untilAborted(dialogSignal, reported).catch(error => {
					if (!dialogSignal.aborted) throw error;
				});
			}
		}
		// `ask_resolved` handlers are awaited: an abort or interrupting message during them wins over the answer.
		if (dialogSignal.aborted) throw abortError();
		if (!answered) return cancelAsk();
		// A timeout submits what the form holds; with a required field still empty that is no answer, not data.
		if (answered.timedOut && named.some(field => fieldError(field, answered.data[field.name!]) !== undefined)) {
			return {
				content: [{ type: "text", text: ASK_TIMED_OUT_UNANSWERED }],
				details: { answers: [], timedOut: true },
			};
		}

		const notes = answered.notes?.length ? answered.notes : undefined;
		// Each note numbers its markers from 1; shift them so `[Image #N]` indexes all result images.
		const answerImages: ImageContent[] = [];
		const resultNotes: OptionNote[] = [];
		for (const { images, ...note } of notes ?? []) {
			resultNotes.push({ ...note, text: shiftImageMarkers(note.text, answerImages.length, images?.length ?? 0) });
			if (images) answerImages.push(...images);
		}
		const details: AskToolDetails = {
			answers: formAnswers(form, answered.data),
			...(notes ? { notes: resultNotes } : {}),
			...(answered.timedOut ? { timedOut: true } : {}),
		};
		const text = prompt.render(askResultTemplate, {
			timedOut: answered.timedOut,
			json: JSON.stringify(answered.data, null, 2),
			notes: notes && resultNotes.map(note => ({ ...note, text: note.text.replace(/\s+/g, " ").trim() })),
		});
		const imageBlocks = await this.#answerImageBlocks(answerImages, signal);
		return { content: [{ type: "text", text }, ...imageBlocks], details };
	}
}
