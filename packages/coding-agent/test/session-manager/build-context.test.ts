import { describe, expect, it, spyOn } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { buildSessionContext } from "@oh-my-pi/pi-coding-agent/session/session-context";
import type {
	BranchSummaryEntry,
	CompactionEntry,
	ModelChangeEntry,
	SessionEntry,
	SessionMessageEntry,
	ThinkingLevelChangeEntry,
} from "@oh-my-pi/pi-coding-agent/session/session-entries";
import * as snapcompact from "@oh-my-pi/snapcompact";

function msg(id: string, parentId: string | null, role: "user" | "assistant", text: string): SessionMessageEntry {
	const base = { type: "message" as const, id, parentId, timestamp: "2025-01-01T00:00:00Z" };
	if (role === "user") {
		return { ...base, message: { role, content: text, timestamp: 1 } };
	}
	return {
		...base,
		message: {
			role,
			content: [{ type: "text", text }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-test",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 1,
		},
	};
}

function compaction(id: string, parentId: string | null, summary: string, firstKeptEntryId: string): CompactionEntry {
	return {
		type: "compaction",
		id,
		parentId,
		timestamp: "2025-01-01T00:00:00Z",
		summary,
		firstKeptEntryId,
		tokensBefore: 1000,
	};
}

function branchSummary(id: string, parentId: string | null, summary: string, fromId: string): BranchSummaryEntry {
	return { type: "branch_summary", id, parentId, timestamp: "2025-01-01T00:00:00Z", summary, fromId };
}

function thinkingLevel(id: string, parentId: string | null, level: string): ThinkingLevelChangeEntry {
	return { type: "thinking_level_change", id, parentId, timestamp: "2025-01-01T00:00:00Z", thinkingLevel: level };
}

function modelChange(id: string, parentId: string | null, provider: string, modelId: string): ModelChangeEntry {
	return { type: "model_change", id, parentId, timestamp: "2025-01-01T00:00:00Z", model: `${provider}/${modelId}` };
}

describe("buildSessionContext", () => {
	describe("trivial cases", () => {
		it("empty entries returns empty context", () => {
			const ctx = buildSessionContext([]);
			expect(ctx.messages).toEqual([]);
			expect(ctx.thinkingLevel).toBe("off");
			expect(ctx.models).toEqual({});
		});

		it("single user message", () => {
			const entries: SessionEntry[] = [msg("1", null, "user", "hello")];
			const ctx = buildSessionContext(entries);
			expect(ctx.messages).toHaveLength(1);
			expect(ctx.messages[0].role).toBe("user");
		});

		it("rehydrates custom_message attribution from entries", () => {
			const entries: SessionEntry[] = [
				{
					type: "custom_message",
					id: "1",
					parentId: null,
					timestamp: "2025-01-01T00:00:00Z",
					customType: "skill-prompt",
					content: "Summarize this file",
					display: true,
					attribution: "user",
				},
			];
			const ctx = buildSessionContext(entries);
			expect(ctx.messages).toHaveLength(1);
			const customMessage = ctx.messages[0];
			expect(customMessage?.role).toBe("custom");
			if (customMessage?.role !== "custom") throw new Error("Expected custom message");
			expect(customMessage.attribution).toBe("user");
		});
		it("preserves missing custom_message attribution on rehydration", () => {
			const entries: SessionEntry[] = [
				{
					type: "custom_message",
					id: "1",
					parentId: null,
					timestamp: "2025-01-01T00:00:00Z",
					customType: "skill-prompt",
					content: "Summarize this file",
					display: true,
				},
			];
			const ctx = buildSessionContext(entries);
			expect(ctx.messages).toHaveLength(1);
			const customMessage = ctx.messages[0];
			expect(customMessage?.role).toBe("custom");
			if (customMessage?.role !== "custom") throw new Error("Expected custom message");
			expect(customMessage.attribution).toBeUndefined();
		});
		it("simple conversation", () => {
			const entries: SessionEntry[] = [
				msg("1", null, "user", "hello"),
				msg("2", "1", "assistant", "hi there"),
				msg("3", "2", "user", "how are you"),
				msg("4", "3", "assistant", "great"),
			];
			const ctx = buildSessionContext(entries);
			expect(ctx.messages).toHaveLength(4);
			expect(ctx.messages.map(m => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
		});

		it("builds deep linear paths without quadratic unshift work", () => {
			const entries: SessionEntry[] = [];
			let parentId: string | null = null;
			for (let i = 0; i < 1000; i++) {
				const id = `entry-${i}`;
				entries.push(msg(id, parentId, "user", id));
				parentId = id;
			}

			const unshift = spyOn(Array.prototype, "unshift");
			try {
				const ctx = buildSessionContext(entries, parentId);
				expect(ctx.messages.map(message => (message.role === "user" ? message.content : ""))).toEqual(
					entries.map(entry =>
						entry.type === "message" && entry.message.role === "user" ? entry.message.content : "",
					),
				);
				expect(unshift).not.toHaveBeenCalled();
			} finally {
				unshift.mockRestore();
			}
		});

		it("tracks thinking level changes", () => {
			const entries: SessionEntry[] = [
				msg("1", null, "user", "hello"),
				thinkingLevel("2", "1", "high"),
				msg("3", "2", "assistant", "thinking hard"),
			];
			const ctx = buildSessionContext(entries);
			expect(ctx.thinkingLevel).toBe("high");
			expect(ctx.messages).toHaveLength(2);
		});

		it("tracks model from assistant message", () => {
			const entries: SessionEntry[] = [msg("1", null, "user", "hello"), msg("2", "1", "assistant", "hi")];
			const ctx = buildSessionContext(entries);
			expect(ctx.models.default).toBe("anthropic/claude-test");
		});

		it("tracks model from model change entry", () => {
			const entries: SessionEntry[] = [
				msg("1", null, "user", "hello"),
				modelChange("2", "1", "openai", "gpt-4"),
				msg("3", "2", "assistant", "hi"),
			];
			const ctx = buildSessionContext(entries);
			// Issue #849: an explicit model_change with role="default" must NOT
			// be silently overwritten by a later assistant message tagged with a
			// different model id. Temporary fallbacks and provider-side
			// downgrades both produce such mismatched messages.
			expect(ctx.models.default).toBe("openai/gpt-4");
		});
	});

	describe("with compaction", () => {
		it("includes summary before kept messages", () => {
			const entries: SessionEntry[] = [
				msg("1", null, "user", "first"),
				msg("2", "1", "assistant", "response1"),
				msg("3", "2", "user", "second"),
				msg("4", "3", "assistant", "response2"),
				compaction("5", "4", "Summary of first two turns", "3"),
				msg("6", "5", "user", "third"),
				msg("7", "6", "assistant", "response3"),
			];
			const ctx = buildSessionContext(entries);

			// Should have: summary + kept (3,4) + after (6,7) = 5 messages
			expect(ctx.messages).toHaveLength(5);
			expect((ctx.messages[0] as any).summary).toContain("Summary of first two turns");
			expect((ctx.messages[1] as any).content).toBe("second");
			expect((ctx.messages[2] as any).content[0].text).toBe("response2");
			expect((ctx.messages[3] as any).content).toBe("third");
			expect((ctx.messages[4] as any).content[0].text).toBe("response3");
		});

		it("keeps Anthropic native web-search bytes when compaction retains the assistant turn", () => {
			const nativeContent: AssistantMessage["content"] = [
				{ type: "thinking", thinking: "search", thinkingSignature: "sig-1" },
				{
					type: "anthropicServerTool",
					block: {
						type: "server_tool_use",
						id: "srvtoolu_1",
						name: "web_search",
						input: { query: "current UTC date" },
					},
				},
				{
					type: "anthropicServerTool",
					block: {
						type: "web_search_tool_result",
						tool_use_id: "srvtoolu_1",
						content: [{ type: "web_search_result", encrypted_content: "opaque-result" }],
					},
				},
				{ type: "thinking", thinking: "write", thinkingSignature: "sig-2" },
				{ type: "toolCall", id: "toolu_write", name: "write", arguments: { path: "date.txt" } },
			];
			const retainedAssistant = msg("4", "3", "assistant", "placeholder");
			if (retainedAssistant.message.role !== "assistant") throw new Error("Expected assistant fixture");
			retainedAssistant.message.content = nativeContent;
			retainedAssistant.message.stopReason = "toolUse";
			const entries: SessionEntry[] = [
				msg("1", null, "user", "old question"),
				msg("2", "1", "assistant", "old response"),
				msg("3", "2", "user", "search then write"),
				retainedAssistant,
				{
					type: "message",
					id: "5",
					parentId: "4",
					timestamp: "2025-01-01T00:00:00Z",
					message: {
						role: "toolResult",
						toolCallId: "toolu_write",
						toolName: "write",
						content: [{ type: "text", text: "wrote date.txt" }],
						isError: false,
						timestamp: 2,
					},
				},
				compaction("6", "5", "Old history summary", "3"),
				msg("7", "6", "user", "continue"),
			];

			const ctx = buildSessionContext(entries);
			const assistant = ctx.messages.find(message => message.role === "assistant");
			if (assistant?.role !== "assistant") throw new Error("Expected retained assistant message");
			expect(assistant.content).toEqual(nativeContent);
		});

		it("handles compaction keeping from first message", () => {
			const entries: SessionEntry[] = [
				msg("1", null, "user", "first"),
				msg("2", "1", "assistant", "response"),
				compaction("3", "2", "Empty summary", "1"),
				msg("4", "3", "user", "second"),
			];
			const ctx = buildSessionContext(entries);

			// Summary + all messages (1,2,4)
			expect(ctx.messages).toHaveLength(4);
			expect((ctx.messages[0] as any).summary).toContain("Empty summary");
		});

		it("uses preserved OpenAI replacement history instead of kept raw messages", () => {
			const remoteCompaction: CompactionEntry = {
				...compaction("3", "2", "Remote summary", "1"),
				preserveData: {
					openaiRemoteCompaction: {
						provider: "openai",
						replacementHistory: [
							{ type: "message", role: "user", content: [{ type: "input_text", text: "Preserved user" }] },
							{ type: "compaction", encrypted_content: "enc_123" },
						],
						compactionItem: { type: "compaction", encrypted_content: "enc_123" },
					},
				},
			};
			const entries: SessionEntry[] = [
				msg("1", null, "user", "first"),
				msg("2", "1", "assistant", "response"),
				remoteCompaction,
				msg("4", "3", "user", "after compact"),
			];
			const ctx = buildSessionContext(entries);
			expect(ctx.messages).toHaveLength(2);
			expect(ctx.messages[0]?.role).toBe("compactionSummary");
			if (ctx.messages[0]?.role !== "compactionSummary") throw new Error("Expected compaction summary message");
			expect(ctx.messages[0].providerPayload).toEqual({
				type: "openaiResponsesHistory",
				provider: "openai",
				items: [
					{ type: "message", role: "user", content: [{ type: "input_text", text: "Preserved user" }] },
					{ type: "compaction", encrypted_content: "enc_123" },
				],
			});
			expect((ctx.messages[1] as { content: string }).content).toBe("after compact");
		});

		it("caps snapcompact frame payload in LLM context but preserves transcript frames", () => {
			const oldFrame = "o".repeat(Math.ceil(snapcompact.FRAME_DATA_BYTES_BUDGET / 2) + 1);
			const newFrame = "n".repeat(oldFrame.length);
			const compacted: CompactionEntry = {
				...compaction("3", "2", "Snapcompact summary", "1"),
				preserveData: {
					[snapcompact.PRESERVE_KEY]: {
						frames: [
							{ data: oldFrame, mimeType: "image/png", cols: 10, rows: 10, chars: 10 },
							{ data: newFrame, mimeType: "image/png", cols: 10, rows: 10, chars: 10 },
						],
						totalChars: 20,
						truncatedChars: 0,
						textHead: "old edge",
						textTail: "new edge",
					},
				},
			};
			const entries: SessionEntry[] = [
				msg("1", null, "user", "first"),
				msg("2", "1", "assistant", "response"),
				compacted,
				msg("4", "3", "user", "after compact"),
			];

			const llmContext = buildSessionContext(entries);
			const summary = llmContext.messages[0];
			if (summary?.role !== "compactionSummary") throw new Error("Expected LLM compaction summary");
			const imageBlocks = summary.blocks?.filter(block => block.type === "image");
			expect(imageBlocks).toHaveLength(1);
			const keptImage = imageBlocks?.[0];
			if (keptImage?.type !== "image") throw new Error("Expected kept snapcompact image");
			expect(keptImage.data).toBe(newFrame);
			const blocks = summary.blocks ?? [];
			const noticeIndex = blocks.findIndex(
				block => block.type === "text" && block.text.includes("image middle omitted"),
			);
			const imageIndex = blocks.findIndex(block => block.type === "image");
			expect(noticeIndex).toBeGreaterThanOrEqual(0);
			// Omitted frames are the oldest archived images, so the gap notice must
			// precede the kept (newer) image to keep blocks oldest-to-newest.
			expect(noticeIndex).toBeLessThan(imageIndex);

			const transcript = buildSessionContext(entries, undefined, undefined, { transcript: true });
			const transcriptSummary = transcript.messages[2];
			if (transcriptSummary?.role !== "compactionSummary") throw new Error("Expected transcript compaction summary");
			expect(transcriptSummary.blocks?.filter(block => block.type === "image")).toHaveLength(2);
		});

		it("does not rehydrate legacy oversized snapcompact frames into active LLM context (#4470)", () => {
			const framePayload = "A".repeat(100_000);
			const archiveText = `Issue #4470 legacy archive source\n${"archived history ".repeat(22_000)}`;
			const compacted: CompactionEntry = {
				...compaction("3", "2", "Legacy snapcompact summary", "1"),
				preserveData: {
					[snapcompact.PRESERVE_KEY]: {
						frames: Array.from({ length: 17 }, (_, index) => ({
							data: framePayload,
							mimeType: "image/png",
							cols: 64,
							rows: 40,
							chars: 1000 + index,
						})),
						totalChars: archiveText.length,
						truncatedChars: 1_500_000,
						text: archiveText,
						textHead: "oldest retained snapcompact archive text",
						textTail: "newest retained snapcompact archive text",
					},
				},
			};
			const entries: SessionEntry[] = [
				msg("1", null, "user", "before compact"),
				msg("2", "1", "assistant", "archived response"),
				compacted,
				msg("4", "3", "user", "after resume"),
			];

			const ctx = buildSessionContext(entries);

			expect(ctx.messages.map(message => message.role)).toEqual(["compactionSummary", "user", "assistant", "user"]);
			const summary = ctx.messages[0];
			if (summary?.role !== "compactionSummary") throw new Error("Expected active compaction summary");
			const blocks = summary.blocks ?? [];
			expect(summary.summary).toContain("Legacy snapcompact summary");
			expect(blocks.some(block => block.type === "text" && block.text.includes("oldest retained snapcompact"))).toBe(
				true,
			);
			expect(blocks.some(block => block.type === "text" && block.text.includes("newest retained snapcompact"))).toBe(
				true,
			);
			expect(blocks.filter(block => block.type === "image")).toHaveLength(0);
			expect(summary.images ?? []).toHaveLength(0);

			const transcript = buildSessionContext(entries, undefined, undefined, { transcript: true });
			const transcriptSummary = transcript.messages[2];
			if (transcriptSummary?.role !== "compactionSummary") throw new Error("Expected transcript compaction summary");
			expect(transcriptSummary.blocks?.filter(block => block.type === "image")).toHaveLength(17);
		});

		it("keeps current oversized snapcompact frame archives in active LLM context", () => {
			const framePayload = "A".repeat(100_000);
			const archiveText = `Current archive source\n${"archived history ".repeat(22_000)}`;
			const compacted: CompactionEntry = {
				...compaction("3", "2", "Current snapcompact summary", "1"),
				preserveData: {
					[snapcompact.PRESERVE_KEY]: {
						frames: Array.from({ length: 17 }, (_, index) => ({
							data: framePayload,
							mimeType: "image/png",
							cols: 64,
							rows: 40,
							chars: 1000 + index,
							font: "8x13",
							variant: "bw",
							lineRepeat: 1,
						})),
						totalChars: archiveText.length,
						truncatedChars: 1_500_000,
						text: archiveText,
						textHead: "current oldest retained text",
						textTail: "current newest retained text",
					},
				},
			};
			const entries: SessionEntry[] = [
				msg("1", null, "user", "before compact"),
				msg("2", "1", "assistant", "archived response"),
				compacted,
				msg("4", "3", "user", "after resume"),
			];

			const ctx = buildSessionContext(entries);
			const summary = ctx.messages[0];
			if (summary?.role !== "compactionSummary") throw new Error("Expected active compaction summary");
			expect(summary.blocks?.filter(block => block.type === "image")).toHaveLength(17);
		});

		it("keeps small legacy snapcompact frame archives in active LLM context", () => {
			const archiveText = `Large legacy text-only counter\n${"archived history ".repeat(22_000)}`;
			const compacted: CompactionEntry = {
				...compaction("3", "2", "Small legacy snapcompact summary", "1"),
				preserveData: {
					[snapcompact.PRESERVE_KEY]: {
						frames: Array.from({ length: 2 }, (_, index) => ({
							data: "A".repeat(1000),
							mimeType: "image/png",
							cols: 64,
							rows: 40,
							chars: 1000 + index,
						})),
						totalChars: archiveText.length,
						truncatedChars: 1_500_000,
						text: archiveText,
						textHead: "small legacy oldest retained text",
						textTail: "small legacy newest retained text",
					},
				},
			};
			const entries: SessionEntry[] = [
				msg("1", null, "user", "before compact"),
				msg("2", "1", "assistant", "archived response"),
				compacted,
				msg("4", "3", "user", "after resume"),
			];

			const ctx = buildSessionContext(entries);
			const summary = ctx.messages[0];
			if (summary?.role !== "compactionSummary") throw new Error("Expected active compaction summary");
			expect(summary.blocks?.filter(block => block.type === "image")).toHaveLength(2);
		});

		it("multiple compactions uses latest", () => {
			const entries: SessionEntry[] = [
				msg("1", null, "user", "a"),
				msg("2", "1", "assistant", "b"),
				compaction("3", "2", "First summary", "1"),
				msg("4", "3", "user", "c"),
				msg("5", "4", "assistant", "d"),
				compaction("6", "5", "Second summary", "4"),
				msg("7", "6", "user", "e"),
			];
			const ctx = buildSessionContext(entries);

			// Should use second summary, keep from 4
			expect(ctx.messages).toHaveLength(4);
			expect((ctx.messages[0] as any).summary).toContain("Second summary");
		});
	});

	describe("collapsed transcript ordering", () => {
		it("display transcript: summary after kept messages, not at top", () => {
			const entries: SessionEntry[] = [
				msg("1", null, "user", "old question"),
				msg("2", "1", "assistant", "old response"),
				msg("3", "2", "user", "kept question"),
				msg("4", "3", "assistant", "kept response"),
				compaction("5", "4", "Summary of compacted turns", "3"),
				msg("6", "5", "user", "after compact"),
			];

			// Display transcript: kept messages → summary → post-compaction
			const transcript = buildSessionContext(entries, undefined, undefined, {
				transcript: true,
				collapseCompactedHistory: true,
			});

			expect(transcript.messages).toHaveLength(4);
			expect(transcript.messages[0]?.role).toBe("user");
			expect(transcript.messages[1]?.role).toBe("assistant");
			expect(transcript.messages[2]?.role).toBe("compactionSummary");
			expect(transcript.messages[3]?.role).toBe("user");
		});

		it("agent context: summary stays at top", () => {
			const entries: SessionEntry[] = [
				msg("1", null, "user", "old question"),
				msg("2", "1", "assistant", "old response"),
				msg("3", "2", "user", "kept question"),
				msg("4", "3", "assistant", "kept response"),
				compaction("5", "4", "Summary of compacted turns", "3"),
				msg("6", "5", "user", "after compact"),
			];

			// Agent context (no transcript): summary first
			const agentCtx = buildSessionContext(entries);

			expect(agentCtx.messages).toHaveLength(4);
			expect(agentCtx.messages[0]?.role).toBe("compactionSummary");
			expect(agentCtx.messages[1]?.role).toBe("user");
			expect(agentCtx.messages[2]?.role).toBe("assistant");
			expect(agentCtx.messages[3]?.role).toBe("user");
		});

		it("display transcript with no post-compaction messages: summary at bottom", () => {
			// Simulates the moment right after /compact runs — compaction is the
			// last entry, so the summary should be the last (bottom) message.
			const entries: SessionEntry[] = [
				msg("1", null, "user", "old question"),
				msg("2", "1", "assistant", "old response"),
				msg("3", "2", "user", "kept question"),
				msg("4", "3", "assistant", "kept response"),
				compaction("5", "4", "Freshly compacted", "3"),
			];

			const transcript = buildSessionContext(entries, undefined, undefined, {
				transcript: true,
				collapseCompactedHistory: true,
			});

			expect(transcript.messages).toHaveLength(3);
			expect(transcript.messages[0]?.role).toBe("user");
			expect(transcript.messages[1]?.role).toBe("assistant");
			expect(transcript.messages[2]?.role).toBe("compactionSummary");
		});

		it("collapsed transcript marks first post-compaction assistant as cache miss", () => {
			// With kept assistant BEFORE compaction and assistant AFTER compaction,
			// the cache-miss flag must land on the post-compaction assistant (the
			// turn that actually follows /compact), not on the kept pre-compaction one.
			const entries: SessionEntry[] = [
				msg("1", null, "user", "old question"),
				msg("2", "1", "assistant", "old response"),
				msg("3", "2", "user", "kept question"),
				msg("4", "3", "assistant", "kept response"),
				compaction("5", "4", "Compacted", "3"),
				msg("6", "5", "user", "after compact"),
				msg("7", "6", "assistant", "after response"),
			];

			const transcript = buildSessionContext(entries, undefined, undefined, {
				transcript: true,
				collapseCompactedHistory: true,
			});

			// Roles: user(3), assistant(4), compactionSummary, user(6), assistant(7)
			expect(transcript.messages.map(m => m.role)).toEqual([
				"user",
				"assistant",
				"compactionSummary",
				"user",
				"assistant",
			]);
			// cacheMissExplainedAt: the kept assistant (index 1) should NOT be a miss;
			// the post-compaction assistant (index 4) SHOULD be a miss.
			expect(transcript.cacheMissExplainedAt).toEqual([false, false, false, false, true]);
		});
	});

	describe("with branches", () => {
		it("follows path to specified leaf", () => {
			// Tree:
			//   1 -> 2 -> 3 (branch A)
			//         \-> 4 (branch B)
			const entries: SessionEntry[] = [
				msg("1", null, "user", "start"),
				msg("2", "1", "assistant", "response"),
				msg("3", "2", "user", "branch A"),
				msg("4", "2", "user", "branch B"),
			];

			const ctxA = buildSessionContext(entries, "3");
			expect(ctxA.messages).toHaveLength(3);
			expect((ctxA.messages[2] as any).content).toBe("branch A");

			const ctxB = buildSessionContext(entries, "4");
			expect(ctxB.messages).toHaveLength(3);
			expect((ctxB.messages[2] as any).content).toBe("branch B");
		});

		it("includes branch summary in path", () => {
			const entries: SessionEntry[] = [
				msg("1", null, "user", "start"),
				msg("2", "1", "assistant", "response"),
				msg("3", "2", "user", "abandoned path"),
				branchSummary("4", "2", "Summary of abandoned work", "3"),
				msg("5", "4", "user", "new direction"),
			];
			const ctx = buildSessionContext(entries, "5");

			expect(ctx.messages).toHaveLength(4);
			expect((ctx.messages[2] as any).summary).toContain("Summary of abandoned work");
			expect((ctx.messages[3] as any).content).toBe("new direction");
		});

		it("complex tree with multiple branches and compaction", () => {
			// Tree:
			//   1 -> 2 -> 3 -> 4 -> compaction(5) -> 6 -> 7 (main path)
			//              \-> 8 -> 9 (abandoned branch)
			//                    \-> branchSummary(10) -> 11 (resumed from 3)
			const entries: SessionEntry[] = [
				msg("1", null, "user", "start"),
				msg("2", "1", "assistant", "r1"),
				msg("3", "2", "user", "q2"),
				msg("4", "3", "assistant", "r2"),
				compaction("5", "4", "Compacted history", "3"),
				msg("6", "5", "user", "q3"),
				msg("7", "6", "assistant", "r3"),
				// Abandoned branch from 3
				msg("8", "3", "user", "wrong path"),
				msg("9", "8", "assistant", "wrong response"),
				// Branch summary resuming from 3
				branchSummary("10", "3", "Tried wrong approach", "9"),
				msg("11", "10", "user", "better approach"),
			];

			// Main path to 7: summary + kept(3,4) + after(6,7)
			const ctxMain = buildSessionContext(entries, "7");
			expect(ctxMain.messages).toHaveLength(5);
			expect((ctxMain.messages[0] as any).summary).toContain("Compacted history");
			expect((ctxMain.messages[1] as any).content).toBe("q2");
			expect((ctxMain.messages[2] as any).content[0].text).toBe("r2");
			expect((ctxMain.messages[3] as any).content).toBe("q3");
			expect((ctxMain.messages[4] as any).content[0].text).toBe("r3");

			// Branch path to 11: 1,2,3 + branch_summary + 11
			const ctxBranch = buildSessionContext(entries, "11");
			expect(ctxBranch.messages).toHaveLength(5);
			expect((ctxBranch.messages[0] as any).content).toBe("start");
			expect((ctxBranch.messages[1] as any).content[0].text).toBe("r1");
			expect((ctxBranch.messages[2] as any).content).toBe("q2");
			expect((ctxBranch.messages[3] as any).summary).toContain("Tried wrong approach");
			expect((ctxBranch.messages[4] as any).content).toBe("better approach");
		});
	});

	describe("edge cases", () => {
		it("uses last entry when leafId not found", () => {
			const entries: SessionEntry[] = [msg("1", null, "user", "hello"), msg("2", "1", "assistant", "hi")];
			const ctx = buildSessionContext(entries, "nonexistent");
			expect(ctx.messages).toHaveLength(2);
		});

		it("handles orphaned entries gracefully", () => {
			const entries: SessionEntry[] = [
				msg("1", null, "user", "hello"),
				msg("2", "missing", "assistant", "orphan"), // parent doesn't exist
			];
			const ctx = buildSessionContext(entries, "2");
			// Should only get the orphan since parent chain is broken
			expect(ctx.messages).toHaveLength(1);
		});

		it("strips dangling tool_use when the leaf lands on a mid-batch assistant turn", () => {
			// Reproduces the rewind/restore loop: leaf = a completed assistant turn that
			// emitted tool calls. Its results are off-path children, so without
			// normalization the turn ends on unpaired tool_use and transformMessages
			// fabricates phantom "aborted" results, re-injecting the failed batch.
			// (Aborted/error turns are dropped from context wholesale — covered in
			// src/session/session-context.test.ts.)
			const assistantWithCalls: SessionMessageEntry = {
				type: "message",
				id: "a1",
				parentId: "u1",
				timestamp: "2025-01-01T00:00:00Z",
				message: {
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "deliberating step 1", thinkingSignature: "sig_1" },
						{ type: "text", text: "Let me finish duel.py now" },
						{ type: "toolCall", id: "call_1", name: "write", arguments: { path: "duel.py" } },
						{ type: "thinking", thinking: "deliberating step 2", thinkingSignature: "sig_2" },
						{ type: "redactedThinking", data: "encrypted" },
						{ type: "toolCall", id: "call_2", name: "bash", arguments: { command: "pytest" } },
					],
					api: "anthropic-messages",
					provider: "anthropic",
					model: "claude-test",
					usage: {
						input: 1,
						output: 1,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 2,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "toolUse",
					timestamp: 1,
				},
			};
			const entries: SessionEntry[] = [msg("u1", null, "user", "do it"), assistantWithCalls];
			const ctx = buildSessionContext(entries, "a1");
			expect(ctx.messages).toHaveLength(2);
			const last = ctx.messages[1];
			expect(last.role).toBe("assistant");
			const content = (last as { content: Array<{ type: string; thinkingSignature?: string }> }).content;
			// Dangling tool_use stripped.
			expect(content.some(block => block.type === "toolCall")).toBe(false);
			// redacted_thinking dropped (encrypted; cannot be downgraded, would trip immutability).
			expect(content.some(block => block.type === "redactedThinking")).toBe(false);
			// thinking preserved but de-signed so the encoder downgrades it to plain text on the wire
			// (a *modified* latest turn carrying signed thinking is rejected by Anthropic).
			const thinking = content.filter(block => block.type === "thinking");
			expect(thinking.length).toBeGreaterThan(0);
			expect(thinking.every(block => block.thinkingSignature === undefined)).toBe(true);
			// Visible reasoning/text preserved.
			expect(content.some(block => block.type === "text")).toBe(true);
		});

		it("drops a trailing assistant turn that is only dangling tool_use", () => {
			const toolCallOnly: SessionMessageEntry = {
				type: "message",
				id: "a1",
				parentId: "u1",
				timestamp: "2025-01-01T00:00:00Z",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "call_1", name: "bash", arguments: { command: "ls" } }],
					api: "anthropic-messages",
					provider: "anthropic",
					model: "claude-test",
					usage: {
						input: 1,
						output: 1,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 2,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "aborted",
					timestamp: 1,
				},
			};
			const entries: SessionEntry[] = [msg("u1", null, "user", "do it"), toolCallOnly];
			const ctx = buildSessionContext(entries, "a1");
			expect(ctx.messages).toHaveLength(1);
			expect(ctx.messages[0].role).toBe("user");
		});

		it("strips a dangling mid-path assistant turn while leaving a paired turn intact", () => {
			// Branch scenario: a user message was inserted after an assistant turn whose
			// tool results live on a sibling branch (off this path), so its tool_use is
			// dangling mid-conversation. An earlier turn whose result IS on-path must be
			// left untouched.
			const usage = {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			};
			const asst = (id: string, parentId: string, content: unknown[], stopReason: string): SessionMessageEntry =>
				({
					type: "message",
					id,
					parentId,
					timestamp: "2025-01-01T00:00:00Z",
					message: {
						role: "assistant",
						content,
						api: "anthropic-messages",
						provider: "anthropic",
						model: "claude-test",
						usage,
						stopReason,
						timestamp: 1,
					},
				}) as SessionMessageEntry;
			const toolRes = (id: string, parentId: string, toolCallId: string): SessionMessageEntry =>
				({
					type: "message",
					id,
					parentId,
					timestamp: "2025-01-01T00:00:00Z",
					message: {
						role: "toolResult",
						toolCallId,
						toolName: "bash",
						content: [{ type: "text", text: "ok" }],
						details: {},
						isError: false,
						timestamp: 1,
					},
				}) as SessionMessageEntry;

			const entries: SessionEntry[] = [
				msg("u1", null, "user", "do it"),
				asst(
					"paired",
					"u1",
					[
						{ type: "text", text: "running A" },
						{ type: "toolCall", id: "call_a", name: "bash", arguments: {} },
					],
					"toolUse",
				),
				toolRes("r_a", "paired", "call_a"),
				asst(
					"dangling",
					"r_a",
					[
						{ type: "text", text: "running B" },
						{ type: "toolCall", id: "call_b", name: "bash", arguments: {} },
					],
					"toolUse",
				),
				msg("u2", "dangling", "user", "actually stop"),
			];
			const ctx = buildSessionContext(entries, "u2");
			expect(ctx.messages).toHaveLength(5);
			const paired = ctx.messages[1] as { content: Array<{ type: string }> };
			const dangling = ctx.messages[3] as { content: Array<{ type: string }> };
			// paired turn keeps its tool_use (result is on-path)
			expect(paired.content.some(block => block.type === "toolCall")).toBe(true);
			// dangling mid-path turn has its tool_use stripped, text preserved
			expect(dangling.content.some(block => block.type === "toolCall")).toBe(false);
			expect(dangling.content.some(block => block.type === "text")).toBe(true);
		});
	});
});
