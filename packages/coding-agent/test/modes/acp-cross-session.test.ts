import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { TempDir } from "@oh-my-pi/pi-utils";
import type { AgentSideConnection, SessionNotification } from "@oh-my-pi/pi-utils/acp";
import { Settings } from "../../src/config/settings";
import * as availableCommands from "../../src/slash-commands/available-commands";
import { ACP_BOOTSTRAP_RACE_GUARD_MS, AcpAgent } from "../../src/modes/acp/acp-agent";
import { mapAgentSessionEventToAcpSessionUpdates } from "../../src/modes/acp/acp-event-mapper";
import type { AgentSession, AgentSessionEvent } from "../../src/session/agent-session";
import * as messagingHost from "../../src/session/messaging-host";
import type { MessagingService } from "../../src/messaging/service";
import { SessionManager } from "../../src/session/session-manager";

/** Re-checks an assertion across queued microtasks; no wall-clock waiting. */
async function eventually(check: () => void): Promise<void> {
	for (let attempt = 0; ; attempt++) {
		try {
			check();
			return;
		} catch (error) {
			if (attempt >= 1000) throw error;
		}
		await Promise.resolve();
	}
}

const agents: AcpAgent[] = [];

afterEach(async () => {
	for (const agent of agents.splice(0)) await agent.dispose();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

function assistant(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function remoteEvent(remote = true): AgentSessionEvent {
	return {
		type: "irc_message",
		message: {
			role: "custom",
			customType: "irc:incoming",
			content: "escaped model text",
			display: true,
			timestamp: Date.now(),
			details: {
				remote,
				from: "release notes",
				message: "Raw <text> for the editor",
				shortId: "1234abcd",
				cwd: "/other",
			},
		},
	} as AgentSessionEvent;
}

function harness(cwd: string) {
	const updates: SessionNotification[] = [];
	const listeners = new Set<(event: AgentSessionEvent) => void>();
	const lifecycle: string[] = [];
	const sessionManager = SessionManager.inMemory(cwd);
	const session = {
		sessionManager,
		get sessionId() {
			return sessionManager.getSessionId();
		},
		get sessionName() {
			return sessionManager.getSessionName();
		},
		settings: Settings.isolated({}),
		isStreaming: false,
		messaging: undefined as MessagingService | undefined,
		setThinkingLevel: (thinkingLevel: string | undefined) => {
			for (const listener of listeners)
				listener({ type: "thinking_level_changed", thinkingLevel } as AgentSessionEvent);
		},
		getAvailableModels: () => [],
		getAvailableThinkingLevels: () => [],
		getPlanModeState: () => undefined,
		setClientBridge: () => {},
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		subscribeCommandMetadataChanged: () => () => {},
		refreshMCPTools: vi.fn(async () => {}),
		getContextUsage: () => undefined,
		abort: vi.fn(async () => {
			session.isStreaming = false;
		}),
		dispose: async () => {
			lifecycle.push("session_dispose");
			await sessionManager.close();
		},
		extensionRunner: {
			initialize: vi.fn(),
			emit: async () => {
				lifecycle.push("session_start");
			},
		},
	};
	const connection = {
		signal: new AbortController().signal,
		sessionUpdate: async (notification: SessionNotification) => {
			updates.push(notification);
		},
	} as unknown as AgentSideConnection;
	spyOn(availableCommands, "buildAvailableSlashCommands").mockResolvedValue([]);
	const binding = {
		ready: vi.fn(() => {
			lifecycle.push("ready");
		}),
		dispose: vi.fn(async () => {
			lifecycle.push("binding_dispose");
		}),
	};
	const bind = spyOn(messagingHost, "bindSessionMessaging").mockImplementation(async () => {
		lifecycle.push("bound");
		return binding;
	});
	const agent = new AcpAgent(connection, async () => session as unknown as AgentSession);
	agents.push(agent);
	return {
		agent,
		session,
		updates,
		lifecycle,
		binding,
		bind,
		emit: (event: AgentSessionEvent) => {
			for (const listener of listeners) listener(event);
		},
	};
}

async function bootstrap(): Promise<void> {
	vi.advanceTimersByTime(ACP_BOOTSTRAP_RACE_GUARD_MS);
	for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe("ACP cross-session messaging", () => {
	it("awaits per-conversation binding before SessionStart, releases after the wire guard, and disposes it first", async () => {
		using dir = TempDir.createSync("@acp-cross-session-");
		vi.useFakeTimers();
		const h = harness(dir.path());
		const start = Promise.withResolvers<void>();
		h.bind.mockImplementation(async () => {
			await start.promise;
			h.lifecycle.push("bound");
			return h.binding;
		});
		const pending = h.agent.newSession({ cwd: dir.path(), mcpServers: [] });
		await eventually(() => expect(h.bind).toHaveBeenCalledTimes(1));
		expect(h.lifecycle).not.toContain("session_start");
		start.resolve();
		const created = await pending;
		expect(h.bind).toHaveBeenCalledWith(h.session, { directPrint: false, exportProcessEnv: false });
		expect(h.lifecycle).toEqual(["bound", "session_start"]);
		await bootstrap();
		expect(h.binding.ready).toHaveBeenCalledTimes(1);
		await h.agent.closeSession({ sessionId: created.sessionId });
		expect(h.lifecycle.slice(-2)).toEqual(["binding_dispose", "session_dispose"]);
		expect(h.binding.dispose).toHaveBeenCalledTimes(1);
	});

	it("streams remote wakes and autonomous answers under the editor's original id after a session switch", async () => {
		using dir = TempDir.createSync("@acp-cross-session-");
		vi.useFakeTimers();
		const h = harness(dir.path());
		const created = await h.agent.newSession({ cwd: dir.path(), mcpServers: [] });
		await bootstrap();
		await h.session.sessionManager.newSession();
		expect(h.session.sessionId).not.toBe(created.sessionId);
		h.updates.length = 0;
		h.emit(remoteEvent());
		h.emit({ type: "agent_start" } as AgentSessionEvent);
		const message = assistant("Autonomous reply");
		h.emit({
			type: "message_update",
			message,
			assistantMessageEvent: { type: "text_delta", delta: "Autonomous reply" },
		} as AgentSessionEvent);
		h.emit({ type: "agent_end", messages: [message] } as AgentSessionEvent);
		await eventually(() =>
			expect(h.updates.some(item => item.update.sessionUpdate === "session_info_update")).toBe(true),
		);
		const text = h.updates.flatMap(item =>
			item.update.sessionUpdate === "agent_message_chunk" && item.update.content.type === "text"
				? [item.update.content.text]
				: [],
		);
		expect(text).toContain("Autonomous reply");
		expect(text.some(value => value.includes("release notes") && value.includes("Raw <text>"))).toBe(true);
		expect(h.updates.every(item => item.sessionId === created.sessionId)).toBe(true);
		await h.agent.setSessionConfigOption({ sessionId: created.sessionId, configId: "thinking", value: "off" });
		expect(h.bind).toHaveBeenCalledTimes(1);
		expect(h.updates.every(item => item.sessionId === created.sessionId)).toBe(true);
	});

	it("does not abort an idle session when messaging is off, including a late cancel after an autonomous turn", async () => {
		using dir = TempDir.createSync("@acp-cross-session-");
		vi.useFakeTimers();
		const h = harness(dir.path());
		const created = await h.agent.newSession({ cwd: dir.path(), mcpServers: [] });
		await bootstrap();
		expect(h.session.messaging).toBeUndefined();

		await h.agent.cancel({ sessionId: created.sessionId });
		expect(h.session.abort).not.toHaveBeenCalled();

		h.session.isStreaming = true;
		h.emit({ type: "agent_start" });
		h.session.isStreaming = false;
		h.emit({ type: "agent_end", messages: [assistant("Finished")] });
		await h.agent.cancel({ sessionId: created.sessionId });
		expect(h.session.abort).not.toHaveBeenCalled();
	});

	it("cancels an autonomous turn without an owning session/prompt and shares concurrent cleanup", async () => {
		using dir = TempDir.createSync("@acp-cross-session-");
		vi.useFakeTimers();
		const h = harness(dir.path());
		const created = await h.agent.newSession({ cwd: dir.path(), mcpServers: [] });
		await bootstrap();
		h.session.isStreaming = true;
		h.emit({ type: "agent_start" } as AgentSessionEvent);
		const aborted = Promise.withResolvers<void>();
		h.session.abort.mockImplementation(async () => {
			h.session.isStreaming = false;
			await aborted.promise;
		});
		const first = h.agent.cancel({ sessionId: created.sessionId });
		const second = h.agent.cancel({ sessionId: created.sessionId });
		expect(h.session.abort).toHaveBeenCalledTimes(1);
		let secondSettled = false;
		void second.then(() => {
			secondSettled = true;
		});
		await Promise.resolve();
		expect(secondSettled).toBe(false);
		aborted.resolve();
		await Promise.all([first, second]);
		expect(h.session.isStreaming).toBe(false);
	});

	it("claims a requested CLI name after binding so another live conversation is not shadowed", async () => {
		using dir = TempDir.createSync("@acp-cross-session-");
		vi.useFakeTimers();
		const h = harness(dir.path());
		h.bind.mockImplementation(async () => {
			h.session.messaging = {
				listSessions: async () => [{ name: "release notes" }],
			} as unknown as MessagingService;
			return h.binding;
		});
		const connection = {
			signal: new AbortController().signal,
			sessionUpdate: async () => {},
		} as unknown as AgentSideConnection;
		const agent = new AcpAgent(connection, async () => ({
			session: h.session as unknown as AgentSession,
			setToolUIContext: () => {},
			name: "release notes",
		}));
		agents.push(agent);
		const created = await agent.newSession({ cwd: dir.path(), mcpServers: [] });
		expect(h.session.sessionManager.getSessionName()).toMatch(/^release notes-[a-z]+-[a-z]+$/);
		await agent.closeSession({ sessionId: created.sessionId });
	});

	it("disposes the binding when MCP setup fails before a record reaches the client", async () => {
		using dir = TempDir.createSync("@acp-cross-session-");
		const h = harness(dir.path());
		h.session.refreshMCPTools.mockRejectedValue(new Error("setup failed"));
		await expect(h.agent.newSession({ cwd: dir.path(), mcpServers: [] })).rejects.toThrow("setup failed");
		expect(h.lifecycle.slice(-2)).toEqual(["binding_dispose", "session_dispose"]);
		expect(h.binding.ready).not.toHaveBeenCalled();
	});

	it("shows raw remote text in the editor while local IRC stays off the external stream", () => {
		const updates = mapAgentSessionEventToAcpSessionUpdates(remoteEvent(), "editor-id");
		expect(updates).toEqual([
			{
				sessionId: "editor-id",
				update: {
					sessionUpdate: "agent_message_chunk",
					content: {
						type: "text",
						text: "**Message from another session @release notes:** Raw <text> for the editor",
					},
				},
			},
		]);
		expect(mapAgentSessionEventToAcpSessionUpdates(remoteEvent(false), "editor-id")).toEqual([]);
	});
});
