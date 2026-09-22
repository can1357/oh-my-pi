import { describe, expect, it } from "bun:test";
import type { ToolResultMessage } from "@oh-my-pi/pi-ai";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ArtifactProtocolHandler } from "@oh-my-pi/pi-coding-agent/internal-urls/artifact-protocol";
import { parseInternalUrl } from "@oh-my-pi/pi-coding-agent/internal-urls/parse";
import { ArtifactManager } from "@oh-my-pi/pi-coding-agent/session/artifacts";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createAssistantMessage } from "./helpers/agent-session-setup";

// These tests defend restorable working state, not the append-only diagnostic log.
describe("advisor working journal checkpoints", () => {
	it("restores in-place tool mutations and the chosen branch instead of the last physical entry", () => {
		const journal = SessionManager.inMemory();
		journal.appendMessage({ role: "user", content: "review current work", timestamp: 1 });
		const assistant = createAssistantMessage("");
		assistant.content = [{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "src/a.ts" } }];
		assistant.stopReason = "toolUse";
		journal.appendMessage(assistant);
		const result: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "read-1",
			toolName: "read",
			content: [{ type: "text", text: "original recoverable tool output" }],
			isError: false,
			timestamp: 3,
		};
		const stableLeaf = journal.appendMessage(result);
		journal.appendMessage({ role: "user", content: "discarded sibling branch", timestamp: 4 });
		journal.branch(stableLeaf);
		const checkpoint = journal.captureJournalSnapshot();

		result.content[0] = { type: "text", text: "uncommitted prune replacement" };
		journal.appendMessage({ role: "user", content: "failed attempt", timestamp: 5 });
		journal.restoreJournalSnapshot(checkpoint);

		const replay = journal.buildSessionContext().messages;
		expect(journal.getLeafId()).toBe(stableLeaf);
		expect(replay.filter(message => message.role === "user").map(message => message.content)).toEqual([
			"review current work",
		]);
		expect(replay.find(message => message.role === "toolResult")?.content).toEqual([
			{ type: "text", text: "original recoverable tool output" },
		]);
		const retryId = journal.appendMessage({ role: "user", content: "retry", timestamp: 6 });
		expect(journal.getEntry(retryId)?.parentId).toBe(stableLeaf);
	});

	it("restores native replay payload and its boundary without duplicating retained raw messages", () => {
		const journal = SessionManager.inMemory();
		const retained = journal.appendMessage({ role: "user", content: "raw retained request", timestamp: 1 });
		const compactionItem = { type: "compaction", encrypted_content: "original-native-state" };
		const replacementHistory = [
			{ type: "message", role: "user", content: [{ type: "input_text", text: "native retained request" }] },
			compactionItem,
		];
		journal.appendCompaction("native context", undefined, retained, 100_000, {
			method: "remote",
			providerReplayThroughEntryId: retained,
			preserveData: { openaiRemoteCompaction: { provider: "openai", replacementHistory, compactionItem } },
		});
		const checkpoint = journal.captureJournalSnapshot();
		compactionItem.encrypted_content = "uncommitted-native-state";
		replacementHistory.splice(0, 1);
		journal.appendMessage({ role: "user", content: "uncommitted tail", timestamp: 2 });
		journal.restoreJournalSnapshot(checkpoint);

		const replay = journal.buildSessionContext().messages;
		const summary = replay.find(message => message.role === "compactionSummary");
		expect(summary?.role).toBe("compactionSummary");
		if (summary?.role !== "compactionSummary") throw new Error("native replay boundary missing");
		expect(summary.providerPayload).toEqual({
			type: "openaiResponsesHistory",
			provider: "openai",
			items: [
				{ type: "message", role: "user", content: [{ type: "input_text", text: "native retained request" }] },
				{ type: "compaction", encrypted_content: "original-native-state" },
			],
		});
		expect(replay.filter(message => message.role === "user")).toHaveLength(0);
	});

	it("keeps primary and both advisors' artifacts readable after checkpoint restoration", async () => {
		await using dir = await TempDir.create("advisor-working-artifacts-");
		const primary = SessionManager.inMemory();
		primary.adoptArtifactManager(new ArtifactManager(dir.path()));
		const first = SessionManager.inMemory();
		const second = SessionManager.inMemory();
		first.adoptArtifactSession(primary);
		second.adoptArtifactSession(primary);
		const checkpoint = first.captureJournalSnapshot();
		const primaryId = await primary.saveArtifact("primary content", "read");
		const [firstId, secondId] = await Promise.all([
			first.saveArtifact("first advisor content", "shake"),
			second.saveArtifact("second advisor content", "shake"),
		]);
		first.restoreJournalSnapshot(checkpoint);
		const retryId = await first.saveArtifact("first advisor retry content", "shake");
		const ids = [primaryId, firstId, secondId, retryId];
		expect(new Set(ids).size).toBe(4);
		const handler = new ArtifactProtocolHandler();
		const context = { localProtocolOptions: { getArtifactsDir: () => first.getArtifactsDir() } };
		const restored = await Promise.all(
			ids.map(async id => {
				const url = parseInternalUrl(`artifact://${id}`);
				if (!url) throw new Error("artifact URL did not parse");
				return (await handler.resolve(url, context)).content;
			}),
		);
		expect(restored).toEqual([
			"primary content",
			"first advisor content",
			"second advisor content",
			"first advisor retry content",
		]);
	});

	it("pages nonpersistent primary and advisor artifacts through the advisor read tool", async () => {
		const primary = SessionManager.inMemory();
		const first = SessionManager.inMemory();
		const second = SessionManager.inMemory();
		first.adoptArtifactSession(primary);
		second.adoptArtifactSession(primary);
		const primaryId = await primary.saveArtifact("primary heading\nprimary retained detail", "read");
		const firstId = await first.saveArtifact("first heading\nfirst retained detail", "shake");
		const checkpoint = first.captureJournalSnapshot();
		const secondId = await second.saveArtifact("second heading\nsecond retained detail", "shake");
		first.restoreJournalSnapshot(checkpoint);
		const reader = new ReadTool({
			cwd: process.cwd(),
			hasUI: false,
			settings: Settings.isolated(),
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			localProtocolOptions: {
				getArtifactsDir: () => first.getArtifactsDir(),
				getArtifactContent: id => first.getArtifactContent(id),
			},
		});
		const details = await Promise.all(
			[primaryId, firstId, secondId].map(async id => {
				const result = await reader.execute(`recover-${id}`, { path: `artifact://${id}:raw:2-2` });
				return result.content.find(block => block.type === "text")?.text;
			}),
		);
		expect(details).toEqual(["primary retained detail", "first retained detail", "second retained detail"]);

		// A new write after restoration cannot reuse another advisor's ID.
		const retryId = await first.saveArtifact("retry content", "shake");
		expect([primaryId, firstId, secondId]).not.toContain(retryId);
		const original = await reader.execute("original-after-retry", { path: `artifact://${secondId}:raw:2-2` });
		expect(original.content.find(block => block.type === "text")?.text).toBe("second retained detail");
	});
});
