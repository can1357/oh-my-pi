/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * The session tree (`/tree`): every entry of the session as a `tree` picker,
 * the branch holding the current leaf first, filter tabs (default, no tools,
 * user only, labeled, all) and fuzzy search over entry text. Enter switches
 * to the selected entry (Shift+Enter summarizes the abandoned branch first);
 * Shift+L labels it (the label editor takes the preview pane).
 */
import { batch, computed, type JSXNode, type KeyEvent, signal } from "@oh-my-pi/pi-tui";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import type { TspPickerAction, TspPickerItem, TspSpan, TspText } from "@oh-my-pi/pi-wire";
import {
	advisorLabel,
	advisorTreeDisplay,
	collectToolCalls,
	entrySearchText,
	formatToolCall,
	joinTextContent,
	modelUsageLabel,
	SEARCH_TEXT_LIMIT,
	sanitizeTreeField,
	serviceTierLabel,
	stripSystemWrapperTags,
	type TreeToolCall,
} from "../../../modes/view-model/overlays/tree-entry-labels";
import { isUserRequestEntry, type TranscriptEntryLike } from "../../../session/transcript/transcript-entry";
import { resolveAssistantErrorPresentation } from "../../../session/transcript/transcript-render-helpers";
import { fuzzyMatch } from "../../../utils/fuzzy";
import { replaceTabs } from "../../../utils/text-width";
import "../../styles/pickers/tree";
import type { TreeLookRow, TreeLookTerm } from "../../styles/pickers/tree";
import { editLine, type LineState } from "../settings/line-edit";
import { getKeybindings } from "../../../config/keybindings/keybindings";
import { matchesAppInterrupt, matchesSelectCancel, selectKeyId } from "../../../config/keybindings/matchers";
import { collectBlocks, type Target, targetCopy, turnPreview } from "./copy-selector";
import { closeAction, PICKER_KEY, pickerAction } from "./select-sheet";
import { confirmKbd } from "../../keys/hints";

/** Session-tree display filters. */
export const TREE_FILTER_MODES = ["default", "no-tools", "user-only", "labeled-only", "all"] as const;
export type TreeFilterMode = (typeof TREE_FILTER_MODES)[number];

/** A persisted session entry as the tree shows it. */
export type SessionTreeEntry = { id: string; parentId: string | null } & (
	| TranscriptEntryLike
	| { type: "compaction"; tokensBefore: number }
	| { type: "branch_summary"; summary: string }
	| { type: "model_change"; model: string }
	| { type: "thinking_level_change"; thinkingLevel?: string | null }
	| { type: "custom"; customType: string }
	| { type: "label"; label?: string }
	| { type: "title_change"; title: string }
	| { type: "mode_change"; mode: string }
	| { type: string }
);

/** One node of the session tree. */
export interface TreeSelectorNode {
	entry: SessionTreeEntry;
	children: TreeSelectorNode[];
	label?: string;
}

export interface TreeSelectorProps {
	readonly roots: readonly TreeSelectorNode[];
	/** The session's current leaf. */
	readonly currentLeafId: string | null;
	/** Terminal rows: the list pages by about half of them. */
	readonly terminalHeight: number;
	onSelect(entryId: string, options: { summarize: boolean }): void;
	onCancel(): void;
	onLabelChange?(entryId: string, label: string | undefined): void;
	readonly initialFilterMode?: TreeFilterMode;
	/** The sheet's subtitle. */
	readonly sessionName?: string;
}

const FILTER_TABS = [
	{ id: "default", label: "Default" },
	{ id: "no-tools", label: "No tools" },
	{ id: "user-only", label: "User only" },
	{ id: "labeled-only", label: "Labeled" },
	{ id: "all", label: "All" },
] as const;
const FILTER_LABELS: Readonly<Record<TreeFilterMode, string>> = {
	default: "[default]",
	"no-tools": "[no-tools]",
	"user-only": "[user]",
	"labeled-only": "[labeled]",
	all: "[all]",
};
const FILTER_KEYS: Readonly<Record<string, TreeFilterMode>> = {
	"alt+d": "default",
	"alt+t": "no-tools",
	"alt+u": "user-only",
	"alt+l": "labeled-only",
	"alt+a": "all",
};
/** Bookkeeping entries the default view hides. */
const SETTINGS_ENTRIES: Readonly<Record<string, true>> = {
	label: true,
	custom: true,
	model_change: true,
	model_usage: true,
	thinking_level_change: true,
	service_tier_change: true,
	title_change: true,
	credential_pin: true,
	session_init: true,
	ttsr_injection: true,
	mode_change: true,
	reset_boundary: true,
};

/** A part of an entry's row text. */
interface EntryPart {
	readonly t: string;
	readonly s?: string;
	readonly strong?: boolean;
}

interface MessageLike {
	role: string;
	content?: unknown;
	stopReason?: string;
	toolCallId?: string;
	toolName?: string;
	command?: string;
}

function messageOf(entry: SessionTreeEntry): MessageLike | undefined {
	return entry.type === "message" && "message" in entry ? (entry.message as MessageLike) : undefined;
}

const normalize = (text: string): string => text.replace(/[\n\t]/g, " ").trim();
/** Text for a single-line row or header: line breaks fold to spaces, escapes and controls go, tabs expand. */
const rowText = (text: string): string => replaceTabs(sanitizeText(text.replace(/[\r\n\u2028\u2029]/g, " ")));

/** An entry's row text as styled parts; a tool result is named by its call in `toolCalls`. */
function entryParts(entry: SessionTreeEntry, toolCalls: ReadonlyMap<string, TreeToolCall>): EntryPart[] {
	const message = messageOf(entry);
	if (message) {
		const content = normalize(joinTextContent(message.content, SEARCH_TEXT_LIMIT));
		switch (message.role) {
			case "user":
				return [
					{ t: "user: ", s: "accent", strong: true },
					{ t: content, s: "accent", strong: true },
				];
			case "developer":
				return [
					{ t: "developer: ", s: "dim" },
					{ t: content, s: "muted" },
				];
			case "assistant": {
				const head: EntryPart = { t: "assistant: ", s: "success" };
				const presentation = resolveAssistantErrorPresentation(
					message as Extract<AgentMessage, { role: "assistant" }>,
				);
				if (presentation.kind === "compact-recovered") return [head, { t: presentation.text, s: "dim" }];
				if (content) return [head, { t: content }];
				if (presentation.kind === "full") {
					return [head, { t: normalize(presentation.text).slice(0, 80), s: "error" }];
				}
				if (message.stopReason === "aborted") return [head, { t: "(aborted)", s: "muted" }];
				return [head, { t: "(no content)", s: "muted" }];
			}
			case "toolResult": {
				const call = message.toolCallId ? toolCalls.get(message.toolCallId) : undefined;
				if (call) return [{ t: formatToolCall(call.name, call.arguments), s: "muted" }];
				return [{ t: `[${message.toolName ?? "tool"}]`, s: "muted" }];
			}
			case "bashExecution":
				return [{ t: `[bash]: ${normalize(message.command ?? "")}`, s: "dim" }];
			default:
				return [{ t: `[${message.role}]`, s: "dim" }];
		}
	}
	const record = entry as Record<string, unknown> & { type: string };
	switch (record.type) {
		case "custom_message": {
			if (record.customType === "advisor") {
				const { qualifier, text } = advisorTreeDisplay(record.details);
				return [
					{ t: advisorLabel(qualifier), s: "customMessageLabel" },
					{ t: normalize(text), s: "muted" },
				];
			}
			return [
				{ t: `[${String(record.customType)}]: `, s: "customMessageLabel" },
				{ t: normalize(stripSystemWrapperTags(joinTextContent(record.content))), s: "muted" },
			];
		}
		case "compaction":
			return [{ t: `[compaction: ${Math.round(Number(record.tokensBefore) / 1000)}k tokens]`, s: "borderAccent" }];
		case "branch_summary":
			return [{ t: "[branch summary]: ", s: "warning" }, { t: normalize(String(record.summary)) }];
		case "model_change":
			return [{ t: `[model: ${String(record.model)}]`, s: "dim" }];
		case "model_usage":
			return [{ t: modelUsageLabel(record), s: "dim" }];
		case "thinking_level_change":
			return [{ t: `[thinking: ${String(record.thinkingLevel ?? "off")}]`, s: "dim" }];
		case "custom":
			return [{ t: `[custom: ${String(record.customType)}]`, s: "dim" }];
		case "label":
			return [{ t: `[label: ${String(record.label ?? "(cleared)")}]`, s: "dim" }];
		case "title_change":
			return [{ t: `[title: ${normalize(String(record.title))}]`, s: "dim" }];
		case "mode_change":
			return [{ t: `[mode: ${String(record.mode)}]`, s: "dim" }];
		case "service_tier_change":
			return [{ t: serviceTierLabel(record.serviceTier), s: "dim" }];
		case "credential_pin":
			return [{ t: `[credential pin: ${sanitizeTreeField(String(record.provider))}]`, s: "dim" }];
		default:
			return [{ t: `[${record.type.replaceAll("_", " ")}]`, s: "dim" }];
	}
}

function partSpan(part: EntryPart): TspSpan {
	const tokens = [part.s, part.strong ? "strong" : undefined].filter(Boolean).join(" ");
	return tokens ? { t: rowText(part.t), s: tokens } : { t: rowText(part.t) };
}

/** One structural row of the tree. */
interface Row {
	readonly node: TreeSelectorNode;
	readonly depth: number;
	readonly parent: string | undefined;
	/** Siblings under the same parent (branch heads have more than one). */
	readonly siblings: number;
	readonly lastSibling: boolean;
	/** Per guide level above the row: whether the fork it hangs under still has branches below it. */
	readonly guides: readonly boolean[];
}

export function TreeSelector(props: TreeSelectorProps): JSXNode {
	const leafId = props.currentLeafId;
	const toolCalls = collectToolCalls(props.roots);
	const partsOf = (entry: SessionTreeEntry): EntryPart[] => entryParts(entry, toolCalls);
	const parentOf = new Map<string, string | null>();
	const nodeById = new Map<string, TreeSelectorNode>();
	const pendingNodes = [...props.roots];
	for (const root of pendingNodes) parentOf.set(root.entry.id, null);
	for (let node = pendingNodes.pop(); node; node = pendingNodes.pop()) {
		const id = node.entry.id;
		nodeById.set(id, node);
		for (const child of node.children) {
			parentOf.set(child.entry.id, id);
			pendingNodes.push(child);
		}
	}
	const activePath = new Set<string>();
	for (let id: string | null | undefined = leafId; id; id = parentOf.get(id)) activePath.add(id);
	const activeFirst = (nodes: readonly TreeSelectorNode[]): readonly TreeSelectorNode[] => {
		if (nodes.length < 2) return nodes;
		const active = nodes.findIndex(node => activePath.has(node.entry.id));
		if (active <= 0) return nodes;
		const ordered = [...nodes];
		ordered.copyWithin(1, 0, active);
		ordered[0] = nodes[active]!;
		return ordered;
	};

	const orderedRoots = activeFirst(props.roots);
	const childOrder = new Map<TreeSelectorNode, readonly TreeSelectorNode[]>();
	const orderedChildren = (node: TreeSelectorNode): readonly TreeSelectorNode[] => {
		if (node.children.length < 2) return node.children;
		let ordered = childOrder.get(node);
		if (!ordered) childOrder.set(node, (ordered = activeFirst(node.children)));
		return ordered;
	};

	// Structural rows: a fork's branches nest one level deeper; a linear chain stays at its head's depth.
	const rows: Row[] = [];
	const branchPoints = new Set<string>();
	const pendingRows: Row[] = [];
	const pushRows = (
		ordered: readonly TreeSelectorNode[],
		depth: number,
		parent: string | undefined,
		guides: readonly boolean[],
	): void => {
		const siblings = ordered.length;
		for (let at = siblings - 1; at >= 0; at--) {
			pendingRows.push({ node: ordered[at]!, depth, parent, siblings, lastSibling: at === siblings - 1, guides });
		}
	};
	pushRows(orderedRoots, 0, undefined, []);
	for (let row = pendingRows.pop(); row; row = pendingRows.pop()) {
		rows.push(row);
		const children = orderedChildren(row.node);
		if (children.length === 0) continue;
		const id = row.node.entry.id;
		if (children.length > 1) branchPoints.add(id);
		const { depth, parent, guides, siblings, lastSibling } = row;
		const childDepth = children.length > 1 || (orderedRoots.length > 1 && parent === undefined) ? depth + 1 : depth;
		// Keep the fork's guide running down the branch while siblings follow it, even if the filter hides its head.
		const forkGuide = siblings > 1 && depth > 0;
		const below =
			childDepth === depth && !forkGuide
				? guides
				: Array.from({ length: childDepth }, (_, level) =>
						forkGuide && level === depth - 1 ? !lastSibling : (guides[level] ?? false),
					);
		pushRows(children, childDepth, id, below);
	}
	const maxVisible = Math.max(
		1,
		Math.min(Math.max(5, Math.floor(props.terminalHeight / 2)), props.terminalHeight - 8),
	);

	const filter = signal<TreeFilterMode>(props.initialFilterMode ?? "default");
	const search = signal<LineState>({ text: "", cursor: 0 });
	const labels = signal(new Map(rows.filter(row => row.node.label).map(row => [row.node.entry.id, row.node.label!])));
	const labelEditor = signal<{ entryId: string; line: LineState } | null>(null);

	const passes = (row: Row): boolean => {
		const node = row.node;
		const entry = node.entry;
		const message = messageOf(entry);
		if (message?.role === "assistant" && entry.id !== leafId) {
			const stopped = message.stopReason && message.stopReason !== "stop" && message.stopReason !== "toolUse";
			if (!joinTextContent(message.content).trim() && !stopped) return false;
		}
		const settings = SETTINGS_ENTRIES[entry.type] === true;
		switch (filter()) {
			case "user-only":
				if (!isUserRequestEntry(entry)) return false;
				break;
			case "no-tools":
				if (settings || message?.role === "toolResult") return false;
				break;
			case "labeled-only":
				if (!labels().has(entry.id)) return false;
				break;
			case "all":
				break;
			default:
				if (settings) return false;
		}
		const tokens = search().text.toLowerCase().split(/\s+/).filter(Boolean);
		if (tokens.length === 0) return true;
		const text = entrySearchText(entry, labels().get(entry.id));
		return tokens.every(token => fuzzyMatch(token, text).matches);
	};
	const visible = computed(() => rows.filter(passes));

	/** The nearest visible row for `id`: itself, else its closest visible ancestor, else the first row. */
	const nearestVisible = (id: string | null): string | null => {
		const shown = new Set(visible().map(row => row.node.entry.id));
		for (let at: string | null | undefined = id; at; at = parentOf.get(at)) if (shown.has(at)) return at;
		return visible()[0]?.node.entry.id ?? null;
	};
	/** The selection the user made; shown as its nearest visible row. */
	const anchor = signal<string | null>(leafId ?? rows.at(-1)?.node.entry.id ?? null);
	const selected = computed(() => nearestVisible(anchor()));
	const index = (): number => visible().findIndex(row => row.node.entry.id === selected());
	const selectAt = (at: number): void => {
		const row = visible()[at];
		if (row) anchor.set(row.node.entry.id);
	};
	const move = (delta: number, wrap: boolean): void => {
		const total = visible().length;
		if (total === 0) return;
		let next = index() + delta;
		if (next < 0 || next >= total)
			next = wrap && Math.abs(delta) === 1 ? (next + total) % total : Math.max(0, Math.min(total - 1, next));
		selectAt(next);
	};
	const moveTurn = (direction: -1 | 1): void => {
		const shown = visible();
		for (let at = index() + direction; at >= 0 && at < shown.length; at += direction) {
			const role = messageOf(shown[at]!.node.entry)?.role;
			if (role === "user" || role === "assistant") return selectAt(at);
		}
	};
	/** Re-anchor on what shows after a filter or search change (an empty result keeps the anchor). */
	const settle = (): void => {
		if (visible().length > 0) anchor.set(nearestVisible(anchor()));
	};
	const setFilter = (mode: TreeFilterMode): void => {
		filter.set(mode);
		settle();
	};
	const setSearch = (line: LineState): void => {
		search.set(line);
		settle();
	};
	const confirm = (summarize: boolean): void => {
		const id = selected();
		if (id) props.onSelect(id, { summarize });
	};
	const escape = (): void => {
		if (search().text) setSearch({ text: "", cursor: 0 });
		else props.onCancel();
	};
	const editLabel = (): void => {
		const id = selected();
		if (!id) return;
		const current = labels().get(id) ?? "";
		labelEditor.set({ entryId: id, line: { text: current, cursor: current.length } });
	};
	const saveLabel = (): void => {
		const editor = labelEditor();
		if (!editor) return;
		const value = editor.line.text.trim() || undefined;
		batch(() => {
			const next = new Map(labels());
			if (value) next.set(editor.entryId, value);
			else next.delete(editor.entryId);
			labels.set(next);
			labelEditor.set(null);
		});
		props.onLabelChange?.(editor.entryId, value);
	};
	const cycleFilter = (delta: 1 | -1): void => {
		const at = TREE_FILTER_MODES.indexOf(filter());
		setFilter(TREE_FILTER_MODES[(at + delta + TREE_FILTER_MODES.length) % TREE_FILTER_MODES.length]!);
	};

	/**
	 * Branch targets in rendered order: for every fork (siblings under one
	 * parent, or several roots), each branch's first visible row (its head, or
	 * its first visible descendant when the filter hides the head), keyed by
	 * every raw branch head that leads to it.
	 */
	const branchTargets = computed(() => {
		const shown = visible();
		const visibleIndex = new Map<string, number>();
		for (let at = 0; at < shown.length; at++) visibleIndex.set(shown[at]!.node.entry.id, at);
		// Rows are in pre-order: one bottom-up pass finds every node's first visible row.
		const firstVisible = new Map<string, TreeSelectorNode>();
		for (let at = rows.length - 1; at >= 0; at--) {
			const node = rows[at]!.node;
			let target = visibleIndex.has(node.entry.id) ? node : undefined;
			for (const child of target ? [] : orderedChildren(node)) {
				target = firstVisible.get(child.entry.id);
				if (target) break;
			}
			if (target) firstVisible.set(node.entry.id, target);
		}
		const byTarget = new Map<string, { heads: string[]; target: TreeSelectorNode }>();
		const addFork = (branches: readonly TreeSelectorNode[]): void => {
			if (branches.length < 2) return;
			for (const branch of branches) {
				const target = firstVisible.get(branch.entry.id);
				if (!target) continue;
				const existing = byTarget.get(target.entry.id);
				if (existing) existing.heads.push(branch.entry.id);
				else byTarget.set(target.entry.id, { heads: [branch.entry.id], target });
			}
		};
		addFork(orderedRoots);
		for (const row of rows) addFork(orderedChildren(row.node));
		const ordered = [...byTarget.values()].sort(
			(a, b) => visibleIndex.get(a.target.entry.id)! - visibleIndex.get(b.target.entry.id)!,
		);
		const indexByHead = new Map<string, number>();
		for (let at = 0; at < ordered.length; at++) for (const head of ordered[at]!.heads) indexByHead.set(head, at);
		return { targets: ordered.map(entry => entry.target.entry.id), indexByHead };
	});
	/** The head of the branch holding `id` at its nearest fork. */
	const branchHeadOf = (id: string): string | undefined => {
		let head = id;
		for (let parent = parentOf.get(head); parent !== undefined; parent = parentOf.get(head)) {
			const siblings = parent === null ? props.roots.length : (nodeById.get(parent)?.children.length ?? 0);
			if (siblings > 1) return head;
			if (parent === null) return undefined;
			head = parent;
		}
		return undefined;
	};
	/** Select the previous/next visible branch in rendered order, wrapping, across nested forks. */
	const moveBranch = (direction: -1 | 1): void => {
		const id = selected();
		if (!id) return;
		const { targets, indexByHead } = branchTargets();
		if (targets.length === 0) return;
		const head = branchHeadOf(id);
		const at = head === undefined ? -1 : (indexByHead.get(head) ?? -1);
		const next =
			at < 0 ? (direction > 0 ? 0 : targets.length - 1) : (at + direction + targets.length) % targets.length;
		anchor.set(targets[next]!);
	};

	const onKey = (key: KeyEvent): boolean => {
		if (key.kind === "release") return false;
		const keybindings = getKeybindings();
		const editor = labelEditor();
		if (editor) {
			if (keybindings.matches(key, "tui.input.submit")) saveLabel();
			else if (matchesSelectCancel(key, keybindings)) labelEditor.set(null);
			else {
				const next = editLine(editor.line, key);
				if (next) labelEditor.set({ ...editor, line: next });
			}
			return true;
		}
		const id = selectKeyId(key, keybindings);
		switch (id) {
			case "up":
				move(-1, true);
				return true;
			case "down":
				move(1, true);
				return true;
			case "alt+up":
				moveTurn(-1);
				return true;
			case "alt+down":
				moveTurn(1);
				return true;
		}
		if (keybindings.matches(key, "app.tree.previousBranch")) {
			moveBranch(-1);
			return true;
		}
		if (keybindings.matches(key, "app.tree.nextBranch")) {
			moveBranch(1);
			return true;
		}
		if (matchesAppInterrupt(key, keybindings)) {
			escape();
			return true;
		}
		switch (id) {
			case "home":
				selectAt(0);
				return true;
			case "end":
				selectAt(visible().length - 1);
				return true;
			case "pageUp":
			case "left":
				move(-maxVisible, false);
				return true;
			case "pageDown":
			case "right":
				move(maxVisible, false);
				return true;
			case "shift+enter":
				confirm(true);
				return true;
			case "enter":
				// A bare LF is Shift+Enter on legacy terminals (iTerm2), as in the composer.
				confirm(key.raw === "\n");
				return true;
			case "ctrl+c":
				props.onCancel();
				return true;
			case "ctrl+shift+o":
				cycleFilter(-1);
				return true;
			case "ctrl+o":
				cycleFilter(1);
				return true;
		}
		const mode = FILTER_KEYS[key.id];
		if (mode) {
			setFilter(mode);
			return true;
		}
		if (key.id === "shift+l" && !search().text) {
			editLabel();
			return true;
		}
		const next = editLine(search(), key);
		if (next && next.text !== search().text) setSearch(next);
		else if (next) search.set(next);
		return true;
	};

	const items = computed<TspPickerItem[]>(() =>
		rows.map(row => {
			const entry = row.node.entry;
			const message = messageOf(entry);
			let kind: TspPickerItem["node"] = "marker";
			let role: string | undefined;
			if (isUserRequestEntry(entry)) kind = "user";
			else if (message?.role === "assistant") kind = "assistant";
			else if (message?.role === "toolResult") [kind, role] = ["tool", `omp.tool.${message.toolName}`];
			else if (message?.role === "bashExecution") [kind, role] = ["tool", "omp.tool.bash"];
			else if (message?.role === "pythonExecution") [kind, role] = ["tool", "omp.tool.eval"];
			const label = labels().get(entry.id);
			return {
				id: entry.id,
				label: partsOf(entry).map(partSpan),
				depth: row.depth,
				node: kind,
				...(role ? { role } : {}),
				...(branchPoints.has(entry.id) ? { open: true } : {}),
				...(label ? { badges: [{ text: rowText(label), tone: "warning" as const }] } : {}),
				...(activePath.has(entry.id) ? { dot: "accent" as const } : {}),
			};
		}),
	);
	const empty = (): TspText => {
		if (rows.length === 0) return [{ t: "No entries found", s: "muted" }];
		const query = search().text;
		if (query.length > 0)
			return [
				{ t: `No entries match search "${query}". Press `, s: "muted" },
				{ t: "backspace", s: "key" },
				{ t: " to clear the search", s: "muted" },
			];
		return [
			{ t: `${rows.length} entries hidden by the current filter ${FILTER_LABELS[filter()]}. Press `, s: "muted" },
			{ t: "alt+a", s: "key" },
			{ t: " to show all, ", s: "muted" },
			{ t: "alt+d", s: "key" },
			{ t: " for default", s: "muted" },
		];
	};
	const actions = (): TspPickerAction[] =>
		labelEditor()
			? [pickerAction("label-save", "Save label", confirmKbd(), { primary: true }), closeAction("Cancel")]
			: [
					pickerAction("switch", "Switch", confirmKbd(), { primary: true }),
					pickerAction("summarize", "Summarize & switch", ["shift", "enter"]),
					pickerAction("label", "Label", ["shift", "l"]),
					pickerAction("filter", "Filter", ["ctrl", "o"]),
					closeAction(),
				];
	const onAction = (act: string, value?: string): void => {
		if (labelEditor()) {
			if (act === "label-save") saveLabel();
			else if (act === "close") labelEditor.set(null);
			return;
		}
		switch (act) {
			case "tab": {
				const mode = TREE_FILTER_MODES.find(m => m === value);
				if (mode && mode !== filter()) setFilter(mode);
				return;
			}
			case "switch":
				return confirm(false);
			case "summarize":
				return confirm(true);
			case "label":
				if (!search().text) editLabel();
				return;
			case "filter":
				return cycleFilter(1);
			case "close":
				return escape();
			case "clear":
				return setSearch({ text: "", cursor: 0 });
		}
	};
	const term = (): TreeLookTerm => {
		const shown = visible();
		const lookRows: TreeLookRow[] = shown.map(row => {
			const id = row.node.entry.id;
			return {
				id,
				depth: row.depth,
				branch: row.siblings > 1,
				last: row.lastSibling,
				guides: row.guides,
				active: activePath.has(id),
				label: labels().get(id),
				parts: partsOf(row.node.entry),
			};
		});
		const editor = labelEditor();
		return {
			look: "omp.tree",
			entries: lookRows,
			field: search(),
			maxRows: maxVisible,
			label: editor ? editor.line : undefined,
			filterLabel: filter() === "default" ? "" : ` ${FILTER_LABELS[filter()]}`,
			total: rows.length,
		};
	};

	return (
		<col>
			<picker
				key={PICKER_KEY}
				title="Session tree"
				subtitle={props.sessionName}
				icon="git-branch"
				noun="entries"
				size="lg"
				layout="tree"
				preview="side"
				query={() => search().text}
				cursor={() => search().cursor}
				placeholder="Search entries…"
				tabs={FILTER_TABS}
				tab={filter}
				items={items}
				order={() => visible().map(row => row.node.entry.id)}
				selected={selected}
				current={leafId === null ? [] : [leafId]}
				total={rows.length}
				empty={empty}
				focus={() => (labelEditor() ? "preview" : "list")}
				actions={actions}
				term={term}
				onKey={onKey}
				onSelect={id => {
					if (!labelEditor() && visible().some(row => row.node.entry.id === id)) anchor.set(id);
				}}
				onActivate={id => {
					if (labelEditor() || !visible().some(row => row.node.entry.id === id)) return;
					anchor.set(id);
					confirm(false);
				}}
				onAction={(act, event) => onAction(act, event.value)}
			>
				{preview}
			</picker>
		</col>
	);

	/** The selected entry (its kind, label and content), or the label editor while open (a reactive child). */
	function preview(): JSXNode {
		const editor = labelEditor();
		if (editor)
			return [
				<text text="Label" role="omp.picker.title" />,
				<text spans={[{ t: "Empty to remove", s: "muted" }]} />,
				<input text={editor.line.text} cursor={editor.line.cursor} prompt="> " sendable={false} />,
			];
		const id = selected();
		const row = rows.find(r => r.node.entry.id === id);
		if (!row) return null;
		const entry = row.node.entry;
		const label = labels().get(entry.id);
		const parts = partsOf(entry)
			.map(part => rowText(part.t))
			.join("");
		const out: JSXNode[] = [];
		if (entry.type === "message" || entry.type === "custom_message") {
			// What `/copy` would take of the entry, shown as the transcript shows it.
			const target: Target = {
				turnId: entry.id,
				isUserTurn: isUserRequestEntry(entry),
				entries: [entry as TranscriptEntryLike],
			};
			const copy = targetCopy(target, collectBlocks(target));
			out.push(
				<text text={rowText(`${copy.label[0]!.toUpperCase()}${copy.label.slice(1)}`)} role="omp.picker.title" />,
			);
			if (label) out.push(<text spans={[{ t: rowText(label), s: "warning" }]} />);
			out.push(turnPreview(target, copy.content || parts));
		} else {
			out.push(<text text={parts} role="omp.picker.title" />);
			if (label) out.push(<text spans={[{ t: rowText(label), s: "warning" }]} />);
		}
		return out;
	}
}
