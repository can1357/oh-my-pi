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
import { ACCEPTED_QUEUE_CAP } from "@oh-my-pi/pi-coding-agent/messaging/protocol";
import { cfgMessagingEnabled, cfgMessagingRateLimit } from "@oh-my-pi/pi-coding-agent/messaging/settings";
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

	async function makeSession(name: string, messaging = true, persisted = false) {
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
		const manager = persisted
			? SessionManager.create(temp.path(), path.join(temp.path(), "sessions"))
			: SessionManager.inMemory(temp.path());
		await manager.setSessionName(name, "user");
		if (persisted) {
			await manager.ensureOnDisk();
			await manager.flush();
		}
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
		const binding = await bindSessionMessaging(session, {
			directPrint: false,
			exportProcessEnv: false,
			claimNames: false,
		});
		bindings.push(binding);
		binding.ready();
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
			handleResumeSession: async (file: string) => {
				await session.switchSession(file);
			},
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

	it("retires original mail rather than migrating it to a new local id after post-restoration rendering fails", async () => {
		const sender = await makeSession("sender");
		const { session, manager, contexts } = await makeSession("local");
		const { guest, ctx } = await join(session);
		const replicaId = manager.getSessionId();
		const target = (await sender.session.messaging!.listSessions()).find(
			peer => peer.shortId === session.messaging!.ownShortId(),
		);
		expect(target).toBeDefined();
		const receipt = await sender.session.messaging!.send(target!, "MAIL_AFTER_LOCAL_COMMIT", {
			notifyWhenIdle: false,
		});
		expect(receipt.ok).toBe(true);
		expect(contexts).toEqual([]);
		vi.spyOn(ctx, "renderInitialMessages").mockRejectedValueOnce(new Error("post-commit render failed"));

		await expect(guest.leave("restore local session")).rejects.toThrow("post-commit render failed");
		await session.whenWorkPoolYieldSettled();
		await session.waitForIdle();
		expect(manager.getSessionId()).not.toBe(replicaId);
		expect(contexts).toEqual([]);
		expect(JSON.stringify(session.messages)).not.toContain("MAIL_AFTER_LOCAL_COMMIT");
	});

	it("preserves saved original-conversation mail across guest adoption and successful restoration", async () => {
		const sender = await makeSession("sender");
		const { session, manager, contexts } = await makeSession("local", true, true);
		const originalId = manager.getSessionId();
		const { guest } = await join(session);
		const target = (await sender.session.messaging!.listSessions()).find(peer => peer.sessionId === originalId)!;
		expect(target).toBeDefined();
		expect(await sender.session.messaging!.send(target, "SAVED_LOCAL_MAIL", { notifyWhenIdle: false })).toEqual({
			ok: true,
			text: "Queued for local (it will read this when receiving resumes).",
		});
		expect(contexts).toEqual([]);
		const woken = Promise.withResolvers<void>();
		session.subscribe(event => {
			if (event.type === "agent_start") woken.resolve();
		});
		await guest.leave("restore saved local");
		await woken.promise;
		await session.waitForIdle();
		expect(manager.getSessionId()).toBe(originalId);
		expect(contexts).toHaveLength(1);
		expect(contexts[0]).toContain("SAVED_LOCAL_MAIL");
	});

	for (const initiallyEnabled of [false, true]) {
		it(`suspends receiving when messaging is enabled mid-guest (initially ${initiallyEnabled ? "on" : "off"})`, async () => {
			const sender = await makeSession("sender");
			const { session, manager, settings, contexts } = await makeSession("local", initiallyEnabled, true);
			const originalId = manager.getSessionId();
			const { guest } = await join(session);
			const replicaId = manager.getSessionId();
			const stopped = Promise.withResolvers<void>();
			const ready = Promise.withResolvers<void>();
			const originalSet = session.setMessaging.bind(session);
			vi.spyOn(session, "setMessaging").mockImplementation(service => {
				originalSet(service);
				if (service) ready.resolve();
				else stopped.resolve();
			});
			if (initiallyEnabled) {
				cfgMessagingEnabled.override(settings, false);
				await stopped.promise;
			}
			cfgMessagingEnabled.override(settings, true);
			await ready.promise;
			const target = (await sender.session.messaging!.listSessions()).find(peer => peer.sessionId === originalId)!;
			expect(target).toBeDefined();
			expect(session.isMessagingReceivingSuspended).toBe(true);
			expect((await sender.session.messaging!.send(target, "MID_GUEST_MAIL", { notifyWhenIdle: false })).text).toBe(
				"Queued for local (it will read this when receiving resumes).",
			);
			expect(manager.getSessionId()).toBe(replicaId);
			expect(contexts).toEqual([]);
			const woken = Promise.withResolvers<void>();
			session.subscribe(event => {
				if (event.type === "agent_start") woken.resolve();
			});
			await guest.leave("restore local");
			await woken.promise;
			await session.waitForIdle();
			expect(contexts).toHaveLength(1);
			expect(contexts[0]).toContain("MID_GUEST_MAIL");
		});
	}

	for (const action of ["new", "switch"] as const) {
		it(`does not wake outgoing mail inside a committed ${action} transition`, async () => {
			const sender = await makeSession("sender");
			const { session, manager, contexts } = await makeSession("local", true, action === "switch");
			const target = (await sender.session.messaging!.listSessions()).find(
				peer => peer.sessionId === manager.getSessionId(),
			)!;
			const successor = action === "switch" ? await makeSession("successor", false, true) : undefined;
			const reached = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const abort = session.abort.bind(session);
			vi.spyOn(session, "abort").mockImplementation(async options => {
				await abort(options);
				reached.resolve();
				await release.promise;
			});
			const retired = Promise.withResolvers<void>();
			sender.session.subscribe(event => {
				if (event.type === "irc_message" && JSON.stringify(event.message).includes("dropped unread"))
					retired.resolve();
			});
			const transition =
				action === "new" ? session.newSession() : session.switchSession(successor!.manager.getSessionFile()!);
			try {
				await reached.promise;
				expect(session.isSessionTransitioning).toBe(true);
				expect(
					(await sender.session.messaging!.send(target, "TRANSITION_MAIL", { notifyWhenIdle: false })).text,
				).toBe("Queued for local (it will read this when receiving resumes).");
				expect(contexts).toEqual([]);
				release.resolve();
				expect(await transition).toBe(true);
				await retired.promise;
				await session.waitForIdle();
				expect(contexts).toEqual([]);
				expect(JSON.stringify(session.messages)).not.toContain("TRANSITION_MAIL");
			} finally {
				release.resolve();
				await transition;
			}
		});
	}

	it("delivers an outgoing-owner batch once after switch rollback settles", async () => {
		const sender = await makeSession("sender");
		const { session, manager, contexts } = await makeSession("local", true, true);
		const target = (await sender.session.messaging!.listSessions()).find(
			peer => peer.sessionId === manager.getSessionId(),
		)!;
		const successor = await makeSession("successor", false, true);
		const reached = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const abort = session.abort.bind(session);
		vi.spyOn(session, "abort").mockImplementation(async options => {
			await abort(options);
			reached.resolve();
			await release.promise;
		});
		const failure = new Error("adoption failed");
		const adopt = manager.setSessionFile.bind(manager);
		vi.spyOn(manager, "setSessionFile").mockImplementationOnce(async file => {
			await adopt(file);
			throw failure;
		});
		const transition = session.switchSession(successor.manager.getSessionFile()!);
		const woken = Promise.withResolvers<void>();
		session.subscribe(event => {
			if (event.type === "agent_start") woken.resolve();
		});
		try {
			await reached.promise;
			await sender.session.messaging!.send(target, "ROLLBACK_MAIL", { notifyWhenIdle: false });
			expect(contexts).toEqual([]);
			release.resolve();
			await expect(transition).rejects.toBe(failure);
			await woken.promise;
			await session.waitForIdle();
			expect(manager.getSessionId()).toBe(target.sessionId);
			expect(contexts).toHaveLength(1);
			expect(contexts[0]).toContain("ROLLBACK_MAIL");
		} finally {
			release.resolve();
			await transition.catch(() => {});
		}
	});

	it("does not acquire in-flight ownership while a remote wake waits for the work-pool barrier", async () => {
		const sender = await makeSession("sender");
		const { session, manager, contexts } = await makeSession("local");
		const target = (await sender.session.messaging!.listSessions()).find(
			peer => peer.sessionId === manager.getSessionId(),
		)!;
		const reached = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		vi.spyOn(session, "whenWorkPoolYieldSettled").mockImplementation(() => {
			reached.resolve();
			return release.promise;
		});
		await sender.session.messaging!.send(target, "POOL_WAIT_MAIL", { notifyWhenIdle: false });
		await reached.promise;
		const transitioned = session.newSession();
		try {
			// The transition must finish even though the wake's pool wait is unresolved.
			expect(await transitioned).toBe(true);
			release.resolve();
			await session.waitForSessionTransition();
			await session.waitForIdle();
			expect(contexts).toEqual([]);
			expect(JSON.stringify(session.messages)).not.toContain("POOL_WAIT_MAIL");
		} finally {
			release.resolve();
			await transitioned;
		}
	});

	it("rechecks the transition after a remote wake's work-pool wait resolves", async () => {
		const sender = await makeSession("sender");
		const { session, manager, contexts } = await makeSession("local");
		const target = (await sender.session.messaging!.listSessions()).find(
			peer => peer.sessionId === manager.getSessionId(),
		)!;
		const poolReached = Promise.withResolvers<void>();
		const releasePool = Promise.withResolvers<void>();
		vi.spyOn(session, "whenWorkPoolYieldSettled").mockImplementation(() => {
			poolReached.resolve();
			return releasePool.promise;
		});
		await sender.session.messaging!.send(target, "LATE_POOL_MAIL", { notifyWhenIdle: false });
		await poolReached.promise;
		const abortReached = Promise.withResolvers<void>();
		const releaseAbort = Promise.withResolvers<void>();
		const abort = session.abort.bind(session);
		vi.spyOn(session, "abort").mockImplementation(async options => {
			await abort(options);
			abortReached.resolve();
			await releaseAbort.promise;
		});
		const transitioned = session.newSession();
		try {
			await abortReached.promise;
			releasePool.resolve();
			// Drain the wake's scheduled continuations while the real /new is paused.
			for (let i = 0; i < 8; i++) await Promise.resolve();
			expect(session.isSessionTransitioning).toBe(true);
			expect(contexts).toEqual([]);
			releaseAbort.resolve();
			expect(await transitioned).toBe(true);
			await session.waitForIdle();
			expect(contexts).toEqual([]);
			expect(JSON.stringify(session.messages)).not.toContain("LATE_POOL_MAIL");
		} finally {
			releasePool.resolve();
			releaseAbort.resolve();
			await transitioned;
		}
	});

	it("pins late-adoption mail to the original published inbox, not the adopted successor", async () => {
		const sender = await makeSession("sender");
		const { session, manager, contexts } = await makeSession("local", true, true);
		const target = (await sender.session.messaging!.listSessions()).find(
			peer => peer.sessionId === manager.getSessionId(),
		)!;
		const successor = await makeSession("successor", false, true);
		const adopted = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const adopt = manager.setSessionFile.bind(manager);
		vi.spyOn(manager, "setSessionFile").mockImplementationOnce(async file => {
			await adopt(file);
			adopted.resolve();
			await release.promise;
		});
		const retired = Promise.withResolvers<void>();
		sender.session.subscribe(event => {
			if (
				event.type === "irc_message" &&
				JSON.stringify(event.message).includes("Your message to @local was dropped unread")
			)
				retired.resolve();
		});
		const transition = session.switchSession(successor.manager.getSessionFile()!);
		try {
			await adopted.promise;
			expect(manager.getSessionId()).toBe(successor.manager.getSessionId());
			expect((await sender.session.messaging!.listSessions()).map(peer => peer.sessionId)).toContain(
				target.sessionId,
			);
			await sender.session.messaging!.send(target, "LATE_ADOPTION_MAIL", { notifyWhenIdle: false });
			await retired.promise;
			expect(contexts).toEqual([]);
			release.resolve();
			expect(await transition).toBe(true);
			await session.waitForIdle();
			expect(contexts).toEqual([]);
			expect(JSON.stringify(session.messages)).not.toContain("LATE_ADOPTION_MAIL");
		} finally {
			release.resolve();
			await transition;
		}
	});

	it("counts handoffs waiting for a real session transition toward the accepted queue cap", async () => {
		const sender = await makeSession("sender");
		const { session, manager, settings, contexts } = await makeSession("local");
		cfgMessagingRateLimit.override(sender.settings, 100);
		cfgMessagingRateLimit.override(settings, 100);
		const target = (await sender.session.messaging!.listSessions()).find(
			peer => peer.sessionId === manager.getSessionId(),
		)!;
		const reached = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const abort = session.abort.bind(session);
		vi.spyOn(session, "abort").mockImplementation(async options => {
			await abort(options);
			reached.resolve();
			await release.promise;
		});
		const transition = session.newSession();
		try {
			await reached.promise;
			for (let i = 0; i < ACCEPTED_QUEUE_CAP; i++) {
				expect(await sender.session.messaging!.send(target, `CAP_MAIL_${i}`, { notifyWhenIdle: false })).toEqual({
					ok: true,
					text: "Queued for local (it will read this when receiving resumes).",
				});
			}
			const overflow = await sender.session.messaging!.send(target, "CAP_OVERFLOW_MAIL", { notifyWhenIdle: false });
			expect(overflow.ok).toBe(false);
			expect(overflow.text).toContain("its queue of undelivered peer messages was full");
			expect(contexts).toEqual([]);
			release.resolve();
			expect(await transition).toBe(true);
			await session.waitForIdle();
			expect(contexts).toEqual([]);
			expect(JSON.stringify(session.messages)).not.toContain("CAP_MAIL_");
		} finally {
			release.resolve();
			await transition;
		}
	});
});
