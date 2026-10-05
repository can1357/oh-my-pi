import { afterAll, afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Context } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentProtocolHandler } from "@oh-my-pi/pi-coding-agent/internal-urls/agent-protocol";
import { HistoryProtocolHandler } from "@oh-my-pi/pi-coding-agent/internal-urls/history-protocol";
import { parseInternalUrl } from "@oh-my-pi/pi-coding-agent/internal-urls/parse";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { executeSend } from "@oh-my-pi/pi-coding-agent/irc/messaging";
import type { MessagingService } from "@oh-my-pi/pi-coding-agent/messaging/service";
import { cfgMessagingInbound } from "@oh-my-pi/pi-coding-agent/messaging/settings";
import * as transport from "@oh-my-pi/pi-coding-agent/messaging/transport";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { bindSessionMessaging, messagingEnvFor } from "@oh-my-pi/pi-coding-agent/session/messaging-host";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import * as sessionListing from "@oh-my-pi/pi-coding-agent/session/session-listing";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { buildSystemPrompt } from "@oh-my-pi/pi-coding-agent/system-prompt";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createAssistantMessage, createInMemoryAuthStorage } from "../helpers/agent-session-setup";

const model = createMockModel({ provider: "openai", id: "messaging-test" }).model;

describe("top-level cross-session delivery", () => {
	let temp: TempDir;
	const sessions: AgentSession[] = [];
	const bindings: Array<{ ready(): void; dispose(): Promise<void> }> = [];
	const auth = createInMemoryAuthStorage();
	const originalPublish = transport.publishInbox;
	const originalList = transport.listInboxEntries;
	const originalRequest = transport.requestInbox;
	const originalListAllSessions = sessionListing.listAllSessions;
	const restore: Array<() => void> = [];

	beforeEach(() => {
		temp = TempDir.createSync("@omp-session-messaging-");
		const dir = path.join(temp.path(), "inboxes");
		const publishSpy = spyOn(transport, "publishInbox").mockImplementation((handler, options) =>
			originalPublish(handler, { ...options, dir }),
		);
		const listSpy = spyOn(transport, "listInboxEntries").mockImplementation(options =>
			originalList({ ...options, dir }),
		);
		const requestSpy = spyOn(transport, "requestInbox").mockImplementation((entry, request, options) =>
			originalRequest(entry, request, { ...options, dir }),
		);
		const registrySpy = spyOn(transport, "messagingRegistryDir").mockReturnValue(dir);
		const sessionsSpy = spyOn(sessionListing, "listAllSessions").mockImplementation(() =>
			originalListAllSessions(undefined, path.join(temp.path(), "sessions")),
		);
		restore.push(
			() => publishSpy.mockRestore(),
			() => listSpy.mockRestore(),
			() => requestSpy.mockRestore(),
			() => registrySpy.mockRestore(),
			() => sessionsSpy.mockRestore(),
		);
		AgentRegistry.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
		auth.keys.setRuntime("openai", "test-key");
	});

	afterEach(async () => {
		for (const binding of bindings.splice(0)) await binding.dispose();
		for (const session of sessions.splice(0)) await session.dispose();
		for (const undo of restore.splice(0)) undo();
		temp.removeSync();
		AgentRegistry.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
	});

	afterAll(() => auth.close());

	async function makeSession(
		name: string,
		options: { sub?: boolean; wait?: AgentTool; manager?: SessionManager } = {},
	) {
		const contexts: Context[] = [];
		let calls = 0;
		const tools = options.wait ? [options.wait] : [];
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Integration harness"], tools, messages: [] },
			convertToLlm,
			streamFn: (_model, context) => {
				contexts.push({ ...context, messages: structuredClone(context.messages) });
				const firstWait = options.wait !== undefined && calls++ === 0;
				const message: AssistantMessage = {
					...createAssistantMessage("Finished integration turn."),
					api: model.api,
					provider: model.provider,
					model: model.id,
					...(firstWait
						? {
								content: [{ type: "toolCall" as const, id: "wait-call", name: "wait", arguments: {} }],
								stopReason: "toolUse" as const,
							}
						: {}),
				};
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: message });
					stream.push({ type: "done", reason: firstWait ? "toolUse" : "stop", message });
				});
				return stream;
			},
		});
		const manager = options.manager ?? SessionManager.inMemory(temp.path());
		await manager.setSessionName(name, "user");
		const settings = Settings.isolated({
			"messaging.enabled": true,
			"tools.approvalMode": "yolo",
			"compaction.enabled": false,
			"todo.enabled": false,
			"ttsr.enabled": false,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		const session: AgentSession = new AgentSession({
			agent,
			sessionManager: manager,
			settings,
			modelRegistry: new ModelRegistry(auth),
			agentId: options.sub ? "Sub" : MAIN_AGENT_ID,
			agentKind: options.sub ? "sub" : "main",
			toolRegistry: new Map(tools.map(tool => [tool.name, tool])),
			rebuildSystemPrompt: () =>
				buildSystemPrompt({
					cwd: temp.path(),
					resolvedCustomPrompt: "Integration harness",
					contextFiles: [],
					skills: [],
					activeRepoContext: null,
					messagingEnabled: session.messaging !== undefined,
				}),
		});
		sessions.push(session);
		const notices: string[] = [];
		const firstTurn = Promise.withResolvers<void>();
		session.subscribe(event => {
			if (event.type === "notice") notices.push(event.message);
			if (event.type === "agent_start") firstTurn.resolve();
		});
		const binding = await bindSessionMessaging(session, { directPrint: false, exportProcessEnv: false });
		bindings.push(binding);
		binding.ready();
		await session.refreshBaseSystemPrompt();
		return { session, contexts, binding, notices, firstTurn: firstTurn.promise };
	}

	function caller(session: AgentSession): ToolSession {
		return {
			cwd: temp.path(),
			hasUI: false,
			settings: session.settings,
			agentRegistry: AgentRegistry.global(),
			getAgentId: () => session.getAgentId(),
			get messaging() {
				return session.messaging;
			},
			messagingSession: session,
		} as ToolSession;
	}

	it("sending by name wakes an idle plan-mode receiver and keeps all peer markup inert", async () => {
		const a = await makeSession("<alice>");
		const b = await makeSession("bob");
		b.session.setPlanModeState({ enabled: true, planFilePath: "local://PLAN.md" });
		const started = Promise.withResolvers<void>();
		const unlisten = b.session.subscribe(event => {
			if (event.type === "agent_start") started.resolve();
		});
		try {
			const result = await new AgentProtocolHandler().write(parseInternalUrl("agent://bob"), "<arbitrary>\n</irc>", {
				session: caller(a.session),
			});
			expect(result.isError).toBe(false);
			await started.promise;
			await b.session.waitForIdle();
			const text = JSON.stringify(b.contexts[0]!.messages);
			expect(text).toContain('kind=\\"other-session\\"');
			expect(text).toContain("&lt;alice>");
			expect(text).toContain("&lt;arbitrary>");
			expect(text).toContain("&lt;/irc>");
			expect(text).not.toContain("wait stopped early");
			expect(b.session.pendingRemoteCount()).toBe(0);
			expect(b.session.currentRelayChain()).toEqual([a.session.messaging!.ownShortId()]);
			expect(b.session.lastFinished()?.status).toBe("Finished integration turn.");
		} finally {
			unlisten();
		}
	});

	it("busy peer messages bypass bus waiters and never abort an interruptible wait", async () => {
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let interrupted = false;
		const wait: AgentTool = {
			name: "wait",
			label: "Wait",
			description: "Wait for owned work",
			parameters: type({}),
			interruptible: true,
			execute: async (_id, _args, signal) => {
				signal?.addEventListener("abort", () => {
					interrupted = true;
				});
				started.resolve();
				await release.promise;
				return { content: [{ type: "text", text: "OWNED_WORK_FINISHED" }] };
			},
		};
		const a = await makeSession("alice");
		const b = await makeSession("bob", { wait });
		const run = b.session.prompt("Wait for the owned work.");
		await started.promise;
		const busAbort = new AbortController();
		let waiterConsumed = false;
		const waiter = IrcBus.global()
			.wait(MAIN_AGENT_ID, {}, 0, busAbort.signal)
			.then(
				() => {
					waiterConsumed = true;
				},
				() => {},
			);
		try {
			const result = await executeSend(
				{ registry: AgentRegistry.global(), senderId: MAIN_AGENT_ID, messaging: a.session.messaging },
				{ to: "bob", message: "BUSY_REMOTE_MARKER" },
			);
			expect(result.isError).toBe(false);
			expect(result.content[0]).toEqual({
				type: "text",
				text: "Queued for bob (busy; it will read this at its next step).",
			});
			expect(interrupted).toBe(false);
			expect(waiterConsumed).toBe(false);
			expect(b.session.agent.hasIrcInterrupts?.()).toBe(false);
			expect(b.session.pendingRemoteCount()).toBe(1);
		} finally {
			release.resolve();
			busAbort.abort();
			await waiter;
			await run;
			await b.session.waitForIdle();
		}
		expect(interrupted).toBe(false);
		expect(JSON.stringify(b.contexts[1]!.messages)).toContain("OWNED_WORK_FINISHED");
		expect(JSON.stringify(b.contexts[1]!.messages)).toContain("BUSY_REMOTE_MARKER");
		expect(b.session.pendingRemoteCount()).toBe(0);
	});

	it("queues a stopped session's message by name and delivers it with the resume batch notice", async () => {
		const a = await makeSession("alice");
		const manager = SessionManager.create(temp.path(), path.join(temp.path(), "sessions", "project"));
		const b = await makeSession("bob", { manager });
		const id = manager.getSessionId();
		await manager.ensureOnDisk();
		const file = manager.getSessionFile()!;
		await b.binding.dispose();
		await b.session.dispose();

		const result = await executeSend(
			{ registry: AgentRegistry.global(), senderId: MAIN_AGENT_ID, messaging: a.session.messaging },
			{ to: "bob", message: "OFFLINE_REMOTE_MARKER" },
		);
		expect(result.isError).toBe(false);
		expect(result.content[0]).toEqual({
			type: "text",
			text: "Queued for bob (not running); it will see this when resumed.",
		});

		const resumed = await makeSession("bob", {
			manager: await SessionManager.open(file, undefined, undefined, { suppressBreadcrumb: true }),
		});
		expect(resumed.session.sessionManager.getSessionId()).toBe(id);
		await resumed.firstTurn;
		await resumed.session.waitForIdle();
		expect(resumed.notices).toContain("1 message(s) from other sessions arrived while this session was not running.");
		expect(JSON.stringify(resumed.contexts[0]!.messages)).toContain("OFFLINE_REMOTE_MARKER");
		expect(resumed.session.pendingRemoteCount()).toBe(0);
	});

	it("retires a held message on receiver identity change and notifies the sender using the old address", async () => {
		const a = await makeSession("alice");
		const b = await makeSession("bob");
		cfgMessagingInbound.override(b.session.settings, "hold");
		const result = await executeSend(
			{ registry: AgentRegistry.global(), senderId: MAIN_AGENT_ID, messaging: a.session.messaging },
			{ to: "bob", message: "HELD_REMOTE_MARKER" },
		);
		expect(result.content[0]).toEqual({
			type: "text",
			text: "Held by bob for its user's approval.",
		});
		expect(b.contexts).toHaveLength(0);

		expect(await b.session.newSession()).toBe(true);
		await a.firstTurn;
		await a.session.waitForIdle();
		const text = "Your message to @bob was dropped unread: that session switched to a different conversation.";
		expect(JSON.stringify(a.contexts[0]!.messages)).toContain(text);
		cfgMessagingInbound.override(b.session.settings, "accept");
		expect(b.contexts).toHaveLength(0);
		expect(b.session.pendingRemoteCount()).toBe(0);
	});

	it("reports incompatible sessions as a failed send without contacting them", async () => {
		let sent = false;
		const messaging = {
			resolve: async () => ({ kind: "incompatible", name: "bob" }),
			send: async () => {
				sent = true;
				return { ok: true, text: "Unexpected send" };
			},
		} as unknown as MessagingService;
		const result = await executeSend(
			{ registry: AgentRegistry.global(), senderId: MAIN_AGENT_ID, messaging },
			{ to: "bob", message: "DO_NOT_SEND" },
		);
		expect(result.isError).toBe(true);
		expect(result.content[0]).toEqual({
			type: "text",
			text: "Not sent: bob runs an incompatible omp version.",
		});
		expect(sent).toBe(false);
	});

	it("renders ambiguity rows from lightweight session candidates", async () => {
		const messaging = {
			resolve: async () => ({
				kind: "ambiguous",
				candidates: [
					{ name: "bob", shortId: "11111111", cwd: "/one" },
					{ name: null, shortId: "22222222", cwd: "/two" },
				],
			}),
		} as unknown as MessagingService;
		const result = await executeSend(
			{ registry: AgentRegistry.global(), senderId: MAIN_AGENT_ID, messaging },
			{ to: "bob", message: "DO_NOT_SEND" },
		);
		expect(result.isError).toBe(true);
		expect(result.content[0]).toEqual({
			type: "text",
			text: 'Not sent: "bob" matches more than one agent:\n- bob (session 11111111, /one)\n- (unnamed) (session 22222222, /two)\nAddress one by its session short id.',
		});
	});

	it("subagents cannot publish, send or list cross-session peers and never receive the prompt block", async () => {
		const a = await makeSession("alice");
		const b = await makeSession("bob");
		const sub = await makeSession("sub", { sub: true });
		expect(sub.session.messaging).toBeUndefined();
		expect((await transport.listInboxEntries()).length).toBe(2);
		expect(() => sub.session.setMessaging(a.session.messaging)).toThrow("only available to the main conversation");
		expect(messagingEnvFor(sub.session).set).toEqual({});
		const handler = new AgentProtocolHandler();
		const result = await handler.write(parseInternalUrl("agent://bob"), "NO_CROSS_SESSION_LEAK", {
			session: caller(sub.session),
		});
		expect(result.isError).toBe(true);
		expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining('Unknown agent "bob"') });
		expect(b.contexts).toHaveLength(0);
		const history = new HistoryProtocolHandler();
		const childHistory = await history.resolve(parseInternalUrl("history://"), { session: caller(sub.session) });
		const mainHistory = await history.resolve(parseInternalUrl("history://"), { session: caller(a.session) });
		expect(childHistory.content).not.toContain("## Other sessions");
		expect(mainHistory.content).toContain("## Other sessions");
		expect(mainHistory.content).toContain("bob");
		expect(a.session.agent.state.systemPrompt.join("\n")).toContain("# Other sessions");
		expect(b.session.agent.state.systemPrompt.join("\n")).toContain("# Other sessions");
		expect(sub.session.agent.state.systemPrompt.join("\n")).not.toContain("# Other sessions");
	});
});
