/**
 * Tool-approval prompt in the composer's place, presented like the ask
 * dialog: the approval title and its details over the answers. The answers are
 * chosen with the arrows and confirmed with Enter — no key approves a call
 * outright, so an Enter typed for the composer as the prompt appears never
 * answers it; that confirm only arms {@link APPROVE_ARM_MS} after mount, when
 * it is also the follow-up key, pressed mid-run exactly when prompts appear.
 * Esc denies. With an {@link ApprovalDialogDraft}, every other key edits the
 * composer mounted beneath the dialog, so a message can steer the turn while
 * the call waits; an empty composer ignores Enter and the arrows scroll the
 * details. Tern's native surface shows the answers as clickable buttons
 * instead. The prompt stays a few rows so the composer keeps its room; with a
 * full prompt, the expand key (`app.tools.expand`) swaps it in, wrapped.
 */
import { type Component, Ellipsis, ScrollView, type TUI, truncateToWidth, wrapTextWithAnsi } from "../index";
import { formatKeyHint, formatKeyHints, formatTooltipKey } from "../app-keybindings";
import { OverlayPanel, PanelDivider, PanelRows } from "../chrome/overlay-box";
import { editorKey, editorKeys } from "../chrome/keybinding-hints";
import { getKeybindings } from "../keybindings";
import { isNativeRendering } from "../native/state";
import {
	appToolsExpandKey,
	matchesAppToolsExpand,
	matchesSelectCancel,
	matchesSelectDown,
	matchesSelectPageDown,
	matchesSelectPageUp,
	matchesSelectUp,
} from "../keybinding-matchers";
import { col, node } from "../native/describe";
import type { NativeNode, NativeUiEvent } from "../native/node";
import { actionBar, actionButton } from "../native/overlay";
import { PREVIEW_LIMITS, sanitizeDisplayLines } from "../render/render-utils";
import { theme } from "../theme/theme";
import { CountdownTimer } from "../chrome/countdown-timer";

/** Detail rows shown before the rest scrolls, so the composer beneath keeps its room. */
const MAX_DETAIL_ROWS: number = PREVIEW_LIMITS.COLLAPSED_ITEMS;
/** The approve key is ignored this long after mount, so a follow-up sent as the prompt appears cannot approve it. */
export const APPROVE_ARM_MS = 500;

interface ApprovalDialogCallbacks {
	/** The exact answer; `always` is the remember checkbox as it stood when the answer was given. */
	onApprove(always: boolean): void;
	/** The directory answer; only reachable when the dialog was given a folder label. */
	onApproveFolder?(always: boolean): void;
	/** The tool answer; a by-name grant for this session, so the remember checkbox never applies. */
	onApproveTool?(): void;
	/** The approve-once answer; it records nothing, so the remember checkbox never applies. */
	onApproveOnce?(): void;
	onDeny(): void;
}

/** The answers the dock's menu can offer, in display order. */
type ApprovalDialogAnswerId = "remember" | "folder" | "tool" | "approve" | "once" | "deny";

/** The remember checkbox's text names the mode it currently holds. */
function approvalDialogRememberLabel(always: boolean): string {
	const glyph = always ? theme.checkbox.checked : theme.checkbox.unchecked;
	return `${glyph} Remember: ${always ? "Always" : "This Session"}`;
}

/** Whether the prompt has a grant to record at all; without one the remember checkbox is pointless. */
function approvalDialogCanRemember(options: ApprovalDialogOptions): boolean {
	return options.exactGrant === true || options.folderLabel !== undefined;
}

/**
 * Whether the exact answer applies at all: hosts that omit {@link ApprovalDialogOptions.exactAnswer}
 * keep it for every exact grant, as they did before the field existed.
 */
function approvalDialogExactAnswer(options: ApprovalDialogOptions): boolean {
	return options.exactAnswer ?? options.exactGrant === true;
}

/**
 * Whether the prompt offers any grant answer. "Approve Once" accompanies them, and stands in for
 * the plain answer when there is no exact target — that answer would record just as little.
 */
function approvalDialogOffersGrants(options: ApprovalDialogOptions): boolean {
	return approvalDialogCanRemember(options) || options.toolName !== undefined;
}

/**
 * Menu rows: the remember checkbox leads (it changes what the answers record), then the answers
 * themselves — the directory one when the call has a folder to grant, the by-name tool one when
 * the call proposes a tool, the exact one when the call records a target, the once-only one
 * wherever grants are offered, and Deny.
 */
function approvalDialogAnswers(
	options: ApprovalDialogOptions,
	rememberAlways: boolean,
): readonly { id: ApprovalDialogAnswerId; label: string }[] {
	const answers: { id: ApprovalDialogAnswerId; label: string }[] = [];
	if (approvalDialogCanRemember(options)) {
		answers.push({ id: "remember", label: approvalDialogRememberLabel(rememberAlways) });
	}
	if (options.folderLabel !== undefined) {
		answers.push({ id: "folder", label: `Approve Directory (${options.folderLabel})` });
	}
	if (options.toolName !== undefined) {
		answers.push({ id: "tool", label: `Approve ${options.toolName} for session` });
	}
	if (approvalDialogExactAnswer(options)) {
		answers.push({ id: "approve", label: options.fileTarget === false ? "Approve" : "Approve File" });
	} else if (!approvalDialogOffersGrants(options)) {
		// A prompt with nothing to record (a forced policy or safety check) keeps the plain answer.
		answers.push({ id: "approve", label: "Approve" });
	}
	if (approvalDialogOffersGrants(options)) {
		answers.push({ id: "once", label: "Approve Once" });
	}
	answers.push({ id: "deny", label: "Deny" });
	return answers;
}

/** The composer mounted beneath the dialog: it receives every key the dialog does not own. */
export interface ApprovalDialogDraft {
	/** True while the composer holds a draft — text, attachments, or a paste still landing: keys then edit and send it. */
	hasDraft(): boolean;
	handleInput(keyData: string): void;
}

interface ApprovalDialogOptions {
	tui?: TUI;
	/** The prompt with every detail in full, which the expand key swaps in (wrapped) for the summarized one. */
	fullPrompt?: string;
	/** Directory the directory answers grant; enables them (keys and buttons) when set. */
	folderLabel?: string;
	/** Whether the call can be remembered by file, which adds the exact answer and the checkbox. */
	exactGrant?: boolean;
	/** Tool the prompt proposes (a command or another non-read/write call); adds the by-name session answer. */
	toolName?: string;
	/** Whether the exact grant names files; `false` keeps the plain `Approve` (a directory or URL target). */
	fileTarget?: boolean;
	/** Whether the exact answer applies; a directory-only call answers through the folder label instead. */
	exactAnswer?: boolean;
	/** Deny once this many ms pass without input (any key restarts the countdown). */
	timeout?: number;
	/** Called when {@link timeout} expires, before the dialog denies. */
	onTimeout?: () => void;
	/** Called when the countdown starts, as the dialog mounts. */
	onTimeoutStart?: () => void;
	/** Called each time a key restarts the countdown. */
	onTimeoutReset?: () => void;
	/** Route typing to the composer instead of dropping it. */
	draft?: ApprovalDialogDraft;
}

/** A prompt's detail rows: every line after the title, trailing blanks dropped. */
function promptDetails(lines: string[]): string[] {
	const details = lines.slice(1);
	while (details.length > 0 && details[details.length - 1]!.trim() === "") details.pop();
	return details;
}

export class ApprovalDialogComponent implements Component {
	readonly #title: string;
	readonly #summary: readonly string[];
	readonly #full: readonly string[] | undefined;
	#expanded = false;
	/** Body width of the last render, or `undefined` before the first one. */
	#renderedWidth: number | undefined;
	readonly #panel: OverlayPanel;
	readonly #body = new PanelRows();
	readonly #choices = new PanelRows();
	readonly #footer = new PanelRows();
	/** Answers shown as a navigable menu; index 0 is highlighted on mount. */
	#answers: readonly { id: ApprovalDialogAnswerId; label: string }[] = [];
	#selected = 0;
	/** The remember checkbox: off keeps grants in this instance, on writes them for every session. */
	#rememberAlways = false;
	#scrollOffset = 0;
	#bodyRows = MAX_DETAIL_ROWS;
	#closed = false;
	#native: NativeNode | undefined;
	readonly #armedAt = performance.now() + APPROVE_ARM_MS;
	readonly #countdown: CountdownTimer | undefined;

	/** `prompt`: the approval title on its first line, the details after it. */
	constructor(
		prompt: string,
		private readonly callbacks: ApprovalDialogCallbacks,
		private readonly options: ApprovalDialogOptions = {},
	) {
		const lines = sanitizeDisplayLines(prompt);
		const title = lines[0] ?? "";
		this.#title = title;
		this.#summary = promptDetails(lines);
		this.#full =
			options.fullPrompt === undefined ? undefined : promptDetails(sanitizeDisplayLines(options.fullPrompt));
		this.#panel = new OverlayPanel(title, "omp.overlay.approval");
		this.#answers = approvalDialogAnswers(options, this.#rememberAlways);
		this.#footer.setHeight(1);
		this.#panel.addChild(this.#body);
		this.#choices.setHeight(this.#answers.length);
		this.#panel.addChild(this.#choices);
		this.#panel.addChild(new PanelDivider());
		this.#panel.addChild(this.#footer);
		if (options.timeout && options.timeout > 0) {
			options.onTimeoutStart?.();
			this.#countdown = new CountdownTimer(
				options.timeout,
				options.tui,
				seconds => {
					this.#panel.title = `${title} (${seconds}s)`;
				},
				() => {
					options.onTimeout?.();
					this.#finish("deny");
				},
			);
		}
	}

	invalidate(): void {
		this.#native = undefined;
		this.#panel.invalidate();
	}

	dispose(): void {
		this.#closed = true;
		this.#countdown?.dispose();
		this.#panel.dispose();
	}

	/**
	 * The arrow-key answer menu is the classic-terminal presentation of every answer set — choose
	 * with the arrows, confirm with Enter; a native surface (Tern) shows the same answers as
	 * clickable buttons instead, so the arrows keep scrolling there.
	 */
	get #menuEnabled(): boolean {
		return !isNativeRendering();
	}

	handleInput(keyData: string): void {
		if (this.#closed) return;
		this.#restartCountdown();
		const armed = performance.now() >= this.#armedAt;
		if (this.#hasMoreDetails && matchesAppToolsExpand(keyData)) {
			this.#toggleExpanded();
			return;
		}
		const draft = this.options.draft;
		// The composer's clear key (Ctrl+C, also a cancel key) clears a draft before it denies.
		if (draft?.hasDraft() && getKeybindings().matches(keyData, "app.clear")) {
			this.#editDraft(draft, keyData);
			return;
		}
		if (matchesSelectCancel(keyData)) {
			this.#finish("deny");
			return;
		}
		if (draft?.hasDraft()) {
			this.#editDraft(draft, keyData);
			return;
		}
		// With the composer empty, the arrows drive the answer menu like any omp selector;
		// page keys keep scrolling the details behind it. Without a menu (native rendering,
		// or a plain Approve/Deny prompt) the arrows keep scrolling as before.
		const menu = this.#menuEnabled;
		const page = Math.max(1, this.#bodyRows - 1);
		if (menu && matchesSelectUp(keyData)) this.#moveSelection(-1);
		else if (menu && matchesSelectDown(keyData)) this.#moveSelection(1);
		else if (matchesSelectPageUp(keyData)) this.#scroll(-page);
		else if (matchesSelectPageDown(keyData)) this.#scroll(page);
		else if (menu && getKeybindings().matches(keyData, "tui.input.submit")) {
			// The highlighted row confirms on Enter; the arming delay keeps an Enter
			// meant for the composer from answering the prompt as it appears. The checkbox
			// row toggles instead of answering.
			if (armed) this.#activate(this.#answers[this.#selected]?.id ?? "deny");
		} else if (!menu && matchesSelectUp(keyData)) this.#scroll(-1);
		else if (!menu && matchesSelectDown(keyData)) this.#scroll(1);
		// An empty composer swallows Enter: it would otherwise submit nothing, or interrupt the run.
		else if (draft && !getKeybindings().matches(keyData, "tui.input.submit")) this.#editDraft(draft, keyData);
	}

	/** Move the highlight by `delta` rows, stopping at the edges like the selector does. */
	#moveSelection(delta: number): void {
		const next = Math.max(0, Math.min(this.#answers.length - 1, this.#selected + delta));
		if (next === this.#selected) return;
		this.#selected = next;
		this.options.tui?.requestRender();
	}

	/** Run the highlighted row: the checkbox toggles, every other row answers the prompt. */
	#activate(id: ApprovalDialogAnswerId): void {
		if (id === "remember") this.#toggleRemember();
		else this.#finish(id);
	}

	/** Flip the remember checkbox, which changes what the answers record (never what they approve). */
	#toggleRemember(): void {
		if (this.#closed) return;
		this.#rememberAlways = !this.#rememberAlways;
		this.#answers = approvalDialogAnswers(this.options, this.#rememberAlways);
		this.#choices.setHeight(this.#answers.length);
		this.#native = undefined;
		this.options.tui?.requestRender();
	}

	#editDraft(draft: ApprovalDialogDraft, keyData: string): void {
		draft.handleInput(keyData);
		this.options.tui?.requestRender();
	}

	/**
	 * Swap the summarized prompt for every detail, wrapped, or back, as the expand key does here;
	 * for hosts that intercept that key first. Restarts the countdown like any key. False (nothing
	 * changes) without a full prompt, so the host's own expand handling (tool previews) can run.
	 */
	toggleDetails(): boolean {
		if (this.#closed || !this.#hasMoreDetails) return false;
		this.#restartCountdown();
		this.#toggleExpanded();
		return true;
	}

	/** Any user input restarts the countdown (and its described form). */
	#restartCountdown(): void {
		if (!this.#countdown) return;
		this.#countdown.reset();
		this.options.onTimeoutReset?.();
		this.#native = undefined;
	}

	#toggleExpanded(): void {
		this.#expanded = !this.#expanded;
		this.#scrollOffset = 0;
		this.#native = undefined;
		this.options.tui?.requestRender();
	}

	/** The rows on show: the summary, or every detail once expanded. */
	/**
	 * Whether expanding shows anything the summary row does not: the full prompt is only worth a
	 * Details option when it differs from what is already on screen.
	 */
	get #hasMoreDetails(): boolean {
		if (!this.#full) return false;
		// Compare the words, not the layout: a full prompt that only re-lays-out the summary row —
		// the same details, one per line — has nothing extra to expand.
		const words = (lines: readonly string[]): string =>
			lines.join(" ").replaceAll("·", " ").replaceAll(/\s+/g, " ").trim();
		if (words(this.#full) !== words(this.#summary)) return true;
		// The same words, but a summary row the body clips: expanding wraps the full text, so what
		// the row cut off is still worth a Details option.
		const width = this.#renderedWidth;
		if (width === undefined) return false;
		const innerWidth = Math.max(1, width - 4);
		return this.#summary.some(line => truncateToWidth(line, innerWidth) !== line);
	}

	get #details(): readonly string[] {
		return this.#expanded && this.#full ? this.#full : this.#summary;
	}

	render(width: number): readonly string[] {
		// Remembered so {@link ApprovalDialogComponent.#hasMoreDetails} can tell whether the summary
		// row is clipped at this width.
		this.#renderedWidth = width;
		const innerWidth = Math.max(1, width - 4);
		let lines = this.#detailLines(innerWidth);
		const rows = Math.max(1, Math.min(lines.length, MAX_DETAIL_ROWS));
		const overflows = lines.length > rows;
		// Leave a column for the scrollbar once the details overflow.
		if (overflows && innerWidth > 1) lines = this.#detailLines(innerWidth - 1);
		this.#bodyRows = rows;
		this.#scrollOffset = Math.max(0, Math.min(this.#scrollOffset, lines.length - rows));
		if (overflows) {
			const view = new ScrollView(lines, {
				height: rows,
				scrollbar: "auto",
				theme: { track: t => theme.fg("muted", t), thumb: t => theme.fg("accent", t) },
			});
			view.setScrollOffset(this.#scrollOffset);
			this.#body.setLines(view.render(innerWidth));
		} else {
			this.#body.setLines(lines);
		}
		this.#body.setHeight(rows);
		const menu = this.#menuEnabled;
		this.#choices.setHeight(menu ? this.#answers.length : 0);
		this.#choices.setLines(menu ? this.#answerLines(width) : []);
		this.#footer.setLines([theme.fg("dim", this.#footerHint(overflows, menu))]);
		return this.#panel.render(width);
	}

	/**
	 * The answer menu: a cursor row painted with the `selectedBg` band like any omp
	 * selector, so the highlight survives themes whose accent is close to the text color.
	 */
	#answerLines(width: number): string[] {
		const innerWidth = Math.max(1, width - 4);
		return this.#answers.map((answer, index) => {
			const selected = index === this.#selected;
			const prefix = selected ? theme.fg("accent", `${theme.nav.cursor} `) : "  ";
			// The checkbox reads as a control, not an answer: dim until it is on (then success),
			// and accent while the cursor sits on it like any other row.
			const tone = answer.id === "remember" ? (this.#rememberAlways ? "success" : "dim") : "text";
			const label = theme.fg(selected ? "accent" : tone, answer.label);
			const row = truncateToWidth(prefix + label, innerWidth, Ellipsis.Unicode);
			return selected ? theme.bg("selectedBg", row) : row;
		});
	}

	/**
	 * In the dock, in the composer's place and framed as the composer is (an
	 * `omp.editor.*` root role), like the ask dialog, rather than a card over
	 * the transcript: the title, the details, then Details (with a full prompt),
	 * Deny, whose keys show in their tooltips.
	 */
	describe(): NativeNode {
		if (this.#native) return this.#native;
		const cancelKey = getKeybindings().getKeys("tui.select.cancel")[0];
		const deny = actionButton("Deny", "deny", {
			...(cancelKey ? { keys: cancelKey } : {}),
			tone: "error",
			title: `Deny this call${cancelKey ? `  ${formatTooltipKey(cancelKey)}` : ""}`,
		});
		const expandKey = appToolsExpandKey();
		const expand = this.#hasMoreDetails
			? [
					actionButton(this.#expanded ? "Less" : "Details", "expand", {
						keys: expandKey,
						title: `${this.#expanded ? "Summarize" : "Show every detail of"} this call  ${formatTooltipKey(expandKey)}`,
					}),
				]
			: [];
		const folderLabel = this.options.folderLabel;
		// The read/write answers describe the reads and writes they grant; a command's folder answer
		// approves running commands inside it, so it keeps the folder wording instead.
		const fileGrant = this.options.exactGrant === true && this.options.fileTarget !== false;
		const grantScope = this.#rememberAlways ? "for every session" : "for this session only";
		const directory =
			folderLabel === undefined
				? []
				: [
						actionButton("Approve Directory", "folder", {
							tone: "accent",
							title: `${this.options.exactGrant === true ? "Approve reads and writes within entire directory" : `Approve this call and remember ${folderLabel}`} ${grantScope}`,
						}),
					];
		const toolName = this.options.toolName;
		const tool =
			toolName === undefined
				? []
				: [
						actionButton(`Approve ${toolName} for session`, "tool", {
							tone: "accent",
							title: `Approve every ${toolName} call for the rest of this session`,
						}),
					];
		// The exact answer is named for what it records — "Approve File" only for a file target —
		// and prompts that offer grants without an exact answer carry "Approve Once" instead of a
		// plain "Approve" that would record just as little.
		const approve = approvalDialogExactAnswer(this.options)
			? [
					actionButton(fileGrant ? "Approve File" : "Approve", "approve", {
						tone: "accent",
						title: fileGrant
							? `Approve reads and writes to this file ${grantScope}`
							: `Approve this call and remember what it touched ${grantScope}`,
					}),
				]
			: approvalDialogOffersGrants(this.options)
				? []
				: [
						actionButton("Approve", "approve", {
							tone: "accent",
							title: "Approve this call without remembering it",
						}),
					];
		const once = approvalDialogOffersGrants(this.options)
			? [
					actionButton("Approve Once", "once", {
						tone: "accent",
						title: "Approve this call without remembering it",
					}),
				]
			: [];
		const remember = approvalDialogCanRemember(this.options)
			? [
					actionButton(approvalDialogRememberLabel(this.#rememberAlways), "remember", {
						title: this.#rememberAlways
							? "Remember approvals for this session only"
							: "Remember approvals for every session, not just this one",
					}),
				]
			: [];
		const children: NativeNode[] = [
			node("text", { text: this.#title, role: "omp.approval.title", tone: "accent" }, undefined, "title"),
		];
		if (this.#details.length > 0) {
			// One clipped row per detail like the text view; expanded details wrap.
			const rows = this.#details.map((line, index) =>
				node("text", this.#expanded ? { text: line } : { text: line, truncate: "end" }, undefined, String(index)),
			);
			children.push(node("col", { role: "omp.approval.details" }, rows, "details"));
		}
		// The countdown, when one runs, leads the bar like the ask dialog's. The answers keep the
		// menu's order — the remember checkbox, then Approve Directory, the by-name tool answer,
		// the exact answer, Approve Once, and Deny.
		children.push(
			actionBar([
				...(this.#countdown ? [this.#countdown.describe()] : []),
				null,
				...expand,
				...remember,
				...directory,
				...tool,
				...approve,
				...once,
				deny,
			]),
		);
		// Under the `omp.editor.ask` prefix: Tern's console layout sizes an ask's rows to the
		// composer column by that prefix, where a bare `omp.editor.*` role spans the whole dock.
		this.#native = col(children, { role: "omp.editor.ask.approval", gap: "md" });
		return this.#native;
	}

	/** Deny, the answers, the remember checkbox, and Details run exactly what their keys run. */
	handleNativeEvent(event: NativeUiEvent): void {
		if (this.#closed || event.type !== "action") return;
		if (event.act === "approve") this.#finish("approve");
		else if (event.act === "folder") this.#finish("folder");
		else if (event.act === "tool") this.#finish("tool");
		else if (event.act === "once") this.#finish("once");
		else if (event.act === "remember") this.#toggleRemember();
		else if (event.act === "deny") this.#finish("deny");
		else if (event.act === "expand") this.toggleDetails();
	}

	/** Detail rows at `width`: one clipped row per detail, or wrapped rows once expanded. */
	#detailLines(width: number): string[] {
		if (!this.#expanded) {
			return this.#details.map(line => truncateToWidth(theme.fg("accent", line), width, Ellipsis.Unicode));
		}
		return this.#details.flatMap(line => (line === "" ? [""] : wrapTextWithAnsi(theme.fg("accent", line), width)));
	}

	#footerHint(overflows: boolean, menu: boolean): string {
		const draft = this.options.draft;
		if (menu) {
			const hint = `${editorKeys("tui.select.up", "tui.select.down")} choose · ${formatKeyHint("enter")} confirm · ${editorKey("tui.select.cancel")} deny`;
			if (draft?.hasDraft()) return `${hint} · ${editorKey("tui.input.submit")} deny and send`;
			const scroll = overflows ? ` · ${editorKeys("tui.select.pageUp", "tui.select.pageDown")} scroll` : "";
			const details = this.#hasMoreDetails
				? ` · ${formatKeyHints([appToolsExpandKey()])} ${this.#expanded ? "less" : "details"}`
				: "";
			return `${hint}${scroll}${details}${draft ? " · type to steer instead" : ""}`;
		}
		const expand = this.#hasMoreDetails
			? ` · ${formatKeyHints([appToolsExpandKey()])} ${this.#expanded ? "less" : "details"}`
			: "";
		const hint = `${editorKey("tui.select.cancel")} deny${expand}`;
		if (draft?.hasDraft()) return `${hint} · ${editorKey("tui.input.submit")} deny and send`;
		const scroll = overflows ? ` · ${editorKeys("tui.select.up", "tui.select.down")} scroll` : "";
		return `${hint}${scroll}${draft ? " · type to steer instead" : ""}`;
	}

	#scroll(delta: number): void {
		this.#scrollOffset = Math.max(0, this.#scrollOffset + delta);
		this.options.tui?.requestRender();
	}

	#finish(outcome: "approve" | "folder" | "tool" | "once" | "deny"): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#countdown?.dispose();
		if (outcome === "approve") this.callbacks.onApprove(this.#rememberAlways);
		else if (outcome === "folder") this.callbacks.onApproveFolder?.(this.#rememberAlways);
		else if (outcome === "tool") this.callbacks.onApproveTool?.();
		else if (outcome === "once") this.callbacks.onApproveOnce?.();
		else this.callbacks.onDeny();
	}
}
