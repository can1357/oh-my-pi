/**
 * Right sidebar of the git TUI.
 *
 * Dirty tree → file management: unstaged/staged sections with stage/unstage
 * actions plus a commit form (amend toggle, summary input, description
 * editor, commit button). Clean tree → HEAD commit view: subject, body,
 * author with avatar photo, parents, and the commit's file list.
 *
 * The sidebar is not a TUI component itself: the root composes its rendered
 * lines and forwards key/mouse input. Every rendered frame records a hit
 * target per row so mouse clicks resolve against what is actually visible.
 */
import {
	Editor,
	Image,
	type ImageBudget,
	Input,
	matchesKey,
	TERMINAL,
	truncateToWidth,
	visibleWidth,
} from "@oh-my-pi/pi-tui";
import type { ConventionalCommit } from "../../commit/types";
import { getEditorTheme, theme } from "../../modes/theme/theme";
import { type AvatarLoader, identiconLines } from "./avatar";
import { pill, selectionBgAnsi, softPill, tintChip, withBg } from "./colors";
import type { ChangedFile, GitModel } from "./state";

/** Actions the sidebar raises to the root component. */
export type SidebarAction =
	/** `selection` omitted → whole tree; `label` names the target for the status line. */
	| { type: "stage"; selection?: { files: ChangedFile[]; label: string } }
	| { type: "unstage"; selection?: { files: ChangedFile[]; label: string } }
	| { type: "generate" }
	| { type: "commit"; message: string; amend: boolean; stageAll: boolean };

type FileTarget = { kind: "file"; file: ChangedFile } | { kind: "dir"; key: string };
/** A foldable file-list section header (unstaged/staged). */
type SectionTarget = { kind: "section"; area: "unstaged" | "staged" };

type Target =
	| FileTarget
	| { kind: "view-style"; style: "path" | "tree" }
	| SectionTarget
	| { kind: "stage-all" }
	| { kind: "unstage-all" }
	| { kind: "amend" }
	| { kind: "summary" }
	| { kind: "description" }
	| { kind: "commit-button" };

interface Row {
	text?: string;
	/** File/dir rows are formatted only when they enter the viewport. */
	entry?: FileEntry;
	target?: Target;
	/** Column-scoped hit targets for rows carrying several buttons. */
	hits?: { from: number; to: number; target: Target }[];
}

const KIND_LETTER: Record<ChangedFile["kind"], string> = {
	modified: "M",
	added: "A",
	deleted: "D",
	renamed: "R",
	untracked: "?",
	conflicted: "U",
};

const KIND_COLOR: Record<ChangedFile["kind"], "warning" | "success" | "error" | "accent" | "muted"> = {
	modified: "warning",
	added: "success",
	deleted: "error",
	renamed: "accent",
	untracked: "muted",
	conflicted: "error",
};

const SUMMARY_LIMIT = 72;
/** Pure additions (new files) render as their own list below the tracked changes, unstaged section only. */
function isAddition(file: ChangedFile): boolean {
	return file.kind === "added" || file.kind === "untracked";
}
interface SplitFiles {
	changes: readonly ChangedFile[];
	additions: readonly ChangedFile[];
}

function targetKey(target: Target): string {
	if (target.kind === "file") return `file:${target.file.area}:${target.file.path}`;
	if (target.kind === "dir") return `dir:${target.key}`;
	if (target.kind === "section") return `section:${target.area}`;
	if (target.kind === "view-style") return `view:${target.style}`;
	return target.kind;
}
/** One rendered entry of a file section: nested dirs (tree mode) or flat files. */
interface FileEntry {
	target: FileTarget;
	/** Tree indentation depth; omitted in flat path mode. */
	depth?: number;
	file?: ChangedFile;
	/** Dir entries: display name (compressed chain) + collapse state. */
	dirName?: string;
	collapsed?: boolean;
}

interface TreeDir {
	name: string;
	dirs: Map<string, TreeDir>;
	files: ChangedFile[];
}

/** File row: status letter, dimmed directory, bright basename, +/− counts. */
function fileRowText(file: ChangedFile, width: number, selected: boolean, focused: boolean, depth?: number): string {
	// The unstaged additions list is homogeneous, so its rows carry no status letter.
	const bare = file.area === "unstaged" && isAddition(file);
	const prefix = bare ? "" : `${theme.fg(KIND_COLOR[file.kind], KIND_LETTER[file.kind])} `;
	const prefixWidth = bare ? 0 : 2;
	const slash = file.path.lastIndexOf("/");
	const dir = depth === undefined && slash >= 0 ? file.path.slice(0, slash + 1) : "";
	const base = slash >= 0 ? file.path.slice(slash + 1) : file.path;
	const indent = depth === undefined ? "" : " ".repeat(depth);
	let counts = "";
	if (file.additions !== undefined || file.deletions !== undefined) {
		const added = file.additions ? theme.fg("success", `+${file.additions}`) : "";
		const removed = file.deletions ? theme.fg("error", `−${file.deletions}`) : "";
		counts = [added, removed].filter(Boolean).join(" ");
	}
	const countsWidth = visibleWidth(counts);
	const pathBudget = width - 2 - prefixWidth - (countsWidth ? countsWidth + 1 : 0) - indent.length;
	let pathText: string;
	const full = dir + base;
	if (full.length <= pathBudget) {
		pathText = theme.fg("dim", dir) + base;
	} else {
		const tail = full.slice(Math.max(0, full.length - pathBudget + 1));
		pathText = theme.fg("dim", "…") + tail;
	}
	if (file.kind === "deleted") pathText = theme.strikethrough(pathText);
	const pad = Math.max(
		0,
		width - 2 - prefixWidth - visibleWidth(pathText) - (countsWidth ? countsWidth + 1 : 0) - indent.length,
	);
	const bar = selected ? theme.fg("accent", "▎") : " ";
	const line = `${bar}${indent}${prefix}${pathText}${" ".repeat(pad)}${countsWidth ? ` ${counts}` : ""}`;
	return selected && focused ? `${withBg(line, selectionBgAnsi())}\x1b[0m` : line;
}
/** Directory row in tree mode: chevron + compressed dir-chain name. */
function dirRowText(entry: FileEntry, width: number, selected: boolean, focused: boolean): string {
	const bar = selected ? theme.fg("accent", "▎") : " ";
	const chevron = entry.collapsed ? "▸" : "▾";
	const indent = " ".repeat(entry.depth ?? 0);
	const text = `${bar}${indent}${theme.fg("muted", chevron)}${theme.fg("dim", `${entry.dirName}/`)}`;
	const line = truncateToWidth(text + " ".repeat(Math.max(0, width - visibleWidth(text))), width);
	return selected && focused ? `${withBg(line, selectionBgAnsi())}\x1b[0m` : line;
}

/** Section header row: clicking the label toggles the fold; the action pill stages/unstages. */
function sectionHeaderRow(
	label: string,
	action: string,
	target: Target,
	pillTarget: Target,
	width: number,
	selected: boolean,
	focused: boolean,
): Row {
	const left = theme.bold(label);
	const right = softPill(` ${action} `, { active: true });
	const pad = Math.max(1, width - 2 - visibleWidth(left) - visibleWidth(right));
	const line = ` ${left}${" ".repeat(pad)}${right} `;
	const from = 1 + visibleWidth(left) + pad;
	return {
		text: selected && focused ? `${withBg(line, selectionBgAnsi())}\x1b[0m` : line,
		target,
		hits: [{ from, to: from + visibleWidth(right), target: pillTarget }],
	};
}

/** Sidebar state machine + renderer. */
export class Sidebar {
	readonly #model: GitModel;
	readonly #avatars: AvatarLoader;
	readonly #onSelectFile: (file: ChangedFile | null) => void;
	readonly #onAction: (action: SidebarAction) => void;
	readonly #onFocusDiff: () => void;
	readonly #requestRender: () => void;
	readonly summary = new Input();
	readonly description = new Editor(getEditorTheme());
	readonly #imageBudget: ImageBudget | undefined;
	focused = false;
	amend = false;
	generating = false;
	/** File-list presentation: flat paths or a collapsible directory tree. */
	viewStyle: "path" | "tree" = "tree";
	readonly #collapsed = new Set<string>();
	readonly #collapsedSections = new Set<SectionTarget["area"]>();
	#targets: Target[] = [];
	#treeVersion = 0;
	readonly #targetByKey = new Map<string, Target>();
	readonly #fileEntryCache = new Map<
		string,
		{
			files: readonly ChangedFile[];
			style: "path" | "tree";
			treeVersion: number;
			entries: FileEntry[];
			rows: Row[];
		}
	>();
	#targetSnapshot:
		| {
				clean: boolean;
				unstaged: readonly ChangedFile[];
				staged: readonly ChangedFile[];
				headFiles: readonly ChangedFile[] | undefined;
				style: "path" | "tree";
				treeVersion: number;
		  }
		| undefined;
	/** Tree depth per target key (file/dir rows only); parent-jump for `←`. */
	readonly #entryDepth = new Map<string, number>();
	/** Change/addition split per section, keyed on source array identity. */
	readonly #splitCache = new Map<string, { source: readonly ChangedFile[]; split: SplitFiles }>();
	#selectedKey: string | undefined;
	#scrollTop = 0;
	#visibleRows: (Row | undefined)[] = [];
	#lastWidth = 40;
	#lastHeight = 24;
	#avatarImage: { email: string; image: Image } | undefined;

	constructor(options: {
		model: GitModel;
		avatars: AvatarLoader;
		imageBudget?: ImageBudget;
		onSelectFile: (file: ChangedFile | null) => void;
		onAction: (action: SidebarAction) => void;
		onFocusDiff: () => void;
		requestRender: () => void;
	}) {
		this.#model = options.model;
		this.#avatars = options.avatars;
		this.#imageBudget = options.imageBudget;
		this.#onSelectFile = options.onSelectFile;
		this.#onAction = options.onAction;
		this.#onFocusDiff = options.onFocusDiff;
		this.#requestRender = options.requestRender;
		this.summary.prompt = "";
		this.description.setBorderVisible(false);
		this.description.setMaxHeight(5);
	}

	/** Currently selected target, if any. */
	get selected(): Target | undefined {
		if (this.#selectedKey === undefined) return this.#targets[0];
		return this.#targetByKey.get(this.#selectedKey) ?? this.#targets[0];
	}

	get selectedFile(): ChangedFile | null {
		const target = this.selected;
		return target?.kind === "file" ? target.file : null;
	}

	/** Re-sync selection after a model refresh; returns the file to show. */
	reconcile(): ChangedFile | null {
		const previousTargets = this.#targets;
		const previousKey = this.#selectedKey;
		this.#rebuildTargets();
		// Staging/unstaging removes the selected row from its section; land on
		// the nearest surviving file/dir row instead of falling back to the top.
		if (previousKey !== undefined && !this.#targetByKey.has(previousKey)) {
			const survivor = this.#nearestSurvivor(previousTargets, previousKey);
			if (survivor) this.#selectedKey = targetKey(survivor);
		}
		const target = this.selected;
		if (target) this.#selectedKey = targetKey(target);
		if (target?.kind === "file") return target.file;
		const firstFile = this.#targets.find(candidate => candidate.kind === "file");
		if (firstFile?.kind === "file" && (!target || target.kind === "section")) {
			return firstFile.file;
		}
		return firstFile?.kind === "file" ? firstFile.file : null;
	}
	/** Closest file/dir row (in previous display order) that still exists after a rebuild. */
	#nearestSurvivor(previousTargets: readonly Target[], previousKey: string): Target | undefined {
		const index = previousTargets.findIndex(target => targetKey(target) === previousKey);
		if (index < 0) return undefined;
		const survivorAt = (i: number): Target | undefined => {
			const candidate = previousTargets[i];
			if (candidate.kind !== "file" && candidate.kind !== "dir") return undefined;
			return this.#targetByKey.get(targetKey(candidate));
		};
		for (let i = index + 1; i < previousTargets.length; i++) {
			const survivor = survivorAt(i);
			if (survivor) return survivor;
		}
		for (let i = index - 1; i >= 0; i--) {
			const survivor = survivorAt(i);
			if (survivor) return survivor;
		}
		return undefined;
	}

	/** Tracked changes vs pure additions (unstaged only; other sections stay one list); memoized so entry caches stay identity-stable. */
	#splitFiles(section: string, files: readonly ChangedFile[]): SplitFiles {
		const cached = this.#splitCache.get(section);
		if (cached?.source === files) return cached.split;
		const split =
			section === "unstaged"
				? { changes: files.filter(file => !isAddition(file)), additions: files.filter(isAddition) }
				: { changes: files, additions: [] };
		this.#splitCache.set(section, { source: files, split });
		return split;
	}

	/** Section entries in display order: tree dirs + files, or flat files. */
	#fileEntries(files: readonly ChangedFile[], section: string): FileEntry[] {
		const cached = this.#fileEntryCache.get(section);
		if (cached?.files === files && cached.style === this.viewStyle && cached.treeVersion === this.#treeVersion) {
			return cached.entries;
		}

		let entries: FileEntry[];
		if (this.viewStyle === "path") {
			entries = files.map(file => ({ target: { kind: "file", file } as const, file }));
		} else {
			const root: TreeDir = { name: "", dirs: new Map(), files: [] };
			for (const file of files) {
				const parts = file.path.split("/");
				let node = root;
				for (const part of parts.slice(0, -1)) {
					let next = node.dirs.get(part);
					if (!next) {
						next = { name: part, dirs: new Map(), files: [] };
						node.dirs.set(part, next);
					}
					node = next;
				}
				node.files.push(file);
			}
			// Compress single-child directory chains ("a/b/c" as one row).
			const compress = (node: TreeDir): void => {
				for (const [key, child] of [...node.dirs]) {
					let merged = child;
					while (merged.files.length === 0 && merged.dirs.size === 1) {
						const [only] = merged.dirs.values();
						merged = { name: `${merged.name}/${only.name}`, dirs: only.dirs, files: only.files };
					}
					if (merged !== child) {
						node.dirs.delete(key);
						node.dirs.set(key, merged);
					}
					compress(merged);
				}
			};
			compress(root);
			entries = [];
			const walk = (node: TreeDir, depth: number, prefix: string): void => {
				for (const dir of [...node.dirs.values()].sort((a, b) => a.name.localeCompare(b.name))) {
					const key = `${section}:${prefix}${dir.name}`;
					const collapsed = this.#collapsed.has(key);
					entries.push({ target: { kind: "dir", key }, depth, dirName: dir.name, collapsed });
					if (!collapsed) walk(dir, depth + 1, `${prefix}${dir.name}/`);
				}
				for (const file of node.files) entries.push({ target: { kind: "file", file }, depth, file });
			};
			walk(root, 0, "");
		}
		this.#fileEntryCache.set(section, {
			files,
			style: this.viewStyle,
			treeVersion: this.#treeVersion,
			entries,
			rows: entries.map(entry => ({ entry, target: entry.target })),
		});
		return entries;
	}

	#rebuildTargets(): void {
		const headFiles = this.#model.headCommit?.files;
		const snapshot = this.#targetSnapshot;
		if (
			snapshot?.clean === this.#model.clean &&
			snapshot.unstaged === this.#model.unstaged &&
			snapshot.staged === this.#model.staged &&
			snapshot.headFiles === headFiles &&
			snapshot.style === this.viewStyle &&
			snapshot.treeVersion === this.#treeVersion
		) {
			return;
		}

		const targets: Target[] = [];
		this.#entryDepth.clear();
		this.#targetByKey.clear();
		const pushTarget = (target: Target): void => {
			targets.push(target);
			this.#targetByKey.set(targetKey(target), target);
		};
		const pushEntry = (entry: FileEntry): void => {
			this.#entryDepth.set(targetKey(entry.target), entry.depth ?? 0);
			pushTarget(entry.target);
		};
		const pushSection = (files: readonly ChangedFile[], section: string): void => {
			const { changes, additions } = this.#splitFiles(section, files);
			for (const entry of this.#fileEntries(changes, section)) pushEntry(entry);
			for (const entry of this.#fileEntries(additions, `${section}-added`)) pushEntry(entry);
		};
		if (this.#model.clean) {
			pushSection(headFiles ?? [], "commit");
		} else {
			pushTarget({ kind: "section", area: "unstaged" });
			if (!this.#collapsedSections.has("unstaged")) pushSection(this.#model.unstaged, "unstaged");
			pushTarget({ kind: "section", area: "staged" });
			if (!this.#collapsedSections.has("staged")) pushSection(this.#model.staged, "staged");
			pushTarget({ kind: "amend" });
			pushTarget({ kind: "summary" });
			pushTarget({ kind: "description" });
			pushTarget({ kind: "commit-button" });
		}
		this.#targets = targets;
		this.#targetSnapshot = {
			clean: this.#model.clean,
			unstaged: this.#model.unstaged,
			staged: this.#model.staged,
			headFiles,
			style: this.viewStyle,
			treeVersion: this.#treeVersion,
		};
	}

	#select(target: Target): void {
		this.#selectedKey = targetKey(target);
		this.summary.focused = this.focused && target.kind === "summary";
		this.description.focused = this.focused && target.kind === "description";
		if (target.kind === "file") this.#onSelectFile(target.file);
		this.#requestRender();
	}

	/** Called by the root when pane focus changes. */
	setFocused(focused: boolean): void {
		this.focused = focused;
		const target = this.selected;
		this.summary.focused = focused && target?.kind === "summary";
		this.description.focused = focused && target?.kind === "description";
	}

	#moveSelection(delta: number): void {
		if (this.#targets.length === 0) return;
		const current = this.selected;
		const index = current ? this.#targets.findIndex(target => targetKey(target) === targetKey(current)) : -1;
		const next = Math.max(0, Math.min(this.#targets.length - 1, index + delta));
		this.#select(this.#targets[next]);
	}

	#activate(target: Target): void {
		switch (target.kind) {
			case "file": {
				const action = this.#stageActionFor(target);
				if (action) this.#onAction(action);
				break;
			}
			case "dir": {
				if (this.#collapsed.has(target.key)) this.#collapsed.delete(target.key);
				else this.#collapsed.add(target.key);
				this.#treeVersion++;
				this.#requestRender();
				break;
			}
			case "view-style":
				this.viewStyle = target.style;
				this.#treeVersion++;
				this.#requestRender();
				break;
			case "section":
				this.#toggleSection(target.area);
				break;
			case "stage-all":
				this.#onAction({ type: "stage" });
				break;
			case "unstage-all":
				this.#onAction({ type: "unstage" });
				break;
			case "amend":
				this.#toggleAmend();
				break;
			case "summary":
			case "description":
				break;
			case "commit-button":
				this.#submitCommit();
				break;
		}
	}

	/** Stage/unstage action for a file, dir, or section-header row; dirs and sections batch every file underneath. */
	#stageActionFor(target: FileTarget | SectionTarget): SidebarAction | null {
		if (target.kind === "section") return target.area === "unstaged" ? { type: "stage" } : { type: "unstage" };
		if (target.kind === "file") {
			const selection = { files: [target.file], label: target.file.path };
			if (target.file.area === "unstaged") return { type: "stage", selection };
			if (target.file.area === "staged") return { type: "unstage", selection };
			return null;
		}
		// Dir keys are `<section>:<path from repo root>` (see #fileEntries).
		const sep = target.key.indexOf(":");
		const section = target.key.slice(0, sep);
		const inAdditions = section.endsWith("-added");
		const area = inAdditions ? section.slice(0, -"-added".length) : section;
		if (area !== "unstaged" && area !== "staged") return null;
		const dirPath = target.key.slice(sep + 1);
		const { changes, additions } = this.#splitFiles(
			area,
			area === "unstaged" ? this.#model.unstaged : this.#model.staged,
		);
		const files = (inAdditions ? additions : changes).filter(file => file.path.startsWith(`${dirPath}/`));
		if (files.length === 0) return null;
		const selection = { files, label: `${dirPath}/` };
		return area === "unstaged" ? { type: "stage", selection } : { type: "unstage", selection };
	}

	#toggleAmend(): void {
		this.amend = !this.amend;
		const head = this.#model.headCommit;
		if (this.amend && head && this.summary.getValue().length === 0 && this.description.getText().length === 0) {
			this.summary.setValue(head.subject);
			this.description.setText(head.body);
		}
		this.#requestRender();
	}

	#submitCommit(): void {
		const summary = this.summary.getValue().trim();
		const body = this.description.getText().trim();
		const stageAll = this.#model.staged.length === 0;
		if (stageAll && this.#model.unstaged.length === 0 && !this.amend) return;
		if (!summary) {
			if (!body) this.#onAction({ type: "generate" });
			return;
		}
		const message = body ? `${summary}\n\n${body}` : summary;
		this.#onAction({ type: "commit", message, amend: this.amend, stageAll });
	}

	/** Clear the commit form after a successful commit. */
	clearForm(): void {
		this.summary.setValue("");
		this.description.setText("");
		this.amend = false;
	}
	/** Replace the form with one generated conventional commit. */
	setGeneratedCommit(commit: ConventionalCommit): void {
		const scope = commit.scope ? `(${commit.scope})` : "";
		this.summary.setValue(`${commit.type}${scope}: ${commit.summary}`);
		this.description.setText(commit.body.map(detail => `- ${detail}`).join("\n"));
		this.#requestRender();
	}
	/** Reflect whether an inference request currently owns the commit form. */
	setGenerating(generating: boolean): void {
		this.generating = generating;
		this.#requestRender();
	}
	/** Escape while the sidebar has focus: blur a text input first. True when consumed. */
	handleEscape(): boolean {
		const target = this.selected;
		if (target?.kind === "summary" || target?.kind === "description") {
			this.#select({ kind: "commit-button" });
			return true;
		}
		return false;
	}
	/** True while a commit-form text input is capturing letter keys. */
	get editing(): boolean {
		const target = this.selected;
		return this.focused && (target?.kind === "summary" || target?.kind === "description");
	}

	/**
	 * Move selection to the next/previous visible file row. False at the
	 * boundary. `from` anchors the walk at the file currently shown in the
	 * diff pane, so hunk rollover works even when the sidebar selection sits
	 * on a dir row or a commit-form control.
	 */
	selectAdjacentFile(direction: 1 | -1, from?: ChangedFile | null): boolean {
		this.#rebuildTargets();
		let start = from
			? this.#targets.findIndex(
					target => target.kind === "file" && target.file.path === from.path && target.file.area === from.area,
				)
			: -1;
		if (start < 0) {
			const current = this.selected;
			start = current ? this.#targets.findIndex(target => targetKey(target) === targetKey(current)) : -1;
		}
		for (let i = start + direction; i >= 0 && i < this.#targets.length; i += direction) {
			const target = this.#targets[i];
			if (target.kind === "file") {
				this.#select(target);
				return true;
			}
		}
		return false;
	}

	/** Select the commit summary input (the `c` shortcut). False on a clean tree. */
	focusCommitForm(): boolean {
		this.#rebuildTargets();
		const summary = this.#targets.find(target => target.kind === "summary");
		if (!summary) return false;
		this.#select(summary);
		return true;
	}

	/** `←`: collapse an expanded dir, otherwise jump to the parent dir row. */
	#collapseOrParent(): void {
		const target = this.selected;
		if (target?.kind === "section" && !this.#collapsedSections.has(target.area)) {
			this.#toggleSection(target.area);
			return;
		}
		if (!target || (target.kind !== "file" && target.kind !== "dir")) return;
		if (target.kind === "dir" && !this.#collapsed.has(target.key)) {
			this.#collapsed.add(target.key);
			this.#treeVersion++;
			this.#requestRender();
			return;
		}
		const index = this.#targets.findIndex(candidate => targetKey(candidate) === targetKey(target));
		const depth = this.#entryDepth.get(targetKey(target)) ?? 0;
		for (let i = index - 1; i >= 0; i--) {
			const candidate = this.#targets[i];
			// Section headers/buttons bound the tree walk.
			if (candidate.kind !== "file" && candidate.kind !== "dir") return;
			if (candidate.kind === "dir" && (this.#entryDepth.get(targetKey(candidate)) ?? 0) < depth) {
				this.#select(candidate);
				return;
			}
		}
	}

	/** `→`: expand a collapsed dir, step into an expanded one, open a file. */
	#expandOrOpen(): void {
		const target = this.selected;
		if (target?.kind === "section") {
			if (this.#collapsedSections.has(target.area)) this.#toggleSection(target.area);
			else this.#moveSelection(1);
			return;
		}
		if (target?.kind === "dir") {
			if (this.#collapsed.has(target.key)) {
				this.#collapsed.delete(target.key);
				this.#treeVersion++;
				this.#requestRender();
			} else {
				this.#moveSelection(1);
			}
			return;
		}
		if (target?.kind === "file") this.#onFocusDiff();
	}
	/** Fold/unfold a whole section; hidden rows drop out of keyboard navigation. */
	#toggleSection(area: SectionTarget["area"]): void {
		if (!this.#collapsedSections.delete(area)) this.#collapsedSections.add(area);
		this.#treeVersion++;
		this.#requestRender();
	}

	handleInput(data: string): void {
		this.#rebuildTargets();
		const target = this.selected;

		if (target?.kind === "summary" && this.focused) {
			if (matchesKey(data, "up")) return this.#moveSelection(-1);
			if (matchesKey(data, "down") || matchesKey(data, "enter")) return this.#moveSelection(1);
			if (!matchesKey(data, "pageUp") && !matchesKey(data, "pageDown")) {
				this.summary.handleInput(data);
				this.#requestRender();
				return;
			}
		}
		if (target?.kind === "description" && this.focused) {
			const cursor = this.description.getCursor();
			const lineCount = this.description.getLines().length;
			if (matchesKey(data, "up") && cursor.line === 0) return this.#moveSelection(-1);
			if (matchesKey(data, "down") && cursor.line >= lineCount - 1) return this.#moveSelection(1);
			if (!matchesKey(data, "pageUp") && !matchesKey(data, "pageDown")) {
				this.description.handleInput(data);
				this.#requestRender();
				return;
			}
		}

		if (matchesKey(data, "up") || data === "k") this.#moveSelection(-1);
		else if (matchesKey(data, "down") || data === "j") this.#moveSelection(1);
		else if (matchesKey(data, "left") || data === "h") this.#collapseOrParent();
		else if (matchesKey(data, "right") || data === "l") this.#expandOrOpen();
		else if (matchesKey(data, "home") || data === "g") this.#moveSelection(-this.#targets.length);
		else if (matchesKey(data, "end") || data === "G") this.#moveSelection(this.#targets.length);
		else if (matchesKey(data, "pageUp")) this.#moveSelection(-Math.max(1, this.#lastHeight - 4));
		else if (matchesKey(data, "pageDown")) this.#moveSelection(Math.max(1, this.#lastHeight - 4));
		else if (matchesKey(data, "enter") && target) {
			// Enter opens a file (focus the diff); space/s/u do the staging.
			if (target.kind === "file") this.#onFocusDiff();
			else this.#activate(target);
		} else if (data === " " && (target?.kind === "file" || target?.kind === "dir" || target?.kind === "section")) {
			// Space stages/unstages the row — folders and section headers act on every file underneath.
			// Enter/click toggle dir/section collapse; ←/→ fold explicitly.
			const action = this.#stageActionFor(target);
			if (action) this.#onAction(action);
		} else if (
			(data === "s" || data === "u") &&
			(target?.kind === "file" || target?.kind === "dir" || target?.kind === "section")
		) {
			const action = this.#stageActionFor(target);
			if (action?.type === (data === "s" ? "stage" : "unstage")) this.#onAction(action);
		} else if (data === "t") {
			this.viewStyle = this.viewStyle === "path" ? "tree" : "path";
			this.#treeVersion++;
			this.#requestRender();
		}
	}

	/** Wheel scroll over the sidebar. */
	handleWheel(delta: number): void {
		this.#scrollTop = Math.max(0, this.#scrollTop + delta * 3);
		this.#requestRender();
	}

	/** Left click at sidebar-local coordinates. */
	handleClick(row: number, col: number): void {
		const visible = this.#visibleRows[row];
		if (!visible) return;
		const hit = visible.hits?.find(candidate => col >= candidate.from && col < candidate.to);
		const target = hit?.target ?? visible.target;
		if (!target) return;
		// Selection follows the row; column-scoped buttons (header pills) fire
		// their own action without stealing it.
		const selectTarget = visible.target ?? target;
		const wasSelected = this.selected && targetKey(this.selected) === targetKey(selectTarget);
		this.#select(selectTarget);
		if (target.kind !== "file" && target.kind !== "summary" && target.kind !== "description") {
			this.#activate(target);
		} else if (target.kind === "file" && wasSelected) {
			this.#activate(target);
		}
	}

	render(width: number, height: number): string[] {
		this.#lastWidth = width;
		this.#lastHeight = height;
		this.#rebuildTargets();
		const selected = this.selected;
		const selectedKey = selected ? targetKey(selected) : undefined;
		const isSelected = (target: Target): boolean => selectedKey === targetKey(target);

		const rows: Row[] = [];
		let pinned: Row[] = [];
		if (this.#model.clean) {
			rows.push(...this.#commitViewRows(width));
		} else {
			rows.push(...this.#changesHeaderRows(width));
			rows.push(...this.#fileListRows(width, isSelected));
			pinned = this.#commitFormRows(width, isSelected);
		}

		const listHeight = Math.max(1, height - pinned.length);
		// Keep the selected row inside the scrollable window.
		const selectedRow = rows.findIndex(row => row.target && selectedKey === targetKey(row.target));
		if (selectedRow >= 0) {
			if (selectedRow < this.#scrollTop) this.#scrollTop = selectedRow;
			if (selectedRow >= this.#scrollTop + listHeight) this.#scrollTop = selectedRow - listHeight + 1;
		}
		this.#scrollTop = Math.max(0, Math.min(this.#scrollTop, Math.max(0, rows.length - listHeight)));

		const lines: string[] = [];
		this.#visibleRows = [];
		for (let i = 0; i < listHeight; i++) {
			const row = rows[this.#scrollTop + i];
			lines.push(row ? truncateToWidth(this.#rowText(row, width, selectedKey), width) : "");
			this.#visibleRows.push(row);
		}
		for (const row of pinned) {
			lines.push(truncateToWidth(this.#rowText(row, width, selectedKey), width));
			this.#visibleRows.push(row);
		}
		return lines.slice(0, height);
	}
	/** Centered `Path | Tree` toggle row with column-scoped hit targets. */
	#viewToggleRow(width: number): Row {
		const nerd = theme.getSymbolPreset() === "nerd";
		const pathPill = softPill(` ${nerd ? "" : "☰"} Path `, { active: this.viewStyle === "path" });
		const treePill = softPill(` ${nerd ? "" : "└"} Tree `, { active: this.viewStyle === "tree" });
		const total = visibleWidth(pathPill) + 1 + visibleWidth(treePill);
		const left = Math.max(1, Math.floor((width - total) / 2));
		return {
			text: `${" ".repeat(left)}${pathPill} ${treePill}`,
			hits: [
				{ from: left, to: left + visibleWidth(pathPill), target: { kind: "view-style", style: "path" } },
				{
					from: left + visibleWidth(pathPill) + 1,
					to: left + total,
					target: { kind: "view-style", style: "tree" },
				},
			],
		};
	}

	#entryRows(files: readonly ChangedFile[], section: string): Row[] {
		const entries = this.#fileEntries(files, section);
		const cached = this.#fileEntryCache.get(section);
		return cached?.entries === entries ? cached.rows : entries.map(entry => ({ entry, target: entry.target }));
	}
	/** Section rows: tracked changes first, then pure additions as their own list below a rule. */
	#sectionRows(files: readonly ChangedFile[], section: string, width: number): Row[] {
		const { changes, additions } = this.#splitFiles(section, files);
		const changeRows = this.#entryRows(changes, section);
		if (additions.length === 0) return changeRows;
		const additionRows = this.#entryRows(additions, `${section}-added`);
		if (changeRows.length === 0) return additionRows;
		return [
			...changeRows,
			{ text: theme.fg("borderMuted", ` ${"─".repeat(Math.max(0, width - 2))}`) },
			...additionRows,
		];
	}

	#rowText(row: Row, width: number, selectedKey: string | undefined): string {
		const entry = row.entry;
		if (!entry) return row.text ?? "";
		const selected = selectedKey === targetKey(entry.target);
		if (entry.target.kind === "dir") return dirRowText(entry, width, selected, this.focused);
		return fileRowText(
			entry.target.file,
			width,
			selected,
			this.focused,
			this.viewStyle === "tree" ? entry.depth : undefined,
		);
	}

	#changesHeaderRows(width: number): Row[] {
		const total = this.#model.unstaged.length + this.#model.staged.length;
		const branch = this.#model.branch ? tintChip(` ${this.#model.branch} `, theme.getColorHex("accent")) : "";
		const label = theme.bold(`${total} file change${total === 1 ? "" : "s"} on `);
		return [
			{ text: ` ${label}${branch}` },
			this.#viewToggleRow(width),
			{ text: theme.fg("borderMuted", "─".repeat(Math.max(0, width))) },
		];
	}

	#fileListRows(width: number, isSelected: (target: Target) => boolean): Row[] {
		const rows: Row[] = [];
		const unstaged: SectionTarget = { kind: "section", area: "unstaged" };
		const unstagedFolded = this.#collapsedSections.has("unstaged");
		rows.push(
			sectionHeaderRow(
				`${unstagedFolded ? "▸" : "▾"} Unstaged Files (${this.#model.unstaged.length})`,
				"Stage All",
				unstaged,
				{ kind: "stage-all" },
				width,
				isSelected(unstaged),
				this.focused,
			),
		);
		if (!unstagedFolded) {
			rows.push(...this.#sectionRows(this.#model.unstaged, "unstaged", width));
			if (this.#model.unstaged.length === 0) rows.push({ text: theme.fg("dim", "   no unstaged files") });
		}
		rows.push({ text: "" });
		const staged: SectionTarget = { kind: "section", area: "staged" };
		const stagedFolded = this.#collapsedSections.has("staged");
		rows.push(
			sectionHeaderRow(
				`${stagedFolded ? "▸" : "▾"} Staged Files (${this.#model.staged.length})`,
				"Unstage All",
				staged,
				{ kind: "unstage-all" },
				width,
				isSelected(staged),
				this.focused,
			),
		);
		if (!stagedFolded) {
			rows.push(...this.#sectionRows(this.#model.staged, "staged", width));
			if (this.#model.staged.length === 0) rows.push({ text: theme.fg("dim", "   no staged files") });
		}
		return rows;
	}

	#commitFormRows(width: number, isSelected: (target: Target) => boolean): Row[] {
		const rows: Row[] = [];
		rows.push({ text: theme.fg("borderMuted", "─".repeat(Math.max(0, width))) });

		const amendTarget: Target = { kind: "amend" };
		const amendBox = this.amend ? theme.fg("accent", "▣") : theme.fg("muted", "☐");
		const amendLine = ` ${amendBox} Amend previous commit`;
		rows.push({
			text: isSelected(amendTarget) && this.focused ? `${withBg(amendLine, selectionBgAnsi())}\x1b[0m` : amendLine,
			target: amendTarget,
		});

		const summaryTarget: Target = { kind: "summary" };
		const summaryLen = this.summary.getValue().length;
		const counter = theme.fg(summaryLen > SUMMARY_LIMIT ? "warning" : "dim", String(SUMMARY_LIMIT - summaryLen));
		const summaryLabel = theme.fg("muted", "Commit summary");
		rows.push({
			text: ` ${summaryLabel}${" ".repeat(Math.max(1, width - 2 - visibleWidth(summaryLabel) - visibleWidth(counter)))}${counter}`,
		});
		const summaryLine = this.summary.render(width - 4)[0] ?? "";
		const summaryBar = isSelected(summaryTarget) ? theme.fg("accent", "▎") : theme.fg("borderMuted", "▏");
		rows.push({ text: ` ${summaryBar}${summaryLine}`, target: summaryTarget });

		const descriptionTarget: Target = { kind: "description" };
		const descriptionLines = this.description.render(width - 4);
		const descriptionBar = isSelected(descriptionTarget) ? theme.fg("accent", "▎") : theme.fg("borderMuted", "▏");
		if (this.description.getText().length === 0 && !this.description.focused) {
			rows.push({ text: ` ${descriptionBar}${theme.fg("dim", "Description")}`, target: descriptionTarget });
		} else {
			for (const line of descriptionLines.length > 0 ? descriptionLines : [""]) {
				rows.push({ text: ` ${descriptionBar}${line}`, target: descriptionTarget });
			}
		}
		rows.push({ text: "" });

		const commitTarget: Target = { kind: "commit-button" };
		const hasChanges = this.#model.staged.length > 0 || this.#model.unstaged.length > 0 || this.amend;
		const summary = this.summary.getValue().trim();
		const description = this.description.getText().trim();
		const canActivate = hasChanges && !this.generating && (summary.length > 0 || description.length === 0);
		const label = this.generating
			? "-○- Generating commit message"
			: this.#model.staged.length > 0
				? "-○- Commit staged changes"
				: "-○- Stage all & commit";
		const pad = Math.max(0, Math.floor((width - 4 - visibleWidth(label)) / 2));
		const inner = `${" ".repeat(pad)}${label}${" ".repeat(pad)}`;
		const button = pill(inner, theme.getColorHex("accent"), {
			dim: !canActivate,
			selected: canActivate && isSelected(commitTarget) && this.focused,
		});
		rows.push({ text: ` ${button}`, target: commitTarget });
		return rows;
	}

	#commitViewRows(width: number): Row[] {
		const rows: Row[] = [];
		const head = this.#model.headCommit;
		if (!head) {
			rows.push({ text: "" }, { text: theme.fg("dim", " No commits yet") });
			return rows;
		}
		for (const line of Bun.wrapAnsi(theme.bold(head.subject), width - 2).split("\n")) {
			rows.push({ text: ` ${line}` });
		}
		if (head.body) {
			rows.push({ text: "" });
			const bodyLines = Bun.wrapAnsi(head.body, width - 2)
				.split("\n")
				.slice(0, 8);
			for (const line of bodyLines) rows.push({ text: theme.fg("muted", ` ${line}`) });
		}
		rows.push({ text: "" });

		for (const line of this.#avatarRows(head.authorEmail)) rows.push({ text: ` ${line}` });
		rows.push({ text: ` ${theme.bold(head.authorName)} ${theme.fg("dim", `<${head.authorEmail}>`)}` });
		const when = head.authorDate ? new Date(head.authorDate) : null;
		if (when && !Number.isNaN(when.getTime())) {
			rows.push({ text: theme.fg("dim", ` authored ${when.toLocaleString()}`) });
		}
		if (head.parents.length > 0) {
			rows.push({
				text: ` ${theme.fg("dim", "parent:")} ${theme.fg("accent", head.parents.map(sha => sha.slice(0, 8)).join(" "))}`,
			});
		}
		rows.push({ text: theme.fg("borderMuted", "─".repeat(Math.max(0, width))) });
		if (!head.filesLoaded) {
			rows.push({ text: theme.fg("dim", " Loading changed files…") });
			return rows;
		}

		const additions = head.files.reduce((sum, file) => sum + (file.additions ?? 0), 0);
		const deletions = head.files.reduce((sum, file) => sum + (file.deletions ?? 0), 0);
		rows.push({
			text: ` ${theme.bold(`${head.files.length} modified`)}  ${theme.fg("success", `+${additions}`)} ${theme.fg("error", `−${deletions}`)} ${theme.fg("dim", `· ${head.shortSha}`)}`,
		});
		rows.push(this.#viewToggleRow(width));
		rows.push(...this.#sectionRows(head.files, "commit", width));
		return rows;
	}

	#avatarRows(email: string): string[] {
		const identicon = (): string[] =>
			identiconLines(email, (hex, text) => {
				const value = Number.parseInt(hex.replace("#", ""), 16);
				return `\x1b[38;2;${(value >> 16) & 0xff};${(value >> 8) & 0xff};${value & 0xff}m${text}\x1b[0m`;
			});
		if (!TERMINAL.imageProtocol) return identicon();
		const png = this.#avatars.get(email, this.#model.cwd);
		if (png === null || png === undefined) return identicon();
		if (this.#avatarImage?.email !== email) {
			this.#avatarImage = {
				email,
				image: new Image(
					png,
					"image/png",
					{ fallbackColor: text => theme.fg("dim", text) },
					{ maxHeightCells: 3, budget: this.#imageBudget, imageKey: `git-avatar:${email}` },
				),
			};
		}
		return [...this.#avatarImage.image.render(this.#lastWidth - 2)];
	}
}
