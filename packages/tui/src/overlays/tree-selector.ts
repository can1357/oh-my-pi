import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import {
	type Component,
	Container,
	FuzzyQuery,
	FuzzyText,
	Input,
	matchesKey,
	Spacer,
	TruncatedText,
	truncateToWidth,
} from "../index";
import { isRecord, sanitizeText } from "@oh-my-pi/pi-utils";
/** Available session-tree display filters. */
export const TREE_FILTER_MODES = ["default", "no-tools", "user-only", "labeled-only", "all"] as const;
/** Session-tree display filter. */
export type TreeFilterMode = (typeof TREE_FILTER_MODES)[number];
import { theme } from "../theme/theme";
import {
	matchesAppInterrupt,
	matchesSelectDown,
	matchesSelectPageDown,
	matchesSelectPageUp,
	matchesSelectUp,
} from "../keybinding-matchers";
import { isUserRequestEntry, type TranscriptEntryLike } from "../chat/transcript-entry";

/** Fields consumed when displaying persisted entries in the session tree. */
export type SessionTreeEntry = { id: string; parentId: string | null } & (
	| TranscriptEntryLike
	| { type: "compaction"; tokensBefore: number }
	| { type: "branch_summary"; summary: string }
	| { type: "model_change"; model: string }
	| { type: "model_usage"; purpose: string; role?: string; provider: string; model: string }
	| { type: "thinking_level_change"; thinkingLevel?: string | null }
	| { type: "custom"; customType: string }
	| { type: "label"; label?: string }
	| { type: "service_tier_change"; serviceTier: Partial<Record<string, string>> | null }
	| { type: "title_change"; title: string }
	| { type: "mode_change"; mode: string }
	| { type: "credential_pin"; provider: string }
	| { type: "ttsr_injection"; injectedRules: string[] }
	| { type: "session_init" | "reset_boundary" }
);

/** Session tree shape consumed by the selector. */
export interface TreeSelectorNode {
	entry: SessionTreeEntry;
	children: TreeSelectorNode[];
	label?: string;
}
import { toPathList } from "../render/render-utils";
import { shortenPath } from "../render/render-utils";
import { canonicalizeMessage } from "../chat/thinking-display";
import { resolveAssistantErrorPresentation } from "../chat/transcript-render-helpers";
import { OverlayPanel, PanelDivider } from "../chrome/overlay-box";
import { TreeView, type TreeAncestor, type TreeRow } from "../components/tree-view";
import { formatKeyHint, formatKeyHints } from "../app-keybindings";
import { boundKeys, editorKeys, interruptKey } from "../chrome/keybinding-hints";
import type { TspPickerItem, TspPickerProps, TspSpan, TspText } from "@oh-my-pi/pi-wire";
import type { ThemeColor } from "../theme/schema";
import { col, keyed, node, span, text } from "../native/describe";
import type { DescribeContext, NativeChild, NativeNode, NativeUiEvent } from "../native/node";
import { actionHint, hintsRow, overlayCard } from "../native/overlay";
import { CLOSE_ACTION, type PickerEvent, picker, pickerAction, pickerEvent, pickerQuery } from "../native/picker";
import { plainText } from "../native/spans";
import type { OutlineTarget } from "../chat/transcript-outline";
import { collectBlocks, targetCopy, turnPreview } from "./copy-selector";

/** Filter mode for tree display */
type FilterMode = TreeFilterMode;

/**
 * Tree list component with selection and ASCII art visualization
 */
/** Tool call info for lookup */
interface ToolCallInfo {
	name: string;
	arguments: Record<string, unknown>;
}

/** Advisor note metadata surfaced on a single session-tree row. */
interface AdvisorTreeDisplay {
	/** Non-default advisor names then severities, comma-joined (e.g. `sec, blocker`). */
	qualifier: string;
	/** Note bodies joined into one line. */
	text: string;
}

/**
 * Collapse untrusted session metadata to one safe tree-row field: strip
 * ANSI/control characters, then fold preserved tabs/newlines into spaces.
 */
function sanitizeTreeField(value: string): string {
	return sanitizeText(value)
		.replace(/[\n\t]/g, " ")
		.trim();
}

/**
 * Extract display metadata from an advisor custom-message's `details.notes`,
 * ignoring the model-facing `<advisory>` wrapper stored in `content`. Collects
 * distinct non-default advisor names and severities so the tree row can tag the
 * note the way its transcript card does.
 */
function advisorTreeDisplay(details: unknown): AdvisorTreeDisplay {
	if (!isRecord(details) || !Array.isArray(details.notes)) return { qualifier: "", text: "" };
	const notes: string[] = [];
	const advisors: string[] = [];
	const severities: string[] = [];
	for (const note of details.notes) {
		if (!isRecord(note)) continue;
		if (typeof note.note === "string") notes.push(note.note);
		if (typeof note.advisor === "string") {
			const name = sanitizeTreeField(note.advisor);
			if (name && name !== "default" && !advisors.includes(name)) advisors.push(name);
		}
		if (typeof note.severity === "string") {
			const severity = sanitizeTreeField(note.severity);
			if (severity && !severities.includes(severity)) severities.push(severity);
		}
	}
	return { qualifier: [...advisors, ...severities].join(", "), text: notes.join(" ") };
}

/**
 * Strip one model-facing `<system-*>` envelope from custom-message content.
 * Nested system tags belong to the recorded payload and remain visible.
 */
function stripSystemWrapperTags(content: string): string {
	const trimmed = content.trim();
	const opening = /^<(system-[\w-]+)/i.exec(trimmed);
	if (!opening) return content;

	const attributeStart = opening[0].length;
	const firstAttributeCharacter = trimmed[attributeStart];
	if (firstAttributeCharacter !== ">" && !/\s/.test(firstAttributeCharacter ?? "")) return content;

	let quote: '"' | "'" | undefined;
	let openingEnd = -1;
	for (let index = attributeStart; index < trimmed.length; index++) {
		const character = trimmed[index];
		if (quote) {
			if (character === quote) quote = undefined;
		} else if (character === '"' || character === "'") {
			quote = character;
		} else if (character === "<") {
			return content;
		} else if (character === ">") {
			openingEnd = index;
			break;
		}
	}
	if (openingEnd === -1 || quote) return content;

	const closingTag = `</${opening[1]}>`;
	const closingStart = trimmed.length - closingTag.length;
	if (closingStart <= openingEnd || trimmed.slice(closingStart).toLowerCase() !== closingTag.toLowerCase()) {
		return content;
	}
	return trimmed.slice(openingEnd + 1, closingStart).trim();
}

/** Per-message cap on text folded into the tree search index. */
const SEARCH_TEXT_LIMIT = 200;

/** One theme-colored piece of an entry's display text. */
interface EntryPart {
	t: string;
	s?: ThemeColor;
}

/** A cached native tree item and the inputs it was built from. */
interface TreeItemMemo {
	label: string | undefined;
	branch: boolean;
	node: NativeNode;
}

/** The session tree's `picker` data (see {@link TreeList.pickerView}). */
interface TreePickerView {
	items: readonly TspPickerItem[];
	order: readonly string[];
	selected: string | null;
	current: readonly string[];
	query: string;
	/** UTF-16 caret into `query`. */
	cursor: number;
	filterMode: FilterMode;
	total: number;
	empty: TspText;
}

const FILTER_TABS: readonly { id: TreeFilterMode; label: string }[] = [
	{ id: "default", label: "Default" },
	{ id: "no-tools", label: "No tools" },
	{ id: "user-only", label: "User only" },
	{ id: "labeled-only", label: "Labeled" },
	{ id: "all", label: "All" },
];

class TreeList implements Component {
	#tree: TreeView<TreeSelectorNode, string>;
	#roots: TreeSelectorNode[] = [];
	#rootIds: Set<string> = new Set();
	#nodeById: Map<string, TreeSelectorNode> = new Map();
	#filterMode: FilterMode;
	/** The search field; its value is the fuzzy query. */
	readonly searchInput = new Input();
	#toolCallMap: Map<string, ToolCallInfo> = new Map();
	#multipleRoots = false;
	#activePathIds: Set<string> = new Set();
	#containsActive: Map<TreeSelectorNode, boolean> = new Map();
	/** Prepared search text per node; rebuilt when the node's label changes. */
	#searchTextCache = new WeakMap<TreeSelectorNode, { label: string | undefined; text: FuzzyText }>();

	onSelect?: (entryId: string, options: { summarize: boolean }) => void;
	onCancel?: () => void;
	onLabelEdit?: (entryId: string, currentLabel: string | undefined) => void;

	/** Native item nodes by entry id, reused across filter/search changes. */
	#itemCache = new Map<string, TreeItemMemo>();
	#itemsNative: { rows: readonly TreeRow<TreeSelectorNode, string>[]; items: NativeNode[] } | undefined;
	#listNative:
		| {
				items: readonly NativeNode[];
				selected: string | undefined;
				query: string;
				filterMode: FilterMode;
				node: NativeNode;
		  }
		| undefined;
	/** Bumped on every label edit: labels are item badges. */
	#labelVersion = 0;
	#pickerItems:
		| { rows: readonly TreeRow<TreeSelectorNode, string>[]; labels: number; items: TspPickerItem[] }
		| undefined;
	#pickerOrder: { rows: readonly TreeRow<TreeSelectorNode, string>[]; order: string[] } | undefined;
	#previewMemo: { node: TreeSelectorNode | undefined; labels: number; preview: NativeChild[] } | undefined;

	constructor(
		tree: TreeSelectorNode[],
		private readonly currentLeafId: string | null,
		private readonly maxVisibleLines: number,
		initialFilterMode: FilterMode = "default",
		initialSelectedId?: string,
	) {
		this.#filterMode = initialFilterMode;
		this.searchInput.prompt = `${theme.fg("muted", "Search:")} `;
		this.searchInput.placeholder = "Type to search";
		this.#multipleRoots = tree.length > 1;
		this.#indexSession(tree);
		this.#tree = new TreeView<TreeSelectorNode, string>({
			roots: this.#roots,
			getKey: node => node.entry.id,
			getChildren: node => this.#orderedChildren(node),
			getChildDepth: (_node, row, children) =>
				children.length > 1 || (this.#multipleRoots && row.parentKey === undefined) ? row.depth + 1 : row.depth,
			compactSameDepthAncestors: true,
			theme,
			filter: this.#buildFilter(),
			maxRows: maxVisibleLines,
			scrollbar: true,
			scrollbarTheme: {
				track: text => theme.fg("muted", text),
				thumb: text => theme.fg("accent", text),
			},
			renderPrefix: (row, context) => this.#renderGutter(row, context.width, context.windowRows),
			renderLeading: (_item, context) => (context.selected ? theme.fg("accent", "› ") : "  "),
			renderRow: (node, context) => this.#renderTreeRow(node, context.selected),
			styleSelected: line => theme.bg("selectedBg", line),
		});

		// Start with initialSelectedId if provided, otherwise current leaf.
		// A null target selects the last row; unknown ids resolve to their
		// nearest visible ancestor inside TreeView.
		const targetId = initialSelectedId ?? currentLeafId;
		if (targetId === null || targetId === undefined) {
			this.#tree.setSelectionIndex(this.#tree.rows.length - 1);
		} else {
			this.#tree.setSelectedKey(targetId);
		}
	}

	/**
	 * Session-specific projection index. Iteratively collects tool calls for
	 * later lookup, maps ids to nodes/parents, marks active-descendant
	 * membership, orders the current branch first, and records the active
	 * path. Hierarchy shape, filtering, and selection live in TreeView.
	 */
	#indexSession(roots: TreeSelectorNode[]): void {
		this.#toolCallMap.clear();
		this.#containsActive.clear();
		this.#nodeById.clear();
		this.#activePathIds.clear();

		const parentIds = new Map<string, string | null>();
		const allNodes: TreeSelectorNode[] = [];
		const visitStack: TreeSelectorNode[] = [...roots];
		while (visitStack.length > 0) {
			const node = visitStack.pop()!;
			allNodes.push(node);
			this.#nodeById.set(node.entry.id, node);
			const entry = node.entry;
			if (entry.type === "message" && entry.message.role === "assistant" && "content" in entry.message) {
				const content = entry.message.content;
				if (Array.isArray(content)) {
					for (const block of content) {
						if (typeof block === "object" && block !== null && "type" in block && block.type === "toolCall") {
							const tc = block as { id: string; name: string; arguments: Record<string, unknown> };
							this.#toolCallMap.set(tc.id, { name: tc.name, arguments: tc.arguments });
						}
					}
				}
			}
			for (let i = node.children.length - 1; i >= 0; i--) {
				const child = node.children[i];
				parentIds.set(child.entry.id, node.entry.id);
				visitStack.push(child);
			}
		}
		for (const root of roots) {
			if (!parentIds.has(root.entry.id)) parentIds.set(root.entry.id, null);
		}

		// Post-order active-descendant membership (children before parents).
		const leafId = this.currentLeafId;
		for (let i = allNodes.length - 1; i >= 0; i--) {
			const node = allNodes[i];
			let has = leafId !== null && node.entry.id === leafId;
			for (const child of node.children) {
				if (this.#containsActive.get(child)) {
					has = true;
					break;
				}
			}
			this.#containsActive.set(node, has);
		}

		// Current branch first; stable sort preserves domain order otherwise.
		this.#roots = [...roots].sort(
			(a, b) => Number(this.#containsActive.get(b)) - Number(this.#containsActive.get(a)),
		);
		this.#rootIds = new Set(this.#roots.map(root => root.entry.id));

		// Active path from the current leaf back to its root.
		let currentId: string | null = this.currentLeafId;
		while (currentId) {
			this.#activePathIds.add(currentId);
			const parentId = parentIds.get(currentId);
			if (parentId === undefined || parentId === null) break;
			currentId = parentId;
		}
	}

	/** Children with the branch containing the active leaf first. */
	#orderedChildren(node: TreeSelectorNode): readonly TreeSelectorNode[] {
		const children = node.children;
		let hasActive = false;
		for (const child of children) {
			if (this.#containsActive.get(child)) {
				hasActive = true;
				break;
			}
		}
		if (!hasActive) return children;
		return [...children].sort((a, b) => Number(this.#containsActive.get(b)) - Number(this.#containsActive.get(a)));
	}

	#applyFilter(): void {
		// TreeView retains the nearest visible selection (including an anchor
		// through empty filter results) when the predicate is replaced.
		this.#tree.setFilter(this.#buildFilter());
	}

	/** Visible-row predicate combining the assistant-text rule, filter mode, and fuzzy query. */
	#buildFilter(): (node: TreeSelectorNode, row: TreeRow<TreeSelectorNode, string>) => boolean {
		const filterMode = this.#filterMode;
		const leafId = this.currentLeafId;
		const searchTokens = this.getSearchQuery()
			.toLowerCase()
			.split(/\s+/)
			.filter(Boolean)
			.map(token => new FuzzyQuery(token));
		return node => {
			const entry = node.entry;
			const isCurrentLeaf = entry.id === leafId;

			// Skip assistant messages with only tool calls (no text) unless error/aborted
			// Always show current leaf so active position is visible
			if (entry.type === "message" && entry.message.role === "assistant" && !isCurrentLeaf) {
				const msg = entry.message as { stopReason?: string; content?: unknown };
				const hasText = this.#hasTextContent(msg.content);
				const isErrorOrAborted = msg.stopReason && msg.stopReason !== "stop" && msg.stopReason !== "toolUse";
				// Only hide if no text AND not an error/aborted message
				if (!hasText && !isErrorOrAborted) {
					return false;
				}
			}

			// Apply filter mode
			let passesFilter = true;
			// Entry types hidden in default view (settings/bookkeeping). These carry
			// no conversation content, so the tree only shows them in "all" mode.
			const isSettingsEntry =
				entry.type === "label" ||
				entry.type === "custom" ||
				entry.type === "model_change" ||
				entry.type === "model_usage" ||
				entry.type === "thinking_level_change" ||
				entry.type === "service_tier_change" ||
				entry.type === "title_change" ||
				entry.type === "credential_pin" ||
				entry.type === "session_init" ||
				entry.type === "ttsr_injection" ||
				entry.type === "mode_change" ||
				entry.type === "reset_boundary";

			switch (filterMode) {
				case "user-only":
					// Just user requests (plain prompts and user-invoked skill/collab prompts)
					passesFilter = isUserRequestEntry(entry);
					break;
				case "no-tools":
					// Default minus tool results
					passesFilter = !isSettingsEntry && !(entry.type === "message" && entry.message.role === "toolResult");
					break;
				case "labeled-only":
					// Just labeled entries
					passesFilter = node.label !== undefined;
					break;
				case "all":
					// Show everything
					passesFilter = true;
					break;
				default:
					// Default mode: hide settings/bookkeeping entries
					passesFilter = !isSettingsEntry;
					break;
			}

			if (!passesFilter) return false;

			// Apply fuzzy search filter
			if (searchTokens.length > 0) {
				const nodeText = this.#getFuzzyText(node);
				return searchTokens.every(token => token.match(nodeText).matches);
			}

			return true;
		};
	}

	/** Prepared fuzzy text for a node's searchable content, built once per label. */
	#getFuzzyText(node: TreeSelectorNode): FuzzyText {
		const cached = this.#searchTextCache.get(node);
		if (cached !== undefined && cached.label === node.label) return cached.text;
		const text = new FuzzyText(this.#getSearchableText(node));
		this.#searchTextCache.set(node, { label: node.label, text });
		return text;
	}

	/** Get searchable text content from a node */
	#getSearchableText(node: TreeSelectorNode): string {
		const entry = node.entry;
		const parts: string[] = [];

		if (node.label) {
			parts.push(node.label);
		}

		switch (entry.type) {
			case "message": {
				const msg = entry.message;
				parts.push(msg.role);
				if ("content" in msg && msg.content) {
					parts.push(this.#extractContent(msg.content));
				}
				if (msg.role === "bashExecution") {
					const bashMsg = msg as { command?: string };
					if (bashMsg.command) parts.push(bashMsg.command);
				}
				break;
			}
			case "custom_message": {
				parts.push(entry.customType);
				if (entry.customType === "advisor") {
					const { qualifier, text } = advisorTreeDisplay(entry.details);
					if (qualifier) parts.push(qualifier);
					if (text) parts.push(text);
				} else {
					const content = stripSystemWrapperTags(this.#joinTextContent(entry.content)).slice(0, SEARCH_TEXT_LIMIT);
					if (content) parts.push(content);
				}
				break;
			}
			case "compaction":
				parts.push("compaction");
				break;
			case "branch_summary":
				parts.push("branch summary", entry.summary);
				break;
			case "model_change":
				parts.push("model", entry.model);
				break;
			case "model_usage":
				parts.push(
					"model usage",
					sanitizeTreeField(entry.purpose),
					sanitizeTreeField(entry.role ?? ""),
					sanitizeTreeField(entry.provider),
					sanitizeTreeField(entry.model),
				);
				break;
			case "thinking_level_change":
				parts.push("thinking", entry.thinkingLevel ?? ThinkingLevel.Off);
				break;
			case "custom":
				parts.push("custom", entry.customType);
				break;
			case "label":
				parts.push("label", entry.label ?? "");
				break;
			case "service_tier_change":
				parts.push("service tier");
				if (entry.serviceTier) {
					const serviceTier = entry.serviceTier;
					for (const family in serviceTier) {
						const tier = serviceTier[family as keyof typeof serviceTier];
						if (tier) parts.push(family, tier);
					}
				}
				break;
			case "title_change":
				parts.push("title", entry.title);
				break;
			case "mode_change":
				parts.push("mode", entry.mode);
				break;
			case "credential_pin":
				parts.push("credential pin", entry.provider);
				break;
			case "ttsr_injection":
				parts.push("ttsr injection", ...entry.injectedRules);
				break;
			case "reset_boundary":
				parts.push("reset boundary");
				break;
			case "session_init":
				parts.push("session init");
				break;
		}

		return parts.join(" ");
	}

	invalidate(): void {
		this.#tree.invalidate();
		this.#itemCache.clear();
	}

	dispose(): void {
		this.#tree.dispose();
	}

	getSearchQuery(): string {
		return this.searchInput.getValue();
	}

	getFilterMode(): FilterMode {
		return this.#filterMode;
	}

	/** Native filter tab: switch to that mode, like its alt+key shortcut. */
	setFilterMode(mode: string): void {
		const next = TREE_FILTER_MODES.find(m => m === mode);
		if (next === undefined || next === this.#filterMode) return;
		this.#filterMode = next;
		this.#applyFilter();
	}

	/** Native click on an entry: highlight it, then the same outcome as Enter. */
	activateEntry(entryId: string): void {
		if (!this.#tree.rows.some(row => row.key === entryId)) return;
		this.#tree.setSelectedKey(entryId);
		const selected = this.#tree.selectedItem;
		if (selected && this.onSelect) this.onSelect(selected.entry.id, { summarize: false });
	}

	/** Native row click: highlight the entry without switching. */
	selectEntry(entryId: string): void {
		if (this.#tree.rows.some(row => row.key === entryId)) this.#tree.setSelectedKey(entryId);
	}

	/**
	 * The `tree` picker's data. `items` is every structural entry, rebuilt
	 * only when the tree or a label changes; filter modes and typing change
	 * only `order` (the visible entries) and the selection.
	 */
	pickerView(): TreePickerView {
		const allRows = this.#tree.allRows;
		if (this.#pickerItems?.rows !== allRows || this.#pickerItems.labels !== this.#labelVersion) {
			// Real branch points get a disclosure; linear chains stay flat at their head's depth.
			const branchPoints = new Set<string>();
			for (const row of allRows) {
				if (row.parentKey !== undefined && row.siblingCount > 1) branchPoints.add(row.parentKey);
			}
			this.#pickerItems = {
				rows: allRows,
				labels: this.#labelVersion,
				items: allRows.map(row => this.#pickerItem(row, branchPoints.has(row.key))),
			};
		}
		const rows = this.#tree.rows;
		if (this.#pickerOrder?.rows !== rows) this.#pickerOrder = { rows, order: rows.map(row => row.key) };
		return {
			items: this.#pickerItems.items,
			order: this.#pickerOrder.order,
			selected: this.#tree.selectedKey ?? null,
			current: this.currentLeafId === null ? [] : [this.currentLeafId],
			query: this.getSearchQuery(),
			cursor: this.searchInput.getCursor(),
			filterMode: this.#filterMode,
			total: allRows.length,
			empty: this.#emptyText(),
		};
	}

	#pickerItem(row: TreeRow<TreeSelectorNode, string>, open: boolean): TspPickerItem {
		const item = row.item;
		const entry = item.entry;
		const label = this.#entryParts(item).map(part =>
			span(part.t.includes("\x1b") ? plainText(part.t) : part.t, part.s),
		);
		let kind: TspPickerItem["node"] = "marker";
		let role: string | undefined;
		if (isUserRequestEntry(entry)) {
			kind = "user";
		} else if (entry.type === "message") {
			const message = entry.message;
			if (message.role === "assistant") kind = "assistant";
			else if (message.role === "toolResult") [kind, role] = ["tool", `omp.tool.${message.toolName}`];
			else if (message.role === "bashExecution") [kind, role] = ["tool", "omp.tool.bash"];
			else if (message.role === "pythonExecution") [kind, role] = ["tool", "omp.tool.eval"];
		}
		return {
			id: row.key,
			label,
			depth: row.depth,
			node: kind,
			...(role ? { role } : {}),
			...(open ? { open: true } : {}),
			...(item.label ? { badges: [{ text: plainText(item.label), tone: "warning" as const }] } : {}),
			...(this.#activePathIds.has(row.key) ? { dot: "accent" as const } : {}),
		};
	}

	/**
	 * Preview of the selected entry: a title, its label, and its content as
	 * the transcript shows it (markdown prose, commands and output as code).
	 */
	pickerPreview(): readonly NativeChild[] {
		const selected = this.#tree.selectedItem;
		const memo = this.#previewMemo;
		if (memo !== undefined && memo.node === selected && memo.labels === this.#labelVersion) return memo.preview;
		const preview: NativeChild[] = [];
		if (selected) {
			const entry = selected.entry;
			const parts = this.#entryParts(selected)
				.map(part => (part.t.includes("\x1b") ? plainText(part.t) : part.t))
				.join("");
			if (entry.type === "message" || entry.type === "custom_message") {
				const target: OutlineTarget = {
					entryId: entry.id,
					turnId: entry.id,
					isUserTurn: isUserRequestEntry(entry),
					start: 0,
					end: 0,
					entries: [entry],
				};
				const copy = targetCopy(target, collectBlocks(target.entries));
				preview.push(text(`${copy.label[0]!.toUpperCase()}${copy.label.slice(1)}`, { role: "omp.picker.title" }));
				if (selected.label) preview.push(text([span(plainText(selected.label), "warning")]));
				preview.push(turnPreview(target, copy.content || parts));
			} else {
				preview.push(text(parts, { role: "omp.picker.title" }));
				if (selected.label) preview.push(text([span(plainText(selected.label), "warning")]));
			}
		}
		this.#previewMemo = { node: selected, labels: this.#labelVersion, preview };
		return preview;
	}

	/**
	 * The visible entries as a native `list` keyed `"list"`, items keyed by
	 * entry id. Selection stays omp's; the terminal scrolls and virtualizes.
	 * Branch heads carry a `branch` icon and the active path an accent bullet
	 * instead of drawn tree connectors.
	 */
	describeList(): NativeNode {
		const rows = this.#tree.rows;
		let items = this.#itemsNative;
		if (items?.rows !== rows) {
			items = { rows, items: rows.map(row => this.#describeRow(row)) };
			this.#itemsNative = items;
		}
		const selected = this.#tree.selectedKey;
		const query = this.getSearchQuery();
		const memo = this.#listNative;
		if (
			memo?.items === items.items &&
			memo.selected === selected &&
			memo.query === query &&
			memo.filterMode === this.#filterMode
		) {
			return memo.node;
		}
		const list = node(
			"list",
			{ selected: selected ?? null, filter: query || undefined, empty: this.#emptyText(), virtual: true },
			items.items,
			"list",
		);
		this.#listNative = { items: items.items, selected, query, filterMode: this.#filterMode, node: list };
		return list;
	}

	/** The empty-state explanation from {@link render}, as spans. */
	#emptyText(): TspText {
		const total = this.#tree.allRows.length;
		if (total === 0) return [span("No entries found", "muted")];
		const query = this.getSearchQuery();
		if (query.length > 0) {
			return [
				span(`No entries match search "${query}". Press `, "muted"),
				span("backspace", "key"),
				span(" to clear the search", "muted"),
			];
		}
		const filterLabel = this.#getFilterLabel().trim() || "[default]";
		return [
			span(`${total} entries hidden by the current filter ${filterLabel}. Press `, "muted"),
			span("alt+a", "key"),
			span(" to show all, ", "muted"),
			span("alt+d", "key"),
			span(" for default", "muted"),
		];
	}

	#describeRow(row: TreeRow<TreeSelectorNode, string>): NativeNode {
		const item = row.item;
		const branch = row.parentKey !== undefined && row.siblingCount > 1;
		const cached = this.#itemCache.get(row.key);
		if (cached !== undefined && cached.label === item.label && cached.branch === branch) return cached.node;
		const label: TspSpan[] = [];
		if (this.#activePathIds.has(row.key)) label.push(span(`${theme.md.bullet} `, "accent"));
		if (item.label) label.push(span(`[${plainText(item.label)}] `, "warning"));
		for (const part of this.#entryParts(item)) {
			label.push(span(part.t.includes("\x1b") ? plainText(part.t) : part.t, part.s));
		}
		const described = node("item", { label, icon: branch ? "branch" : undefined }, undefined, row.key);
		this.#itemCache.set(row.key, { label: item.label, branch, node: described });
		return described;
	}

	getSelectedNode(): TreeSelectorNode | undefined {
		return this.#tree.selectedItem;
	}

	updateNodeLabel(entryId: string, label: string | undefined): void {
		const node = this.#nodeById.get(entryId);
		if (node) node.label = label;
		this.#labelVersion++;
		this.#tree.invalidate();
	}

	#getFilterLabel(): string {
		switch (this.#filterMode) {
			case "no-tools":
				return " [no-tools]";
			case "user-only":
				return " [user]";
			case "labeled-only":
				return " [labeled]";
			case "all":
				return " [all]";
			default:
				return "";
		}
	}

	render(width: number): readonly string[] {
		const lines: string[] = [];
		const totalCount = this.#tree.allRows.length;

		if (this.#tree.rows.length === 0) {
			// Three empty-state shapes:
			//  - no rows at all                → no entries at all (truly fresh session).
			//  - search query rejects everything → tell the user the search is the cause.
			//  - filter mode rejects everything  → tell the user the filter is the cause and
			//    how to widen it. Otherwise fresh sessions whose only persisted entries are
			//    `model_change` + `thinking_level_change` (both hidden by the default filter)
			//    read as "broken /tree" — see #1909.
			if (totalCount === 0) {
				lines.push(truncateToWidth(theme.fg("muted", "No entries found"), width));
				lines.push(truncateToWidth(theme.fg("muted", `(0/0)${this.#getFilterLabel()}`), width));
			} else if (this.getSearchQuery().length > 0) {
				lines.push(truncateToWidth(theme.fg("muted", `No entries match search "${this.getSearchQuery()}"`), width));
				lines.push(
					truncateToWidth(theme.fg("muted", `Press ${formatKeyHint("backspace")} to clear the search`), width),
				);
				lines.push(truncateToWidth(theme.fg("muted", `(0/${totalCount})${this.#getFilterLabel()}`), width));
			} else {
				const filterLabel = this.#getFilterLabel().trim() || "[default]";
				lines.push(
					truncateToWidth(
						theme.fg("muted", `${totalCount} entries hidden by the current filter ${filterLabel}`),
						width,
					),
				);
				lines.push(
					truncateToWidth(
						theme.fg(
							"muted",
							`Press ${formatKeyHint("alt+a")} to show all, ${formatKeyHint("alt+d")} for default`,
						),
						width,
					),
				);
				lines.push(truncateToWidth(theme.fg("muted", `(0/${totalCount})${this.#getFilterLabel()}`), width));
			}
			return lines;
		}

		// Hierarchy, selection-centered windowing, and the scrollbar all live
		// in TreeView; the gutter/row builders below only shape its lines.
		lines.push(...this.#tree.render(width));

		const filterLabel = this.#getFilterLabel();
		if (filterLabel) {
			lines.push(truncateToWidth(theme.fg("muted", filterLabel.trim()), width));
		}

		return lines;
	}

	/** Entry text after the tree gutter: active-path marker, label, and display row. */
	#renderTreeRow(node: TreeSelectorNode, selected: boolean): string {
		// Active path marker - shown right before the entry text
		const isOnActivePath = this.#activePathIds.has(node.entry.id);
		const pathMarker = isOnActivePath ? theme.fg("accent", `${theme.md.bullet} `) : "";
		const label = node.label ? theme.fg("warning", `[${node.label}] `) : "";
		return `${pathMarker}${label}${this.#getEntryDisplayText(node, selected)}`;
	}

	/**
	 * Custom gutter geometry over TreeView rows. Connectors draw only at real
	 * branch points (`siblingCount > 1`); session roots under the virtual
	 * multi-root stay connector-free, and linear chains keep their branch
	 * head's depth. Gutter depth is capped like before (issue #1144): each
	 * level renders as 3 cells, older levels compress behind a leading `…`,
	 * and one shared horizontal offset keeps every row describing one shape.
	 */
	#renderGutter(
		row: TreeRow<TreeSelectorNode, string>,
		width: number,
		windowRows: readonly TreeRow<TreeSelectorNode, string>[],
	): { first: string; continuation: string } {
		// Cap the per-row gutter prefix so a content budget is always preserved.
		// Reserve at least MIN_CONTENT_COLS for entry text — or half the
		// viewport, whichever is larger — and compress older gutter levels
		// off-screen behind a leading ellipsis when the row would exceed budget.
		const MIN_CONTENT_COLS = 24;
		const OVERHEAD_COLS = 4; // cursor (2) + a touch of breathing room
		const contentReserve = Math.max(MIN_CONTENT_COLS, Math.floor(width / 2));
		const maxIndentLevels = Math.max(1, Math.floor((width - contentReserve - OVERHEAD_COLS) / 3));

		// One horizontal scroll position for the whole window: a per-row offset
		// would put a different tree depth in the same column on each line, so
		// connectors and gutters would stop describing one shape.
		let deepest = row.depth;
		for (const windowRow of windowRows) {
			deepest = Math.max(deepest, windowRow.depth);
		}
		const windowOffset = Math.max(0, deepest - maxIndentLevels);

		const displayIndent = row.depth;
		const hasConnector = row.parentKey !== undefined && row.siblingCount > 1;
		const connectorSymbol = hasConnector ? (row.isLast ? theme.tree.last : theme.tree.branch) : "";
		const connectorChars = hasConnector ? Array.from(connectorSymbol) : [];
		const scrollOffset = Math.min(windowOffset, displayIndent);
		const renderedIndent = displayIndent - scrollOffset;
		const connectorPositionDisplay = hasConnector ? renderedIndent - 1 : -1;
		// Linear rows reuse their branch head's depth. Existing sibling
		// gutters remain visible; terminal gutters remain terminated.

		// Branch points that can draw a gutter, indexed by rendered level: the
		// ancestor list is as deep as the conversation, so it is scanned once
		// per row rather than once per prefix cell.
		// oxlint-disable-next-line unicorn/no-new-array -- length preallocation
		const gutterByLevel: (TreeAncestor<string> | undefined)[] = new Array(renderedIndent);
		for (const ancestor of row.ancestors) {
			if (ancestor.siblingCount <= 1) continue;
			if (this.#multipleRoots && this.#rootIds.has(ancestor.key)) continue;
			const level = ancestor.depth - 1 - scrollOffset;
			if (level >= 0 && level < renderedIndent && gutterByLevel[level] === undefined) {
				gutterByLevel[level] = ancestor;
			}
		}
		// Build prefix char by char, placing gutters and connector at their positions
		const totalChars = renderedIndent * 3;
		const prefixChars: string[] = [];
		for (let i = 0; i < totalChars; i++) {
			const level = Math.floor(i / 3);
			const posInLevel = i % 3;
			const gutterAncestor = gutterByLevel[level];
			if (gutterAncestor) {
				// Gutters follow standard tree semantics: `│` only while more
				// siblings continue below, space below a `└─`.
				if (posInLevel === 0) {
					prefixChars.push(gutterAncestor.isLast ? " " : theme.tree.vertical);
				} else {
					prefixChars.push(" ");
				}
			} else if (hasConnector && level === connectorPositionDisplay) {
				// Connector at this level
				if (posInLevel === 0) {
					prefixChars.push(connectorChars[0] ?? " ");
				} else if (posInLevel === 1) {
					prefixChars.push(connectorChars[1] ?? theme.tree.horizontal);
				} else {
					prefixChars.push(connectorChars[2] ?? " ");
				}
			} else {
				prefixChars.push(" ");
			}
		}
		// Mark the leftmost cell when ancestors were compressed off-screen.
		if (scrollOffset > 0 && prefixChars.length > 0) {
			prefixChars[0] = "…";
		}
		const prefix = theme.fg("dim", prefixChars.join(""));
		return { first: prefix, continuation: prefix };
	}

	#getEntryDisplayText(node: TreeSelectorNode, isSelected: boolean): string {
		let result = "";
		for (const part of this.#entryParts(node)) result += part.s ? theme.fg(part.s, part.t) : part.t;
		return isSelected ? theme.bold(result) : result;
	}

	/** Entry display text as theme-colored parts, shared by the ANSI row and the native item label. */
	#entryParts(node: TreeSelectorNode): readonly EntryPart[] {
		const entry = node.entry;
		const normalize = (s: string) => s.replace(/[\n\t]/g, " ").trim();

		switch (entry.type) {
			case "message": {
				const msg = entry.message;
				const role = msg.role;
				if (role === "user") {
					const msgWithContent = msg as { content?: unknown };
					const content = normalize(this.#extractContent(msgWithContent.content));
					return [{ t: "user: ", s: "accent" }, { t: content }];
				}
				if (role === "developer") {
					const msgWithContent = msg as { content?: unknown };
					const content = normalize(this.#extractContent(msgWithContent.content));
					return [
						{ t: "developer: ", s: "dim" },
						{ t: content, s: "muted" },
					];
				}
				if (role === "assistant") {
					const presentation = resolveAssistantErrorPresentation(msg);
					if (presentation.kind === "compact-recovered") {
						return [
							{ t: "assistant: ", s: "success" },
							{ t: presentation.text, s: "dim" },
						];
					}
					const msgWithContent = msg as { content?: unknown; stopReason?: string; errorMessage?: string };
					const textContent = normalize(this.#extractContent(msgWithContent.content));
					const head: EntryPart = { t: "assistant: ", s: "success" };
					if (textContent) return [head, { t: textContent }];
					if (presentation.kind === "full") {
						return [head, { t: normalize(presentation.text).slice(0, 80), s: "error" }];
					}
					if (msgWithContent.stopReason === "aborted") return [head, { t: "(aborted)", s: "muted" }];
					return [head, { t: "(no content)", s: "muted" }];
				}
				if (role === "toolResult") {
					const toolMsg = msg as { toolCallId?: string; toolName?: string };
					const toolCall = toolMsg.toolCallId ? this.#toolCallMap.get(toolMsg.toolCallId) : undefined;
					if (toolCall) return [{ t: this.#formatToolCall(toolCall.name, toolCall.arguments), s: "muted" }];
					return [{ t: `[${toolMsg.toolName ?? "tool"}]`, s: "muted" }];
				}
				if (role === "bashExecution") {
					const bashMsg = msg as { command?: string };
					return [{ t: `[bash]: ${normalize(bashMsg.command ?? "")}`, s: "dim" }];
				}
				return [{ t: `[${role}]`, s: "dim" }];
			}
			case "custom_message": {
				if (entry.customType === "advisor") {
					const { qualifier, text } = advisorTreeDisplay(entry.details);
					const label = qualifier ? `advisor (${qualifier}): ` : "advisor: ";
					return [{ t: label, s: "customMessageLabel" }, { t: normalize(text) }];
				}
				const content = stripSystemWrapperTags(this.#joinTextContent(entry.content));
				return [{ t: `[${entry.customType}]: `, s: "customMessageLabel" }, { t: normalize(content) }];
			}
			case "compaction": {
				const tokens = Math.round(entry.tokensBefore / 1000);
				return [{ t: `[compaction: ${tokens}k tokens]`, s: "borderAccent" }];
			}
			case "branch_summary":
				return [{ t: `[branch summary]: `, s: "warning" }, { t: normalize(entry.summary) }];
			case "model_change":
				return [{ t: `[model: ${entry.model}]`, s: "dim" }];
			case "model_usage": {
				const purpose = sanitizeTreeField(entry.purpose);
				const role = sanitizeTreeField(entry.role ?? "");
				const provider = sanitizeTreeField(entry.provider);
				const model = sanitizeTreeField(entry.model);
				return [{ t: `[model usage: ${purpose} ${role ? `${role} ` : ""}${provider}/${model}]`, s: "dim" }];
			}
			case "thinking_level_change":
				return [{ t: `[thinking: ${entry.thinkingLevel ?? ThinkingLevel.Off}]`, s: "dim" }];
			case "custom":
				return [{ t: `[custom: ${entry.customType}]`, s: "dim" }];
			case "label":
				return [{ t: `[label: ${entry.label ?? "(cleared)"}]`, s: "dim" }];
			case "service_tier_change": {
				// Per-family map, or null when the session went back to the default.
				const tiers = entry.serviceTier
					? Object.entries(entry.serviceTier)
							.map(([family, tier]) => `${family}:${tier}`)
							.join(" ")
					: "(default)";
				return [{ t: `[service tier: ${tiers}]`, s: "dim" }];
			}
			case "title_change":
				return [{ t: `[title: ${normalize(entry.title)}]`, s: "dim" }];
			case "mode_change":
				return [{ t: `[mode: ${entry.mode}]`, s: "dim" }];
			case "credential_pin":
				return [{ t: `[credential pin: ${entry.provider}]`, s: "dim" }];
			default:
				// Bookkeeping entries with nothing worth spelling out still get their
				// type. A row that renders to the empty string is worse than a
				// useless one: it draws as a bare bullet with no way to tell what it
				// is or why the tree has a gap in it.
				return [{ t: `[${entry.type.replaceAll("_", " ")}]`, s: "dim" }];
		}
	}

	#extractContent(content: unknown): string {
		return this.#joinTextContent(content, SEARCH_TEXT_LIMIT);
	}

	/** Concatenate text blocks, stopping as soon as `limit` characters exist. */
	#joinTextContent(content: unknown, limit = Number.POSITIVE_INFINITY): string {
		if (typeof content === "string") return content.length > limit ? content.slice(0, limit) : content;
		if (Array.isArray(content)) {
			let result = "";
			for (const c of content) {
				if (
					typeof c === "object" &&
					c !== null &&
					"type" in c &&
					c.type === "text" &&
					"text" in c &&
					typeof c.text === "string"
				) {
					result += c.text;
					if (result.length >= limit) return result.slice(0, limit);
				}
			}
			return result;
		}
		return "";
	}

	#hasTextContent(content: unknown): boolean {
		if (typeof content === "string") return Boolean(canonicalizeMessage(content));
		if (Array.isArray(content)) {
			for (const c of content) {
				if (typeof c === "object" && c !== null && "type" in c && c.type === "text") {
					const text = (c as { text?: string }).text;
					if (text && canonicalizeMessage(text)) return true;
				}
			}
		}
		return false;
	}

	#formatToolCall(name: string, args: Record<string, unknown>): string {
		switch (name) {
			case "read": {
				const path = shortenPath(String(args.path || args.file_path || ""));
				const offset = args.offset as number | undefined;
				const limit = args.limit as number | undefined;
				let display = path;
				if (offset !== undefined || limit !== undefined) {
					const start = offset ?? 1;
					const end = limit !== undefined ? start + limit - 1 : "";
					display += `:${start}${end ? `-${end}` : ""}`;
				}
				return `[read: ${display}]`;
			}
			case "write": {
				const path = shortenPath(String(args.path || args.file_path || ""));
				return `[write: ${path}]`;
			}
			case "edit": {
				const path = shortenPath(String(args.path || args.file_path || ""));
				return `[edit: ${path}]`;
			}
			case "bash": {
				const rawCmd = String(args.command || "");
				const cmd = rawCmd
					.replace(/[\n\t]/g, " ")
					.trim()
					.slice(0, 50);
				return `[bash: ${cmd}${rawCmd.length > 50 ? "..." : ""}]`;
			}
			case "grep": {
				const pattern = String(args.pattern || "");
				const searchPathsInput =
					typeof args.paths === "string" || Array.isArray(args.paths)
						? args.paths
						: typeof args.path === "string"
							? args.path
							: undefined;
				const paths = toPathList(searchPathsInput);
				const scope = paths.length > 0 ? paths.join(", ") : ".";
				return `[grep: /${pattern}/ in ${shortenPath(scope)}]`;
			}
			case "glob": {
				const globInput =
					typeof args.path === "string"
						? args.path
						: typeof args.paths === "string" || Array.isArray(args.paths)
							? args.paths
							: undefined;
				const paths = toPathList(globInput);
				const scope = paths.length > 0 ? paths.join(", ") : ".";
				return `[glob: ${shortenPath(scope)}]`;
			}
			case "ls": {
				const path = shortenPath(String(args.path || "."));
				return `[ls: ${path}]`;
			}
			default: {
				// Custom tool - show name and truncated JSON args
				const argsStr = JSON.stringify(args).slice(0, 40);
				return `[${name}: ${argsStr}${JSON.stringify(args).length > 40 ? "..." : ""}]`;
			}
		}
	}

	/** Enter (`summarize` false) / Shift+Enter: switch to the selected entry. */
	confirm(summarize: boolean): void {
		const selected = this.#tree.selectedItem;
		if (selected && this.onSelect) this.onSelect(selected.entry.id, { summarize });
	}

	/** Esc: clear the search first, then close. */
	escape(): void {
		if (this.getSearchQuery()) this.clearSearch();
		else this.onCancel?.();
	}

	clearSearch(): void {
		this.searchInput.setValue("");
		this.#applyFilter();
	}

	/** Ctrl+O / Shift+Ctrl+O: default → no-tools → user-only → labeled-only → all → default. */
	cycleFilter(delta: 1 | -1): void {
		const modes = TREE_FILTER_MODES;
		const currentIndex = modes.indexOf(this.#filterMode);
		this.#filterMode = modes[(currentIndex + delta + modes.length) % modes.length];
		this.#applyFilter();
	}

	/** Shift+L: edit the selected entry's label. */
	editLabel(): void {
		const selected = this.#tree.selectedItem;
		if (selected && this.onLabelEdit) this.onLabelEdit(selected.entry.id, selected.label);
	}

	handleInput(keyData: string): void {
		if (matchesSelectUp(keyData)) {
			this.#tree.moveSelection(-1, true);
		} else if (matchesSelectDown(keyData)) {
			this.#tree.moveSelection(1, true);
		} else if (matchesKey(keyData, "alt+up")) {
			this.#tree.moveSelectionWhere(
				node =>
					node.entry.type === "message" &&
					(node.entry.message.role === "user" || node.entry.message.role === "assistant"),
				-1,
			);
		} else if (matchesKey(keyData, "alt+down")) {
			this.#tree.moveSelectionWhere(
				node =>
					node.entry.type === "message" &&
					(node.entry.message.role === "user" || node.entry.message.role === "assistant"),
				1,
			);
		} else if (matchesKey(keyData, "home")) {
			this.#tree.setSelectionIndex(0);
		} else if (matchesKey(keyData, "end")) {
			this.#tree.setSelectionIndex(this.#tree.rows.length - 1);
		} else if (matchesSelectPageUp(keyData) || matchesKey(keyData, "left")) {
			this.#tree.moveSelection(-this.maxVisibleLines);
		} else if (matchesSelectPageDown(keyData) || matchesKey(keyData, "right")) {
			this.#tree.moveSelection(this.maxVisibleLines);
		} else if (
			matchesKey(keyData, "shift+enter") ||
			matchesKey(keyData, "shift+return") ||
			keyData === "\n" || // Shift+Enter delivered as bare LF (iTerm2 legacy mapping) — matches the composer (issue #8821)
			keyData === "\x1b[13;2~" // Shift+Enter legacy CSI ~ form — also accepted by the composer (editor.ts:1466)
		) {
			// Summarize-and-switch: fork with a branch summary without the extra prompt.
			this.confirm(true);
		} else if (matchesKey(keyData, "enter") || matchesKey(keyData, "return")) {
			this.confirm(false);
		} else if (matchesAppInterrupt(keyData)) {
			this.escape();
		} else if (matchesKey(keyData, "ctrl+c")) {
			this.onCancel?.();
		} else if (matchesKey(keyData, "shift+ctrl+o") || matchesKey(keyData, "ctrl+shift+o")) {
			this.cycleFilter(-1);
		} else if (matchesKey(keyData, "ctrl+o")) {
			this.cycleFilter(1);
		} else if (matchesKey(keyData, "alt+d")) {
			this.#filterMode = "default";
			this.#applyFilter();
		} else if (matchesKey(keyData, "alt+t")) {
			this.#filterMode = "no-tools";
			this.#applyFilter();
		} else if (matchesKey(keyData, "alt+u")) {
			this.#filterMode = "user-only";
			this.#applyFilter();
		} else if (matchesKey(keyData, "alt+l")) {
			this.#filterMode = "labeled-only";
			this.#applyFilter();
		} else if (matchesKey(keyData, "alt+a")) {
			this.#filterMode = "all";
			this.#applyFilter();
		} else if (matchesKey(keyData, "shift+l") && !this.getSearchQuery()) {
			this.editLabel();
		} else {
			const before = this.getSearchQuery();
			if (this.searchInput.handleInput(keyData) && this.getSearchQuery() !== before) this.#applyFilter();
		}
	}
}

/** Component that displays the current search query */
class SearchLine implements Component {
	constructor(private treeList: TreeList) {}

	invalidate(): void {}

	render(width: number): readonly string[] {
		return this.treeList.searchInput.render(width);
	}

	handleInput(_keyData: string): void {}
}

/** Label input component shown when editing a label */
class LabelInput implements Component {
	#input: Input;
	onSubmit?: (entryId: string, label: string | undefined) => void;
	onCancel?: () => void;

	#native: NativeNode | undefined;
	#preview: readonly NativeChild[] | undefined;

	constructor(
		private readonly entryId: string,
		currentLabel: string | undefined,
	) {
		this.#input = new Input();
		if (currentLabel) {
			this.#input.setValue(currentLabel);
		}
	}

	invalidate(): void {}

	/** Prompt, the label `Input`, and save/cancel hints; the Input describes its own edits. */
	describe(_cx: DescribeContext): NativeNode {
		this.#native ??= node("col", { gap: "xs" }, [
			text([span("Label (empty to remove):", "muted")]),
			this.#input,
			hintsRow([
				{ keys: ["enter"], label: "save" },
				{ keys: [boundKeys("app.interrupt", ["escape"])[0] ?? "escape"], label: "cancel" },
			]),
		]);
		return this.#native;
	}

	/** The picker preview while editing: the prompt and the label `Input` (save/cancel sit in the action bar). */
	get preview(): readonly NativeChild[] {
		this.#preview ??= [
			text("Label", { role: "omp.picker.title" }),
			text([span("Empty to remove", "muted")]),
			this.#input,
		];
		return this.#preview;
	}

	/** Enter: save the label (empty removes it). */
	submit(): void {
		const value = this.#input.getValue().trim();
		this.onSubmit?.(this.entryId, value || undefined);
	}

	render(width: number): readonly string[] {
		const lines: string[] = [];
		lines.push(truncateToWidth(theme.fg("muted", "Label (empty to remove):"), width));
		lines.push(...this.#input.render(width));
		const cancel = interruptKey();
		lines.push(truncateToWidth(theme.fg("dim", `${formatKeyHint("enter")}: save  ${cancel}: cancel`), width));
		return lines;
	}

	handleInput(keyData: string): void {
		if (matchesKey(keyData, "enter") || matchesKey(keyData, "return") || keyData === "\n") {
			this.submit();
		} else if (matchesAppInterrupt(keyData)) {
			this.onCancel?.();
		} else {
			this.#input.handleInput(keyData);
		}
	}
}

/**
 * Component that renders a session tree selector for navigation
 */
export class TreeSelectorComponent extends OverlayPanel {
	#treeList: TreeList;
	#labelInput: LabelInput | null = null;
	#labelInputContainer: Container;
	#treeContainer: Container;
	#nativeMemo:
		| {
				content: NativeChild;
				query: string;
				cursor: number;
				filterMode: FilterMode;
				node: NativeNode;
		  }
		| undefined;
	#pickerMemo:
		| {
				view: TreePickerView;
				preview: readonly NativeChild[];
				label: LabelInput | null;
				node: NativeNode;
		  }
		| undefined;

	constructor(
		tree: TreeSelectorNode[],
		currentLeafId: string | null,
		terminalHeight: number,
		onSelect: (entryId: string, options: { summarize: boolean }) => void,
		onCancel: () => void,
		private readonly onLabelChangeCallback?: (entryId: string, label: string | undefined) => void,
		initialFilterMode: FilterMode = "default",
		/** The picker's subtitle. */
		private readonly sessionName?: string,
	) {
		super("Session Tree");
		// The outer panel has eight fixed rows around the tree list: top/bottom
		// borders, the two spacers, help, search, and section divider.
		const PANEL_CHROME_ROWS = 8;
		const maxVisibleLines = Math.max(
			1,
			Math.min(Math.max(5, Math.floor(terminalHeight / 2)), terminalHeight - PANEL_CHROME_ROWS),
		);

		this.#treeList = new TreeList(tree, currentLeafId, maxVisibleLines, initialFilterMode);
		this.#treeList.onSelect = onSelect;
		this.#treeList.onCancel = onCancel;
		this.#treeList.onLabelEdit = (entryId, currentLabel) => this.#showLabelInput(entryId, currentLabel);

		this.#treeContainer = new Container();
		this.#treeContainer.addChild(this.#treeList);

		this.#labelInputContainer = new Container();

		this.addChild(new Spacer(1));
		this.addChild(
			new TruncatedText(
				theme.fg(
					"muted",
					[
						`${formatKeyHint("enter")}: switch.`,
						`${formatKeyHints(["alt+up", "alt+down"])}: previous/next turn.`,
						`${editorKeys("tui.select.pageUp", "tui.select.pageDown")} (${formatKeyHints(["left", "right"])}): page.`,
						`${formatKeyHints(["home", "end"])}: first/last item.`,
						`${formatKeyHint("shift+enter")}: summarize & switch.`,
						`${formatKeyHint("shift+l")}: label.`,
						`${formatKeyHint("ctrl+o")}: filter.`,
						`${formatKeyHints(["alt+d", "alt+t", "alt+u", "alt+l", "alt+a"])}: filter.`,
						"Type to search",
					].join(" "),
				),
				0,
				0,
			),
		);
		this.addChild(new SearchLine(this.#treeList));
		this.addChild(new PanelDivider());
		this.addChild(new Spacer(1));
		this.addChild(this.#treeContainer);
		this.addChild(this.#labelInputContainer);
		this.addChild(new Spacer(1));

		if (tree.length === 0) {
			setTimeout(() => onCancel(), 100);
		}
	}

	override describe(cx: DescribeContext): NativeNode {
		return cx.supports("picker") ? this.#describePicker() : this.#describeCard();
	}

	/**
	 * The `tree` picker, keyed `picker` inside a column: mounted in the dock,
	 * the reconciler hoists it into `layer` as a sheet. The label editor
	 * takes the preview pane while open.
	 */
	#describePicker(): NativeNode {
		const view = this.#treeList.pickerView();
		const label = this.#labelInput;
		const preview = label ? label.preview : this.#treeList.pickerPreview();
		const memo = this.#pickerMemo;
		if (
			memo?.label === label &&
			memo.preview === preview &&
			memo.view.items === view.items &&
			memo.view.order === view.order &&
			memo.view.selected === view.selected &&
			memo.view.query === view.query &&
			memo.view.cursor === view.cursor &&
			memo.view.filterMode === view.filterMode
		) {
			return memo.node;
		}
		const props: TspPickerProps = {
			title: "Session tree",
			...(this.sessionName ? { subtitle: this.sessionName } : {}),
			icon: "git-branch",
			noun: "entries",
			size: "lg",
			layout: "tree",
			preview: "side",
			...pickerQuery(this.#treeList.searchInput),
			placeholder: "Search entries…",
			tabs: FILTER_TABS,
			tab: view.filterMode,
			items: view.items,
			order: view.order,
			selected: view.selected,
			current: view.current,
			total: view.total,
			empty: view.empty,
			focus: label ? "preview" : "list",
			actions: label
				? [
						pickerAction("label-save", "Save label", "enter", { primary: true }),
						{ ...CLOSE_ACTION, label: "Cancel" },
					]
				: [
						pickerAction("switch", "Switch", "enter", { primary: true }),
						pickerAction("summarize", "Summarize & switch", "shift+enter"),
						pickerAction("label", "Label", "shift+l"),
						pickerAction("filter", "Filter", "ctrl+o"),
						CLOSE_ACTION,
					],
		};
		const result = col([keyed(picker(props, preview), "picker")]);
		this.#pickerMemo = { view, preview, label, node: result };
		return result;
	}

	/** Picker pointer events run the same paths as their keys; the label editor owns them while open. */
	#handlePickerEvent(event: PickerEvent): void {
		const label = this.#labelInput;
		if (label) {
			if (event.kind !== "action") return;
			if (event.act === "label-save") label.submit();
			else if (event.act === "close") label.onCancel?.();
			return;
		}
		const list = this.#treeList;
		if (event.kind !== "action") {
			if (event.kind === "select") list.selectEntry(event.item);
			else list.activateEntry(event.item);
			return;
		}
		switch (event.act) {
			case "tab":
				if (event.value !== undefined) list.setFilterMode(event.value);
				return;
			case "switch":
				list.confirm(false);
				return;
			case "summarize":
				list.confirm(true);
				return;
			case "label":
				if (!list.getSearchQuery()) list.editLabel();
				return;
			case "filter":
				list.cycleFilter(1);
				return;
			case "close":
				list.escape();
				return;
			case "clear":
				list.clearSearch();
				return;
			default:
				return;
		}
	}

	/**
	 * Native tree: filter-mode `tabs`, the search query as an `input`, then
	 * the entry `list` (or the label editor in its place) and the key hints.
	 */
	#describeCard(): NativeNode {
		const content: NativeChild = this.#labelInput ?? this.#treeList.describeList();
		const search = this.#treeList.searchInput;
		const query = search.getValue();
		const cursor = search.getCursor();
		const filterMode = this.#treeList.getFilterMode();
		const memo = this.#nativeMemo;
		if (
			memo?.content === content &&
			memo.query === query &&
			memo.cursor === cursor &&
			memo.filterMode === filterMode
		) {
			return memo.node;
		}
		const children: NativeChild[] = [
			node("tabs", { items: FILTER_TABS, active: filterMode }, undefined, "filter"),
			search,
			content,
			hintsRow([
				{ keys: ["enter"], label: "switch" },
				{ keys: ["alt+up", "alt+down"], label: "previous/next turn" },
				actionHint(["tui.select.pageUp", "tui.select.pageDown"], "page"),
				{ keys: ["home", "end"], label: "first/last" },
				{ keys: ["shift+enter"], label: "summarize & switch" },
				{ keys: ["shift+l"], label: "label" },
				{ keys: ["ctrl+o"], label: "filter" },
			]),
		];
		const result = overlayCard("omp.overlay.tree", "Session Tree", children);
		this.#nativeMemo = { content, query, cursor, filterMode, node: result };
		return result;
	}

	/** Filter tab → switch mode; entry click → highlight it and switch, exactly like Enter. */
	handleNativeEvent(event: NativeUiEvent): void {
		const picked = pickerEvent(event, "picker");
		if (picked) {
			this.#handlePickerEvent(picked);
			return;
		}
		if (event.type !== "select" && event.type !== "activate") return;
		if (event.key === "filter") {
			if (event.type === "select") this.#treeList.setFilterMode(event.item);
			return;
		}
		if (event.key === "list" && !this.#labelInput) this.#treeList.activateEntry(event.item);
	}

	#showLabelInput(entryId: string, currentLabel: string | undefined): void {
		this.#labelInput = new LabelInput(entryId, currentLabel);
		this.#labelInput.onSubmit = (id, label) => {
			this.#treeList.updateNodeLabel(id, label);
			this.onLabelChangeCallback?.(id, label);
			this.#hideLabelInput();
		};
		this.#labelInput.onCancel = () => this.#hideLabelInput();

		this.#treeContainer.clear();
		this.#labelInputContainer.clear();
		this.#labelInputContainer.addChild(this.#labelInput);
	}

	#hideLabelInput(): void {
		this.#labelInput = null;
		this.#labelInputContainer.clear();
		this.#treeContainer.clear();
		this.#treeContainer.addChild(this.#treeList);
	}

	handleInput(keyData: string): void {
		if (this.#labelInput) {
			this.#labelInput.handleInput(keyData);
		} else {
			this.#treeList.handleInput(keyData);
		}
	}

	getTreeList(): TreeList {
		return this.#treeList;
	}
}
