import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mapAgentSessionEventToAcpSessionUpdates } from "@oh-my-pi/pi-coding-agent/modes/acp/acp-event-mapper";
import { AcpSubagentStreams } from "@oh-my-pi/pi-coding-agent/modes/acp/acp-subagents";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import {
	type SubagentLifecyclePayload,
	TASK_SUBAGENT_EVENT_CHANNEL,
	TASK_SUBAGENT_LIFECYCLE_CHANNEL,
} from "@oh-my-pi/pi-coding-agent/task/types";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { type AgentSideConnection, type SessionNotification, zSessionNotification } from "@oh-my-pi/pi-utils/acp";

const ROOT_SESSION_ID = "root-session";
const ROOT_AGENT_ID = `acp:${ROOT_SESSION_ID}`;

function lifecycle(id: string, status: SubagentLifecyclePayload["status"]): SubagentLifecyclePayload {
	return { id, agent: "task", agentSource: "bundled", status, index: 0 };
}

function registerAgent(id: string, parentId: string): void {
	AgentRegistry.global().register({ id, displayName: id, kind: "sub", parentId, session: null });
}

describe("AcpSubagentStreams", () => {
	let bus: EventBus;
	let sent: SessionNotification[];
	let onSent: (() => void) | undefined;
	let streams: AcpSubagentStreams;

	/** Resolves once `count` notifications reached the client, each valid on the wire. */
	async function delivered(count: number): Promise<SessionNotification[]> {
		while (sent.length < count) {
			const next = Promise.withResolvers<void>();
			onSent = next.resolve;
			await next.promise;
		}
		for (const notification of sent) {
			const result = zSessionNotification.safeParse(notification);
			expect(result.success, JSON.stringify(notification)).toBe(true);
		}
		return sent;
	}

	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		bus = new EventBus();
		sent = [];
		const connection = {
			sessionUpdate: async (notification: SessionNotification) => {
				sent.push(notification);
				onSent?.();
			},
		} as unknown as AgentSideConnection;
		const session = {
			sessionId: ROOT_SESSION_ID,
			getAgentId: () => ROOT_AGENT_ID,
			sessionManager: { getCwd: () => "/work" },
		} as unknown as AgentSession;
		streams = new AcpSubagentStreams(connection, session, bus);
	});

	afterEach(() => {
		streams.dispose();
		AgentRegistry.resetGlobalForTests();
	});

	it("announces a child on its parent before streaming the child's own traffic, then reports it idle", async () => {
		registerAgent("Scout", ROOT_AGENT_ID);
		bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, lifecycle("Scout", "started"));
		bus.emit(TASK_SUBAGENT_EVENT_CHANNEL, {
			id: "Scout",
			event: {
				type: "message_end",
				message: { role: "user", content: "Find the flaky test", attribution: "agent", timestamp: 1 },
			} as AgentSessionEvent,
		});
		bus.emit(TASK_SUBAGENT_EVENT_CHANNEL, {
			id: "Scout",
			event: { type: "tool_execution_start", toolCallId: "tc-1", toolName: "bash", args: { command: "ls" } },
		});
		// Only the first agent-attributed user message is the delegated assignment.
		bus.emit(TASK_SUBAGENT_EVENT_CHANNEL, {
			id: "Scout",
			event: {
				type: "message_end",
				message: { role: "user", content: "Reminder: call yield", attribution: "agent", timestamp: 2 },
			} as AgentSessionEvent,
		});
		bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, lifecycle("Scout", "completed"));

		const childSessionId = `${ROOT_SESSION_ID}/Scout`;
		expect((await delivered(4)).map(n => [n.sessionId, n.update.sessionUpdate])).toEqual([
			[ROOT_SESSION_ID, "subagent_update"],
			[childSessionId, "session_message"],
			[childSessionId, "tool_call"],
			[ROOT_SESSION_ID, "subagent_update"],
		]);
		expect(sent[0]!.update).toEqual({
			sessionUpdate: "subagent_update",
			sessionId: childSessionId,
			title: "Scout",
			state: { state: "running" },
		});
		expect(sent[1]!.update).toMatchObject({
			senderSessionId: ROOT_SESSION_ID,
			recipientSessionId: childSessionId,
			content: [{ type: "text", text: "Find the flaky test" }],
		});
		expect(sent[3]!.update).toMatchObject({ state: { state: "idle", stopReason: "end_turn" } });
	});

	it("nests a grandchild under its exposed parent and never exposes a child of an unexposed parent", async () => {
		registerAgent("Lead", ROOT_AGENT_ID);
		registerAgent("Helper", "Lead");
		registerAgent("Stranger", "Unannounced");
		for (const id of ["Lead", "Helper", "Stranger"])
			bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, lifecycle(id, "started"));
		bus.emit(TASK_SUBAGENT_EVENT_CHANNEL, {
			id: "Stranger",
			event: { type: "tool_execution_start", toolCallId: "tc-x", toolName: "bash", args: { command: "ls" } },
		});
		bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, lifecycle("Helper", "aborted"));

		const leadSessionId = `${ROOT_SESSION_ID}/Lead`;
		const helperSessionId = `${ROOT_SESSION_ID}/Helper`;
		expect((await delivered(3)).map(n => [n.sessionId, n.update])).toEqual([
			[ROOT_SESSION_ID, expect.objectContaining({ sessionUpdate: "subagent_update", sessionId: leadSessionId })],
			[leadSessionId, expect.objectContaining({ sessionUpdate: "subagent_update", sessionId: helperSessionId })],
			[
				leadSessionId,
				{
					sessionUpdate: "subagent_update",
					sessionId: helperSessionId,
					state: { state: "idle", stopReason: "cancelled" },
				},
			],
		]);
		expect(streams.resolveAgentSessionId("Stranger")).toBeUndefined();
	});

	it("reports a woken child as running again in the same child session", async () => {
		registerAgent("Scout", ROOT_AGENT_ID);
		for (const status of ["started", "completed", "started"] as const) {
			bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, lifecycle("Scout", status));
		}
		const updates = (await delivered(3)).map(n => n.update);
		expect(updates).toHaveLength(3);
		expect(new Set(updates.map(u => (u.sessionUpdate === "subagent_update" ? u.sessionId : undefined)))).toEqual(
			new Set([`${ROOT_SESSION_ID}/Scout`]),
		);
		expect(updates[2]).toMatchObject({ state: { state: "running" } });
	});

	it("re-establishes known children for a reloaded parent, routing first and current state after", async () => {
		registerAgent("Lead", ROOT_AGENT_ID);
		registerAgent("Helper", "Lead");
		bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, lifecycle("Lead", "started"));
		bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, lifecycle("Helper", "started"));
		bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, lifecycle("Helper", "completed"));
		sent.length = 0;

		streams.announceAll();
		streams.reportStates();

		const leadSessionId = `${ROOT_SESSION_ID}/Lead`;
		const helperSessionId = `${ROOT_SESSION_ID}/Helper`;
		expect((await delivered(4)).map(n => [n.sessionId, n.update])).toEqual([
			[ROOT_SESSION_ID, { sessionUpdate: "subagent_update", sessionId: leadSessionId, title: "Lead" }],
			[leadSessionId, { sessionUpdate: "subagent_update", sessionId: helperSessionId, title: "Helper" }],
			[ROOT_SESSION_ID, { sessionUpdate: "subagent_update", sessionId: leadSessionId, state: { state: "running" } }],
			[
				leadSessionId,
				{
					sessionUpdate: "subagent_update",
					sessionId: helperSessionId,
					state: { state: "idle", stopReason: "end_turn" },
				},
			],
		]);
	});

	it("resolves a child's file locations against the child's own cwd, never the parent's", async () => {
		AgentRegistry.global().register({
			id: "Isolated",
			displayName: "Isolated",
			kind: "sub",
			parentId: ROOT_AGENT_ID,
			session: { sessionManager: { getCwd: () => "/worktrees/isolated" } } as unknown as AgentSession,
		});
		registerAgent("Detached", ROOT_AGENT_ID);
		for (const id of ["Isolated", "Detached"]) {
			bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, lifecycle(id, "started"));
			bus.emit(TASK_SUBAGENT_EVENT_CHANNEL, {
				id,
				event: {
					type: "tool_execution_start",
					toolCallId: `tc-${id}`,
					toolName: "write",
					args: { path: "src/a.ts", content: "x" },
				},
			});
		}
		const locations = (await delivered(4))
			.map(n => n.update)
			.flatMap(update => (update.sessionUpdate === "tool_call" ? [update.locations?.map(l => l.path)] : []));
		expect(locations[0]).toEqual(["/worktrees/isolated/src/a.ts"]);
		// With no session to read a cwd from, nothing may resolve against the parent workspace.
		expect(locations[1]?.some(path => path.startsWith("/work/"))).not.toBe(true);
	});
});

describe("ACP session messages for agent IRC traffic", () => {
	const sessionMessages = {
		resolveAgentSessionId: (agentId: string) => ({ Scout: "child-scout", main: "root" })[agentId],
	};

	it("reports a delivered agent:// write as an outgoing message to the recipient session", () => {
		const args = { path: "agent://Scout", content: "Also check Windows." };
		const end: AgentSessionEvent = {
			type: "tool_execution_end",
			toolCallId: "tc-1",
			toolName: "write",
			isError: false,
			result: { content: [{ type: "text", text: "Delivered." }] },
		};
		expect(
			mapAgentSessionEventToAcpSessionUpdates(end, "root", { getToolArgs: () => args, sessionMessages }),
		).toEqual([
			{
				sessionId: "root",
				update: {
					sessionUpdate: "session_message",
					messageId: "irc-out:tc-1",
					senderSessionId: "root",
					recipientSessionId: "child-scout",
					content: [{ type: "text", text: "Also check Windows." }],
				},
			},
		]);
		const broadcast = mapAgentSessionEventToAcpSessionUpdates(end, "root", {
			getToolArgs: () => ({ path: "agent://all", content: "Stop." }),
			sessionMessages,
		});
		expect(broadcast[0]!.update).not.toHaveProperty("recipientSessionId");
		const failed = mapAgentSessionEventToAcpSessionUpdates({ ...end, isError: true }, "root", {
			getToolArgs: () => args,
			sessionMessages,
		});
		expect(failed).toEqual([]);
	});

	it("reports an incoming IRC message once whether it arrives live or as a wake-turn record", () => {
		const record = {
			role: "custom" as const,
			customType: "irc:incoming",
			content: "<rendered envelope>",
			display: true,
			details: { id: "m-7", from: "Scout", message: "pong" },
			attribution: "agent" as const,
			timestamp: 1,
		};
		const live = mapAgentSessionEventToAcpSessionUpdates({ type: "irc_message", message: record }, "root", {
			sessionMessages,
		});
		const persisted = mapAgentSessionEventToAcpSessionUpdates(
			{ type: "message_end", message: record } as AgentSessionEvent,
			"root",
			{ sessionMessages },
		);
		expect(live).toEqual(persisted);
		expect(live).toEqual([
			{
				sessionId: "root",
				update: {
					sessionUpdate: "session_message",
					messageId: "irc-in:m-7",
					senderSessionId: "child-scout",
					recipientSessionId: "root",
					content: [{ type: "text", text: "pong" }],
				},
			},
		]);
		expect(mapAgentSessionEventToAcpSessionUpdates({ type: "irc_message", message: record }, "root")).toEqual([]);
	});
});
