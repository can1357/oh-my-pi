import {
	type Focusable,
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
import { compositeLineAt } from "../render/composite";
import { wrapLiteralLine } from "../utils";
import { editorKey } from "../chrome/keybinding-hints";
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
import { appExternalEditorKey, matchesAppExternalEditor } from "../keybinding-matchers";
import type { KeyName } from "../key-hint-format";
import type { TspSpan } from "@oh-my-pi/pi-wire";
import { col, item, keyed, node, row as rowNode, span, text } from "../native/describe";
import { leafKey, type NativeChild, type NativeNode, type NativeUiEvent } from "../native/node";
import { actionButton, hintsRow, itemIndex, type NativeHint, selectList } from "../native/overlay";

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
	/** Open the current source in the host's editor. The overlay stays open. */
	onExternalEditor?(): void | Promise<void>;
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
	sourceIndexByRenderedRow: Array<number | undefined>;
	selectedSourceLines: Array<string | undefined>;
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

/** Splits a text source into the overlay's 1-based annotatable lines. */
export function splitTextLines(text: string): string[] {
	return text.split(/\r\n|\n|\r/);
}

function isTextSource(value: readonly ReviewDiffFile[] | TextReviewSource): value is TextReviewSource {
	return !Array.isArray(value);
}

/** The native sheet: full-pane glass, titled by the review kind with what is under review after it. */
interface NativeSheet {
	readonly role: "omp.overlay.codeReview" | "omp.overlay.annotateText";
	readonly size: "full";
	readonly head: TspSpan[];
}
const DIFF_SHEET_TITLE = "Code review";
const TEXT_SHEET_TITLE = "Annotate text";

const NOTE_PLACEHOLDER = "Write a note…";

type FileStatus = "added" | "deleted" | "renamed" | "modified";
const FILE_STATUS_ICON: Record<FileStatus, string> = {
	added: "file-plus",
	deleted: "trash",
	renamed: "forward",
	modified: "file",
};
const FILE_STATUS_TONE: Record<FileStatus, "success" | "error" | "info" | undefined> = {
	added: "success",
	deleted: "error",
	renamed: "info",
	modified: undefined,
};
const kFileStatus = Symbol("annotation.fileStatus");

/** How a file changed, read from its diff header (memoized on the frozen file). */
function fileStatus(file: ReviewDiffFile & { [kFileStatus]?: FileStatus }): FileStatus {
	let status = file[kFileStatus];
	if (status) return status;
	const hunk = file.rawDiff.indexOf("\n@@");
	const header = file.rawDiff.slice(0, hunk < 0 ? 4096 : hunk);
	status = /^new file mode/m.test(header)
		? "added"
		: /^deleted file mode/m.test(header)
			? "deleted"
			: file.oldPath !== undefined && file.newPath !== undefined && file.oldPath !== file.newPath
				? "renamed"
				: "modified";
	file[kFileStatus] = status;
	return status;
}

/** `src/ui/app.ts` → `{ dir: "src/ui", leaf: "app.ts" }`. */
function splitPath(path: string): { dir: string; leaf: string } {
	const slash = path.lastIndexOf("/");
	return slash < 0 ? { dir: "", leaf: path } : { dir: path.slice(0, slash), leaf: path.slice(slash + 1) };
}

/** `3 files`, `1 note`. */
function plural(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** A review mode line, muted, with its `backticked` refs as code chips. */
function modeSpans(mode: string): TspSpan[] {
	return mode.split("`").flatMap((part, index) => (part ? [span(part, index % 2 === 1 ? "code" : "muted")] : []));
}

/** A fullscreen, annotated diff picker that only relies on public OMP APIs. */
export class AnnotationOverlay implements Focusable {
	focused = false;
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
	/** Set once {@link replaceTextSource} runs; the paste result then carries the edited text. */
	#textSourceEdited = false;
	#finished = false;
	#annotations: CommittedAnnotation[] = [];
	#textAnnotations: CommittedTextAnnotation[] = [];
	/** Annotation lists before each create/edit/delete, restored by `u`. */
	#undoStack: Array<{ annotations: CommittedAnnotation[]; textAnnotations: CommittedTextAnnotation[] }> = [];
	#actions: readonly string[] = CODE_REVIEW_ACTIONS;
	#textSource: TextReviewSource | undefined;
	#textLines: readonly string[] = [];
	#viewportDriven = false;
	/** Last viewport move went toward the end, so a viewport resting at its maximum offset selects the last visible row. */
	#viewportTowardEnd = false;
	#renderedRowBySource: readonly number[] = [];
	#staticRenderedDiffBodies = new WeakMap<ReviewDiffFile, { width: number; body: RenderedDiffBody }>();
	/** Bumped on every annotation change (each one pushes an undo snapshot) and on undo. */
	#annotationRev = 0;
	#nativeBody: NativeBody | undefined;
	#nativeSig = "";
	#nativeRoot: NativeNode | undefined;
	/** Body the memoized root was built from. */
	#nativeRootBody: NativeBody | undefined;
	#nativeSheet: NativeSheet | undefined;

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
		this.#editor.describePlaceholder = () => NOTE_PLACEHOLDER;
		this.#editor.setScrollbarVisible(true);
		this.#editor.onSubmit = value => this.#commitAnnotation(value);
		this.#resetSourceCursor();
	}

	/** Keep the nested editor's cursor mode aligned with the overlay focus target. */
	setUseTerminalCursor(useTerminalCursor: boolean): void {
		this.#editor.setUseTerminalCursor(useTerminalCursor);
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

	/** Repo-relative path of the diff file under the cursor, if this is a code review. */
	reviewFilePath(): string | undefined {
		const file = this.#files[this.#fileIndex];
		if (!file) return undefined;
		return file.newPath ?? file.oldPath ?? file.path;
	}

	/** Current text-source bytes, including edits applied by {@link replaceTextSource}. */
	textSourceText(): string | undefined {
		return this.#textSource?.text;
	}

	/**
	 * Replace the text under review. Line notes whose quote still sits on the
	 * same row stay; a quote that moved to exactly one row is retargeted;
	 * every other line note is dropped. Returns how many were dropped.
	 */
	replaceTextSource(text: string): number {
		if (!this.#textSource) return 0;
		this.#textSource = { ...this.#textSource, text };
		this.#textSourceEdited = true;
		this.#textLines = splitTextLines(text);
		this.#viewportDriven = false;
		this.#sourceIndex = Math.min(this.#sourceIndex, Math.max(0, this.#textLines.length - 1));
		let dropped = 0;
		const kept: CommittedTextAnnotation[] = [];
		for (const entry of this.#textAnnotations) {
			if (entry.annotation.scope !== "line") {
				kept.push(entry);
				continue;
			}
			const quote = entry.annotation.quote;
			if (this.#textLines[entry.sourceIndex] === quote) {
				kept.push(entry);
				continue;
			}
			const matches = this.#textLines.flatMap((line, index) => (line === quote ? [index] : []));
			const only = matches.length === 1 ? matches[0] : undefined;
			if (only !== undefined) {
				kept.push({
					sourceIndex: only,
					annotation: { ...entry.annotation, line: only + 1 },
				});
				continue;
			}
			dropped++;
		}
		this.#textAnnotations = kept;
		// Earlier snapshots hold notes anchored to the old text; undo must not resurrect them.
		this.#undoStack = [];
		this.#annotationRev++;
		this.#nativeBody = undefined;
		return dropped;
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
			this.#escape();
			return;
		}
		if (this.#callbacks.onExternalEditor && matchesAppExternalEditor(data)) {
			void this.#openSourceEditor();
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

	/** Esc, by state: leave the note chooser, drop the note draft, else close the review. */
	#escape(): void {
		if (this.#annotationChooser) this.#annotationChooser = undefined;
		else if (this.#annotating) this.#cancelAnnotation();
		else this.#finish(undefined);
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
			if (this.#tui.nativeRendering && !this.#textSource) {
				this.#moveSourceCursor(-Math.max(1, this.#bodyHeight - 1));
			} else {
				this.#scrollView.page(-1);
				this.#viewportDriven = true;
				this.#viewportTowardEnd = false;
				this.#syncCursorToViewport();
			}
			return;
		}
		if (this.#keybindings.matches(data, "tui.select.pageDown")) {
			if (this.#tui.nativeRendering && !this.#textSource) {
				this.#moveSourceCursor(Math.max(1, this.#bodyHeight - 1));
			} else {
				this.#scrollView.page(1);
				this.#viewportDriven = true;
				this.#viewportTowardEnd = true;
				this.#syncCursorToViewport();
			}
			return;
		}
		if (data === "g" || matchesKey(data, "home")) {
			this.#sourceIndex = 0;
			if (this.#textSource || this.#tui.nativeRendering) {
				this.#viewportDriven = false;
			} else {
				this.#scrollView.scrollToTop();
				this.#viewportDriven = true;
				this.#viewportTowardEnd = false;
			}
		} else if (data === "G" || matchesKey(data, "end")) {
			this.#sourceIndex = Math.max(
				0,
				(this.#textSource ? this.#textLines.length : this.#currentSourceRows().length) - 1,
			);
			if (this.#textSource || this.#tui.nativeRendering) {
				this.#viewportDriven = false;
			} else {
				this.#scrollView.scrollToBottom();
				this.#viewportDriven = true;
				this.#viewportTowardEnd = true;
			}
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
				...(this.#textSourceEdited ? { editedText: this.#textSource.text } : {}),
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
		this.#viewportDriven = false;
	}

	#currentFile(): ReviewDiffFile | undefined {
		return this.#files[this.#fileIndex];
	}

	#currentSourceRows(): ReviewSourceRow[] {
		const file = this.#currentFile();
		return file ? file.rows.filter(isSourceRow) : [];
	}
	#syncCursorToViewport(): void {
		if (this.#renderedRowBySource.length === 0) return;
		const viewportTop = this.#scrollView.getScrollOffset();
		const viewportBottom = viewportTop + Math.max(0, this.#bodyHeight - 1);
		let topSourceIndex = 0;
		let lastVisibleSourceIndex = 0;
		for (let index = 1; index < this.#renderedRowBySource.length; index++) {
			const renderedRow = this.#renderedRowBySource[index];
			if (renderedRow === undefined || renderedRow > viewportBottom) break;
			lastVisibleSourceIndex = index;
			if (renderedRow <= viewportTop) topSourceIndex = index;
		}
		// A short pane has no scroll range, so paging toward the end must still reach the last row.
		const atBottom = this.#viewportTowardEnd && viewportTop >= this.#scrollView.getMaxScrollOffset();
		this.#sourceIndex = atBottom ? lastVisibleSourceIndex : topSourceIndex;
	}

	#moveSourceCursor(delta: number): void {
		const rowCount = this.#textSource ? this.#textLines.length : this.#currentSourceRows().length;
		if (rowCount === 0) return;
		this.#sourceIndex = Math.max(0, Math.min(rowCount - 1, this.#sourceIndex + delta));
		this.#viewportDriven = false;
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

	async #openSourceEditor(): Promise<void> {
		const openEditor = this.#callbacks.onExternalEditor;
		if (this.#externalOperation || !openEditor) return;
		this.#externalOperation = true;
		try {
			await openEditor();
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
		const staticBody = this.#getStaticRenderedBody(file, contentWidth);
		const lines: string[] = [];
		const renderedRowBySource: number[] = [];

		// File notes describe the whole change, so keep them above headers and
		// status rows (including binary and rename-only files).
		for (const entry of this.#annotations) {
			if (entry.fileIndex === this.#fileIndex && entry.annotation.scope === "file") {
				this.#appendAnnotationCallout(lines, entry.annotation.note, contentWidth, "file note");
			}
		}

		for (let staticRow = 0; staticRow < staticBody.lines.length; staticRow++) {
			const currentSourceIndex = staticBody.sourceIndexByRenderedRow[staticRow];
			let renderedLine = staticBody.lines[staticRow] ?? "";
			if (currentSourceIndex !== undefined && staticBody.renderedRowBySource[currentSourceIndex] === staticRow) {
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
			}
			if (this.#focus === "diff" && currentSourceIndex === this.#sourceIndex) {
				renderedLine = staticBody.selectedSourceLines[staticRow] ?? renderedLine;
				renderedLine = this.#theme.bg("selectedBg", fit(renderedLine, contentWidth));
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
			const visualRows = wrapLiteralLine(displayLine, textWidth);
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

	#getStaticRenderedBody(file: ReviewDiffFile, contentWidth: number): RenderedDiffBody {
		const normalizedWidth = Math.max(1, Math.floor(contentWidth));
		const cached = this.#staticRenderedDiffBodies.get(file);
		if (cached?.width === normalizedWidth) return cached.body;
		const lines: string[] = [];
		const renderedRowBySource: number[] = [];
		const sourceIndexByRenderedRow: Array<number | undefined> = [];
		const selectedSourceLines: Array<string | undefined> = [];
		const pushStaticLine = (line: string) => {
			lines.push(line);
			sourceIndexByRenderedRow.push(undefined);
			selectedSourceLines.push(undefined);
		};
		if (file.isBinary) {
			pushStaticLine(this.#theme.fg("dim", "Binary diff; no annotatable source rows"));
		} else if (file.rows.length === 0) {
			pushStaticLine(this.#theme.fg("dim", "No diff hunks; this may be a rename-only change"));
		} else {
			let sourceIndex = 0;
			for (const diffRow of file.rows) {
				if (!isSourceRow(diffRow)) {
					pushStaticLine(
						this.#theme.fg(diffRow.kind === "hunk" ? "accent" : "dim", replaceTabs(sanitizeText(diffRow.raw))),
					);
					continue;
				}
				const marker = diffRow.kind === "added" ? "+" : diffRow.kind === "removed" ? "-" : " ";
				const lineNumber = diffRow.kind === "removed" ? diffRow.oldLine : (diffRow.newLine ?? diffRow.oldLine);
				const prefix = `${marker}${String(lineNumber ?? "").padStart(4)} `;
				const prefixWidth = visibleWidth(prefix);
				const contentColor: DiffColor =
					diffRow.kind === "added"
						? "toolDiffAdded"
						: diffRow.kind === "removed"
							? "toolDiffRemoved"
							: "toolDiffContext";
				const sourceContent = replaceTabs(sanitizeText(diffRow.content));
				const contentWidthForRow = Math.max(1, normalizedWidth - SOURCE_SELECTION_GUTTER_WIDTH - prefixWidth);
				const visualRows = wrapLiteralLine(sourceContent, contentWidthForRow);
				const firstRenderedRow = lines.length;
				renderedRowBySource[sourceIndex] = firstRenderedRow;
				for (const [rowIndex, visualRow] of visualRows.entries()) {
					const first = rowIndex === 0;
					const gutter = " ".repeat(SOURCE_SELECTION_GUTTER_WIDTH);
					const continuationPrefix = " ".repeat(prefixWidth);
					const prefixForRow = first ? this.#theme.fg(contentColor, prefix) : continuationPrefix;
					const selectedGutter = first ? fit(`${this.#theme.nav.cursor} `, SOURCE_SELECTION_GUTTER_WIDTH) : gutter;
					const styledRow = this.#theme.fg(contentColor, visualRow);
					lines.push(`${gutter}${prefixForRow}${styledRow}`);
					sourceIndexByRenderedRow.push(sourceIndex);
					selectedSourceLines.push(`${selectedGutter}${prefixForRow}${styledRow}`);
				}
				sourceIndex++;
			}
		}
		const body = { lines, renderedRowBySource, sourceIndexByRenderedRow, selectedSourceLines };
		this.#staticRenderedDiffBodies.set(file, { width: normalizedWidth, body });
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
		this.#editor.focused = this.focused && this.#annotating;
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
			hints.push(`${formatKeyHint(appExternalEditorKey())} editor`);
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
		const editorHint = this.#callbacks.onExternalEditor ? ` · ${formatKeyHint(appExternalEditorKey())} editor` : "";
		return `${focusHelp} · ${formatKeyHint("u")} undo · ${formatKeyHint("tab")} regions${editorHint} · ${this.#key("tui.select.cancel")} cancel`;
	}

	#ensureCursorVisible(renderedRowBySource: readonly number[]): boolean {
		this.#renderedRowBySource = renderedRowBySource;
		if (this.#viewportDriven) {
			const sourceIndex = this.#sourceIndex;
			if (!this.#annotating && !this.#annotationChooser) this.#syncCursorToViewport();
			return this.#sourceIndex !== sourceIndex;
		}
		const rowIndex = renderedRowBySource[this.#sourceIndex];
		if (rowIndex === undefined) return false;
		const offset = this.#scrollView.getScrollOffset();
		if (rowIndex < offset) this.#scrollView.setScrollOffset(rowIndex);
		else if (rowIndex >= offset + this.#bodyHeight) this.#scrollView.setScrollOffset(rowIndex - this.#bodyHeight + 1);
		return false;
	}

	#sidebarWidth(width: number): number {
		return Math.max(18, Math.min(32, Math.round(width * 0.28)));
	}

	#canShowSidebar(width: number): boolean {
		return (
			width >= SIDEBAR_MIN_TOTAL_WIDTH && splitBodyWidth(width, this.#sidebarWidth(width)) >= SIDEBAR_MIN_BODY_WIDTH
		);
	}

	#sidebarStart(rows: number): number {
		return Math.max(0, Math.min(this.#fileIndex - Math.floor(rows / 2), Math.max(0, this.#files.length - rows)));
	}

	#renderSidebarBadge(file: ReviewDiffFile, count: number): string {
		const changes = ` +${file.linesAdded}/-${file.linesRemoved}`;
		const annotations = count ? ` ✎${count}` : "";
		return this.#theme.fg("dim", changes) + (annotations ? this.#theme.fg("warning", annotations) : "");
	}

	#sidebarLabelWidth(file: ReviewDiffFile, count: number, width: number): number {
		const badge = this.#renderSidebarBadge(file, count);
		return Math.max(0, width - visibleWidth(badge) - 2);
	}

	#renderSidebar(rows: number, width: number): string[] {
		const start = this.#sidebarStart(rows);
		return Array.from({ length: rows }, (_, rowIndex) => {
			const index = start + rowIndex;
			const file = this.#files[index];
			if (!file) return "";
			const selected = index === this.#fileIndex;
			const count = this.#annotationCount(index);
			const badge = this.#renderSidebarBadge(file, count);
			const available = this.#sidebarLabelWidth(file, count, width);
			const label = truncateToWidth(sanitizeStatusText(displayFileLabel(file)), available, Ellipsis.Unicode);
			const cursor = selected ? (this.#focus === "files" ? "› " : "▎ ") : "  ";
			const line = fit(`${cursor}${label}${badge}`, width);
			return selected && this.#focus === "files"
				? this.#theme.bg("selectedBg", this.#theme.bold(line))
				: this.#theme.fg(selected ? "accent" : "muted", line);
		});
	}

	#revealSelectedFile(output: string[], width: number): void {
		const file = this.#currentFile();
		if (
			!file ||
			!this.#sidebarShown ||
			this.#textSource ||
			this.#focus !== "files" ||
			this.#annotating ||
			this.#annotationChooser
		) {
			return;
		}

		const pathColumn = 4;
		const lineWidth = Math.max(0, width - pathColumn - 1);
		if (lineWidth === 0) return;

		const selectedRow = 1 + this.#fileIndex - this.#sidebarStart(this.#bodyHeight + 1);
		const interiorTop = 1;
		const lastBodyRow = this.#bodyHeight + 1;
		const interiorRows = lastBodyRow - interiorTop + 1;
		if (selectedRow < interiorTop || selectedRow > lastBodyRow || interiorRows <= 0) return;

		const label = replaceTabs(sanitizeStatusText(displayFileLabel(file)));
		if (!label) return;
		const count = this.#annotationCount(this.#fileIndex);
		if (visibleWidth(label) <= this.#sidebarLabelWidth(file, count, this.#sidebarWidth(width))) return;

		let wrapped = wrapTextWithAnsi(label, lineWidth);
		if (wrapped.length > interiorRows) {
			wrapped = wrapped.slice(-interiorRows);
			wrapped[0] = truncateToWidth(`…${wrapped[0] ?? ""}`, lineWidth, Ellipsis.Omit);
		}
		const overlayTop = Math.max(interiorTop, Math.min(selectedRow, lastBodyRow - wrapped.length + 1));
		const overlayWidth = Math.min(lineWidth, Math.max(0, ...wrapped.map(visibleWidth)) + 1);
		for (const [index, line] of wrapped.entries()) {
			const highlighted = this.#theme.bg("selectedBg", this.#theme.bold(fit(line, overlayWidth)));
			const targetRow = overlayTop + index;
			const baseLine = output[targetRow];
			if (overlayWidth > 0 && baseLine !== undefined) {
				output[targetRow] = compositeLineAt(baseLine, highlighted, pathColumn, overlayWidth, width);
			}
		}
	}

	/**
	 * The terminal draws the frame: a full-pane glass sheet titled `Code review`
	 * (or `Annotate text`), then what is under review as a quieter subtitle.
	 */
	get nativeOverlay(): NativeSheet {
		if (!this.#nativeSheet) {
			const subtitle = this.#textSource
				? [span(sanitizeStatusText(this.#textSource.label), "muted")]
				: modeSpans(sanitizeStatusText(this.#mode));
			this.#nativeSheet = {
				role: this.#textSource ? "omp.overlay.annotateText" : "omp.overlay.codeReview",
				size: "full",
				head: [span(this.#textSource ? TEXT_SHEET_TITLE : DIFF_SHEET_TITLE), ...subtitle],
			};
		}
		return this.#nativeSheet;
	}

	/**
	 * The sheet's body: the file rail (totals over the changed files) beside
	 * the current file's diff (text: its numbered lines), the note composer
	 * docked under the lines while a note is open, and a footer of key hints
	 * and the actions.
	 */
	describe(): NativeNode {
		// The terminal lays out the file sidebar; diffs always have one, text never does.
		this.#sidebarShown = !this.#textSource;
		if (!this.#sidebarShown && this.#focus === "files") this.#focus = "diff";
		// Page size for PgUp/PgDn, matching the rendered body height.
		const terminalHeight = this.#tui.terminal.rows;
		this.#bodyHeight = Math.max(MIN_BODY_ROWS, terminalHeight - (this.#actions.length + 8));
		this.#editor.setMaxHeight(Math.max(1, Math.min(MAX_ANNOTATION_EDITOR_ROWS, terminalHeight - 12)));
		this.#editor.focused = this.focused && this.#annotating;
		const body = this.#describeBodyItems();
		const chooser = this.#annotationChooser;
		const sig = [
			this.#focus,
			this.#fileIndex,
			this.#sourceIndex,
			this.#actionIndex,
			this.#bodyHeight,
			this.#annotating ? `annotating:${this.#annotationScope}:${this.#editingAnnotationIndex}` : "",
			chooser ? `chooser:${chooser.selected}:${chooser.entries.join()}` : "",
		].join("|");
		if (this.#nativeRoot && sig === this.#nativeSig && body === this.#nativeRootBody) return this.#nativeRoot;

		const editing = this.#annotating || chooser !== undefined;
		const rowCount = this.#textSource ? this.#textLines.length : this.#currentSourceRows().length;
		const lines = selectList("lines", body.items, {
			selected: rowCount > 0 ? `l${this.#sourceIndex}` : null,
			// Past 200 rows the terminal virtualizes the list itself (fixed one-line rows).
			max: { lines: this.#bodyHeight },
			empty: [span(this.#textSource ? "This text is empty" : "Nothing to review", "muted")],
			role: this.#textSource ? "omp.review.text" : "omp.review.diff",
			tone: this.#focus === "diff" && !editing ? "accent" : undefined,
		});
		const pane: NativeChild[] = [this.#describePaneHead()];
		pane.push(lines);
		const composer = this.#describeComposer();
		if (composer) pane.push(composer);
		const main = node("col", { role: "omp.review.pane", grow: 1, min: { w: 0 } }, pane, "pane");
		const children: NativeChild[] = [];
		if (this.#sidebarShown) {
			children.push(keyed(rowNode([this.#describeRail(editing), main], { role: "omp.review.split" }), "split"));
		} else {
			children.push(main);
		}
		children.push(this.#describeFooter(editing));

		this.#nativeSig = sig;
		this.#nativeRootBody = body;
		this.#nativeRoot = col(children);
		return this.#nativeRoot;
	}

	handleNativeEvent(event: NativeUiEvent): void {
		if (this.#finished || this.#externalOperation) return;
		if (event.type === "action") {
			if (event.act === "close") {
				this.#escape();
				return;
			}
			// A draft or the note chooser is open: finish or leave it first.
			if (this.#annotating || this.#annotationChooser) return;
			const index =
				event.act === "review" && !this.#textSource ? 0 : event.act === "paste" ? (this.#textSource ? 0 : 1) : -1;
			if (index < 0 || this.#actionDisabled(index)) return;
			this.#actionIndex = index;
			this.#confirmAction();
			return;
		}
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
				this.#viewportDriven = false;
				// Double-clicking a line opens its note, like `a`.
				if (activate) this.#startAnnotation("line");
				return;
			}
		}
	}

	/**
	 * One item per diff/text row; notes are disabled `warning` items under
	 * the row they belong to (file and whole-text notes lead). Diff rows carry
	 * their kind as the tone (`success` added, `error` removed, `info` hunk).
	 */
	#describeBodyItems(): NativeBody {
		const cached = this.#nativeBody;
		if (cached && cached.fileIndex === this.#fileIndex && cached.rev === this.#annotationRev) return cached;
		const items: NativeNode[] = [];
		const note = (key: string, body: string, scope?: string) =>
			items.push(
				item(key, {
					label: [span(sanitizeStatusText(body))],
					value: scope ? [span(scope, "muted")] : undefined,
					icon: "pen",
					disabled: true,
					tone: "warning",
					role: "omp.review.note",
				}),
			);
		const notice = (key: string, label: string, icon: string) =>
			items.push(item(key, { label: [span(label, "muted")], icon, disabled: true, tone: "muted" }));
		if (this.#textSource) {
			for (const [index, entry] of this.#textAnnotations.entries()) {
				if (entry.annotation.scope === "text") note(`n${index}`, entry.annotation.note, "Whole text");
			}
			const mono = this.#textSource.kind !== "message" && this.#textSource.kind !== "prompt";
			const width = String(this.#textLines.length).length;
			for (const [sourceIndex, sourceLine] of this.#textLines.entries()) {
				items.push(
					item(`l${sourceIndex}`, {
						label: [span(replaceTabs(sanitizeText(sourceLine)), mono ? "mono" : undefined)],
						value: [span(String(sourceIndex + 1).padStart(width), "mono")],
					}),
				);
				for (const [index, entry] of this.#textAnnotations.entries()) {
					if (entry.annotation.scope === "line" && entry.sourceIndex === sourceIndex) {
						note(`n${index}`, entry.annotation.note);
					}
				}
			}
		} else {
			const file = this.#currentFile();
			if (file) {
				for (const [index, entry] of this.#annotations.entries()) {
					if (entry.fileIndex === this.#fileIndex && entry.annotation.scope === "file") {
						note(`n${index}`, entry.annotation.note, "File note");
					}
				}
				if (file.isBinary) {
					notice("binary", "Binary file: no lines to annotate, but a file note works", "binary");
				} else if (file.rows.length === 0) {
					notice("empty", "No hunks: this looks like a rename-only change", "forward");
				}
				let lineWidth = 1;
				for (const diffRow of file.isBinary ? [] : file.rows) {
					if (!isSourceRow(diffRow)) continue;
					lineWidth = Math.max(
						lineWidth,
						String(diffRow.oldLine ?? "").length,
						String(diffRow.newLine ?? "").length,
					);
				}
				// The old/new line gutter is the item's value (drawn first); rows without numbers keep its width.
				const blankGutter = [span(" ".repeat(lineWidth * 2 + 1), "mono")];
				let sourceIndex = 0;
				for (const [rowIndex, diffRow] of file.isBinary ? [] : file.rows.entries()) {
					if (!isSourceRow(diffRow)) {
						if (diffRow.kind === "hunk") {
							const match = /^(@@[^@]*@@)\s?(.*)$/.exec(sanitizeText(diffRow.raw));
							const label = match
								? [span(match[1]!, "mono"), span(match[2] ? `  ${replaceTabs(match[2])}` : "", "muted mono")]
								: [span(sanitizeText(diffRow.raw), "mono")];
							items.push(item(`r${rowIndex}`, { label, value: blankGutter, disabled: true, tone: "info" }));
						} else {
							items.push(
								item(`r${rowIndex}`, {
									label: [span("No newline at end of file", "muted")],
									value: blankGutter,
									disabled: true,
									tone: "muted",
								}),
							);
						}
						continue;
					}
					const added = diffRow.kind === "added";
					const removed = diffRow.kind === "removed";
					const oldCell = String((added ? undefined : diffRow.oldLine) ?? "").padStart(lineWidth);
					const newCell = String((removed ? undefined : diffRow.newLine) ?? "").padStart(lineWidth);
					const color: DiffColor = added ? "toolDiffAdded" : removed ? "toolDiffRemoved" : "toolDiffContext";
					items.push(
						item(`l${sourceIndex}`, {
							label: [
								span(added ? "+ " : removed ? "- " : "  ", `${color} mono`),
								span(replaceTabs(sanitizeText(diffRow.content)), "mono"),
							],
							value: [span(`${oldCell} ${newCell}`, "mono")],
							tone: added ? "success" : removed ? "error" : undefined,
						}),
					);
					// A line's notes sit under it, like review comments.
					for (const [index, entry] of this.#annotations.entries()) {
						if (
							entry.fileIndex === this.#fileIndex &&
							entry.sourceIndex === sourceIndex &&
							entry.annotation.scope === "line"
						) {
							note(`n${index}`, entry.annotation.note);
						}
					}
					sourceIndex++;
				}
			}
		}
		this.#nativeBody = { fileIndex: this.#fileIndex, rev: this.#annotationRev, items };
		return this.#nativeBody;
	}

	/** The file rail: the totals (file count, notes, `+a −r`) over the changed files. */
	#describeRail(editing: boolean): NativeNode {
		let added = 0;
		let removed = 0;
		for (const file of this.#files) {
			added += file.linesAdded;
			removed += file.linesRemoved;
		}
		const total: NativeChild[] = [text([span(plural(this.#files.length, "file"))], { grow: 1, wrap: "none" })];
		if (this.#annotations.length > 0) {
			total.push(text([span(plural(this.#annotations.length, "note"))], { role: "omp.review.count", wrap: "none" }));
		}
		total.push(
			text([span(`+${added}`, "toolDiffAdded mono"), span(" "), span(`−${removed}`, "toolDiffRemoved mono")], {
				wrap: "none",
			}),
		);
		const files = selectList(
			"files",
			this.#files.map((file, index) => {
				const { dir, leaf } = splitPath(displayFileLabel(file));
				const status = fileStatus(file);
				const count = this.#annotationCount(index);
				const value: TspSpan[] = [];
				if (count) value.push(span(`✎ ${count}`, "warning"), span(" "));
				if (file.isBinary) value.push(span("bin", "muted"));
				else
					value.push(
						span(`+${file.linesAdded}`, "toolDiffAdded mono"),
						span(" "),
						span(`−${file.linesRemoved}`, "toolDiffRemoved mono"),
					);
				return item(`f${index}`, {
					label: [span(sanitizeStatusText(leaf))],
					detail: dir ? [span(sanitizeStatusText(dir))] : undefined,
					value,
					icon: file.isBinary ? "binary" : FILE_STATUS_ICON[status],
					tone: FILE_STATUS_TONE[status],
				});
			}),
			{
				selected: this.#files.length > 0 ? `f${this.#fileIndex}` : null,
				max: { lines: this.#bodyHeight },
				empty: [span("No files", "muted")],
				role: "omp.review.files",
				tone: this.#focus === "files" && !editing ? "accent" : undefined,
			},
		);
		return node(
			"col",
			{ role: "omp.review.rail" },
			[node("row", { role: "omp.review.total", gap: "sm", align: "center" }, total, "total"), files],
			"rail",
		);
	}

	/**
	 * Over the lines: the current file's full path, how it changed, its note
	 * count and `+a −r` (text: its line and note counts).
	 */
	#describePaneHead(): NativeNode {
		const children: NativeChild[] = [];
		const props = { role: "omp.review.head", gap: "sm", align: "center" } as const;
		if (this.#textSource) {
			children.push(text([span(plural(this.#textLines.length, "line"))], { grow: 1, wrap: "none" }));
			const notes = this.#textAnnotations.length;
			if (notes) children.push(text([span(plural(notes, "note"))], { role: "omp.review.count", wrap: "none" }));
			return node("row", props, children, "head");
		}
		const file = this.#currentFile();
		if (!file) return node("row", props, [text([span("No reviewable files", "muted")])], "head");
		const status = fileStatus(file);
		children.push(
			text([span(sanitizeStatusText(displayFileLabel(file)), "path")], { truncate: "middle", min: { w: 0 } }),
		);
		const what =
			status === "renamed" && file.oldPath
				? `Renamed from ${sanitizeStatusText(file.oldPath)}`
				: status === "added"
					? "New file"
					: status === "deleted"
						? "Deleted"
						: file.isBinary
							? "Binary"
							: undefined;
		if (what) {
			children.push(
				text([span(what)], {
					role: "omp.review.status",
					tone: FILE_STATUS_TONE[status],
					truncate: "end",
					min: { w: 0 },
				}),
			);
		}
		children.push(node("spacer", { grow: 1 }));
		const count = this.#annotationCount(this.#fileIndex);
		if (count) children.push(text([span(plural(count, "note"))], { role: "omp.review.count", wrap: "none" }));
		if (!file.isBinary) {
			children.push(
				text(
					[
						span(`+${file.linesAdded}`, "toolDiffAdded mono"),
						span(" "),
						span(`−${file.linesRemoved}`, "toolDiffRemoved mono"),
					],
					{ wrap: "none" },
				),
			);
		}
		return node("row", props, children, "head");
	}

	/** Docked under the lines: the note being written (what it is on, then the field) or the note chooser. */
	#describeComposer(): NativeNode | undefined {
		const chooser = this.#annotationChooser;
		if (chooser) {
			const entries = chooser.entries.map((index, i) => {
				const entry = chooser.kind === "text" ? this.#textAnnotations[index] : this.#annotations[index];
				// Every candidate is on the current file (or text), so the place is just the line.
				const annotation = entry?.annotation;
				const location = !annotation
					? ""
					: annotation.scope === "file"
						? "File note"
						: annotation.scope === "text"
							? "Whole text"
							: "line" in annotation
								? `Line ${annotation.line}`
								: annotation.newLine !== undefined
									? `Line ${annotation.newLine}`
									: `Removed line ${annotation.oldLine ?? ""}`.trim();
				return item(`c${i}`, {
					label: sanitizeStatusText(annotation?.note.split(/\r?\n/, 1)[0] ?? ""),
					value: location,
					icon: "pen",
				});
			});
			return node(
				"col",
				{ role: "omp.review.composer" },
				[
					keyed(text([span("Edit which note?", "strong")]), "caption"),
					selectList("chooser", entries, { selected: `c${chooser.selected}`, tone: "accent" }),
				],
				"chooser",
			);
		}
		if (!this.#annotating) return undefined;
		return node(
			"col",
			{ role: "omp.review.composer" },
			[keyed(text(this.#noteCaption(), { truncate: "end" }), "caption"), this.#editor],
			"composer",
		);
	}

	/** Where the open note lands: `Note on line 42 in src/app.ts`, `Edit note on src/app.ts`, `Note on the whole text`. */
	#noteCaption(): TspSpan[] {
		const verb = span(this.#editingAnnotationIndex === undefined ? "Note on " : "Edit note on ", "muted");
		if (this.#textSource) {
			return this.#annotationScope === "text"
				? [verb, span("the whole text", "strong")]
				: [verb, span(`line ${this.#sourceIndex + 1}`, "strong")];
		}
		const file = this.#currentFile();
		const path = file ? sanitizeStatusText(displayFileLabel(file)) : "file";
		if (this.#annotationScope === "file") return [verb, span(path, "path")];
		const source = this.#currentSourceRows()[this.#sourceIndex];
		const where =
			source?.kind === "removed"
				? `removed line ${source.oldLine ?? ""}`
				: `line ${source?.newLine ?? source?.oldLine ?? ""}`;
		return [verb, span(where.trim(), "strong"), span(" in ", "muted"), span(path, "path")];
	}

	/**
	 * The footer: key hints for what has focus, then Cancel and the actions
	 * (the primary last). Each button's key lives in its tooltip; the action
	 * picked from the keyboard is marked `pick`, an unavailable one `drop`.
	 */
	#describeFooter(editing: boolean): NativeNode {
		const pick = (index: number): "pick" | "drop" | undefined =>
			editing || this.#actionDisabled(index)
				? "drop"
				: this.#focus === "actions" && this.#actionIndex === index
					? "pick"
					: undefined;
		const marked = (button: NativeNode, mark: "pick" | "drop" | undefined): NativeNode =>
			mark ? ({ ...button, p: { ...button.p, mark } } as NativeNode) : button;
		const hasNotes = this.#textSource ? this.#textAnnotations.length > 0 : this.#annotations.length > 0;
		const pasteTitle = hasNotes ? PASTE_CODE_REVIEW_ACTION : "Add a note to paste it into the prompt";
		const buttons: NativeNode[] = [actionButton("Cancel", "close", { keys: "escape" })];
		if (this.#textSource) {
			buttons.push(
				marked(actionButton("Paste into prompt", "paste", { tone: "accent", title: pasteTitle }), pick(0)),
			);
		} else {
			buttons.push(
				marked(actionButton("Paste into prompt", "paste", { title: pasteTitle }), pick(1)),
				marked(
					actionButton("Review with LLM", "review", { tone: "accent", title: CONTINUE_CODE_REVIEW_ACTION }),
					pick(0),
				),
			);
		}
		return node(
			"row",
			{ role: "omp.actions", gap: "sm", align: "center" },
			[hintsRow(this.#footerHints()), ...buttons],
			"actions",
		);
	}

	/** At most a handful of hints, for the region (or draft) that has the keys. */
	#footerHints(): (NativeHint | undefined)[] {
		const key = (keys: KeyName | readonly KeyName[], label: string): NativeHint => ({
			keys: typeof keys === "string" ? [keys] : keys,
			label,
		});
		const upDown = (label: string) => this.#hint(["tui.select.up", "tui.select.down"], label);
		if (this.#annotationChooser) {
			return [upDown("choose"), this.#hint("tui.select.confirm", "edit"), this.#hint("tui.select.cancel", "back")];
		}
		if (this.#annotating) {
			return [
				this.#hint("tui.input.submit", "save"),
				this.#hint("tui.input.newLine", "new line"),
				this.#hint("tui.select.cancel", "discard"),
				this.#callbacks.onAnnotationExternalEditor ? key(appExternalEditorKey(), "editor") : undefined,
			];
		}
		const undo = this.#undoStack.length > 0 ? key("u", "undo") : undefined;
		if (this.#focus === "files") {
			return [
				upDown("file"),
				this.#hint("tui.select.confirm", "open"),
				key("a", "file note"),
				undo,
				key("tab", "pane"),
			];
		}
		if (this.#focus === "diff") {
			return [
				upDown("line"),
				key("a", "note"),
				key("shift+a", this.#textSource ? "note on all" : "file note"),
				this.#annotationCandidates().length > 0 ? key("e", "edit note") : undefined,
				undo,
				key("tab", this.#textSource ? "actions" : "pane"),
			];
		}
		return [upDown("choose"), this.#hint("tui.select.confirm", "run"), key("tab", "pane")];
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
		const terminalHeight = this.#tui.terminal.rows;
		this.#sidebarShown = this.#textSource ? false : this.#canShowSidebar(width);
		if (!this.#sidebarShown && this.#focus === "files") this.#focus = "diff";
		const sidebarWidth = this.#sidebarShown ? this.#sidebarWidth(width) : 0;
		const innerWidth = Math.max(1, width - 4);
		const bodyWidth = this.#sidebarShown ? splitBodyWidth(width, sidebarWidth) : innerWidth;
		this.#editor.setMaxHeight(Math.max(1, Math.min(MAX_ANNOTATION_EDITOR_ROWS, terminalHeight - 12)));
		this.#editor.focused = this.focused && this.#annotating;
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
		const bodyContentWidth = Math.max(1, bodyWidth - 1);
		let renderedBody = this.#renderBody(bodyContentWidth);
		this.#scrollView.setLines(renderedBody.lines);
		this.#scrollView.setHeight(this.#bodyHeight);
		if (this.#ensureCursorVisible(renderedBody.renderedRowBySource)) {
			renderedBody = this.#renderBody(bodyContentWidth);
			this.#scrollView.setLines(renderedBody.lines);
			this.#renderedRowBySource = renderedBody.renderedRowBySource;
		}
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
		this.#revealSelectedFile(output, width);
		return output;
	}
}
