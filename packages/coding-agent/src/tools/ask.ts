/**
 * Ask Tool - the model asks the user to fill in one HTML `<form>`.
 *
 * Hosts with a form surface (`ui.formDialog`: the interactive TUI, ACP) render
 * the form whole; every other host walks its named fields one prompt at a time
 * through `select`/`input`/`editor`. The model receives the submitted form data
 * as JSON. Outside plan mode a configurable timeout submits the form's
 * preselected values.
 */

import { type as arkType } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import type { ToolExample } from "@oh-my-pi/pi-ai";
import { TERMINAL } from "@oh-my-pi/pi-tui";
import { formatKeyHint } from "@oh-my-pi/pi-tui/app-keybindings";
import { editorKey, editorKeys } from "@oh-my-pi/pi-tui/chrome/keybinding-hints";
import {
	choiceValue,
	defaultFormData,
	fieldQuestions,
	fieldError,
	formAnswers,
	type HtmlFormData,
	OTHER_LABEL,
	textValue,
} from "@oh-my-pi/pi-tui/html-form/data";
import {
	type ChoiceField,
	type HtmlForm,
	parseHtmlForm,
	spansText,
	type TextField,
} from "@oh-my-pi/pi-tui/html-form/parse";
import { disambiguateDisplayLabels } from "@oh-my-pi/pi-tui/render/render-utils";
import { theme } from "@oh-my-pi/pi-tui/theme";
import type { AskToolDetails } from "@oh-my-pi/pi-tui/tools/ask";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { isRecord, prompt, untilAborted } from "@oh-my-pi/pi-utils";
import type { ExtensionUIContext, ExtensionUIDialogOptions, ExtensionUISelectItem } from "../extensibility/extensions";
import { askTimeoutMs, cfgAskNotify } from "../modes/settings";
import askDescription from "../prompts/tools/ask.md" with { type: "text" };
import askHeadlessForkMessage from "../prompts/tools/ask-headless-fork.md" with { type: "text" };
import { cfgSpeechEnabled } from "../tts/settings";
import { vocalizer } from "../tts/vocalizer";
import type { ToolSession } from ".";
import { ToolAbortError } from "./tool-errors";

/** Returned to a headless fork's model instead of aborting its run. */
const HEADLESS_FORK_ASK_ERROR = prompt.render(askHeadlessForkMessage);

const NO_NAMED_CONTROLS_ERROR =
	"Error: the form has no named controls. Put at least one <input>, <select> or <textarea> with a `name` attribute inside the <form>.";

// Window after the timeout deadline within which an `undefined` answer is
// attributed to a UI-enforced timeout (for surfaces that close the dialog at
// the deadline but never invoke `onTimeout`). Cancels beyond it are user Esc.
const TIMEOUT_DETECTION_TOLERANCE_MS = 1_000;

const askSchema = arkType({
	html: arkType("string").describe("one HTML <form>"),
});

export type AskParams = typeof askSchema.infer;

/** The `html` of a persisted or streamed `ask` call, for `/tree` re-answer and status lines. */
export function recoverAskHtml(toolCallArguments: unknown): string | undefined {
	if (!isRecord(toolCallArguments)) return undefined;
	const html = toolCallArguments.html;
	return typeof html === "string" ? html : undefined;
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
	question: string,
	timeout: number | undefined,
	signal: AbortSignal,
): Promise<PromptOutcome<ChoiceAnswer>> {
	// The options the user can pick, by index, with one-line labels.
	const options = field.options.flatMap((option, index) =>
		option.disabled ? [] : [{ index, label: spansText(option.label).replace(/\s+/g, " ").trim() || option.value }],
	);
	const labels = disambiguateDisplayLabels(
		options.map(option => option.label),
		[],
	);
	const preselected = new Set(field.options.flatMap((option, index) => (option.checked ? [index] : [])));
	const helpText = `${editorKeys("tui.select.up", "tui.select.down")} navigate  ${formatKeyHint("enter")} select  ${editorKey("tui.select.cancel")} cancel`;
	const otherRow = field.other ? disambiguateDisplayLabels([OTHER_ROW], labels)[0] : undefined;
	const choiceRows = otherRow === undefined ? labels : [...labels, otherRow];

	if (!field.multi) {
		let initialIndex = Math.max(
			0,
			options.findIndex(option => preselected.has(option.index)),
		);
		while (true) {
			const outcome = await promptWithTimeout(ui, timeout, signal, dialogOptions =>
				ui.select(question, choiceRows, {
					...dialogOptions,
					initialIndex,
					outline: true,
					helpText,
					selectionMarker: "radio",
				}),
			);
			if (otherRow !== undefined && outcome.value === otherRow) {
				const typed = await promptWithTimeout(ui, timeout, signal, dialogOptions =>
					ui.input(question, undefined, dialogOptions),
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

	const doneLabel = disambiguateDisplayLabels([`${theme.status.success} Done selecting`], choiceRows)[0]!;
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
			ui.select(`${prefix}${question}`, rows, {
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
				ui.input(question, undefined, dialogOptions),
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
	question: string,
	timeout: number | undefined,
	signal: AbortSignal,
): Promise<PromptOutcome<string>> {
	const useEditor = field.multiline || field.value !== "";
	let error: string | undefined;
	let current = field.value;
	while (true) {
		const title = error ? `${question} (${error})` : question;
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
export async function askFieldByField(
	ui: FallbackUI,
	form: HtmlForm,
	timeout: number | undefined,
	signal: AbortSignal,
): Promise<{ data: HtmlFormData; timedOut: boolean } | undefined> {
	const data = defaultFormData(form);
	const questions = fieldQuestions(form);
	for (const field of form.fields) {
		if (!field.name) continue;
		const question = questions.get(field) ?? field.name;
		if (field.kind === "choice") {
			const outcome = await askChoice(ui, field, question, timeout, signal);
			if (outcome.value !== undefined) {
				const value = choiceValue(field, outcome.value.checked, outcome.value.other);
				if (value === undefined) delete data[field.name];
				else data[field.name] = value;
			}
			if (outcome.timedOut) return { data, timedOut: true };
			if (outcome.value === undefined) return undefined;
			continue;
		}
		const outcome = await askText(ui, field, question, timeout, signal);
		if (outcome.timedOut) return { data, timedOut: true };
		if (outcome.value === undefined) return undefined;
		data[field.name] = textValue(field, outcome.value);
	}
	return { data, timedOut: false };
}

// =============================================================================
// Tool Class
// =============================================================================

const EXAMPLE_FORM = `<form>
  <p>Sessions live in memory and are lost on restart.</p>
  <fieldset>
    <legend>Session store</legend>
    <label><input type="radio" name="store" value="sqlite" checked> SQLite: one file, no new service</label>
    <label><input type="radio" name="store" value="redis"> Redis: shared across instances, needs ops</label>
  </fieldset>
  <label>Session lifetime (days) <input type="number" name="ttl_days" value="30" min="1"></label>
</form>`;

/** Asks the user to fill in one HTML form and returns the submitted form data. */
export class AskTool implements AgentTool<typeof askSchema, AskToolDetails> {
	readonly name = "ask";
	readonly approval = "read" as const;
	readonly label = "Ask";
	readonly summary = "Ask the user to fill in a form";
	readonly description: string;
	readonly parameters = askSchema;
	readonly strict = true;

	readonly examples: readonly ToolExample<typeof askSchema.infer>[] = [
		{ caption: "Choice with context and a number", call: { html: EXAMPLE_FORM } },
	];
	// Run alone in its tool batch. The interactive dialog is a single shared UI
	// surface (`ExtensionUiController` has no queue and overwrites the active
	// dialog on each call), so two concurrent `ask` calls would clobber each
	// other: the second steals focus and orphans the first, whose promise then
	// hangs until the user aborts the whole turn.
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

	async execute(
		_toolCallId: string,
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

		const form = parseHtmlForm(params.html);
		const questions = fieldQuestions(form);
		const named = form.fields.filter(field => field.name);
		if (named.length === 0) {
			return { content: [{ type: "text", text: NO_NAMED_CONTROLS_ERROR }], details: { answers: [] } };
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
		const abortError = (): ToolAbortError =>
			new ToolAbortError(userSteering.signal.aborted ? "Ask interrupted by message" : "Ask input was cancelled");
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

		let answered: { data: HtmlFormData; timedOut?: boolean } | undefined;
		try {
			if (extensionUi.formDialog) {
				const formDialog = extensionUi.formDialog.bind(extensionUi);
				answered = await untilAborted(dialogSignal, () =>
					formDialog(params.html, { timeout, signal: dialogSignal }),
				);
			} else {
				answered = await askFieldByField(extensionUi, form, timeout, dialogSignal);
			}
		} catch (error) {
			if (error instanceof Error && error.name === "AbortError") throw abortError();
			throw error;
		}
		if (!answered) return cancelAsk();

		const json = JSON.stringify(answered.data, null, 2);
		const details: AskToolDetails = { answers: formAnswers(form, answered.data) };
		if (answered.timedOut) {
			details.timedOut = true;
			return {
				content: [
					{ type: "text", text: `No answer before the timeout; submitted the form's current values:\n${json}` },
				],
				details,
			};
		}
		return { content: [{ type: "text", text: `User answers:\n${json}` }], details };
	}
}
