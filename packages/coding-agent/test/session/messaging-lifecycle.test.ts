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
import { MessagingService } from "@oh-my-pi/pi-coding-agent/messaging/service";
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

	async function makeSession(name: string, messaging = true, persisted = false, legacyTitle = false) {
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
		const legacyFile = temp.join(`legacy-${crypto.randomUUID()}.jsonl`);
		if (legacyTitle)
			await Bun.write(
				legacyFile,
				`${JSON.stringify({
					type: "session",
					version: 3,
					id: crypto.randomUUID(),
					timestamp: new Date().toISOString(),
					cwd: temp.path(),
					title: name,
					titleSource: "user",
				})}\n`,
			);
		const manager = legacyTitle
			? await SessionManager.open(legacyFile)
			: persisted
				? SessionManager.create(temp.path(), path.join(temp.path(), "sessions"))
				: SessionManager.inMemory(temp.path());
		if (!legacyTitle) await manager.setSessionName(name, "user");
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
			claimNames: legacyTitle ? undefined : false,
		});
		bindings.push(binding);
		binding.ready();
		return { session, manager, settings, contexts, binding };
	}

	function watchMessaging(session: AgentSession) {
		const stopped = Promise.withResolvers<void>();
		const installed = Promise.withResolvers<void>();
		const setMessaging = session.setMessaging.bind(session);
		vi.spyOn(session, "setMessaging").mockImplementation(service => {
			setMessaging(service);
			(service ? installed : stopped).resolve();
		});
		return { stopped, installed };
	}

	async function peerFor(sender: AgentSession, sessionId: string) {
		return (await sender.messaging!.listSessions()).find(peer => peer.sessionId === sessionId)!;
	}

	function nextWake(session: AgentSession) {
		const woken = Promise.withResolvers<void>();
		session.subscribe(event => {
			if (event.type === "agent_start") woken.resolve();
		});
		return woken.promise;
	}

	function pauseAbort(session: AgentSession) {
		const reached = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const abort = session.abort.bind(session);
		vi.spyOn(session, "abort").mockImplementation(async options => {
			await abort(options);
			reached.resolve();
			await release.promise;
		});
		return { reached, release };
	}

	it("keeps cutoff permanent when an in-flight settings reconcile recreates the service", async () => {
		const owner = await makeSession("cutoff-owner");
		const peer = await makeSession("cutoff-peer");
		const { stopped, installed } = watchMessaging(owner.session);
		cfgMessagingEnabled.override(owner.settings, false);
		await stopped.promise;
		const start = MessagingService.start;
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		vi.spyOn(MessagingService, "start").mockImplementation(async (...args) => {
			const service = await start(...args);
			started.resolve();
			await release.promise;
			return service;
		});
		cfgMessagingEnabled.override(owner.settings, true);
		await started.promise;
		owner.binding.stopReceiving();
		release.resolve();
		await installed.promise;
		expect(owner.session.messaging).toBeDefined();
		const target = (await peer.session.messaging!.listSessions())[0];
		expect(await peer.session.messaging!.send(target, "late inbound", { notifyWhenIdle: false })).toEqual({
			ok: false,
			text: "Failed to send to cutoff-owner: the session is no longer running.",
		});
		const remote = (await owner.session.messaging!.listSessions())[0];
		expect((await owner.session.messaging!.send(remote, "outbound remains", { notifyWhenIdle: false })).ok).toBe(
			true,
		);
		await peer.session.waitForIdle();
		expect(peer.contexts.some(context => context.includes("outbound remains"))).toBe(true);
		expect(owner.contexts).toEqual([]);
	});

	it("closes a switch publication paused across disable before re-enable publishes another inbox", async () => {
		const owner = await makeSession("owner", true, true);
		const successor = await makeSession("successor", false, true);
		const oldService = owner.session.messaging!;
		const published = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const closing = Promise.withResolvers<void>();
		const { stopped, installed } = watchMessaging(owner.session);
		const publications: transport.InboxPublication[] = [];
		const close = oldService.close.bind(oldService);
		vi.spyOn(oldService, "close").mockImplementation(() => {
			const pending = close();
			closing.resolve();
			return pending;
		});
		vi.spyOn(transport, "publishInbox").mockImplementation(async (handler, options) => {
			const publication = await originalPublish(handler, {
				...options,
				dir: path.join(temp.path(), "inboxes"),
			});
			publications.push(publication);
			published.resolve();
			await release.promise;
			return publication;
		});
		try {
			expect(await owner.session.switchSession(successor.manager.getSessionFile()!)).toBe(true);
			await published.promise;
			cfgMessagingEnabled.override(owner.settings, false);
			await closing.promise;
			release.resolve();
			await stopped.promise;
			cfgMessagingEnabled.override(owner.settings, true);
			await installed.promise;
			const entries = (await transport.listInboxEntries()).filter(
				entry => entry.sessionId === successor.manager.getSessionId(),
			);
			expect(entries).toHaveLength(1);
			expect(entries[0]!.endpoint).toBe(owner.session.messaging!.env.OMP_MESSAGING_SOCKET);
			expect(await transport.requestInbox(entries[0]!, { type: "snapshot" })).toMatchObject({
				ok: true,
				snapshot: { sessionId: successor.manager.getSessionId() },
			});
		} finally {
			release.resolve();
			await Promise.all(publications.map(publication => publication.close()));
		}
	});

	it.each(["all", "@extension"])("keeps messaging bound for a persisted reserved title %s", async title => {
		const { session, manager } = await makeSession(title, true, false, true);
		expect(manager.titleSource).toBe("user");
		expect(manager.getSessionName()).toBe(title);
		expect(session.messaging).toBeDefined();
		expect(session.messaging!.ownAddress()).not.toBe(title);
		const own = (await transport.listInboxEntries()).find(
			entry => entry.endpoint === session.messaging!.env.OMP_MESSAGING_SOCKET,
		)!;
		const snapshot = await transport.requestInbox(own, { type: "snapshot" });
		expect(snapshot).toMatchObject({ ok: true, snapshot: { title, name: session.messaging!.ownAddress() } });
	});

	it("keeps real binding credentials session-scoped through bash, toggles and disposal", async () => {
		const keys = ["OMP_MESSAGING_SOCKET", "OMP_MESSAGING_TOKEN"] as const;
		const previous = keys.map(key => process.env[key]);
		for (const key of keys) delete process.env[key];
		vi.spyOn(Settings.prototype, "getShellConfig").mockReturnValue({
			shell: process.platform === "win32" ? (Bun.env.ComSpec ?? "cmd.exe") : "/bin/sh",
			args: process.platform === "win32" ? ["/c"] : ["-c"],
			env: { PATH: Bun.env.PATH ?? "", HOME: temp.path() },
			prefix: undefined,
		});
		try {
			const a = await makeSession("env-a");
			const b = await makeSession("env-b");
			const aEnv = a.session.messaging!.env;
			const bEnv = b.session.messaging!.env;
			expect(aEnv.OMP_MESSAGING_TOKEN).not.toBe(bEnv.OMP_MESSAGING_TOKEN);
			for (const key of keys) {
				expect(process.env[key]).toBeUndefined();
				expect(Bun.env[key]).toBeUndefined();
			}
			const child = Bun.spawn(
				[
					process.execPath,
					"-e",
					"process.stdout.write(JSON.stringify(Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('OMP_MESSAGING_')))))",
				],
				{ stdout: "pipe", stderr: "pipe" },
			);
			expect(await new Response(child.stdout).json()).toEqual({});
			expect(await child.exited).toBe(0);
			const probe = 'printf "%s|%s" "$OMP_MESSAGING_SOCKET" "$OMP_MESSAGING_TOKEN"';
			expect((await a.session.executeBash(probe)).output).toBe(
				`${aEnv.OMP_MESSAGING_SOCKET}|${aEnv.OMP_MESSAGING_TOKEN}`,
			);
			expect((await b.session.executeBash(probe)).output).toBe(
				`${bEnv.OMP_MESSAGING_SOCKET}|${bEnv.OMP_MESSAGING_TOKEN}`,
			);
			const { stopped } = watchMessaging(a.session);
			cfgMessagingEnabled.override(a.settings, false);
			await stopped.promise;
			expect(a.session.messaging).toBeUndefined();
			expect((await a.session.executeBash(probe)).output).toBe("|");
			expect((await b.session.executeBash(probe)).output).toBe(
				`${bEnv.OMP_MESSAGING_SOCKET}|${bEnv.OMP_MESSAGING_TOKEN}`,
			);
			for (const binding of bindings.splice(0)) await binding.dispose();
			for (const key of keys) expect(process.env[key]).toBeUndefined();
		} finally {
			for (const [index, key] of keys.entries()) {
				if (previous[index] === undefined) delete process.env[key];
				else process.env[key] = previous[index];
			}
		}
	});

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
		const target = await peerFor(sender.session, originalId);
		expect(target).toBeDefined();
		expect(await sender.session.messaging!.send(target, "SAVED_LOCAL_MAIL", { notifyWhenIdle: false })).toEqual({
			ok: true,
			text: "Queued for local (it will read this when receiving resumes).",
		});
		expect(contexts).toEqual([]);
		const woken = nextWake(session);
		await guest.leave("restore saved local");
		await woken;
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
			const { stopped, installed: ready } = watchMessaging(session);
			if (initiallyEnabled) {
				cfgMessagingEnabled.override(settings, false);
				await stopped.promise;
			}
			cfgMessagingEnabled.override(settings, true);
			await ready.promise;
			const target = await peerFor(sender.session, originalId);
			expect(target).toBeDefined();
			expect(session.isMessagingReceivingSuspended).toBe(true);
			expect((await sender.session.messaging!.send(target, "MID_GUEST_MAIL", { notifyWhenIdle: false })).text).toBe(
				"Queued for local (it will read this when receiving resumes).",
			);
			expect(manager.getSessionId()).toBe(replicaId);
			expect(contexts).toEqual([]);
			const woken = nextWake(session);
			await guest.leave("restore local");
			await woken;
			await session.waitForIdle();
			expect(contexts).toHaveLength(1);
			expect(contexts[0]).toContain("MID_GUEST_MAIL");
		});
	}

	for (const action of ["new", "switch"] as const) {
		it(`does not wake outgoing mail inside a committed ${action} transition`, async () => {
			const sender = await makeSession("sender");
			const { session, manager, contexts } = await makeSession("local", true, action === "switch");
			const target = await peerFor(sender.session, manager.getSessionId());
			const successor = action === "switch" ? await makeSession("successor", false, true) : undefined;
			const { reached, release } = pauseAbort(session);
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
		const target = await peerFor(sender.session, manager.getSessionId());
		const successor = await makeSession("successor", false, true);
		const { reached, release } = pauseAbort(session);
		const failure = new Error("adoption failed");
		const adopt = manager.setSessionFile.bind(manager);
		vi.spyOn(manager, "setSessionFile").mockImplementationOnce(async file => {
			await adopt(file);
			throw failure;
		});
		const transition = session.switchSession(successor.manager.getSessionFile()!);
		const woken = nextWake(session);
		try {
			await reached.promise;
			await sender.session.messaging!.send(target, "ROLLBACK_MAIL", { notifyWhenIdle: false });
			expect(contexts).toEqual([]);
			release.resolve();
			await expect(transition).rejects.toBe(failure);
			await woken;
			await session.waitForIdle();
			expect(manager.getSessionId()).toBe(target.sessionId);
			expect(contexts).toHaveLength(1);
			expect(contexts[0]).toContain("ROLLBACK_MAIL");
		} finally {
			release.resolve();
			await transition.catch(() => {});
		}
	});

	it("retires a pool-barrier wake across /new and releases capacity for the successor", async () => {
		const sender = await makeSession("sender");
		const { session, manager, contexts } = await makeSession("local");
		const target = await peerFor(sender.session, manager.getSessionId());
		const reached = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		vi.spyOn(session, "whenWorkPoolYieldSettled").mockImplementation(() => {
			reached.resolve();
			return release.promise;
		});
		const republished = Promise.withResolvers<void>();
		const service = session.messaging!;
		const retireConversation = service.retireConversation.bind(service);
		vi.spyOn(service, "retireConversation").mockImplementation(async () => {
			await retireConversation();
			republished.resolve();
		});
		const retired = Promise.withResolvers<string>();
		sender.session.subscribe(event => {
			if (event.type === "irc_message" && JSON.stringify(event.message).includes("dropped unread"))
				retired.resolve(JSON.stringify(event.message));
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
			for (let i = 0; i < 8; i++) await Promise.resolve();
			expect(contexts).toEqual([]);
			expect(JSON.stringify(session.messages)).not.toContain("POOL_WAIT_MAIL");
			expect(session.pendingRemoteCount()).toBe(0);
			expect(await retired.promise).toContain("Your message to @local was dropped unread");
			await republished.promise;
			const successor = await peerFor(sender.session, manager.getSessionId());
			const woken = nextWake(session);
			expect((await sender.session.messaging!.send(successor, "SUCCESSOR_MAIL", { notifyWhenIdle: false })).ok).toBe(
				true,
			);
			await woken;
			await session.waitForIdle();
			expect(contexts).toHaveLength(1);
			expect(contexts[0]).toContain("SUCCESSOR_MAIL");
			expect(session.pendingRemoteCount()).toBe(0);
		} finally {
			release.resolve();
			await transitioned;
		}
	});

	it("rechecks the transition after a remote wake's work-pool wait resolves", async () => {
		const sender = await makeSession("sender");
		const { session, manager, contexts } = await makeSession("local");
		const target = await peerFor(sender.session, manager.getSessionId());
		const poolReached = Promise.withResolvers<void>();
		const releasePool = Promise.withResolvers<void>();
		vi.spyOn(session, "whenWorkPoolYieldSettled").mockImplementation(() => {
			poolReached.resolve();
			return releasePool.promise;
		});
		await sender.session.messaging!.send(target, "LATE_POOL_MAIL", { notifyWhenIdle: false });
		await poolReached.promise;
		const { reached: abortReached, release: releaseAbort } = pauseAbort(session);
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
		const target = await peerFor(sender.session, manager.getSessionId());
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
		const target = await peerFor(sender.session, manager.getSessionId());
		const { reached, release } = pauseAbort(session);
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
