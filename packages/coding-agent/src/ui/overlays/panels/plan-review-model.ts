/**
 * The plan review's state and behaviour: the plan as sections with their
 * notes (annotations), the Contents cursor, the approval options and the
 * model slider, the note editor and the note chooser, and the commit that
 * locks the review while the owner works.
 *
 * The terminal face scrolls the plan in a fixed-height box; its geometry at
 * the terminal's size ({@link PlanReviewModel.reference}) decides what the
 * scroll keys, the Contents cursor and the body notes act on. The body's
 * scroll is kept as a share of its range, so every width shows the same
 * place in the plan.
 */
import type { Accessor, TextEdit } from "@oh-my-pi/pi-tui";
import { signal, untrack } from "@oh-my-pi/pi-tui";
import type { MouseEvent } from "@oh-my-pi/pi-tui/driver/contract";
import type { Theme } from "@oh-my-pi/pi-tui/theme/contract";
import type {
	PlanReviewAnnotationState,
	PlanReviewOverlayChoice,
} from "../../../modes/view-model/overlays/plan-review-overlay";
import {
	type AnnotationTarget,
	type BodyAnchor,
	lineContexts,
	nearestOccurrence,
	type PlanFrame,
	planFrame,
	quoteLine,
	quoteRow,
	resolveLineRow,
	sectionAt,
} from "./plan-review-frame";
import { joinPlanSections, type PlanSection, parsePlanSections, sectionDeletionSpan } from "./plan-sections";
import { matchesSelectCancel, selectKeyId } from "../../../config/keybindings/matchers";

export type { PlanReviewAnnotationState, PlanReviewOverlayChoice };

/** The model-tier slider under the plan. */
export interface PlanReviewSlider {
	readonly caption?: string;
	readonly index: number;
	readonly segments: readonly { readonly label: string; readonly detail?: string }[];
	onChange?(index: number): void;
}

/** What the review reports to its owner. */
export interface PlanReviewCallbacks {
	/** An option was committed (an approval choice or Refine); the review stays up, locked. */
	onPick(id: string): void;
	onCancel(): void;
	/** Save is offered only with this. */
	onSave?(content: string): void;
	onCopyPlan?(content: string): void | Promise<void>;
	onExternalEditor?(): void;
	/** Edit the note draft in an external editor; `commit` puts the result back (null: unchanged). */
	onAnnotationExternalEditor?(draft: string, commit: (text: string | null) => void): void;
	onPlanEdited?(content: string): void;
	/** The Refine feedback ("" when the plan has none). */
	onFeedbackChange?(feedback: string): void;
	onAnnotationStateChange?(state: PlanReviewAnnotationState): void;
}

/** How the review is set up. */
export interface PlanReviewOptions {
	readonly options: readonly PlanReviewOverlayChoice[];
	/** Offered (and preselected) while the plan has feedback. */
	readonly refine?: { readonly id: string; readonly label: string };
	/** Shown above the options. */
	readonly promptTitle?: string;
	/** Replaces the cancel hint at the end of the key hints. */
	readonly helpText?: string;
	readonly initialIndex?: number;
	readonly slider?: PlanReviewSlider;
	/** The external editor's key as the hints name it (`ctrl+e`). */
	readonly externalEditorLabel?: string;
	readonly annotationState?: PlanReviewAnnotationState;
	/** Key id that cancels (default `escape`). */
	readonly cancelKey?: string;
	/** Key id that opens the external editor (none by default). */
	readonly externalEditorKey?: string;
}

/** The terminal the review is drawn on. */
export interface PlanReviewTerminal {
	readonly theme: Accessor<Theme>;
	/** The terminal's size: the geometry keys and clicks act on. */
	readonly size: Accessor<{ readonly columns: number; readonly rows: number }>;
}

export type PlanFocus = "toc" | "body" | "actions";

/** A note on the plan. */
export interface PlanAnnotation {
	readonly id: string;
	note: string;
	target: AnnotationTarget;
}

/** A section with its notes. */
export interface ReviewSection extends PlanSection {
	annotations: PlanAnnotation[];
}

/** One option row: Refine, an approval choice or Save. */
export type PlanOption =
	| { readonly kind: "refine"; readonly id: string; readonly label: string }
	| { readonly kind: "approve"; readonly choice: PlanReviewOverlayChoice }
	| { readonly kind: "save" };

/** A note picked by section and position. */
export interface NoteRef {
	readonly sectionIndex: number;
	readonly annotationIndex: number;
}

/** What a new note is on: a body row or a whole section (`row` null). */
export type NoteTarget = BodyAnchor | { readonly sectionIndex: number; readonly row: null; readonly context: null };

/** A comment as the native document shows it. */
export interface DocComment {
	readonly id: string;
	readonly quote: string;
	readonly at: number;
	readonly note: string;
}

const MAX_UNDO = 100;
const SIDEBAR_MIN_HEADINGS = 2;
const HEADING_LINE = /^(#{1,6}[ \t]+)(.+?)[ \t]*#*[ \t]*$/;
const WHEEL_ROWS = 3;
const FAST_ROWS = 5;

interface UndoEntry {
	readonly text: string;
	readonly annotations: PlanAnnotation[][];
	readonly deleted: string[];
}

export class PlanReviewModel {
	/** Bumped on every change the faces draw. */
	readonly rev = signal(0);
	sections: ReviewSection[] = [];
	/** Section indices listed in the Contents (headings but the title). */
	toc: number[] = [];
	/** The section holding the plan's title heading (left out of the Contents and the document), or -1. */
	titleIndex = -1;
	tocBaseLevel = 1;
	deleted: string[] = [];
	choices: readonly PlanReviewOverlayChoice[];
	readonly refine: { readonly id: string; readonly label: string } | undefined;
	readonly promptTitle: string | undefined;
	readonly helpText: string | undefined;
	readonly externalEditorLabel: string | undefined;
	readonly cancelKey: string;
	readonly slider: PlanReviewSlider | undefined;
	sliderIndex = 0;
	hasFeedback = false;
	selected: number;
	focus: PlanFocus = "actions";
	/** The Contents cursor while the Contents has focus (else it follows the scroll). */
	tocCursor = 0;
	/** Where the body is scrolled, as a share of its range. */
	progress = 0;
	hovered: number | undefined;
	committed = false;
	committedLabel: string | undefined;
	/** The last successful local export, shown above the terminal review's key hints. */
	saveNotice: string | undefined;
	/** The note editor (open while annotating). */
	annotating = false;
	draft = { text: "", cursor: 0 };
	target: NoteTarget | undefined;
	editing: NoteRef | undefined;
	chooser: { entries: NoteRef[]; selected: number } | undefined;
	/** The last Contents jump (`n` counts them, so each one reveals its heading again natively). */
	jump: { section: number; n: number } | undefined;
	/** The host draws the native dock (its keys follow it). */
	nativeDock = false;
	/** The host draws the native document (notes are its comments). */
	nativeDoc = true;
	#undo: UndoEntry[] = [];
	/** A delete or undo moves the body to the Contents cursor's section once, when next drawn. */
	#pendingScrub = false;
	#seq = 0;
	#rev = 0;

	constructor(
		plan: string,
		readonly options: PlanReviewOptions,
		readonly callbacks: PlanReviewCallbacks,
		readonly terminal: PlanReviewTerminal,
	) {
		this.choices = options.options;
		this.refine = options.refine;
		this.promptTitle = options.promptTitle;
		this.helpText = options.helpText;
		this.externalEditorLabel = options.externalEditorLabel;
		this.cancelKey = options.cancelKey ?? "escape";
		if (options.slider && options.slider.segments.length > 0) {
			this.slider = options.slider;
			this.sliderIndex = Math.max(0, Math.min(options.slider.index, options.slider.segments.length - 1));
		}
		this.selected = this.#coerce(options.initialIndex ?? 0);
		this.#setSections(plan);
		this.#restore(options.annotationState);
		if ((options.annotationState?.annotations.length ?? 0) > 0) this.#feedbackChanged();
	}

	/** Redraw both faces. */
	touch(): void {
		this.rev.set(++this.#rev);
	}

	/** Report a completed export while the terminal review obscures the transcript. */
	setSaveNotice(message: string): void {
		this.saveNotice = message;
		this.touch();
	}

	// ─── Geometry ───────────────────────────────────────────────────────────

	/** The terminal face at `width` × `height`. */
	frame(width: number, height: number, theme: Theme): PlanFrame {
		this.#settle();
		return planFrame(this, width, height, theme);
	}

	/** Run the pending scroll to the Contents cursor (deletes and undos made since the last draw). */
	#settle(): void {
		if (!this.#pendingScrub) return;
		this.#pendingScrub = false;
		this.#scrubToToc();
	}

	/** The last Contents jump, as the native document reveals it. */
	currentJump(): { section: number; n: number } | undefined {
		this.#settle();
		return this.jump;
	}

	/** The terminal face at the terminal's size: what keys and clicks act on. */
	reference(): PlanFrame {
		const size = untrack(this.terminal.size);
		return this.frame(size.columns, size.rows, untrack(this.terminal.theme));
	}

	/** The body's scroll offset in a frame whose body scrolls `maxOffset` rows. */
	offsetIn(frame: { readonly maxOffset: number }): number {
		return frame.maxOffset > 0 ? Math.round(this.progress * frame.maxOffset) : 0;
	}

	#scrollTo(frame: PlanFrame, offset: number): void {
		const clamped = Math.max(0, Math.min(Math.trunc(offset), frame.maxOffset));
		if (frame.maxOffset > 0) this.progress = clamped / frame.maxOffset;
	}

	#scrollBy(delta: number): void {
		const frame = this.reference();
		this.#scrollTo(frame, this.offsetIn(frame) + delta);
	}

	/** The Contents entry of the last section starting at or above the scroll (`offsets`: each section's first body row). */
	scrolledTocPos(offsets: readonly number[], maxOffset: number): number {
		if (this.toc.length === 0) return 0;
		const offset = this.offsetIn({ maxOffset });
		let current = 0;
		for (let i = 0; i < this.sections.length; i++) {
			if ((offsets[i] ?? 0) <= offset) current = i;
			else break;
		}
		let pos = 0;
		for (let p = 0; p < this.toc.length; p++) {
			if (this.toc[p]! <= current) pos = p;
			else break;
		}
		return pos;
	}

	#derivedTocCursor(frame: PlanFrame): number {
		return this.scrolledTocPos(frame.body.offsets, frame.maxOffset);
	}

	/** The Contents cursor now (following the scroll outside the Contents). */
	currentTocCursor(): number {
		return this.focus === "toc" ? this.tocCursor : this.#derivedTocCursor(this.reference());
	}

	/** Whether the Contents is offered: two or more entries, and no comments in the native document's margin. */
	sidebarShown(): boolean {
		return this.toc.length >= SIDEBAR_MIN_HEADINGS && !(this.nativeDoc && this.commentCount() > 0);
	}

	commentCount(): number {
		let count = 0;
		for (const section of this.sections) count += section.annotations.length;
		return count;
	}

	// ─── Sections ───────────────────────────────────────────────────────────

	#setSections(plan: string): void {
		this.sections = parsePlanSections(plan).map(section => ({ ...section, annotations: [] }));
		this.#rebuildToc();
		this.tocCursor = Math.min(this.tocCursor, Math.max(0, this.toc.length - 1));
	}

	#rebuildToc(): void {
		const headings: number[] = [];
		this.sections.forEach((section, i) => {
			if (section.level >= 1) headings.push(i);
		});
		const top = Math.min(...headings.map(i => this.sections[i]!.level));
		const topLevel = headings.filter(i => this.sections[i]!.level === top);
		// A lone shallowest heading opening the plan is its title, not a section to list.
		this.titleIndex = topLevel.length === 1 && headings[0] === topLevel[0] ? topLevel[0]! : -1;
		this.toc = headings.filter(i => i !== this.titleIndex);
		this.tocBaseLevel = this.toc.length > 0 ? Math.min(...this.toc.map(i => this.sections[i]!.level)) : 1;
	}

	/** The plan source as the sections hold it. */
	source(): string {
		return this.sections.map(section => section.raw).join("");
	}

	/** The plan as saved or copied. */
	content(): string {
		return joinPlanSections(this.sections);
	}

	sectionStarts(): number[] {
		const starts: number[] = [];
		let offset = 0;
		for (const section of this.sections) {
			starts.push(offset);
			offset += section.raw.length;
		}
		return starts;
	}

	#paths(): string[][] {
		const stack: { level: number; title: string }[] = [];
		return this.sections.map(section => {
			if (section.level < 1) return [];
			while (stack.length > 0 && stack[stack.length - 1]!.level >= section.level) stack.pop();
			stack.push(section);
			return stack.map(entry => entry.title);
		});
	}

	#hash(section: PlanSection): string {
		return `${section.raw.length}:${Bun.hash(section.raw).toString(16)}`;
	}

	/** The title heading's line and where it starts, when the plan has a title. */
	titleLine(): { start: number; line: string } | undefined {
		const section = this.sections[this.titleIndex];
		if (!section) return undefined;
		const newline = section.raw.indexOf("\n");
		return {
			start: this.sectionStarts()[this.titleIndex]!,
			line: newline < 0 ? section.raw : section.raw.slice(0, newline + 1),
		};
	}

	/** The native document: the plan without its title line. */
	docText(): string {
		const title = this.titleLine();
		const source = this.source();
		return title ? source.slice(0, title.start) + source.slice(title.start + title.line.length) : source;
	}

	/** Every note as a comment on the native document. */
	docComments(): DocComment[] {
		const title = this.titleLine();
		const starts = this.sectionStarts();
		const comments: DocComment[] = [];
		this.sections.forEach((section, index) => {
			for (const annotation of section.annotations) {
				const target = annotation.target;
				const anchor =
					target.kind === "quote"
						? { quote: target.quote, at: starts[index]! + target.at }
						: this.#noteAnchor(index, starts[index]!, target);
				let at = anchor.at;
				if (title && at >= title.start)
					at = at < title.start + title.line.length ? title.start : at - title.line.length;
				comments.push({ id: annotation.id, quote: anchor.quote, at, note: annotation.note });
			}
		});
		return comments;
	}

	/**
	 * Where a line or section note sits in the native document: its line when
	 * the source has it verbatim, else the section's heading title (or its
	 * first line of text under the title heading or in the preamble).
	 */
	#noteAnchor(index: number, start: number, target: AnnotationTarget): { quote: string; at: number } {
		const raw = this.sections[index]!.raw;
		if (target.kind === "line") {
			const line =
				target.contextTruncated && target.context.endsWith("…") ? target.context.slice(0, -1) : target.context;
			const probe = line
				.replace(/^[\s•◦▪‣·*+>-]+/, "")
				.replace(/^\d+[.)]\s+/, "")
				.trim();
			const found = probe ? raw.indexOf(probe) : -1;
			if (found >= 0) return { quote: probe, at: start + found };
		}
		const newline = raw.indexOf("\n");
		const isTitle = index === this.titleIndex;
		const heading = isTitle ? null : HEADING_LINE.exec(newline < 0 ? raw : raw.slice(0, newline));
		if (heading) return { quote: heading[2]!, at: start + heading[1]!.length };
		const bodyStart = isTitle ? (newline < 0 ? raw.length : newline + 1) : 0;
		const line = /\S[^\n]*/.exec(raw.slice(bodyStart));
		if (!line) return { quote: "", at: start };
		return { quote: line[0].trimEnd(), at: start + bodyStart + line.index };
	}

	// ─── Notes ──────────────────────────────────────────────────────────────

	#newId(): string {
		return `c${++this.#seq}`;
	}

	/** The notes as the owner keeps them between reviews. */
	annotationState(): PlanReviewAnnotationState {
		const paths = this.#paths();
		const annotations: PlanReviewAnnotationState["annotations"] = [];
		this.sections.forEach((section, index) => {
			for (const annotation of section.annotations) {
				annotations.push({
					section: { index, title: section.title, path: paths[index]!, contentHash: this.#hash(section) },
					target: { ...annotation.target },
					note: annotation.note,
				});
			}
		});
		return { annotations };
	}

	#restore(state: PlanReviewAnnotationState | undefined): void {
		if (!state || !Array.isArray(state.annotations)) return;
		const paths = this.#paths();
		const hashes = this.sections.map(section => this.#hash(section));
		const starts = this.sectionStarts();
		const source = this.source();
		const theme = untrack(this.terminal.theme);
		for (const entry of state.annotations) {
			if (!entry?.section || !entry.target || typeof entry.note !== "string") continue;
			if (typeof entry.section.title !== "string") continue;
			const note = entry.note.trim();
			if (!note) continue;
			const storedIndex = Number.isInteger(entry.section.index) ? entry.section.index : -1;
			const storedPath = entry.section.path;
			let candidates: number[];
			if (
				Array.isArray(storedPath) &&
				storedPath.every(segment => typeof segment === "string") &&
				typeof entry.section.contentHash === "string"
			) {
				candidates = [];
				this.sections.forEach((section, i) => {
					const path = paths[i]!;
					if (
						section.title === entry.section.title &&
						hashes[i] === entry.section.contentHash &&
						path.length === storedPath.length &&
						path.every((segment, n) => segment === storedPath[n])
					)
						candidates.push(i);
				});
			} else {
				candidates =
					storedIndex >= 0 &&
					storedIndex < this.sections.length &&
					this.sections[storedIndex]!.title === entry.section.title
						? [storedIndex]
						: [];
			}
			if (candidates.length === 0) continue;
			const index = candidates.reduce((best, candidate) =>
				Math.abs(candidate - storedIndex) < Math.abs(best - storedIndex) ? candidate : best,
			);
			const section = this.sections[index]!;
			const target = entry.target;
			if (target.kind === "section") {
				if (section.level >= 1) section.annotations.push({ id: this.#newId(), note, target: { kind: "section" } });
				continue;
			}
			if (target.kind === "quote") {
				if (typeof target.quote !== "string" || !target.quote || !Number.isFinite(target.at)) continue;
				const stored = starts[index]! + Math.max(0, Math.trunc(target.at));
				const found = source.startsWith(target.quote, stored)
					? stored
					: nearestOccurrence(source, target.quote, stored);
				if (found < 0) continue;
				const owner = sectionAt(starts, found);
				this.sections[owner]!.annotations.push({
					id: this.#newId(),
					note,
					target: { kind: "quote", quote: target.quote, at: found - starts[owner]! },
				});
				continue;
			}
			if (target.kind !== "line" || !Number.isFinite(target.row) || typeof target.context !== "string") continue;
			const contexts = lineContexts(section.raw, theme);
			const row = resolveLineRow(
				target.row,
				{ text: target.context, truncated: target.contextTruncated === true },
				contexts,
			);
			if (row < 0) continue;
			section.annotations.push({
				id: this.#newId(),
				note,
				target: { kind: "line", row, context: contexts[row]!.text, contextTruncated: contexts[row]!.truncated },
			});
		}
	}

	#pushUndo(): void {
		if (this.#undo.length >= MAX_UNDO) this.#undo.shift();
		this.#undo.push({
			text: this.content(),
			annotations: this.sections.map(section =>
				section.annotations.map(annotation => ({ ...annotation, target: { ...annotation.target } })),
			),
			deleted: [...this.deleted],
		});
	}

	#feedbackChanged(): void {
		this.callbacks.onAnnotationStateChange?.(this.annotationState());
		const annotated = this.sections.filter(section => section.annotations.length > 0);
		this.#setHasFeedback(annotated.length > 0 || this.deleted.length > 0);
		if (!this.hasFeedback) {
			this.callbacks.onFeedbackChange?.("");
			return;
		}
		let feedback = "Refinement feedback on the plan:\n";
		if (this.deleted.length > 0) {
			feedback += "\nRemove these sections:\n";
			for (const title of this.deleted) feedback += `- ${title}\n`;
		}
		for (const section of annotated) {
			feedback += `\n## ${section.title || "Plan preamble"}\n`;
			for (const annotation of section.annotations) {
				const target = annotation.target;
				if (target.kind === "line") feedback += `> Line: ${target.context}\n`;
				else if (target.kind === "quote") feedback += `> "${quoteLine(target.quote)}"\n`;
				if (!annotation.note.includes("\n")) feedback += `- ${annotation.note}\n`;
				else {
					let fence = "```";
					while (annotation.note.includes(fence)) fence += "`";
					feedback += `${fence}md\n${annotation.note}\n${fence}\n`;
				}
			}
		}
		this.callbacks.onFeedbackChange?.(feedback);
	}

	#setHasFeedback(hasFeedback: boolean): void {
		if (hasFeedback === this.hasFeedback) return;
		this.hasFeedback = hasFeedback;
		if (!this.refine) return;
		// Refine arrives preselected; when it leaves, the cursor keeps its option.
		this.selected = hasFeedback ? 0 : this.#coerce(Math.max(0, this.selected - 1));
		this.hovered = undefined;
	}

	/** Replace the plan with `next`, carrying every note: by offset, by quote, else by heading. */
	#replaceText(next: string): void {
		const previous = this.source();
		const oldStarts = this.sectionStarts();
		const oldPaths = this.#paths();
		const carried = this.sections.flatMap((section, index) =>
			section.annotations.map(annotation => ({ annotation, section, index })),
		);
		const limit = Math.min(previous.length, next.length);
		let prefix = 0;
		while (prefix < limit && previous.charCodeAt(prefix) === next.charCodeAt(prefix)) prefix++;
		let suffix = 0;
		while (
			suffix < limit - prefix &&
			previous.charCodeAt(previous.length - 1 - suffix) === next.charCodeAt(next.length - 1 - suffix)
		)
			suffix++;
		const delta = next.length - previous.length;
		const editEnd = previous.length - suffix;
		const map = (offset: number): number => (offset <= prefix ? offset : offset >= editEnd ? offset + delta : prefix);
		this.#setSections(next);
		const starts = this.sectionStarts();
		const paths = this.#paths();
		const theme = untrack(this.terminal.theme);
		for (const { annotation, section: old, index } of carried) {
			const target = annotation.target;
			if (target.kind === "quote") {
				const oldAt = oldStarts[index]! + target.at;
				const untouched = oldAt + target.quote.length <= prefix || oldAt >= editEnd;
				const found = untouched ? map(oldAt) : nearestOccurrence(next, target.quote, map(oldAt));
				const at = found >= 0 ? found : Math.min(map(oldAt), next.length);
				const owner = sectionAt(starts, at);
				this.sections[owner]?.annotations.push({ ...annotation, target: { ...target, at: at - starts[owner]! } });
				continue;
			}
			const mappedStart = map(oldStarts[index]!);
			const oldPath = oldPaths[index]!;
			let owner = -1;
			this.sections.forEach((section, i) => {
				const path = paths[i]!;
				if (
					section.title !== old.title ||
					section.level !== old.level ||
					path.length !== oldPath.length ||
					!path.every((segment, n) => segment === oldPath[n])
				)
					return;
				if (owner < 0 || Math.abs(starts[i]! - mappedStart) < Math.abs(starts[owner]! - mappedStart)) owner = i;
			});
			if (owner < 0) owner = sectionAt(starts, mappedStart);
			const section = this.sections[owner];
			if (!section) continue;
			if (target.kind === "line") {
				const contexts = lineContexts(section.raw, theme);
				const row = resolveLineRow(
					target.row,
					{ text: target.context, truncated: target.contextTruncated === true },
					contexts,
				);
				if (row >= 0) {
					section.annotations.push({
						...annotation,
						target: {
							kind: "line",
							row,
							context: contexts[row]!.text,
							contextTruncated: contexts[row]!.truncated,
						},
					});
					continue;
				}
			}
			section.annotations.push({ ...annotation, target: { kind: "section" } });
		}
	}

	// ─── Options ────────────────────────────────────────────────────────────

	/** The option rows: Refine (while the plan has feedback), the approval choices, Save. */
	entries(): PlanOption[] {
		const entries: PlanOption[] = [];
		if (this.hasFeedback && this.refine) entries.push({ kind: "refine", ...this.refine });
		for (const choice of this.choices) entries.push({ kind: "approve", choice });
		if (this.callbacks.onSave) entries.push({ kind: "save" });
		return entries;
	}

	isDisabled(index: number): boolean {
		const entry = this.entries()[index];
		return entry?.kind === "approve" && entry.choice.disabled !== undefined;
	}

	/** `index` clamped, then moved to the nearest enabled option. */
	#coerce(index: number): number {
		const max = this.entries().length - 1;
		if (max < 0) return -1;
		const clamped = Math.max(0, Math.min(index, max));
		if (!this.isDisabled(clamped)) return clamped;
		for (let i = clamped + 1; i <= max; i++) if (!this.isDisabled(i)) return i;
		for (let i = clamped - 1; i >= 0; i--) if (!this.isDisabled(i)) return i;
		return clamped;
	}

	#firstEnabled(): number {
		const count = this.entries().length;
		for (let i = 0; i < count; i++) if (!this.isDisabled(i)) return i;
		return -1;
	}

	#moveSelection(delta: number): void {
		const max = this.entries().length - 1;
		if (max < 0) return;
		let index = this.selected;
		for (;;) {
			const next = Math.max(0, Math.min(index + delta, max));
			if (next === index) return;
			index = next;
			if (!this.isDisabled(index)) {
				this.selected = index;
				return;
			}
		}
	}

	#moveSlider(delta: number): void {
		const slider = this.slider;
		if (!slider) return;
		const next = Math.max(0, Math.min(slider.segments.length - 1, this.sliderIndex + delta));
		if (next === this.sliderIndex) return;
		this.sliderIndex = next;
		slider.onChange?.(next);
	}

	/** An option's label and its dim meta. */
	entryLabel(entry: PlanOption): { label: string; meta?: string } {
		if (entry.kind === "approve") return { label: entry.choice.label, meta: entry.choice.meta };
		return { label: entry.kind === "refine" ? entry.label : "Save" };
	}

	#commit(id: string, label: string): void {
		this.committed = true;
		this.committedLabel = label;
		this.callbacks.onPick(id);
	}

	#runEntry(index: number): void {
		const entry = this.entries()[index];
		if (!entry || this.isDisabled(index)) return;
		if (entry.kind === "save") this.callbacks.onSave?.(this.content());
		else if (entry.kind === "refine") this.#commit(entry.id, entry.label);
		else this.#commit(entry.choice.id, entry.choice.label);
	}

	#runMain(): void {
		if (this.hasFeedback && this.refine) {
			this.#commit(this.refine.id, this.refine.label);
			return;
		}
		const choice = this.choices.find(candidate => candidate.disabled === undefined);
		if (choice) this.#commit(choice.id, choice.label);
	}

	#cancel(): void {
		this.committed = true;
		this.callbacks.onCancel();
	}

	// ─── Owner API ──────────────────────────────────────────────────────────

	/** Swap the plan (an external edit came back): notes carried, scroll and Contents back at the top. */
	setPlanContent(plan: string): void {
		const state = this.annotationState();
		this.#setSections(plan);
		this.#restore(state);
		this.progress = 0;
		this.tocCursor = 0;
		this.deleted = [];
		this.#undo = [];
		this.#feedbackChanged();
		this.touch();
	}

	setSliderIndex(index: number): void {
		if (this.committed || !this.slider) return;
		this.#moveSlider(index - this.sliderIndex);
		this.touch();
	}

	/** New approval choices; the cursor leaves a now-disabled row. */
	setChoices(choices: readonly PlanReviewOverlayChoice[]): void {
		this.choices = choices;
		this.selected = this.#coerce(this.selected);
		if (this.hovered !== undefined && this.isDisabled(this.hovered)) this.hovered = undefined;
		this.touch();
	}

	/** Commit an answer from outside: an enabled choice, or Refine. False when nothing was committed. */
	selectOption(id: string): boolean {
		if (this.committed) return false;
		if (this.refine?.id === id) {
			this.#commit(id, this.refine.label);
			this.touch();
			return true;
		}
		const choice = this.choices.find(candidate => candidate.id === id);
		if (!choice || choice.disabled !== undefined) return false;
		this.#commit(choice.id, choice.label);
		this.touch();
		return true;
	}

	/** Which host faces are native (their keys follow the native dock). */
	setNativeHost(host: { dock: boolean; doc: boolean }): void {
		this.nativeDock = host.dock;
		this.nativeDoc = host.doc;
		this.touch();
	}

	// ─── Keys ───────────────────────────────────────────────────────────────

	/** A key on the review; false when it is the note editor's. */
	key(id: string, text: string | undefined, raw: string): boolean {
		if (this.committed) return true;
		const handled = this.#key(id, text, raw);
		this.touch();
		return handled;
	}

	/** The review's cancel key (the app's interrupt key) or a selector cancel binding (Esc, Ctrl+C). */
	#isCancel(id: string): boolean {
		return id === this.cancelKey || matchesSelectCancel(id);
	}

	#key(id: string, text: string | undefined, raw: string): boolean {
		if (this.chooser) {
			this.#chooserKey(selectKeyId(id), text);
			return true;
		}
		if (this.annotating) {
			if (this.options.externalEditorKey === id && this.callbacks.onAnnotationExternalEditor) {
				this.callbacks.onAnnotationExternalEditor(this.draft.text, next => {
					if (next !== null && this.annotating) {
						this.draft = { text: next, cursor: next.length };
						this.touch();
					}
				});
				return true;
			}
			if (this.#isCancel(id)) {
				this.#closeEditor();
				return true;
			}
			if (id === "enter" && raw !== "\n") {
				this.#submitNote(this.draft.text);
				return true;
			}
			return false;
		}
		if (this.#isCancel(id)) {
			this.#cancel();
			return true;
		}
		// List keys follow the selector bindings (`tui.select.*`).
		id = selectKeyId(id);
		if (this.nativeDock) {
			this.#dockKey(id, text, raw);
			return true;
		}
		if (this.focus !== "actions" && text === "u") {
			this.#undoLast();
			return true;
		}
		if (this.focus !== "actions" && text === "e") {
			this.#editNote();
			return true;
		}
		if (this.options.externalEditorKey === id && this.callbacks.onExternalEditor) {
			this.callbacks.onExternalEditor();
			return true;
		}
		if (this.callbacks.onCopyPlan && text === "c") {
			void this.callbacks.onCopyPlan(this.content());
			return true;
		}
		if (id === "tab") this.#cycle(1);
		else if (id === "shift+tab") this.#cycle(-1);
		else if (this.focus === "actions") this.#actionsKey(id, text);
		else if (this.focus === "body") this.#bodyKey(id, text);
		else this.#tocKey(id, text);
		return true;
	}

	#isUp(id: string, text: string | undefined): boolean {
		return id === "up" || text === "k";
	}

	#isDown(id: string, text: string | undefined): boolean {
		return id === "down" || text === "j";
	}

	/** Keys under the native dock: Enter runs the main button, ←/→ the model, ↑/↓/d the Contents, u undoes. */
	#dockKey(id: string, text: string | undefined, raw: string): void {
		if (id === "enter" || raw === "\n") return this.#runMain();
		if (id === "left") return this.#moveSlider(-1);
		if (id === "right") return this.#moveSlider(1);
		if (text === "u") return this.#undoLast();
		if (!this.sidebarShown()) return;
		this.#enterToc();
		if (this.#isUp(id, text)) this.#moveToc(-1);
		else if (this.#isDown(id, text)) this.#moveToc(1);
		else if (text === "d" || id === "delete") this.#deleteSection();
		else if (!this.nativeDoc && text === "a") this.#annotateSection();
		else if (!this.nativeDoc && text === "e") this.#editNote();
	}

	#cycle(direction: number): void {
		const regions: PlanFocus[] = this.sidebarShown() ? ["toc", "body", "actions"] : ["body", "actions"];
		const current = regions.indexOf(this.focus);
		const base = current < 0 ? regions.length - 1 : current;
		this.#setFocus(regions[(base + direction + regions.length) % regions.length]!);
	}

	#setFocus(focus: PlanFocus): void {
		if (focus === "toc") this.tocCursor = this.#derivedTocCursor(this.reference());
		this.focus = focus;
	}

	/** Focus the Contents keeping the cursor it showed. */
	#enterToc(): void {
		if (this.focus !== "toc") this.tocCursor = this.#derivedTocCursor(this.reference());
		this.focus = "toc";
	}

	#actionsKey(id: string, text: string | undefined): void {
		const left = id === "left" || (this.slider !== undefined && text === "h");
		const right = id === "right" || (this.slider !== undefined && text === "l");
		if (left) return this.#moveSlider(-1);
		if (right) return this.#moveSlider(1);
		if (this.#isUp(id, text)) {
			if (this.selected === this.#firstEnabled()) this.#setFocus("body");
			else this.#moveSelection(-1);
			return;
		}
		if (this.#isDown(id, text)) return this.#moveSelection(1);
		if (id === "enter") return this.#runEntry(this.selected);
		this.#scrollKey(id, text);
	}

	#bodyKey(id: string, text: string | undefined): void {
		if (text === "a") return this.#annotateBody();
		if (id === "left" || text === "h") {
			if (this.sidebarShown()) this.#setFocus("toc");
			return;
		}
		if (id === "right" || text === "l" || id === "enter") return this.#setFocus("actions");
		if (this.#isUp(id, text)) {
			const frame = this.reference();
			if (this.offsetIn(frame) <= 0 && this.sidebarShown()) this.#setFocus("toc");
			else this.#scrollTo(frame, this.offsetIn(frame) - 1);
			return;
		}
		if (this.#isDown(id, text)) {
			const frame = this.reference();
			if (this.offsetIn(frame) >= frame.maxOffset) this.#setFocus("actions");
			else this.#scrollTo(frame, this.offsetIn(frame) + 1);
			return;
		}
		this.#scrollKey(id, text);
	}

	/** Paging and fast keys shared by the body and the options. */
	#scrollKey(id: string, text: string | undefined): void {
		const frame = this.reference();
		const offset = this.offsetIn(frame);
		switch (id) {
			case "shift+up":
				return this.#scrollTo(frame, offset - FAST_ROWS);
			case "shift+down":
				return this.#scrollTo(frame, offset + FAST_ROWS);
			case "up":
				return this.#scrollTo(frame, offset - 1);
			case "down":
				return this.#scrollTo(frame, offset + 1);
			case "pageUp":
				return this.#scrollTo(frame, offset - Math.max(1, frame.regionRows - 1));
			case "pageDown":
				return this.#scrollTo(frame, offset + Math.max(1, frame.regionRows - 1));
			case "home":
				this.progress = 0;
				return;
			case "end":
				this.progress = 1;
				return;
		}
		if (text === "g") this.progress = 0;
		else if (text === "G") this.progress = 1;
	}

	#tocKey(id: string, text: string | undefined): void {
		if (this.#isUp(id, text)) return this.#moveToc(-1);
		if (this.#isDown(id, text)) {
			if (this.tocCursor >= this.toc.length - 1) this.#setFocus("actions");
			else this.#moveToc(1);
			return;
		}
		if (id === "right" || text === "l" || id === "enter") return this.#setFocus("body");
		if (text === "d" || id === "delete") return this.#deleteSection();
		if (text === "a") this.#annotateSection();
	}

	#moveToc(delta: number): void {
		if (this.toc.length === 0) return;
		const next = Math.max(0, Math.min(this.toc.length - 1, this.tocCursor + delta));
		if (next === this.tocCursor) return;
		this.tocCursor = next;
		this.#scrubToToc();
	}

	/** Scroll the body to the Contents cursor's heading. */
	#scrubToToc(): void {
		const section = this.toc[this.tocCursor];
		if (section === undefined) return;
		this.jump = { section, n: (this.jump?.n ?? 0) + 1 };
		const frame = this.reference();
		const offset = frame.body.offsets[section];
		if (offset !== undefined) this.#scrollTo(frame, offset);
	}

	#deleteSection(): void {
		const index = this.toc[this.tocCursor];
		if (index === undefined) return;
		const span = sectionDeletionSpan(this.sections, index);
		if (span.length === 0) return;
		this.#pushUndo();
		for (const i of span) {
			const section = this.sections[i]!;
			if (section.level >= 1 && section.title) this.deleted.push(section.title);
		}
		for (let i = span.length - 1; i >= 0; i--) this.sections.splice(span[i]!, 1);
		this.#rebuildToc();
		this.tocCursor = Math.min(this.tocCursor, Math.max(0, this.toc.length - 1));
		this.callbacks.onPlanEdited?.(this.content());
		this.#feedbackChanged();
		this.#pendingScrub = true;
	}

	#undoLast(): void {
		const entry = this.#undo.pop();
		if (!entry) return;
		this.#setSections(entry.text);
		this.sections.forEach((section, i) => {
			section.annotations = entry.annotations[i]?.map(annotation => ({ ...annotation })) ?? [];
		});
		this.deleted = [...entry.deleted];
		this.tocCursor = Math.min(this.tocCursor, Math.max(0, this.toc.length - 1));
		this.callbacks.onPlanEdited?.(this.content());
		this.#feedbackChanged();
		this.#pendingScrub = true;
	}

	// ─── Note editor ────────────────────────────────────────────────────────

	#annotateSection(): void {
		const sectionIndex = this.toc[this.tocCursor];
		if (sectionIndex === undefined) return;
		this.#openEditor({ sectionIndex, row: null, context: null });
	}

	/** The body row at the top of the terminal's view. */
	#topAnchor(): BodyAnchor | undefined {
		const frame = this.reference();
		const anchors = frame.body.anchors;
		if (anchors.length === 0) return undefined;
		return anchors[Math.max(0, Math.min(anchors.length - 1, this.offsetIn(frame)))];
	}

	#annotateBody(): void {
		const anchor = this.#topAnchor();
		if (anchor) this.#openEditor(anchor);
	}

	#openEditor(target: NoteTarget): void {
		this.target = target;
		this.editing = undefined;
		this.annotating = true;
		this.draft = { text: "", cursor: 0 };
	}

	#openNote(ref: NoteRef): void {
		const annotation = this.sections[ref.sectionIndex]?.annotations[ref.annotationIndex];
		if (!annotation) return;
		this.chooser = undefined;
		this.editing = ref;
		const target = annotation.target;
		this.target =
			target.kind === "line"
				? {
						sectionIndex: ref.sectionIndex,
						row: target.row,
						context: target.context,
						contextTruncated: target.contextTruncated === true,
					}
				: { sectionIndex: ref.sectionIndex, row: null, context: null };
		this.annotating = true;
		this.draft = { text: annotation.note, cursor: annotation.note.length };
	}

	#closeEditor(): void {
		this.annotating = false;
		this.target = undefined;
		this.editing = undefined;
		this.draft = { text: "", cursor: 0 };
	}

	/** An edit of the note draft. */
	editDraft(edit: TextEdit): void {
		if (!this.annotating || edit.len !== this.draft.text.length) return;
		this.draft = {
			text: `${this.draft.text.slice(0, edit.from)}${edit.text}${this.draft.text.slice(edit.to)}`,
			cursor: edit.cursor,
		};
		this.touch();
	}

	#submitNote(value: string): void {
		const note = value.trim();
		const target = this.target;
		const editing = this.editing;
		this.#closeEditor();
		if (editing) {
			const section = this.sections[editing.sectionIndex];
			const annotation = section?.annotations[editing.annotationIndex];
			if (!section || !annotation) return;
			this.#pushUndo();
			if (note) annotation.note = note;
			else section.annotations.splice(editing.annotationIndex, 1);
			this.#feedbackChanged();
			return;
		}
		if (!note || !target) return;
		const section = this.sections[target.sectionIndex];
		if (!section) return;
		this.#pushUndo();
		section.annotations.push({
			id: this.#newId(),
			note,
			target:
				target.row === null
					? { kind: "section" }
					: { kind: "line", row: target.row, context: target.context, contextTruncated: target.contextTruncated },
		});
		this.#feedbackChanged();
	}

	#matchesAnchor(annotation: PlanAnnotation, anchor: BodyAnchor, anchors: readonly BodyAnchor[]): boolean {
		const target = annotation.target;
		if (target.kind === "section") return true;
		if (target.kind === "line" && target.row === anchor.row && target.context === anchor.context) return true;
		const seen = new Set<number>();
		const contexts: { text: string; truncated: boolean }[] = [];
		for (const candidate of anchors) {
			if (candidate.sectionIndex !== anchor.sectionIndex || seen.has(candidate.row)) continue;
			seen.add(candidate.row);
			contexts.push({ text: candidate.context, truncated: candidate.contextTruncated });
		}
		const row =
			target.kind === "quote"
				? quoteRow(contexts, target.quote)
				: resolveLineRow(
						target.row,
						{ text: target.context, truncated: target.contextTruncated === true },
						contexts,
					);
		return row === anchor.row;
	}

	/** Notes `e` edits: the Contents section's, or those on the body's top row. */
	#noteCandidates(): NoteRef[] {
		if (this.focus === "toc") {
			const sectionIndex = this.toc[this.tocCursor];
			const section = sectionIndex === undefined ? undefined : this.sections[sectionIndex];
			if (!section || sectionIndex === undefined) return [];
			return section.annotations.map((_, annotationIndex) => ({ sectionIndex, annotationIndex }));
		}
		if (this.focus !== "body") return [];
		const frame = this.reference();
		const anchor = this.#topAnchor();
		const section = anchor ? this.sections[anchor.sectionIndex] : undefined;
		if (!anchor || !section) return [];
		const refs: NoteRef[] = [];
		section.annotations.forEach((annotation, annotationIndex) => {
			if (this.#matchesAnchor(annotation, anchor, frame.body.anchors))
				refs.push({ sectionIndex: anchor.sectionIndex, annotationIndex });
		});
		return refs;
	}

	#editNote(): void {
		const refs = this.#noteCandidates();
		if (refs.length === 0) return;
		if (refs.length === 1) this.#openNote(refs[0]!);
		else this.chooser = { entries: refs, selected: 0 };
	}

	#chooserKey(id: string, text: string | undefined): void {
		const chooser = this.chooser!;
		if (id === this.cancelKey) this.chooser = undefined;
		else if (this.#isUp(id, text))
			chooser.selected = (chooser.selected - 1 + chooser.entries.length) % chooser.entries.length;
		else if (this.#isDown(id, text)) chooser.selected = (chooser.selected + 1) % chooser.entries.length;
		else if (id === "enter") {
			const ref = chooser.entries[chooser.selected];
			this.chooser = undefined;
			if (ref) this.#openNote(ref);
		}
	}

	// ─── Pointer ────────────────────────────────────────────────────────────

	/** A pointer event at a cell of the terminal face `frame`. */
	mouse(frame: PlanFrame, event: MouseEvent, row: number, col: number): boolean {
		if (this.committed) return true;
		if (event.button === "wheel-up" || event.button === "wheel-down") {
			this.#scrollBy((event.button === "wheel-down" ? 1 : -1) * WHEEL_ROWS);
		} else if (event.action === "release") {
			return true;
		} else if (event.action === "move" || event.action === "drag") {
			const option = frame.optionRows.get(row);
			this.hovered = option !== undefined && !this.isDisabled(option) ? option : undefined;
		} else if (event.button === "left" && event.action === "press") {
			const option = frame.optionRows.get(row);
			const tocPos = frame.tocRows.get(row);
			if (option !== undefined) {
				if (!this.isDisabled(option)) {
					this.focus = "actions";
					this.selected = option;
					this.#runEntry(option);
				}
			} else if (tocPos !== undefined && col < frame.sidebarClickCols) {
				this.focus = "toc";
				this.tocCursor = tocPos;
				this.#scrubToToc();
			} else if (frame.bodyRows.has(row)) this.#setFocus("body");
		} else return true;
		this.touch();
		return true;
	}

	// ─── Native events ──────────────────────────────────────────────────────

	/** A list pick (`select`/`activate`) by its leaf key. */
	pick(leaf: string, item: string, activate: boolean): void {
		if (this.committed) return;
		const index = (prefix: string): number =>
			item.startsWith(prefix) && /^\d+$/.test(item.slice(prefix.length)) ? Number(item.slice(prefix.length)) : -1;
		switch (leaf) {
			case "toc": {
				const pos = this.toc.indexOf(index("h"));
				if (pos < 0) return;
				this.focus = "toc";
				this.tocCursor = pos;
				this.#scrubToToc();
				if (activate) this.#setFocus("body");
				break;
			}
			case "options": {
				const i = index("o");
				if (i < 0 || i >= this.entries().length || this.isDisabled(i)) return;
				this.focus = "actions";
				this.selected = i;
				if (activate) this.#runEntry(i);
				break;
			}
			case "tabs": {
				const i = index("t");
				if (i >= 0) this.#moveSlider(i - this.sliderIndex);
				break;
			}
			case "chooser": {
				const chooser = this.chooser;
				const i = index("c");
				if (!chooser || i < 0 || i >= chooser.entries.length) return;
				chooser.selected = i;
				if (activate) {
					this.chooser = undefined;
					this.#openNote(chooser.entries[i]!);
				}
				break;
			}
			default:
				return;
		}
		this.touch();
	}

	/** A dock click: the main button, a menu choice, a model tier, Save or Cancel. */
	action(leaf: string, act: string): void {
		if (this.committed || this.annotating || this.chooser) return;
		if (leaf === "more") {
			const choice = this.choices.find(candidate => candidate.id === act);
			if (choice && choice.disabled === undefined) this.#commit(choice.id, choice.label);
		} else if (leaf === "model") {
			const i = act.startsWith("tier:") ? Number(act.slice(5)) : -1;
			if (Number.isInteger(i) && i >= 0) this.#moveSlider(i - this.sliderIndex);
		} else if (act === "approve") {
			const choice = this.choices.find(candidate => candidate.disabled === undefined);
			if (choice) this.#commit(choice.id, choice.label);
		} else if (act === "refine") {
			if (this.hasFeedback && this.refine) this.#commit(this.refine.id, this.refine.label);
		} else if (act === "save") this.callbacks.onSave?.(this.content());
		else if (act === "cancel") this.#cancel();
		this.touch();
	}

	/** The native document's text was edited (its title line put back). */
	docChange(text: string): void {
		if (this.committed) return;
		const title = this.titleLine();
		let next = text;
		if (title) {
			const at = text.startsWith(this.source().slice(0, title.start)) ? title.start : 0;
			const rest = text.slice(at);
			next = text.slice(0, at) + (rest && !title.line.endsWith("\n") ? `${title.line}\n` : title.line) + rest;
		}
		if (next === this.source()) return;
		this.#replaceText(next);
		this.#undo = [];
		this.callbacks.onPlanEdited?.(this.content());
		this.#feedbackChanged();
		this.touch();
	}

	/** A comment on the native document's `quote` at document offset `at`. */
	comment(quote: string, at: number, note: string): void {
		if (this.committed) return;
		const trimmed = note.trim();
		if (!trimmed || !quote) return;
		const title = this.titleLine();
		const docAt = Math.max(0, Math.trunc(at));
		const offset = Math.min(title && docAt >= title.start ? docAt + title.line.length : docAt, this.source().length);
		const starts = this.sectionStarts();
		const owner = sectionAt(starts, offset);
		const section = this.sections[owner];
		if (!section) return;
		this.#pushUndo();
		section.annotations.push({
			id: this.#newId(),
			note: trimmed,
			target: { kind: "quote", quote, at: offset - starts[owner]! },
		});
		this.#feedbackChanged();
		this.touch();
	}

	/** Set (blank: delete) note `id`. */
	setNote(id: string, note: string): void {
		if (this.committed) return;
		for (const section of this.sections) {
			const index = section.annotations.findIndex(annotation => annotation.id === id);
			if (index < 0) continue;
			const trimmed = note.trim();
			if (trimmed === section.annotations[index]!.note) return;
			this.#pushUndo();
			if (trimmed) section.annotations[index]!.note = trimmed;
			else section.annotations.splice(index, 1);
			this.#feedbackChanged();
			this.touch();
			return;
		}
	}
}
