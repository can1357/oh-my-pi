/**
 * The git app's sidebar state: the change lists (staged/unstaged, or the HEAD
 * commit's files on a clean tree), the keyboard selection over every row and
 * control, the commit form (amend, summary, description, commit button) and
 * the AI staging prompt.
 *
 * The sidebar never touches the repository: staging, discarding, committing
 * and generating are {@link SidebarAction}s the host carries out, after which
 * it calls {@link SidebarModel.reconcile} with the refreshed state.
 */
import { batch, computed, type KeyEvent, type Signal, signal, type TextEdit, untrack } from "@oh-my-pi/pi-tui";
import { replaceTabs } from "@oh-my-pi/pi-tui/text/width";
import type { GitCommitMessage, SidebarAction } from "../../../cli/git-tui/model/sidebar";
import type { ChangedFile, GitViewState, HeadCommit } from "../../../cli/git-tui/model/state";
import { editLine, type LineState } from "../../overlays/settings/line-edit";
import { applyTextEdit, caretLine, EMPTY_LINE, editMultiline, lineAt } from "./text-edit";
import { type FileEntry, pathEntries, treeEntries } from "./tree";

/** Summary length the counter counts down from. */
export const SUMMARY_LIMIT = 72;
/** Description rows shown at most. */
const DESCRIPTION_ROWS = 5;

/** Staging section of the working tree. */
export type SectionArea = "unstaged" | "staged";

/** File-list presentation. */
export type ViewStyle = "path" | "tree";

/** Controls of the sidebar besides its rows. */
export type ControlKind =
	| "stage-all"
	| "unstage-all"
	| "stage-ai"
	| "stage-ai-input"
	| "amend"
	| "summary"
	| "description"
	| "commit-button";

/** Something the keyboard can select (or a click can hit). */
export type SidebarTarget =
	| { readonly kind: "entry"; readonly key: string; readonly entry: FileEntry }
	| { readonly kind: "section"; readonly key: string; readonly area: SectionArea }
	| { readonly kind: "view-style"; readonly key: string; readonly style: ViewStyle }
	| { readonly kind: ControlKind; readonly key: string };

const control = (kind: ControlKind): SidebarTarget => ({ kind, key: kind });
const sectionTarget = (area: SectionArea): SidebarTarget => ({ kind: "section", key: `section:${area}`, area });

/** One terminal row of the sidebar (styled by the `omp.app.git.side` look). */
export type SidebarRow =
	| { readonly kind: "title"; readonly total: number; readonly branch: string | null }
	| { readonly kind: "toggle"; readonly style: ViewStyle; readonly left: number }
	| { readonly kind: "rule" }
	| { readonly kind: "blank" }
	| { readonly kind: "note"; readonly text: string }
	| {
			readonly kind: "section";
			readonly area: SectionArea;
			readonly folded: boolean;
			readonly count: number;
			readonly highlight: boolean;
	  }
	| { readonly kind: "ai"; readonly selected: boolean; readonly line: LineState | undefined }
	| {
			readonly kind: "entry";
			readonly entry: FileEntry;
			readonly selected: boolean;
			readonly highlight: boolean;
	  }
	| { readonly kind: "amend"; readonly on: boolean; readonly highlight: boolean }
	| { readonly kind: "summary-label"; readonly length: number }
	| { readonly kind: "summary"; readonly selected: boolean; readonly line: LineState }
	| {
			readonly kind: "description";
			readonly selected: boolean;
			/** The visual line; undefined draws the placeholder. */
			readonly text: string | undefined;
			/** Caret column in `text`, when the caret is on this line. */
			readonly caret: number | undefined;
	  }
	| { readonly kind: "button"; readonly label: string; readonly enabled: boolean; readonly highlight: boolean }
	| { readonly kind: "subject"; readonly text: string }
	| { readonly kind: "body"; readonly text: string }
	| { readonly kind: "avatar"; readonly email: string; readonly line: number }
	| { readonly kind: "author"; readonly name: string; readonly email: string }
	| { readonly kind: "authored"; readonly when: string }
	| { readonly kind: "parents"; readonly parents: readonly string[] }
	| { readonly kind: "clean"; readonly sha: string }
	| {
			readonly kind: "commit-files";
			readonly count: number;
			readonly sha: string;
			readonly additions: number;
			readonly deletions: number;
	  };

/** A click target inside a row: columns `[from, to)`. */
interface RowHit {
	readonly from: number;
	readonly to: number;
	readonly target: SidebarTarget;
}

interface PlacedRow {
	readonly row: SidebarRow;
	readonly target?: SidebarTarget;
	readonly hits?: readonly RowHit[];
}

/** Toggle pill labels (` ☰ Path `, ` └ Tree `): eight cells each. */
const TOGGLE_PILL = 8;

/** What the sidebar shows at one size. */
export interface SidebarLayout {
	readonly rows: readonly SidebarRow[];
}

/** Host callbacks of a {@link SidebarModel}. */
export interface SidebarHost {
	/** The selection landed on a file (show it in the diff). */
	onSelectFile?(file: ChangedFile | null): void;
	onAction?(action: SidebarAction): void;
	/** ⏎/→ on a file: move the keyboard into the diff. */
	onFocusDiff?(): void;
}

const pillWidth = (label: string): number => label.length + 2;

/** See the module docs. */
export class SidebarModel {
	readonly #host: SidebarHost;
	readonly #state: Signal<GitViewState>;
	readonly #read: () => GitViewState;
	readonly focused = signal(false);
	readonly amend = signal(false);
	readonly generating = signal(false);
	readonly viewStyle = signal<ViewStyle>("tree");
	readonly aiOpen = signal(false);
	readonly summary = signal<LineState>(EMPTY_LINE);
	readonly description = signal<LineState>(EMPTY_LINE);
	readonly aiPrompt = signal<LineState>(EMPTY_LINE);
	readonly #collapsedDirs = signal<ReadonlySet<string>>(new Set());
	readonly #collapsedSections = signal<ReadonlySet<SectionArea>>(new Set());
	readonly #selectedKey = signal<string | undefined>(undefined);
	/** Bumped by wheel scrolling (the next paint applies it). */
	readonly #scrollVersion = signal(0);
	#top = 0;
	#followSelection = false;
	#visibleRows: (PlacedRow | undefined)[] = [];
	#lastHeight = 24;

	/** `read` returns the repository state; {@link reconcile} re-reads it. */
	constructor(read: () => GitViewState, host: SidebarHost = {}) {
		this.#read = read;
		this.#host = host;
		this.#state = signal(snapshot(read()));
	}

	/** The repository state the sidebar last read. */
	get state(): GitViewState {
		return this.#state();
	}

	// ── targets ────────────────────────────────────────────────────────────

	/** Rows of `files` in the current presentation. */
	entries(files: readonly ChangedFile[], section: string): FileEntry[] {
		return this.viewStyle() === "path" ? pathEntries(files) : treeEntries(files, section, this.#collapsedDirs());
	}

	isSectionFolded(area: SectionArea): boolean {
		return this.#collapsedSections().has(area);
	}

	/** Everything the keyboard moves through, in order. */
	readonly targets = computed((): readonly SidebarTarget[] => {
		const state = this.#state();
		const out: SidebarTarget[] = [];
		const pushEntries = (files: readonly ChangedFile[], section: string): void => {
			for (const entry of this.entries(files, section)) out.push({ kind: "entry", key: entryKey(entry), entry });
		};
		if (state.clean) {
			pushEntries(state.headCommit?.files ?? [], "commit");
			return out;
		}
		out.push(sectionTarget("unstaged"));
		if (this.aiOpen()) out.push(control("stage-ai-input"));
		if (!this.isSectionFolded("unstaged")) pushEntries(state.unstaged, "unstaged");
		out.push(sectionTarget("staged"));
		if (!this.isSectionFolded("staged")) pushEntries(state.staged, "staged");
		out.push(control("amend"), control("summary"), control("description"), control("commit-button"));
		return out;
	});

	/** The selected target (the first row when the selection is gone). */
	readonly selected = computed((): SidebarTarget | undefined => {
		const key = this.#selectedKey();
		const targets = this.targets();
		return targets.find(target => target.key === key) ?? targets[0];
	});

	get selectedFile(): ChangedFile | null {
		const target = untrack(this.selected);
		return target?.kind === "entry" && target.entry.kind === "file" ? target.entry.file : null;
	}

	#selectedIndex(): number {
		const key = untrack(this.selected)?.key;
		return untrack(this.targets).findIndex(target => target.key === key);
	}

	/** Whether `kind` is the selected control. */
	isSelected(kind: SidebarTarget["kind"] | string): boolean {
		const selected = this.selected();
		return selected !== undefined && (selected.kind === kind || selected.key === kind);
	}

	/** Whether a text field owns the keys (summary, description or the AI prompt selected while focused). */
	readonly editing = computed((): "summary" | "description" | "stage-ai-input" | undefined => {
		if (!this.focused()) return undefined;
		const kind = this.selected()?.kind;
		return kind === "summary" || kind === "description" || kind === "stage-ai-input" ? kind : undefined;
	});

	// ── state sync ─────────────────────────────────────────────────────────

	/** Re-read the repository state (the selection stays on its key, or falls back to the first row). */
	refresh(): void {
		this.#state.set(snapshot(this.#read()));
		this.#pruneSelection();
	}

	/** Forget a selected row that no longer exists (the selection falls back to the first row). */
	#pruneSelection(): void {
		const key = untrack(this.#selectedKey);
		if (key !== undefined && !untrack(this.targets).some(target => target.key === key)) {
			this.#selectedKey.set(undefined);
		}
	}

	/**
	 * Re-read the repository state after the host changed it; a selected row
	 * that disappeared hands the selection to the nearest surviving file or
	 * folder row. Returns the file the diff should show.
	 */
	reconcile(): ChangedFile | null {
		const before = untrack(this.targets);
		const previousKey = untrack(this.#selectedKey);
		this.#state.set(snapshot(this.#read()));
		const after = untrack(this.targets);
		if (previousKey !== undefined && !after.some(target => target.key === previousKey)) {
			const survivor = nearestSurvivor(before, previousKey, after);
			if (survivor) this.#selectedKey.set(survivor.key);
		}
		this.#pruneSelection();
		// A fresh list selects its first row.
		if (untrack(this.#selectedKey) === undefined) this.#selectedKey.set(after[0]?.key);
		if (untrack(this.#selectedKey) !== previousKey) this.#followSelection = true;
		const file = this.selectedFile;
		if (file) return file;
		const first = after.find(target => target.kind === "entry" && target.entry.kind === "file");
		return first?.kind === "entry" && first.entry.kind === "file" ? first.entry.file : null;
	}

	// ── selection ──────────────────────────────────────────────────────────

	#select(target: SidebarTarget): void {
		const targets = untrack(this.targets);
		this.#selectedKey.set(targets.some(item => item.key === target.key) ? target.key : targets[0]?.key);
		this.#followSelection = true;
		if (target.kind === "entry" && target.entry.kind === "file") this.#host.onSelectFile?.(target.entry.file);
	}

	/** Move the keyboard into or out of the sidebar. */
	setFocused(focused: boolean): void {
		this.focused.set(focused);
	}

	#move(delta: number): void {
		const targets = untrack(this.targets);
		if (targets.length === 0) return;
		const index = Math.max(0, this.#selectedIndex());
		const next = Math.max(0, Math.min(targets.length - 1, index + delta));
		if (next === index) return;
		this.#select(targets[next]!);
	}

	/**
	 * Select the next/previous file row, starting from `from` (the file the
	 * diff shows) or the selection. False at the end of the list.
	 */
	selectAdjacentFile(direction: 1 | -1, from?: ChangedFile | null): boolean {
		const targets = untrack(this.targets);
		let start = from
			? targets.findIndex(
					target =>
						target.kind === "entry" &&
						target.entry.kind === "file" &&
						target.entry.file.path === from.path &&
						target.entry.file.area === from.area,
				)
			: -1;
		if (start < 0) start = this.#selectedIndex();
		for (let i = start + direction; i >= 0 && i < targets.length; i += direction) {
			const target = targets[i]!;
			if (target.kind === "entry" && target.entry.kind === "file") {
				this.#select(target);
				return true;
			}
		}
		return false;
	}

	/** Select the commit summary (the `c` shortcut); false on a clean tree. */
	focusCommitForm(): boolean {
		const summary = untrack(this.targets).find(target => target.kind === "summary");
		if (!summary) return false;
		this.#select(summary);
		return true;
	}

	// ── actions ────────────────────────────────────────────────────────────

	#emit(action: SidebarAction | null): void {
		if (action) this.#host.onAction?.(action);
	}

	/** Files under a file/folder row; null outside the unstaged/staged lists. */
	#filesOf(target: SidebarTarget): { files: ChangedFile[]; label: string; area: SectionArea } | null {
		if (target.kind !== "entry") return null;
		const entry = target.entry;
		if (entry.kind === "file") {
			const area = entry.file.area;
			if (area !== "unstaged" && area !== "staged") return null;
			return { files: [entry.file], label: entry.file.path, area };
		}
		const sep = entry.key.indexOf(":");
		const area = entry.key.slice(0, sep);
		if (area !== "unstaged" && area !== "staged") return null;
		const path = entry.key.slice(sep + 1);
		const state = untrack(this.#state);
		const files = (area === "unstaged" ? state.unstaged : state.staged).filter(file =>
			file.path.startsWith(`${path}/`),
		);
		return files.length === 0 ? null : { files, label: `${path}/`, area };
	}

	#stageAction(target: SidebarTarget): SidebarAction | null {
		if (target.kind === "section") return { type: target.area === "unstaged" ? "stage" : "unstage" };
		const selected = this.#filesOf(target);
		if (!selected) return null;
		const selection = { files: selected.files, label: selected.label };
		return selected.area === "unstaged" ? { type: "stage", selection } : { type: "unstage", selection };
	}

	#discardAction(target: SidebarTarget): SidebarAction | null {
		const selected = this.#filesOf(target);
		return selected ? { type: "discard", selection: { files: selected.files, label: selected.label } } : null;
	}

	#toggleDir(key: string, collapse?: boolean): void {
		const next = new Set(untrack(this.#collapsedDirs));
		const on = collapse ?? !next.has(key);
		if (on) next.add(key);
		else next.delete(key);
		this.#collapsedDirs.set(next);
		this.#pruneSelection();
	}

	#toggleSection(area: SectionArea): void {
		const next = new Set(untrack(this.#collapsedSections));
		if (!next.delete(area)) next.add(area);
		this.#collapsedSections.set(next);
		this.#pruneSelection();
	}

	#setStyle(style: ViewStyle): void {
		this.viewStyle.set(style);
		this.#pruneSelection();
	}

	#activate(target: SidebarTarget): void {
		switch (target.kind) {
			case "entry":
				if (target.entry.kind === "dir") this.#toggleDir(target.entry.key);
				else this.#emit(this.#stageAction(target));
				return;
			case "view-style":
				this.#setStyle(target.style);
				return;
			case "section":
				this.#toggleSection(target.area);
				return;
			case "stage-all":
				this.#emit({ type: "stage" });
				return;
			case "unstage-all":
				this.#emit({ type: "unstage" });
				return;
			case "stage-ai":
				this.#openAiPrompt();
				return;
			case "amend":
				this.#toggleAmend();
				return;
			case "commit-button":
				this.#submit();
				return;
		}
	}

	#openAiPrompt(): void {
		this.aiOpen.set(true);
		this.#select(control("stage-ai-input"));
	}

	#closeAiPrompt(): void {
		batch(() => {
			this.aiOpen.set(false);
			this.aiPrompt.set(EMPTY_LINE);
		});
		this.#pruneSelection();
	}

	#submitAiPrompt(): void {
		const prompt = untrack(this.aiPrompt).text.trim();
		if (prompt.length === 0) return;
		this.#closeAiPrompt();
		this.#select(sectionTarget("unstaged"));
		this.#emit({ type: "stage-ai", prompt });
	}

	#toggleAmend(): void {
		const on = !untrack(this.amend);
		batch(() => {
			this.amend.set(on);
			const head = untrack(this.#state).headCommit;
			if (on && head && untrack(this.summary).text === "" && untrack(this.description).text === "") {
				this.summary.set(lineAt(head.subject));
				this.description.set(lineAt(head.body));
			}
		});
	}

	#submit(): void {
		const state = untrack(this.#state);
		const summary = untrack(this.summary).text.trim();
		const body = untrack(this.description).text.trim();
		const stageAll = state.staged.length === 0;
		if (stageAll && state.unstaged.length === 0 && !untrack(this.amend)) return;
		if (!summary) {
			if (!body) this.#emit({ type: "generate" });
			return;
		}
		this.#emit({
			type: "commit",
			message: body ? `${summary}\n\n${body}` : summary,
			amend: untrack(this.amend),
			stageAll,
		});
	}

	/** Empty the commit form (after a commit). */
	clearForm(): void {
		batch(() => {
			this.summary.set(EMPTY_LINE);
			this.description.set(EMPTY_LINE);
			this.amend.set(false);
		});
	}

	/** Fill the commit form with a generated conventional commit. */
	setGeneratedCommit(commit: GitCommitMessage): void {
		const scope = commit.scope ? `(${commit.scope})` : "";
		batch(() => {
			this.summary.set(lineAt(`${commit.type}${scope}: ${commit.summary}`));
			this.description.set(lineAt(commit.body.map(detail => `- ${detail}`).join("\n")));
		});
	}

	setGenerating(generating: boolean): void {
		this.generating.set(generating);
	}

	// ── input ──────────────────────────────────────────────────────────────

	/** Escape inside the sidebar: leave a text field. True when consumed. */
	handleEscape(): boolean {
		const kind = untrack(this.selected)?.kind;
		if (kind === "stage-ai-input") {
			this.#closeAiPrompt();
			this.#select(sectionTarget("unstaged"));
			return true;
		}
		if (kind === "summary" || kind === "description") {
			this.#select(control("commit-button"));
			return true;
		}
		return false;
	}

	#collapseOrParent(): void {
		const target = untrack(this.selected);
		if (!target) return;
		if (target.kind === "section") {
			if (!this.isSectionFoldedNow(target.area)) this.#toggleSection(target.area);
			return;
		}
		if (target.kind !== "entry") return;
		if (target.entry.kind === "dir" && !target.entry.collapsed) {
			this.#toggleDir(target.entry.key, true);
			return;
		}
		const targets = untrack(this.targets);
		const index = targets.findIndex(candidate => candidate.key === target.key);
		const depth = target.entry.depth ?? 0;
		for (let i = index - 1; i >= 0; i--) {
			const candidate = targets[i]!;
			if (candidate.kind !== "entry") return;
			if (candidate.entry.kind === "dir" && candidate.entry.depth < depth) {
				this.#select(candidate);
				return;
			}
		}
	}

	isSectionFoldedNow(area: SectionArea): boolean {
		return untrack(this.#collapsedSections).has(area);
	}

	#expandOrOpen(): void {
		const target = untrack(this.selected);
		if (!target) return;
		if (target.kind === "section") {
			if (this.isSectionFoldedNow(target.area)) this.#toggleSection(target.area);
			else this.#move(1);
			return;
		}
		if (target.kind !== "entry") return;
		if (target.entry.kind === "dir") {
			if (target.entry.collapsed) this.#toggleDir(target.entry.key, false);
			else this.#move(1);
			return;
		}
		this.#host.onFocusDiff?.();
	}

	/** A key while the sidebar holds the keyboard. True when consumed. */
	handleKey(key: KeyEvent): boolean {
		if (key.kind === "release") return false;
		const target = untrack(this.selected);
		const focused = untrack(this.focused);
		const id = key.id;
		if (focused && (target?.kind === "stage-ai-input" || target?.kind === "summary")) {
			if (id === "up") return (this.#move(-1), true);
			if (id === "down") return (this.#move(1), true);
			if (id !== "pageUp" && id !== "pageDown") {
				if (id === "enter") {
					if (target.kind === "summary") this.#move(1);
					else this.#submitAiPrompt();
					return true;
				}
				if (id === "escape") return this.handleEscape();
				const field = target.kind === "summary" ? this.summary : this.aiPrompt;
				const next = editLine(untrack(field), key);
				if (next) field.set(next);
				return true;
			}
		}
		if (focused && target?.kind === "description") {
			const value = untrack(this.description);
			const at = caretLine(value);
			if (id === "up" && at.start === 0) return (this.#move(-1), true);
			if (id === "down" && at.end >= value.text.length) return (this.#move(1), true);
			if (id !== "pageUp" && id !== "pageDown") {
				if (id === "escape") return this.handleEscape();
				const next = editMultiline(value, key);
				if (next) this.description.set(next);
				return true;
			}
		}
		const count = untrack(this.targets).length;
		switch (id) {
			case "up":
			case "k":
				this.#move(-1);
				return true;
			case "down":
			case "j":
				this.#move(1);
				return true;
			case "left":
			case "h":
				this.#collapseOrParent();
				return true;
			case "right":
			case "l":
				this.#expandOrOpen();
				return true;
			case "home":
			case "g":
				this.#move(-count);
				return true;
			case "end":
			case "shift+g":
				this.#move(count);
				return true;
			case "pageUp":
				this.#move(-Math.max(1, this.#lastHeight - 4));
				return true;
			case "pageDown":
				this.#move(Math.max(1, this.#lastHeight - 4));
				return true;
			case "enter":
				if (!target) return false;
				if (target.kind === "entry" && target.entry.kind === "file") this.#host.onFocusDiff?.();
				else this.#activate(target);
				return true;
			case "t":
				this.#setStyle(untrack(this.viewStyle) === "path" ? "tree" : "path");
				return true;
		}
		const rowLike = target?.kind === "entry" || target?.kind === "section";
		if (id === "space" && rowLike) {
			this.#emit(this.#stageAction(target));
			return true;
		}
		if ((id === "s" || id === "u") && rowLike) {
			const action = this.#stageAction(target);
			if (action?.type === (id === "s" ? "stage" : "unstage")) this.#emit(action);
			return true;
		}
		if (id === "delete" && target?.kind === "entry") {
			this.#emit(this.#discardAction(target));
			return true;
		}
		return false;
	}

	/** Wheel over the sidebar: three rows per notch. */
	handleWheel(delta: number): void {
		this.#top += delta * 3;
		this.#scrollVersion.update(v => v + 1);
	}

	/** A left click at sidebar-local cell (`row`, `col`) of the last layout. */
	handleClick(row: number, col: number): void {
		const placed = this.#visibleRows[row];
		if (!placed) return;
		const hit = placed.hits?.find(candidate => col >= candidate.from && col < candidate.to);
		const target = hit?.target ?? placed.target;
		if (!target) return;
		// Selection follows the row; buttons inside it run their own action.
		const selectTarget = placed.target ?? target;
		const wasSelected = untrack(this.selected)?.key === selectTarget.key;
		this.#select(selectTarget);
		const isFile = target.kind === "entry" && target.entry.kind === "file";
		if (!isFile && target.kind !== "summary" && target.kind !== "description") this.#activate(target);
		else if (isFile && wasSelected) this.#activate(target);
	}

	// ── native events ──────────────────────────────────────────────────────

	/** A list row picked natively (`select`/`activate` with the row's item key). False when unknown. */
	pickItem(item: string, activate: boolean): boolean {
		if (item === "path" || item === "tree") {
			this.#setStyle(item);
			return true;
		}
		const target = untrack(this.targets).find(
			candidate => candidate.kind === "entry" && itemKey(candidate.key) === item,
		);
		if (!target || target.kind !== "entry") return false;
		const wasSelected = untrack(this.selected)?.key === target.key;
		this.#select(target);
		if (activate || target.entry.kind === "dir" || wasSelected) this.#activate(target);
		return true;
	}

	/** A native action (fold, stage all, amend, commit, edit a field). False when not the sidebar's. */
	runAction(act: string): boolean {
		switch (act) {
			case "fold-unstaged":
			case "fold-staged":
				this.#toggleSection(act === "fold-unstaged" ? "unstaged" : "staged");
				return true;
			case "stage-all":
			case "unstage-all":
			case "stage-ai":
				this.#activate(control(act));
				return true;
			case "amend":
				this.#select(control("amend"));
				this.#toggleAmend();
				return true;
			case "commit":
				this.#select(control("commit-button"));
				this.#submit();
				return true;
			case "edit-summary":
				this.#select(control("summary"));
				return true;
			case "edit-description":
				this.#select(control("description"));
				return true;
			case "edit-ai":
				this.#select(control("stage-ai-input"));
				return true;
		}
		return false;
	}

	#activeField(): Signal<LineState> | undefined {
		switch (untrack(this.editing)) {
			case "summary":
				return this.summary;
			case "description":
				return this.description;
			case "stage-ai-input":
				return this.aiPrompt;
		}
	}

	/** A bracketed paste inserts at the active field's caret, never as Git shortcuts. */
	paste(text: string): boolean {
		const field = this.#activeField();
		if (!field) return false;
		const clean = replaceTabs(text.normalize("NFC").replace(/\r\n?/g, "\n")).replace(
			field === this.description ? /[\x00-\x09\x0b-\x1f\x7f]/g : /[\x00-\x1f\x7f]/g,
			"",
		);
		const { text: value, cursor } = field.peek();
		field.set({ text: value.slice(0, cursor) + clean + value.slice(cursor), cursor: cursor + clean.length });
		return true;
	}

	/** A native edit of the field being edited (stale edits are dropped). */
	applyEdit(edit: TextEdit): boolean {
		const field = this.#activeField();
		if (!field) return false;
		const next = applyTextEdit(untrack(field), edit);
		if (next) field.set(next);
		return true;
	}

	// ── layout ─────────────────────────────────────────────────────────────

	/** Rows at `width` × `height` (resolves the list scroll; clicks map through the last layout). */
	layout(width: number, height: number): SidebarLayout {
		this.#scrollVersion();
		this.#lastHeight = height;
		const state = this.#state();
		const selectedKey = this.selected()?.key;
		const focused = this.focused();
		const list: PlacedRow[] = [];
		let pinned: PlacedRow[] = [];
		if (state.clean) this.#commitView(state.headCommit, width, list, selectedKey);
		else {
			list.push({
				row: { kind: "title", total: state.unstaged.length + state.staged.length, branch: state.branch },
			});
			list.push(this.#toggleRow(width));
			list.push({ row: { kind: "rule" } });
			this.#changeLists(state, width, list, selectedKey, focused);
			pinned = this.#commitForm(state, width, selectedKey, focused);
		}
		const listHeight = Math.max(1, height - pinned.length);
		const maxTop = Math.max(0, list.length - listHeight);
		this.#top = Math.max(0, Math.min(this.#top, maxTop));
		if (this.#followSelection) {
			this.#followSelection = false;
			const index = list.findIndex(placed => placed.target?.key === selectedKey);
			if (index >= 0) {
				if (index < this.#top) this.#top = index;
				else if (index >= this.#top + listHeight) this.#top = index - listHeight + 1;
			}
		}
		this.#top = Math.max(0, Math.min(this.#top, maxTop));
		const visible: (PlacedRow | undefined)[] = [];
		for (let i = 0; i < listHeight; i++) visible.push(list[this.#top + i]);
		visible.push(...pinned);
		this.#visibleRows = visible.slice(0, height);
		return { rows: this.#visibleRows.map(placed => placed?.row ?? { kind: "blank" }) };
	}

	#toggleRow(width: number): PlacedRow {
		const total = TOGGLE_PILL * 2 + 1;
		const left = Math.max(1, Math.floor((width - total) / 2));
		return {
			row: { kind: "toggle", style: this.viewStyle(), left },
			hits: [
				{ from: left, to: left + TOGGLE_PILL, target: { kind: "view-style", key: "view:path", style: "path" } },
				{
					from: left + TOGGLE_PILL + 1,
					to: left + total,
					target: { kind: "view-style", key: "view:tree", style: "tree" },
				},
			],
		};
	}

	#sectionRow(
		area: SectionArea,
		count: number,
		width: number,
		selectedKey: string | undefined,
		focused: boolean,
	): PlacedRow {
		const folded = this.isSectionFolded(area);
		const label = `${folded ? "▸" : "▾"} ${area === "unstaged" ? "Unstaged" : "Staged"} Files (${count})`;
		const pills: [string, ControlKind][] =
			area === "unstaged"
				? [
						[" Stage All ", "stage-all"],
						[" ✦ ", "stage-ai"],
					]
				: [[" Unstage All ", "unstage-all"]];
		const right = pills.reduce((sum, [text]) => sum + pillWidth(text) - 2, 0) + pills.length - 1;
		const pad = Math.max(1, width - 2 - Bun.stringWidth(label) - right);
		let col = 1 + Bun.stringWidth(label) + pad;
		const hits: RowHit[] = [];
		pills.forEach(([text, kind], index) => {
			if (index > 0) col += 1;
			hits.push({ from: col, to: col + text.length, target: control(kind) });
			col += text.length;
		});
		const target = sectionTarget(area);
		return {
			row: { kind: "section", area, folded, count, highlight: focused && selectedKey === target.key },
			target,
			hits,
		};
	}

	#entryRows(
		files: readonly ChangedFile[],
		section: string,
		list: PlacedRow[],
		selectedKey: string | undefined,
		focused: boolean,
	): void {
		for (const entry of this.entries(files, section)) {
			const key = entryKey(entry);
			const selected = selectedKey === key;
			list.push({
				row: { kind: "entry", entry, selected, highlight: selected && focused },
				target: { kind: "entry", key, entry },
			});
		}
	}

	#changeLists(
		state: GitViewState,
		width: number,
		list: PlacedRow[],
		selectedKey: string | undefined,
		focused: boolean,
	): void {
		list.push(this.#sectionRow("unstaged", state.unstaged.length, width, selectedKey, focused));
		if (this.aiOpen()) {
			const selected = selectedKey === "stage-ai-input";
			const line = this.aiPrompt();
			const showField = line.text.length > 0 || (focused && selected);
			list.push({
				row: { kind: "ai", selected, line: showField ? line : undefined },
				target: control("stage-ai-input"),
			});
		}
		if (!this.isSectionFolded("unstaged")) {
			this.#entryRows(state.unstaged, "unstaged", list, selectedKey, focused);
			if (state.unstaged.length === 0) list.push({ row: { kind: "note", text: "   no unstaged files" } });
		}
		list.push({ row: { kind: "blank" } });
		list.push(this.#sectionRow("staged", state.staged.length, width, selectedKey, focused));
		if (!this.isSectionFolded("staged")) {
			this.#entryRows(state.staged, "staged", list, selectedKey, focused);
			if (state.staged.length === 0) list.push({ row: { kind: "note", text: "   no staged files" } });
		}
	}

	#commitForm(state: GitViewState, width: number, selectedKey: string | undefined, focused: boolean): PlacedRow[] {
		const rows: PlacedRow[] = [{ row: { kind: "rule" } }];
		const amend = this.amend();
		rows.push({
			row: { kind: "amend", on: amend, highlight: focused && selectedKey === "amend" },
			target: control("amend"),
		});
		const summary = this.summary();
		rows.push({ row: { kind: "summary-label", length: summary.text.length } });
		rows.push({
			row: { kind: "summary", selected: selectedKey === "summary", line: summary },
			target: control("summary"),
		});
		const description = this.description();
		const descriptionSelected = selectedKey === "description";
		const editingDescription = focused && descriptionSelected;
		if (description.text.length === 0 && !editingDescription) {
			rows.push({
				row: { kind: "description", selected: descriptionSelected, text: undefined, caret: undefined },
				target: control("description"),
			});
		} else {
			for (const line of descriptionLines(description, Math.max(1, width - 4))) {
				rows.push({
					row: { kind: "description", selected: descriptionSelected, ...line },
					target: control("description"),
				});
			}
		}
		rows.push({ row: { kind: "blank" } });
		const hasChanges = state.staged.length > 0 || state.unstaged.length > 0 || amend;
		const generating = this.generating();
		const summaryText = summary.text.trim();
		const enabled = hasChanges && !generating && (summaryText.length > 0 || description.text.trim().length === 0);
		const label = generating
			? "-○- Generating commit message"
			: state.staged.length > 0
				? "-○- Commit staged changes"
				: "-○- Stage all & commit";
		rows.push({
			row: { kind: "button", label, enabled, highlight: enabled && focused && selectedKey === "commit-button" },
			target: control("commit-button"),
		});
		return rows;
	}

	#commitView(head: HeadCommit | null, width: number, list: PlacedRow[], selectedKey: string | undefined): void {
		if (!head) {
			list.push({ row: { kind: "blank" } }, { row: { kind: "note", text: " No commits yet" } });
			return;
		}
		for (const line of Bun.wrapAnsi(head.subject, Math.max(1, width - 2)).split("\n")) {
			list.push({ row: { kind: "subject", text: line } });
		}
		if (head.body) {
			list.push({ row: { kind: "blank" } });
			const body = Bun.wrapAnsi(head.body, Math.max(1, width - 2))
				.split("\n")
				.slice(0, 8);
			for (const line of body) list.push({ row: { kind: "body", text: line } });
		}
		list.push({ row: { kind: "blank" } });
		for (let line = 0; line < 3; line++) list.push({ row: { kind: "avatar", email: head.authorEmail, line } });
		list.push({ row: { kind: "author", name: head.authorName, email: head.authorEmail } });
		const when = head.authorDate ? new Date(head.authorDate) : null;
		if (when && !Number.isNaN(when.getTime())) list.push({ row: { kind: "authored", when: when.toLocaleString() } });
		if (head.parents.length > 0) list.push({ row: { kind: "parents", parents: head.parents } });
		list.push({ row: { kind: "clean", sha: head.shortSha } });
		list.push({ row: { kind: "rule" } });
		if (!head.filesLoaded) {
			list.push({ row: { kind: "note", text: " Loading changed files…" } });
			return;
		}
		const additions = head.files.reduce((sum, file) => sum + (file.additions ?? 0), 0);
		const deletions = head.files.reduce((sum, file) => sum + (file.deletions ?? 0), 0);
		list.push({ row: { kind: "commit-files", count: head.files.length, sha: head.shortSha, additions, deletions } });
		list.push(this.#toggleRow(width));
		this.#entryRows(head.files, "commit", list, selectedKey, this.focused());
	}
}

/** Selection identity of a file-list row. */
export function entryKey(entry: FileEntry): string {
	return entry.kind === "dir" ? `dir:${entry.key}` : entry.key;
}

/** The native list item key of a row identity. */
export function itemKey(identity: string): string {
	return Bun.hash(identity).toString(36);
}

function snapshot(state: GitViewState): GitViewState {
	return {
		cwd: state.cwd,
		branch: state.branch,
		clean: state.clean,
		unstaged: state.unstaged,
		staged: state.staged,
		headCommit: state.headCommit,
	};
}

/** The closest file/folder row of `before` around `key` that still exists in `after`. */
function nearestSurvivor(
	before: readonly SidebarTarget[],
	key: string,
	after: readonly SidebarTarget[],
): SidebarTarget | undefined {
	const index = before.findIndex(target => target.key === key);
	if (index < 0) return undefined;
	const survivorAt = (i: number): SidebarTarget | undefined => {
		const candidate = before[i]!;
		if (candidate.kind !== "entry") return undefined;
		return after.find(target => target.key === candidate.key);
	};
	for (let i = index + 1; i < before.length; i++) {
		const survivor = survivorAt(i);
		if (survivor) return survivor;
	}
	for (let i = index - 1; i >= 0; i--) {
		const survivor = survivorAt(i);
		if (survivor) return survivor;
	}
	return undefined;
}

/** Visual rows of the description at `width` (hard-wrapped), at most five around the caret. */
function descriptionLines(value: LineState, width: number): { text: string; caret: number | undefined }[] {
	const rows: { text: string; caret: number | undefined }[] = [];
	let offset = 0;
	let caretRow = 0;
	for (const line of value.text.split("\n")) {
		const chunks: string[] = [];
		for (let start = 0; start < line.length || chunks.length === 0; start += width)
			chunks.push(line.slice(start, start + width));
		chunks.forEach((chunk, index) => {
			const start = offset + index * width;
			const last = index === chunks.length - 1;
			const end = start + chunk.length;
			const caret =
				value.cursor >= start && (value.cursor < end || (last && value.cursor === end))
					? value.cursor - start
					: undefined;
			if (caret !== undefined) caretRow = rows.length;
			rows.push({ text: chunk, caret });
		});
		offset += line.length + 1;
	}
	if (rows.length <= DESCRIPTION_ROWS) return rows;
	const top = Math.max(0, Math.min(caretRow - DESCRIPTION_ROWS + 1, rows.length - DESCRIPTION_ROWS));
	return rows.slice(top, top + DESCRIPTION_ROWS);
}
