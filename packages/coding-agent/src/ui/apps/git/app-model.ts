/**
 * The `omp git` app: repository review in one screen. A header (the shown
 * file, its `+a −d`, key hints or the latest status, the content kind, Stage
 * file, close), a toolbar (scope chip, change navigation, the view switch,
 * whitespace and wrap toggles), the diff pane, and the sidebar (the change
 * lists and commit form, or the HEAD commit on a clean tree).
 *
 * The app owns the flow between the panes and the repository: it refreshes
 * the model every two seconds, streams the selected file into the pane,
 * carries out the sidebar's actions (stage, unstage, discard with a second
 * press to confirm, AI staging, commit message generation, commit) and the
 * pane's hunk and line actions, and routes keys and the pointer to the pane
 * with the keyboard.
 */
import { type Accessor, batch, type KeyEvent, type ScrollRequest, signal, untrack } from "@oh-my-pi/pi-tui";
import type { MouseEvent } from "@oh-my-pi/pi-tui/driver/contract";
import { buildLineSelectionPatch, type HunkBlock, type WhitespaceMode } from "../../../cli/git-tui/model/diff-pane";
import type { GitTuiHost } from "../../../cli/git-tui/model/git-tui";
import type { SidebarAction } from "../../../cli/git-tui/model/sidebar";
import type { ChangedFile, FileContents, GitTuiModel } from "../../../cli/git-tui/model/state";
import { formatKey } from "@oh-my-pi/pi-tui/theme/keys";
import { DiffPaneModel, type HunkAction, type ViewMode } from "./diff-pane-model";
import { buildDiffDocument } from "./document";
import { SidebarModel } from "./sidebar-model";

const REFRESH_MS = 2_000;

/** A key as status messages name it (`⌦`, `x`). */
const keyHint = (key: string): string => formatKey(key, { preset: "unicode", platform: process.platform });
const STATUS_TTL_MS = 6_000;

/** Which pane holds the keyboard. */
export type GitFocus = "diff" | "sidebar";

/** Tone of a status message (its color in the header, its span token natively). */
export type StatusTone = "success" | "warning" | "error" | "accent" | "dim";

/** The views in `1`–`4` order. */
export const VIEW_ORDER: readonly ViewMode[] = ["file", "split", "inline", "hunk"];

/** Columns below which the native layout stacks the sidebar under the diff. */
export const NARROW_COLS = 100;

/** A clickable range of the header or toolbar: columns `[from, to)` running `act`. */
export interface ChromeHit {
	readonly from: number;
	readonly to: number;
	readonly act: string;
}

/** How the terminal splits the screen at a width. */
export interface GitLayout {
	readonly sidebarWidth: number;
	readonly centerWidth: number;
	readonly contentHeight: number;
}

/** The split at `width` × `height`: the sidebar takes 30% (30–48 cells), the diff the rest. */
export function gitLayout(width: number, height: number): GitLayout {
	const sidebarWidth = Math.max(30, Math.min(48, Math.floor(width * 0.3)));
	return { sidebarWidth, centerWidth: width - sidebarWidth - 1, contentHeight: Math.max(10, height) - 2 };
}

/** Options of a {@link GitAppModel}. */
export interface GitAppOptions {
	/** Terminal columns (the native layout stacks below {@link NARROW_COLS}). */
	readonly columns: Accessor<number>;
	/** The app closed (`q`, escape, ⌃C, the close button). */
	onExit?(): void;
}

/** See the module docs. */
export class GitAppModel {
	readonly host: GitTuiHost;
	readonly model: GitTuiModel;
	readonly pane = new DiffPaneModel();
	readonly sidebar: SidebarModel;
	readonly columns: Accessor<number>;
	readonly focus = signal<GitFocus>("sidebar");
	readonly currentFile = signal<ChangedFile | null>(null);
	readonly contents = signal<FileContents | null>(null);
	readonly whitespace = signal<WhitespaceMode>("off");
	readonly status = signal<{ text: string; tone: StatusTone; sticky: boolean; at: number }>({
		text: "",
		tone: "dim",
		sticky: false,
		at: 0,
	});
	/** Bumped when a status message expires. */
	readonly #statusClock = signal(0);
	readonly helpOpen = signal(false);
	readonly #options: GitAppOptions;
	readonly #done = Promise.withResolvers<void>();
	#loadSeq = 0;
	#loadAbort: AbortController | null = null;
	#highlightAbort: AbortController | null = null;
	#generationAbort: AbortController | null = null;
	#aiStageAbort: AbortController | null = null;
	#refreshTimer: NodeJS.Timeout | undefined;
	#statusTimer: NodeJS.Timeout | undefined;
	#busy = false;
	#pendingDiscard: string | null = null;
	#pendingHunkEdge: "last" | null = null;
	#disposed = false;
	#layout: GitLayout = gitLayout(120, 30);
	#headerHits: readonly ChromeHit[] = [];
	#toolbarHits: readonly ChromeHit[] = [];

	constructor(host: GitTuiHost, options: GitAppOptions) {
		this.host = host;
		this.model = host.model;
		this.columns = options.columns;
		this.#options = options;
		this.sidebar = new SidebarModel(() => this.model, {
			onSelectFile: file => this.#showFile(file),
			onAction: action => void this.runSidebarAction(action),
			onFocusDiff: () => this.setFocus("diff"),
		});
		this.sidebar.setFocused(true);
	}

	/** Refresh, then keep refreshing until the app closes; resolves on close. */
	async run(): Promise<void> {
		await this.refresh(true);
		if (!this.#disposed) this.#refreshTimer = setInterval(() => void this.refresh(false), REFRESH_MS);
		return this.#done.promise;
	}

	/** Close the app. */
	quit(): void {
		this.#done.resolve();
		this.#options.onExit?.();
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#loadAbort?.abort();
		this.#highlightAbort?.abort();
		this.#generationAbort?.abort();
		this.#aiStageAbort?.abort();
		clearInterval(this.#refreshTimer);
		clearTimeout(this.#statusTimer);
	}

	// ── data ───────────────────────────────────────────────────────────────

	/** Re-read the repository (`force`: even when nothing changed). */
	async refresh(force: boolean): Promise<void> {
		if (this.#disposed) return;
		try {
			const changed = await this.model.refresh();
			if (!changed && !force) return;
			this.#syncSidebar(true);
			this.#loadDeferredDetails();
		} catch (error) {
			this.#setError(error);
		}
	}

	/** Re-read the sidebar; reload the shown file when asked or when it is gone. */
	#syncSidebar(reloadCurrent: boolean): void {
		const suggested = this.sidebar.reconcile();
		const current = untrack(this.currentFile);
		const all = [...this.model.unstaged, ...this.model.staged, ...(this.model.headCommit?.files ?? [])];
		const stillExists =
			current !== null && all.some(candidate => candidate.path === current.path && candidate.area === current.area);
		const file = stillExists ? current : suggested;
		const same = file !== null && current !== null && file.path === current.path && file.area === current.area;
		if (reloadCurrent || !same) this.#showFile(file);
	}

	#loadDeferredDetails(): void {
		const apply = (changed: boolean): void => {
			if (changed && !this.#disposed) this.#syncSidebar(false);
		};
		const fail = (error: unknown): void => {
			if (!this.#disposed) this.#setError(error);
		};
		void this.model.loadChangeStats().then(apply, fail);
		if (this.model.clean) void this.model.loadHeadFiles().then(apply, fail);
	}

	#patchTargetFor(file: ChangedFile | null): "stage" | "unstage" | null {
		if (!file) return null;
		if (file.area === "unstaged") return file.kind === "untracked" || file.kind === "conflicted" ? null : "stage";
		return file.area === "staged" ? "unstage" : null;
	}

	#showFile(file: ChangedFile | null): void {
		this.#loadAbort?.abort();
		this.#loadAbort = null;
		this.#highlightAbort?.abort();
		this.#highlightAbort = null;
		const seq = ++this.#loadSeq;
		batch(() => {
			this.currentFile.set(file);
			this.contents.set(null);
			this.pane.patchTarget = this.#patchTargetFor(file);
			if (!file) {
				this.pane.emptyMessage = this.model.clean && !this.model.headCommit ? "No commits yet" : "No changes";
				this.pane.setDocument(null, "empty");
			} else this.pane.startStream(file.path);
		});
		if (!file) return;
		const abort = new AbortController();
		this.#loadAbort = abort;
		this.model
			.streamContents(
				file,
				update => {
					if (seq === this.#loadSeq && !this.#disposed) this.pane.updateStream(update);
				},
				abort.signal,
			)
			.then(
				contents => {
					if (seq !== this.#loadSeq || this.#disposed) return;
					if (this.#loadAbort === abort) this.#loadAbort = null;
					this.contents.set(contents);
					this.#rebuildDocument();
				},
				error => {
					if (seq !== this.#loadSeq || abort.signal.aborted) return;
					this.pane.setDocument(null, "empty");
					this.#setError(error);
				},
			);
	}

	/** Build the pane's document from the loaded contents (view toggles re-run it). */
	#rebuildDocument(): void {
		const file = untrack(this.currentFile);
		const contents = untrack(this.contents);
		if (!file || !contents) return;
		this.#highlightAbort?.abort();
		this.#highlightAbort = null;
		const edge = this.#pendingHunkEdge;
		this.#pendingHunkEdge = null;
		if (contents.kind === "asset") {
			this.pane.setAsset(file.path, contents.old, contents.new);
			return;
		}
		const doc = buildDiffDocument(contents.oldText, contents.newText, file.path, {
			whitespace: untrack(this.whitespace),
			streamResult: contents.streamResult,
		});
		this.pane.setDocument(doc, "ready");
		if (edge) this.pane.seekHunk(edge);
		const abort = new AbortController();
		this.#highlightAbort = abort;
		void this.pane.highlightAsync(abort.signal).catch(() => undefined);
	}

	// ── actions ────────────────────────────────────────────────────────────

	/** Carry out a sidebar action (discards ask for a second press first). */
	async runSidebarAction(action: SidebarAction): Promise<void> {
		if (action.type === "discard") {
			const key = action.selection.files.map(file => `${file.area}:${file.path}`).join("\0");
			if (this.#pendingDiscard !== key) {
				this.#pendingDiscard = key;
				this.setStatus(
					"warning",
					`Discard changes to ${action.selection.label}? Press ${keyHint("delete")} again to confirm`,
				);
				return;
			}
			this.#pendingDiscard = null;
		}
		if (this.#busy) return;
		this.#busy = true;
		try {
			switch (action.type) {
				case "discard":
					await this.model.discard(action.selection.files);
					this.setStatus("success", `Discarded ${action.selection.label}`);
					break;
				case "stage":
					await this.model.stage(action.selection?.files);
					this.setStatus("success", action.selection ? `Staged ${action.selection.label}` : "Staged all changes");
					break;
				case "unstage":
					await this.model.unstage(action.selection?.files);
					this.setStatus(
						"success",
						action.selection ? `Unstaged ${action.selection.label}` : "Unstaged all changes",
					);
					break;
				case "stage-ai":
					await this.#aiStage(action.prompt);
					break;
				case "generate":
					await this.#generate();
					break;
				case "commit":
					if (action.stageAll) await this.model.stage();
					await this.model.commit(action.message, { amend: action.amend });
					this.sidebar.clearForm();
					this.setStatus("success", action.amend ? "Amended commit" : "Created commit");
					break;
			}
			await this.refresh(true);
		} catch (error) {
			this.#setError(error);
		} finally {
			this.#busy = false;
		}
	}

	async #aiStage(prompt: string): Promise<void> {
		const abort = new AbortController();
		this.#aiStageAbort = abort;
		this.setStatus("accent", `Filtering changes: ${prompt}`);
		try {
			const outcome = await this.host.aiStage({
				cwd: this.model.cwd,
				instruction: prompt,
				files: this.model.unstaged,
				signal: abort.signal,
				onProgress: message => {
					if (!this.#disposed) this.setStatus("dim", message);
				},
			});
			if (outcome.stagedHunks === 0 && outcome.wholeFiles === 0) {
				this.setStatus("warning", `No changes matched "${prompt}"`);
				return;
			}
			const parts: string[] = [];
			if (outcome.stagedHunks > 0) parts.push(`${outcome.stagedHunks} of ${outcome.totalHunks} hunks`);
			if (outcome.wholeFiles > 0)
				parts.push(`${outcome.wholeFiles} whole file${outcome.wholeFiles === 1 ? "" : "s"}`);
			this.setStatus(
				"success",
				`Staged ${parts.join(" + ")} (${outcome.matchedFiles}/${outcome.totalFiles} files matched)`,
			);
		} finally {
			if (this.#aiStageAbort === abort) this.#aiStageAbort = null;
		}
	}

	async #generate(): Promise<void> {
		const abort = new AbortController();
		this.#generationAbort = abort;
		this.sidebar.setGenerating(true);
		this.setStatus("accent", "Generating commit message…");
		try {
			const generated = await this.host.generateCommitMessage({
				cwd: this.model.cwd,
				stageIfEmpty: true,
				signal: abort.signal,
				onProgress: message => {
					if (!this.#disposed) this.setStatus("dim", message);
				},
			});
			this.sidebar.setGeneratedCommit(generated.commit);
			if (generated.validationError) {
				this.setStatus("warning", `Generated message needs review: ${generated.validationError}`);
			} else {
				this.setStatus(
					"success",
					generated.stagedAll ? "Staged all changes and generated commit message" : "Generated commit message",
				);
			}
		} finally {
			if (this.#generationAbort === abort) this.#generationAbort = null;
			this.sidebar.setGenerating(false);
		}
	}

	async #hunkAction(hunk: HunkBlock, action: HunkAction): Promise<void> {
		if (!hunk.patch) return;
		if (action === "discard" && this.#pendingDiscard !== hunk.patch) {
			this.#pendingDiscard = hunk.patch;
			this.setStatus("warning", `Discard hunk? Press ${keyHint("x")} (or click) again to confirm`);
			return;
		}
		this.#pendingDiscard = null;
		if (this.#busy) return;
		this.#busy = true;
		try {
			if (action === "stage") await this.model.applyPatch(hunk.patch, { cached: true });
			else if (action === "unstage") await this.model.applyPatch(hunk.patch, { cached: true, reverse: true });
			else await this.model.applyPatch(hunk.patch, { reverse: true });
			this.setStatus(
				"success",
				action === "stage" ? "Staged hunk" : action === "unstage" ? "Unstaged hunk" : "Discarded hunk",
			);
			await this.refresh(true);
		} catch (error) {
			this.#setError(error);
		} finally {
			this.#busy = false;
		}
	}

	/** Stage/unstage/discard the selected lines of the shown file. */
	async #lineAction(action: HunkAction): Promise<void> {
		const doc = this.pane.doc;
		const span = this.pane.selection;
		if (!doc || !span) return;
		const patch = buildLineSelectionPatch(doc, span.from, span.to, action === "stage" ? "apply" : "revert");
		if (!patch) {
			this.setStatus("warning", "Selection contains no changes");
			return;
		}
		if (action === "discard" && this.#pendingDiscard !== patch) {
			this.#pendingDiscard = patch;
			this.setStatus("warning", `Discard selected lines? Press ${keyHint("x")} again to confirm`);
			return;
		}
		this.#pendingDiscard = null;
		if (this.#busy) return;
		this.#busy = true;
		try {
			await this.model.applyPatch(patch, { cached: action !== "discard" });
			this.pane.clearSelection();
			this.setStatus(
				"success",
				action === "stage"
					? "Staged selection"
					: action === "unstage"
						? "Unstaged selection"
						: "Discarded selection",
			);
			await this.refresh(true);
		} catch (error) {
			this.#setError(error);
		} finally {
			this.#busy = false;
		}
	}

	/** Show `text` in the header for six seconds. */
	setStatus(tone: StatusTone, text: string): void {
		this.status.set({ text, tone, sticky: false, at: Date.now() });
		clearTimeout(this.#statusTimer);
		this.#statusTimer = setTimeout(() => this.#statusClock.update(v => v + 1), STATUS_TTL_MS);
		this.#statusTimer.unref?.();
	}

	/** A one-line error that stays until the next status. */
	#setError(error: unknown): void {
		const message = error instanceof Error ? error.message : String(error);
		clearTimeout(this.#statusTimer);
		this.status.set({ text: message.replace(/\s+/g, " ").trim(), tone: "error", sticky: true, at: Date.now() });
	}

	/** The status message while it shows. */
	visibleStatus(): { text: string; tone: StatusTone } | null {
		this.#statusClock();
		const status = this.status();
		if (status.text === "") return null;
		return status.sticky || Date.now() - status.at < STATUS_TTL_MS ? status : null;
	}

	// ── view ───────────────────────────────────────────────────────────────

	setFocus(focus: GitFocus): void {
		batch(() => {
			this.focus.set(focus);
			this.sidebar.setFocused(focus === "sidebar");
			this.pane.focused = focus === "diff";
		});
	}

	stageCurrentFile(): void {
		const file = untrack(this.currentFile);
		if (!file) return;
		const selection = { files: [file], label: file.path };
		if (file.area === "unstaged") void this.runSidebarAction({ type: "stage", selection });
		else if (file.area === "staged") void this.runSidebarAction({ type: "unstage", selection });
	}

	#discardCurrentFile(): void {
		const file = untrack(this.currentFile);
		if (!file || file.area === "commit") return;
		void this.runSidebarAction({ type: "discard", selection: { files: [file], label: file.path } });
	}

	setMode(mode: ViewMode): void {
		this.pane.setMode(mode);
	}

	/** Exact → ignore whitespace → ignore formatting and imports. */
	cycleWhitespace(): void {
		const next = { off: "whitespace", whitespace: "formatting", formatting: "off" } as const;
		const mode = next[untrack(this.whitespace)];
		this.whitespace.set(mode);
		this.setStatus(
			"dim",
			mode === "off"
				? "Showing all changes"
				: mode === "whitespace"
					? "Ignoring whitespace-only line changes"
					: "Ignoring formatting and import-only changes",
		);
		this.#rebuildDocument();
	}

	/** Next/previous change, rolling into the adjacent file at the edges. */
	jumpHunkOrFile(direction: 1 | -1): void {
		if (this.pane.jumpHunk(direction)) return;
		this.#selectFile(direction, direction < 0 ? "last" : "first");
	}

	#selectFile(direction: 1 | -1, edge: "first" | "last" = "first"): void {
		this.#pendingHunkEdge = edge === "last" ? "last" : null;
		if (!this.sidebar.selectAdjacentFile(direction, untrack(this.currentFile))) this.#pendingHunkEdge = null;
	}

	toggleHelp(): void {
		this.helpOpen.update(open => !open);
	}

	// ── input ──────────────────────────────────────────────────────────────

	#moveDiffCursor(delta: number, by: ScrollRequest["by"]): true {
		this.pane.moveCursor(delta, false);
		if (this.pane.doc) this.pane.requestScroll(by);
		return true;
	}

	/** A key nothing else consumed. */
	handleKey(key: KeyEvent): boolean {
		if (key.kind === "release") return false;
		const id = key.id;
		if (id === "ctrl+c") return (this.quit(), true);
		if (id === "tab" || id === "shift+tab") {
			this.setFocus(untrack(this.focus) === "diff" ? "sidebar" : "diff");
			return true;
		}
		const focus = untrack(this.focus);
		if (id === "escape") {
			if (focus === "sidebar" && this.sidebar.handleEscape()) return true;
			if (focus === "diff" && this.pane.clearSelection()) return true;
			this.quit();
			return true;
		}
		if (!(focus === "sidebar" && untrack(this.sidebar.editing))) {
			const text = key.text;
			if (id === "q") return (this.quit(), true);
			if (id === "alt+down" || id === "super+alt+down") return (this.jumpHunkOrFile(1), true);
			if (id === "alt+up" || id === "super+alt+up") return (this.jumpHunkOrFile(-1), true);
			if (text === "]") return (this.#selectFile(1), true);
			if (text === "[") return (this.#selectFile(-1), true);
			if (id === "v") return (this.pane.cycleMode(), true);
			if (text !== undefined && text >= "1" && text <= "4" && text.length === 1) {
				return (this.setMode(VIEW_ORDER[Number(text) - 1]!), true);
			}
			if (id === "w") return (this.pane.toggleWrap(), true);
			if (id === "b") return (this.cycleWhitespace(), true);
			if (id === "r") return (void this.refresh(true), true);
			if (text === "?") return (this.toggleHelp(), true);
			if (id === "c") {
				if (this.sidebar.focusCommitForm()) this.setFocus("sidebar");
				return true;
			}
		}
		if (focus === "sidebar") return this.sidebar.handleKey(key);
		const page = Math.max(1, this.#layout.contentHeight - 2);
		switch (id) {
			case "shift+up":
				return (this.pane.moveCursor(-1, true), true);
			case "shift+down":
				return (this.pane.moveCursor(1, true), true);
			case "up":
			case "k":
				return this.#moveDiffCursor(-1, "line-up");
			case "down":
			case "j":
				return this.#moveDiffCursor(1, "line-down");
			case "pageUp":
				return this.#moveDiffCursor(-page, "page-up");
			case "pageDown":
				return this.#moveDiffCursor(page, "page-down");
			case "left":
			case "h":
				return (this.pane.scrollLeftBy(-8), true);
			case "right":
			case "l":
				return (this.pane.scrollLeftBy(8), true);
			case "home":
			case "g":
				this.pane.cursorToEdge("start");
				if (this.pane.doc) this.pane.requestScroll("start");
				return true;
			case "end":
			case "shift+g":
				this.pane.cursorToEdge("end");
				if (this.pane.doc) this.pane.requestScroll("end");
				return true;
			case "enter":
				return (this.jumpHunkOrFile(1), true);
			case "space": {
				// Hunk-view rows do not map back to document rows: Space acts on the focused hunk there.
				const target = this.pane.patchTarget;
				const hunk = this.pane.mode === "hunk" ? this.pane.currentHunk : null;
				if (target && hunk) void this.#hunkAction(hunk, target);
				else if (target && this.pane.selection) void this.#lineAction(target);
				return true;
			}
			case "s":
			case "u": {
				const target = this.pane.patchTarget;
				if (this.pane.selection?.explicit && target) return (void this.#lineAction(target), true);
				const hunk = this.pane.mode === "hunk" ? this.pane.currentHunk : null;
				if (hunk && target) void this.#hunkAction(hunk, target);
				else this.stageCurrentFile();
				return true;
			}
			case "x": {
				if (this.pane.selection?.explicit && this.pane.patchTarget === "stage")
					return (void this.#lineAction("discard"), true);
				const hunk = this.pane.mode === "hunk" ? this.pane.currentHunk : null;
				if (hunk && this.pane.patchTarget === "stage") void this.#hunkAction(hunk, "discard");
				return true;
			}
			case "delete":
				this.#discardCurrentFile();
				return true;
		}
		return true;
	}

	/** Record the terminal layout and the header/toolbar buttons of the last paint. */
	recordChrome(layout: GitLayout, header: readonly ChromeHit[], toolbar: readonly ChromeHit[]): void {
		this.#layout = layout;
		this.#headerHits = header;
		this.#toolbarHits = toolbar;
	}

	/** A toolbar/header/native action. False when it is not the app's. */
	runAction(act: string): boolean {
		switch (act) {
			case "prev-hunk":
				this.jumpHunkOrFile(-1);
				return true;
			case "next-hunk":
				this.jumpHunkOrFile(1);
				return true;
			case "whitespace":
				this.cycleWhitespace();
				return true;
			case "wrap":
				this.pane.toggleWrap();
				return true;
			case "stage-file":
				this.stageCurrentFile();
				return true;
			case "help":
				this.toggleHelp();
				return true;
			case "close":
				this.quit();
				return true;
		}
		if (act.startsWith("view:")) {
			const mode = VIEW_ORDER.find(view => view === act.slice(5));
			if (mode) this.setMode(mode);
			return true;
		}
		return false;
	}

	/** A pointer event at app cell (`mouse.row`, `mouse.col`). */
	handleMouse(mouse: MouseEvent): boolean {
		const { centerWidth } = this.#layout;
		const wheel = mouse.button === "wheel-down" ? 1 : mouse.button === "wheel-up" ? -1 : 0;
		if (wheel !== 0) {
			if (mouse.row < 2) return true;
			if (mouse.col < centerWidth) this.pane.scrollBy(wheel * 3);
			else if (mouse.col > centerWidth) this.sidebar.handleWheel(wheel);
			return true;
		}
		if (mouse.button !== "left" || mouse.action !== "press") return true;
		if (mouse.row < 2) {
			const hits = mouse.row === 0 ? this.#headerHits : this.#toolbarHits;
			const hit = hits.find(candidate => mouse.col >= candidate.from && mouse.col < candidate.to);
			if (hit) this.runAction(hit.act);
			return true;
		}
		const line = mouse.row - 2;
		if (mouse.col > centerWidth) {
			if (untrack(this.focus) !== "sidebar") this.setFocus("sidebar");
			this.sidebar.handleClick(line, mouse.col - centerWidth - 1);
		} else if (mouse.col < centerWidth) {
			if (untrack(this.focus) !== "diff") this.setFocus("diff");
			const click = this.pane.clickAt(mouse.col, line, mouse.mods.includes("shift"));
			if (click?.type === "hunk-action") void this.#hunkAction(click.hunk, click.action);
		}
		return true;
	}
}
