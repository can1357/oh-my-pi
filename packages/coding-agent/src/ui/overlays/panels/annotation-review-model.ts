/**
 * Annotating a review: notes on a diff (per line or per file, across the
 * changed files) or on a text (per line or on the whole text), kept with an
 * undo history, then handed back as the paste/review result.
 *
 * Regions: the file rail (diffs only, when it fits), the lines and the
 * actions (Continue with LLM review, Paste, Discard; Discard asks twice).
 * The note editor and the note chooser take the keys while open.
 *
 * The terminal face scrolls the lines in a box sized to the terminal; its
 * geometry at the terminal's size ({@link AnnotationReviewModel.reference})
 * is what paging and the cursor's scrolling act on.
 */
import type { Accessor, TextEdit } from "@oh-my-pi/pi-tui";
import { signal } from "@oh-my-pi/pi-tui";
import type { Theme } from "@oh-my-pi/pi-tui/theme/contract";
import type {
	AnnotationOverlayDraft,
	CodeReviewAnnotation,
	CodeReviewAnnotationBase,
	CodeReviewOverlayResult,
	ReviewDiffFile,
	ReviewDiffRow,
	ReviewSourceRow,
	TextReviewAnnotation,
	TextReviewOverlayResult,
	TextReviewSource,
} from "../../../extensibility/custom-commands/bundled/annotate/annotation-types";
import { type AnnotationFrame, annotationFrame, canShowRail } from "./annotation-review-frame";
import { selectKeyId } from "../../../config/keybindings/matchers";

export const CONTINUE_CODE_REVIEW_ACTION = "Continue with LLM review";
export const PASTE_CODE_REVIEW_ACTION = "Paste annotations into prompt";
/** Clears every note and closes; needs a second confirm. */
export const DISCARD_ANNOTATIONS_ACTION = "Discard notes and close";

/** What is under review. */
export type AnnotationReviewInput =
	| { readonly kind: "diff"; readonly files: readonly ReviewDiffFile[]; readonly mode: string }
	| { readonly kind: "text"; readonly source: TextReviewSource };

export interface AnnotationReviewCallbacks {
	onComplete(result: CodeReviewOverlayResult | TextReviewOverlayResult | undefined): void;
	onWarning?(message: string): void;
	/** Edit the note draft in the host's editor; `commit` puts the result back (null: unchanged). */
	onAnnotationExternalEditor?(draft: string, commit: (text: string | null) => void): void | Promise<void>;
	/** Open the source in the host's editor; the review stays open. */
	onExternalEditor?(): void | Promise<void>;
	/** Refresh the source under review. */
	onRefresh?(): Promise<void>;
}

export interface AnnotationReviewOptions {
	/** Key id that closes (default `escape`). */
	readonly cancelKey?: string;
	/** Key id of the external editor (default `ctrl+e`). */
	readonly externalEditorKey?: string;
}

/** The terminal the review is drawn on. */
export interface AnnotationReviewTerminal {
	readonly theme: Accessor<Theme>;
	readonly size: Accessor<{ readonly columns: number; readonly rows: number }>;
}

export type ReviewFocus = "files" | "diff" | "actions";
export type NoteScope = "file" | "line" | "text";

export interface DiffNote {
	readonly fileIndex: number;
	readonly sourceIndex: number;
	readonly annotation: CodeReviewAnnotation;
}

export interface TextNote {
	readonly sourceIndex: number;
	readonly annotation: TextReviewAnnotation;
}

const MIN_BODY_ROWS = 3;
const FAST_ROWS = 5;

/** Whether a diff row is a source line (one a note can be on). */
export function isSourceRow(row: ReviewDiffRow): row is ReviewSourceRow {
	return row.kind === "context" || row.kind === "added" || row.kind === "removed";
}

/** `path`, or `path (n)` for a later occurrence of the same path. */
export function fileLabel(file: ReviewDiffFile): string {
	return file.occurrence > 1 ? `${file.path} (${file.occurrence})` : file.path;
}

/** A text's 1-based annotatable lines. */
export function splitTextLines(text: string): string[] {
	return text.split(/\r\n|\n|\r/);
}
function sourceRowIndex(
	rows: readonly ReviewSourceRow[],
	raw: string,
	oldLine: number | undefined,
	newLine: number | undefined,
	allowUniqueRawFallback: boolean,
): number | undefined {
	const rawMatches: number[] = [];
	const coordinateMatches: number[] = [];
	rows.forEach((row, index) => {
		if (row.raw !== raw) return;
		rawMatches.push(index);
		if (row.oldLine === oldLine && row.newLine === newLine) coordinateMatches.push(index);
	});
	if (coordinateMatches.length > 0) return coordinateMatches.length === 1 ? coordinateMatches[0] : undefined;
	return allowUniqueRawFallback && rawMatches.length === 1 ? rawMatches[0] : undefined;
}

function fileIndexes(files: readonly ReviewDiffFile[]): Map<string, number[]> {
	const indexes = new Map<string, number[]>();
	files.forEach((file, index) => {
		const matches = indexes.get(file.path);
		if (matches) matches.push(index);
		else indexes.set(file.path, [index]);
	});
	return indexes;
}

function sectionIndexes(files: readonly ReviewDiffFile[], indexes: readonly number[]): Map<string, number[]> {
	const sections = new Map<string, number[]>();
	for (const index of indexes) {
		const rawDiff = files[index]!.rawDiff;
		const matches = sections.get(rawDiff);
		if (matches) matches.push(index);
		else sections.set(rawDiff, [index]);
	}
	return sections;
}
function annotationBaseForFile(annotation: CodeReviewAnnotationBase, file: ReviewDiffFile): CodeReviewAnnotationBase {
	return {
		path: file.path,
		...(file.oldPath === undefined ? {} : { oldPath: file.oldPath }),
		...(file.newPath === undefined ? {} : { newPath: file.newPath }),
		occurrence: file.occurrence,
		note: annotation.note,
	};
}

export class AnnotationReviewModel {
	readonly rev = signal(0);
	files: readonly ReviewDiffFile[];
	readonly mode: string;
	readonly actions: readonly string[];
	readonly cancelKey: string;
	readonly externalEditorKey: string;
	textSource: TextReviewSource | undefined;
	textLines: string[] = [];
	focus: ReviewFocus = "files";
	fileIndex = 0;
	sourceIndex = 0;
	actionIndex = 0;
	annotating = false;
	scope: NoteScope = "line";
	editingIndex: number | undefined;
	chooser: { kind: "diff" | "text"; entries: number[]; selected: number } | undefined;
	draft = { text: "", cursor: 0 };
	discardArmed = false;
	finished = false;
	notes: DiffNote[] = [];
	refreshing = false;
	textNotes: TextNote[] = [];
	undoStack: { notes: DiffNote[]; textNotes: TextNote[] }[] = [];
	/** The lines' scroll offset (in the terminal's geometry). */
	offset = 0;
	/** The last move scrolled the view (paging); the cursor follows the view rather than the reverse. */
	viewportDriven = false;
	viewportTowardEnd = false;
	#textEdited = false;
	#external = false;
	#rev = 0;
	/** Moves since the last draw: the view follows the cursor (or the cursor the view) once drawn. */
	#unsettled = false;

	constructor(
		input: AnnotationReviewInput,
		readonly callbacks: AnnotationReviewCallbacks,
		readonly terminal: AnnotationReviewTerminal,
		options: AnnotationReviewOptions = {},
	) {
		this.cancelKey = options.cancelKey ?? "escape";
		this.externalEditorKey = options.externalEditorKey ?? "ctrl+e";
		if (input.kind === "text") {
			this.files = [];
			this.mode = "Annotating text";
			this.actions = [PASTE_CODE_REVIEW_ACTION, DISCARD_ANNOTATIONS_ACTION];
			this.textSource = { ...input.source };
			this.textLines = splitTextLines(input.source.text);
			this.focus = "diff";
		} else {
			this.files = input.files;
			this.mode = input.mode;
			this.actions = [CONTINUE_CODE_REVIEW_ACTION, PASTE_CODE_REVIEW_ACTION, DISCARD_ANNOTATIONS_ACTION];
			// Start on Paste: a stray Enter must not start the LLM review.
			this.actionIndex = 1;
		}
	}

	touch(): void {
		this.#unsettled = true;
		this.rev.set(++this.#rev);
	}

	// ─── Geometry ───────────────────────────────────────────────────────────

	/** The terminal face at `width` (as tall as the terminal). */
	frame(width: number, theme: Theme): AnnotationFrame {
		this.#settle();
		return annotationFrame(this, width, this.terminal.size().rows, theme);
	}

	/** The face at the terminal's size, as the last draw left it. */
	reference(): AnnotationFrame {
		const size = this.terminal.size();
		return annotationFrame(this, size.columns, size.rows, this.terminal.theme());
	}

	/** Rows the native lines list shows (the page natively). */
	nativeBodyRows(): number {
		return Math.max(MIN_BODY_ROWS, this.terminal.size().rows - (this.actions.length + 8));
	}

	/** After moves, as a draw does: the view scrolls to the cursor, or (after paging) the cursor follows the view. */
	#settle(): void {
		if (!this.#unsettled) return;
		this.#unsettled = false;
		const frame = this.reference();
		this.offset = frame.offset;
		if (this.viewportDriven) {
			if (!this.annotating && !this.chooser) this.sourceIndex = this.#viewportSource(frame, frame.bodyRows);
		} else {
			const row = frame.rowBySource[this.sourceIndex];
			if (row !== undefined) {
				if (row < this.offset) this.offset = row;
				else if (row >= this.offset + frame.bodyRows) this.offset = row - frame.bodyRows + 1;
			}
		}
	}

	/** The source line the view rests on: its top line, or its last after paging to the end. */
	#viewportSource(frame: AnnotationFrame, rows: number): number {
		const rowBySource = frame.rowBySource;
		if (rowBySource.length === 0) return this.sourceIndex;
		const top = Math.max(0, Math.min(this.offset, frame.maxOffset));
		const bottom = top + Math.max(0, rows - 1);
		let topSource = 0;
		let lastVisible = 0;
		for (let index = 1; index < rowBySource.length; index++) {
			const row = rowBySource[index];
			if (row === undefined || row > bottom) break;
			lastVisible = index;
			if (row <= top) topSource = index;
		}
		return this.viewportTowardEnd && top >= frame.maxOffset ? lastVisible : topSource;
	}

	/** Whether the file rail is shown (diffs, wide enough). */
	railShown(): boolean {
		return !this.textSource && canShowRail(this.terminal.size().columns);
	}

	/** A face drawn `width` wide: without room for the rail, the files cannot have focus. */
	drawnAt(width: number): void {
		if ((this.textSource || !canShowRail(width)) && this.focus === "files") this.focus = "diff";
	}

	// ─── Draft API ──────────────────────────────────────────────────────────

	/** Notes, the open note and any source edit, as {@link restoreDraft} replays them. */
	getDraft(): AnnotationOverlayDraft {
		const editing = this.editingIndex === undefined ? {} : { editingAnnotationIndex: this.editingIndex };
		const text = this.draft.text;
		if (this.textSource) {
			const scope = this.scope === "text" ? "text" : "line";
			return {
				kind: "text",
				annotations: this.textNotes.map(entry => ({ ...entry, annotation: { ...entry.annotation } })),
				...(this.#textEdited ? { editedText: this.textSource.text } : {}),
				...(this.annotating
					? { editor: { sourceIndex: scope === "text" ? -1 : this.sourceIndex, scope, ...editing, text } }
					: {}),
			};
		}
		const scope = this.scope === "file" ? "file" : "line";
		return {
			kind: "diff",
			annotations: this.notes.map(entry => ({ ...entry, annotation: { ...entry.annotation } })),
			...(this.annotating
				? { editor: { fileIndex: this.fileIndex, sourceIndex: this.sourceIndex, scope, ...editing, text } }
				: {}),
		};
	}

	/** Replay a draft of this same source; anything anchored outside it is dropped. */
	restoreDraft(draft: AnnotationOverlayDraft): void {
		const rows = (fileIndex: number) =>
			this.textSource ? this.textLines.length : (this.files[fileIndex]?.rows.filter(isSourceRow).length ?? -1);
		const fits = (fileIndex: number, sourceIndex: number, whole: boolean) =>
			rows(fileIndex) >= 0 && (whole ? sourceIndex === -1 : sourceIndex >= 0 && sourceIndex < rows(fileIndex));
		if (draft.kind === "text" && this.textSource) {
			if (draft.editedText !== undefined) this.replaceTextSource(draft.editedText);
			this.textNotes = draft.annotations.filter(entry =>
				fits(0, entry.sourceIndex, entry.annotation.scope === "text"),
			);
		} else if (draft.kind === "diff" && !this.textSource) {
			this.notes = draft.annotations.filter(entry =>
				fits(entry.fileIndex, entry.sourceIndex, entry.annotation.scope === "file"),
			);
		} else return;
		const editor = draft.editor;
		const fileIndex = editor && "fileIndex" in editor ? editor.fileIndex : 0;
		if (editor && fits(fileIndex, editor.sourceIndex, editor.scope === "text" || editor.scope === "file")) {
			this.fileIndex = fileIndex;
			if (editor.sourceIndex >= 0) this.sourceIndex = editor.sourceIndex;
			this.scope = editor.scope;
			const count = this.textSource ? this.textNotes.length : this.notes.length;
			this.editingIndex =
				(editor.editingAnnotationIndex ?? count) < count ? editor.editingAnnotationIndex : undefined;
			this.annotating = true;
			this.draft = { text: editor.text, cursor: editor.text.length };
		}
		this.touch();
	}

	getAnnotations(): CodeReviewAnnotation[] {
		return this.notes.map(entry => ({ ...entry.annotation }));
	}

	getTextAnnotations(): TextReviewAnnotation[] {
		return this.textNotes.map(entry => ({ ...entry.annotation }));
	}

	/** Path of the diff file under the cursor (code reviews). */
	reviewFilePath(): string | undefined {
		const file = this.files[this.fileIndex];
		return file ? (file.newPath ?? file.oldPath ?? file.path) : undefined;
	}

	textSourceText(): string | undefined {
		return this.textSource?.text;
	}

	/**
	 * Replace the text under review: a line note stays when its quote is
	 * still on its line, moves when the quote is now on exactly one line, and
	 * is dropped otherwise. Returns how many were dropped.
	 */
	replaceTextSource(text: string): number {
		if (!this.textSource) return 0;
		this.textSource = { ...this.textSource, text };
		this.#textEdited = true;
		this.textLines = splitTextLines(text);
		this.viewportDriven = false;
		this.sourceIndex = Math.min(this.sourceIndex, Math.max(0, this.textLines.length - 1));
		let dropped = 0;
		const kept: TextNote[] = [];
		for (const entry of this.textNotes) {
			if (entry.annotation.scope !== "line") {
				kept.push(entry);
				continue;
			}
			const quote = entry.annotation.quote;
			if (this.textLines[entry.sourceIndex] === quote) {
				kept.push(entry);
				continue;
			}
			const matches = this.textLines.flatMap((line, index) => (line === quote ? [index] : []));
			if (matches.length === 1) {
				kept.push({ sourceIndex: matches[0]!, annotation: { ...entry.annotation, line: matches[0]! + 1 } });
				continue;
			}
			dropped++;
		}
		this.textNotes = kept;
		// Older snapshots anchor notes to the old text.
		this.undoStack = [];
		this.touch();
		return dropped;
	}
	/**
	 * Replace the diff under review, retaining only notes whose file and line
	 * anchors can be matched unambiguously. Returns the number of dropped notes.
	 */
	replaceDiffSource(files: readonly ReviewDiffFile[]): number {
		if (this.textSource) return 0;
		const previousFiles = this.files;
		const previousFileIndex = this.fileIndex;
		const previousSourceIndex = this.sourceIndex;
		const rowsByFile = new Map<ReviewDiffFile, ReviewSourceRow[]>();
		const sourceRowsFor = (file: ReviewDiffFile): ReviewSourceRow[] => {
			const cached = rowsByFile.get(file);
			if (cached !== undefined) return cached;
			const rows = file.rows.filter(isSourceRow);
			rowsByFile.set(file, rows);
			return rows;
		};
		const rawCountsByFile = new Map<ReviewDiffFile, Map<string, number>>();
		const rawCountFor = (file: ReviewDiffFile, raw: string): number => {
			let counts = rawCountsByFile.get(file);
			if (counts === undefined) {
				counts = new Map();
				for (const row of sourceRowsFor(file)) counts.set(row.raw, (counts.get(row.raw) ?? 0) + 1);
				rawCountsByFile.set(file, counts);
			}
			return counts.get(raw) ?? 0;
		};
		const previousFile = previousFiles[previousFileIndex];
		const previousRow = previousFile ? sourceRowsFor(previousFile)[previousSourceIndex] : undefined;
		const oldIndexes = fileIndexes(previousFiles);
		const newIndexes = fileIndexes(files);
		const oldToNew = new Map<number, number>();
		for (const [path, oldMatches] of oldIndexes) {
			const newMatches = newIndexes.get(path);
			if (newMatches === undefined) continue;
			if (oldMatches.length === 1 && newMatches.length === 1) {
				const oldIndex = oldMatches[0]!;
				const newIndex = newMatches[0]!;
				if (previousFiles[oldIndex]!.occurrence === files[newIndex]!.occurrence) oldToNew.set(oldIndex, newIndex);
				continue;
			}
			const oldSections = sectionIndexes(previousFiles, oldMatches);
			const newSections = sectionIndexes(files, newMatches);
			for (const oldIndex of oldMatches) {
				const rawDiff = previousFiles[oldIndex]!.rawDiff;
				const oldSection = oldSections.get(rawDiff);
				const newSection = newSections.get(rawDiff);
				if (oldSection?.length === 1 && newSection?.length === 1) oldToNew.set(oldIndex, newSection[0]!);
			}
		}

		let dropped = 0;
		const kept: DiffNote[] = [];
		for (const entry of this.notes) {
			const oldFile = previousFiles[entry.fileIndex];
			const newFileIndex = oldToNew.get(entry.fileIndex);
			const annotation = entry.annotation;
			if (
				!oldFile ||
				newFileIndex === undefined ||
				annotation.path !== oldFile.path ||
				annotation.occurrence !== oldFile.occurrence
			) {
				dropped++;
				continue;
			}
			const newFile = files[newFileIndex]!;
			const base = annotationBaseForFile(annotation, newFile);
			if (annotation.scope === "file") {
				kept.push({ ...entry, fileIndex: newFileIndex, annotation: { ...base, scope: "file" } });
				continue;
			}
			const oldRows = sourceRowsFor(oldFile);
			const oldRow = oldRows[entry.sourceIndex];
			if (
				!oldRow ||
				oldRow.raw !== annotation.rawLine ||
				oldRow.oldLine !== annotation.oldLine ||
				oldRow.newLine !== annotation.newLine
			) {
				dropped++;
				continue;
			}
			const newRows = sourceRowsFor(newFile);
			const newSourceIndex = sourceRowIndex(
				newRows,
				annotation.rawLine,
				annotation.oldLine,
				annotation.newLine,
				rawCountFor(oldFile, annotation.rawLine) === 1,
			);
			if (newSourceIndex === undefined) {
				dropped++;
				continue;
			}
			const newRow = newRows[newSourceIndex];
			if (newRow === undefined) {
				dropped++;
				continue;
			}
			kept.push({
				fileIndex: newFileIndex,
				sourceIndex: newSourceIndex,
				annotation: {
					...base,
					scope: "line",
					hunkHeader: newRow.hunkHeader,
					...(newRow.oldLine === undefined ? {} : { oldLine: newRow.oldLine }),
					...(newRow.newLine === undefined ? {} : { newLine: newRow.newLine }),
					rawLine: newRow.raw,
				},
			});
		}

		this.files = files;
		this.notes = kept;
		this.undoStack = [];
		const mappedFileIndex = oldToNew.get(previousFileIndex);
		this.fileIndex =
			files.length === 0 ? 0 : (mappedFileIndex ?? Math.max(0, Math.min(previousFileIndex, files.length - 1)));
		const currentFile = files[this.fileIndex];
		const currentRows = currentFile ? sourceRowsFor(currentFile) : [];
		const mappedSourceIndex =
			mappedFileIndex === this.fileIndex && previousFile && previousRow
				? sourceRowIndex(
						currentRows,
						previousRow.raw,
						previousRow.oldLine,
						previousRow.newLine,
						rawCountFor(previousFile, previousRow.raw) === 1,
					)
				: undefined;
		this.sourceIndex = mappedSourceIndex ?? Math.max(0, Math.min(previousSourceIndex, currentRows.length - 1));
		this.viewportDriven = false;
		this.viewportTowardEnd = false;
		this.offset = 0;
		this.touch();
		return dropped;
	}

	dispose(): void {
		this.finished = true;
	}

	// ─── Queries ────────────────────────────────────────────────────────────

	currentFile(): ReviewDiffFile | undefined {
		return this.files[this.fileIndex];
	}

	currentSourceRows(): ReviewSourceRow[] {
		return this.currentFile()?.rows.filter(isSourceRow) ?? [];
	}

	#rowCount(): number {
		return this.textSource ? this.textLines.length : this.currentSourceRows().length;
	}

	noteCount(fileIndex: number): number {
		return this.notes.filter(entry => entry.fileIndex === fileIndex).length;
	}

	hasNotes(): boolean {
		return this.textSource ? this.textNotes.length > 0 : this.notes.length > 0;
	}

	actionDisabled(index: number): boolean {
		if (this.actions[index] === DISCARD_ANNOTATIONS_ACTION) return false;
		if (this.actions[index] === CONTINUE_CODE_REVIEW_ACTION) return this.files.length === 0;
		return this.textSource ? !this.hasNotes() : index === 1 && !this.hasNotes();
	}

	/** Notes `e` edits: the line's, then the file's (text: the line's, then the whole text's). */
	noteCandidates(): number[] {
		if (this.focus !== "files" && this.focus !== "diff") return [];
		if (this.textSource) {
			if (this.focus !== "diff") return [];
			const lines: number[] = [];
			const whole: number[] = [];
			this.textNotes.forEach((entry, index) => {
				if (entry.annotation.scope === "text") whole.push(index);
				else if (entry.sourceIndex === this.sourceIndex) lines.push(index);
			});
			return [...lines, ...whole];
		}
		const lines: number[] = [];
		const whole: number[] = [];
		this.notes.forEach((entry, index) => {
			if (entry.fileIndex !== this.fileIndex) return;
			if (entry.annotation.scope === "file") whole.push(index);
			else if (this.focus === "diff" && entry.sourceIndex === this.sourceIndex) lines.push(index);
		});
		return this.focus === "files" ? whole : [...lines, ...whole];
	}

	// ─── Keys ───────────────────────────────────────────────────────────────

	/** A key; false when it belongs to the note editor's field. */
	key(id: string, text: string | undefined, raw: string): boolean {
		if (this.finished || this.#external) return true;
		if (this.refreshing && id !== this.cancelKey) return true;
		this.drawnAt(this.terminal.size().columns);
		const armed = this.discardArmed;
		this.discardArmed = false;
		const handled = this.#key(id, text, raw, armed);
		this.touch();
		return handled;
	}

	#key(id: string, text: string | undefined, raw: string, armed: boolean): boolean {
		if (this.chooser) {
			this.#chooserKey(selectKeyId(id), text);
			return true;
		}
		if (this.annotating) {
			if (id === this.externalEditorKey) {
				void this.#editDraftExternally();
				return true;
			}
			// Close, keeping the open note in the draft.
			if (id === this.cancelKey) {
				this.#finish(undefined);
				return true;
			}
			if (id === "enter" && raw !== "\n") {
				this.#commitNote(this.draft.text);
				return true;
			}
			return false;
		}
		if (id === this.cancelKey) {
			this.#finish(undefined);
			return true;
		}
		// List keys follow the selector bindings (`tui.select.*`).
		if (text === "r" && this.callbacks.onRefresh) {
			void this.#refreshSource();
			return true;
		}
		id = selectKeyId(id);
		if (this.callbacks.onExternalEditor && id === this.externalEditorKey) {
			void this.#editSourceExternally();
			return true;
		}
		if (text === "A" && (this.focus === "files" || this.focus === "diff")) {
			this.#startNote(this.textSource ? "text" : "file");
			return true;
		}
		if (!this.textSource && (text === "[" || text === "]")) {
			if (this.files.length > 0)
				this.#selectFile((this.fileIndex + (text === "[" ? -1 : 1) + this.files.length) % this.files.length);
			return true;
		}
		if (text === "u") this.#undo();
		else if (text === "e") this.#editNote();
		else if (id === "tab") this.#cycle(1);
		else if (id === "shift+tab") this.#cycle(-1);
		else if (this.focus === "files") this.#filesKey(id, text);
		else if (this.focus === "diff") this.#linesKey(id, text);
		else this.#actionsKey(id, text, armed);
		return true;
	}

	#isUp(id: string, text: string | undefined): boolean {
		return id === "up" || text === "k";
	}

	#isDown(id: string, text: string | undefined): boolean {
		return id === "down" || text === "j";
	}

	#cycle(direction: number): void {
		// The native sheet always has the rail for diffs.
		const regions: ReviewFocus[] = this.textSource ? ["diff", "actions"] : ["files", "diff", "actions"];
		const current = regions.indexOf(this.focus);
		const index = current < 0 ? regions.length - 1 : current;
		this.focus = regions[(index + direction + regions.length) % regions.length]!;
	}

	#filesKey(id: string, text: string | undefined): void {
		if (text === "a") this.#startNote("file");
		else if (this.#isUp(id, text)) this.#selectFile(Math.max(0, this.fileIndex - 1));
		else if (this.#isDown(id, text)) this.#selectFile(Math.min(this.files.length - 1, this.fileIndex + 1));
		else if (id === "right" || text === "l" || id === "enter") this.focus = "diff";
	}

	#linesKey(id: string, text: string | undefined): void {
		if (text === "a") return this.#startNote("line");
		if (id === "left" || text === "h") {
			if (!this.textSource) this.focus = "files";
			return;
		}
		if (id === "right" || text === "l" || id === "enter") {
			this.focus = "actions";
			return;
		}
		if (id === "shift+up") return this.#moveCursor(-FAST_ROWS);
		if (id === "shift+down") return this.#moveCursor(FAST_ROWS);
		if (this.#isUp(id, text)) return this.#moveCursor(-1);
		if (this.#isDown(id, text)) return this.#moveCursor(1);
		if (id === "pageUp" || id === "pageDown") {
			const frame = this.reference();
			const step = Math.max(1, frame.bodyRows - 1) * (id === "pageUp" ? -1 : 1);
			this.offset = Math.max(0, Math.min(this.offset + step, frame.maxOffset));
			this.viewportDriven = true;
			this.viewportTowardEnd = id === "pageDown";
			this.sourceIndex = this.#viewportSource(frame, this.nativeBodyRows());
			return;
		}
		if (text === "g" || id === "home") {
			this.sourceIndex = 0;
			this.#jumpEnd(false);
		} else if (text === "G" || id === "end") {
			this.sourceIndex = Math.max(0, this.#rowCount() - 1);
			this.#jumpEnd(true);
		}
	}

	#jumpEnd(toEnd: boolean): void {
		if (this.textSource) {
			this.viewportDriven = false;
			return;
		}
		this.offset = toEnd ? this.reference().maxOffset : 0;
		this.viewportDriven = true;
		this.viewportTowardEnd = toEnd;
	}

	#actionsKey(id: string, text: string | undefined, armed: boolean): void {
		const up = this.#isUp(id, text);
		if (up || this.#isDown(id, text)) {
			const step = up ? -1 : 1;
			for (let index = this.actionIndex + step; index >= 0 && index < this.actions.length; index += step) {
				if (this.actionDisabled(index)) continue;
				this.actionIndex = index;
				break;
			}
			return;
		}
		if (id === "enter") this.#confirm(armed);
	}

	#confirm(armed: boolean): void {
		if (this.actionDisabled(this.actionIndex)) return;
		if (this.actions[this.actionIndex] === DISCARD_ANNOTATIONS_ACTION) {
			if (!armed) {
				this.discardArmed = true;
				return;
			}
			this.notes = [];
			this.textNotes = [];
			this.#textEdited = false;
			this.annotating = false;
			this.editingIndex = undefined;
			this.draft = { text: "", cursor: 0 };
			this.#finish(undefined);
		} else if (this.textSource) {
			this.#finish({
				action: "paste",
				annotations: this.getTextAnnotations(),
				...(this.#textEdited ? { editedText: this.textSource.text } : {}),
			});
		} else {
			this.#finish({ action: this.actionIndex === 0 ? "review" : "paste", annotations: this.getAnnotations() });
		}
	}

	#finish(result: CodeReviewOverlayResult | TextReviewOverlayResult | undefined): void {
		if (this.finished) return;
		this.finished = true;
		this.callbacks.onComplete(result);
	}

	#selectFile(index: number): void {
		if (this.files.length === 0) return;
		this.fileIndex = Math.max(0, Math.min(this.files.length - 1, index));
		this.sourceIndex = 0;
		this.viewportDriven = false;
		this.offset = 0;
	}

	#moveCursor(delta: number): void {
		const count = this.#rowCount();
		if (count === 0) return;
		this.sourceIndex = Math.max(0, Math.min(count - 1, this.sourceIndex + delta));
		this.viewportDriven = false;
	}

	// ─── Notes ──────────────────────────────────────────────────────────────

	#startNote(scope: NoteScope, existing?: number): void {
		if (this.textSource) {
			if (scope === "file") return;
			const entry = existing === undefined ? undefined : this.textNotes[existing];
			if (entry && entry.annotation.scope !== scope) return;
			this.#open(scope, existing, entry?.annotation.note ?? "");
			return;
		}
		const file = this.currentFile();
		const source = this.currentSourceRows()[this.sourceIndex];
		if (!file || (scope === "line" && (file.isBinary || !source))) {
			this.callbacks.onWarning?.("This file has no annotatable diff rows");
			return;
		}
		const entry = existing === undefined ? undefined : this.notes[existing];
		if (entry && (entry.fileIndex !== this.fileIndex || entry.annotation.scope !== scope)) return;
		this.#open(scope === "file" ? "file" : "line", existing, entry?.annotation.note ?? "");
	}

	#open(scope: NoteScope, existing: number | undefined, note: string): void {
		this.scope = scope;
		this.editingIndex = existing;
		this.annotating = true;
		this.draft = { text: note, cursor: note.length };
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

	#pushUndo(): void {
		this.undoStack.push({ notes: [...this.notes], textNotes: [...this.textNotes] });
	}

	#undo(): void {
		const snapshot = this.undoStack.pop();
		if (!snapshot) return;
		this.notes = snapshot.notes;
		this.textNotes = snapshot.textNotes;
	}

	#commitNote(value: string): void {
		const note = value.trim();
		const editing = this.editingIndex;
		this.annotating = false;
		this.editingIndex = undefined;
		this.draft = { text: "", cursor: 0 };
		const list = this.textSource ? this.textNotes : this.notes;
		if (!note || editing !== undefined) {
			if (editing === undefined) return;
			const existing = list[editing];
			if (!note) {
				this.#pushUndo();
				list.splice(editing, 1);
			} else if (existing) {
				this.#pushUndo();
				list[editing] = { ...existing, annotation: { ...existing.annotation, note } } as never;
			}
			return;
		}
		if (this.textSource) {
			this.#pushUndo();
			const line = this.scope === "text" ? -1 : this.sourceIndex;
			this.textNotes.push({
				sourceIndex: line,
				annotation:
					line < 0
						? { scope: "text", note }
						: { scope: "line", line: line + 1, quote: this.textLines[line] ?? "", note },
			});
			return;
		}
		const file = this.currentFile();
		const source = this.currentSourceRows()[this.sourceIndex];
		const scope = this.scope === "file" ? "file" : "line";
		if (!file || (scope === "line" && !source)) return;
		this.#pushUndo();
		const common = {
			path: file.path,
			...(file.oldPath === undefined ? {} : { oldPath: file.oldPath }),
			...(file.newPath === undefined ? {} : { newPath: file.newPath }),
			occurrence: file.occurrence,
			note,
		};
		this.notes.push({
			fileIndex: this.fileIndex,
			sourceIndex: scope === "line" ? this.sourceIndex : -1,
			annotation:
				scope === "file"
					? { ...common, scope: "file" }
					: {
							...common,
							scope: "line",
							hunkHeader: source!.hunkHeader,
							...(source!.oldLine === undefined ? {} : { oldLine: source!.oldLine }),
							...(source!.newLine === undefined ? {} : { newLine: source!.newLine }),
							rawLine: source!.raw,
						},
		});
	}

	#editNote(): void {
		const entries = this.noteCandidates();
		if (entries.length === 0) return;
		if (entries.length === 1) this.#openExisting(entries[0]!);
		else this.chooser = { kind: this.textSource ? "text" : "diff", entries, selected: 0 };
	}

	#openExisting(index: number): void {
		const scope = this.textSource ? this.textNotes[index]?.annotation.scope : this.notes[index]?.annotation.scope;
		if (scope) this.#startNote(scope, index);
	}

	#chooserKey(id: string, text: string | undefined): void {
		const chooser = this.chooser!;
		if (id === this.cancelKey) this.chooser = undefined;
		else if (this.#isUp(id, text))
			chooser.selected = (chooser.selected - 1 + chooser.entries.length) % chooser.entries.length;
		else if (this.#isDown(id, text)) chooser.selected = (chooser.selected + 1) % chooser.entries.length;
		else if (id === "enter") this.#pickChosen();
	}

	#pickChosen(): void {
		const chooser = this.chooser!;
		const index = chooser.entries[chooser.selected];
		this.chooser = undefined;
		if (index !== undefined) this.#openExisting(index);
	}

	async #editDraftExternally(): Promise<void> {
		if (this.#external || !this.annotating) return;
		const open = this.callbacks.onAnnotationExternalEditor;
		if (!open) {
			this.callbacks.onWarning?.("External editor is unavailable in this UI host.");
			return;
		}
		this.#external = true;
		try {
			await open(this.draft.text, text => {
				if (text !== null) this.draft = { text, cursor: text.length };
			});
		} catch (error) {
			this.callbacks.onWarning?.(
				`Failed to open external editor: ${error instanceof Error ? error.message : String(error)}`,
			);
		} finally {
			this.#external = false;
			this.touch();
		}
	}

	async #editSourceExternally(): Promise<void> {
		const open = this.callbacks.onExternalEditor;
		if (this.#external || !open) return;
		this.#external = true;
		try {
			await open();
		} catch (error) {
			this.callbacks.onWarning?.(
				`Failed to open external editor: ${error instanceof Error ? error.message : String(error)}`,
			);
		} finally {
			this.#external = false;
			this.touch();
		}
	}
	async #refreshSource(): Promise<void> {
		const refresh = this.callbacks.onRefresh;
		if (!refresh || this.refreshing || this.finished) return;
		this.refreshing = true;
		this.touch();
		try {
			await refresh();
		} catch (error) {
			if (!this.finished)
				this.callbacks.onWarning?.(
					`Failed to refresh review: ${error instanceof Error ? error.message : String(error)}`,
				);
		} finally {
			this.refreshing = false;
			if (!this.finished) this.touch();
		}
	}

	// ─── Native events ──────────────────────────────────────────────────────

	/** A footer button. */
	action(act: string): void {
		if (this.finished || this.#external) return;
		if (this.refreshing && act !== "close") return;
		const armed = this.discardArmed;
		this.discardArmed = false;
		if (act === "close") {
			if (this.chooser) this.chooser = undefined;
			else this.#finish(undefined);
		} else if (act === "refresh") {
			if (!this.annotating && !this.chooser) void this.#refreshSource();
		} else if (!this.annotating && !this.chooser) {
			const index =
				act === "discard"
					? this.actions.indexOf(DISCARD_ANNOTATIONS_ACTION)
					: act === "review" && !this.textSource
						? 0
						: act === "paste"
							? this.textSource
								? 0
								: 1
							: -1;
			if (index >= 0 && !this.actionDisabled(index)) {
				this.actionIndex = index;
				this.#confirm(armed);
			}
		}
		this.touch();
	}
	/** A pick in the files, lines or chooser list. */
	pick(leaf: string, item: string, activate: boolean): void {
		if (this.finished || this.#external || this.refreshing) return;
		this.discardArmed = false;
		const index = (prefix: string): number =>
			item.startsWith(prefix) && /^\d+$/.test(item.slice(prefix.length)) ? Number(item.slice(prefix.length)) : -1;
		const chooser = this.chooser;
		if (leaf === "chooser") {
			const i = index("c");
			if (!chooser || i < 0 || i >= chooser.entries.length) return;
			chooser.selected = i;
			if (activate) this.#pickChosen();
		} else if (chooser || this.annotating) {
			return;
		} else if (leaf === "files") {
			const i = index("f");
			if (i < 0 || i >= this.files.length) return;
			this.focus = "files";
			if (i !== this.fileIndex) this.#selectFile(i);
			if (activate) this.focus = "diff";
		} else if (leaf === "lines") {
			const i = index("l");
			if (i < 0 || i >= this.#rowCount()) return;
			this.focus = "diff";
			this.sourceIndex = i;
			this.viewportDriven = false;
			if (activate) this.#startNote("line");
		} else return;
		this.touch();
	}
}
