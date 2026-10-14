/**
 * Tool-approval prompt in the composer's place, presented like the ask
 * dialog: the approval title and its details over an action bar. Approving
 * takes a deliberate chord (`app.approval.approve`, Ctrl+Enter by default),
 * so an Enter typed for the composer as the prompt appears never approves a
 * call, and the chord itself only arms {@link APPROVE_ARM_MS} after mount: it
 * is also the follow-up key, pressed mid-run exactly when prompts appear.
 * Esc denies. With an {@link ApprovalDialogDraft}, every other key edits the
 * composer mounted beneath the dialog, so a message can steer the turn while
 * the call waits; an empty composer ignores Enter and arrows scroll the details.
 * The prompt stays a few rows so the composer keeps its room; with a full
 * prompt, the expand key (`app.tools.expand`) swaps it in, wrapped.
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
	onApprove(): void;
	onDeny(): void;
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
	readonly #footer = new PanelRows();
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
		this.#footer.setHeight(1);
		this.#panel.addChild(this.#body);
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
					this.#finish(false);
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

	handleInput(keyData: string): void {
		if (this.#closed) return;
		this.#restartCountdown();
		if (matchesAppApprove(keyData)) {
			if (performance.now() >= this.#armedAt) this.#finish(true);
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
			this.#finish(false);
			return;
		}
		if (draft?.hasDraft()) {
			this.#editDraft(draft, keyData);
			return;
		}
		const page = Math.max(1, this.#bodyRows - 1);
		if (matchesSelectUp(keyData)) this.#scroll(-1);
		else if (matchesSelectDown(keyData)) this.#scroll(1);
		else if (matchesSelectPageUp(keyData)) this.#scroll(-page);
		else if (matchesSelectPageDown(keyData)) this.#scroll(page);
		// An empty composer swallows Enter: it would otherwise submit nothing, or interrupt the run.
		else if (draft && !getKeybindings().matches(keyData, "tui.input.submit")) this.#editDraft(draft, keyData);
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
		this.#footer.setLines([theme.fg("dim", this.#footerHint(overflows))]);
		return this.#panel.render(width);
	}

	/**
	 * In the dock, in the composer's place and framed as the composer is (an
	 * `omp.editor.*` root role), like the ask dialog, rather than a card over
	 * the transcript: the title, the details, then Details (with a full prompt),
	 * Deny, and the primary Approve, whose keys show in their tooltips.
	 */
	describe(): NativeNode {
		if (this.#native) return this.#native;
		const cancelKey = getKeybindings().getKeys("tui.select.cancel")[0];
		const approveKey = appApproveKeys()[0];
		const deny = actionButton("Deny", "deny", {
			...(cancelKey ? { keys: cancelKey } : {}),
			tone: "error",
			title: `Deny this call${cancelKey ? `  ${formatTooltipKey(cancelKey)}` : ""}`,
		});
		const approve = actionButton("Approve", "approve", {
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
		// The countdown, when one runs, leads the bar like the ask dialog's.
		children.push(
			actionBar([...(this.#countdown ? [this.#countdown.describe()] : []), null, ...expand, deny, approve]),
		);
		// Under the `omp.editor.ask` prefix: Tern's console layout sizes an ask's rows to the
		// composer column by that prefix, where a bare `omp.editor.*` role spans the whole dock.
		this.#native = col(children, { role: "omp.editor.ask.approval", gap: "md" });
		return this.#native;
	}

	/** Deny, Approve, and Details run exactly what Esc, the approve key, and the expand key run. */
	handleNativeEvent(event: NativeUiEvent): void {
		if (this.#closed || event.type !== "action") return;
		if (event.act === "approve") this.#finish(true);
		else if (event.act === "deny") this.#finish(false);
		else if (event.act === "expand") this.toggleDetails();
	}

	/** Detail rows at `width`: one clipped row per detail, or wrapped rows once expanded. */
	#detailLines(width: number): string[] {
		if (!this.#expanded) {
			return this.#details.map(line => truncateToWidth(theme.fg("accent", line), width, Ellipsis.Unicode));
		}
		return this.#details.flatMap(line => (line === "" ? [""] : wrapTextWithAnsi(theme.fg("accent", line), width)));
	}

	#footerHint(overflows: boolean): string {
		const approve = formatKeyHints(appApproveKeys());
		const expand = this.#full
			? ` · ${formatKeyHints([appToolsExpandKey()])} ${this.#expanded ? "less" : "details"}`
			: "";
		const hint = `${approve} approve · ${editorKey("tui.select.cancel")} deny${expand}`;
		const draft = this.options.draft;
		if (draft?.hasDraft()) return `${hint} · ${editorKey("tui.input.submit")} deny and send`;
		const scroll = overflows ? ` · ${editorKeys("tui.select.up", "tui.select.down")} scroll` : "";
		return `${hint}${scroll}${draft ? " · type to steer instead" : ""}`;
	}

	#scroll(delta: number): void {
		this.#scrollOffset = Math.max(0, this.#scrollOffset + delta);
		this.options.tui?.requestRender();
	}

	#finish(approved: boolean): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#countdown?.dispose();
		if (approved) this.callbacks.onApprove();
		else this.callbacks.onDeny();
	}
}
