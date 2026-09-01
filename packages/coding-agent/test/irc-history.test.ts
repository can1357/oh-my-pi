import { describe, expect, it } from "bun:test";
import { IrcBus, type IrcMessage } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { deriveIrcConversations } from "@oh-my-pi/pi-coding-agent/irc/conversations";
import { IRC_HISTORY_CUSTOM_TYPE, IrcHistoryStore } from "@oh-my-pi/pi-coding-agent/irc/history";
import type { IrcHistoryRecord } from "@oh-my-pi/pi-coding-agent/irc/types";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("IRC history", () => {
	it("persists terminal outcomes in session custom entries and restores them after restart", async () => {
		using tempDir = TempDir.createSync("irc-history-");
		const manager = SessionManager.create(tempDir.path(), tempDir.path());
		const registry = new AgentRegistry();
		let delivered: IrcMessage | undefined;
		const session = {
			deliverIrcMessage: async (message: IrcMessage) => {
				expect(
					manager
						.getEntries()
						.filter(entry => entry.type === "custom" && entry.customType === IRC_HISTORY_CUSTOM_TYPE),
				).toHaveLength(0);
				expect(manager.getEntries().some(entry => entry.type === "custom")).toBe(false);
				delivered = message;
				return "woken" as const;
			},
			emitIrcRelayObservation() {},
		} as unknown as AgentSession;
		registry.register({ id: "Worker", displayName: "Worker", kind: "sub", session });
		const bus = new IrcBus(registry);
		bus.configureHistory(manager);

		const receipt = await bus.send({ from: "Main", to: "Worker", body: "ping" });
		expect(receipt).toEqual({ to: "Worker", outcome: "woken" });
		expect(delivered?.id).toBeTruthy();
		const entries = manager
			.getEntries()
			.filter(entry => entry.type === "custom" && entry.customType === IRC_HISTORY_CUSTOM_TYPE);
		expect(entries).toEqual([
			expect.objectContaining({
				customType: IRC_HISTORY_CUSTOM_TYPE,
				data: expect.objectContaining({
					message: expect.objectContaining({ id: delivered?.id, body: "ping" }),
					outcome: "woken",
				}),
			}),
		]);

		await manager.ensureOnDisk();
		await manager.flush();
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected persisted session file");
		await manager.close();

		const reopened = await SessionManager.open(sessionFile, tempDir.path());
		try {
			const restored = new IrcHistoryStore();
			restored.configureSession(reopened);
			expect(restored.list()).toEqual([
				expect.objectContaining({
					message: expect.objectContaining({ id: delivered?.id, from: "Main", to: "Worker", body: "ping" }),
					outcome: "woken",
				}),
			]);
		} finally {
			await reopened.close();
		}
	});

	it("persists failed delivery outcomes with the same stable message id", async () => {
		using tempDir = TempDir.createSync("irc-history-failed-");
		const manager = SessionManager.create(tempDir.path(), tempDir.path());
		try {
			const bus = new IrcBus(new AgentRegistry());
			bus.configureHistory(manager);
			const receipt = await bus.send({ from: "Main", to: "Missing", body: "hello" });
			expect(receipt.outcome).toBe("failed");
			const records = bus.historyRecords();
			expect(records).toHaveLength(1);
			expect(records[0]).toMatchObject({
				message: { from: "Main", to: "Missing", body: "hello" },
				outcome: "failed",
			});
			expect(records[0]?.message.id).toBeTruthy();
			expect(
				manager
					.getEntries()
					.filter(entry => entry.type === "custom" && entry.customType === IRC_HISTORY_CUSTOM_TYPE),
			).toHaveLength(1);
		} finally {
			await manager.close();
		}
	});

	it("isolates pending messages and unread cursors when the active session changes", async () => {
		using tempDir = TempDir.createSync("irc-history-switch-");
		const firstSession = SessionManager.create(tempDir.path(), tempDir.path());
		const secondSession = SessionManager.create(tempDir.path(), tempDir.path());
		try {
			const history = new IrcHistoryStore();
			history.configureSession(firstSession);
			history.markRead("direct:Main:Worker", { timestamp: 10_000, messageId: "seen" });
			history.recordMessage({
				id: "old-session-message",
				from: "Main",
				to: "Worker",
				body: "old session",
				ts: 1_000,
			});
			history.configureSession(secondSession);
			history.recordDelivery("old-session-message", { to: "Worker", outcome: "injected" });

			expect(history.list()).toEqual([]);
			expect(history.readAt("direct:Main:Worker")).toEqual({ timestamp: 0, messageId: "" });
			expect(
				secondSession
					.getEntries()
					.filter(entry => entry.type === "custom" && entry.customType === IRC_HISTORY_CUSTOM_TYPE),
			).toHaveLength(0);

			history.configureSession(null);
			history.recordMessage({ id: "memory-only", from: "Main", to: "Worker", body: "new session", ts: 2_000 });
			expect(history.list().map(record => record.message.id)).toEqual(["memory-only"]);
		} finally {
			await Promise.all([firstSession.close(), secondSession.close()]);
		}
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
			"Worker One ⇄ Reviewer",
			"Main ⇄ Worker One",
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
	it("preserves failed aggregate outcome for mixed broadcast receipts", () => {
		const records: IrcHistoryRecord[] = [
			{
				message: {
					id: "b-ok",
					from: "Main",
					to: "Worker",
					body: "Status update",
					ts: 4_000,
					broadcastId: "broadcast-mixed",
				},
				outcome: "injected",
				updatedAt: 4_000,
			},
			{
				message: {
					id: "b-fail",
					from: "Main",
					to: "Reviewer",
					body: "Status update",
					ts: 4_000,
					broadcastId: "broadcast-mixed",
				},
				outcome: "failed",
				error: 'Agent "Reviewer" has no live session.',
				updatedAt: 4_001,
			},
		];
		const conversations = deriveIrcConversations(records);
		expect(conversations).toHaveLength(1);
		expect(conversations[0]?.id).toBe("broadcast:all");
		expect(conversations[0]?.messages).toHaveLength(1);
		expect(conversations[0]?.messages[0]).toMatchObject({
			outcome: "failed",
			error: 'Agent "Reviewer" has no live session.',
			recipients: ["Worker", "Reviewer"],
		});
	});
});
