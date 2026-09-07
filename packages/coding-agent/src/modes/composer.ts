import {
	type Component,
	Container,
	type EditorTopBorder,
	isInsideTerminalMultiplexer,
	ProcessTerminal,
	type ResizeScrollbackMode,
	routeSgrMouseInput,
	type SgrMouseEvent,
	sliceWithWidth,
	Spacer,
	type OverlayHandle,
	type Terminal,
	type TerminalFramePlan,
	type TerminalFrameProvider,
	Text,
	truncateToWidth,
	TUI,
	type TUIOptions,
	type ViewportSize,
	visibleWidth,
} from "@oh-my-pi/pi-tui";
import { CustomEditor } from "./components/custom-editor";
import {
	highlightViewportSelection,
	sliceViewportSelection as sliceViewportText,
	type ViewportSelectionPoint,
} from "./components/viewport-selection";
import { type AnimationFrame, TranscriptContainer } from "./components/transcript-container";
import { type LspServerInfo, type RecentSession, WelcomeComponent } from "./components/welcome";
import { getEditorTheme, initThemeSync, theme } from "./theme/theme";
import { copyToClipboard } from "../utils/clipboard";

const DOUBLE_INTERRUPT_MS = 500;
const EMPTY_VIEWPORT_ROWS: readonly string[] = [];

function reflowRowsAtWidth(lines: readonly string[], width: number): string[] {
	const columns = Math.max(1, width);
	const reflowed: string[] = [];
	for (const line of lines) {
		const lineWidth = visibleWidth(line);
		if (lineWidth === 0) {
			reflowed.push("");
			continue;
		}
		for (let column = 0; column < lineWidth;) {
			let slice = sliceWithWidth(line, column, columns, true);
			if (slice.width === 0) slice = sliceWithWidth(line, column, columns);
			reflowed.push(slice.text);
			column += Math.max(1, slice.width);
		}
	}
	return reflowed;
}

function sameRows(previous: readonly string[], next: readonly string[]): boolean {
	if (previous.length !== next.length) return false;
	for (let index = 0; index < previous.length; index++) {
		if (previous[index] !== next[index]) return false;
	}
	return true;
}

interface ViewportSelectionSnapshot {
	readonly lines: readonly string[];
	readonly columns: number;
	readonly revision: number;
}

/** Live settings that affect the composer before and after session adoption. */
export interface ComposerPreferences {
	readonly quiet: boolean;
	readonly composerShape: string;
	readonly showHardwareCursor: boolean;
	readonly maxInlineImages: number;
	readonly resizeScrollback: ResizeScrollbackMode;
	readonly imeSafeCursor: boolean;
	readonly autocompleteMaxVisible: number;
	readonly spellingTypoDetection: boolean;
	readonly spellingAutocomplete: boolean;
	readonly spellingAutocorrect: boolean;
}

/** Settings-schema-compatible defaults used when constructing a dependency-free composer. */
export const COMPOSER_DEFAULTS: ComposerPreferences = {
	quiet: false,
	composerShape: "band",
	showHardwareCursor: true,
	maxInlineImages: 8,
	resizeScrollback: "rebuild",
	imeSafeCursor: false,
	autocompleteMaxVisible: 10,
	spellingTypoDetection: true,
	spellingAutocomplete: true,
	spellingAutocorrect: false,
};

/** Welcome data that can be supplied initially or patched as startup resolves it. */
export interface ComposerWelcomeUpdate {
	readonly version?: string;
	readonly modelName?: string;
	readonly providerName?: string;
	readonly recentSessions?: readonly RecentSession[];
	readonly lspServers?: readonly LspServerInfo[];
}

/**
 * Placeholder-only status chrome replayed on the next first frame so the
 * status band/border exists before the session-aware status line attaches.
 * Bound to the composer shape it was rendered for; a different shape drops it.
 */
export interface ComposerStatusSnapshot {
	readonly shape: string;
	/** ANSI wrapper of the editor border at snapshot time (session accent or thinking color). */
	readonly borderColor?: {
		readonly prefix: string;
		readonly suffix: string;
	};
	/** Status content embedded in the editor's top chrome (`top-border`, `top-band`, `top-rule-chip`). */
	readonly topBorder?: {
		readonly content: string;
		readonly width: number;
	};
	/** Standalone bottom-bar rows (`pi`/`claude` shapes), gap row included. */
	readonly bottomLines: readonly string[];
}

/** Optional dependencies and initial state for a standalone composer. */
export interface ComposerOptions {
	readonly terminal?: Terminal;
	/** Extra TUI construction options (render scheduler injection for tests and `omp render`). */
	readonly tuiOptions?: TUIOptions;
	readonly preferences?: Partial<ComposerPreferences>;
	readonly welcome?: ComposerWelcomeUpdate;
	readonly status?: ComposerStatusSnapshot;
	readonly exit?: (code: number) => void;
	readonly now?: () => number;
}

/** Controls the first terminal paint for a composer that does not already own the terminal. */
export interface ComposerStartOptions {
	readonly clearScrollback?: boolean;
	readonly playWelcomeIntro?: boolean;
	/**
	 * Paint without owning stdin: the tty keeps cooked-mode echo/editing so
	 * typing stays visible while startup module loading blocks the event loop.
	 * {@link Composer.enableInput} later switches to raw input and replays the
	 * kernel-buffered keystrokes into the editor.
	 */
	readonly deferInput?: boolean;
}

/**
 * Mount slot for the session-aware status component below the editor. Shows
 * placeholder rows during startup until the real component mounts.
 */
class StatusHost implements Component {
	#lines: readonly string[] = [];
	#component: Component | undefined;

	get mounted(): boolean {
		return this.#component !== undefined;
	}

	setLines(lines: readonly string[]): void {
		this.#lines = lines;
	}

	setComponent(component: Component): void {
		this.#component = component;
		this.#lines = [];
	}

	render(width: number): readonly string[] {
		if (this.#component) return this.#component.render(width);
		return this.#lines.map(line => truncateToWidth(line, width));
	}
}
/**
 * Canonical interactive composer, usable before session/settings exist and updatable in place.
 * It owns the terminal, welcome header, and editor; InteractiveMode later supplies authoritative
 * data and mounts the session-aware runtime children without replacing the visible header.
 */
export class Composer implements TerminalFrameProvider {
	/** Terminal renderer shared with InteractiveMode after adoption. */
	readonly ui: TUI;
	#editor: CustomEditor;
	readonly #header = new Container();
	readonly #bootstrapInputGap = new Spacer(1);
	readonly #statusHost = new StatusHost();
	readonly #exit: (code: number) => void;
	readonly #now: () => number;
	#preferences: ComposerPreferences;
	#welcome: WelcomeComponent | undefined;
	#version = "";
	#modelName = "";
	#providerName = "";
	#recentSessions: RecentSession[] = [];
	#lspServers: LspServerInfo[] = [];
	#headerBefore: readonly Component[] = [];
	#headerAfter: readonly Component[] = [];
	#runtimeChildren: readonly Component[] = [];
	#statusSnapshot: ComposerStatusSnapshot | undefined;
	#runtimeMounted = false;
	// Composer-owned history id space. Transcript batch ids restart across
	// container clears/swaps; the composer translates them into one monotonic
	// sequence the terminal's accepted-id watermark can trust.
	#nextHistoryId = 1;
	#offeredHistory:
		| {
				id: number;
				rows: readonly string[];
				kind: "append" | "replay";
				source:
					| "header"
					| {
							transcript: TranscriptContainer;
							transcriptId?: number;
							header: "none" | "replay";
							/** Recomposed header rows to accept as the new retired-header bytes. */
							headerRows?: readonly string[];
					  };
		  }
		| undefined;
	#historyReplayRequested = false;
	#headerReplayPending = false;
	#historyFlush = false;
	// The welcome header retires to terminal history exactly once, after the
	// intro settles; until then it renders as mutable viewport chrome.
	#headerRetired = false;
	// Exact hard rows accepted into native history. Transient resize-alt
	// paints reflow these rows to match the terminal's own rewrap of history
	// it still holds; a settled replay owns every byte it emits, so it
	// recomposes the header at the replay width and refreshes these rows.
	#retiredHeaderRows: readonly string[] | undefined;
	// Hard-row prefix currently above the native viewport. The first resize
	// frame may pull part of it down before the normal buffer is borrowed.
	#retiredHeaderStart = 0;
	#resizeRetiredHeaderStart: number | undefined;
	#lastNormalRows = 0;
	#lastInterruptAt = 0;
	#started = false;
	#stopped = false;
	#transferred = false;

	#visibleViewportColumns = 0;
	#visibleViewportRows = 0;
	#visibleSelectionRevision = 0;
	#visibleTranscriptStart = -1;
	#visibleTranscriptRows: readonly string[] = [];
	#visibleHistoryRows: readonly string[] = [];
	#visibleHistoryHardRows: readonly string[] = [];
	#visibleHistoryScreenOffset = 0;
	#visibleHistoryWidth = 0;
	#visibleHistoryBatchId: number | undefined;
	#visibleHistoryBatchHardRows: readonly string[] = [];
	#mouseSelectionUnsubscribe: (() => void) | undefined;
	#selectionAnchor: ViewportSelectionPoint | undefined;
	#selectionFocus: ViewportSelectionPoint | undefined;
	#selectionSnapshot: ViewportSelectionSnapshot | undefined;
	#copiedOverlayHandle: OverlayHandle | undefined;
	#copiedOverlayTimer: NodeJS.Timeout | undefined;
	constructor(options: ComposerOptions = {}) {
		if (typeof theme === "undefined") initThemeSync();
		this.#exit = options.exit ?? (code => process.exit(code));
		this.#now = options.now ?? Date.now;
		this.#preferences = { ...COMPOSER_DEFAULTS, ...options.preferences };
		this.#statusSnapshot = options.status;
		this.#applyWelcomeUpdate(options.welcome ?? {});

		this.ui = new TUI(
			options.terminal ?? new ProcessTerminal(),
			this.#preferences.showHardwareCursor,
			options.tuiOptions,
		);
		this.ui.setFrameProvider(this);
		this.ui.setMaxInlineImages(this.#preferences.maxInlineImages);
		this.ui.setResizeScrollback(this.#preferences.resizeScrollback);

		this.#editor = new CustomEditor(getEditorTheme());
		this.editor.disableSubmit = true;
		this.editor.setUseTerminalCursor(this.ui.getShowHardwareCursor());
		this.editor.setImeSafeCursorLayout(this.#preferences.imeSafeCursor);
		this.editor.setAutocompleteMaxVisible(this.#preferences.autocompleteMaxVisible);
		this.editor.setSpellingFeatures({
			typoDetection: this.#preferences.spellingTypoDetection,
			autocomplete: this.#preferences.spellingAutocomplete,
			autocorrect: this.#preferences.spellingAutocorrect,
		});
		try {
			this.editor.setBorderStyle(this.#preferences.composerShape);
		} catch {
			// Extension-defined styles arrive with the session; InteractiveMode reapplies them.
		}
		this.#applyStatusSnapshot();
		// Emergency controls stay active until InteractiveMode installs configured bindings.
		this.editor.setActionKeys("app.clear", ["ctrl+c"]);
		this.editor.setActionKeys("app.exit", ["ctrl+d"]);
		this.editor.onClear = () => this.#handleInterrupt();
		this.editor.onExit = () => this.#requestExit(0);
		this.editor.setShimmerRepaintHandler(() => this.ui.requestComponentRender(this.editor));

		if (!this.#preferences.quiet) this.#ensureWelcome();
		this.#rebuildHeader();
		this.ui.addChild(this.#header);
		this.ui.addChild(this.#bootstrapInputGap);
		this.ui.addChild(this.editor);
		this.ui.addChild(this.#statusHost);
		this.ui.setFocus(this.editor);
	}
	/**
	 * Enable transcript selection for the coding-agent interactive CLI. This is
	 * intentionally separate from Composer construction so standalone Composer
	 * users and other TUI hosts retain native terminal selection by default.
	 */
	enableTranscriptMouseSelection(): void {
		if (this.#mouseSelectionUnsubscribe !== undefined) return;
		this.ui.setMouseTracking(true);
		this.#mouseSelectionUnsubscribe = this.ui.addInputListener(data => {
			if (this.#hasBlockingOverlay() || !data.startsWith("\x1b[<")) return undefined;
			const parsed = routeSgrMouseInput(data, event => {
				this.#handleMouse(event);
				return true;
			});
			return parsed ? { consume: true } : undefined;
		});
	}

	#hasBlockingOverlay(): boolean {
		return this.ui.overlayStack.some(entry => {
			if (entry.hidden || entry.options?.focus === false) return false;
			const visible = entry.options?.visible;
			return visible === undefined || visible(this.ui.terminal.columns, this.ui.terminal.rows);
		});
	}

	#selectionLines(): readonly string[] {
		return this.#visibleHistoryRows.length === 0
			? this.#visibleTranscriptRows
			: [...this.#visibleHistoryRows, ...this.#visibleTranscriptRows];
	}

	#cancelStaleSelection(): void {
		if (this.#selectionSnapshot?.revision === this.#visibleSelectionRevision) return;
		this.#selectionAnchor = undefined;
		this.#selectionFocus = undefined;
		this.#selectionSnapshot = undefined;
	}

	#transcriptPoint(row: number, col: number): ViewportSelectionPoint | undefined {
		const screenRow = Math.trunc(row);
		const column = Math.trunc(col);
		if (this.#visibleViewportColumns <= 0 || column < 0 || column >= this.#visibleViewportColumns) return undefined;

		const providerTop = this.ui.getProviderViewportTop();
		const historyStart = providerTop + this.#visibleHistoryScreenOffset;
		const historyEnd = historyStart + this.#visibleHistoryRows.length;
		if (screenRow >= historyStart && screenRow < historyEnd) {
			return { row: screenRow - historyStart, col: column };
		}

		const providerRow = screenRow - providerTop;
		const transcriptStart = this.#visibleTranscriptStart;
		const transcriptEnd = transcriptStart + this.#visibleTranscriptRows.length;
		if (transcriptStart < 0 || providerRow < transcriptStart || providerRow >= transcriptEnd) return undefined;
		return {
			row: this.#visibleHistoryRows.length + providerRow - transcriptStart,
			col: column,
		};
	}
	#handleMouse(event: SgrMouseEvent): boolean {
		if (!this.#started || this.#stopped) return false;
		if (event.wheel !== null) {
			return this.#transcriptPoint(event.row, event.col) !== undefined;
		}

		const point = this.#transcriptPoint(event.row, event.col);
		if (event.release) {
			const anchor = this.#selectionAnchor;
			const focus = point ?? this.#selectionFocus;
			const snapshot = this.#selectionSnapshot;
			this.#selectionAnchor = undefined;
			this.#selectionFocus = undefined;
			this.#selectionSnapshot = undefined;
			if (anchor === undefined || focus === undefined || snapshot === undefined) {
				this.ui.requestRender();
				return anchor !== undefined;
			}
			if (snapshot.revision !== this.#visibleSelectionRevision) {
				this.ui.requestRender();
				return true;
			}
			if (anchor.row === focus.row && anchor.col === focus.col) {
				this.ui.requestRender();
				return true;
			}
			void this.#copySelection(anchor, focus, snapshot);
			this.ui.requestRender();
			return true;
		}
		if (event.motion) {
			if (this.#selectionAnchor === undefined) return false;
			if (this.#selectionSnapshot?.revision !== this.#visibleSelectionRevision) {
				this.#cancelStaleSelection();
				this.ui.requestRender();
				return true;
			}
			if (point !== undefined) {
				this.#selectionFocus = point;
				this.ui.requestRender();
			}
			return true;
		}
		if (!event.leftClick) return false;
		if (point === undefined) {
			this.#selectionAnchor = undefined;
			this.#selectionFocus = undefined;
			this.#selectionSnapshot = undefined;
			return false;
		}
		this.#selectionAnchor = point;
		this.#selectionFocus = point;
		this.#selectionSnapshot = {
			lines: [...this.#selectionLines()],
			columns: this.#visibleViewportColumns,
			revision: this.#visibleSelectionRevision,
		};
		this.ui.requestRender();
		return true;
	}

	async #copySelection(
		anchor: ViewportSelectionPoint,
		focus: ViewportSelectionPoint,
		snapshot: ViewportSelectionSnapshot,
	): Promise<void> {
		const text = sliceViewportText(snapshot.lines, snapshot.columns, anchor, focus);
		try {
			await copyToClipboard(text);
			if (!this.#stopped && !this.#hasBlockingOverlay()) this.#showCopiedOverlay();
		} catch {
			// Clipboard implementations are best-effort; they normally swallow
			// failures themselves, and a failed copy must not disrupt the CLI.
		}
	}

	#showCopiedOverlay(): void {
		this.#hideCopiedOverlay();
		const text = theme.bold(theme.fg("accent", "Copied"));
		const handle = this.ui.showOverlay(new Text(text, 0, 0), {
			anchor: "bottom-right",
			width: visibleWidth(text),
			margin: { right: 1, bottom: 1 },
			focus: false,
		});
		this.#copiedOverlayHandle = handle;
		const timer = setTimeout(() => {
			if (this.#copiedOverlayHandle !== handle) return;
			this.#copiedOverlayHandle = undefined;
			this.#copiedOverlayTimer = undefined;
			handle.hide();
		}, 1200);
		timer.unref?.();
		this.#copiedOverlayTimer = timer;
	}

	#hideCopiedOverlay(): void {
		if (this.#copiedOverlayTimer !== undefined) {
			clearTimeout(this.#copiedOverlayTimer);
			this.#copiedOverlayTimer = undefined;
		}
		const handle = this.#copiedOverlayHandle;
		this.#copiedOverlayHandle = undefined;
		handle?.hide();
	}
	#recordVisibleViewport(
		columns: number,
		rows: number,
		transcriptStart: number,
		transcriptRows: readonly string[],
	): void {
		const nextRows = transcriptStart < 0 ? EMPTY_VIEWPORT_ROWS : transcriptRows;
		const changed =
			columns !== this.#visibleViewportColumns ||
			rows !== this.#visibleViewportRows ||
			transcriptStart !== this.#visibleTranscriptStart ||
			!sameRows(this.#visibleTranscriptRows, nextRows);
		if (changed) this.#visibleSelectionRevision++;
		this.#visibleViewportColumns = columns;
		this.#visibleViewportRows = rows;
		this.#visibleTranscriptStart = transcriptStart;
		this.#visibleTranscriptRows = nextRows;
	}

	#clearVisibleHistory(): void {
		if (
			this.#visibleHistoryRows.length > 0 ||
			this.#visibleHistoryHardRows.length > 0 ||
			this.#visibleHistoryBatchId !== undefined
		) {
			this.#visibleSelectionRevision++;
		}
		this.#visibleHistoryRows = EMPTY_VIEWPORT_ROWS;
		this.#visibleHistoryHardRows = EMPTY_VIEWPORT_ROWS;
		this.#visibleHistoryScreenOffset = 0;
		this.#visibleHistoryWidth = 0;
		this.#visibleHistoryBatchId = undefined;
		this.#visibleHistoryBatchHardRows = EMPTY_VIEWPORT_ROWS;
	}

	#refreshVisibleHistory(width: number): void {
		if (this.#visibleHistoryRows.length === 0) return;
		if (this.#visibleHistoryWidth !== width) {
			this.#visibleHistoryRows = reflowRowsAtWidth(this.#visibleHistoryHardRows, width);
			this.#visibleHistoryScreenOffset = -this.#visibleHistoryRows.length;
			this.#visibleSelectionRevision++;
		}
		this.#visibleHistoryWidth = width;
	}

	#clearViewportSelection(): void {
		this.#selectionAnchor = undefined;
		this.#selectionFocus = undefined;
		this.#selectionSnapshot = undefined;
		this.#clearVisibleHistory();
	}

	#recordVisibleHistory(history: TerminalFramePlan["history"], width: number): void {
		if (history === undefined) return;
		const offered = this.#offeredHistory;
		if (offered === undefined || offered.id !== history.id || offered.source === "header") {
			this.#clearVisibleHistory();
			return;
		}
		const transcriptStart = offered.source.header === "replay" ? (offered.source.headerRows?.length ?? 0) : 0;
		const transcriptRows = history.rows.slice(transcriptStart);
		const sameCurrentBatch =
			history.id === this.#visibleHistoryBatchId && sameRows(this.#visibleHistoryBatchHardRows, transcriptRows);
		if (!sameCurrentBatch) {
			if (history.kind === "replay" || this.#visibleHistoryBatchId === undefined) {
				this.#visibleHistoryHardRows = transcriptRows;
			} else if (history.id !== this.#visibleHistoryBatchId) {
				this.#visibleHistoryHardRows = [...this.#visibleHistoryHardRows, ...transcriptRows];
			} else {
				const priorRows = this.#visibleHistoryHardRows.slice(
					0,
					Math.max(0, this.#visibleHistoryHardRows.length - this.#visibleHistoryBatchHardRows.length),
				);
				this.#visibleHistoryHardRows = [...priorRows, ...transcriptRows];
			}
			this.#visibleHistoryRows = reflowRowsAtWidth(this.#visibleHistoryHardRows, width);
			this.#visibleHistoryScreenOffset = -this.#visibleHistoryRows.length;
			this.#visibleHistoryBatchHardRows = transcriptRows;
			this.#visibleSelectionRevision++;
		}
		this.#visibleHistoryWidth = width;
		this.#visibleHistoryBatchId = history.id;
	}

	/** Compose the bounded mutable viewport and the next ordered history append. */
	renderFrame(viewport: ViewportSize): TerminalFramePlan {
		const width = Math.max(1, viewport.columns);
		const rows = Math.max(0, viewport.rows);
		this.#refreshVisibleHistory(width);
		if (!this.#started || this.#stopped) {
			this.#clearVisibleHistory();
			this.#recordVisibleViewport(width, rows, -1, []);
			return { viewport: [] };
		}
		if (this.#resizeRetiredHeaderStart !== undefined) {
			this.#retiredHeaderStart = this.#resizeRetiredHeaderStart;
			this.#resizeRetiredHeaderStart = undefined;
		}
		this.#lastNormalRows = rows;
		const roots = this.#runtimeMounted
			? [...this.#runtimeChildren, this.#statusHost]
			: [this.#header, this.#bootstrapInputGap, this.editor, this.#statusHost];
		const transcriptIndex = roots.findIndex(root => root instanceof TranscriptContainer);
		if (transcriptIndex < 0) {
			this.#clearVisibleHistory();
			const composed = this.#renderRoots(roots, width);
			const visible = rows > 0 && composed.length > rows ? composed.slice(-rows) : rows > 0 ? composed : [];
			this.#recordVisibleViewport(width, rows, -1, []);
			return { viewport: visible };
		}
		const transcript = roots[transcriptIndex] as TranscriptContainer;
		const preRoots = this.#renderRoots(roots.slice(0, transcriptIndex), width);
		const after = this.#renderRoots(roots.slice(transcriptIndex + 1), width);
		// Offer history under capacity pressure only: blocks stay live (and keep
		// reflowing to the current width) while the screen has room. A batch
		// leaves the mutable viewport in the same frame it is appended, so its
		// rows are never painted twice.
		const history = this.#offerHistory(transcript, width, rows, preRoots.length + after.length);
		this.#recordVisibleHistory(history, width);
		const headerVisible = !this.#headerRetired && this.#offeredHistory?.source !== "header";
		const headerRows = headerVisible ? this.#header.render(width) : [];
		const before = [...headerRows, ...preRoots];
		const now = performance.now();
		const frame: AnimationFrame = { now, tick: Math.floor(now / 80) };
		const active = transcript.renderViewport(width, Math.max(0, rows - before.length - after.length), frame);
		const composed = [...before, ...active, ...after];
		if (history !== undefined && this.#offeredHistory?.source === "header") {
			const visibleHeaderRows = Math.max(0, rows - composed.length);
			this.#retiredHeaderStart = Math.max(0, history.rows.length - visibleHeaderRows);
		}
		const visible = rows > 0 && composed.length > rows ? composed.slice(-rows) : rows > 0 ? composed : [];
		const composedStart = composed.length - visible.length;
		const transcriptStartInComposed = Math.max(composedStart, before.length);
		const transcriptEndInComposed = Math.min(composed.length, before.length + active.length);
		let transcriptStart = -1;
		let transcriptRows: readonly string[] = [];
		if (transcriptStartInComposed < transcriptEndInComposed) {
			transcriptStart = transcriptStartInComposed - composedStart;
			transcriptRows = visible.slice(transcriptStart, transcriptEndInComposed - composedStart);
		}
		this.#recordVisibleViewport(width, rows, transcriptStart, transcriptRows);
		this.#cancelStaleSelection();
		let paintedVisible = visible;
		const historyRows = this.#visibleHistoryRows;
		const anchor = this.#selectionAnchor;
		const focus = this.#selectionFocus;
		if (anchor !== undefined && focus !== undefined && transcriptStart >= 0) {
			const historyLength = historyRows.length;
			const activeEndRow = Math.max(anchor.row, focus.row);
			if (activeEndRow >= historyLength) {
				const toActivePoint = (point: ViewportSelectionPoint): ViewportSelectionPoint => ({
					row: Math.max(0, point.row - historyLength),
					col: point.row < historyLength ? 0 : point.col,
				});
				const highlightedRows = highlightViewportSelection(
					transcriptRows,
					width,
					toActivePoint(anchor),
					toActivePoint(focus),
				);
				paintedVisible = [...visible];
				for (let index = 0; index < highlightedRows.length; index++) {
					const highlighted = highlightedRows[index];
					if (highlighted !== undefined) paintedVisible[transcriptStart + index] = highlighted;
				}
			}
		}
		return { history, viewport: paintedVisible };
	}

	/** Acknowledges one accepted header, replay, or transcript batch. */
	acknowledgeHistory(id: number): void {
		const offered = this.#offeredHistory;
		if (offered === undefined || offered.id !== id) return;
		if (offered.source === "header") {
			this.#headerRetired = true;
			this.#retiredHeaderRows = offered.rows;
		} else {
			if (offered.source.transcriptId !== undefined) {
				offered.source.transcript.acknowledgeFinalizedBatch(offered.source.transcriptId);
			}
			if (offered.source.header === "replay") {
				this.#headerReplayPending = false;
				if (offered.source.headerRows !== undefined) this.#retiredHeaderRows = offered.source.headerRows;
			}
		}
		this.#offeredHistory = undefined;
		if (this.#historyReplayRequested) this.#startHistoryReplay();
	}

	/** Render the semantic transcript tail while the terminal borrows its resize buffer. */
	renderResizeFrame(viewport: ViewportSize): readonly string[] {
		if (!this.#started || this.#stopped) return [];
		const width = Math.max(1, viewport.columns);
		const rows = Math.max(0, viewport.rows);
		const tail = this.#runtimeMounted
			? this.#renderResizeTail(width, rows)
			: this.#renderRoots([this.#bootstrapInputGap, this.editor, this.#statusHost], width);
		let header: readonly string[];
		if (this.#headerRetired) {
			this.#resizeRetiredHeaderStart ??= Math.max(
				0,
				this.#retiredHeaderStart - Math.max(0, rows - this.#lastNormalRows),
			);
			header = this.#reflowRetiredHeader(width, this.#resizeRetiredHeaderStart);
		} else {
			header = this.#header.render(width);
		}
		const rendered = [...header, ...tail];
		return rendered.length <= rows ? rendered : rendered.slice(rendered.length - rows);
	}

	/** Replays committed presentation without changing logical retirement state. */
	beginHistoryReplay(): void {
		if (this.#offeredHistory !== undefined) {
			this.#historyReplayRequested = true;
			return;
		}
		this.#startHistoryReplay();
	}

	/** Forces every currently eligible finalized prefix to retire before stop. */
	beginHistoryFlush(): void {
		this.#historyFlush = true;
		// A pending replay would re-render and re-stream the entire committed
		// ledger during shutdown; the terminal already holds that history, so
		// flush emits only genuinely un-retired rows. An already offered batch
		// stays valid and is accepted by the flush loop.
		this.#historyReplayRequested = false;
		this.#headerReplayPending = false;
		for (const child of this.#runtimeChildren) {
			if (child instanceof TranscriptContainer) child.cancelReplay();
		}
	}

	#startHistoryReplay(): void {
		this.#headerReplayPending = this.#headerRetired && (this.#retiredHeaderRows?.length ?? 0) > 0;
		this.#historyReplayRequested = false;
		for (const child of this.#runtimeChildren) {
			if (child instanceof TranscriptContainer) child.beginReplay();
		}
	}

	/** Header retires first; replay coalesces it with the complete transcript ledger. */
	#offerHistory(
		transcript: TranscriptContainer,
		width: number,
		rows: number,
		chromeRows: number,
	): { id: number; rows: readonly string[]; kind: "append" | "replay" } | undefined {
		if (this.#offeredHistory !== undefined) {
			this.#rerenderOfferedHistory(width);
			return {
				id: this.#offeredHistory.id,
				rows: this.#offeredHistory.rows,
				kind: this.#offeredHistory.kind,
			};
		}
		if (this.#headerReplayPending) {
			const transcriptReplay = transcript.peekReplayBatch(width);
			// A replay follows a scrollback clear, so the header recomposes at
			// the new width exactly like transcript entries do. An empty
			// recompose (welcome unmounted after retirement) falls back to the
			// committed rows, hard-wrapped the way the terminal would.
			const recomposed = this.#header.render(width);
			const headerRows = recomposed.length > 0 ? [...recomposed, ""] : this.#reflowRetiredHeader(width, 0);
			this.#offeredHistory = {
				id: this.#nextHistoryId++,
				rows: [...headerRows, ...(transcriptReplay?.rows ?? [])],
				kind: "replay",
				source: {
					transcript,
					transcriptId: transcriptReplay?.id,
					header: "replay",
					headerRows,
				},
			};
			return {
				id: this.#offeredHistory.id,
				rows: this.#offeredHistory.rows,
				kind: this.#offeredHistory.kind,
			};
		}
		if (!this.#headerRetired) {
			const welcome = this.#welcome;
			if (welcome !== undefined && !welcome.isTranscriptBlockFinalized()) return undefined;
			// The header stays live viewport chrome until the screen fills; then it
			// retires first so transcript prefixes can follow in order.
			const renderedHeader = this.#header.render(width);
			if (renderedHeader.length > 0) {
				const liveRows = transcript.liveRowCount(width);
				if (!this.#historyFlush && renderedHeader.length + chromeRows + liveRows <= rows) return undefined;
				this.#offeredHistory = {
					id: this.#nextHistoryId++,
					rows: [...renderedHeader, ""],
					kind: "append",
					source: "header",
				};
				return {
					id: this.#offeredHistory.id,
					rows: this.#offeredHistory.rows,
					kind: this.#offeredHistory.kind,
				};
			}
			this.#headerRetired = true;
			this.#retiredHeaderRows = [];
		}
		const batch = this.#historyFlush
			? transcript.peekFlushBatch(width)
			: transcript.peekFinalizedBatch(width, Math.max(0, rows - chromeRows));
		if (batch === undefined) return undefined;
		this.#offeredHistory = {
			id: this.#nextHistoryId++,
			rows: batch.rows,
			kind: batch.kind ?? "append",
			source: { transcript, transcriptId: batch.id, header: "none" },
		};
		return {
			id: this.#offeredHistory.id,
			rows: this.#offeredHistory.rows,
			kind: this.#offeredHistory.kind,
		};
	}

	#rerenderOfferedHistory(width: number): void {
		const offered = this.#offeredHistory;
		if (offered === undefined) return;
		if (offered.source === "header") {
			const rows = this.#header.render(width);
			offered.rows = rows.length > 0 ? [...rows, ""] : [];
			return;
		}
		const transcript = offered.source.transcript.rerenderOfferedBatch(width);
		if (offered.source.header === "none") {
			if (transcript !== undefined) offered.rows = transcript.rows;
			return;
		}
		const recomposed = this.#header.render(width);
		const headerRows = recomposed.length > 0 ? [...recomposed, ""] : this.#reflowRetiredHeader(width, 0);
		offered.source.headerRows = headerRows;
		offered.rows = [...headerRows, ...(transcript?.rows ?? [])];
	}

	#renderRoots(roots: readonly Component[], width: number): string[] {
		const rows: string[] = [];
		for (const root of roots) rows.push(...root.render(width));
		return rows;
	}
	/**
	 * Mounted-runtime rows for the transient resize buffer. Only the trailing
	 * viewport can survive the caller's bottom slice, so the transcript renders
	 * a bounded tail instead of the full committed ledger, and the chrome above
	 * it renders only when that tail underfills the screen.
	 */
	#renderResizeTail(width: number, rows: number): string[] {
		const roots = [...this.#runtimeChildren, this.#statusHost];
		const transcriptIndex = roots.findIndex(root => root instanceof TranscriptContainer);
		if (transcriptIndex < 0) return this.#renderRoots(roots, width);
		const transcript = roots[transcriptIndex] as TranscriptContainer;
		const after = this.#renderRoots(roots.slice(transcriptIndex + 1), width);
		const transcriptRows = transcript.renderTail(width, Math.max(0, rows - after.length));
		const pre =
			transcriptRows.length + after.length >= rows ? [] : this.#renderRoots(roots.slice(0, transcriptIndex), width);
		return [...pre, ...transcriptRows, ...after];
	}

	/** Reflow accepted hard rows exactly as the restored terminal buffer will. */
	#reflowRetiredHeader(width: number, start: number): string[] {
		const lines = this.#retiredHeaderRows;
		if (!lines) return [];
		if (isInsideTerminalMultiplexer()) return lines.slice(start);
		const reflowed: string[] = [];
		const columns = Math.max(1, width);
		for (let index = start; index < lines.length; index++) {
			const line = lines[index]!;
			const lineWidth = visibleWidth(line);
			if (lineWidth === 0) {
				reflowed.push("");
				continue;
			}
			for (let column = 0; column < lineWidth;) {
				let slice = sliceWithWidth(line, column, columns, true);
				if (slice.width === 0) slice = sliceWithWidth(line, column, columns);
				reflowed.push(slice.text);
				column += Math.max(1, slice.width);
			}
		}
		return reflowed;
	}

	/** Live editor whose draft survives startup and session adoption. */
	get editor(): CustomEditor {
		return this.#editor;
	}

	/** The welcome component currently mounted in the header, if quiet mode is off. */
	get welcome(): WelcomeComponent | undefined {
		return this.#welcome;
	}

	/** Whether this composer already owns the terminal render/input loop. */
	get started(): boolean {
		return this.#started && !this.#stopped;
	}

	/** Start terminal ownership and optionally begin the welcome intro. */
	start(options: ComposerStartOptions = {}): void {
		if (this.#started || this.#stopped) return;
		this.#started = true;
		this.ui.start({ clearScrollback: options.clearScrollback === true, deferInput: options.deferInput === true });
		if (options.playWelcomeIntro !== false) this.playWelcomeIntro();
	}
	/** Take raw-input ownership after a deferred-input start. Idempotent. */
	enableInput(): void {
		if (this.#stopped) return;
		this.ui.enableInput();
	}

	/** Apply settings changes without replacing the editor or welcome component. */
	setPreferences(update: Partial<ComposerPreferences>): void {
		if (this.#stopped) return;
		const wasQuiet = this.#preferences.quiet;
		this.#preferences = { ...this.#preferences, ...update };
		this.editor.setTheme(getEditorTheme());
		try {
			this.editor.setBorderStyle(this.#preferences.composerShape);
		} catch {
			// Extension-defined styles arrive with the session; InteractiveMode reapplies them.
		}
		this.ui.setShowHardwareCursor(this.#preferences.showHardwareCursor);
		this.editor.setUseTerminalCursor(this.ui.getShowHardwareCursor());
		this.ui.setMaxInlineImages(this.#preferences.maxInlineImages);
		if (update.resizeScrollback !== undefined) this.ui.setResizeScrollback(update.resizeScrollback);
		this.editor.setImeSafeCursorLayout(this.#preferences.imeSafeCursor);
		this.editor.setAutocompleteMaxVisible(this.#preferences.autocompleteMaxVisible);
		this.editor.setSpellingFeatures({
			typoDetection: this.#preferences.spellingTypoDetection,
			autocomplete: this.#preferences.spellingAutocomplete,
			autocorrect: this.#preferences.spellingAutocorrect,
		});
		this.#applyStatusSnapshot();
		if (this.#preferences.quiet) {
			this.#welcome?.stopIntro();
			this.#welcome = undefined;
		} else {
			this.#ensureWelcome();
			this.#welcome?.invalidate();
			if (wasQuiet && this.#started) this.playWelcomeIntro();
		}
		if (wasQuiet !== this.#preferences.quiet) this.#rebuildHeader();
		this.ui.requestRender();
	}

	/** Patch welcome data in place as model, session, and project discovery complete. */
	updateWelcome(update: ComposerWelcomeUpdate): void {
		if (this.#stopped) return;
		this.#applyWelcomeUpdate(update);
		if (this.#preferences.quiet) return;
		this.#ensureWelcome();
		const welcome = this.#welcome;
		if (!welcome) return;
		if (update.version !== undefined) welcome.setVersion(this.#version);
		if (update.modelName !== undefined || update.providerName !== undefined) {
			welcome.setModel(this.#modelName, this.#providerName);
		}
		if (update.recentSessions !== undefined) welcome.setRecentSessions(this.#recentSessions);
		if (update.lspServers !== undefined) welcome.setLspServers(this.#lspServers);
		this.ui.requestRender();
	}

	/** Replace optional header content around the stable welcome scene. */
	setHeaderExtras(before: readonly Component[], after: readonly Component[]): void {
		if (this.#stopped) return;
		this.#headerBefore = before;
		this.#headerAfter = after;
		this.#rebuildHeader();
		this.ui.requestRender();
	}

	/** Update the canonical editor reference after InteractiveMode remounts a custom editor. */
	setEditor(editor: CustomEditor): void {
		this.#editor = editor;
	}

	/**
	 * Mount the session-aware status component into the slot below the editor.
	 * Drops the speculative snapshot; the caller installs the real top-border
	 * provider through its composer-shape sync.
	 */
	setStatusComponent(component: Component): void {
		this.#statusHost.setComponent(component);
		this.#statusSnapshot = undefined;
		this.editor.setTopBorderProvider(undefined);
	}

	/** Cached placeholder top-border content fitted to the current editor width. */
	#speculativeTopBorder(availableWidth: number): EditorTopBorder | undefined {
		const border = this.#statusSnapshot?.topBorder;
		if (!border) return undefined;
		if (border.width <= availableWidth) return { content: border.content, width: border.width };
		const content = truncateToWidth(border.content, availableWidth);
		return { content, width: visibleWidth(content) };
	}

	/** Install the cached chrome for the current shape; a shape mismatch clears it. */
	#applyStatusSnapshot(): void {
		if (this.#statusHost.mounted) return;
		const snapshot = this.#statusSnapshot;
		if (!snapshot || snapshot.shape !== this.#preferences.composerShape) {
			this.editor.setTopBorderProvider(undefined);
			this.#statusHost.setLines([]);
			return;
		}
		if (snapshot.borderColor) {
			const { prefix, suffix } = snapshot.borderColor;
			this.editor.borderColor = text => `${prefix}${text}${suffix}`;
		}
		this.editor.setTopBorderProvider(
			snapshot.topBorder ? availableWidth => this.#speculativeTopBorder(availableWidth) : undefined,
		);
		this.#statusHost.setLines(snapshot.bottomLines);
	}

	/** Mount or replace session-aware root children while preserving the header and status hosts. */
	setRuntimeChildren(children: readonly Component[]): void {
		if (this.#stopped) return;
		this.#clearViewportSelection();
		this.ui.removeChild(this.#statusHost);
		if (this.#runtimeMounted) {
			for (const child of this.#runtimeChildren) this.ui.removeChild(child);
		} else {
			this.ui.removeChild(this.#bootstrapInputGap);
			this.ui.removeChild(this.editor);
			this.#runtimeMounted = true;
		}
		this.#runtimeChildren = children;
		for (const child of children) this.ui.addChild(child);
		this.ui.addChild(this.#statusHost);
		this.ui.requestRender();
	}

	/** Play or replay the welcome intro against the stable header render target. */
	playWelcomeIntro(): void {
		this.#welcome?.playIntro(() => this.ui.requestComponentRender(this.#header));
	}

	/** Transfer terminal ownership to InteractiveMode without stopping the composer. */
	transfer(): void {
		if (!this.#started || this.#stopped || this.#transferred) {
			throw new Error("Composer is not available for transfer");
		}
		this.#transferred = true;
	}

	/** Stop a composer that has not transferred terminal ownership. */
	stop(): void {
		if (!this.#started || this.#stopped || this.#transferred) return;
		this.#welcome?.stopIntro();
		this.#clearViewportSelection();
		this.#hideCopiedOverlay();
		this.ui.stop();
		this.#stopped = true;
	}

	#applyWelcomeUpdate(update: ComposerWelcomeUpdate): void {
		if (update.version !== undefined) this.#version = update.version;
		if (update.modelName !== undefined) this.#modelName = update.modelName;
		if (update.providerName !== undefined) this.#providerName = update.providerName;
		if (update.recentSessions !== undefined) this.#recentSessions = [...update.recentSessions];
		if (update.lspServers !== undefined) this.#lspServers = [...update.lspServers];
	}

	#ensureWelcome(): void {
		this.#welcome ??= new WelcomeComponent(
			this.#version,
			this.#modelName,
			this.#providerName,
			this.#recentSessions,
			this.#lspServers,
		);
	}

	#rebuildHeader(): void {
		this.#header.clear();
		for (const component of this.#headerBefore) this.#header.addChild(component);
		if (this.#welcome) {
			this.#header.addChild(new Spacer(1));
			this.#header.addChild(this.#welcome);
			this.#header.addChild(new Spacer(1));
		}
		for (const component of this.#headerAfter) this.#header.addChild(component);
	}

	#handleInterrupt(): void {
		const now = this.#now();
		if (now - this.#lastInterruptAt < DOUBLE_INTERRUPT_MS) {
			this.#requestExit(130);
			return;
		}
		this.editor.setText("");
		this.#lastInterruptAt = now;
	}

	#requestExit(code: number): void {
		// Remains live after transfer until InteractiveMode installs its configured handlers.
		if (this.#stopped) return;
		this.#welcome?.stopIntro();
		this.#clearViewportSelection();
		this.#hideCopiedOverlay();
		if (this.#started) this.ui.stop();
		this.#stopped = true;
		this.#exit(code);
	}
}
