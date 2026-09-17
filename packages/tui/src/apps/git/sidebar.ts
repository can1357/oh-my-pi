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
import { Editor } from "../../components/editor";
import { FormField, type FormFieldTheme, TextFormField } from "../../components/form";
import { Image, type ImageBudget } from "../../components/image";
import { MenuSelection } from "../../components/menu-selection";
import { ScrollView } from "../../components/scroll-view";
import { TreeView } from "../../components/tree-view";
import { matchesKey } from "../../keys";
import { TERMINAL } from "../../terminal-capabilities";
import { truncateToWidth, visibleWidth } from "../../utils";
import { getEditorTheme, theme } from "../../theme/theme";
import { type AvatarSource, identiconLines } from "./avatar";
import { pill, selectionBgAnsi, softPill, tintChip, withBg } from "./colors";
import type { ChangedFile, GitViewState } from "./state";

/** Generated conventional commit fields shown in the commit form. */
export interface GitCommitMessage {
	type: string;
	scope?: string | null;
	summary: string;
	body: readonly string[];
}

/** Actions the sidebar raises to the root component. */
export type SidebarAction =
	/** `selection` omitted → whole tree; `label` names the target for the status line. */
	| { type: "stage"; selection?: { files: ChangedFile[]; label: string } }
	| { type: "unstage"; selection?: { files: ChangedFile[]; label: string } }
	/** `delete`: throw away the row's changes (a dir batches every file underneath). */
	| { type: "discard"; selection: { files: ChangedFile[]; label: string } }
	| { type: "generate" }
	/** Wand pill: AI-filter the unstaged tree against a natural-language prompt. */
	| { type: "stage-ai"; prompt: string }
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
	| { kind: "stage-ai" }
	| { kind: "stage-ai-input" }
	| { kind: "amend" }
	| { kind: "summary" }
	| { kind: "description" }
	| { kind: "commit-button" };

interface Row {
	text?: string;
	/** File/dir rows are formatted only when they enter the viewport. */
	entry?: SidebarFileEntry;
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

const SIDEBAR_FORM_THEME: FormFieldTheme = {
	label: text => theme.fg("muted", text),
	description: text => theme.fg("dim", text),
	error: text => theme.fg("error", text),
	hint: text => theme.fg("dim", text),
};

function targetKey(target: Target): string {
	if (target.kind === "file") return `file:${target.file.area}:${target.file.path}`;
	if (target.kind === "dir") return `dir:${target.key}`;
	if (target.kind === "section") return `section:${target.area}`;
	if (target.kind === "view-style") return `view:${target.style}`;
	return target.kind;
}
/** One rendered entry of a file section: nested dirs (tree mode) or flat files. */
interface SidebarFileEntry {
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

type GitTreeNode =
	| { kind: "dir"; key: string; name: string; children: GitTreeNode[] }
	| { kind: "file"; key: string; file: ChangedFile };

class GitFileTree {
	readonly #roots: GitTreeNode[] = [];
	readonly #tree: TreeView<GitTreeNode, string>;
	readonly #section: string;
	readonly #collapsed: ReadonlySet<string>;
	#files: readonly ChangedFile[] | undefined;
	#version = -1;
	#entries: SidebarFileEntry[] = [];

	constructor(section: string, collapsed: ReadonlySet<string>) {
		this.#section = section;
		this.#collapsed = collapsed;
		this.#tree = new TreeView({
			roots: this.#roots,
			getKey: node => node.key,
			getChildren: node => (node.kind === "dir" ? node.children : []),
			isExpanded: node => node.kind !== "dir" || !this.#collapsed.has(node.key),
			theme,
			renderRow: node => (node.kind === "dir" ? `${node.name}/` : node.file.path),
		});
	}

	entries(files: readonly ChangedFile[], version: number): SidebarFileEntry[] {
		if (files !== this.#files) {
			this.#files = files;
			this.#roots.splice(0, this.#roots.length, ...this.#buildNodes(files));
			this.#tree.invalidate();
			this.#version = version;
		} else if (version !== this.#version) {
			this.#tree.invalidate();
			this.#version = version;
		} else {
			return this.#entries;
		}

		this.#entries = this.#tree.rows.map(row =>
			row.item.kind === "dir"
				? {
						target: { kind: "dir", key: row.item.key },
						depth: row.depth,
						dirName: row.item.name,
						collapsed: this.#collapsed.has(row.item.key),
					}
				: { target: { kind: "file", file: row.item.file }, depth: row.depth, file: row.item.file },
		);
		return this.#entries;
	}

	dispose(): void {
		this.#tree.dispose();
	}

	#buildNodes(files: readonly ChangedFile[]): GitTreeNode[] {
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

		const compress = (node: TreeDir): void => {
			for (const [key, child] of Array.from(node.dirs)) {
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

		const children = (node: TreeDir, prefix: string): GitTreeNode[] => [
			...[...node.dirs.values()]
				.sort((left, right) => left.name.localeCompare(right.name))
				.map(dir => {
					const path = `${prefix}${dir.name}`;
					return {
						kind: "dir" as const,
						key: `${this.#section}:${path}`,
						name: dir.name,
						children: children(dir, `${path}/`),
					};
				}),
			...node.files.map(file => ({
				kind: "file" as const,
				key: `file:${file.area}:${file.path}`,
				file,
			})),
		];
		return children(root, "");
	}
}

/** File row: status letter, dimmed directory, bright basename, +/− counts. */
function fileRowText(file: ChangedFile, width: number, selected: boolean, focused: boolean, depth?: number): string {
	const prefix = `${theme.fg(KIND_COLOR[file.kind], KIND_LETTER[file.kind])} `;
	const prefixWidth = 2;
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
function dirRowText(entry: SidebarFileEntry, width: number, selected: boolean, focused: boolean): string {
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
	pills: readonly { action: string; target: Target }[],
	target: Target,
	width: number,
	selected: boolean,
	focused: boolean,
): Row {
	const left = theme.bold(label);
	const rendered = pills.map(pill => softPill(` ${pill.action} `, { active: true }));
	const rightWidth = rendered.reduce((sum, text) => sum + visibleWidth(text), 0) + Math.max(0, rendered.length - 1);
	const pad = Math.max(1, width - 2 - visibleWidth(left) - rightWidth);
	let line = ` ${left}${" ".repeat(pad)}`;
	let col = 1 + visibleWidth(left) + pad;
	const hits: Row["hits"] = [];
	rendered.forEach((text, index) => {
		if (index > 0) {
			line += " ";
			col += 1;
		}
		hits.push({ from: col, to: col + visibleWidth(text), target: pills[index].target });
		line += text;
		col += visibleWidth(text);
	});
	line += " ";
	return {
		text: selected && focused ? `${withBg(line, selectionBgAnsi())}\x1b[0m` : line,
		target,
		hits,
	};
}

/** Sidebar state machine + renderer. */
export class Sidebar {
	readonly #model: GitViewState;
	readonly #avatars: AvatarSource;
	readonly #onSelectFile: (file: ChangedFile | null) => void;
	readonly #onAction: (action: SidebarAction) => void;
	readonly #onFocusDiff: () => void;
	readonly #requestRender: () => void;
	readonly summary: TextFormField;
	readonly description = new Editor(getEditorTheme());
	readonly #descriptionField: FormField;
	/** "What should we stage?" textbox opened by the unstaged-header wand pill. */
	readonly aiInput: TextFormField;
	readonly #imageBudget: ImageBudget | undefined;
	focused = false;
	amend = false;
	generating = false;
	#aiPromptOpen = false;
	/** File-list presentation: flat paths or a collapsible directory tree. */
	viewStyle: "path" | "tree" = "tree";
	readonly #collapsed = new Set<string>();
	readonly #collapsedSections = new Set<SectionTarget["area"]>();
	readonly #selection = new MenuSelection<Target>([], { getKey: targetKey, getSearchText: targetKey });
	#treeVersion = 0;
	readonly #targetByKey = new Map<string, Target>();
	readonly #fileEntryCache = new Map<
		string,
		{
			files: readonly ChangedFile[];
			style: "path" | "tree";
			treeVersion: number;
			entries: SidebarFileEntry[];
			rows: Row[];
		}
	>();
	readonly #fileTrees = new Map<string, GitFileTree>();
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
	readonly #scrollView = new ScrollView([], { height: 1, totalRows: 0, scrollbar: "never" });
	/** One-shot: the next render scrolls the selected row into view. Set on
	 * explicit selection changes so wheel scrolling can roam freely. */
	#followSelection = false;
	#visibleRows: (Row | undefined)[] = [];
	#lastWidth = 40;
	#lastHeight = 24;
	#avatarImage: { email: string; image: Image } | undefined;

	constructor(options: {
		model: GitViewState;
		avatars: AvatarSource;
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
		this.summary = new TextFormField({
			theme: SIDEBAR_FORM_THEME,
			prompt: "",
			spaceBeforeControl: false,
			spaceAfterControl: false,
			onSubmit: () => this.#moveSelection(1),
			onCancel: () => this.#select({ kind: "commit-button" }),
		});
		this.aiInput = new TextFormField({
			theme: SIDEBAR_FORM_THEME,
			prompt: "",
			spaceBeforeControl: false,
			spaceAfterControl: false,
			onSubmit: value => {
				const prompt = value.trim();
				if (prompt.length === 0) return;
				this.#closeAiPrompt();
				this.#select({ kind: "section", area: "unstaged" });
				this.#onAction({ type: "stage-ai", prompt });
			},
			onCancel: () => {
				this.#closeAiPrompt();
				this.#select({ kind: "section", area: "unstaged" });
			},
		});
		this.description.setBorderVisible(false);
		this.description.setMaxHeight(5);
		this.#descriptionField = new FormField(this.description, {
			theme: SIDEBAR_FORM_THEME,
			spaceBeforeControl: false,
			spaceAfterControl: false,
		});
	}

	/** Currently selected target, if any. */
	get selected(): Target | undefined {
		return this.#selection.selectedItem ?? this.#selection.visibleItems[0] ?? this.#selection.items[0];
	}

	get selectedFile(): ChangedFile | null {
		const target = this.selected;
		return target?.kind === "file" ? target.file : null;
	}

	/** Re-sync selection after a model refresh; returns the file to show. */
	reconcile(): ChangedFile | null {
		const previousTargets = this.#selection.items;
		const previousKey = this.#selection.selectedKey;
		this.#rebuildTargets();
		// Staging/unstaging removes the selected row from its section; land on
		// the nearest surviving file/dir row instead of falling back to the top.
		if (previousKey !== undefined && !this.#targetByKey.has(previousKey)) {
			const survivor = this.#nearestSurvivor(previousTargets, previousKey);
			if (survivor) this.#selection.setSelectedKey(targetKey(survivor));
		}
		const target = this.selected;
		if (this.#selection.selectedKey !== previousKey) this.#followSelection = true;
		if (target?.kind === "file") return target.file;
		const firstFile = this.#selection.items.find(candidate => candidate.kind === "file");
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

	/** Section entries in display order: tree dirs + files, or flat files. */
	#fileEntries(files: readonly ChangedFile[], section: string): SidebarFileEntry[] {
		const cached = this.#fileEntryCache.get(section);
		if (cached?.files === files && cached.style === this.viewStyle && cached.treeVersion === this.#treeVersion) {
			return cached.entries;
		}

		let entries: SidebarFileEntry[];
		if (this.viewStyle === "path") {
			entries = files.map(file => ({ target: { kind: "file", file } as const, file }));
		} else {
			let fileTree = this.#fileTrees.get(section);
			if (!fileTree) {
				fileTree = new GitFileTree(section, this.#collapsed);
				this.#fileTrees.set(section, fileTree);
			}
			entries = fileTree.entries(files, this.#treeVersion);
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
		const pushEntry = (entry: SidebarFileEntry): void => {
			this.#entryDepth.set(targetKey(entry.target), entry.depth ?? 0);
			pushTarget(entry.target);
		};
		const pushSection = (files: readonly ChangedFile[], section: string): void => {
			for (const entry of this.#fileEntries(files, section)) pushEntry(entry);
		};
		if (this.#model.clean) {
			pushSection(headFiles ?? [], "commit");
		} else {
			pushTarget({ kind: "section", area: "unstaged" });
			if (this.#aiPromptOpen) pushTarget({ kind: "stage-ai-input" });
			if (!this.#collapsedSections.has("unstaged")) pushSection(this.#model.unstaged, "unstaged");
			pushTarget({ kind: "section", area: "staged" });
			if (!this.#collapsedSections.has("staged")) pushSection(this.#model.staged, "staged");
			pushTarget({ kind: "amend" });
			pushTarget({ kind: "summary" });
			pushTarget({ kind: "description" });
			pushTarget({ kind: "commit-button" });
		}
		const retainKey = this.#selection.selectedKey;
		this.#selection.setItems(targets, retainKey);
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
		const key = targetKey(target);
		if (this.#selection.items.some(item => targetKey(item) === key)) this.#selection.setSelectedKey(key);
		else this.#selection.setSelectedIndex(0);
		this.#followSelection = true;
		this.summary.focused = this.focused && target.kind === "summary";
		this.#descriptionField.focused = this.focused && target.kind === "description";
		this.aiInput.focused = this.focused && target.kind === "stage-ai-input";
		if (target.kind === "file") this.#onSelectFile(target.file);
		this.#requestRender();
	}

	/** Called by the root when pane focus changes. */
	setFocused(focused: boolean): void {
		this.focused = focused;
		const target = this.selected;
		this.summary.focused = focused && target?.kind === "summary";
		this.#descriptionField.focused = focused && target?.kind === "description";
		this.aiInput.focused = focused && target?.kind === "stage-ai-input";
	}

	#moveSelection(delta: number): void {
		if (this.#selection.items.length === 0) return;
		if (!this.#selection.move(delta, false)) return;
		const current = this.#selection.selectedItem;
		if (current) this.#select(current);
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
			case "stage-ai":
				this.#openAiPrompt();
				break;
			case "stage-ai-input":
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
		const selected = this.#selectionFor(target);
		if (!selected) return null;
		const { area, ...selection } = selected;
		return area === "unstaged" ? { type: "stage", selection } : { type: "unstage", selection };
	}

	/** Discard action for a file or dir row; null on a commit-area row. */
	#discardActionFor(target: FileTarget): SidebarAction | null {
		const selected = this.#selectionFor(target);
		if (!selected) return null;
		return { type: "discard", selection: { files: selected.files, label: selected.label } };
	}

	/** Files under a file/dir row plus a status-line label; null outside the unstaged/staged sections. */
	#selectionFor(target: FileTarget): { files: ChangedFile[]; label: string; area: "unstaged" | "staged" } | null {
		if (target.kind === "file") {
			const area = target.file.area;
			if (area !== "unstaged" && area !== "staged") return null;
			return { files: [target.file], label: target.file.path, area };
		}
		// Dir keys are `<section>:<path from repo root>` (see #fileEntries).
		const sep = target.key.indexOf(":");
		const area = target.key.slice(0, sep);
		if (area !== "unstaged" && area !== "staged") return null;
		const dirPath = target.key.slice(sep + 1);
		const files = (area === "unstaged" ? this.#model.unstaged : this.#model.staged).filter(file =>
			file.path.startsWith(`${dirPath}/`),
		);
		if (files.length === 0) return null;
		return { files, label: `${dirPath}/`, area };
	}

	/** Open the AI staging textbox under the unstaged header and focus it. */
	#openAiPrompt(): void {
		this.#aiPromptOpen = true;
		this.#treeVersion++;
		this.#rebuildTargets();
		this.#select({ kind: "stage-ai-input" });
	}

	#closeAiPrompt(): void {
		this.#aiPromptOpen = false;
		this.aiInput.setValue("");
		this.#treeVersion++;
		this.#requestRender();
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
	setGeneratedCommit(commit: GitCommitMessage): void {
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
		if (target?.kind === "stage-ai-input") {
			this.#closeAiPrompt();
			this.#select({ kind: "section", area: "unstaged" });
			return true;
		}
		if (target?.kind === "summary" || target?.kind === "description") {
			this.#select({ kind: "commit-button" });
			return true;
		}
		return false;
	}
	/** True while a commit-form text input is capturing letter keys. */
	get editing(): boolean {
		const target = this.selected;
		return (
			this.focused &&
			(target?.kind === "summary" || target?.kind === "description" || target?.kind === "stage-ai-input")
		);
	}

	/**
	 * Move selection to the next/previous visible file row. False at the
	 * boundary. `from` anchors the walk at the file currently shown in the
	 * diff pane, so hunk rollover works even when the sidebar selection sits
	 * on a dir row or a commit-form control.
	 */
	selectAdjacentFile(direction: 1 | -1, from?: ChangedFile | null): boolean {
		this.#rebuildTargets();
		const items = this.#selection.items;
		let start = from
			? items.findIndex(
					target => target.kind === "file" && target.file.path === from.path && target.file.area === from.area,
				)
			: -1;
		if (start < 0) {
			const current = this.selected;
			start = current ? items.findIndex(target => targetKey(target) === targetKey(current)) : -1;
		}
		for (let i = start + direction; i >= 0 && i < items.length; i += direction) {
			const target = items[i];
			if (target?.kind === "file") {
				this.#select(target);
				return true;
			}
		}
		return false;
	}

	/** Select the commit summary input (the `c` shortcut). False on a clean tree. */
	focusCommitForm(): boolean {
		this.#rebuildTargets();
		const summary = this.#selection.items.find(target => target.kind === "summary");
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
		const items = this.#selection.items;
		const index = items.findIndex(candidate => targetKey(candidate) === targetKey(target));
		const depth = this.#entryDepth.get(targetKey(target)) ?? 0;
		for (let i = index - 1; i >= 0; i--) {
			const candidate = items[i];
			// Section headers/buttons bound the tree walk.
			if (!candidate || (candidate.kind !== "file" && candidate.kind !== "dir")) return;
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

		if (target?.kind === "stage-ai-input" && this.focused) {
			if (matchesKey(data, "up")) return this.#moveSelection(-1);
			if (matchesKey(data, "down")) return this.#moveSelection(1);
			if (!matchesKey(data, "pageUp") && !matchesKey(data, "pageDown")) {
				this.aiInput.handleInput(data);
				this.#requestRender();
				return;
			}
		}

		if (target?.kind === "summary" && this.focused) {
			if (matchesKey(data, "up")) return this.#moveSelection(-1);
			if (matchesKey(data, "down")) return this.#moveSelection(1);
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
				this.#descriptionField.handleInput(data);
				this.#requestRender();
				return;
			}
		}

		if (matchesKey(data, "up") || data === "k") this.#moveSelection(-1);
		else if (matchesKey(data, "down") || data === "j") this.#moveSelection(1);
		else if (matchesKey(data, "left") || data === "h") this.#collapseOrParent();
		else if (matchesKey(data, "right") || data === "l") this.#expandOrOpen();
		else if (matchesKey(data, "home") || data === "g") this.#moveSelection(-this.#selection.items.length);
		else if (matchesKey(data, "end") || data === "G") this.#moveSelection(this.#selection.items.length);
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
		} else if (matchesKey(data, "delete") && (target?.kind === "file" || target?.kind === "dir")) {
			const action = this.#discardActionFor(target);
			if (action) this.#onAction(action);
		} else if (data === "t") {
			this.viewStyle = this.viewStyle === "path" ? "tree" : "path";
			this.#treeVersion++;
			this.#requestRender();
		}
	}

	/** Wheel scroll over the sidebar. */
	handleWheel(delta: number): void {
		this.#scrollView.scroll(delta * 3);
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
		this.#scrollView.setHeight(listHeight);
		this.#scrollView.setTotalRows(rows.length);
		// Scroll the selected row into view only after an explicit selection
		// change; unconditional following would snap wheel scrolling back to
		// the selection on every render.
		if (this.#followSelection) {
			this.#followSelection = false;
			const selectedRow = rows.findIndex(row => row.target && selectedKey === targetKey(row.target));
			if (selectedRow >= 0) this.#scrollView.setActiveRow(selectedRow);
			this.#scrollView.setActiveRow(undefined);
		}
		const { start, end } = this.#scrollView.getVisibleRange();

		this.#visibleRows = [];
		const windowed: string[] = [];
		for (let i = 0; i < listHeight; i++) {
			const row = i < end - start ? rows[start + i] : undefined;
			windowed.push(row ? truncateToWidth(this.#rowText(row, width, selectedKey), width) : "");
			this.#visibleRows.push(row);
		}
		this.#scrollView.setLines(windowed);
		const lines = [...this.#scrollView.render(width)];
		for (const row of pinned) {
			lines.push(truncateToWidth(this.#rowText(row, width, selectedKey), width));
			this.#visibleRows.push(row);
		}
		return lines.slice(0, height);
	}

	/** Permanently release viewport, form, and avatar resources. */
	dispose(): void {
		this.#scrollView.dispose();
		this.summary.dispose();
		this.aiInput.dispose();
		this.#descriptionField.dispose();
		for (const tree of this.#fileTrees.values()) tree.dispose();
		this.#fileTrees.clear();
		this.#avatarImage = undefined;
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
		const wand = theme.getSymbolPreset() === "nerd" ? "" : "✦";
		rows.push(
			sectionHeaderRow(
				`${unstagedFolded ? "▸" : "▾"} Unstaged Files (${this.#model.unstaged.length})`,
				[
					{ action: "Stage All", target: { kind: "stage-all" } },
					{ action: wand, target: { kind: "stage-ai" } },
				],
				unstaged,
				width,
				isSelected(unstaged),
				this.focused,
			),
		);
		if (this.#aiPromptOpen) rows.push(this.#aiPromptRow(width, isSelected));
		if (!unstagedFolded) {
			rows.push(...this.#entryRows(this.#model.unstaged, "unstaged"));
			if (this.#model.unstaged.length === 0) rows.push({ text: theme.fg("dim", "   no unstaged files") });
		}
		rows.push({ text: "" });
		const staged: SectionTarget = { kind: "section", area: "staged" };
		const stagedFolded = this.#collapsedSections.has("staged");
		rows.push(
			sectionHeaderRow(
				`${stagedFolded ? "▸" : "▾"} Staged Files (${this.#model.staged.length})`,
				[{ action: "Unstage All", target: { kind: "unstage-all" } }],
				staged,
				width,
				isSelected(staged),
				this.focused,
			),
		);
		if (!stagedFolded) {
			rows.push(...this.#entryRows(this.#model.staged, "staged"));
			if (this.#model.staged.length === 0) rows.push({ text: theme.fg("dim", "   no staged files") });
		}
		return rows;
	}
	/** Inline "What should we stage?" textbox under the unstaged header. */
	#aiPromptRow(width: number, isSelected: (target: Target) => boolean): Row {
		const target: Target = { kind: "stage-ai-input" };
		const bar = isSelected(target) ? theme.fg("accent", "▎") : theme.fg("borderMuted", "▏");
		const line =
			this.aiInput.getValue().length === 0 && !this.aiInput.focused
				? theme.fg("dim", "What should we stage?")
				: (this.aiInput.render(width - 4)[0] ?? "");
		return { text: ` ${bar}${line}`, target };
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
		const descriptionLines = this.#descriptionField.render(width - 4);
		const descriptionBar = isSelected(descriptionTarget) ? theme.fg("accent", "▎") : theme.fg("borderMuted", "▏");
		if (this.description.getText().length === 0 && !this.#descriptionField.focused) {
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
		rows.push(...this.#entryRows(head.files, "commit"));
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
