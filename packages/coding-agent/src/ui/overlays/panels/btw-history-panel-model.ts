/**
 * State of the `/btw` history sheet: the session's side questions (newest
 * first) beside the selected one's thread, the follow-up composer under it,
 * and what the keys, the wheel and native events do to them.
 *
 * The native tree (`btw-history-panel.tsx`) and the terminal look
 * (`styles/panels/btw-history-panel.ts`) both read {@link BtwHistoryModel};
 * the terminal painter records the geometry it drew (list rows per page,
 * reader rows) that paging and the wheel use.
 *
 * The follow-up composer takes push-to-talk dictation (a held Space shows the
 * transcription at the caret, the mic glyph in the caret's cell, and commits
 * it on release) and attaches pasted image paths.
 */
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { type KeyEvent, type ScrollRequest, signal, untrack } from "@oh-my-pi/pi-tui";
import { holdText, SpaceHoldGesture, type SpaceHoldHandler } from "../../../config/keybindings/space-hold";
import type { BtwInjectState } from "../../../modes/view-model/overlays/btw-inject";
import { compactImageMarkers, formatVisionMarker } from "../../../modes/view-model/prompt/composer-attachments";
import { extractImagePastePathsFromText } from "../../../modes/view-model/prompt/custom-editor";
import {
	type BtwHistoryRecord,
	type BtwHistoryTurn,
	type BtwInjectParts,
	getBtwCopyText,
	getBtwLatestTurn,
	getBtwTurns,
	splitBtwInject,
} from "../../../session/btw-history-model";
import type { DictationTarget } from "../../../stt";
import { editLine } from "../settings/line-edit";
import type { LineValue } from "./common";
import { matchesSelectCancel, selectKeyId } from "../../../config/keybindings/matchers";
import { getKeybindings } from "../../../config/keybindings/keybindings";

/** `btw.inject` hooks, given while injecting is on for this view. */
export interface BtwHistoryInject {
	/** How a finished turn's closed `<inject>` block shows: apart while pending or sent, plain when undefined. */
	state(record: BtwHistoryRecord, turnIndex: number): BtwInjectState | undefined;
	/** Whether the inject key may send the record's latest block now. */
	canSend(record: BtwHistoryRecord): boolean;
	send(record: BtwHistoryRecord): void;
}

export interface BtwHistoryOptions {
	readonly records: readonly BtwHistoryRecord[];
	readonly onClose: () => void;
	readonly onCopy: (record: BtwHistoryRecord) => void;
	readonly onCancel: (record: BtwHistoryRecord) => void;
	readonly canFollowUp?: (record: BtwHistoryRecord) => boolean;
	/** Promote the answer into a branch; false hides Branch. */
	readonly canBranch?: (record: BtwHistoryRecord) => boolean;
	readonly onBranch?: (record: BtwHistoryRecord) => void;
	/** Start a follow-up; false (or a throw) keeps the draft. */
	readonly onFollowUp?: (
		record: BtwHistoryRecord,
		question: string,
		signal: AbortSignal,
		images?: ImageContent[],
	) => Promise<boolean>;
	/** Read a clipboard image into the follow-up (terminals send an empty paste for one). */
	readonly onPasteImage?: () => Promise<unknown>;
	/** Attach a pasted image (or video) path to the follow-up; what it cannot attach comes back as a paste. */
	readonly onPasteImagePath?: (path: string) => Promise<void>;
	/** Push-to-talk keys (KeyEvent ids; default Space) recognized as held while the follow-up is written. */
	readonly spaceHoldKeys?: readonly string[];
	/** What a recognized hold drives, dictating into the follow-up; unset keeps the keys typing. */
	readonly spaceHold?: (target: DictationTarget) => SpaceHoldHandler;
	/** Terminal rows the sheet takes. */
	readonly terminalRows: () => number;
	/**
	 * Esc closes even while the selected answer runs (it keeps streaming) and
	 * `x` stops it, instead of Esc stopping first (hosts without an inline panel).
	 */
	readonly escapeHides?: boolean;
	readonly inject?: BtwHistoryInject;
	/** The inject key (`alt+i`). */
	readonly injectKey?: string;
	/** Wall clock (ms). */
	readonly now?: () => number;
}

export type BtwPane = "list" | "answer";

/** The follow-up being written for one topic. */
export interface FollowUpComposer {
	readonly recordId: string;
	draft: LineValue;
	readonly abort: AbortController;
	/** Images pasted into it, numbered by their `[Image #N]` markers. */
	readonly images: ImageContent[];
	notice?: string;
	/** Dictation not yet final, shown in the draft from `from` (UTF-16 offsets). */
	volatile?: { from: number; length: number };
}

/** A turn's `<inject>` block as shown apart from its prose. */
export interface InjectBlock {
	readonly parts: BtwInjectParts;
	readonly state: BtwInjectState;
}

export const BTW_STATUS: Readonly<Record<BtwHistoryTurn["status"], { label: string; color: string }>> = {
	running: { label: "Running", color: "accent" },
	complete: { label: "Complete", color: "success" },
	cancelled: { label: "Cancelled", color: "warning" },
	error: { label: "Error", color: "error" },
	interrupted: { label: "Interrupted", color: "warning" },
};

/** The topic's heading: its title (`/sitrep`), else the opening question. */
export function topicLabel(record: BtwHistoryRecord): string {
	return record.title ?? record.question;
}

/** The turns as shown: a titled topic's opening question reads as its title. */
export function displayTurns(record: BtwHistoryRecord): readonly BtwHistoryTurn[] {
	const turns = getBtwTurns(record);
	return record.title === undefined ? turns : [{ ...turns[0]!, question: record.title }, ...turns.slice(1)];
}

export function sameLocalDay(a: number | Date, b: number | Date): boolean {
	return new Date(a).toDateString() === new Date(b).toDateString();
}

export const TIME_FORMAT = new Intl.DateTimeFormat("en", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
export const DATE_FORMAT = new Intl.DateTimeFormat("en", {
	month: "short",
	day: "numeric",
	year: "numeric",
	hour: "2-digit",
	minute: "2-digit",
	hourCycle: "h23",
});
const DAY_FORMAT = new Intl.DateTimeFormat("en", { month: "short", day: "numeric" });
const YEAR_DAY_FORMAT = new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric" });

/** A history row's stamp: the time for today's question, else its date (with the year when not this one). */
export function listStamp(timestamp: number, now: number): string {
	const date = new Date(timestamp);
	if (sameLocalDay(date, now)) return TIME_FORMAT.format(date);
	return (date.getFullYear() === new Date(now).getFullYear() ? DAY_FORMAT : YEAR_DAY_FORMAT).format(date);
}

const LINE_SCROLL: Readonly<Record<string, ScrollRequest["by"]>> = {
	up: "line-up",
	down: "line-down",
	pageUp: "page-up",
	pageDown: "page-down",
	home: "start",
	end: "end",
};

export class BtwHistoryModel implements DictationTarget {
	/** Bumped on every change either face shows. */
	readonly rev = signal(0);
	/** Push-to-talk's mic glyph drawn in the follow-up caret's cell (terminal only). */
	readonly caretGlyph = signal<string | undefined>(undefined);
	records: readonly BtwHistoryRecord[];
	selectedId: string | undefined;
	focus: BtwPane = "list";
	composer: FollowUpComposer | undefined;
	followUpPending = false;
	/** Keep the reader at its last row (after opening or sending a follow-up) until a scroll key. */
	followLatest = false;
	/** The last reader scroll key, forwarded natively. */
	nativeScroll: ScrollRequest | undefined;
	#copied: { id: string; text: string } | undefined;
	readonly #spaceHold: SpaceHoldGesture | undefined;
	/** Image-path pastes in flight: what they hand back as text (an unreadable path) is typed, not re-attached. */
	#pathPastes = 0;

	// Terminal geometry: written by the painter as it draws, read by paging and the wheel.
	listScroll = 0;
	/** History rows per page. */
	listHeight = 1;
	/** Reader scroll offset, rows and height. */
	detailScroll = 0;
	detailRows = 0;
	detailHeight = 1;

	constructor(readonly options: BtwHistoryOptions) {
		this.records = options.records;
		this.selectedId = options.records[0]?.id;
		if (options.records.length === 1) this.focus = "answer";
		if (options.spaceHold) {
			const hold = new SpaceHoldGesture(
				count => this.deleteBeforeCursor(count),
				() => this.composer !== undefined && !this.followUpPending,
			);
			if (options.spaceHoldKeys) hold.keys = options.spaceHoldKeys;
			hold.handler = options.spaceHold(this);
			this.#spaceHold = hold;
		}
	}

	/** End a held push-to-talk (stopping its dictation) and its timer; the sheet closed. */
	dispose(): void {
		this.#spaceHold?.dispose();
	}

	now(): number {
		return this.options.now?.() ?? Date.now();
	}

	touch(): void {
		this.rev.set(untrack(this.rev) + 1);
	}

	get injectKey(): string {
		return this.options.injectKey ?? "alt+i";
	}

	update(records: readonly BtwHistoryRecord[]): void {
		this.records = records;
		const copied = this.#copied && records.find(record => record.id === this.#copied!.id);
		if (!copied || getBtwCopyText(copied) !== this.#copied!.text) this.#copied = undefined;
		if (this.composer && !records.some(record => record.id === this.composer!.recordId)) this.composer = undefined;
		if (!records.some(record => record.id === this.selectedId)) {
			this.selectedId = records[0]?.id;
			this.listScroll = 0;
			this.followLatest = false;
			this.detailScroll = 0;
		}
		// One side question has nothing to pick: its answer keeps the arrow keys.
		if (records.length === 1) this.focus = "answer";
		this.touch();
	}

	/** `c` copied this record's answer (shown while the record still holds that text). */
	markCopied(recordId: string, text: string): void {
		this.#copied = { id: recordId, text };
		this.touch();
	}

	isCopied(record: BtwHistoryRecord): boolean {
		return record.id === this.#copied?.id && getBtwCopyText(record) === this.#copied.text;
	}

	selectedIndex(): number {
		return Math.max(
			0,
			this.records.findIndex(record => record.id === this.selectedId),
		);
	}

	selected(): BtwHistoryRecord | undefined {
		return this.records[this.selectedIndex()];
	}

	running(record: BtwHistoryRecord | undefined): boolean {
		return record !== undefined && getBtwLatestTurn(record).status === "running";
	}

	#select(index: number): void {
		const record = this.records[Math.max(0, Math.min(index, this.records.length - 1))];
		if (!record || record.id === this.selectedId) return;
		this.selectedId = record.id;
		this.followLatest = false;
		this.detailScroll = 0;
	}

	canFollowUp(record: BtwHistoryRecord | undefined): boolean {
		return (
			record !== undefined &&
			!this.followUpPending &&
			!!this.options.onFollowUp &&
			!!this.options.canFollowUp?.(record)
		);
	}

	canBranch(record: BtwHistoryRecord | undefined): boolean {
		return record !== undefined && this.options.canBranch?.(record) === true;
	}

	canInject(record: BtwHistoryRecord | undefined): boolean {
		return record !== undefined && this.options.inject?.canSend(record) === true;
	}

	canCopy(record: BtwHistoryRecord | undefined): boolean {
		return record !== undefined && getBtwCopyText(record) !== undefined;
	}

	/** The turn's `<inject>` block to show apart, if any. */
	injectBlock(record: BtwHistoryRecord, turn: BtwHistoryTurn, index: number): InjectBlock | undefined {
		const inject = this.options.inject;
		const parts = inject ? splitBtwInject(turn.answer) : undefined;
		if (!inject || !parts) return undefined;
		const state = turn.status === "running" ? "pending" : parts.closed ? inject.state(record, index) : undefined;
		return state && { parts, state };
	}

	/** Jump the reader to its end once: the terminal follows the last row until a scroll key; natively the sheet scrolls there. */
	#jumpToEnd(): void {
		this.followLatest = true;
		this.nativeScroll = { by: "end", n: (this.nativeScroll?.n ?? 0) + 1 };
	}

	openFollowUp(recordId: string): boolean {
		if (this.composer) return false;
		const index = this.records.findIndex(record => record.id === recordId);
		const record = this.records[index];
		if (!record || !this.canFollowUp(record)) return false;
		this.#select(index);
		this.composer = { recordId: record.id, draft: { text: "", cursor: 0 }, abort: new AbortController(), images: [] };
		this.focus = "answer";
		this.#jumpToEnd();
		this.touch();
		return true;
	}

	/** Select a record with its reader focused, from the top (a just-asked `/btw`). */
	showRecord(recordId: string): void {
		const index = this.records.findIndex(record => record.id === recordId);
		if (index === -1) return;
		this.#select(index);
		this.focus = "answer";
		this.touch();
	}

	discard(): void {
		if (!this.composer) return;
		this.composer.abort.abort();
		this.composer = undefined;
		this.touch();
	}

	/** The follow-up's draft after an edit (native `edit` events, terminal keys, pastes). */
	setDraft(draft: LineValue): void {
		if (!this.composer) return;
		this.composer.draft = draft;
		this.touch();
	}

	paste(text: string): void {
		const composer = this.composer;
		if (!composer) return;
		if (text === "" && this.options.onPasteImage) {
			void this.options.onPasteImage();
			return;
		}
		const paths =
			this.options.onPasteImagePath && this.#pathPastes === 0 ? extractImagePastePathsFromText(text) : undefined;
		if (paths) {
			void this.#pastePaths(paths);
			return;
		}
		this.#insert(text);
	}

	async #pastePaths(paths: readonly string[]): Promise<void> {
		this.#pathPastes++;
		try {
			for (const path of paths) await this.options.onPasteImagePath!(path);
		} finally {
			this.#pathPastes--;
		}
	}

	/** Type `text` (one line) at the follow-up's caret. */
	#insert(text: string): void {
		const composer = this.composer;
		if (!composer) return;
		const { draft } = composer;
		const line = text.replace(/\r\n?|\n/g, " ");
		this.setDraft({
			text: `${draft.text.slice(0, draft.cursor)}${line}${draft.text.slice(draft.cursor)}`,
			cursor: draft.cursor + line.length,
		});
	}

	// ─── Dictation target (push-to-talk into the follow-up) ─────────────────

	/** Show not-yet-final dictated `text` at the caret, replacing the previous volatile text. */
	setVolatileText(text: string): void {
		const composer = this.composer;
		if (!composer) return;
		const { draft, volatile } = composer;
		const line = text.replace(/\r\n?|\n/g, " ");
		const from = volatile ? Math.min(volatile.from, draft.text.length) : draft.cursor;
		const to = volatile ? Math.min(from + volatile.length, draft.text.length) : from;
		composer.volatile = line ? { from, length: line.length } : undefined;
		this.setDraft({
			text: `${draft.text.slice(0, from)}${line}${draft.text.slice(to)}`,
			cursor: from + line.length,
		});
	}

	clearVolatileText(): void {
		if (this.composer?.volatile) this.setVolatileText("");
	}

	/** Replace the volatile text with the final `text`. */
	commitVolatileText(text: string): void {
		this.clearVolatileText();
		this.#insert(text);
	}

	/** A spoken submit command sends the follow-up. */
	submit(): void {
		void this.submitFollowUp();
	}

	/** Delete `count` UTF-16 units before the caret (the spaces a recognized hold typed). */
	deleteBeforeCursor(count: number): void {
		const draft = this.composer?.draft;
		if (!draft || count <= 0) return;
		const from = Math.max(0, draft.cursor - count);
		this.setDraft({ text: draft.text.slice(0, from) + draft.text.slice(draft.cursor), cursor: from });
	}

	setCaretGlyph(glyph: string | undefined): void {
		this.caretGlyph.set(glyph);
	}

	/** Push-to-talk on the follow-up: a recognized hold swallows its key; a candidate press types now. */
	#holdKey(key: KeyEvent): boolean {
		const hold = this.#spaceHold;
		if (!hold || key.kind === "release") return false;
		const typed = holdText(key);
		const step = hold.process(key.id, typed?.length ?? 0);
		if (step === "swallow") return true;
		if (step !== "type" || typed === undefined) return false;
		this.#insert(typed);
		hold.recordTyped(typed.length);
		return true;
	}

	/** Attach an image to the follow-up; its `[Image #N, WxH]` marker to type, or undefined while none can take it. */
	attachImage(image: ImageContent, dims?: { width: number; height: number }): string | undefined {
		const composer = this.composer;
		if (!composer || this.followUpPending) return undefined;
		composer.images.push(image);
		return formatVisionMarker("image", composer.images.length, dims);
	}

	async submitFollowUp(): Promise<void> {
		const composer = this.composer;
		if (!composer || this.followUpPending) return;
		let question = composer.draft.text.trim();
		if (!question) {
			composer.notice = "Enter a follow-up question.";
			this.touch();
			return;
		}
		const record = this.records.find(record => record.id === composer.recordId);
		if (!record || !this.canFollowUp(record)) {
			composer.notice = "A BTW request is busy. Try again when it finishes.";
			this.touch();
			return;
		}
		this.followUpPending = true;
		composer.notice = "Starting follow-up…";
		this.touch();
		let images: ImageContent[] | undefined;
		if (composer.images.length > 0) {
			const compacted = compactImageMarkers(question, composer.images.length, { byAppearance: true });
			images = compacted ? compacted.keep.map(index => composer.images[index]!) : composer.images;
			if (compacted) question = compacted.text.trim();
		}
		try {
			const accepted = await this.options.onFollowUp!(
				record,
				question,
				composer.abort.signal,
				images?.length ? images : undefined,
			);
			if (this.composer !== composer) return;
			if (accepted) {
				this.composer = undefined;
				this.selectedId = composer.recordId;
				this.focus = "answer";
				this.#jumpToEnd();
			} else {
				composer.notice = "Follow-up was not started. Your draft is kept; ⏎ to retry.";
			}
		} catch {
			if (this.composer === composer)
				composer.notice = "Could not start the follow-up. Your draft is kept; ⏎ to retry.";
		} finally {
			this.followUpPending = false;
			this.touch();
		}
	}

	#sendInject(record: BtwHistoryRecord | undefined): void {
		const inject = this.options.inject;
		if (!record || !inject?.canSend(record)) return;
		inject.send(record);
		this.touch();
	}

	/** Reader scroll by a key's step; a scroll stops following the last row unless it is End. */
	#scrollDetail(by: ScrollRequest["by"]): void {
		const max = Math.max(0, this.detailRows - this.detailHeight);
		const step = Math.max(1, this.detailHeight - 1);
		const next =
			by === "line-up"
				? this.detailScroll - 1
				: by === "line-down"
					? this.detailScroll + 1
					: by === "page-up"
						? this.detailScroll - step
						: by === "page-down"
							? this.detailScroll + step
							: by === "start"
								? 0
								: max;
		this.detailScroll = Math.max(0, Math.min(max, next));
		this.nativeScroll = { by, n: (this.nativeScroll?.n ?? 0) + 1 };
		this.followLatest = by === "end";
	}

	/** A wheel notch: over the list it moves the selection, over the reader it scrolls three rows. */
	wheel(pane: BtwPane, delta: -1 | 1): void {
		if (pane === "list") {
			// The composer holds the topic it was opened for.
			if (this.composer) return;
			this.#select(this.selectedIndex() + delta);
		} else {
			const max = Math.max(0, this.detailRows - this.detailHeight);
			this.detailScroll = Math.max(0, Math.min(max, this.detailScroll + delta * 3));
			this.followLatest = false;
		}
		this.touch();
	}

	/** Terminal keys; true when handled. */
	key(key: KeyEvent): boolean {
		const composer = this.composer;
		if (composer) {
			if (this.#holdKey(key)) return true;
			if (matchesSelectCancel(key)) this.discard();
			else if (getKeybindings().matches(key, "tui.input.submit")) void this.submitFollowUp();
			else {
				// The draft takes every key it edits with; the line keys it leaves scroll the reader above.
				const edited = editLine(composer.draft, key);
				if (edited) this.setDraft(edited);
				else {
					const by = LINE_SCROLL[key.id];
					if (!by) return false;
					this.#scrollDetail(by);
					this.touch();
				}
			}
			return true;
		}
		const record = this.selected();
		const running = this.running(record) ? record : undefined;
		const hides = this.options.escapeHides === true;
		if (matchesSelectCancel(key)) {
			if (running && !hides) this.options.onCancel(running);
			else this.options.onClose();
			return true;
		}
		const id = selectKeyId(key);
		if (hides && id === "x") {
			if (running) this.options.onCancel(running);
			return true;
		}
		if (id === "f" || id === "enter") {
			if (record) this.openFollowUp(record.id);
			return true;
		}
		if (id === "c") {
			if (record && this.canCopy(record)) this.options.onCopy(record);
			return true;
		}
		if (id === "b") {
			if (record && this.canBranch(record)) this.options.onBranch?.(record);
			return true;
		}
		if (this.options.inject && id === this.injectKey) {
			this.#sendInject(record);
			return true;
		}
		if (id === "tab" || id === "shift+tab" || id === "ctrl+/" || id === "ctrl+_") {
			if (this.records.length > 1) this.focus = this.focus === "list" ? "answer" : "list";
		} else if (id === "right") {
			this.focus = "answer";
		} else if (id === "left") {
			if (this.records.length > 1) this.focus = "list";
		} else if (this.focus === "list") {
			const index = this.selectedIndex();
			if (id === "up") this.#select(index - 1);
			else if (id === "down") this.#select(index + 1);
			else if (id === "pageUp") this.#select(index - this.listHeight);
			else if (id === "pageDown") this.#select(index + this.listHeight);
			else if (id === "home") this.#select(0);
			else if (id === "end") this.#select(this.records.length - 1);
			else return false;
		} else {
			const by = LINE_SCROLL[id];
			if (!by) return false;
			this.#scrollDetail(by);
		}
		this.touch();
		return true;
	}

	/** Native footer buttons. */
	action(act: string): void {
		const record = this.selected();
		switch (act) {
			case "close":
				this.options.onClose();
				return;
			case "copy-answer":
				if (record && this.canCopy(record)) this.options.onCopy(record);
				break;
			case "branch":
				if (record && this.canBranch(record)) this.options.onBranch?.(record);
				break;
			case "inject":
				this.#sendInject(record);
				break;
			case "follow-up":
				if (record) this.openFollowUp(record.id);
				break;
			case "stop":
				if (record && this.running(record)) this.options.onCancel(record);
				break;
			case "send":
				void this.submitFollowUp();
				break;
			case "discard":
				this.discard();
				break;
			default:
				return;
		}
		this.touch();
	}

	/** A history row picked natively (`activate` opens its follow-up). */
	pick(item: string, activate: boolean): void {
		if (this.composer) return;
		const index = this.records.findIndex(record => record.id === item);
		if (index === -1) return;
		this.#select(index);
		this.focus = "list";
		if (activate) this.openFollowUp(item);
		this.touch();
	}
}
