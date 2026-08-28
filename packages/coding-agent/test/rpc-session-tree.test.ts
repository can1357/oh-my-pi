import { describe, expect, it } from "bun:test";
import {
	getNavigationTree,
	getSessionTree,
	isRpcTreeFilterMode,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-session-tree";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

function appendUser(manager: SessionManager, text: string): string {
	return manager.appendMessage({ role: "user", content: text, timestamp: Date.now() });
}

function appendAssistant(manager: SessionManager, text: string): string {
	return manager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-20250514",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	});
}

function appendToolOnlyAssistant(manager: SessionManager): string {
	return manager.appendMessage({
		role: "assistant",
		content: [{ type: "toolCall", id: "toolu_1", name: "bash", arguments: { command: "ls" } }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-20250514",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: Date.now(),
	});
}

function appendToolResult(manager: SessionManager): string {
	return manager.appendMessage({
		role: "toolResult",
		toolCallId: "toolu_1",
		toolName: "bash",
		content: [{ type: "text", text: "ok" }],
		isError: false,
		timestamp: Date.now(),
	});
}

describe("RPC session tree", () => {
	describe("isRpcTreeFilterMode", () => {
		it("accepts the five /tree filter modes and rejects everything else", () => {
			for (const mode of ["default", "no-tools", "user-only", "labeled-only", "all"]) {
				expect(isRpcTreeFilterMode(mode)).toBe(true);
			}
			for (const bad of ["", "DEFAULT", "tools", "alll", 42, null, undefined, {}]) {
				expect(isRpcTreeFilterMode(bad)).toBe(false);
			}
		});
	});

	describe("getSessionTree", () => {
		it("returns the nested tree with the active leaf id", () => {
			const manager = SessionManager.inMemory();
			const userId = appendUser(manager, "hello");
			const assistantId = appendAssistant(manager, "hi there");

			const snapshot = getSessionTree(manager);
			expect(snapshot.leafId).toBe(assistantId);
			expect(snapshot.tree).toHaveLength(1);
			const root = snapshot.tree[0];
			expect(root.entry.id).toBe(userId);
			expect(root.children.map(child => child.entry.id)).toEqual([assistantId]);
		});

		it("reflects branches as sibling children and resolves labels", () => {
			const manager = SessionManager.inMemory();
			const userId = appendUser(manager, "start");
			const firstId = appendAssistant(manager, "approach A");
			manager.branch(userId);
			const secondId = appendAssistant(manager, "approach B");
			// Appending the label moves the leaf onto the new label entry.
			const labelId = manager.appendLabelChange(firstId, "checkpoint");

			const snapshot = getSessionTree(manager);
			expect(snapshot.leafId).toBe(labelId);
			const root = snapshot.tree[0];
			expect(root.children.map(child => child.entry.id)).toEqual([firstId, secondId]);
			expect(root.children[0].label).toBe("checkpoint");
			expect(root.children[1].label).toBeUndefined();
		});
	});

	describe("getNavigationTree", () => {
		it("flattens the linear conversation and marks the active path", () => {
			const manager = SessionManager.inMemory();
			const userId = appendUser(manager, "hello");
			const assistantId = appendAssistant(manager, "hi there");

			const result = getNavigationTree(manager);
			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(result.data.leafId).toBe(assistantId);
			expect(result.data.multipleRoots).toBe(false);
			expect(result.data.nodes.map(node => node.entryId)).toEqual([userId, assistantId]);
			const [userRow, assistantRow] = result.data.nodes;
			expect(userRow).toMatchObject({
				parentId: null,
				entryType: "message",
				role: "user",
				onActivePath: true,
				isLeaf: false,
			});
			expect(assistantRow).toMatchObject({ role: "assistant", onActivePath: true, isLeaf: true });
			expect(userRow.preview).toContain("hello");
		});

		it("orders the active branch first at a fork", () => {
			const manager = SessionManager.inMemory();
			const userId = appendUser(manager, "start");
			const inactiveId = appendAssistant(manager, "approach A");
			manager.branch(userId);
			const activeId = appendAssistant(manager, "approach B");

			const result = getNavigationTree(manager);
			expect(result.ok).toBe(true);
			if (!result.ok) return;
			const childIds = result.data.nodes.filter(node => node.parentId === userId).map(node => node.entryId);
			expect(childIds).toEqual([activeId, inactiveId]);
			const activeRow = result.data.nodes.find(node => node.entryId === activeId);
			const inactiveRow = result.data.nodes.find(node => node.entryId === inactiveId);
			expect(activeRow?.onActivePath).toBe(true);
			expect(inactiveRow?.onActivePath).toBe(false);
			expect(activeRow?.isLast).toBe(false);
			expect(inactiveRow?.isLast).toBe(true);
		});

		it("hides bookkeeping entries by default and shows them in all mode", () => {
			const manager = SessionManager.inMemory();
			const userId = appendUser(manager, "hello");
			manager.appendLabelChange(userId, "checkpoint");
			manager.appendModelChange("anthropic/claude-sonnet-4-5", "default");

			const defaultResult = getNavigationTree(manager);
			expect(defaultResult.ok).toBe(true);
			if (!defaultResult.ok) return;
			expect(defaultResult.data.nodes.every(node => node.entryType === "message")).toBe(true);
			expect(defaultResult.data.totalNodes).toBeGreaterThan(defaultResult.data.nodes.length);

			const allResult = getNavigationTree(manager, { filter: "all" });
			expect(allResult.ok).toBe(true);
			if (!allResult.ok) return;
			const types = new Set(allResult.data.nodes.map(node => node.entryType));
			expect(types.has("label")).toBe(true);
			expect(types.has("model_change")).toBe(true);
			expect(allResult.data.nodes.length).toBe(allResult.data.totalNodes);
		});

		it("user-only keeps only user messages; labeled-only keeps labeled entries", () => {
			const manager = SessionManager.inMemory();
			const userId = appendUser(manager, "hello");
			appendAssistant(manager, "hi there");
			manager.appendLabelChange(userId, "checkpoint");

			const userOnly = getNavigationTree(manager, { filter: "user-only" });
			expect(userOnly.ok).toBe(true);
			if (!userOnly.ok) return;
			expect(userOnly.data.nodes.map(node => node.entryId)).toEqual([userId]);

			const labeledOnly = getNavigationTree(manager, { filter: "labeled-only" });
			expect(labeledOnly.ok).toBe(true);
			if (!labeledOnly.ok) return;
			expect(labeledOnly.data.nodes.map(node => node.entryId)).toEqual([userId]);
			expect(labeledOnly.data.nodes[0].label).toBe("checkpoint");
		});

		it("no-tools drops tool results but keeps conversation", () => {
			const manager = SessionManager.inMemory();
			const userId = appendUser(manager, "run ls");
			const toolCallId = appendToolOnlyAssistant(manager);
			const toolResultId = appendToolResult(manager);
			const answerId = appendAssistant(manager, "done");

			const result = getNavigationTree(manager, { filter: "no-tools" });
			expect(result.ok).toBe(true);
			if (!result.ok) return;
			const ids = result.data.nodes.map(node => node.entryId);
			expect(ids).toContain(userId);
			expect(ids).toContain(answerId);
			expect(ids).not.toContain(toolResultId);
			// The tool-only assistant node is not the leaf, so it stays hidden.
			expect(ids).not.toContain(toolCallId);
		});

		it("always keeps the current leaf visible, even a tool-only assistant node", () => {
			const manager = SessionManager.inMemory();
			appendUser(manager, "run ls");
			const toolCallId = appendToolOnlyAssistant(manager);

			const result = getNavigationTree(manager);
			expect(result.ok).toBe(true);
			if (!result.ok) return;
			const leafRow = result.data.nodes.find(node => node.entryId === toolCallId);
			expect(leafRow?.isLeaf).toBe(true);
		});

		it("applies fuzzy search over the same text the /tree selector indexes", () => {
			const manager = SessionManager.inMemory();
			appendUser(manager, "deploy the staging build");
			appendAssistant(manager, "done, deployed");

			const hit = getNavigationTree(manager, { search: "staging" });
			expect(hit.ok).toBe(true);
			if (!hit.ok) return;
			expect(hit.data.nodes).toHaveLength(1);
			expect(hit.data.nodes[0].preview).toContain("staging");

			const miss = getNavigationTree(manager, { search: "nonexistent-token" });
			expect(miss.ok).toBe(true);
			if (!miss.ok) return;
			expect(miss.data.nodes).toHaveLength(0);
			expect(miss.data.totalNodes).toBeGreaterThan(0);
		});

		it("rejects an unknown filter mode with invalid_filter", () => {
			const manager = SessionManager.inMemory();
			appendUser(manager, "hello");

			const result = getNavigationTree(manager, { filter: "bogus" });
			expect(result.ok).toBe(false);
			if (result.ok) return;
			expect(result.code).toBe("invalid_filter");
			expect(result.error).toContain("bogus");
		});

		it("nests multiple roots under a virtual branching root", () => {
			const manager = SessionManager.inMemory();
			const firstRoot = appendUser(manager, "first root");
			manager.resetLeaf();
			const secondRoot = appendUser(manager, "second root");

			const result = getNavigationTree(manager);
			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(result.data.multipleRoots).toBe(true);
			const roots = result.data.nodes.filter(node => node.parentId === null);
			expect(roots.map(node => node.entryId)).toEqual([secondRoot, firstRoot]);
			for (const root of roots) {
				expect(root.isVirtualRootChild).toBe(true);
				expect(root.indent).toBe(1);
			}
			// Active branch first: the second root holds the leaf.
			expect(roots[0].onActivePath).toBe(true);
			expect(roots[1].onActivePath).toBe(false);
		});
	});
});
