import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { backfillIrcHistoryFromTranscript, dedupeBackfillRecords } from "@oh-my-pi/pi-coding-agent/irc/backfill";
import { deriveIrcConversations } from "@oh-my-pi/pi-coding-agent/irc/conversations";
import type { IrcHistoryRecord } from "@oh-my-pi/pi-coding-agent/irc/types";
import { TempDir } from "@oh-my-pi/pi-utils";

/** Legacy transcripts record hub sends as assistant toolCall blocks. */
function legacyEntry(id: string, timestamp: string, to: string, body: string): string {
	return JSON.stringify({
		type: "message",
		id,
		timestamp,
		message: {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "" },
				{ type: "toolCall", id: `call_${id}`, name: "hub", arguments: { op: "send", to, message: body } },
			],
		},
	});
}

async function writeLegacyTranscript(sessionFile: string, lines: string[]): Promise<void> {
	await Bun.write(sessionFile, `${lines.join("\n")}\n`);
}

describe("IRC history backfill", () => {
	it("reconstructs hub sends from a legacy transcript", async () => {
		using tempDir = TempDir.createSync("irc-backfill-");
		const sessionFile = path.join(tempDir.path(), "main.jsonl");
		await writeLegacyTranscript(sessionFile, [
			JSON.stringify({ type: "session", id: "s1", timestamp: "2026-08-05T04:00:00.000Z" }),
			legacyEntry("e1", "2026-08-05T04:13:06.184Z", "Reviewer", "inspect the artifact"),
			legacyEntry("e2", "2026-08-05T04:14:00.000Z", "all", "status check"),
			legacyEntry("e3", "2026-08-05T04:15:00.000Z", "Reviewer", "also rerun validation"),
		]);

		const records = await backfillIrcHistoryFromTranscript(sessionFile);
		expect(records).toHaveLength(3);
		expect(records[0]).toMatchObject({
			message: { from: "Main", to: "Reviewer", body: "inspect the artifact" },
			outcome: "injected",
		});
		expect(records[0]!.message.ts).toBe(Date.parse("2026-08-05T04:13:06.184Z"));
		expect(records[0]!.message.id).toContain("bf:e1:call_e1");
		// Broadcasts synthesize a broadcastId so they land in the All agents thread.
		expect(records[1]!.message.broadcastId).toContain("bf-broadcast:");
		expect(records[2]!.message.broadcastId).toBeUndefined();
	});

	it("returns nothing without a session file and survives missing files", async () => {
		expect(await backfillIrcHistoryFromTranscript(undefined)).toEqual([]);
		expect(await backfillIrcHistoryFromTranscript("/nonexistent/path/main.jsonl")).toEqual([]);
	});

	it("drops backfilled records duplicated by the durable journal", async () => {
		using tempDir = TempDir.createSync("irc-backfill-dedupe-");
		const sessionFile = path.join(tempDir.path(), "main.jsonl");
		await writeLegacyTranscript(sessionFile, [
			legacyEntry("e1", "2026-08-05T04:13:06.184Z", "Reviewer", "same body both ways"),
			legacyEntry("e2", "2026-08-05T04:14:00.000Z", "Reviewer", "only in transcript"),
		]);
		const backfilled = await backfillIrcHistoryFromTranscript(sessionFile);
		const journaled: IrcHistoryRecord[] = [
			{
				message: {
					id: "snowflake-1",
					from: "Main",
					to: "Reviewer",
					body: "same body both ways",
					ts: Date.parse("2026-08-06T10:00:00.000Z"),
				},
				outcome: "woken",
				updatedAt: Date.parse("2026-08-06T10:00:00.000Z"),
			},
		];
		const merged = dedupeBackfillRecords(backfilled, journaled);
		expect(merged).toHaveLength(1);
		expect(merged[0]!.message.body).toBe("only in transcript");
		const conversations = deriveIrcConversations([...journaled, ...merged]);
		const direct = conversations.find(conversation => conversation.messages.some(m => m.id.startsWith("bf:")));
		const bodies = direct!.messages.map(message => message.body);
		// The duplicated send appears once (journal copy only); the transcript-only send appears once.
		expect(bodies.filter(body => body === "same body both ways")).toHaveLength(1);
		expect(bodies.filter(body => body === "only in transcript")).toHaveLength(1);
	});

	it("ignores non-send hub ops and non-hub tool calls", async () => {
		using tempDir = TempDir.createSync("irc-backfill-ops-");
		const sessionFile = path.join(tempDir.path(), "main.jsonl");
		const lines = [
			JSON.stringify({
				type: "message",
				id: "w1",
				timestamp: "2026-08-05T04:13:06.184Z",
				message: {
					role: "assistant",
					content: [
						{ type: "toolCall", id: "call_w1", name: "hub", arguments: { op: "wait", timeoutMs: 1000 } },
						{ type: "toolCall", id: "call_w2", name: "bash", arguments: { command: "ls" } },
					],
				},
			}),
		];
		await writeLegacyTranscript(sessionFile, lines);
		expect(await backfillIrcHistoryFromTranscript(sessionFile)).toEqual([]);
	});
});
