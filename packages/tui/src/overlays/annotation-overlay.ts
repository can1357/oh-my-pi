import {
	type Component,
	Editor,
	Ellipsis,
	matchesKey,
	padding,
	replaceTabs,
	ScrollView,
	type TUI,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "../index";
import { appKey, editorKey } from "../chrome/keybinding-hints";
import { formatKeyHint, formatKeyHints, type KeybindingsManager } from "../app-keybindings";
import type { Keybinding } from "../keybindings";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import { type Theme } from "../theme/theme";
import type {
	CodeReviewAnnotation,
	CodeReviewOverlayResult,
	ReviewDiffFile,
	ReviewDiffRow,
	ReviewSourceRow,
	TextReviewAnnotation,
	TextReviewOverlayResult,
	TextReviewSource,
} from "./annotation-types";
import {
	bottomBorder,
	divider,
	dividerSplit,
	row,
	splitBodyWidth,
	splitRow,
	topBorder,
	topBorderSplit,
} from "../chrome/overlay-box";
import { matchesAppExternalEditor } from "../keybinding-matchers";
import type { KeyName } from "../key-hint-format";
import { item, keyed, node, row as rowNode, span, text } from "../native/describe";
import { leafKey, type NativeChild, type NativeNode, type NativeUiEvent } from "../native/node";
import { hintsRow, itemIndex, type NativeHint, noteSpans, overlayCard, selectList } from "../native/overlay";

function fit(text: string, width: number): string {
	if (width <= 0) return "";
	const measured = visibleWidth(text);
	if (measured === width) return text;
	if (measured < width) return text + padding(width - measured);
	const truncated = truncateToWidth(text, width);
	const truncatedWidth = visibleWidth(truncated);
	return truncatedWidth < width ? truncated + padding(width - truncatedWidth) : truncated;
}

export const CONTINUE_CODE_REVIEW_ACTION = "Continue with LLM review";
export const PASTE_CODE_REVIEW_ACTION = "Paste annotations into prompt";

export interface AnnotationOverlayCallbacks {
	onComplete(result: CodeReviewOverlayResult | TextReviewOverlayResult | undefined): void;
	onWarning?(message: string): void;
	/** Open the draft in the host's editor and invoke `commit` with its result. */
	onAnnotationExternalEditor?(draft: string, commit: (text: string | null) => void): void | Promise<void>;
}

export interface CodeReviewOverlayCallbacks extends AnnotationOverlayCallbacks {
	onComplete(result: CodeReviewOverlayResult | undefined): void;
}

export interface TextReviewOverlayCallbacks extends AnnotationOverlayCallbacks {
	onComplete(result: TextReviewOverlayResult | undefined): void;
}

type OverlayCallbacks = CodeReviewOverlayCallbacks | TextReviewOverlayCallbacks;

type AnnotationScope = CodeReviewAnnotation["scope"] | TextReviewAnnotation["scope"];
type DiffColor = "toolDiffAdded" | "toolDiffRemoved" | "toolDiffContext";

interface AnnotationChooser {
	kind: "diff" | "text";
	entries: number[];
	selected: number;
}

interface CommittedAnnotation {
	fileIndex: number;
	sourceIndex: number;
	annotation: CodeReviewAnnotation;
}

interface CommittedTextAnnotation {
	sourceIndex: number;
	annotation: TextReviewAnnotation;
}
interface RenderedDiffBody {
	lines: string[];
	renderedRowBySource: number[];
	selectedSourceLines: string[];
}

interface RenderedBody {
	lines: string[];
	renderedRowBySource: number[];
}

type FocusRegion = "files" | "diff" | "actions";

/** Described body rows of the current file (or text), rebuilt when the file or annotations change. */
interface NativeBody {
	fileIndex: number;
	rev: number;
	items: NativeNode[];
}

const SOURCE_SELECTION_GUTTER_WIDTH = 2;

const OVERLAY_TITLE = "Code Review";
const TEXT_OVERLAY_TITLE = "Annotate Text";
const MIN_BODY_ROWS = 3;
const SIDEBAR_MIN_TOTAL_WIDTH = 64;
const SIDEBAR_MIN_BODY_WIDTH = 40;
const MAX_ANNOTATION_EDITOR_ROWS = 6;
const CODE_REVIEW_ACTIONS = [CONTINUE_CODE_REVIEW_ACTION, PASTE_CODE_REVIEW_ACTION] as const;
const TEXT_REVIEW_ACTIONS = [PASTE_CODE_REVIEW_ACTION] as const;

function isSourceRow(row: ReviewDiffRow): row is ReviewSourceRow {
	return row.kind === "context" || row.kind === "added" || row.kind === "removed";
}

function displayFileLabel(file: ReviewDiffFile): string {
	return file.occurrence > 1 ? `${file.path} (${file.occurrence})` : file.path;
}
function sanitizeStatusText(text: string): string {
	return sanitizeText(text)
		.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

function splitTextLines(text: string): string[] {
	return text.split(/\r\n|\n|\r/);
}

function isTextSource(value: readonly ReviewDiffFile[] | TextReviewSource): value is TextReviewSource {
	return !Array.isArray(value);
}

/** A fullscreen, annotated diff picker that only relies on public OMP APIs. */
export class AnnotationOverlay implements Component {
	#scrollView: ScrollView;
	#editor: Editor;
	#focus: FocusRegion = "files";
	#fileIndex = 0;
	#sourceIndex = 0;
	#actionIndex = 0;
	#bodyHeight = MIN_BODY_ROWS;
	#sidebarShown = false;
	#annotating = false;
	#annotationScope: AnnotationScope = "line";
	#editingAnnotationIndex: number | undefined;
	#annotationChooser: AnnotationChooser | undefined;
	#externalOperation = false;
	#finished = false;
	#annotations: CommittedAnnotation[] = [];
	#textAnnotations: CommittedTextAnnotation[] = [];
	/** Annotation lists before each create/edit/delete, restored by `u`. */
	#undoStack: Array<{ annotations: CommittedAnnotation[]; textAnnotations: CommittedTextAnnotation[] }> = [];
	#actions: readonly string[] = CODE_REVIEW_ACTIONS;
	#textSource: TextReviewSource | undefined;
	#textLines: readonly string[] = [];
	#textViewportDriven = false;
	#textRenderedRowBySource: readonly number[] = [];
	#staticRenderedDiffBodies = new WeakMap<ReviewDiffFile, RenderedDiffBody>();
	/** Bumped on every annotation change (each one pushes an undo snapshot) and on undo. */
	#annotationRev = 0;
	#nativeBody: NativeBody | undefined;
	#nativeSig = "";
	#nativeRoot: NativeNode | undefined;
	/** Body the memoized root was built from. */
	#nativeRootBody: NativeBody | undefined;

	readonly #tui: TUI;
	readonly #theme: Theme;
	readonly #keybindings: KeybindingsManager;
	readonly #files: readonly ReviewDiffFile[];
	readonly #mode: string;
	readonly #callbacks: OverlayCallbacks;

	constructor(
		tui: TUI,
		theme: Theme,
		keybindings: KeybindingsManager,
		files: readonly ReviewDiffFile[],
		mode: string,
		callbacks: CodeReviewOverlayCallbacks,
	);
	constructor(
		tui: TUI,
		theme: Theme,
		keybindings: KeybindingsManager,
		source: TextReviewSource,
		callbacks: TextReviewOverlayCallbacks,
	);
	constructor(
		tui: TUI,
		theme: Theme,
		keybindings: KeybindingsManager,
		filesOrSource: readonly ReviewDiffFile[] | TextReviewSource,
		modeOrCallbacks: string | TextReviewOverlayCallbacks,
		maybeCallbacks?: CodeReviewOverlayCallbacks,
	) {
		this.#tui = tui;
		this.#theme = theme;
		this.#keybindings = keybindings;
		if (isTextSource(filesOrSource)) {
			this.#files = [];
			this.#actions = TEXT_REVIEW_ACTIONS;
			this.#mode = "Annotating text";
			this.#callbacks = modeOrCallbacks as TextReviewOverlayCallbacks;
			this.#textSource = { ...filesOrSource };
			this.#textLines = splitTextLines(filesOrSource.text);
			this.#focus = "diff";
		} else {
			this.#files = filesOrSource;
			this.#mode = modeOrCallbacks as string;
			this.#callbacks = maybeCallbacks!;
		}
		const symbols = {
			cursor: theme.nav.cursor,
			inputCursor: theme.nav.cursor,
			boxRound: {
				topLeft: theme.boxRound.topLeft,
				topRight: theme.boxRound.topRight,
				bottomLeft: theme.boxRound.bottomLeft,
				bottomRight: theme.boxRound.bottomRight,
				horizontal: theme.boxRound.horizontal,
				vertical: theme.boxRound.vertical,
			},
			boxSharp: theme.boxSharp,
			table: theme.boxSharp,
			quoteBorder: theme.md.quoteBorder,
			hrChar: theme.md.hrChar,
			colorSwatch: theme.md.colorSwatch,
			spinnerFrames: theme.spinnerFrames,
		};
		this.#editor = new Editor({
			borderColor: text => theme.fg("border", text),
			selectList: {
				selectedPrefix: text => theme.fg("accent", text),
				selectedText: text => theme.bold(theme.fg("accent", text)),
				description: text => theme.fg("dim", text),
				scrollInfo: text => theme.fg("dim", text),
				noMatch: text => theme.fg("dim", text),
				symbols,
			},
			symbols,
			hintStyle: text => theme.fg("dim", text),
		});
		this.#scrollView = new ScrollView([], {
			height: MIN_BODY_ROWS,
			scrollbar: "auto",
			ellipsis: Ellipsis.Omit,
			theme: {
				track: text => theme.fg("dim", text),
				thumb: text => theme.fg("accent", text),
			},
		});
		this.#editor.setBorderVisible(false);
		this.#editor.setPromptGutter("> ");
		this.#editor.setUseTerminalCursor(false);
		// Keep the editor's CURSOR_MARKER for terminal cursor placement, but
		// replace its visible end-of-input caret with a stable blank cell.
		this.#editor.cursorOverride = " ";
		this.#editor.setScrollbarVisible(true);
		this.#editor.onSubmit = value => this.#commitAnnotation(value);
		this.#resetSourceCursor();
	}

	invalidate(): void {
		this.#staticRenderedDiffBodies = new WeakMap();
	}

	dispose(): void {
		this.#finished = true;
	}

	getAnnotations(): CodeReviewAnnotation[] {
		return this.#annotations.map(entry => ({ ...entry.annotation }));
	}

	getTextAnnotations(): TextReviewAnnotation[] {
		return this.#textAnnotations.map(entry => ({ ...entry.annotation }));
	}

	handleInput(data: string): void {
		if (this.#finished || this.#externalOperation) return;
		if (this.#annotationChooser) {
			this.#handleAnnotationChooser(data);
			return;
		}
		if (this.#annotating) {
			if (matchesAppExternalEditor(data)) {
				void this.#openAnnotationEditor();
				return;
			}
			if (this.#keybindings.matches(data, "tui.select.cancel")) {
				this.#cancelAnnotation();
				return;
			}
			this.#editor.handleInput(data);
			return;
		}
		if (this.#keybindings.matches(data, "tui.select.cancel")) {
			this.#finish(undefined);
			return;
		}
		if (data === "A" && (this.#focus === "files" || this.#focus === "diff")) {
			this.#startAnnotation(this.#textSource ? "text" : "file");
			return;
		}
		if (!this.#textSource && data === "[") {
			this.#selectRelativeFile(-1);
			return;
		}
		if (!this.#textSource && data === "]") {
			this.#selectRelativeFile(1);
			return;
		}
		if (data === "u") {
			this.#undoAnnotation();
			return;
		}
		if (data === "e") {
			this.#editCurrentAnnotation();
			return;
		}
		if (matchesKey(data, "tab") || data === "\t") {
			this.#cycleFocus(1);
			return;
		}
		if (matchesKey(data, "shift+tab") || data === "\x1b[Z") {
			this.#cycleFocus(-1);
			return;
		}
		if (this.#focus === "files") this.#handleFiles(data);
		else if (this.#focus === "diff") this.#handleDiff(data);
		else this.#handleActions(data);
	}

	/** Primary key bound to `action` in this overlay's keybindings, formatted for footer hints. */
	#key(action: Keybinding): string {
		const [key] = this.#keybindings.getKeys(action);
		return key ? formatKeyHint(key) : "";
	}

	#finish(result: CodeReviewOverlayResult | TextReviewOverlayResult | undefined): void {
		if (this.#finished) return;
		this.#finished = true;
		if (this.#textSource) {
			(this.#callbacks as TextReviewOverlayCallbacks).onComplete(result as TextReviewOverlayResult | undefined);
		} else {
			(this.#callbacks as CodeReviewOverlayCallbacks).onComplete(result as CodeReviewOverlayResult | undefined);
		}
	}

	#cycleFocus(direction: number): void {
		const regions: FocusRegion[] = this.#sidebarShown ? ["files", "diff", "actions"] : ["diff", "actions"];
		const current = regions.indexOf(this.#focus);
		const index = current < 0 ? regions.length - 1 : current;
		this.#focus = regions[(index + direction + regions.length) % regions.length]!;
	}

	#handleFiles(data: string): void {
		if (data === "a") {
			this.#startAnnotation("file");
			return;
		}
		if (this.#keybindings.matches(data, "tui.select.up") || matchesKey(data, "k")) {
			this.#selectFile(Math.max(0, this.#fileIndex - 1));
			return;
		}
		if (this.#keybindings.matches(data, "tui.select.down") || matchesKey(data, "j")) {
			this.#selectFile(Math.min(this.#files.length - 1, this.#fileIndex + 1));
			return;
		}
		if (matchesKey(data, "right") || matchesKey(data, "l") || this.#keybindings.matches(data, "tui.select.confirm")) {
			this.#focus = "diff";
		}
	}

	#handleDiff(data: string): void {
		if (data === "a") {
			this.#startAnnotation("line");
			return;
		}
		if (matchesKey(data, "left") || matchesKey(data, "h")) {
			if (this.#sidebarShown) this.#focus = "files";
			return;
		}
		if (matchesKey(data, "right") || matchesKey(data, "l") || this.#keybindings.matches(data, "tui.select.confirm")) {
			this.#focus = "actions";
			return;
		}
		if (matchesKey(data, "shift+up")) {
			this.#moveSourceCursor(-5);
			return;
		}
		if (matchesKey(data, "shift+down")) {
			this.#moveSourceCursor(5);
			return;
		}
		if (this.#keybindings.matches(data, "tui.select.up") || matchesKey(data, "k")) {
			this.#moveSourceCursor(-1);
			return;
		}
		if (this.#keybindings.matches(data, "tui.select.down") || matchesKey(data, "j")) {
			this.#moveSourceCursor(1);
			return;
		}
		if (this.#keybindings.matches(data, "tui.select.pageUp")) {
			if (this.#textSource) {
				this.#scrollView.page(-1);
				this.#textViewportDriven = true;
				this.#syncTextCursorToViewport();
			} else {
				this.#moveSourceCursor(-Math.max(1, this.#bodyHeight - 1));
			}
			return;
		}
		if (this.#keybindings.matches(data, "tui.select.pageDown")) {
			if (this.#textSource) {
				this.#scrollView.page(1);
				this.#textViewportDriven = true;
				this.#syncTextCursorToViewport();
			} else {
				this.#moveSourceCursor(Math.max(1, this.#bodyHeight - 1));
			}
			return;
		}
		if (data === "g" || matchesKey(data, "home")) {
			this.#sourceIndex = 0;
			this.#textViewportDriven = false;
		} else if (data === "G" || matchesKey(data, "end")) {
			this.#sourceIndex = Math.max(
				0,
				(this.#textSource ? this.#textLines.length : this.#currentSourceRows().length) - 1,
			);
			this.#textViewportDriven = false;
		}
	}

	#handleActions(data: string): void {
		const actionCount = this.#actions.length;
		if (actionCount === 0) return;
		const hasAnnotations = this.#textSource ? this.#textAnnotations.length > 0 : this.#annotations.length > 0;
		if (this.#keybindings.matches(data, "tui.select.up") || matchesKey(data, "k")) {
			this.#actionIndex = this.#textSource ? (this.#actionIndex - 1 + actionCount) % actionCount : 0;
			return;
		}
		if (this.#keybindings.matches(data, "tui.select.down") || matchesKey(data, "j")) {
			if (this.#textSource) {
				this.#actionIndex = (this.#actionIndex + 1) % actionCount;
			} else if (hasAnnotations) {
				this.#actionIndex = Math.min(actionCount - 1, this.#actionIndex + 1);
			}
			return;
		}
		if (this.#keybindings.matches(data, "tui.select.confirm")) this.#confirmAction();
	}

	#actionDisabled(index: number): boolean {
		const hasAnnotations = this.#textSource ? this.#textAnnotations.length > 0 : this.#annotations.length > 0;
		return this.#textSource ? !hasAnnotations : index === 1 && !hasAnnotations;
	}

	#confirmAction(): void {
		if (this.#actionDisabled(this.#actionIndex)) return;
		if (this.#textSource) {
			this.#finish({
				action: "paste",
				annotations: this.getTextAnnotations(),
			});
		} else {
			this.#finish({
				action: this.#actionIndex === 0 ? "review" : "paste",
				annotations: this.getAnnotations(),
			});
		}
	}

	#selectFile(index: number): void {
		if (this.#files.length === 0) return;
		this.#fileIndex = Math.max(0, Math.min(this.#files.length - 1, index));
		this.#resetSourceCursor();
		this.#scrollView.scrollToTop();
	}

	#selectRelativeFile(delta: number): void {
		if (this.#files.length === 0) return;
		this.#selectFile((this.#fileIndex + delta + this.#files.length) % this.#files.length);
	}

	#resetSourceCursor(): void {
		this.#sourceIndex = 0;
	}

	#currentFile(): ReviewDiffFile | undefined {
		return this.#files[this.#fileIndex];
	}

	#currentSourceRows(): ReviewSourceRow[] {
		const file = this.#currentFile();
		return file ? file.rows.filter(isSourceRow) : [];
	}
	#syncTextCursorToViewport(): void {
		if (!this.#textSource || this.#textRenderedRowBySource.length === 0) return;
		const viewportTop = this.#scrollView.getScrollOffset();
		const viewportBottom = viewportTop + Math.max(0, this.#bodyHeight - 1);
		let topSourceIndex = 0;
		let lastVisibleSourceIndex = 0;
		for (let index = 1; index < this.#textRenderedRowBySource.length; index++) {
			const renderedRow = this.#textRenderedRowBySource[index];
			if (renderedRow === undefined || renderedRow > viewportBottom) break;
			lastVisibleSourceIndex = index;
			if (renderedRow <= viewportTop) topSourceIndex = index;
		}
		const atBottom =
			this.#scrollView.getMaxScrollOffset() > 0 && viewportTop === this.#scrollView.getMaxScrollOffset();
		this.#sourceIndex = atBottom ? lastVisibleSourceIndex : topSourceIndex;
	}

	#moveSourceCursor(delta: number): void {
		const rowCount = this.#textSource ? this.#textLines.length : this.#currentSourceRows().length;
		if (rowCount === 0) return;
		this.#sourceIndex = Math.max(0, Math.min(rowCount - 1, this.#sourceIndex + delta));
		if (this.#textSource) this.#textViewportDriven = false;
	}

	#startAnnotation(scope: AnnotationScope, existingIndex?: number): void {
		if (this.#textSource) {
			if (scope === "text" || scope === "line") this.#startTextAnnotation(scope, existingIndex);
			return;
		}
		const file = this.#currentFile();
		const source = this.#currentSourceRows()[this.#sourceIndex];
		if (!file || (scope === "line" && (file.isBinary || !source))) {
			this.#callbacks.onWarning?.("This file has no annotatable diff rows");
			return;
		}
		const existing = existingIndex === undefined ? undefined : this.#annotations[existingIndex];
		if (existing && (existing.fileIndex !== this.#fileIndex || existing.annotation.scope !== scope)) {
			return;
		}
		this.#annotationScope = scope === "file" ? "file" : "line";
		this.#editingAnnotationIndex = existingIndex;
		this.#annotating = true;
		this.#editor.setText(existing?.annotation.note ?? "");
	}

	#startTextAnnotation(scope: TextReviewAnnotation["scope"], existingIndex?: number): void {
		const existing = existingIndex === undefined ? undefined : this.#textAnnotations[existingIndex];
		if (existing && existing.annotation.scope !== scope) return;
		this.#annotationScope = scope;
		this.#editingAnnotationIndex = existingIndex;
		this.#annotating = true;
		this.#editor.setText(existing?.annotation.note ?? "");
	}

	#cancelAnnotation(): void {
		this.#annotating = false;
		this.#editingAnnotationIndex = undefined;
		this.#editor.setText("");
	}

	#commitAnnotation(value: string): void {
		if (this.#textSource) {
			this.#commitTextAnnotation(value);
			return;
		}
		const note = value.trim();
		const file = this.#currentFile();
		const source = this.#currentSourceRows()[this.#sourceIndex];
		const editingIndex = this.#editingAnnotationIndex;
		const scope: CodeReviewAnnotation["scope"] = this.#annotationScope === "file" ? "file" : "line";
		this.#annotating = false;
		this.#editingAnnotationIndex = undefined;
		this.#editor.setText("");

		if (!note) {
			if (editingIndex !== undefined) {
				this.#pushUndo();
				this.#annotations.splice(editingIndex, 1);
			}
			return;
		}
		if (editingIndex !== undefined) {
			const existing = this.#annotations[editingIndex];
			if (existing) {
				this.#pushUndo();
				this.#annotations[editingIndex] = {
					...existing,
					annotation: { ...existing.annotation, note },
				};
			}
			return;
		}
		if (!file || (scope === "line" && !source)) return;
		this.#pushUndo();

		const common = {
			path: file.path,
			...(file.oldPath === undefined ? {} : { oldPath: file.oldPath }),
			...(file.newPath === undefined ? {} : { newPath: file.newPath }),
			occurrence: file.occurrence,
			note,
		};
		const annotation: CodeReviewAnnotation =
			scope === "file"
				? { ...common, scope: "file" }
				: {
						...common,
						scope: "line",
						hunkHeader: source!.hunkHeader,
						...(source!.oldLine === undefined ? {} : { oldLine: source!.oldLine }),
						...(source!.newLine === undefined ? {} : { newLine: source!.newLine }),
						rawLine: source!.raw,
					};
		this.#annotations.push({
			fileIndex: this.#fileIndex,
			sourceIndex: scope === "line" ? this.#sourceIndex : -1,
			annotation,
		});
	}

	#commitTextAnnotation(value: string): void {
		const note = value.trim();
		const editingIndex = this.#editingAnnotationIndex;
		const scope: TextReviewAnnotation["scope"] = this.#annotationScope === "text" ? "text" : "line";
		const sourceLine = this.#textLines[this.#sourceIndex] ?? "";
		this.#annotating = false;
		this.#editingAnnotationIndex = undefined;
		this.#editor.setText("");
		if (!note) {
			if (editingIndex !== undefined) {
				this.#pushUndo();
				this.#textAnnotations.splice(editingIndex, 1);
			}
			return;
		}
		if (editingIndex !== undefined) {
			const existing = this.#textAnnotations[editingIndex];
			if (existing) {
				this.#pushUndo();
				this.#textAnnotations[editingIndex] = {
					...existing,
					annotation: { ...existing.annotation, note },
				};
			}
			return;
		}
		this.#pushUndo();
		const annotation: TextReviewAnnotation =
			scope === "text"
				? { scope: "text", note }
				: {
						scope: "line",
						line: this.#sourceIndex + 1,
						quote: sourceLine,
						note,
					};
		this.#textAnnotations.push({
			sourceIndex: scope === "line" ? this.#sourceIndex : -1,
			annotation,
		});
	}

	#annotationCandidates(): number[] {
		if (this.#focus !== "files" && this.#focus !== "diff") return [];
		if (this.#textSource) {
			if (this.#focus !== "diff") return [];
			const lineEntries: number[] = [];
			const textEntries: number[] = [];
			for (const [index, entry] of this.#textAnnotations.entries()) {
				if (entry.annotation.scope === "text") textEntries.push(index);
				else if (entry.sourceIndex === this.#sourceIndex) lineEntries.push(index);
			}
			return [...lineEntries, ...textEntries];
		}
		const lineEntries: number[] = [];
		const fileEntries: number[] = [];
		for (const [index, entry] of this.#annotations.entries()) {
			if (entry.fileIndex !== this.#fileIndex) continue;
			if (entry.annotation.scope === "file") {
				fileEntries.push(index);
			} else if (this.#focus === "diff" && entry.sourceIndex === this.#sourceIndex) {
				lineEntries.push(index);
			}
		}
		return this.#focus === "files" ? fileEntries : [...lineEntries, ...fileEntries];
	}

	#editCurrentAnnotation(): void {
		const entries = this.#annotationCandidates();
		if (entries.length === 0) return;
		if (entries.length === 1) {
			const index = entries[0]!;
			if (this.#textSource) {
				this.#startTextAnnotation(this.#textAnnotations[index]!.annotation.scope, index);
			} else {
				this.#startAnnotation(this.#annotations[index]!.annotation.scope, index);
			}
			return;
		}
		this.#annotationChooser = {
			kind: this.#textSource ? "text" : "diff",
			entries,
			selected: 0,
		};
	}

	#handleAnnotationChooser(data: string): void {
		const chooser = this.#annotationChooser;
		if (!chooser) return;
		if (this.#keybindings.matches(data, "tui.select.cancel")) {
			this.#annotationChooser = undefined;
			return;
		}
		if (this.#keybindings.matches(data, "tui.select.up") || matchesKey(data, "up") || matchesKey(data, "k")) {
			chooser.selected = (chooser.selected - 1 + chooser.entries.length) % chooser.entries.length;
			return;
		}
		if (this.#keybindings.matches(data, "tui.select.down") || matchesKey(data, "down") || matchesKey(data, "j")) {
			chooser.selected = (chooser.selected + 1) % chooser.entries.length;
			return;
		}
		if (this.#keybindings.matches(data, "tui.select.confirm")) this.#openChosenAnnotation(chooser);
	}

	#openChosenAnnotation(chooser: AnnotationChooser): void {
		const index = chooser.entries[chooser.selected];
		this.#annotationChooser = undefined;
		if (index === undefined) return;
		if (chooser.kind === "text") {
			const entry = this.#textAnnotations[index];
			if (entry) this.#startTextAnnotation(entry.annotation.scope, index);
		} else {
			const entry = this.#annotations[index];
			if (entry) this.#startAnnotation(entry.annotation.scope, index);
		}
	}

	#annotationLocation(entry: CommittedAnnotation): string {
		if (entry.annotation.scope === "file") return `${displayFileLabel(this.#files[entry.fileIndex]!)} · file`;
		return `${displayFileLabel(this.#files[entry.fileIndex]!)} · ${entry.annotation.oldLine ?? "-"}/${entry.annotation.newLine ?? "-"}`;
	}

	#textAnnotationLocation(entry: CommittedTextAnnotation): string {
		if (entry.annotation.scope === "text") return `${sanitizeStatusText(this.#textSource?.label ?? "text")} · text`;
		return `${sanitizeStatusText(this.#textSource?.label ?? "text")} · line ${entry.annotation.line}`;
	}

	#pushUndo(): void {
		this.#undoStack.push({ annotations: [...this.#annotations], textAnnotations: [...this.#textAnnotations] });
		this.#annotationRev++;
	}

	#undoAnnotation(): void {
		const snapshot = this.#undoStack.pop();
		if (!snapshot) return;
		this.#annotationRev++;
		this.#annotations = snapshot.annotations;
		this.#textAnnotations = snapshot.textAnnotations;
		if (this.#annotations.length === 0 && this.#actionIndex === 1) this.#actionIndex = 0;
	}

	async #openAnnotationEditor(): Promise<void> {
		if (this.#externalOperation || !this.#annotating) return;
		const openEditor = this.#callbacks.onAnnotationExternalEditor;
		if (!openEditor) {
			this.#callbacks.onWarning?.("External editor is unavailable in this UI host.");
			return;
		}
		const draft = this.#editor.getExpandedText();
		this.#externalOperation = true;
		try {
			await openEditor(draft, text => {
				if (text !== null) this.#editor.setText(text);
			});
		} catch (error) {
			this.#callbacks.onWarning?.(
				`Failed to open external editor: ${error instanceof Error ? error.message : String(error)}`,
			);
		} finally {
			this.#externalOperation = false;
			this.#tui.requestRender(true);
		}
	}

	#annotationCount(fileIndex: number): number {
		let count = 0;
		for (const entry of this.#annotations) if (entry.fileIndex === fileIndex) count++;
		return count;
	}

	#renderBody(contentWidth: number): RenderedBody {
		if (this.#textSource) return this.#renderTextBody(contentWidth);
		const file = this.#currentFile();
		if (!file)
			return {
				lines: [this.#theme.fg("dim", "No reviewable files")],
				renderedRowBySource: [],
			};
		const staticBody = this.#getStaticRenderedBody(file);
		const lines: string[] = [];
		const renderedRowBySource: number[] = [];

		// File notes describe the whole change, so keep them above headers and
		// status rows (including binary and rename-only files).
		for (const entry of this.#annotations) {
			if (entry.fileIndex === this.#fileIndex && entry.annotation.scope === "file") {
				this.#appendAnnotationCallout(lines, entry.annotation.note, contentWidth, "file note");
			}
		}

		let sourceIndex = 0;
		for (let staticRow = 0; staticRow < staticBody.lines.length; staticRow++) {
			const currentSourceIndex =
				staticBody.renderedRowBySource[sourceIndex] === staticRow ? sourceIndex++ : undefined;
			let renderedLine = staticBody.lines[staticRow] ?? "";
			if (currentSourceIndex !== undefined) {
				// Line notes belong immediately before their source row. This keeps
				// the selected row and all notes in a stable, readable order.
				for (const entry of this.#annotations) {
					if (
						entry.fileIndex === this.#fileIndex &&
						entry.sourceIndex === currentSourceIndex &&
						entry.annotation.scope === "line"
					) {
						this.#appendAnnotationCallout(lines, entry.annotation.note, contentWidth);
					}
				}
				renderedRowBySource[currentSourceIndex] = lines.length;
				if (this.#focus === "diff" && currentSourceIndex === this.#sourceIndex) {
					renderedLine = this.#theme.bg(
						"selectedBg",
						fit(staticBody.selectedSourceLines[currentSourceIndex] ?? "", contentWidth),
					);
				}
			}
			lines.push(truncateToWidth(renderedLine, contentWidth));
		}
		return { lines, renderedRowBySource };
	}

	#renderTextBody(contentWidth: number): RenderedBody {
		const lines: string[] = [];
		const renderedRowBySource: number[] = [];
		const textWidth = Math.max(1, contentWidth - SOURCE_SELECTION_GUTTER_WIDTH);

		for (const entry of this.#textAnnotations) {
			if (entry.annotation.scope === "text") {
				this.#appendAnnotationCallout(lines, entry.annotation.note, contentWidth, "text note");
			}
		}

		for (const [sourceIndex, sourceLine] of this.#textLines.entries()) {
			for (const entry of this.#textAnnotations) {
				if (entry.annotation.scope === "line" && entry.sourceIndex === sourceIndex) {
					this.#appendAnnotationCallout(lines, entry.annotation.note, contentWidth);
				}
			}
			renderedRowBySource[sourceIndex] = lines.length;
			const displayLine = replaceTabs(sanitizeText(sourceLine));
			const wrapped = wrapTextWithAnsi(displayLine, textWidth);
			const visualRows = wrapped.length > 0 ? wrapped : [""];
			for (const [rowIndex, visualRow] of visualRows.entries()) {
				const selected = this.#focus === "diff" && sourceIndex === this.#sourceIndex;
				const gutter =
					selected && rowIndex === 0
						? fit(`${this.#theme.nav.cursor} `, SOURCE_SELECTION_GUTTER_WIDTH)
						: " ".repeat(SOURCE_SELECTION_GUTTER_WIDTH);
				const renderedLine = fit(`${gutter}${visualRow}`, contentWidth);
				lines.push(selected ? this.#theme.bg("selectedBg", renderedLine) : renderedLine);
			}
		}
		return { lines, renderedRowBySource };
	}

	#getStaticRenderedBody(file: ReviewDiffFile): RenderedDiffBody {
		const cached = this.#staticRenderedDiffBodies.get(file);
		if (cached) return cached;
		const lines: string[] = [];
		const renderedRowBySource: number[] = [];
		const selectedSourceLines: string[] = [];
		if (file.isBinary) {
			lines.push(this.#theme.fg("dim", "Binary diff; no annotatable source rows"));
		} else if (file.rows.length === 0) {
			lines.push(this.#theme.fg("dim", "No diff hunks; this may be a rename-only change"));
		} else {
			let sourceIndex = 0;
			for (const diffRow of file.rows) {
				if (!isSourceRow(diffRow)) {
					lines.push(
						this.#theme.fg(diffRow.kind === "hunk" ? "accent" : "dim", replaceTabs(sanitizeText(diffRow.raw))),
					);
					continue;
				}
				renderedRowBySource[sourceIndex] = lines.length;
				const marker = diffRow.kind === "added" ? "+" : diffRow.kind === "removed" ? "-" : " ";
				const lineNumber = diffRow.kind === "removed" ? diffRow.oldLine : (diffRow.newLine ?? diffRow.oldLine);
				const suffix = `${marker}${String(lineNumber ?? "").padStart(4)} ${replaceTabs(sanitizeText(diffRow.content))}`;
				const color: DiffColor =
					diffRow.kind === "added"
						? "toolDiffAdded"
						: diffRow.kind === "removed"
							? "toolDiffRemoved"
							: "toolDiffContext";
				const coloredSuffix = this.#theme.fg(color, suffix);
				const gutter = " ".repeat(SOURCE_SELECTION_GUTTER_WIDTH);
				selectedSourceLines[sourceIndex] = `${fit(
					`${this.#theme.nav.cursor} `,
					SOURCE_SELECTION_GUTTER_WIDTH,
				)}${coloredSuffix}`;
				lines.push(`${gutter}${coloredSuffix}`);
				sourceIndex++;
			}
		}
		const body = { lines, renderedRowBySource, selectedSourceLines };
		this.#staticRenderedDiffBodies.set(file, body);
		return body;
	}

	#appendAnnotationCallout(lines: string[], note: string, width: number, label = "note"): void {
		const gutter = this.#theme.fg("warning", "▎ ");
		const labelText = this.#theme.fg("dim", `${label}: `);
		const continuation = `${gutter}${" ".repeat(visibleWidth(labelText))}`;
		for (const [index, noteLine] of note.split(/\r?\n/).entries()) {
			const prefix = index === 0 ? `${gutter}${labelText}` : continuation;
			const available = Math.max(0, width - visibleWidth(prefix));
			const content = truncateToWidth(replaceTabs(sanitizeText(noteLine)), available, Ellipsis.Unicode);
			lines.push(truncateToWidth(`${prefix}${this.#theme.fg("accent", content)}`, width));
		}
	}

	#renderCurrentFileHeader(width: number): string {
		if (this.#textSource) {
			const count = this.#textAnnotations.length;
			const suffix = count ? this.#theme.fg("dim", `  ✎${count}`) : "";
			return truncateToWidth(
				`${this.#theme.bold(sanitizeStatusText(this.#textSource.label))}${suffix}`,
				width,
				Ellipsis.Unicode,
			);
		}
		const file = this.#currentFile();
		if (!file) return this.#theme.fg("dim", "No reviewable files");
		const count = this.#annotationCount(this.#fileIndex);
		const suffix = `  +${file.linesAdded}/-${file.linesRemoved}${count ? `  ✎${count}` : ""}`;
		return truncateToWidth(
			`${this.#theme.bold(sanitizeStatusText(displayFileLabel(file)))}${this.#theme.fg("dim", suffix)}`,
			width,
			Ellipsis.Unicode,
		);
	}

	#renderActions(): string[] {
		const hasAnnotations = this.#textSource ? this.#textAnnotations.length > 0 : this.#annotations.length > 0;
		return this.#actions.map((label, index) => {
			const disabled = this.#textSource ? !hasAnnotations : index === 1 && !hasAnnotations;
			const selected = index === this.#actionIndex;
			const cursor = selected ? `${this.#theme.nav.cursor} ` : "  ";
			const text = disabled
				? this.#theme.fg("dim", label)
				: selected && this.#focus === "actions"
					? this.#theme.bold(this.#theme.fg("accent", label))
					: this.#theme.fg("text", label);
			return cursor + text;
		});
	}

	#renderAnnotationChooser(width: number, maxRows = Number.POSITIVE_INFINITY): string[] {
		const chooser = this.#annotationChooser;
		if (!chooser || maxRows <= 0) return [];
		const availableRows = Number.isFinite(maxRows) ? Math.max(0, Math.floor(maxRows)) : Number.POSITIVE_INFINITY;
		if (availableRows === 1) {
			const index = chooser.entries[chooser.selected];
			if (index === undefined) return [];
			return [this.#renderAnnotationChooserEntry(chooser, index, chooser.selected, width)];
		}
		const optionLimit = Number.isFinite(availableRows) ? Math.max(1, availableRows - 2) : chooser.entries.length;
		const start =
			optionLimit >= chooser.entries.length
				? 0
				: Math.max(
						0,
						Math.min(chooser.selected - Math.floor(optionLimit / 2), chooser.entries.length - optionLimit),
					);
		const options = chooser.entries
			.slice(start, start + optionLimit)
			.map((index, windowIndex) => this.#renderAnnotationChooserEntry(chooser, index, start + windowIndex, width));
		const keysHint = `${this.#key("tui.select.up")}/${this.#key("tui.select.down")} choose · ${this.#key("tui.select.confirm")} edit · ${this.#key("tui.select.cancel")} cancel`;
		const lines =
			availableRows === 2
				? [this.#theme.fg("dim", `Edit annotation · ${keysHint}`), ...options.slice(0, 1)]
				: [this.#theme.fg("dim", `Edit annotation · ${keysHint}`), ...options, this.#theme.fg("dim", keysHint)];
		return Number.isFinite(availableRows) ? lines.slice(0, availableRows) : lines;
	}

	#renderAnnotationChooserEntry(
		chooser: AnnotationChooser,
		index: number,
		optionIndex: number,
		width: number,
	): string {
		const marker = optionIndex === chooser.selected ? `${this.#theme.nav.cursor} ` : "  ";
		if (chooser.kind === "text") {
			const entry = this.#textAnnotations[index];
			if (!entry) return "";
			const location = this.#textAnnotationLocation(entry);
			const note = sanitizeStatusText(entry.annotation.note.split(/\r?\n/, 1)[0] ?? "");
			return fit(`${marker}${location} · ${note}`, width);
		}
		const entry = this.#annotations[index];
		if (!entry) return "";
		const location = this.#annotationLocation(entry);
		const note = sanitizeStatusText(entry.annotation.note.split(/\r?\n/, 1)[0] ?? "");
		return fit(`${marker}${location} · ${note}`, width);
	}

	#renderFooter(width: number, maxChooserRows = Number.POSITIVE_INFINITY): string[] {
		if (this.#annotationChooser) {
			return this.#renderAnnotationChooser(width, maxChooserRows);
		}
		if (this.#annotating) {
			const { action, location } = this.#annotationCaption();
			const caption = truncateToWidth(
				`${this.#theme.fg("dim", action)} ${this.#theme.fg("accent", location)}`,
				width,
				Ellipsis.Unicode,
			);
			const hints = [
				`${editorKey("tui.input.submit")} save`,
				`${editorKey("tui.input.newLine")} newline`,
				`${this.#key("tui.select.cancel")} cancel`,
			];
			const externalEditorKey = appKey(this.#keybindings, "app.editor.external");
			if (externalEditorKey) hints.push(`${externalEditorKey} editor`);
			this.#editor.focused = true;
			return [caption, ...this.#editor.render(width), this.#theme.fg("dim", hints.join(" · "))];
		}
		return [this.#theme.fg("dim", this.#helpText())];
	}

	/** What the active annotation draft does and where it lands. */
	#annotationCaption(): { action: string; location: string } {
		let location: string;
		let action: string;
		if (this.#textSource) {
			const label = sanitizeStatusText(this.#textSource.label);
			location = this.#annotationScope === "text" ? `${label} · text` : `${label} · line ${this.#sourceIndex + 1}`;
			action =
				this.#editingAnnotationIndex === undefined
					? this.#annotationScope === "text"
						? "Annotate text"
						: "Annotate line"
					: "Edit annotation";
		} else {
			const file = this.#currentFile();
			const source = this.#currentSourceRows()[this.#sourceIndex];
			location =
				this.#annotationScope === "file"
					? file
						? `${displayFileLabel(file)} · file`
						: "file"
					: source && file
						? `${displayFileLabel(file)} · ${source.oldLine ?? "-"}/${source.newLine ?? "-"}`
						: "diff row";
			action =
				this.#editingAnnotationIndex === undefined
					? this.#annotationScope === "file"
						? "Annotate file"
						: "Annotate line"
					: "Edit annotation";
		}
		return { action, location: sanitizeStatusText(location) };
	}

	/** Footer help for the focused region. */
	#helpText(): string {
		const upDown = `${this.#key("tui.select.up")}/${this.#key("tui.select.down")}`;
		const confirm = this.#key("tui.select.confirm");
		const editNote = `${formatKeyHint("e")} edit note`;
		const focusHelp =
			this.#focus === "files"
				? `${upDown} file · ${confirm} diff · ${formatKeyHints(["a", "shift+a"])} file note · ${editNote}`
				: this.#focus === "diff"
					? `${upDown} line · ${formatKeyHint("shift")} faster · ${this.#key("tui.select.pageUp")}/${this.#key("tui.select.pageDown")} · ${formatKeyHints(["g", "shift+g"])} ends · ${formatKeyHint("a")} line note · ${formatKeyHint("shift+a")} ${this.#textSource ? "text" : "file"} note · ${editNote}`
					: `${upDown} select · ${confirm} confirm`;
		return `${focusHelp} · ${formatKeyHint("u")} undo · ${formatKeyHint("tab")} regions · ${this.#key("tui.select.cancel")} cancel`;
	}

	#ensureCursorVisible(renderedRowBySource: readonly number[]): void {
		if (this.#textSource && this.#textViewportDriven) return;
		const rowIndex = renderedRowBySource[this.#sourceIndex];
		if (rowIndex === undefined) return;
		const offset = this.#scrollView.getScrollOffset();
		if (rowIndex < offset) this.#scrollView.setScrollOffset(rowIndex);
		else if (rowIndex >= offset + this.#bodyHeight) this.#scrollView.setScrollOffset(rowIndex - this.#bodyHeight + 1);
	}

	#sidebarWidth(width: number): number {
		return Math.max(18, Math.min(32, Math.round(width * 0.28)));
	}

	#canShowSidebar(width: number): boolean {
		return (
			width >= SIDEBAR_MIN_TOTAL_WIDTH && splitBodyWidth(width, this.#sidebarWidth(width)) >= SIDEBAR_MIN_BODY_WIDTH
		);
	}

	#renderSidebar(rows: number, width: number): string[] {
		const start = Math.max(
			0,
			Math.min(this.#fileIndex - Math.floor(rows / 2), Math.max(0, this.#files.length - rows)),
		);
		return Array.from({ length: rows }, (_, rowIndex) => {
			const index = start + rowIndex;
			const file = this.#files[index];
			if (!file) return "";
			const selected = index === this.#fileIndex;
			const count = this.#annotationCount(index);
			const badge = `${this.#theme.fg("dim", ` +${file.linesAdded}/-${file.linesRemoved}`)}${count ? this.#theme.fg("warning", ` ✎${count}`) : ""}`;
			const available = Math.max(0, width - visibleWidth(badge) - 2);
			const label = truncateToWidth(sanitizeStatusText(displayFileLabel(file)), available, Ellipsis.Unicode);
			const cursor = selected ? (this.#focus === "files" ? "› " : "▎ ") : "  ";
			const line = fit(`${cursor}${label}${badge}`, width);
			return selected && this.#focus === "files"
				? this.#theme.bg("selectedBg", this.#theme.bold(line))
				: this.#theme.fg(selected ? "accent" : "muted", line);
		});
	}

	describe(): NativeNode {
		// The terminal lays out the file sidebar; diffs always have one, text never does.
		this.#sidebarShown = !this.#textSource;
		if (!this.#sidebarShown && this.#focus === "files") this.#focus = "diff";
		// Page size for PgUp/PgDn, matching the rendered body height.
		this.#bodyHeight = Math.max(MIN_BODY_ROWS, (process.stdout.rows || 40) - (this.#actions.length + 8));
		this.#editor.focused = this.#annotating;
		const body = this.#describeBodyItems();
		const chooser = this.#annotationChooser;
		const sig = [
			this.#focus,
			this.#fileIndex,
			this.#sourceIndex,
			this.#actionIndex,
			this.#annotating ? `annotating:${this.#annotationScope}:${this.#editingAnnotationIndex}` : "",
			chooser ? `chooser:${chooser.selected}:${chooser.entries.join()}` : "",
		].join("|");
		if (this.#nativeRoot && sig === this.#nativeSig && body === this.#nativeRootBody) return this.#nativeRoot;

		const children: NativeChild[] = [];
		const lines = selectList("lines", body.items, {
			selected: this.#focus === "diff" ? `l${this.#sourceIndex}` : null,
			virtual: true,
			empty: [span(this.#textSource ? "No text" : "No reviewable files", "dim")],
			role: this.#textSource ? "omp.overlay.annotateText.lines" : "omp.overlay.codeReview.diff",
			tone: this.#focus === "diff" ? "accent" : undefined,
		});
		const main = node("col", { grow: 1 }, [this.#describeHeader(), lines], "main");
		if (this.#sidebarShown) {
			const files = selectList(
				"files",
				this.#files.map((file, index) => {
					const count = this.#annotationCount(index);
					const value = [
						span(`+${file.linesAdded}`, "ins"),
						span("/", "dim"),
						span(`-${file.linesRemoved}`, "del"),
					];
					if (count) value.push(span(` ✎${count}`, "warning"));
					return item(`f${index}`, { label: [span(displayFileLabel(file), "path")], value });
				}),
				{
					selected: this.#files.length > 0 ? `f${this.#fileIndex}` : null,
					role: "omp.overlay.codeReview.files",
					tone: this.#focus === "files" ? "accent" : undefined,
				},
			);
			const sidebar = node("col", { max: { w: "34ch" }, shrink: 0 }, [files], "sidebar");
			children.push(keyed(rowNode([sidebar, main], { gap: "md", align: "start" }), "split"));
		} else {
			children.push(main);
		}
		children.push(keyed(text([span(sanitizeStatusText(this.#mode), "accent strong")]), "mode"));
		children.push(
			selectList(
				"actions",
				this.#actions.map((label, index) =>
					item(`a${index}`, { label, disabled: this.#actionDisabled(index) || undefined }),
				),
				{ selected: `a${this.#actionIndex}`, tone: this.#focus === "actions" ? "accent" : undefined },
			),
		);
		children.push(...this.#describeFooter());

		this.#nativeSig = sig;
		this.#nativeRootBody = body;
		this.#nativeRoot = overlayCard(
			this.#textSource ? "omp.overlay.annotateText" : "omp.overlay.codeReview",
			this.#textSource ? TEXT_OVERLAY_TITLE : OVERLAY_TITLE,
			children,
		);
		return this.#nativeRoot;
	}

	handleNativeEvent(event: NativeUiEvent): void {
		if (this.#finished || this.#externalOperation) return;
		if (event.type !== "select" && event.type !== "activate") return;
		const activate = event.type === "activate";
		const leaf = leafKey(event.key);
		const chooser = this.#annotationChooser;
		if (leaf === "chooser") {
			const index = itemIndex(event.item, "c");
			if (!chooser || index < 0 || index >= chooser.entries.length) return;
			chooser.selected = index;
			if (activate) this.#openChosenAnnotation(chooser);
			return;
		}
		// A draft commits against the current file/row, so the target stays put
		// while the editor or the chooser is open.
		if (chooser || this.#annotating) return;
		switch (leaf) {
			case "files": {
				const index = itemIndex(event.item, "f");
				if (index < 0 || index >= this.#files.length) return;
				this.#focus = "files";
				if (index !== this.#fileIndex) this.#selectFile(index);
				if (activate) this.#focus = "diff";
				return;
			}
			case "lines": {
				const index = itemIndex(event.item, "l");
				const rowCount = this.#textSource ? this.#textLines.length : this.#currentSourceRows().length;
				if (index < 0 || index >= rowCount) return;
				this.#focus = "diff";
				this.#sourceIndex = index;
				this.#textViewportDriven = false;
				if (activate) this.#focus = "actions";
				return;
			}
			case "actions": {
				const index = itemIndex(event.item, "a");
				if (index < 0 || index >= this.#actions.length || this.#actionDisabled(index)) return;
				this.#focus = "actions";
				this.#actionIndex = index;
				if (activate) this.#confirmAction();
				return;
			}
		}
	}

	/** One item per diff/text row; annotation callouts are disabled items before their row. */
	#describeBodyItems(): NativeBody {
		const cached = this.#nativeBody;
		if (cached && cached.fileIndex === this.#fileIndex && cached.rev === this.#annotationRev) return cached;
		const items: NativeNode[] = [];
		const note = (key: string, label: string, body: string) =>
			items.push(
				item(key, {
					label: noteSpans(label, sanitizeText(body)),
					disabled: true,
					tone: "warning",
					role: "omp.overlay.codeReview.note",
				}),
			);
		if (this.#textSource) {
			for (const [index, entry] of this.#textAnnotations.entries()) {
				if (entry.annotation.scope === "text") note(`n${index}`, "text note", entry.annotation.note);
			}
			for (const [sourceIndex, sourceLine] of this.#textLines.entries()) {
				for (const [index, entry] of this.#textAnnotations.entries()) {
					if (entry.annotation.scope === "line" && entry.sourceIndex === sourceIndex) {
						note(`n${index}`, "note", entry.annotation.note);
					}
				}
				items.push(item(`l${sourceIndex}`, { label: sanitizeText(sourceLine) }));
			}
		} else {
			const file = this.#currentFile();
			if (file) {
				for (const [index, entry] of this.#annotations.entries()) {
					if (entry.fileIndex === this.#fileIndex && entry.annotation.scope === "file") {
						note(`n${index}`, "file note", entry.annotation.note);
					}
				}
				if (file.isBinary) {
					items.push(
						item("binary", { label: [span("Binary diff; no annotatable source rows", "dim")], disabled: true }),
					);
				} else if (file.rows.length === 0) {
					items.push(
						item("empty", {
							label: [span("No diff hunks; this may be a rename-only change", "dim")],
							disabled: true,
						}),
					);
				}
				let sourceIndex = 0;
				for (const [rowIndex, diffRow] of file.isBinary ? [] : file.rows.entries()) {
					if (!isSourceRow(diffRow)) {
						const s = diffRow.kind === "hunk" ? "accent" : "dim";
						items.push(item(`r${rowIndex}`, { label: [span(sanitizeText(diffRow.raw), s)], disabled: true }));
						continue;
					}
					for (const [index, entry] of this.#annotations.entries()) {
						if (
							entry.fileIndex === this.#fileIndex &&
							entry.sourceIndex === sourceIndex &&
							entry.annotation.scope === "line"
						) {
							note(`n${index}`, "note", entry.annotation.note);
						}
					}
					const marker = diffRow.kind === "added" ? "+" : diffRow.kind === "removed" ? "-" : " ";
					const lineNumber = diffRow.kind === "removed" ? diffRow.oldLine : (diffRow.newLine ?? diffRow.oldLine);
					const color: DiffColor =
						diffRow.kind === "added"
							? "toolDiffAdded"
							: diffRow.kind === "removed"
								? "toolDiffRemoved"
								: "toolDiffContext";
					items.push(
						item(`l${sourceIndex}`, {
							label: [
								span(marker, `${color} mono`),
								span(`${lineNumber ?? ""} `, "num dim mono"),
								span(sanitizeText(diffRow.content), `${color} mono`),
							],
						}),
					);
					sourceIndex++;
				}
			}
		}
		this.#nativeBody = { fileIndex: this.#fileIndex, rev: this.#annotationRev, items };
		return this.#nativeBody;
	}

	#describeHeader(): NativeNode {
		if (this.#textSource) {
			const count = this.#textAnnotations.length;
			const spans = [span(sanitizeStatusText(this.#textSource.label), "strong")];
			if (count) spans.push(span(` ✎${count}`, "dim"));
			return keyed(text(spans, { truncate: "end" }), "header");
		}
		const file = this.#currentFile();
		if (!file) return keyed(text([span("No reviewable files", "dim")]), "header");
		const count = this.#annotationCount(this.#fileIndex);
		const spans = [
			span(sanitizeStatusText(displayFileLabel(file)), "strong path"),
			span(` +${file.linesAdded}`, "ins"),
			span("/", "dim"),
			span(`-${file.linesRemoved}`, "del"),
		];
		if (count) spans.push(span(` ✎${count}`, "dim"));
		return keyed(text(spans, { truncate: "middle" }), "header");
	}

	#describeFooter(): NativeChild[] {
		const chooser = this.#annotationChooser;
		if (chooser) {
			const entries = chooser.entries.map((index, i) => {
				const entry = chooser.kind === "text" ? this.#textAnnotations[index] : this.#annotations[index];
				const location = !entry
					? ""
					: "fileIndex" in entry
						? this.#annotationLocation(entry)
						: this.#textAnnotationLocation(entry);
				return item(`c${i}`, {
					label: sanitizeStatusText(entry?.annotation.note.split(/\r?\n/, 1)[0] ?? ""),
					detail: location,
				});
			});
			return [
				keyed(text([span("Edit annotation", "accent strong")]), "chooserHead"),
				selectList("chooser", entries, { selected: `c${chooser.selected}` }),
				hintsRow(
					[
						this.#hint(["tui.select.up", "tui.select.down"], "choose"),
						this.#hint("tui.select.confirm", "edit"),
						this.#hint("tui.select.cancel", "cancel"),
					],
					"chooserHints",
				),
			];
		}
		if (this.#annotating) {
			const { action, location } = this.#annotationCaption();
			return [
				keyed(text([span(`${action} `, "dim"), span(location, "accent")], { truncate: "end" }), "annotateHead"),
				this.#editor,
				hintsRow(
					[
						this.#hint("tui.input.submit", "save"),
						this.#hint("tui.input.newLine", "newline"),
						this.#hint("tui.select.cancel", "cancel"),
						this.#hint("app.editor.external", "editor"),
					],
					"annotateHints",
				),
			];
		}
		const key = (keys: KeyName | readonly KeyName[], label: string): NativeHint => ({
			keys: typeof keys === "string" ? [keys] : keys,
			label,
		});
		const upDown = (label: string) => this.#hint(["tui.select.up", "tui.select.down"], label);
		const editNote = key("e", "edit note");
		const hints: (NativeHint | undefined)[] =
			this.#focus === "files"
				? [upDown("file"), this.#hint("tui.select.confirm", "diff"), key(["a", "shift+a"], "file note"), editNote]
				: this.#focus === "diff"
					? [
							upDown("line"),
							key("shift", "faster"),
							this.#hint(["tui.select.pageUp", "tui.select.pageDown"], "page"),
							key(["g", "shift+g"], "ends"),
							key("a", "line note"),
							key("shift+a", this.#textSource ? "text note" : "file note"),
							editNote,
						]
					: [upDown("select"), this.#hint("tui.select.confirm", "confirm")];
		hints.push(key("u", "undo"), key("tab", "regions"), this.#hint("tui.select.cancel", "cancel"));
		return [hintsRow(hints)];
	}

	/** Keycap hint for the primary keys this overlay's keybindings bind to `actions`. */
	#hint(actions: Keybinding | readonly Keybinding[], label: string): NativeHint | undefined {
		const keys: KeyName[] = [];
		for (const action of typeof actions === "string" ? [actions] : actions) {
			const [key] = this.#keybindings.getKeys(action);
			if (key) keys.push(key);
		}
		return keys.length > 0 ? { keys, label } : undefined;
	}

	render(width: number): readonly string[] {
		const terminalHeight = process.stdout.rows || 40;
		this.#sidebarShown = this.#textSource ? false : this.#canShowSidebar(width);
		if (!this.#sidebarShown && this.#focus === "files") this.#focus = "diff";
		const sidebarWidth = this.#sidebarShown ? this.#sidebarWidth(width) : 0;
		const innerWidth = Math.max(1, width - 4);
		const bodyWidth = this.#sidebarShown ? splitBodyWidth(width, sidebarWidth) : innerWidth;
		this.#editor.setMaxHeight(Math.max(1, Math.min(MAX_ANNOTATION_EDITOR_ROWS, terminalHeight - 12)));
		this.#editor.focused = this.#annotating;
		const chooserBaseRows = terminalHeight - (this.#actions.length + 7);
		const chooserFooterRows = this.#annotationChooser
			? Math.max(0, Math.min(chooserBaseRows, Math.max(3, chooserBaseRows - MIN_BODY_ROWS)))
			: Number.POSITIVE_INFINITY;
		const footer = this.#renderFooter(innerWidth, chooserFooterRows);
		const fixedRows = this.#actions.length + footer.length + 7;
		const availableBodyRows = terminalHeight - fixedRows;
		this.#bodyHeight = this.#annotationChooser
			? Math.max(0, availableBodyRows)
			: Math.max(MIN_BODY_ROWS, availableBodyRows);
		const renderedBody = this.#renderBody(this.#textSource ? Math.max(1, bodyWidth - 1) : bodyWidth);
		this.#scrollView.setLines(renderedBody.lines);
		this.#scrollView.setHeight(this.#bodyHeight);
		if (this.#textSource) {
			this.#textRenderedRowBySource = renderedBody.renderedRowBySource;
			if (this.#textViewportDriven) this.#syncTextCursorToViewport();
		}
		this.#ensureCursorVisible(renderedBody.renderedRowBySource);
		const body = this.#scrollView.render(bodyWidth);
		const output: string[] = [];
		if (this.#sidebarShown) {
			const sidebar = this.#renderSidebar(this.#bodyHeight + 1, sidebarWidth);
			output.push(topBorderSplit(width, this.#textSource ? TEXT_OVERLAY_TITLE : OVERLAY_TITLE, sidebarWidth));
			output.push(splitRow(sidebar[0] ?? "", this.#renderCurrentFileHeader(bodyWidth), width, sidebarWidth));
			for (let index = 0; index < this.#bodyHeight; index++) {
				output.push(splitRow(sidebar[index + 1] ?? "", body[index] ?? "", width, sidebarWidth));
			}
			output.push(dividerSplit(width, sidebarWidth));
		} else {
			output.push(topBorder(width, this.#textSource ? TEXT_OVERLAY_TITLE : OVERLAY_TITLE));
			output.push(row(this.#renderCurrentFileHeader(innerWidth), width));
			for (const bodyLine of body) output.push(row(bodyLine, width));
			output.push(divider(width));
		}
		output.push(row(this.#theme.bold(this.#theme.fg("accent", sanitizeStatusText(this.#mode))), width));
		for (const action of this.#renderActions()) output.push(row(action, width));
		output.push(divider(width));
		for (const footerLine of footer) output.push(row(footerLine, width));
		output.push(bottomBorder(width));
		return output;
	}
}
