import { describe, expect, it, spyOn } from "bun:test";
import type { CustomEntry, SessionTreeNode } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { assistantMsg, failedAssistantMsg, toolCallMsg, toolResultMsg, userMsg } from "../utilities";

describe("SessionManager append and tree traversal", () => {
	describe("append operations", () => {
		it("appendMessage creates entry with correct parentId chain", () => {
			const session = SessionManager.inMemory();

			const id1 = session.appendMessage(userMsg("first"));
			const id2 = session.appendMessage(assistantMsg("second"));
			const id3 = session.appendMessage(userMsg("third"));

			const entries = session.getEntries();
			expect(entries).toHaveLength(3);

			expect(entries[0].id).toBe(id1);
			expect(entries[0].parentId).toBeNull();
			expect(entries[0].type).toBe("message");

			expect(entries[1].id).toBe(id2);
			expect(entries[1].parentId).toBe(id1);

			expect(entries[2].id).toBe(id3);
			expect(entries[2].parentId).toBe(id2);
		});

		it("appendThinkingLevelChange integrates into tree", () => {
			const session = SessionManager.inMemory();

			const msgId = session.appendMessage(userMsg("hello"));
			const thinkingId = session.appendThinkingLevelChange("high");
			session.appendMessage(assistantMsg("response"));

			const entries = session.getEntries();
			expect(entries).toHaveLength(3);

			const thinkingEntry = entries.find(e => e.type === "thinking_level_change");
			expect(thinkingEntry).toBeDefined();
			expect(thinkingEntry!.id).toBe(thinkingId);
			expect(thinkingEntry!.parentId).toBe(msgId);

			expect(entries[2].parentId).toBe(thinkingId);
		});

		it("appendModelChange integrates into tree", () => {
			const session = SessionManager.inMemory();

			const msgId = session.appendMessage(userMsg("hello"));
			const modelId = session.appendModelChange("openai/gpt-4");
			session.appendMessage(assistantMsg("response"));

			const entries = session.getEntries();
			const modelEntry = entries.find(e => e.type === "model_change");
			expect(modelEntry).toBeDefined();
			expect(modelEntry?.id).toBe(modelId);
			expect(modelEntry?.parentId).toBe(msgId);
			if (modelEntry?.type === "model_change") {
				expect(modelEntry.model).toBe("openai/gpt-4");
			}

			expect(entries[2].parentId).toBe(modelId);
		});

		it("appendCompaction integrates into tree", () => {
			const session = SessionManager.inMemory();

			const id1 = session.appendMessage(userMsg("1"));
			const id2 = session.appendMessage(assistantMsg("2"));
			const compactionId = session.appendCompaction("summary", undefined, id1, 1000);
			session.appendMessage(userMsg("3"));

			const entries = session.getEntries();
			const compactionEntry = entries.find(e => e.type === "compaction");
			expect(compactionEntry).toBeDefined();
			expect(compactionEntry?.id).toBe(compactionId);
			expect(compactionEntry?.parentId).toBe(id2);
			if (compactionEntry?.type === "compaction") {
				expect(compactionEntry.summary).toBe("summary");
				expect(compactionEntry.firstKeptEntryId).toBe(id1);
				expect(compactionEntry.tokensBefore).toBe(1000);
			}

			expect(entries[3].parentId).toBe(compactionId);
		});

		it("appendCustomEntry integrates into tree", () => {
			const session = SessionManager.inMemory();

			const msgId = session.appendMessage(userMsg("hello"));
			const customId = session.appendCustomEntry("my_hook", { key: "value" });
			session.appendMessage(assistantMsg("response"));

			const entries = session.getEntries();
			const customEntry = entries.find(e => e.type === "custom") as CustomEntry;
			expect(customEntry).toBeDefined();
			expect(customEntry.id).toBe(customId);
			expect(customEntry.parentId).toBe(msgId);
			expect(customEntry.customType).toBe("my_hook");
			expect(customEntry.data).toEqual({ key: "value" });

			expect(entries[2].parentId).toBe(customId);
		});

		it("leaf pointer advances after each append", () => {
			const session = SessionManager.inMemory();

			expect(session.getLeafId()).toBeNull();

			const id1 = session.appendMessage(userMsg("1"));
			expect(session.getLeafId()).toBe(id1);

			const id2 = session.appendMessage(assistantMsg("2"));
			expect(session.getLeafId()).toBe(id2);

			const id3 = session.appendThinkingLevelChange("high");
			expect(session.getLeafId()).toBe(id3);
		});
	});

	describe("getPath", () => {
		it("returns empty array for empty session", () => {
			const session = SessionManager.inMemory();
			expect(session.getBranch()).toEqual([]);
		});

		it("returns single entry path", () => {
			const session = SessionManager.inMemory();
			const id = session.appendMessage(userMsg("hello"));

			const path = session.getBranch();
			expect(path).toHaveLength(1);
			expect(path[0].id).toBe(id);
		});

		it("returns full path from root to leaf", () => {
			const session = SessionManager.inMemory();

			const id1 = session.appendMessage(userMsg("1"));
			const id2 = session.appendMessage(assistantMsg("2"));
			const id3 = session.appendThinkingLevelChange("high");
			const id4 = session.appendMessage(userMsg("3"));

			const path = session.getBranch();
			expect(path).toHaveLength(4);
			expect(path.map(e => e.id)).toEqual([id1, id2, id3, id4]);
		});

		it("returns path from specified entry to root", () => {
			const session = SessionManager.inMemory();

			const id1 = session.appendMessage(userMsg("1"));
			const id2 = session.appendMessage(assistantMsg("2"));
			session.appendMessage(userMsg("3"));
			session.appendMessage(assistantMsg("4"));

			const path = session.getBranch(id2);
			expect(path).toHaveLength(2);
			expect(path.map(e => e.id)).toEqual([id1, id2]);
		});

		it("returns deep branch paths without quadratic unshift work", () => {
			const session = SessionManager.inMemory();
			const ids: string[] = [];
			for (let i = 0; i < 1000; i++) {
				ids.push(session.appendMessage(userMsg(`message-${i}`)));
			}

			const unshift = spyOn(Array.prototype, "unshift");
			try {
				expect(session.getBranch().map(entry => entry.id)).toEqual(ids);
				expect(unshift).not.toHaveBeenCalled();
			} finally {
				unshift.mockRestore();
			}
		});
	});

	describe("getTree", () => {
		it("returns empty array for empty session", () => {
			const session = SessionManager.inMemory();
			expect(session.getTree()).toEqual([]);
		});

		it("returns single root for linear session", () => {
			const session = SessionManager.inMemory();

			const id1 = session.appendMessage(userMsg("1"));
			const id2 = session.appendMessage(assistantMsg("2"));
			const id3 = session.appendMessage(userMsg("3"));

			const tree = session.getTree();
			expect(tree).toHaveLength(1);

			const root = tree[0];
			expect(root.entry.id).toBe(id1);
			expect(root.children).toHaveLength(1);
			expect(root.children[0].entry.id).toBe(id2);
			expect(root.children[0].children).toHaveLength(1);
			expect(root.children[0].children[0].entry.id).toBe(id3);
			expect(root.children[0].children[0].children).toHaveLength(0);
		});

		it("returns tree with branches after branch", () => {
			const session = SessionManager.inMemory();

			// Build: 1 -> 2 -> 3
			const id1 = session.appendMessage(userMsg("1"));
			const id2 = session.appendMessage(assistantMsg("2"));
			const id3 = session.appendMessage(userMsg("3"));

			// Branch from id2, add new path: 2 -> 4
			session.branch(id2);
			const id4 = session.appendMessage(userMsg("4-branch"));

			const tree = session.getTree();
			expect(tree).toHaveLength(1);

			const root = tree[0];
			expect(root.entry.id).toBe(id1);
			expect(root.children).toHaveLength(1);

			const node2 = root.children[0];
			expect(node2.entry.id).toBe(id2);
			expect(node2.children).toHaveLength(2); // id3 and id4 are siblings

			const childIds = node2.children.map(c => c.entry.id).sort();
			expect(childIds).toEqual([id3, id4].sort());
		});

		it("handles multiple branches at same point", () => {
			const session = SessionManager.inMemory();

			session.appendMessage(userMsg("root"));
			const id2 = session.appendMessage(assistantMsg("response"));

			// Branch A
			session.branch(id2);
			const idA = session.appendMessage(userMsg("branch-A"));

			// Branch B
			session.branch(id2);
			const idB = session.appendMessage(userMsg("branch-B"));

			// Branch C
			session.branch(id2);
			const idC = session.appendMessage(userMsg("branch-C"));

			const tree = session.getTree();
			const node2 = tree[0].children[0];
			expect(node2.entry.id).toBe(id2);
			expect(node2.children).toHaveLength(3);

			const branchIds = node2.children.map(c => c.entry.id).sort();
			expect(branchIds).toEqual([idA, idB, idC].sort());
		});

		it("handles deep branching", () => {
			const session = SessionManager.inMemory();

			// Main path: 1 -> 2 -> 3 -> 4
			session.appendMessage(userMsg("1"));
			const id2 = session.appendMessage(assistantMsg("2"));
			const id3 = session.appendMessage(userMsg("3"));
			session.appendMessage(assistantMsg("4"));

			// Branch from 2: 2 -> 5 -> 6
			session.branch(id2);
			const id5 = session.appendMessage(userMsg("5"));
			session.appendMessage(assistantMsg("6"));

			// Branch from 5: 5 -> 7
			session.branch(id5);
			session.appendMessage(userMsg("7"));

			const tree = session.getTree();

			// Verify structure
			const node2 = tree[0].children[0];
			expect(node2.children).toHaveLength(2); // id3 and id5

			const node5 = node2.children.find(c => c.entry.id === id5)!;
			expect(node5.children).toHaveLength(2); // id6 and id7

			const node3 = node2.children.find(c => c.entry.id === id3)!;
			expect(node3.children).toHaveLength(1); // id4
		});
	});

	describe("branch", () => {
		it("moves leaf pointer to specified entry", () => {
			const session = SessionManager.inMemory();

			const id1 = session.appendMessage(userMsg("1"));
			session.appendMessage(assistantMsg("2"));
			const id3 = session.appendMessage(userMsg("3"));

			expect(session.getLeafId()).toBe(id3);

			session.branch(id1);
			expect(session.getLeafId()).toBe(id1);
		});

		it("throws for non-existent entry", () => {
			const session = SessionManager.inMemory();
			session.appendMessage(userMsg("hello"));

			expect(() => session.branch("nonexistent")).toThrow("Entry nonexistent not found");
		});

		it("new appends become children of branch point", () => {
			const session = SessionManager.inMemory();

			const id1 = session.appendMessage(userMsg("1"));
			session.appendMessage(assistantMsg("2"));

			session.branch(id1);
			const id3 = session.appendMessage(userMsg("branched"));

			const entries = session.getEntries();
			const branchedEntry = entries.find(e => e.id === id3)!;
			expect(branchedEntry.parentId).toBe(id1); // sibling of id2
		});
	});

	describe("branchWithSummary", () => {
		it("inserts branch summary and advances leaf", () => {
			const session = SessionManager.inMemory();

			const id1 = session.appendMessage(userMsg("1"));
			session.appendMessage(assistantMsg("2"));
			session.appendMessage(userMsg("3"));

			const summaryId = session.branchWithSummary(id1, "Summary of abandoned work");

			expect(session.getLeafId()).toBe(summaryId);

			const entries = session.getEntries();
			const summaryEntry = entries.find(e => e.type === "branch_summary");
			expect(summaryEntry).toBeDefined();
			expect(summaryEntry?.parentId).toBe(id1);
			if (summaryEntry?.type === "branch_summary") {
				expect(summaryEntry.summary).toBe("Summary of abandoned work");
			}
		});

		it("throws for non-existent entry", () => {
			const session = SessionManager.inMemory();
			session.appendMessage(userMsg("hello"));

			expect(() => session.branchWithSummary("nonexistent", "summary")).toThrow("Entry nonexistent not found");
		});
	});

	describe("getLeafEntry", () => {
		it("returns undefined for empty session", () => {
			const session = SessionManager.inMemory();
			expect(session.getLeafEntry()).toBeUndefined();
		});

		it("returns current leaf entry", () => {
			const session = SessionManager.inMemory();

			session.appendMessage(userMsg("1"));
			const id2 = session.appendMessage(assistantMsg("2"));

			const leaf = session.getLeafEntry();
			expect(leaf).toBeDefined();
			expect(leaf!.id).toBe(id2);
		});
	});

	describe("getEntry", () => {
		it("returns undefined for non-existent id", () => {
			const session = SessionManager.inMemory();
			expect(session.getEntry("nonexistent")).toBeUndefined();
		});

		it("returns entry by id", () => {
			const session = SessionManager.inMemory();

			const id1 = session.appendMessage(userMsg("first"));
			const id2 = session.appendMessage(assistantMsg("second"));

			const entry1 = session.getEntry(id1);
			expect(entry1).toBeDefined();
			expect(entry1?.type).toBe("message");
			if (entry1?.type === "message" && entry1.message.role === "user") {
				expect(entry1.message.content).toBe("first");
			}

			const entry2 = session.getEntry(id2);
			expect(entry2).toBeDefined();
			if (entry2?.type === "message" && entry2.message.role === "assistant") {
				expect((entry2.message.content as any)[0].text).toBe("second");
			}
		});
	});

	describe("buildSessionContext with branches", () => {
		it("returns messages from current branch only", () => {
			const session = SessionManager.inMemory();

			// Main: 1 -> 2 -> 3
			session.appendMessage(userMsg("msg1"));
			const id2 = session.appendMessage(assistantMsg("msg2"));
			session.appendMessage(userMsg("msg3"));

			// Branch from 2: 2 -> 4
			session.branch(id2);
			session.appendMessage(assistantMsg("msg4-branch"));

			const ctx = session.buildSessionContext();
			expect(ctx.messages).toHaveLength(3); // msg1, msg2, msg4-branch (not msg3)

			expect((ctx.messages[0] as any).content).toBe("msg1");
			expect((ctx.messages[1] as any).content[0].text).toBe("msg2");
			expect((ctx.messages[2] as any).content[0].text).toBe("msg4-branch");
		});
	});
});

describe("createBranchedSession", () => {
	it("throws for non-existent entry", () => {
		const session = SessionManager.inMemory();
		session.appendMessage(userMsg("hello"));

		expect(() => session.createBranchedSession("nonexistent")).toThrow("Entry nonexistent not found");
	});

	it("creates new session with path to specified leaf (in-memory)", () => {
		const session = SessionManager.inMemory();

		// Build: 1 -> 2 -> 3 -> 4
		const id1 = session.appendMessage(userMsg("1"));
		const id2 = session.appendMessage(assistantMsg("2"));
		const id3 = session.appendMessage(userMsg("3"));
		session.appendMessage(assistantMsg("4"));

		// Branch from 3: 3 -> 5
		session.branch(id3);
		session.appendMessage(userMsg("5"));

		// Create branched session from id2 (should only have 1 -> 2)
		const result = session.createBranchedSession(id2);
		expect(result).toBeUndefined(); // in-memory returns null

		// Session should now only have entries 1 and 2
		const entries = session.getEntries();
		expect(entries).toHaveLength(2);
		expect(entries[0].id).toBe(id1);
		expect(entries[1].id).toBe(id2);
	});

	it("preserves the session title when creating a branch", async () => {
		const session = SessionManager.inMemory();
		const leafId = session.appendMessage(userMsg("hello"));
		await session.setSessionName("new-ds", "user");

		session.createBranchedSession(leafId);

		expect(session.getSessionName()).toBe("new-ds");
		expect(session.titleSource).toBe("user");
		expect(await session.setSessionName("automatic", "auto")).toBe(false);
		expect(session.getSessionName()).toBe("new-ds");
	});

	it("extracts correct path from branched tree", () => {
		const session = SessionManager.inMemory();

		// Build: 1 -> 2 -> 3
		const id1 = session.appendMessage(userMsg("1"));
		const id2 = session.appendMessage(assistantMsg("2"));
		session.appendMessage(userMsg("3"));

		// Branch from 2: 2 -> 4 -> 5
		session.branch(id2);
		const id4 = session.appendMessage(userMsg("4"));
		const id5 = session.appendMessage(assistantMsg("5"));

		// Create branched session from id5 (should have 1 -> 2 -> 4 -> 5)
		session.createBranchedSession(id5);

		const entries = session.getEntries();
		expect(entries).toHaveLength(4);
		expect(entries.map(e => e.id)).toEqual([id1, id2, id4, id5]);
	});

	it("drops archive records whose targets are absent from a branched session", async () => {
		const session = SessionManager.inMemory();
		const idRoot = session.appendMessage(userMsg("root"));
		const idAnswered = session.appendMessage(assistantMsg("answered"));
		session.branch(idRoot);
		const idArchivedSibling = session.appendMessage(userMsg("archived sibling"));
		session.branch(idAnswered);
		await session.archiveBranch(idArchivedSibling);
		const idContinuation = session.appendMessage(userMsg("continue"));

		session.createBranchedSession(idContinuation);

		expect(session.getEntries().some(entry => entry.type === "archive")).toBe(false);
		expect(session.getArchivedRootIds()).toEqual([]);
		expect(session.getEntry(idContinuation)?.parentId).toBe(idAnswered);
		expect(session.getBranch().map(entry => entry.id)).toEqual([idRoot, idAnswered, idContinuation]);
	});
});

describe("pruneEmptyBranches", () => {
	it("notifies replication after destructive pruning replaces the journal", async () => {
		const session = SessionManager.inMemory();
		const rootId = session.appendMessage(userMsg("root"));
		const activeId = session.appendMessage(assistantMsg("answer"));
		session.branch(rootId);
		const abandonedId = session.appendMessage(userMsg("unanswered"));
		session.branch(activeId);

		const snapshots: string[][] = [];
		session.onEntriesReplaced = () => snapshots.push(session.getEntries().map(entry => entry.id));

		expect(await session.pruneEmptyBranches()).toBe(1);
		expect(snapshots).toEqual([[rootId, activeId]]);
		expect(snapshots[0]).not.toContain(abandonedId);
	});

	it("prunes empty abandoned branches and keeps active path and branches with assistant messages", async () => {
		const session = SessionManager.inMemory();

		// Active branch: Root (user) -> Assistant -> user1 (active, no assistant response yet)
		const idRoot = session.appendMessage(userMsg("Root"));
		const idAsst = session.appendMessage(assistantMsg("Assistant"));
		const idUser1 = session.appendMessage(userMsg("user1")); // active leaf

		// Abandoned empty branch (no assistant messages): Root -> user2
		session.branch(idRoot);
		const idUser2 = session.appendMessage(userMsg("user2"));

		// Abandoned non-empty branch (has assistant message): Root -> user3 -> asst3 -> user3_sub
		session.branch(idRoot);
		const idUser3 = session.appendMessage(userMsg("user3"));
		const idAsst3 = session.appendMessage(assistantMsg("asst3"));
		const idUser3Sub = session.appendMessage(userMsg("user3_sub"));

		// Add a label to a kept entry
		const labelId1 = session.appendLabelChange(idAsst3, "milestone");

		// Add a label to an empty/prunable entry
		const labelId2 = session.appendLabelChange(idUser2, "useless");

		// Active leaf is still user1
		session.branch(idUser1);

		const prunedCount = await session.pruneEmptyBranches();
		expect(prunedCount).toBe(3); // user2, labelId2, and the unanswered user3_sub

		const entries = session.getEntries();
		const entryIds = entries.map(e => e.id);

		// Kept entries
		expect(entryIds).toContain(idRoot);
		expect(entryIds).toContain(idAsst);
		expect(entryIds).toContain(idUser1);
		expect(entryIds).toContain(idUser3);
		expect(entryIds).toContain(idAsst3);
		expect(entryIds).toContain(labelId1);

		// Pruned entries
		expect(entryIds).not.toContain(idUser2);
		expect(entryIds).not.toContain(labelId2);
		// Nothing answered user3_sub and it is not the branch we are in, so it is
		// the same dead end as user2 — one row deeper.
		expect(entryIds).not.toContain(idUser3Sub);
	});

	it("never prunes the active branch, even with no assistant message anywhere", async () => {
		const session = SessionManager.inMemory();
		session.appendMessage(userMsg("only"));
		session.appendMessage(userMsg("still talking"));

		expect(await session.pruneEmptyBranches()).toBe(0);
		expect(session.getEntries()).toHaveLength(2);
	});

	it("keeps a branch whose only assistant message is below the fork", async () => {
		const session = SessionManager.inMemory();
		const idRoot = session.appendMessage(userMsg("root"));
		const idAsst = session.appendMessage(assistantMsg("answer"));

		// Abandoned branch: two user turns before the assistant finally replies.
		session.branch(idRoot);
		const idDeepUser = session.appendMessage(userMsg("retry"));
		const idDeepUser2 = session.appendMessage(userMsg("retry harder"));
		const idDeepAsst = session.appendMessage(assistantMsg("late answer"));
		session.branch(idAsst);

		expect(await session.pruneEmptyBranches()).toBe(0);
		const ids = session.getEntries().map(e => e.id);
		expect(ids).toContain(idDeepUser);
		expect(ids).toContain(idDeepUser2);
		expect(ids).toContain(idDeepAsst);
	});

	it("drops bookkeeping entries on a pruned branch but keeps them on a kept one", async () => {
		const session = SessionManager.inMemory();
		const idRoot = session.appendMessage(userMsg("root"));
		session.appendMessage(assistantMsg("answer"));
		const idKeptThinking = session.appendThinkingLevelChange("high");

		session.branch(idRoot);
		const idDoomedThinking = session.appendThinkingLevelChange("low");
		const idDoomedUser = session.appendMessage(userMsg("abandoned"));
		session.branch(idKeptThinking);

		expect(await session.pruneEmptyBranches()).toBe(2);
		const ids = session.getEntries().map(e => e.id);
		expect(ids).toContain(idKeptThinking);
		expect(ids).not.toContain(idDoomedThinking);
		expect(ids).not.toContain(idDoomedUser);
	});

	it("is idempotent: a second prune finds nothing", async () => {
		const session = SessionManager.inMemory();
		const idRoot = session.appendMessage(userMsg("root"));
		const idAsst = session.appendMessage(assistantMsg("answer"));
		session.branch(idRoot);
		session.appendMessage(userMsg("abandoned"));
		session.branch(idAsst);

		expect(await session.pruneEmptyBranches()).toBe(1);
		expect(await session.pruneEmptyBranches()).toBe(0);
	});

	it("prunes a branch whose only reply errored or was aborted", async () => {
		const session = SessionManager.inMemory();
		const idRoot = session.appendMessage(userMsg("root"));
		const idAsst = session.appendMessage(assistantMsg("answer"));

		// Both attempts fork off the prompt itself, so nothing but the failure ever
		// answered them.
		session.branch(idRoot);
		const idErrorPrompt = session.appendMessage(userMsg("try this"));
		const idError = session.appendMessage(failedAssistantMsg("half a th", "error"));

		session.branch(idRoot);
		const idAbortPrompt = session.appendMessage(userMsg("no, this"));
		const idAborted = session.appendMessage(failedAssistantMsg("stopp", "aborted"));

		session.branch(idAsst);

		expect(await session.pruneEmptyBranches()).toBe(4);
		const ids = session.getEntries().map(e => e.id);
		expect(ids).not.toContain(idError);
		expect(ids).not.toContain(idErrorPrompt);
		expect(ids).not.toContain(idAborted);
		expect(ids).not.toContain(idAbortPrompt);
		expect(ids).toContain(idAsst);
	});

	it("keeps a failure that the retry below it hangs off", async () => {
		const session = SessionManager.inMemory();
		session.appendMessage(userMsg("root"));
		const idFailed = session.appendMessage(failedAssistantMsg("half a th", "error"));
		const idRetry = session.appendMessage(assistantMsg("answer"));
		session.branch(idRetry);

		expect(await session.pruneEmptyBranches()).toBe(0);
		expect(session.getEntries().map(e => e.id)).toContain(idFailed);
	});

	it("keeps a branch whose only reply was truncated for length", async () => {
		const session = SessionManager.inMemory();
		const idRoot = session.appendMessage(userMsg("root"));
		const idAsst = session.appendMessage(assistantMsg("answer"));

		// Hitting the token ceiling is not the same as failing: the reply is cut
		// off, but everything before the cut is real content someone may want to
		// come back for. It answers the prompt above it.
		session.branch(idRoot);
		const idPrompt = session.appendMessage(userMsg("write me an essay"));
		const idTruncated = session.appendMessage({
			...assistantMsg("chapter one of forty"),
			stopReason: "length" as const,
		});
		session.branch(idAsst);

		expect(await session.pruneEmptyBranches()).toBe(0);
		const ids = session.getEntries().map(e => e.id);
		expect(ids).toContain(idPrompt);
		expect(ids).toContain(idTruncated);
	});

	it("drops a dead-end failure hanging off an answered branch", async () => {
		const session = SessionManager.inMemory();
		session.appendMessage(userMsg("root"));
		const idAsst = session.appendMessage(assistantMsg("answer"));
		const idPrompt = session.appendMessage(userMsg("and now this"));
		const idFailed = session.appendMessage(failedAssistantMsg("half a th", "error"));
		session.branch(idAsst);

		// Nothing answered the prompt, so the whole dead end goes — an answer
		// further up the branch does not vouch for what came after it.
		expect(await session.pruneEmptyBranches()).toBe(2);
		const ids = session.getEntries().map(e => e.id);
		expect(ids).not.toContain(idPrompt);
		expect(ids).not.toContain(idFailed);
	});

	it("takes the tool traffic under a pruned failure with it", async () => {
		const session = SessionManager.inMemory();
		const idRoot = session.appendMessage(userMsg("root"));
		const idAsst = session.appendMessage(assistantMsg("answer"));
		session.branch(idAsst);
		const idPrompt = session.appendMessage(userMsg("run the thing"));
		const idFailed = session.appendMessage(failedAssistantMsg("calling", "aborted"));
		const idToolResult = session.appendMessage(toolResultMsg("cancelled"));
		session.branch(idRoot);

		expect(await session.pruneEmptyBranches()).toBe(3);
		const ids = session.getEntries().map(e => e.id);
		// A surviving tool result would reload as an orphan root: a detached stub
		// of a message that no longer exists. Its content also must not be what
		// keeps the failure alive — that is the wreckage of the failed turn.
		expect(ids).not.toContain(idToolResult);
		expect(ids).not.toContain(idFailed);
		expect(ids).not.toContain(idPrompt);
	});

	it("drops an unanswered prompt at the tail of an abandoned branch", async () => {
		const session = SessionManager.inMemory();
		const idRoot = session.appendMessage(userMsg("root"));
		const idAsst = session.appendMessage(assistantMsg("answer"));
		const idDangling = session.appendMessage(userMsg("and one more thing"));
		session.branch(idRoot);
		const idOther = session.appendMessage(assistantMsg("elsewhere"));
		session.branch(idOther);

		// The reply above it answered the prompt before it, not this one.
		expect(await session.pruneEmptyBranches()).toBe(1);
		const ids = session.getEntries().map(e => e.id);
		expect(ids).not.toContain(idDangling);
		expect(ids).toContain(idAsst);
	});

	it("keeps the tool results of a reply that was never followed up", async () => {
		const session = SessionManager.inMemory();
		const idRoot = session.appendMessage(userMsg("root"));
		const idAsst = session.appendMessage(assistantMsg("running it"));
		const idToolResult = session.appendMessage(toolResultMsg("output"));
		session.branch(idRoot);
		session.appendMessage(assistantMsg("elsewhere"));

		// Nothing answers a tool result, so it cannot earn its own verdict — it
		// belongs to the reply that called it.
		expect(await session.pruneEmptyBranches()).toBe(0);
		expect(session.getEntries().map(e => e.id)).toContain(idToolResult);
		expect(session.getEntries().map(e => e.id)).toContain(idAsst);
	});

	it("drops a prompt whose only reply stopped on a tool call that never came back", async () => {
		const session = SessionManager.inMemory();
		const idRoot = session.appendMessage(userMsg("root"));
		session.appendMessage(assistantMsg("answer"));
		session.branch(idRoot);
		const idPrompt = session.appendMessage(userMsg("Or are they something else?"));
		const idCall = session.appendMessage(toolCallMsg("looking it up"));
		session.branch(idRoot);

		// A reply that stopped waiting on a tool is a request, not an answer:
		// nothing came back, so the prompt reads as unanswered and goes with it.
		expect(await session.pruneEmptyBranches()).toBe(2);
		const ids = session.getEntries().map(e => e.id);
		expect(ids).not.toContain(idPrompt);
		expect(ids).not.toContain(idCall);
	});

	it("keeps a tool call that the reply below it answers", async () => {
		const session = SessionManager.inMemory();
		const idRoot = session.appendMessage(userMsg("root"));
		const idPrompt = session.appendMessage(userMsg("run the thing"));
		const idCall = session.appendMessage(toolCallMsg("running it"));
		const idResult = session.appendMessage(toolResultMsg("output"));
		const idAnswer = session.appendMessage(assistantMsg("here is what it said"));
		session.branch(idRoot);

		expect(await session.pruneEmptyBranches()).toBe(0);
		const ids = session.getEntries().map(e => e.id);
		for (const id of [idPrompt, idCall, idResult, idAnswer]) expect(ids).toContain(id);
	});

	it("never prunes a failure you are still looking at", async () => {
		const session = SessionManager.inMemory();
		session.appendMessage(userMsg("root"));
		session.appendMessage(userMsg("try this"));
		const idFailed = session.appendMessage(failedAssistantMsg("half a th", "error"));

		expect(await session.pruneEmptyBranches()).toBe(0);
		expect(session.getEntries().map(e => e.id)).toContain(idFailed);
	});

	it("keeps the session's own metadata, which is not part of the tree", async () => {
		using tempDir = TempDir.createSync("@pi-session-prune-meta-");
		const session = SessionManager.create(tempDir.path(), tempDir.path());
		await session.setSessionName("irv extremism", "user");
		const idRoot = session.appendMessage(userMsg("root"));
		const idAsst = session.appendMessage(assistantMsg("answer"));
		session.branch(idRoot);
		session.appendMessage(userMsg("abandoned"));
		session.branch(idAsst);
		await session.flush();

		expect(await session.pruneEmptyBranches()).toBe(1);
		await session.flush();

		// The header and title carry no id the tree ever sees, so there is no
		// verdict on them to obey — dropping them would rename the session.
		const reloaded = await SessionManager.open(session.getSessionFile() as string);
		expect(reloaded.getSessionName()).toBe("irv extremism");
	});

	it("stays linear on a deep chain", async () => {
		const session = SessionManager.inMemory();
		const idRoot = session.appendMessage(userMsg("root"));
		session.appendMessage(assistantMsg("answer"));
		for (let i = 0; i < 20_000; i++) session.appendMessage(userMsg(`turn ${i}`));

		// One abandoned empty branch off the root, so pruning has real work to do.
		session.branch(idRoot);
		session.appendMessage(userMsg("abandoned"));
		session.branch(session.getBranch()[0]?.id ?? idRoot);

		const started = performance.now();
		await session.pruneEmptyBranches();
		// A per-entry ancestor walk needs ~2x10^8 lookups here and blows past this;
		// the linear passes land in single-digit milliseconds.
		expect(performance.now() - started).toBeLessThan(2_000);
	});

	it("persists the prune: reloading from disk does not resurrect the branch", async () => {
		using tempDir = TempDir.createSync("@pi-session-prune-");
		const session = SessionManager.create(tempDir.path(), tempDir.path());
		const idRoot = session.appendMessage(userMsg("root"));
		const idAsst = session.appendMessage(assistantMsg("answer"));
		session.branch(idRoot);
		const idAbandoned = session.appendMessage(userMsg("abandoned"));
		session.branch(idAsst);
		await session.flush();

		expect(await session.pruneEmptyBranches()).toBe(1);
		await session.flush();

		const reloaded = await SessionManager.open(session.getSessionFile() as string);
		const ids = reloaded.getEntries().map(e => e.id);
		expect(ids).toContain(idRoot);
		expect(ids).toContain(idAsst);
		expect(ids).not.toContain(idAbandoned);
	});

	it("preserves the ancestors needed to restore an archived branch", async () => {
		const session = SessionManager.inMemory();
		const idRoot = session.appendMessage(userMsg("root"));
		const idAsst = session.appendMessage(assistantMsg("answer"));
		session.branch(idRoot);
		const idAncestor = session.appendMessage(userMsg("abandoned ancestor"));
		const idArchived = session.appendMessage(userMsg("archived descendant"));
		session.branch(idAsst);
		await session.archiveBranch(idArchived);

		expect(await session.pruneEmptyBranches()).toBe(0);
		expect(await session.restoreArchived(idArchived)).toBe(1);
		expect(session.getBranch(idArchived).map(entry => entry.id)).toEqual([idRoot, idAncestor, idArchived]);
	});

	it("keeps active archive bookkeeping when its restored target is pruned", async () => {
		const session = SessionManager.inMemory();
		const idRoot = session.appendMessage(userMsg("root"));
		const idAsst = session.appendMessage(assistantMsg("answer"));
		session.branch(idRoot);
		const idAbandoned = session.appendMessage(userMsg("abandoned"));
		session.branch(idAsst);
		await session.archiveBranch(idAbandoned);
		await session.restoreArchived(idAbandoned);
		const activeLeafId = session.getLeafId();

		expect(await session.pruneEmptyBranches()).toBe(1);
		expect(session.getLeafId()).toBe(activeLeafId);
		expect(session.getEntries().filter(entry => entry.type === "archive")).toHaveLength(2);
		const nextId = session.appendMessage(userMsg("continue"));
		expect(session.getEntry(nextId)?.parentId).toBe(activeLeafId);
	});

	it("reparents the active path when removing a label whose target is pruned", async () => {
		const session = SessionManager.inMemory();
		const idRoot = session.appendMessage(userMsg("root"));
		const idAsst = session.appendMessage(assistantMsg("answer"));
		session.branch(idRoot);
		const idAbandoned = session.appendMessage(userMsg("abandoned"));
		session.branch(idAsst);
		const labelId = session.appendLabelChange(idAbandoned, "Pools of Stale Metadata");
		const idContinuation = session.appendMessage(userMsg("continue on the active branch"));

		expect(await session.pruneEmptyBranches()).toBe(2);
		const entries = session.getEntries();
		expect(entries.map(entry => entry.id)).not.toContain(idAbandoned);
		expect(entries.map(entry => entry.id)).not.toContain(labelId);
		expect(JSON.stringify(entries)).not.toContain("Pools of Stale Metadata");
		expect(session.getEntry(idContinuation)?.parentId).toBe(idAsst);
		expect(session.getBranch().map(entry => entry.id)).toEqual([idRoot, idAsst, idContinuation]);
		const nextId = session.appendMessage(userMsg("keep going"));
		expect(session.getEntry(nextId)?.parentId).toBe(idContinuation);
	});
});

describe("archiveEmptyBranches", () => {
	/** Every entry id reachable in a tree, in pre-order. */
	function treeIds(nodes: SessionTreeNode[]): string[] {
		const ids: string[] = [];
		const walk = (list: SessionTreeNode[]) => {
			for (const node of list) {
				ids.push(node.entry.id);
				walk(node.children);
			}
		};
		walk(nodes);
		return ids;
	}

	/**
	 * One answered branch plus two abandoned empty ones, so archive and prune both
	 * have the same real work to do.
	 */
	function buildForkedSession() {
		const session = SessionManager.inMemory();
		const idRoot = session.appendMessage(userMsg("root"));
		const idAsst = session.appendMessage(assistantMsg("answer"));

		session.branch(idRoot);
		const idEmptyA = session.appendMessage(userMsg("abandoned A"));

		session.branch(idRoot);
		const idEmptyB = session.appendMessage(userMsg("abandoned B"));
		const idEmptyBTool = session.appendMessage(toolCallMsg("stalled"));

		session.branch(idAsst);
		// Entry ids are random per session, so the two builds are compared by the
		// stable role each entry plays rather than by raw id.
		const names = new Map<string, string>([
			[idRoot, "root"],
			[idAsst, "asst"],
			[idEmptyA, "emptyA"],
			[idEmptyB, "emptyB"],
			[idEmptyBTool, "emptyBTool"],
		]);
		return { session, names, idRoot, idAsst, idEmptyA, idEmptyB, idEmptyBTool };
	}

	it("hides exactly the entries a prune would have deleted", async () => {
		const pruned = buildForkedSession();
		const before = new Set(pruned.session.getEntries().map(e => e.id));
		expect(await pruned.session.pruneEmptyBranches()).toBeGreaterThan(0);
		const after = new Set(pruned.session.getEntries().map(e => e.id));
		const deleted = [...before].filter(id => !after.has(id)).map(id => pruned.names.get(id));

		const archived = buildForkedSession();
		await archived.session.archiveEmptyBranches();
		const hidden = [...archived.session.getArchivedEntryIds()].map(id => archived.names.get(id));

		expect(deleted).not.toHaveLength(0);
		expect(hidden.sort()).toEqual(deleted.sort());
	});

	it("deletes nothing: every original entry survives the archive", async () => {
		const { session } = buildForkedSession();
		const before = session.getEntries().map(e => e.id);

		const { branches, entries } = await session.archiveEmptyBranches();
		expect(branches).toBeGreaterThan(0);
		expect(entries).toBeGreaterThan(0);

		const after = new Set(session.getEntries().map(e => e.id));
		for (const id of before) expect(after.has(id)).toBe(true);
	});

	it("drops archived branches from getTree but returns them with includeArchived", async () => {
		const { session, idRoot, idAsst, idEmptyA, idEmptyB, idEmptyBTool } = buildForkedSession();
		await session.archiveEmptyBranches();

		const visible = treeIds(session.getTree());
		expect(visible).toContain(idRoot);
		expect(visible).toContain(idAsst);
		expect(visible).not.toContain(idEmptyA);
		expect(visible).not.toContain(idEmptyB);
		expect(visible).not.toContain(idEmptyBTool);

		const all = treeIds(session.getTree({ includeArchived: true }));
		expect(all).toContain(idEmptyA);
		expect(all).toContain(idEmptyB);
		expect(all).toContain(idEmptyBTool);
	});

	it("filters a 100,000-entry archived tree without overflowing the stack", async () => {
		const session = SessionManager.inMemory();
		const idRoot = session.appendMessage(userMsg("root"));
		let activeLeaf = idRoot;
		for (let i = 1; i < 100_000; i++) activeLeaf = session.appendModelChange(`test/model-${i}`);

		session.branch(idRoot);
		const archivedId = session.appendMessage(userMsg("archived sibling"));
		session.branch(activeLeaf);
		await session.archiveBranch(archivedId);

		const stack = [...session.getTree()];
		let visibleCount = 0;
		let sawArchivedEntry = false;
		while (stack.length > 0) {
			const node = stack.pop()!;
			visibleCount++;
			if (node.entry.id === archivedId) sawArchivedEntry = true;
			stack.push(...node.children);
		}
		// The deep active chain and the append-only archive record remain visible
		// to SessionManager; consumers omit the bookkeeping row themselves.
		expect(visibleCount).toBe(100_001);
		expect(sawArchivedEntry).toBe(false);
	});

	it("restores every branch with no argument and only one when given an id", async () => {
		const one = buildForkedSession();
		await one.session.archiveEmptyBranches();
		expect(await one.session.restoreArchived()).toBe(2);
		const restored = treeIds(one.session.getTree());
		expect(restored).toContain(one.idEmptyA);
		expect(restored).toContain(one.idEmptyB);

		const targeted = buildForkedSession();
		await targeted.session.archiveEmptyBranches();
		expect(await targeted.session.restoreArchived(targeted.idEmptyA)).toBe(1);
		const partial = treeIds(targeted.session.getTree());
		expect(partial).toContain(targeted.idEmptyA);
		expect(partial).not.toContain(targeted.idEmptyB);
	});

	it("writes one record for the outermost node of a multi-level empty subtree", async () => {
		const session = SessionManager.inMemory();
		const idRoot = session.appendMessage(userMsg("root"));
		const idAsst = session.appendMessage(assistantMsg("answer"));

		session.branch(idRoot);
		const idTop = session.appendMessage(userMsg("abandoned"));
		const idMid = session.appendMessage(toolCallMsg("stalled"));
		const idDeep = session.appendMessage(toolResultMsg("stalled"));
		session.branch(idAsst);

		const { branches, entries } = await session.archiveEmptyBranches();
		expect(branches).toBe(1);
		expect(entries).toBe(3);
		expect(session.getArchivedRootIds()).toEqual([idTop]);
		expect([...session.getArchivedEntryIds()].sort()).toEqual([idTop, idMid, idDeep].sort());
	});

	it("shields the archived branch from a later prune", async () => {
		const { session } = buildForkedSession();
		await session.archiveEmptyBranches();
		const before = session.getEntries().map(e => e.id);

		expect(await session.pruneEmptyBranches()).toBe(0);
		expect(session.getEntries().map(e => e.id)).toEqual(before);
	});

	it("persists the archive: the branch is still hidden after reloading from disk", async () => {
		using tempDir = TempDir.createSync("@pi-session-archive-");
		const session = SessionManager.create(tempDir.path(), tempDir.path());
		const idRoot = session.appendMessage(userMsg("root"));
		const idAsst = session.appendMessage(assistantMsg("answer"));
		session.branch(idRoot);
		const idAbandoned = session.appendMessage(userMsg("abandoned"));
		session.branch(idAsst);
		await session.flush();

		expect((await session.archiveEmptyBranches()).branches).toBe(1);
		await session.flush();

		const reloaded = await SessionManager.open(session.getSessionFile() as string);
		expect(reloaded.getEntries().map(e => e.id)).toContain(idAbandoned);
		expect(reloaded.getArchivedRootIds()).toEqual([idAbandoned]);
		expect(treeIds(reloaded.getTree())).not.toContain(idAbandoned);
		expect(treeIds(reloaded.getTree({ includeArchived: true }))).toContain(idAbandoned);
	});
});

describe("archiveBranch", () => {
	/** Every entry id reachable in a tree, in pre-order. */
	function treeIds(nodes: SessionTreeNode[]): string[] {
		const ids: string[] = [];
		const walk = (list: SessionTreeNode[]) => {
			for (const node of list) {
				ids.push(node.entry.id);
				walk(node.children);
			}
		};
		walk(nodes);
		return ids;
	}

	/** An answered branch the session sits on, plus an answered branch beside it. */
	function buildTwoAnsweredBranches() {
		const session = SessionManager.inMemory();
		const idRoot = session.appendMessage(userMsg("root"));
		const idAsst = session.appendMessage(assistantMsg("answer"));

		session.branch(idRoot);
		const idOther = session.appendMessage(userMsg("other question"));
		const idOtherAsst = session.appendMessage(assistantMsg("other answer"));

		session.branch(idAsst);
		return { session, idRoot, idAsst, idOther, idOtherAsst };
	}

	it("hides a branch that prune would have kept, and everything under it", async () => {
		const { session, idOther, idOtherAsst } = buildTwoAnsweredBranches();

		expect(await session.archiveBranch(idOther)).toBe(2);

		expect(treeIds(session.getTree())).not.toContain(idOther);
		expect(treeIds(session.getTree())).not.toContain(idOtherAsst);
		expect(session.getEntries().map(e => e.id)).toContain(idOtherAsst);
		expect(session.getArchivedRootIds()).toEqual([idOther]);
	});

	it("refuses the branch the session is standing on", async () => {
		const { session, idAsst, idRoot } = buildTwoAnsweredBranches();

		await expect(session.archiveBranch(idAsst)).rejects.toThrow(/the one you are in/);
		await expect(session.archiveBranch(idRoot)).rejects.toThrow(/the one you are in/);
		expect(session.getArchivedRootIds()).toEqual([]);
	});

	it("rejects an id that is not in the session", async () => {
		const { session } = buildTwoAnsweredBranches();
		await expect(session.archiveBranch("nope")).rejects.toThrow(/No entry nope/);
	});

	it("archives once: a second call adds no record", async () => {
		const { session, idOther } = buildTwoAnsweredBranches();
		await session.archiveBranch(idOther);
		const after = session.getEntries().length;

		expect(await session.archiveBranch(idOther)).toBe(0);
		expect(session.getEntries()).toHaveLength(after);
	});

	it("restores an archived ancestor when given one of its descendants", async () => {
		const { session, idOther, idOtherAsst } = buildTwoAnsweredBranches();
		await session.archiveBranch(idOther);
		const afterArchive = session.getEntries().length;

		expect(session.getArchivedRootId(idOtherAsst)).toBe(idOther);
		expect(await session.archiveBranch(idOtherAsst)).toBe(0);
		expect(session.getEntries()).toHaveLength(afterArchive);
		expect(await session.restoreArchived(idOtherAsst)).toBe(1);
		expect(session.getArchivedRootIds()).toEqual([]);
		expect(treeIds(session.getTree())).toContain(idOtherAsst);
	});

	it("restores every nested archive covering a descendant", async () => {
		const { session, idOther, idOtherAsst } = buildTwoAnsweredBranches();
		await session.archiveBranch(idOtherAsst);
		await session.archiveBranch(idOther);

		expect(session.getArchivedRootIds()).toEqual([idOtherAsst, idOther]);
		expect(session.getArchivedRootId(idOtherAsst)).toBe(idOther);
		expect(await session.restoreArchived(idOtherAsst)).toBe(2);
		expect(session.getArchivedRootIds()).toEqual([]);
		expect(treeIds(session.getTree())).toContain(idOtherAsst);
	});

	it("restores what it hid", async () => {
		const { session, idOther, idOtherAsst } = buildTwoAnsweredBranches();
		await session.archiveBranch(idOther);

		expect(await session.restoreArchived(idOther)).toBe(1);
		expect(treeIds(session.getTree())).toContain(idOther);
		expect(treeIds(session.getTree())).toContain(idOtherAsst);
	});
});
