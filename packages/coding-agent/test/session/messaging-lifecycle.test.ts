import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { generateRoomKey, importRoomKey } from "@oh-my-pi/pi-coding-agent/collab/crypto";
import { CollabGuestLink } from "@oh-my-pi/pi-coding-agent/collab/guest";
import { COLLAB_PROTO, formatCollabLink } from "@oh-my-pi/pi-coding-agent/collab/protocol";
import { CollabSocket } from "@oh-my-pi/pi-coding-agent/collab/relay-client";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import * as transport from "@oh-my-pi/pi-coding-agent/messaging/transport";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { bindSessionMessaging } from "@oh-my-pi/pi-coding-agent/session/messaging-host";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import * as sessionListing from "@oh-my-pi/pi-coding-agent/session/session-listing";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import * as utils from "@oh-my-pi/pi-utils";
import { installInMemoryRelay, uninstallInMemoryRelay } from "../collab/helpers/in-memory-relay";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

describe("cross-session messaging lifecycle", () => {
	let temp: TempDir;
	let auth: AuthStorage;
	const sessions: AgentSession[] = [];
	const bindings: Array<{ dispose(): Promise<void> }> = [];
	const guests: Array<{ guest: CollabGuestLink; socket: CollabSocket }> = [];
	const originalPublish = transport.publishInbox;
	const originalList = transport.listInboxEntries;
	const originalRequest = transport.requestInbox;
	const originalListAllSessions = sessionListing.listAllSessions;

	beforeEach(() => {
		temp = TempDir.createSync("@omp-messaging-lifecycle-");
		const dir = path.join(temp.path(), "inboxes");
		vi.spyOn(transport, "publishInbox").mockImplementation((handler, options) =>
			originalPublish(handler, { ...options, dir }),
		);
		vi.spyOn(transport, "listInboxEntries").mockImplementation(options => originalList({ ...options, dir }));
		vi.spyOn(transport, "requestInbox").mockImplementation((entry, request, options) =>
			originalRequest(entry, request, { ...options, dir }),
		);
		vi.spyOn(transport, "messagingRegistryDir").mockReturnValue(dir);
		vi.spyOn(sessionListing, "listAllSessions").mockImplementation(() =>
			originalListAllSessions(undefined, path.join(temp.path(), "sessions")),
		);
		vi.spyOn(utils, "getConfigRootDir").mockReturnValue(temp.path());
		AgentRegistry.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
		auth = createInMemoryAuthStorage();
		auth.keys.setRuntime("openai", "test-key");
	});

	afterEach(async () => {
		try {
			for (const { guest, socket } of guests.splice(0)) {
				try {
					await guest.leave("test cleanup").catch(() => {});
				} finally {
					socket.close();
				}
			}
			for (const binding of bindings.splice(0)) await binding.dispose();
			for (const session of sessions.splice(0)) await session.dispose();
		} finally {
			uninstallInMemoryRelay();
			vi.restoreAllMocks();
			auth.close();
			temp.removeSync();
			AgentRegistry.resetGlobalForTests();
			IrcBus.resetGlobalForTests();
		}
	});

	async function makeSession(name: string, messaging = true) {
		const contexts: string[] = [];
		const mock = createMockModel({
			provider: "openai",
			id: "messaging-lifecycle",
			handler(context) {
				contexts.push(JSON.stringify(context.messages));
				return { content: ["COMPLETION_FROM_PREVIOUS_CONVERSATION"] };
			},
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: mock.model, systemPrompt: ["Lifecycle harness"], tools: [], messages: [] },
			convertToLlm,
			streamFn: mock.stream,
		});
		const manager = SessionManager.inMemory(temp.path());
		await manager.setSessionName(name, "user");
		const settings = Settings.isolated({
			"messaging.enabled": messaging,
			"tools.approvalMode": "yolo",
			"compaction.enabled": false,
			"todo.enabled": false,
			"ttsr.enabled": false,
		});
		settings.setModelRole("default", `${mock.model.provider}/${mock.model.id}`);
		const session = new AgentSession({
			agent,
			sessionManager: manager,
			settings,
			modelRegistry: new ModelRegistry(auth),
			rebuildSystemPrompt: async () => ({ systemPrompt: ["Lifecycle harness"] }),
		});
		sessions.push(session);
		if (messaging) {
			const binding = await bindSessionMessaging(session, {
				directPrint: false,
				exportProcessEnv: false,
				claimNames: false,
			});
			bindings.push(binding);
			binding.ready();
		}
		return { session, manager, settings, contexts };
	}

	async function join(session: AgentSession) {
		installInMemoryRelay();
		const key = generateRoomKey();
		const roomId = `lifecycle-${crypto.randomUUID()}`;
		const socket = new CollabSocket({
			wsUrl: `ws://localhost:8788/r/${roomId}`,
			role: "host",
			key: await importRoomKey(key),
		});
		const opened = Promise.withResolvers<void>();
		socket.onOpen = () => opened.resolve();
		socket.onFrame = frame => {
			if (frame.t === "hello") {
				socket.send({
					t: "welcome",
					proto: COLLAB_PROTO,
					header: {
						type: "session",
						version: 3,
						id: crypto.randomUUID(),
						timestamp: new Date().toISOString(),
						cwd: temp.path(),
					},
					state: {
						isStreaming: false,
						queuedMessageCount: 0,
						sessionName: "replica",
						cwd: temp.path(),
						participants: [],
					},
					agents: [],
					entryCount: 0,
				});
			}
		};
		socket.connect();
		await opened.promise;
		const ctx = {
			settings: session.settings,
			sessionManager: session.sessionManager,
			session,
			statusContainer: { clear() {}, disposeChildren() {} },
			pendingMessagesContainer: { clear() {} },
			compactionQueuedMessages: [],
			pendingTools: new Map(),
			transcriptMessageComponents: new WeakMap(),
			statusLine: {
				setCollabStatus() {},
				invalidate() {},
				markActivityStart() {},
				markActivityEnd() {},
				getCachedContextBreakdown: () => ({ usedTokens: 0, contextWindow: 0 }),
				resetActiveTime() {},
			},
			ui: { requestRender() {} },
			chatContainer: { clear() {}, disposeChildren() {} },
			resetObserverRegistry() {},
			syncRunningSubagentBadge() {},
			renderInitialMessages: async () => {},
			reloadTodos: async () => {},
			showStatus() {},
			showError() {},
			updateEditorTopBorder() {},
			updateEditorBorderColor() {},
			eventController: { handleEvent: async () => {}, takeDisplaceableComponents: () => [] },
			collabGuest: undefined as CollabGuestLink | undefined,
			handleResumeSession: async () => {},
		};
		const guest = new CollabGuestLink(ctx as unknown as InteractiveModeContext);
		guests.push({ guest, socket });
		await guest.join(formatCollabLink("ws://localhost:8788", roomId, key));
		return { guest, ctx };
	}

	it("rejects eval admission synchronously when dispose starts with messaging disabled", async () => {
		const { session } = await makeSession("disposing", false);
		const disposing = session.dispose();
		try {
			expect(() => session.assertEvalExecutionAllowed()).toThrow("session disposal is in progress");
		} finally {
			await disposing;
		}
	});

	it("does not report the previous conversation's completion after a committed newSession", async () => {
		const { session, manager } = await makeSession("conversation-a");
		await session.agent.prompt("Complete conversation A.");
		await session.waitForIdle();
		const finished = session.lastFinished();
		expect(finished?.status).toBe("COMPLETION_FROM_PREVIOUS_CONVERSATION");
		await manager.setSessionName("renamed-a", "user");
		expect(session.lastFinished()).toBe(finished);
		const previousId = manager.getSessionId();
		expect(await session.newSession()).toBe(true);
		expect(manager.getSessionId()).not.toBe(previousId);
		expect(session.messages).toEqual([]);
		expect(session.lastFinished()).toBeUndefined();
	});

	it("keeps buffered mail from waking a replica after failed restoration, repeated leave, and disposal", async () => {
		const sender = await makeSession("sender");
		const { session, manager, contexts } = await makeSession("local");
		const localId = manager.getSessionId();
		const { guest, ctx } = await join(session);
		const replicaId = manager.getSessionId();
		expect(replicaId).not.toBe(localId);
		const target = (await sender.session.messaging!.listSessions()).find(
			peer => peer.shortId === session.messaging!.ownShortId(),
		);
		expect(target).toBeDefined();
		const receipt = await sender.session.messaging!.send(target!, "BUFFERED_REPLICA_MAIL", {
			notifyWhenIdle: false,
		});
		expect(receipt.ok).toBe(true);
		const promptSpy = vi.spyOn(session.agent, "prompt");
		vi.spyOn(session, "newSession").mockResolvedValueOnce(false);
		await expect(guest.leave("cancel restoration")).rejects.toThrow("Local session restoration was cancelled");
		await session.whenWorkPoolYieldSettled();
		await session.waitForIdle();
		expect(manager.getSessionId()).toBe(replicaId);
		expect(ctx.collabGuest).toBe(guest);
		expect(promptSpy).not.toHaveBeenCalled();
		expect(contexts).toEqual([]);

		await expect(guest.leave("retry restoration")).rejects.toThrow("Local session restoration was cancelled");
		await session.whenWorkPoolYieldSettled();
		await session.waitForIdle();
		expect(manager.getSessionId()).toBe(replicaId);
		expect(ctx.collabGuest).toBe(guest);
		expect(promptSpy).not.toHaveBeenCalled();
		expect(contexts).toEqual([]);

		await session.dispose();
		expect(promptSpy).not.toHaveBeenCalled();
		expect(contexts).toEqual([]);
	});
});
