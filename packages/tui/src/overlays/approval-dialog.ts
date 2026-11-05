/**
 * Tool-approval prompt in the composer's place, presented like the ask
 * dialog: the approval title and its details over a list of choices —
 * optional grants (led by a toggle that keeps them across sessions), Approve,
 * an optional "approve for this session", and Deny — and an action
 * bar. The arrows move between the choices and Enter takes the highlighted
 * one; `app.approval.approve` (Ctrl+Enter by default) approves this call
 * outright and Esc denies. Enter and the approve chord only arm
 * {@link APPROVE_ARM_MS} after mount, so a key meant for the composer (Enter,
 * or the follow-up chord pressed mid-run) as the prompt appears never answers
 * it. With an {@link ApprovalDialogDraft}, every other key edits the composer
 * mounted beneath the dialog, so a message can deny the call and steer the
 * turn instead: while the composer holds a draft, the arrows and Enter edit and
 * send it, and the highlight sits on Deny, relabeled to say Enter sends.
 * The prompt stays a few rows so the composer keeps its room; Page Up/Down
 * scroll the details, and with a full prompt the expand key
 * (`app.tools.expand`) swaps it in, wrapped.
 */
import { type Component, Ellipsis, ScrollView, type TUI, truncateToWidth, wrapTextWithAnsi } from "../index";
import { formatKeyHints, formatTooltipKey } from "../app-keybindings";
import { OverlayPanel, PanelDivider, PanelRows } from "../chrome/overlay-box";
import { editorKey, editorKeys } from "../chrome/keybinding-hints";
import { getKeybindings } from "../keybindings";
import {
	appApproveKeys,
	appToolsExpandKey,
	matchesAppApprove,
	matchesAppToolsExpand,
	matchesSelectCancel,
	matchesSelectDown,
	matchesSelectPageDown,
	matchesSelectPageUp,
	matchesSelectUp,
} from "../keybinding-matchers";
import { col, item, node } from "../native/describe";
import { leafKey, type NativeNode, type NativeUiEvent } from "../native/node";
import { actionBar, actionButton } from "../native/overlay";
import { PREVIEW_LIMITS, sanitizeDisplayLines } from "../render/render-utils";
import { theme } from "../theme/theme";
import { CountdownTimer } from "../chrome/countdown-timer";

/** Detail rows shown before the rest scrolls, so the composer beneath keeps its room. */
const MAX_DETAIL_ROWS: number = PREVIEW_LIMITS.COLLAPSED_ITEMS;
/** Enter and the approve key are ignored this long after mount, so a key sent as the prompt appears cannot answer it. */
export const APPROVE_ARM_MS = 500;
/** The Deny row while a composer draft holds Enter: sending it denies the call and steers the turn. */
const DENY_AND_SEND_LABEL = "Deny and send message";

/** `grant<N>` takes the Nth of {@link ApprovalDialogOptions.grants}; `remember` toggles their lifetime. */
type ApprovalAnswer = "once" | "session" | "deny" | "remember" | `grant${number}`;

interface ApprovalChoice {
	readonly label: string;
	readonly answer: ApprovalAnswer;
}

interface ApprovalDialogCallbacks {
	onApprove(): void;
	onDeny(): void;
}

/** A choice that approves the call and remembers more than it: a folder, or the exact target. */
export interface ApprovalDialogGrant {
	/** Label while the grant is remembered for this session. */
	readonly label: string;
	/** Label once the remember toggle keeps it across sessions. */
	readonly alwaysLabel: string;
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
	/** Offer to approve this and later like calls for the rest of the session, as the row between Approve and Deny. */
	session?: { label: string; onApprove(): void };
	/**
	 * Grants to offer above Approve, led by a toggle that keeps them across sessions; Approve then
	 * reads "Approve Once". `onGrant` gets the chosen grant and whether the toggle was on.
	 */
	grants?: readonly ApprovalDialogGrant[];
	onGrant?(grant: ApprovalDialogGrant, always: boolean): void;
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
	readonly #panel: OverlayPanel;
	readonly #body = new PanelRows();
	readonly #choiceRows = new PanelRows();
	readonly #footer = new PanelRows();
	#scrollOffset = 0;
	#bodyRows = MAX_DETAIL_ROWS;
	/** In list order: the remember toggle and grants (when offered), Approve (highlighted on mount), the session row, Deny last. */
	#choices: readonly ApprovalChoice[];
	#choice = 0;
	/** The remember toggle: grants are kept across sessions while it is on. */
	#rememberAlways = false;
	#closed = false;
	#native: NativeNode | undefined;
	/** Whether a draft held the keys when {@link #native} was described: it moves the highlight. */
	#nativeDrafting = false;
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
		this.#choices = this.#buildChoices();
		this.#choice = this.#choices.findIndex(choice => choice.answer === "once");
		this.#panel = new OverlayPanel(title, "omp.overlay.approval");
		this.#footer.setHeight(1);
		this.#panel.addChild(this.#body);
		this.#panel.addChild(this.#choiceRows);
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

	#buildChoices(): ApprovalChoice[] {
		const grants = this.options.grants ?? [];
		const glyph = this.#rememberAlways ? theme.checkbox.checked : theme.checkbox.unchecked;
		return [
			...(grants.length > 0 ? [{ label: `${glyph} Remember across sessions`, answer: "remember" as const }] : []),
			...grants.map((grant, index) => ({
				label: this.#rememberAlways ? grant.alwaysLabel : grant.label,
				answer: `grant${index}` as const,
			})),
			{ label: grants.length > 0 ? "Approve Once" : "Approve", answer: "once" },
			...(this.options.session ? [{ label: this.options.session.label, answer: "session" as const }] : []),
			{ label: "Deny", answer: "deny" },
		];
	}

	/** Run a choice: the remember toggle flips the grants' lifetime in place, every other choice answers. */
	#take(answer: ApprovalAnswer): void {
		if (answer !== "remember") {
			this.#finish(answer);
			return;
		}
		this.#rememberAlways = !this.#rememberAlways;
		this.#choices = this.#buildChoices();
		this.#native = undefined;
		this.options.tui?.requestRender();
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

	handleInput(keyData: string): void {
		if (this.#closed) return;
		this.#restartCountdown();
		if (matchesAppApprove(keyData)) {
			if (performance.now() >= this.#armedAt) this.#finish("once");
			return;
		}
		if (this.#full && matchesAppToolsExpand(keyData)) {
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
		const page = Math.max(1, this.#bodyRows - 1);
		if (matchesSelectUp(keyData)) this.#moveChoice(-1);
		else if (matchesSelectDown(keyData)) this.#moveChoice(1);
		else if (matchesSelectPageUp(keyData)) this.#scroll(-page);
		else if (matchesSelectPageDown(keyData)) this.#scroll(page);
		else if (getKeybindings().matches(keyData, "tui.select.confirm")) {
			if (performance.now() >= this.#armedAt) this.#take(this.#choices[this.#choice]!.answer);
		}
		// Enter never reaches an empty composer: it would submit nothing, or interrupt the run.
		else if (draft && !getKeybindings().matches(keyData, "tui.input.submit")) this.#editDraft(draft, keyData);
	}

	#moveChoice(delta: number): void {
		const count = this.#choices.length;
		this.#choice = (this.#choice + delta + count) % count;
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
		if (this.#closed || !this.#full) return false;
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
	get #details(): readonly string[] {
		return this.#expanded && this.#full ? this.#full : this.#summary;
	}

	render(width: number): readonly string[] {
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
		const drafting = this.options.draft?.hasDraft() ?? false;
		// While a draft holds Enter the highlight sits on Deny (sending the draft denies), else on the arrows' choice.
		const shown = drafting ? this.#choices.length - 1 : this.#choice;
		this.#choiceRows.setLines(
			this.#choices.map((choice, index) => {
				const label = drafting && choice.answer === "deny" ? DENY_AND_SEND_LABEL : choice.label;
				if (index !== shown) return truncateToWidth(`  ${label}`, innerWidth, Ellipsis.Unicode);
				const color = choice.answer === "deny" ? "error" : "accent";
				const row = truncateToWidth(`${theme.nav.cursor} ${label}`, innerWidth, Ellipsis.Unicode);
				return theme.bold(theme.fg(color, row));
			}),
		);
		this.#footer.setLines([theme.fg("dim", this.#footerHint(overflows, drafting))]);
		return this.#panel.render(width);
	}

	/**
	 * In the dock, in the composer's place and framed as the composer is (an
	 * `omp.editor.*` root role), like the ask dialog, rather than a card over
	 * the transcript: the title, the details, the choices with the keyboard's
	 * highlight (a click takes one), then Details (with a full prompt), Deny,
	 * and the primary Approve, whose keys show in their tooltips.
	 */
	describe(): NativeNode {
		const drafting = this.options.draft?.hasDraft() ?? false;
		if (this.#native && this.#nativeDrafting === drafting) return this.#native;
		const cancelKey = getKeybindings().getKeys("tui.select.cancel")[0];
		const approveKey = appApproveKeys()[0];
		const deny = actionButton("Deny", "deny", {
			...(cancelKey ? { keys: cancelKey } : {}),
			tone: "error",
			title: `Deny this call${cancelKey ? `  ${formatTooltipKey(cancelKey)}` : ""}`,
		});
		const approve = actionButton(this.options.grants?.length ? "Approve Once" : "Approve", "approve", {
			...(approveKey ? { keys: approveKey } : {}),
			tone: "accent",
			title: `Approve this call${approveKey ? `  ${formatTooltipKey(approveKey)}` : ""}`,
		});
		const expandKey = appToolsExpandKey();
		const expand = this.#full
			? [
					actionButton(this.#expanded ? "Less" : "Details", "expand", {
						keys: expandKey,
						title: `${this.#expanded ? "Summarize" : "Show every detail of"} this call  ${formatTooltipKey(expandKey)}`,
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
		const choices = this.#choices.map(choice =>
			item(choice.answer, {
				label: choice.label,
				role: "omp.approval.choice",
				tone: choice.answer === "deny" ? "error" : "accent",
			}),
		);
		const selected = drafting ? "deny" : this.#choices[this.#choice]!.answer;
		children.push(node("list", { selected, role: "omp.approval.choices" }, choices, "choices"));
		// The countdown, when one runs, leads the bar like the ask dialog's.
		children.push(
			actionBar([...(this.#countdown ? [this.#countdown.describe()] : []), null, ...expand, deny, approve]),
		);
		// Under the `omp.editor.ask` prefix: Tern's console layout sizes an ask's rows to the
		// composer column by that prefix, where a bare `omp.editor.*` role spans the whole dock.
		this.#native = col(children, { role: "omp.editor.ask.approval", gap: "md" });
		this.#nativeDrafting = drafting;
		return this.#native;
	}

	/** Deny, Approve, and Details run exactly what Esc, the approve key, and the expand key run; a click on a choice takes it. */
	handleNativeEvent(event: NativeUiEvent): void {
		if (this.#closed) return;
		if (event.type === "action") {
			if (event.act === "approve") this.#finish("once");
			else if (event.act === "deny") this.#finish("deny");
			else if (event.act === "expand") this.toggleDetails();
			return;
		}
		if ((event.type !== "select" && event.type !== "activate") || leafKey(event.key) !== "choices") return;
		const choice = this.#choices.find(candidate => candidate.answer === event.item);
		if (choice) this.#take(choice.answer);
	}

	/** Detail rows at `width`: one clipped row per detail, or wrapped rows once expanded. */
	#detailLines(width: number): string[] {
		if (!this.#expanded) {
			return this.#details.map(line => truncateToWidth(theme.fg("accent", line), width, Ellipsis.Unicode));
		}
		return this.#details.flatMap(line => (line === "" ? [""] : wrapTextWithAnsi(theme.fg("accent", line), width)));
	}

	#footerHint(overflows: boolean, drafting: boolean): string {
		const approve = formatKeyHints(appApproveKeys());
		const expand = this.#full
			? ` · ${formatKeyHints([appToolsExpandKey()])} ${this.#expanded ? "less" : "details"}`
			: "";
		const keys = `${approve} approve · ${editorKey("tui.select.cancel")} deny${expand}`;
		if (drafting) return `${editorKey("tui.input.submit")} deny and send · ${keys}`;
		const choose = `${editorKeys("tui.select.up", "tui.select.down")} choose · ${editorKey("tui.select.confirm")} select`;
		const scroll = overflows ? ` · ${editorKeys("tui.select.pageUp", "tui.select.pageDown")} scroll` : "";
		return `${choose} · ${keys}${scroll}${this.options.draft ? " · type to deny and steer" : ""}`;
	}

	#scroll(delta: number): void {
		this.#scrollOffset = Math.max(0, this.#scrollOffset + delta);
		this.options.tui?.requestRender();
	}

	#finish(answer: ApprovalAnswer): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#countdown?.dispose();
		if (answer === "once") this.callbacks.onApprove();
		else if (answer === "session") this.options.session?.onApprove();
		else if (answer.startsWith("grant")) {
			const grant = this.options.grants?.[Number(answer.slice("grant".length))];
			if (grant) this.options.onGrant?.(grant, this.#rememberAlways);
			else this.callbacks.onDeny();
		} else this.callbacks.onDeny();
	}
}
