/**
 * Session tree over RPC.
 *
 * `get_tree` returns the raw `SessionManager.getTree()` snapshot;
 * `get_navigation_tree` returns the flattened, filtered projection the `/tree`
 * selector renders, so remote clients can mirror the same navigation UI.
 */

import type { SessionManager } from "../../session/session-manager";
import {
	buildActivePathIds,
	type FlatNode,
	filterFlatNodes,
	flattenSessionTree,
	getSearchableText,
} from "../components/tree-model";
import type { RpcNavigationTree, RpcNavigationTreeNode, RpcSessionTree, RpcTreeFilterMode } from "./rpc-types";

const TREE_FILTER_MODES: readonly RpcTreeFilterMode[] = ["default", "no-tools", "user-only", "labeled-only", "all"];

export function isRpcTreeFilterMode(value: unknown): value is RpcTreeFilterMode {
	return typeof value === "string" && (TREE_FILTER_MODES as readonly string[]).includes(value);
}

/** Raw session tree: nested `SessionTreeNode[]` plus the active leaf. */
export function getSessionTree(sessionManager: SessionManager): RpcSessionTree {
	return { leafId: sessionManager.getLeafId(), tree: sessionManager.getTree() };
}

export type NavigationTreeRpcFailure = { ok: false; error: string; code: "invalid_filter" };
export type NavigationTreeRpcResult = { ok: true; data: RpcNavigationTree } | NavigationTreeRpcFailure;

/**
 * Flattened navigation tree matching the `/tree` selector: active branch
 * first, filter modes, and fuzzy search over the same searchable text.
 */
export function getNavigationTree(
	sessionManager: SessionManager,
	options: { filter?: unknown; search?: unknown } = {},
): NavigationTreeRpcResult {
	const filter = options.filter ?? "default";
	if (!isRpcTreeFilterMode(filter)) {
		return { ok: false, error: `Invalid tree filter mode: ${String(options.filter)}`, code: "invalid_filter" };
	}
	const search = typeof options.search === "string" ? options.search : "";

	const leafId = sessionManager.getLeafId();
	const tree = sessionManager.getTree();
	const { flatNodes } = flattenSessionTree(tree, leafId);
	const activePathIds = buildActivePathIds(flatNodes, leafId);
	const visible = filterFlatNodes(flatNodes, { mode: filter, searchQuery: search, currentLeafId: leafId });

	return {
		ok: true,
		data: {
			leafId,
			filter,
			search,
			multipleRoots: tree.length > 1,
			totalNodes: flatNodes.length,
			nodes: visible.map(flatNode => toRpcNavigationNode(flatNode, activePathIds, leafId)),
		},
	};
}

function toRpcNavigationNode(
	flatNode: FlatNode,
	activePathIds: Set<string>,
	leafId: string | null,
): RpcNavigationTreeNode {
	const { entry, label } = flatNode.node;
	const role = entry.type === "message" ? entry.message.role : undefined;
	return {
		entryId: entry.id,
		parentId: entry.parentId,
		entryType: entry.type,
		...(role !== undefined ? { role } : {}),
		timestamp: entry.timestamp,
		...(label !== undefined ? { label } : {}),
		preview: getSearchableText(flatNode.node),
		indent: flatNode.indent,
		showConnector: flatNode.showConnector,
		isLast: flatNode.isLast,
		isVirtualRootChild: flatNode.isVirtualRootChild,
		gutters: flatNode.gutters.map(gutter => ({ position: gutter.position, show: gutter.show })),
		onActivePath: activePathIds.has(entry.id),
		isLeaf: entry.id === leafId,
	};
}
