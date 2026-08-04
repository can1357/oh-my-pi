import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { IrcBus, type IrcMessage } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { deriveIrcConversations } from "@oh-my-pi/pi-coding-agent/irc/conversations";
import { IrcHistoryStore } from "@oh-my-pi/pi-coding-agent/irc/history";
import type { IrcHistoryRecord } from "@oh-my-pi/pi-coding-agent/irc/types";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { TempDir } from "@oh-my-pi/pi-utils";

async function journalLines(sessionFile: string): Promise<Array<Record<string, unknown>>> {
	const text = await Bun.file(`${sessionFile}.irc`).text();
	return text
		.trim()
		.split("\n")
		.map(line => JSON.parse(line));
}

describe("IRC history", () => {
	it("records message intent before delivery and restores terminal outcomes after restart", async () => {
		using tempDir = TempDir.createSync("irc-history-");
		const sessionFile = path.join(tempDir.path(), "main.jsonl");
		const registry = new AgentRegistry();
		let delivered: IrcMessage | undefined;
		const session = {
			deliverIrcMessage: async (message: IrcMessage) => {
				const beforeDelivery = await journalLines(sessionFile);
				expect(beforeDelivery).toHaveLength(1);
				expect(beforeDelivery[0]).toMatchObject({ event: "message", message: { id: message.id, body: "ping" } });
				delivered = message;
				return "woken" as const;
			},
			emitIrcRelayObservation() {},
		} as unknown as AgentSession;
		registry.register({ id: "Worker", displayName: "Worker", kind: "sub", session });
		const bus = new IrcBus(registry);
		bus.configureHistory(sessionFile);

		const receipt = await bus.send({ from: "Main", to: "Worker", body: "ping" });
		expect(receipt).toEqual({ to: "Worker", outcome: "woken" });
		expect(delivered?.id).toBeTruthy();
		const events = await journalLines(sessionFile);
		expect(events.map(event => event.event)).toEqual(["message", "delivery"]);
		expect(events[1]).toMatchObject({ messageId: delivered?.id, outcome: "woken" });

		const restored = new IrcHistoryStore();
		restored.configureSessionFile(sessionFile);
		await restored.ready();
		expect(restored.list()).toEqual([
			expect.objectContaining({
				message: expect.objectContaining({ id: delivered?.id, from: "Main", to: "Worker", body: "ping" }),
				outcome: "woken",
			}),
		]);
	});

	it("persists failed delivery outcomes with the same stable message id", async () => {
		using tempDir = TempDir.createSync("irc-history-failed-");
		const sessionFile = path.join(tempDir.path(), "main.jsonl");
		const bus = new IrcBus(new AgentRegistry());
		bus.configureHistory(sessionFile);
		const receipt = await bus.send({ from: "Main", to: "Missing", body: "hello" });
		expect(receipt.outcome).toBe("failed");
		const records = bus.historyRecords();
		expect(records).toHaveLength(1);
		expect(records[0]).toMatchObject({
			message: { from: "Main", to: "Missing", body: "hello" },
			outcome: "failed",
		});
		expect(records[0]?.message.id).toBeTruthy();
	});

	it("isolates pending writes and unread cursors when the active session changes", async () => {
		using tempDir = TempDir.createSync("irc-history-switch-");
		const firstSession = path.join(tempDir.path(), "first.jsonl");
		const secondSession = path.join(tempDir.path(), "second.jsonl");
		const history = new IrcHistoryStore();
		history.configureSessionFile(firstSession);
		history.markRead("direct:Main:Worker", { timestamp: 10_000, messageId: "seen" });
		const pending = history.recordMessage({
			id: "old-session-message",
			from: "Main",
			to: "Worker",
			body: "old session",
			ts: 1_000,
		});
		history.configureSessionFile(secondSession);
		expect(pending).toBeDefined();
		await expect(pending!).rejects.toThrow("session changed");
		await history.ready();
		expect(history.recordDelivery("old-session-message", { to: "Worker", outcome: "injected" })).toBeUndefined();

		expect(history.list()).toEqual([]);
		expect(history.readAt("direct:Main:Worker")).toEqual({ timestamp: 0, messageId: "" });
		expect(await Bun.file(`${secondSession}.irc`).exists()).toBe(false);

		history.configureSessionFile(null);
		history.recordMessage({ id: "memory-only", from: "Main", to: "Worker", body: "new session", ts: 2_000 });
		expect(history.list().map(record => record.message.id)).toEqual(["memory-only"]);
	});

	it("derives direct, sibling, and deduplicated broadcast conversations with reply linkage", () => {
		const registry = new AgentRegistry();
		registry.register({ id: "Worker", displayName: "Worker One", kind: "sub", parentId: "Main", session: null });
		registry.register({ id: "Reviewer", displayName: "Reviewer", kind: "sub", parentId: "Main", session: null });
		const record = (
			id: string,
			from: string,
			to: string,
			body: string,
			ts: number,
			extra: Partial<IrcMessage> = {},
		): IrcHistoryRecord => ({
			message: { id, from, to, body, ts, ...extra },
			outcome: "injected",
			updatedAt: ts,
		});
		const records = [
			record("d1", "Main", "Worker", "Please inspect auth", 1_000),
			record("d2", "Worker", "Main", "Found one issue", 2_000, { replyTo: "d1" }),
			record("d3", "Main", "Worker", "Please patch it", 2_500, { replyTo: "d2" }),
			record("s1", "Worker", "Reviewer", "Can you validate?", 3_000),
			record("b1-worker", "Main", "Worker", "Status update", 4_000, { broadcastId: "broadcast-1" }),
			record("b1-reviewer", "Main", "Reviewer", "Status update", 4_000, { broadcastId: "broadcast-1" }),
			record("b2-main", "Worker", "Main", "Security alert", 5_000, { broadcastId: "broadcast-2" }),
			record("b2-reviewer", "Worker", "Reviewer", "Security alert", 5_000, { broadcastId: "broadcast-2" }),
		];

		const conversations = deriveIrcConversations(records, {
			registry,
			readAt: id =>
				id === "direct:Main:Worker" ? { timestamp: 2_000, messageId: "d1" } : { timestamp: 0, messageId: "" },
		});
		expect(conversations.map(conversation => conversation.label)).toEqual([
			"All agents",
			"Worker One ↔ Reviewer",
			"Worker One",
		]);
		expect(conversations[0]?.messages).toHaveLength(2);
		expect(conversations[0]?.unread).toBe(1);
		expect(conversations[1]?.unread).toBe(0);
		expect(conversations[0]?.messages[0]).toMatchObject({
			to: "all",
			recipients: ["Worker", "Reviewer"],
			broadcastId: "broadcast-1",
		});
		expect(conversations[2]?.messages[1]).toMatchObject({ id: "d2", replyTo: "d1" });
		expect(conversations[2]?.messages[2]).toMatchObject({ id: "d3", replyTo: "d2" });
		expect(conversations[2]?.unread).toBe(1);
	});
});
