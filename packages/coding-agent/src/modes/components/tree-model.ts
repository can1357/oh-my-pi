/**
 * Pure session-tree navigation model: flattening, active-path resolution,
 * filter modes, and searchable text. Shared by the interactive `/tree`
 * selector (`tree-selector.ts`) and the RPC `get_navigation_tree` handler so
 * remote clients see the same rows the TUI renders.
 */
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { fuzzyMatch } from "@oh-my-pi/pi-tui";
import { isRecord, sanitizeText } from "@oh-my-pi/pi-utils";
import type { TreeFilterMode } from "../../config/settings-schema";
import type { SessionEntry, SessionTreeNode } from "../../session/session-entries";
import { canonicalizeMessage } from "../../utils/thinking-display";

/** Gutter info: position (displayIndent where connector was) and whether to show │ */
export interface GutterInfo {
	position: number; // displayIndent level where the connector was shown
	show: boolean; // true = show │, false = show spaces
}

/** Flattened tree node for navigation */
export interface FlatNode {
	node: SessionTreeNode;
	/** Indentation level (each level = 3 chars) */
	indent: number;
	/** Whether to show connector (├─ or └─) - true if parent has multiple children */
	showConnector: boolean;
	/** If showConnector, true = last sibling (└─), false = not last (├─) */
	isLast: boolean;
	/** Gutter info for each ancestor branch point */
	gutters: GutterInfo[];
	/** True if this node is a root under a virtual branching root (multiple roots) */
	isVirtualRootChild: boolean;
}

/** Tool call info for lookup */
export interface ToolCallInfo {
	name: string;
	arguments: Record<string, unknown>;
}

/** Advisor note metadata surfaced on a single session-tree row. */
export interface AdvisorTreeDisplay {
	/** Non-default advisor names then severities, comma-joined (e.g. `sec, blocker`). */
	qualifier: string;
	/** Note bodies joined into one line. */
	text: string;
}

/** Per-message cap on text folded into the tree search index. */
export const SEARCH_TEXT_LIMIT = 200;

/**
 * Collapse a raw advisor field (a `WATCHDOG.yml`-supplied name or severity) to
 * a single safe line: strip ANSI/control characters via the shared sanitizer,
 * then fold the tab/newline it intentionally preserves into spaces so the value
 * cannot split or misalign a session-tree row.
 */
function sanitizeAdvisorField(value: string): string {
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
export function advisorTreeDisplay(details: unknown): AdvisorTreeDisplay {
	if (!isRecord(details) || !Array.isArray(details.notes)) return { qualifier: "", text: "" };
	const notes: string[] = [];
	const advisors: string[] = [];
	const severities: string[] = [];
	for (const note of details.notes) {
		if (!isRecord(note)) continue;
		if (typeof note.note === "string") notes.push(note.note);
		if (typeof note.advisor === "string") {
			const name = sanitizeAdvisorField(note.advisor);
			if (name && name !== "default" && !advisors.includes(name)) advisors.push(name);
		}
		if (typeof note.severity === "string") {
			const severity = sanitizeAdvisorField(note.severity);
			if (severity && !severities.includes(severity)) severities.push(severity);
		}
	}
	return { qualifier: [...advisors, ...severities].join(", "), text: notes.join(" ") };
}

/**
 * Strip one model-facing `<system-*>` envelope from custom-message content.
 * Nested system tags belong to the recorded payload and remain visible.
 */
export function stripSystemWrapperTags(content: string): string {
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

/** Concatenate every text block (or return a string as-is) with no length cap. */
export function joinTextContent(content: unknown): string {
	if (typeof content === "string") return content;
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
			}
		}
		return result;
	}
	return "";
}

export function extractContent(content: unknown): string {
	return joinTextContent(content).slice(0, SEARCH_TEXT_LIMIT);
}

export function hasTextContent(content: unknown): boolean {
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

/**
 * Flatten the session tree for navigation: active branch first, real branch
 * points add one indentation level, and multiple roots nest under a virtual
 * branching root. Also collects the tool-call lookup used to render toolResult
 * rows. Pure projection — the session tree is not mutated.
 */
export function flattenSessionTree(
	roots: SessionTreeNode[],
	currentLeafId: string | null,
): { flatNodes: FlatNode[]; toolCallMap: Map<string, ToolCallInfo> } {
	const result: FlatNode[] = [];
	const toolCallMap = new Map<string, ToolCallInfo>();

	// A real branch point adds one indentation level. Linear conversation
	// chains retain that level so their text stays aligned with the branch
	// head instead of drifting right after every fork.

	// Stack items: [node, indent, showConnector, isLast, gutters, isVirtualRootChild]
	type StackItem = [SessionTreeNode, number, boolean, boolean, GutterInfo[], boolean];
	const stack: StackItem[] = [];

	// Determine which subtrees contain the active leaf (to sort current branch first)
	// Use iterative post-order traversal to avoid stack overflow
	const containsActive = new Map<SessionTreeNode, boolean>();
	const leafId = currentLeafId;
	{
		// Build list in pre-order, then process in reverse for post-order effect
		const allNodes: SessionTreeNode[] = [];
		const preOrderStack: SessionTreeNode[] = [...roots];
		while (preOrderStack.length > 0) {
			const node = preOrderStack.pop()!;
			allNodes.push(node);
			// Push children in reverse so they're processed left-to-right
			for (let i = node.children.length - 1; i >= 0; i--) {
				preOrderStack.push(node.children[i]);
			}
		}
		// Process in reverse (post-order): children before parents
		for (let i = allNodes.length - 1; i >= 0; i--) {
			const node = allNodes[i];
			let has = leafId !== null && node.entry.id === leafId;
			for (const child of node.children) {
				if (containsActive.get(child)) {
					has = true;
				}
			}
			containsActive.set(node, has);
		}
	}

	// Add roots in reverse order, prioritizing the one containing the active leaf
	// If multiple roots, treat them as children of a virtual root that branches
	const multipleRoots = roots.length > 1;
	const orderedRoots = [...roots].sort((a, b) => Number(containsActive.get(b)) - Number(containsActive.get(a)));
	for (let i = orderedRoots.length - 1; i >= 0; i--) {
		const isLast = i === orderedRoots.length - 1;
		stack.push([orderedRoots[i], multipleRoots ? 1 : 0, multipleRoots, isLast, [], multipleRoots]);
	}

	while (stack.length > 0) {
		const [node, indent, showConnector, isLast, gutters, isVirtualRootChild] = stack.pop()!;

		// Extract tool calls from assistant messages for later lookup
		const entry = node.entry;
		if (entry.type === "message" && entry.message.role === "assistant") {
			const content = (entry.message as { content?: unknown }).content;
			if (Array.isArray(content)) {
				for (const block of content) {
					if (typeof block === "object" && block !== null && "type" in block && block.type === "toolCall") {
						const tc = block as { id: string; name: string; arguments: Record<string, unknown> };
						toolCallMap.set(tc.id, { name: tc.name, arguments: tc.arguments });
					}
				}
			}
		}

		result.push({ node, indent, showConnector, isLast, gutters, isVirtualRootChild });

		const children = node.children;
		const multipleChildren = children.length > 1;

		// Order children so the branch containing the active leaf comes first
		const orderedChildren = (() => {
			const prioritized: SessionTreeNode[] = [];
			const rest: SessionTreeNode[] = [];
			for (const child of children) {
				if (containsActive.get(child)) {
					prioritized.push(child);
				} else {
					rest.push(child);
				}
			}
			return [...prioritized, ...rest];
		})();

		// Real branch points add visual depth, and a virtual root's direct
		// children (the session roots) nest one level under the shared column-0
		// root. Linear continuations otherwise stay aligned with their head.
		const childIndent = multipleChildren || isVirtualRootChild ? indent + 1 : indent;

		// Build gutters for children
		// If this node showed a connector, add a gutter entry for descendants
		// Only add gutter if connector is actually displayed (not suppressed for virtual root children)
		const connectorDisplayed = showConnector && !isVirtualRootChild;
		// When connector is displayed, add a gutter entry at the connector's position
		// Connector is at position (displayIndent - 1), so gutter should be there too
		const currentDisplayIndent = multipleRoots ? Math.max(0, indent - 1) : indent;
		const connectorPosition = Math.max(0, currentDisplayIndent - 1);
		const childGutters: GutterInfo[] = connectorDisplayed
			? [...gutters, { position: connectorPosition, show: !isLast }]
			: gutters;

		// Add children in reverse order
		for (let i = orderedChildren.length - 1; i >= 0; i--) {
			const childIsLast = i === orderedChildren.length - 1;
			stack.push([orderedChildren[i], childIndent, multipleChildren, childIsLast, childGutters, false]);
		}
	}

	return { flatNodes: result, toolCallMap };
}

/** Build the set of entry IDs on the path from root to current leaf. */
export function buildActivePathIds(flatNodes: FlatNode[], currentLeafId: string | null): Set<string> {
	const activePathIds = new Set<string>();
	if (!currentLeafId) return activePathIds;

	// Build a map of id -> entry for parent lookup
	const entryMap = new Map<string, FlatNode>();
	for (const flatNode of flatNodes) {
		entryMap.set(flatNode.node.entry.id, flatNode);
	}

	// Walk from leaf to root
	let currentId: string | null = currentLeafId;
	while (currentId) {
		activePathIds.add(currentId);
		const node = entryMap.get(currentId);
		if (!node) break;
		currentId = node.node.entry.parentId ?? null;
	}
	return activePathIds;
}

/**
 * Entry types hidden in default view (settings/bookkeeping). These carry
 * no conversation content, so the tree only shows them in "all" mode.
 */
function isSettingsEntry(entry: SessionEntry): boolean {
	return (
		entry.type === "label" ||
		entry.type === "custom" ||
		entry.type === "model_change" ||
		entry.type === "thinking_level_change" ||
		entry.type === "service_tier_change" ||
		entry.type === "title_change" ||
		entry.type === "credential_pin" ||
		entry.type === "session_init" ||
		entry.type === "ttsr_injection" ||
		entry.type === "mode_change" ||
		entry.type === "reset_boundary"
	);
}

/** Get searchable text content from a node */
export function getSearchableText(node: SessionTreeNode): string {
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
				parts.push(extractContent(msg.content));
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
				const content = stripSystemWrapperTags(joinTextContent(entry.content)).slice(0, SEARCH_TEXT_LIMIT);
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

/**
 * Apply a filter mode and optional search query to flattened nodes, matching
 * the `/tree` selector semantics: tool-only assistant messages are hidden
 * unless errored/aborted or the current leaf, filter modes drop bookkeeping
 * entry types, and search tokens must all fuzzy-match the searchable text.
 */
export function filterFlatNodes(
	flatNodes: FlatNode[],
	options: { mode: TreeFilterMode; searchQuery?: string; currentLeafId: string | null },
): FlatNode[] {
	const { mode, currentLeafId } = options;
	const searchTokens = (options.searchQuery ?? "").toLowerCase().split(/\s+/).filter(Boolean);

	return flatNodes.filter(flatNode => {
		const entry = flatNode.node.entry;
		const isCurrentLeaf = entry.id === currentLeafId;

		// Skip assistant messages with only tool calls (no text) unless error/aborted
		// Always show current leaf so active position is visible
		if (entry.type === "message" && entry.message.role === "assistant" && !isCurrentLeaf) {
			const msg = entry.message as { stopReason?: string; content?: unknown };
			const hasText = hasTextContent(msg.content);
			const isErrorOrAborted = msg.stopReason && msg.stopReason !== "stop" && msg.stopReason !== "toolUse";
			// Only hide if no text AND not an error/aborted message
			if (!hasText && !isErrorOrAborted) {
				return false;
			}
		}

		// Apply filter mode
		let passesFilter = true;
		switch (mode) {
			case "user-only":
				// Just user messages
				passesFilter = entry.type === "message" && entry.message.role === "user";
				break;
			case "no-tools":
				// Default minus tool results
				passesFilter =
					!isSettingsEntry(entry) && !(entry.type === "message" && entry.message.role === "toolResult");
				break;
			case "labeled-only":
				// Just labeled entries
				passesFilter = flatNode.node.label !== undefined;
				break;
			case "all":
				// Show everything
				passesFilter = true;
				break;
			default:
				// Default mode: hide settings/bookkeeping entries
				passesFilter = !isSettingsEntry(entry);
				break;
		}

		if (!passesFilter) return false;

		// Apply fuzzy search filter
		if (searchTokens.length > 0) {
			const nodeText = getSearchableText(flatNode.node);
			return searchTokens.every(token => fuzzyMatch(token, nodeText).matches);
		}

		return true;
	});
}
