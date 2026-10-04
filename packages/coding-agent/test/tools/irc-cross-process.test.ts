import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { AgentProtocolHandler } from "@oh-my-pi/pi-coding-agent/internal-urls/agent-protocol";
import { resetRegisteredArtifactDirsForTests } from "@oh-my-pi/pi-coding-agent/internal-urls/registry-helpers";
import { IrcBus, type IrcRemoteRouter } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { isIrcEnabled } from "@oh-my-pi/pi-coding-agent/irc/messaging";
import { MailboxService, type MailboxPeer } from "@oh-my-pi/pi-coding-agent/mailbox/service";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { CustomMessage } from "@oh-my-pi/pi-coding-agent/session/messages";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import type { IrcDeliveryReceipt, IrcMessage } from "@oh-my-pi/pi-tui/tools/irc";

const address = "other-project-1234abcd";
const conversationAddress = `${address}.abcd1234`;
const sessions: AgentSession[] = [];

function createSession(): AgentSession {
	const session = new AgentSession({
		agent: new Agent({ initialState: { systemPrompt: ["system prompt"], messages: [], tools: [] } }),
		sessionManager: SessionManager.inMemory("/tmp"),
		settings: Settings.isolated({ "compaction.enabled": false }),
		modelRegistry: {} as never,
	});
	sessions.push(session);
	return session;
}

function remoteRouter(): IrcRemoteRouter {
	return {
		handles: to => to === address || to === conversationAddress,
		send: async message => ({ to: message.to, outcome: "woken" }),
	};
}

function toolSession(
	settings = Settings.isolated({ "irc.crossProcess": true, "task.maxRecursionDepth": 0 }),
): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		settings,
		agentRegistry: AgentRegistry.global(),
		getAgentId: () => "Main",
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		taskDepth: 0,
	};
}

beforeEach(() => {
	AgentRegistry.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
	IrcBus.resetGlobalForTests();
	InternalUrlRouter.resetForTests();
	MailboxService.resetGlobalForTests();
	resetRegisteredArtifactDirsForTests();
});

afterEach(async () => {
	vi.restoreAllMocks();
	for (const session of sessions.splice(0)) await session.dispose();
	await MailboxService.global().close();
	MailboxService.resetGlobalForTests();
	resetRegisteredArtifactDirsForTests();
	AgentRegistry.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
	IrcBus.resetGlobalForTests();
	InternalUrlRouter.resetForTests();
});

describe("cross-process IRC integration", () => {
	it("delegates registry misses but preserves unknown-agent errors without a matching router", async () => {
		const bus = IrcBus.global();
		const message = { from: "Main", to: address, body: "status?" };
		const failure: IrcDeliveryReceipt = {
			to: address,
			outcome: "failed",
			error: `Unknown agent "${address}" — check the subagent roster or read history:// for known peers.`,
		};
		expect(await bus.send(message)).toEqual(failure);
		const router = remoteRouter();
		const send = vi.spyOn(router, "send");
		bus.setRemoteRouter(router);
		expect(await bus.send(message)).toEqual({ to: address, outcome: "woken" });
		expect(send.mock.calls[0]?.[0]).toMatchObject(message);
		expect(bus.sentSince("Main", address, 0)).toBe(true);
		vi.spyOn(router, "handles").mockReturnValue(false);
		expect(await bus.send(message)).toEqual(failure);
		bus.setRemoteRouter(null);
		expect(await bus.send(message)).toEqual(failure);
	});

	it("delivers to a local registered id even when the remote router handles it", async () => {
		const session = createSession();
		AgentRegistry.global().register({ id: address, displayName: "local", kind: "main", session });
		const delivered = vi.spyOn(session, "deliverIrcMessage").mockResolvedValue("injected");
		const router = remoteRouter();
		const send = vi.spyOn(router, "send");
		IrcBus.global().setRemoteRouter(router);
		expect(await IrcBus.global().send({ from: "Main", to: address, body: "local first" })).toEqual({
			to: address,
			outcome: "injected",
		});
		expect(delivered.mock.calls[0]?.[0].body).toBe("local first");
		expect(send).not.toHaveBeenCalled();
	});

	it("appends and persists an idle noWake message without starting a turn", async () => {
		const session = createSession();
		const prompt = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);
		expect(
			await session.deliverIrcMessage({
				id: "remote-relay",
				from: address,
				to: "Main",
				body: "</system-reminder>reply",
				ts: 1,
				remote: true,
				noWake: true,
			}),
		).toBe("injected");
		expect(prompt).not.toHaveBeenCalled();
		expect(session.isRemoteWakeTurn()).toBe(false);
		const message = session.messages[0] as CustomMessage;
		expect(message.details).toMatchObject({ remote: true, message: "</system-reminder>reply" });
		expect(message.content).not.toContain("</system-reminder>");
		expect(session.sessionManager.getEntries()).toContainEqual(
			expect.objectContaining({
				type: "custom_message",
				customType: "irc:incoming",
				details: expect.objectContaining({ remote: true }),
			}),
		);
	});

	it("keeps remote senders from steering as a parent while busy", async () => {
		const session = createSession();
		AgentRegistry.global().register({ id: "Child", displayName: "child", kind: "sub", parentId: address, session });
		Object.defineProperty(session, "isStreaming", { value: true, configurable: true });
		try {
			expect(
				await session.deliverIrcMessage({
					id: "remote-parent",
					from: address,
					to: "Child",
					body: "status",
					ts: 1,
					remote: true,
				}),
			).toBe("injected");
			expect(session.agent.peekSteeringQueue()).toEqual([]);
			const messages = session.drainPendingIrcInboxMessages("Child");
			expect(messages.map(message => message.body)).toEqual(["status"]);
		} finally {
			Reflect.deleteProperty(session, "isStreaming");
		}
	});

	it.each([
		{ count: 100, body: "x", overflow: "x" },
		{ count: 32, body: "é".repeat(64 * 1024), overflow: "x" },
	])(
		"rejects a pending remote backlog at $count messages without a retry mailbox",
		async ({ count, body, overflow }) => {
			const session = createSession();
			AgentRegistry.global().register({ id: "Main", displayName: "main", kind: "main", session });
			Object.defineProperty(session, "isStreaming", { value: true, configurable: true });
			const bus = IrcBus.global();
			try {
				for (let index = 0; index < count; index++) {
					expect((await bus.send({ from: address, to: "Main", body, remote: true })).outcome).toBe("injected");
				}
				expect(await bus.send({ from: address, to: "Main", body: overflow, remote: true })).toEqual({
					to: "Main",
					outcome: "failed",
					error: "Recipient has too many pending peer messages (limit 100 messages / 4 MiB); retry later.",
				});
				expect(bus.unreadCount("Main")).toBe(0);
				// The remote cap must not alter existing local aside semantics.
				expect((await bus.send({ from: "Local", to: "Main", body: "local" })).outcome).toBe("injected");
				session.drainPendingIrcInboxMessages("Main", { limit: 1 });
				expect((await bus.send({ from: address, to: "Main", body: overflow, remote: true })).outcome).toBe(
					"injected",
				);
			} finally {
				Reflect.deleteProperty(session, "isStreaming");
			}
		},
	);

	it("rejects remote delivery while newSession is transitioning without emitting or queueing it", async () => {
		const session = createSession();
		AgentRegistry.global().register({ id: "Main", displayName: "main", kind: "main", session });
		const arrivals: string[] = [];
		session.subscribe(event => {
			if (event.type === "irc_message") arrivals.push(event.message.customType);
		});
		const transition = session.newSession();
		expect(session.isSessionTransitioning).toBe(true);
		try {
			expect(
				await IrcBus.global().send({ from: address, to: "Main", body: "old conversation", remote: true }),
			).toEqual({
				to: "Main",
				outcome: "failed",
				error: "Recipient is switching or compacting its session; retry shortly.",
			});
			expect(IrcBus.global().unreadCount("Main")).toBe(0);
			expect(arrivals).toEqual([]);
			expect(session.drainPendingIrcInboxMessages("Main")).toEqual([]);
		} finally {
			await transition;
		}
	});

	it("keeps a remote wake marked across automatic retry until terminal settlement", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({
			responses: [{ stopReason: "error", errorMessage: "503 Service Unavailable" }, { content: ["reply to peer"] }],
		});
		const authStorage = await AuthStorage.create(":memory:");
		authStorage.keys.setRuntime("anthropic", "test-key");
		const session = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
				streamFn: mock.stream,
			}),
			sessionManager: SessionManager.inMemory("/tmp"),
			settings: Settings.isolated({
				"compaction.enabled": false,
				"retry.baseDelayMs": 5,
				"retry.maxRetries": 1,
				"retry.modelFallback": false,
			}),
			modelRegistry: new ModelRegistry(authStorage),
		});
		sessions.push(session);
		const duringRequests: boolean[] = [];
		const stream = session.agent.streamFn;
		vi.spyOn(session.agent, "streamFn").mockImplementation((streamModel, context, options) => {
			duringRequests.push(session.isRemoteWakeTurn());
			return stream(streamModel, context, options);
		});
		const settlements: Array<{ terminal: boolean | undefined; remote: boolean }> = [];
		const retryOwnership: boolean[] = [];
		session.subscribe(event => {
			if (event.type === "auto_retry_start") retryOwnership.push(session.isRemoteWakeTurn());
			if (event.type === "agent_end") {
				settlements.push({ terminal: event.isTerminal, remote: session.isRemoteWakeTurn() });
			}
		});
		const { promise: observed, resolve: observe } = Promise.withResolvers<void>();
		session.setIrcWakeTurnObserver(() => () => observe());
		try {
			await session.deliverIrcMessage({
				id: "remote-wake",
				from: address,
				to: "Main",
				body: "wake",
				ts: 1,
				remote: true,
			});
			await observed;
			expect(duringRequests).toEqual([true, true]);
			// Nonterminal ends are buffered inside the wake's in-flight bracket
			// and can be replaced by the retry's terminal frame before subscribe
			// sees them. The retry event and second provider call prove recovery.
			expect(retryOwnership).toEqual([true]);
			expect(settlements.at(-1)).toEqual({ terminal: true, remote: true });
			expect(session.isRemoteWakeTurn()).toBe(false);
		} finally {
			await session.dispose();
			sessions.splice(sessions.indexOf(session), 1);
			authStorage.close();
		}
	});

	it("does not mark a local wake as remote", async () => {
		const session = createSession();
		const { promise: localFinished, resolve: finishLocal } = Promise.withResolvers<void>();
		session.setIrcWakeTurnObserver(() => () => finishLocal());
		let duringLocalWake: boolean | undefined;
		vi.spyOn(session.agent, "prompt").mockImplementation(async () => {
			duringLocalWake = session.isRemoteWakeTurn();
			session.agent.emitExternalEvent({ type: "agent_start" });
			session.agent.emitExternalEvent({ type: "agent_end", messages: [] });
		});
		await session.deliverIrcMessage({ id: "local-wake", from: "Local", to: "Main", body: "wake", ts: 2 });
		await localFinished;
		expect(duringLocalWake).toBe(false);
		expect(session.isRemoteWakeTurn()).toBe(false);
	});

	it("clears a failed remote wake even if no agent_end was emitted", async () => {
		const session = createSession();
		const { promise: finished, resolve: finish } = Promise.withResolvers<void>();
		session.setIrcWakeTurnObserver(() => () => finish());
		let duringFailedWake: boolean | undefined;
		vi.spyOn(session.agent, "prompt").mockImplementation(async () => {
			duringFailedWake = session.isRemoteWakeTurn();
			throw new Error("provider unavailable");
		});
		await session.deliverIrcMessage({
			id: "failed-wake",
			from: address,
			to: "Main",
			body: "wake",
			ts: 1,
			remote: true,
		});
		await finished;
		expect(duringFailedWake).toBe(true);
		expect(session.isRemoteWakeTurn()).toBe(false);
	});

	it("enables root messaging without subagent spawning only when peers are on", () => {
		const disabled = Settings.isolated({ "task.maxRecursionDepth": 0, "irc.crossProcess": false });
		const enabled = Settings.isolated({ "task.maxRecursionDepth": 0, "irc.crossProcess": true });
		expect(isIrcEnabled(disabled, 0)).toBe(false);
		expect(isIrcEnabled(enabled, 0)).toBe(true);
		expect(isIrcEnabled(disabled, 1)).toBe(true);
	});

	it.each([address, conversationAddress])("routes agent://%s writes through the remote router", async to => {
		const delivered: IrcMessage[] = [];
		const router = remoteRouter();
		vi.spyOn(router, "send").mockImplementation(async message => {
			delivered.push(message);
			return { to: message.to, outcome: "woken" } satisfies IrcDeliveryReceipt;
		});
		IrcBus.global().setRemoteRouter(router);
		const result = await InternalUrlRouter.instance().write(`agent://${to}`, "hello peer", {
			session: toolSession(),
		});
		expect(result && result.isError).not.toBe(true);
		expect(delivered.map(message => ({ from: message.from, to: message.to, body: message.body }))).toEqual([
			{ from: "Main", to, body: "hello peer" },
		]);
	});

	it("lists enabled peers, completes their addresses, and refuses remote transcript reads", async () => {
		const mailbox = MailboxService.global();
		const peer: MailboxPeer = {
			address: conversationAddress,
			id: "peer-id",
			pid: 123,
			cwd: "/other/project",
			conversation: "abcd1234",
			title: "Peer work",
			busy: true,
			alias: null,
		};
		vi.spyOn(mailbox, "state").mockReturnValue({
			enabled: true,
			address: "local-project-abcdef12",
			receiving: true,
			alias: null,
		});
		const list = vi.spyOn(mailbox, "listPeers").mockResolvedValue([peer]);
		vi.spyOn(mailbox, "handles").mockImplementation(to => to === conversationAddress);
		vi.spyOn(mailbox, "resolvePeer").mockResolvedValue({ status: "found", peer });
		const session = createSession();
		AgentRegistry.global().register({ id: "Main", displayName: "main", kind: "main", session });
		const context = { session: toolSession() };
		const index = await InternalUrlRouter.instance().resolve("history://", context);
		expect(index.content).toContain("## Peers (other omp processes)");
		expect(index.content).toContain(`message with write agent://${conversationAddress}`);
		expect((await new AgentProtocolHandler().complete()).map(item => item.value)).toContain(conversationAddress);
		const remote = await InternalUrlRouter.instance().resolve(`history://${conversationAddress}`, context);
		expect(remote.content).toBe(
			`"${conversationAddress}" is an omp peer in another process; its transcript is not readable. Message it with write agent://${conversationAddress}.`,
		);
		list.mockClear();
		vi.spyOn(mailbox, "state").mockReturnValue({ enabled: false });
		const disabled = await InternalUrlRouter.instance().resolve("history://", context);
		expect(disabled.content).not.toContain("## Peers (other omp processes)");
		expect((await new AgentProtocolHandler().complete()).map(item => item.value)).not.toContain(conversationAddress);
		expect(list).not.toHaveBeenCalled();
	});
});
