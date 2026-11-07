/**
 * Contract: `CollabController` owns local discovery for every ordinary
 * interactive process, independently of opt-in remote hosting. Local agent
 * delivery uses real authenticated IPC and the synchronous session admission
 * boundary, never the human/remote-guest prompt paths. `collab.autoStart`
 * installs a room before extension hooks run and retains
 * dialogs raised before the relay connects; the registry sees one entry per
 * process keyed by a stable instance ID with an increasing generation; a
 * session switch revokes the old room before its successor is published;
 * same-ID transitions and rollback retire local capabilities while retaining
 * the remote room; and published access caps what `omp collab link` can obtain.
 *
 * Real CollabHost/CollabSocket run over the in-memory relay; the registry's
 * real Unix-socket IPC is redirected into a temp dir via a spy on
 * `publishCollabHost`, exactly as in host-registry.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, type Mock, spyOn, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { closeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { CollabController } from "@oh-my-pi/pi-coding-agent/collab/controller";
import { importRoomKey } from "@oh-my-pi/pi-coding-agent/collab/crypto";
import { CollabGuestLink } from "@oh-my-pi/pi-coding-agent/collab/guest";
import { CollabHost, CollabHostStoppedError } from "@oh-my-pi/pi-coding-agent/collab/host";
import { COLLAB_PROTO, type CollabFrame, parseCollabLink } from "@oh-my-pi/pi-coding-agent/collab/protocol";
import * as registry from "@oh-my-pi/pi-coding-agent/collab/registry";
import { CollabSocket } from "@oh-my-pi/pi-coding-agent/collab/relay-client";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as pluginHelpers from "@oh-my-pi/pi-coding-agent/discovery/helpers";
import { clearOmpExtensionCliRoots } from "@oh-my-pi/pi-coding-agent/discovery/omp-extension-roots";
import { runRootCommand } from "@oh-my-pi/pi-coding-agent/main";
import { Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { beginStartupComposer, stopPendingStartupComposer } from "@oh-my-pi/pi-coding-agent/modes/startup-composer";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { HistoryStorage } from "@oh-my-pi/pi-coding-agent/session/history-storage";
import { closeSessionIndex } from "@oh-my-pi/pi-coding-agent/session/session-index";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import { IpcConnection, IpcServer, ipcEndpoint } from "@oh-my-pi/pi-natives";
import { getProjectDir, setProjectDir } from "@oh-my-pi/pi-utils";
import * as utils from "@oh-my-pi/pi-utils";
import { VirtualTerminal } from "../../../tui/test/virtual-terminal";
import { assistantMsg, createTestSession, type TestSessionContext, userMsg } from "../utilities";
import { FakeWebSocket, installInMemoryRelay, uninstallInMemoryRelay } from "./helpers/in-memory-relay";

import { cfgCollabAutoStart } from "@oh-my-pi/pi-coding-agent/collab/settings";
import { cfgAdvisorEnabled } from "@oh-my-pi/pi-coding-agent/advisor/settings";
import { CfgProtocolHandler } from "@oh-my-pi/pi-coding-agent/internal-urls/cfg-protocol";
import { parseInternalUrl } from "@oh-my-pi/pi-coding-agent/internal-urls/parse";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import {
	cfgMarketplaceAutoUpdate,
	cfgStartupChangelogMode,
	cfgStartupCheckUpdate,
	cfgStartupSetupWizard,
	cfgStartupShowSplash,
} from "@oh-my-pi/pi-coding-agent/modes/settings";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const originalPiProfile = process.env.PI_PROFILE;
const originalOmpProfile = process.env.OMP_PROFILE;

function restoreEnv(key: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[key];
	} else {
		process.env[key] = value;
	}
}

const RELAY_URL = "ws://localhost:8788";
const WEB_URL = "https://collab.example";

interface ControllerContextState {
	sessionId: string;
	sessionName: string;
	isStreaming: boolean;
	/** Calls to the synchronous AgentSession boundary; real-session execution is covered separately. */
	admissions: {
		message: Parameters<InteractiveModeContext["session"]["admitAgentMessage"]>[0];
		expectedSessionId: string;
		expectedSessionTransitionEpoch: number;
	}[];
	humanPrompts: string[];
	sessionTransitionEpoch: number;
	transition?: Promise<void>;
	transitionWaited?: () => void;
	/** Real settings carrying the collab relay/web/auto-start values the controller reads. */
	settings: Settings;
	showStatus: string[];
	/** Resolves with the first status message the controller shows. */
	firstStatus: PromiseWithResolvers<string>;
	/** Session-change callbacks registered by the controller under test. */
	sessionChangeCallbacks: Set<() => void>;
	/** Persistence-notice observers registered by the controller under test. */
	sessionMoveCallbacks: Set<() => void>;
	/** Synchronous outer-transition begin/end observers. */
	sessionTransitionCallbacks: Set<() => void>;
	/** Resolves each time a host clears its status-line segment (tore down). */
	tornDown: (() => void)[];
	/** Guest prompts a host forwarded into the session. */
	prompts: string[];
	/** Resolves each time a guest prompt is forwarded. */
	prompted: (() => void)[];
}

/**
 * Minimal InteractiveModeContext for a controller: settings, the mutable
 * session identity, synchronous transition epoch and session-change observers,
 * and the observable seams (status messages, status-line collab segment).
 */
function makeControllerContext(over: { autoStart?: "off" | "view" | "control"; relayUrl?: string } = {}): {
	ctx: InteractiveModeContext;
	state: ControllerContextState;
} {
	let transition: Promise<void> | undefined;
	const state: ControllerContextState = {
		sessionId: `sess-${crypto.randomUUID()}`,
		sessionName: "controller-test",
		isStreaming: false,
		admissions: [],
		humanPrompts: [],
		sessionTransitionEpoch: 0,
		get transition() {
			return transition;
		},
		set transition(value: Promise<void> | undefined) {
			if (value === transition) return;
			const beginning = transition === undefined;
			transition = value;
			if (beginning) state.sessionTransitionEpoch++;
			if (beginning || value === undefined) {
				for (const callback of state.sessionTransitionCallbacks) callback();
			}
		},
		settings: Settings.isolated({
			"collab.autoStart": over.autoStart ?? "off",
			"collab.relayUrl": over.relayUrl ?? RELAY_URL,
			"collab.webUrl": WEB_URL,
		}),
		showStatus: [],
		firstStatus: Promise.withResolvers<string>(),
		sessionChangeCallbacks: new Set(),
		sessionMoveCallbacks: new Set(),
		sessionTransitionCallbacks: new Set(),
		tornDown: [],
		prompts: [],
		prompted: [],
	};
	const ctx = {
		settings: state.settings,
		sessionManager: {
			getSessionId: () => state.sessionId,
			getCwd: () => "/tmp/collab-controller-test",
			snapshotForReplication: () => ({
				header: {
					type: "session",
					id: state.sessionId,
					timestamp: "2026-07-20T00:00:00Z",
					cwd: "/tmp/collab-controller-test",
				},
				entries: [],
			}),
			onEntryAppended: undefined,
			onPersistenceNotice: (cb: () => void) => {
				state.sessionMoveCallbacks.add(cb);
				return () => state.sessionMoveCallbacks.delete(cb);
			},
		},
		session: {
			get sessionTransitionEpoch() {
				return state.sessionTransitionEpoch;
			},
			get isSessionTransitioning() {
				return state.transition !== undefined;
			},
			waitForSessionTransition: async () => {
				state.transitionWaited?.();
				await state.transition;
			},
			get isStreaming() {
				return state.isStreaming;
			},
			queuedMessageCount: 0,
			get sessionName() {
				return state.sessionName;
			},
			model: { provider: "test-provider", id: "test-model" },
			thinkingLevel: undefined,
			subscribe: () => () => {},
			emitNotice: () => {},
			admitAgentMessage: (
				message: Parameters<InteractiveModeContext["session"]["admitAgentMessage"]>[0],
				expectedSessionId: string,
				expectedSessionTransitionEpoch: number,
			) => {
				if (
					state.transition !== undefined ||
					state.sessionId !== expectedSessionId ||
					state.sessionTransitionEpoch !== expectedSessionTransitionEpoch
				) {
					throw new Error("Session unavailable for agent message admission");
				}
				state.admissions.push({ message, expectedSessionId, expectedSessionTransitionEpoch });
			},
			prompt: (content: string) => {
				state.humanPrompts.push(content);
				return Promise.resolve();
			},
			promptCustomMessage: (message: { content: unknown }) => {
				state.prompts.push(String(message.content));
				state.prompted.shift()?.();
				return Promise.resolve();
			},
			abort: () => Promise.resolve(),
			registerSessionTransitionCallback: (cb: () => void) => {
				state.sessionTransitionCallbacks.add(cb);
				return () => state.sessionTransitionCallbacks.delete(cb);
			},
			registerSessionChangeCallback: (cb: () => void) => {
				state.sessionChangeCallbacks.add(cb);
				return () => state.sessionChangeCallbacks.delete(cb);
			},
		},
		eventBus: undefined,
		editor: { setText: () => {} },
		statusLine: {
			setCollabStatus: (status: unknown) => {
				if (status === null) state.tornDown.shift()?.();
			},
			invalidate: () => {},
			getCachedContextBreakdown: () => ({ usedTokens: 0, contextWindow: 0 }),
		},
		ui: { requestRender: () => {} },
		showStatus: (message: string) => {
			state.showStatus.push(message);
			state.firstStatus.resolve(message);
		},
		collabHost: undefined,
	};
	return { ctx: ctx as unknown as InteractiveModeContext, state };
}

/** Simulate AgentSession adopting a new session id: mutate, then notify. */
function switchSession(state: ControllerContextState, sessionId: string): void {
	state.sessionId = sessionId;
	for (const cb of state.sessionChangeCallbacks) cb();
}

/**
 * Simulate SessionManager moving the session to a sibling file because the
 * original is open in another omp process: it re-ids, then raises a
 * persistence notice; AgentSession's session-change callbacks never run.
 */
function moveSessionFile(state: ControllerContextState, sessionId: string): void {
	state.sessionId = sessionId;
	for (const cb of state.sessionMoveCallbacks) cb();
}

/** Join `host`'s room through the relay as a writer; resolves after `welcome`. */
async function joinAsWriter(host: CollabHost, onFrame?: (frame: CollabFrame) => void) {
	const parsed = parseCollabLink(host.link);
	if ("error" in parsed) throw new Error(parsed.error);
	const writeToken = parsed.writeToken ? Buffer.from(parsed.writeToken).toString("base64url") : undefined;
	const socket = new CollabSocket({ wsUrl: parsed.wsUrl, role: "guest", key: await importRoomKey(parsed.key) });
	guestCleanups.push(() => socket.close());
	const welcomed = Promise.withResolvers<void>();
	socket.onFrame = frame => {
		if (frame.t === "welcome") welcomed.resolve();
		onFrame?.(frame);
	};
	socket.onOpen = () => socket.send({ t: "hello", proto: COLLAB_PROTO, name: "writer", writeToken });
	socket.connect();
	await welcomed.promise;
	return socket;
}

/** Hold the genuine outgoing proof after the source responds, as in collab-send-registry.test.ts. */
async function holdOutgoingProof(source: registry.CollabHostPublication) {
	const reached = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const connections = new Set<IpcConnection>();
	const pending = new Set<Promise<void>>();
	const errors: unknown[] = [];
	const endpoint = ipcEndpoint(tmp, `proof-${crypto.randomUUID().slice(0, 8)}`);
	const server = await IpcServer.listen(endpoint, { framing: "lines", maxFrameBytes: 128 * 1024 }, connection => {
		connections.add(connection);
		let handled = false;
		connection.start(
			line => {
				if (handled) return;
				handled = true;
				const work = (async () => {
					const upstream = await IpcConnection.connect(source.endpoint, { framing: "lines", timeoutMs: 3_000 });
					connections.add(upstream);
					const response = Promise.withResolvers<string | null>();
					upstream.start(response.resolve, () => response.resolve(null));
					try {
						upstream.send(line);
						const frame = await response.promise;
						if (JSON.parse(line).op === "outgoing") {
							expect(frame).not.toBeNull();
							expect(JSON.parse(frame!)).toMatchObject({ ok: true });
							reached.resolve();
							await release.promise;
						}
						if (frame !== null) connection.send(frame);
						connection.end();
					} finally {
						upstream.destroy();
						connections.delete(upstream);
					}
				})();
				pending.add(work);
				void work.then(
					() => pending.delete(work),
					error => {
						pending.delete(work);
						errors.push(error);
						reached.reject(error);
						connection.destroy();
					},
				);
			},
			() => connections.delete(connection),
		);
	});
	try {
		for (const name of await fs.readdir(tmp)) {
			if (!name.endsWith(".json")) continue;
			const file = path.join(tmp, name);
			const metadata = await Bun.file(file).json();
			if (metadata.endpoint !== source.endpoint) continue;
			await Bun.write(file, JSON.stringify({ ...metadata, endpoint }));
			return {
				reached: reached.promise,
				release: release.resolve,
				async close() {
					release.resolve();
					for (const connection of connections) connection.destroy();
					await server.close();
					await Promise.allSettled(pending);
					for (const connection of connections) connection.destroy();
					expect(errors).toEqual([]);
				},
			};
		}
		throw new Error("Source publication metadata was not written");
	} catch (error) {
		await server.close();
		throw error;
	}
}

/**
 * Resolves once the controller's background start has published `calls`
 * times and every publication finished. The spy implementation wakes waiters
 * on each call, so this awaits the real event rather than spinning.
 */
async function settled(publishSpy: Mock<typeof registry.publishCollabHost>, calls: number): Promise<void> {
	while (publishSpy.mock.calls.length < calls) {
		const waiter = Promise.withResolvers<void>();
		publishWaiters.push(waiter.resolve);
		await waiter.promise;
	}
	await Promise.all(publishSpy.mock.results.map(result => result.value));
	// Publication now runs independently of the relay handshake. Wait for both.
	await controller?.idle();
}

let tmp: string;
let publishSpy: Mock<typeof registry.publishCollabHost>;
let controller: CollabController | undefined;
const additionalControllers: CollabController[] = [];
const guestCleanups: (() => void)[] = [];
const publishWaiters: (() => void)[] = [];
let capturedSockets: FakeWebSocket[] = [];

beforeEach(async () => {
	tmp = await fs.mkdtemp(path.join(os.tmpdir(), "omp-collabctl-"));
	utils.setAgentDir(path.join(tmp, "agent"));
	installInMemoryRelay();
	// Record every fake socket so a test can drive a terminal close on the host's transport.
	capturedSockets = [];
	const Capturing = class extends FakeWebSocket {
		constructor(url: string) {
			super(url);
			capturedSockets.push(this);
		}
	};
	globalThis.WebSocket = Capturing as unknown as typeof WebSocket;
	const real = registry.publishCollabHost;
	publishSpy = spyOn(registry, "publishCollabHost").mockImplementation((source, options) => {
		const publication = real(source, { ...options, dir: tmp });
		for (const wake of publishWaiters.splice(0)) wake();
		return publication;
	});
	controller = undefined;
});

afterEach(async () => {
	for (const cleanup of guestCleanups.splice(0).reverse()) cleanup();
	await controller?.shutdown("test cleanup").catch(() => {});
	for (const extra of additionalControllers.splice(0)) await extra.shutdown("test cleanup").catch(() => {});
	uninstallInMemoryRelay();
	publishSpy?.mockRestore();
	// `runRootCommand` registers the CLI's extension roots (`--no-extensions` → explicit-only) process-wide.
	clearOmpExtensionCliRoots();
	restoreEnv("PI_CODING_AGENT_DIR", originalAgentDir);
	restoreEnv("PI_PROFILE", originalPiProfile);
	restoreEnv("OMP_PROFILE", originalOmpProfile);
	utils.__resetDirsFromEnvForTests();
	// InteractiveMode and the CLI open process-wide agent.db, history.db (prompt history and
	// session index), and models.db under tmp/agent; Windows cannot delete open files.
	AgentStorage.close();
	HistoryStorage.close();
	closeSessionIndex();
	closeModelCache();
	await fs.rm(tmp, { recursive: true, force: true });
});

describe("interactive collaboration startup", () => {
	let activeSettings: Settings;
	let testSession: TestSessionContext;
	let mode: InteractiveMode | undefined;
	let originalProject: string;
	const remoteHosts: CollabHost[] = [];

	beforeEach(async () => {
		originalProject = getProjectDir();
		setProjectDir(tmp);
		spyOn(utils, "getConfigRootDir").mockReturnValue(tmp);
		resetSettingsForTest();
		await initTheme();
		activeSettings = await Settings.init({ inMemory: true, cwd: tmp });
		cfgStartupCheckUpdate.override(activeSettings, false);
		cfgStartupChangelogMode.override(activeSettings, "hidden");
		cfgStartupSetupWizard.override(activeSettings, false);
		cfgStartupShowSplash.override(activeSettings, false);
		cfgMarketplaceAutoUpdate.override(activeSettings, "off");
		testSession = await createTestSession({
			settingsOverrides: {
				"collab.autoStart": "view",
				"collab.relayUrl": RELAY_URL,
				"collab.webUrl": WEB_URL,
			},
		});
		mode = undefined;
	});

	afterEach(async () => {
		await mode?.collabGuest?.leave("test cleanup").catch(() => {});
		for (const remote of remoteHosts.splice(0)) await remote.stop("test cleanup");
		await mode?.collabController.shutdown("test cleanup").catch(() => {});
		mode?.stop();
		stopPendingStartupComposer();
		await testSession.cleanup();
		vi.restoreAllMocks();
		resetSettingsForTest();
		setProjectDir(originalProject);
	});

	it("keeps renderer-only initialization local without changing the saved policy", async () => {
		mode = new InteractiveMode(
			testSession.session,
			"test",
			undefined,
			undefined,
			undefined,
			undefined,
			new Composer({ terminal: new VirtualTerminal() }),
		);
		spyOn(mode.statusLine, "watchBranch").mockImplementation(() => {});

		await mode.init({ suppressWelcomeIntro: true });

		expect(mode.collabHost).toBeUndefined();
		expect(await registry.listCollabHosts({ dir: tmp })).toEqual([]);
		expect(cfgCollabAutoStart.get(mode.settings)).toBe("view");
		// Renderer-only initialization must not disable a later explicit start.
		await mode.collabController.start({ access: "view" });
		expect(await registry.listCollabHosts({ dir: tmp })).toMatchObject([{ access: "view", generation: 1 }]);
	});

	it.each(["/collab", "/join"])(
		"%s recovers a real session whose persistence failed before notifying observers",
		async command => {
			mode = new InteractiveMode(
				testSession.session,
				"test",
				undefined,
				undefined,
				undefined,
				undefined,
				new Composer({ terminal: new VirtualTerminal(200, 60) }),
			);
			spyOn(mode.statusLine, "watchBranch").mockImplementation(() => {});
			await mode.init({ suppressWelcomeIntro: true });
			await executeBuiltinSlashCommand("/collab", { ctx: mode });
			const first = mode.collabHost;
			if (!first) throw new Error("slash command did not start a host");
			const persistence = spyOn(testSession.sessionManager, "ensureOnDisk").mockRejectedValueOnce(
				new Error("injected persistence failure"),
			);
			await expect(testSession.session.newSession()).rejects.toThrow("injected persistence failure");
			persistence.mockRestore();
			expect(testSession.sessionManager.getSessionId()).not.toBe(first.sessionId);
			if (command === "/join") {
				const remote = new CollabHost(makeControllerContext().ctx);
				remoteHosts.push(remote);
				await remote.start(RELAY_URL);
				await executeBuiltinSlashCommand("/join " + remote.link, { ctx: mode });
				expect(remote.participants.map(peer => peer.role)).toEqual(["host", "guest"]);
				expect(first.stopped).toBe(true);
				expect((await registry.listCollabHosts({ dir: tmp })).map(room => room.instanceId)).toEqual([
					remote.instanceId,
				]);
				return;
			}
			await executeBuiltinSlashCommand("/collab", { ctx: mode });
			const replacement = mode.collabHost;
			expect(replacement).not.toBe(first);
			expect(first.stopped).toBe(true);
			expect(await registry.listCollabHosts({ dir: tmp })).toMatchObject([
				{
					instanceId: mode.collabController.instanceId,
					sessionId: testSession.sessionManager.getSessionId(),
					access: "control",
					relayConnected: true,
				},
			]);
			if (!replacement) throw new Error("slash command did not replace the stale host");
			expect(replacement.sessionId).toBe(testSession.sessionManager.getSessionId());
			await expect(
				registry.sendCollabAgentMessage(
					{ instanceId: first.instanceId, generation: first.generation },
					{
						requestId: "stale-persistence-failure",
						recipient: { instanceId: first.instanceId, generation: first.generation },
						text: "stale transcript capability",
					},
					{ dir: tmp },
				),
			).rejects.toMatchObject({ code: "stale_generation" });
			expect(mode.ui.render(200).join("\n")).toContain(replacement.webLink);
			await joinAsWriter(replacement);
		},
	);

	it.each(["resetSessionContext", "navigateTree"] as const)(
		"rejects held outgoing proof after real same-ID %s completes, then admits the fresh generation",
		async operation => {
			const { session, sessionManager } = testSession;
			const targetEntry = sessionManager.appendMessage(userMsg("original transcript"));
			sessionManager.appendMessage(assistantMsg("original response"));
			session.agent.replaceMessages(sessionManager.buildSessionContext().messages);
			await sessionManager.ensureOnDisk();
			const originalSessionId = sessionManager.getSessionId();
			const originalSessionFile = sessionManager.getSessionFile();
			// Exercise real admission and queueing without making a provider request.
			session.setClientBridge({ capabilities: {}, deferAgentInitiatedTurns: true });
			mode = new InteractiveMode(
				session,
				"test",
				undefined,
				undefined,
				undefined,
				undefined,
				new Composer({ terminal: new VirtualTerminal() }),
			);
			spyOn(mode.statusLine, "watchBranch").mockImplementation(() => {});
			await mode.init({ suppressWelcomeIntro: true });
			const sender = new CollabController(makeControllerContext().ctx);
			additionalControllers.push(sender);
			sender.startupComplete();
			mode.collabController.startupComplete();
			await Promise.all([sender.idle(), mode.collabController.idle()]);
			const senderAddress = { instanceId: sender.instanceId, generation: sender.generation };
			const recipient = {
				instanceId: mode.collabController.instanceId,
				generation: mode.collabController.generation,
			};
			const publicationIndex = publishSpy.mock.calls.findIndex(
				([source]) => source.snapshot()?.instanceId === sender.instanceId,
			);
			if (publicationIndex < 0) throw new Error("Source controller was not published");
			const sourcePublication = publishSpy.mock.results[publicationIndex];
			if (sourcePublication?.type !== "return") throw new Error("Source publication did not return");
			const proof = await holdOutgoingProof(await sourcePublication.value);
			const admission = spyOn(session, "admitAgentMessage");
			const pending = registry.sendCollabAgentMessage(
				senderAddress,
				{ requestId: `held-${operation}`, recipient, text: "must not enter the replacement transcript" },
				{ dir: tmp, timeoutMs: 3_000 },
			);
			// Observe early teardown rejection without losing the post-proof admission assertion.
			pending.catch(() => {});
			try {
				await proof.reached;
				expect(admission).not.toHaveBeenCalled();
				if (operation === "resetSessionContext") {
					expect(await session.resetSessionContext()).toBeDefined();
				} else {
					expect(await session.navigateTree(targetEntry, { summarize: false })).toMatchObject({
						cancelled: false,
					});
				}
				await mode.collabController.idle();
				expect(session.isSessionTransitioning).toBe(false);
				expect(sessionManager.getSessionId()).toBe(originalSessionId);
				expect(sessionManager.getSessionFile()).toBe(originalSessionFile);
				proof.release();
				await expect(pending).rejects.toBeInstanceOf(Error);
				expect(admission).not.toHaveBeenCalled();
				expect(session.agent.peekSteeringQueue()).toEqual([]);
				const fresh = { instanceId: recipient.instanceId, generation: mode.collabController.generation };
				expect(fresh.generation).toBe(recipient.generation + 1);
				const receipt = await registry.sendCollabAgentMessage(
					senderAddress,
					{ requestId: `fresh-${operation}`, recipient: fresh, text: "fresh transcript only" },
					{ dir: tmp, timeoutMs: 3_000 },
				);
				expect(receipt.recipient).toEqual({ ...fresh, sessionId: originalSessionId });
				expect(admission).toHaveBeenCalledTimes(1);
				expect(session.agent.peekSteeringQueue()).toMatchObject([
					{
						customType: registry.COLLAB_AGENT_MESSAGE_TYPE,
						content: "fresh transcript only",
						attribution: "agent",
					},
				]);
			} finally {
				proof.release();
				await pending.catch(() => {});
				await proof.close();
			}
		},
		10_000,
	);

	it("mirrors a cfg:// approval prompt to a writer guest and applies the guest's answer", async () => {
		mode = new InteractiveMode(
			testSession.session,
			"test",
			undefined,
			undefined,
			undefined,
			undefined,
			new Composer({ terminal: new VirtualTerminal(200, 60) }),
		);
		spyOn(mode.statusLine, "watchBranch").mockImplementation(() => {});
		await mode.init({ suppressWelcomeIntro: true });
		const host = await mode.collabController.start({ access: "control" });
		const asked = Promise.withResolvers<CollabFrame & { t: "ui-request" }>();
		const guest = await joinAsWriter(host, frame => {
			if (frame.t === "ui-request") asked.resolve(frame);
		});

		const settings = testSession.session.settings;
		const session = { settings, hasUI: true, settingsApproval: true, taskDepth: 0 } as unknown as ToolSession;
		const write = new CfgProtocolHandler().write(parseInternalUrl("cfg://advisor/enabled"), "true", { session });
		const { request } = await asked.promise;
		expect(request.title).toContain("advisor.enabled");
		guest.send({ t: "ui-response", reqId: request.reqId, value: "Allow once" });

		expect((await write).details?.cfg?.outcome).toBe("applied");
		expect(cfgAdvisorEnabled.get(settings)).toBe(true);
	});

	it("restores the local session and saved hosting policy after dedicated CLI join activation fails", async () => {
		const finished = new Error("finished observing failed join");
		testSession.sessionManager.appendMessage({ role: "user", content: "dedicated local transcript", timestamp: 0 });
		await testSession.sessionManager.ensureOnDisk();
		await testSession.sessionManager.flush();
		const localFile = testSession.sessionManager.getSessionFile();
		const remote = new CollabHost(makeControllerContext().ctx);
		remoteHosts.push(remote);
		await remote.start(RELAY_URL);
		const render = InteractiveMode.prototype.renderInitialMessages;
		spyOn(InteractiveMode.prototype, "renderInitialMessages").mockImplementation(
			async function (this: InteractiveMode, options) {
				if (this.sessionManager.getHeader()?.parentSession === remote.sessionId)
					throw new Error("dedicated replica rendering failed");
				await render.call(this, options);
			},
		);
		beginStartupComposer({
			terminal: new VirtualTerminal(),
			version: "test",
			cache: false,
		});
		spyOn(InteractiveMode.prototype, "getUserInput").mockImplementation(async function (this: InteractiveMode) {
			mode = this;
			await this.collabController.idle();
			expect(this.sessionManager.getSessionFile()).toBe(localFile);
			expect(this.session.messages).toMatchObject([{ role: "user", content: "dedicated local transcript" }]);
			expect(
				(await registry.listCollabHosts({ dir: tmp })).filter(
					host => host.instanceId === this.collabController.instanceId,
				),
			).toMatchObject([{ access: "view", generation: this.collabController.generation }]);
			const restoredGeneration = this.collabController.generation;
			await this.session.newSession();
			await this.collabController.idle();
			expect(
				(await registry.listCollabHosts({ dir: tmp })).filter(
					host => host.instanceId === this.collabController.instanceId,
				),
			).toMatchObject([
				{ access: "view", generation: restoredGeneration + 1, sessionId: this.sessionManager.getSessionId() },
			]);
			throw finished;
		});
		spyOn(ModelRegistry.prototype, "refreshInBackground").mockImplementation(() => {});
		spyOn(pluginHelpers, "preloadPluginRoots").mockResolvedValue(undefined);
		const originalIsTTY = process.stdin.isTTY;
		Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
		const authStorage = await AuthStorage.create(path.join(tmp, "failed-join-auth.db"));
		try {
			const rawArgs = ["--no-session", "--no-extensions", "--no-skills", "--no-rules", "--no-tools", "--no-lsp"];
			const parsed = parseArgs(rawArgs);
			parsed.join = remote.link;
			await expect(
				runRootCommand(parsed, rawArgs, {
					settings: activeSettings,
					discoverAuthStorage: async () => authStorage,
					createAgentSession: async options => {
						if (!options?.preloadedExtensions || !options.eventBus) throw new Error("Missing startup context");
						await options.sessionManager?.close();
						return {
							session: testSession.session,
							setToolUIContext: () => {},
							extensionsResult: options.preloadedExtensions,
							eventBus: options.eventBus,
						};
					},
				}),
			).rejects.toBe(finished);
		} finally {
			Object.defineProperty(process.stdin, "isTTY", { value: originalIsTTY, configurable: true });
			authStorage.close();
		}
	});

	async function prepareGuestMode(): Promise<{ local: InteractiveMode; remote: CollabHost; localFile: string }> {
		testSession.sessionManager.appendMessage({ role: "user", content: "local transcript", timestamp: 0 });
		await testSession.sessionManager.ensureOnDisk();
		await testSession.sessionManager.flush();
		const localFile = testSession.sessionManager.getSessionFile()!;
		mode = new InteractiveMode(
			testSession.session,
			"test",
			undefined,
			undefined,
			undefined,
			undefined,
			new Composer({ terminal: new VirtualTerminal() }),
		);
		spyOn(mode.statusLine, "watchBranch").mockImplementation(() => {});
		await mode.init({ suppressWelcomeIntro: true, autoStartCollab: true });
		await mode.collabController.idle();
		await executeBuiltinSlashCommand("/collab stop", { ctx: mode });
		const remote = new CollabHost(makeControllerContext().ctx);
		remoteHosts.push(remote);
		await remote.start(RELAY_URL);
		return { local: mode, remote, localFile };
	}

	it("does not restart a stopped host when join fails before replica activation", async () => {
		const { local, remote, localFile } = await prepareGuestMode();
		const failure = new Error("transport setup failed");
		const connect = CollabSocket.prototype.connect;
		let failed = false;
		spyOn(CollabSocket.prototype, "connect").mockImplementation(function (this: CollabSocket) {
			if (!failed) {
				failed = true;
				throw failure;
			}
			connect.call(this);
		});
		await expect(new CollabGuestLink(local).join(remote.link)).rejects.toBe(failure);
		await local.collabController.idle();
		expect(local.sessionManager.getSessionFile()).toBe(localFile);
		expect(
			(await registry.listCollabHosts({ dir: tmp })).filter(
				row => row.instanceId === local.collabController.instanceId,
			),
		).toEqual([]);
	});

	it("keeps manual join occupancy through post-switch rendering and restores before auto-hosting", async () => {
		const { local, remote, localFile } = await prepareGuestMode();
		const rendering = Promise.withResolvers<void>();
		const gate = Promise.withResolvers<void>();
		const render = spyOn(local, "renderInitialMessages").mockImplementationOnce(async () => {
			rendering.resolve();
			await gate.promise;
		});
		const joining = executeBuiltinSlashCommand(`/join ${remote.link}`, { ctx: local });
		try {
			await rendering.promise;
			await local.collabController.idle();
			expect(local.sessionManager.getSessionFile()).not.toBe(localFile);
			expect(local.collabGuest).toBeDefined();
			expect(local.collabHost).toBeUndefined();
			expect(
				(await registry.listCollabHosts({ dir: tmp })).filter(
					h => h.instanceId === local.collabController.instanceId,
				),
			).toEqual([]);
		} finally {
			gate.resolve();
			await joining;
			render.mockRestore();
		}
		await executeBuiltinSlashCommand("/leave", { ctx: local });
		await local.collabController.idle();
		expect(local.sessionManager.getSessionFile()).toBe(localFile);
		expect(local.collabGuest).toBeUndefined();
		expect(local.collabHost?.sessionId).toBe(local.sessionManager.getSessionId());
		expect(cfgCollabAutoStart.get(local.settings)).toBe("view");
	});

	it.each(["stop", "shutdown"] as const)(
		"%s during restored-session rendering invalidates automatic hosting without blocking restoration",
		async operation => {
			const { local, remote, localFile } = await prepareGuestMode();
			const guest = new CollabGuestLink(local);
			await guest.join(remote.link);
			const rendering = Promise.withResolvers<void>();
			const gate = Promise.withResolvers<void>();
			const render = spyOn(local, "renderInitialMessages").mockImplementationOnce(async () => {
				rendering.resolve();
				await gate.promise;
			});
			const leaving = guest.leave("left");
			await rendering.promise;
			try {
				expect(local.sessionManager.getSessionFile()).toBe(localFile);
				expect(local.collabGuest).toBe(guest);
				await local.collabController[operation]("explicit user stop");
			} finally {
				gate.resolve();
				await leaving;
				render.mockRestore();
			}
			await local.collabController.idle();
			expect(local.collabGuest).toBeUndefined();
			expect(local.collabHost).toBeUndefined();
			expect(cfgCollabAutoStart.get(local.settings)).toBe("view");
			if (operation === "stop") {
				await local.session.newSession();
				await local.collabController.idle();
				expect(local.collabHost?.sessionId).toBe(local.sessionManager.getSessionId());
			}
		},
	);

	it("coalesces explicit leave through held restoration and surfaces its failure without unlocking hosting", async () => {
		const { local, remote } = await prepareGuestMode();
		const guest = new CollabGuestLink(local);
		await guest.join(remote.link);
		const restoring = Promise.withResolvers<void>();
		const gate = Promise.withResolvers<void>();
		const failure = new Error("local resume failed");
		const resume = spyOn(local, "handleResumeSession").mockImplementation(async () => {
			restoring.resolve();
			await gate.promise;
			throw failure;
		});
		const outcomes: unknown[] = [];
		const first = guest.leave("left").then(
			() => outcomes.push("resolved"),
			err => outcomes.push(err),
		);
		await restoring.promise;
		const second = guest.leave("again").then(
			() => outcomes.push("resolved"),
			err => outcomes.push(err),
		);
		try {
			await Bun.sleep(0);
			expect(outcomes).toEqual([]);
			expect(local.collabGuest).toBe(guest);
			local.collabController.autoStart();
			expect(local.collabHost).toBeUndefined();
		} finally {
			gate.resolve();
			await Promise.all([first, second]);
			resume.mockRestore();
		}
		expect(outcomes).toEqual([failure, failure]);
		expect(local.collabGuest).toBe(guest);
		local.collabController.autoStart();
		await local.collabController.idle();
		expect(local.collabHost).toBeUndefined();
	});

	it("cancels a snapshot waiting to switch without letting late activation escape restoration", async () => {
		const { local, remote, localFile } = await prepareGuestMode();
		const switching = Promise.withResolvers<void>();
		const gate = Promise.withResolvers<void>();
		const originalSwitch = local.session.switchSession.bind(local.session);
		spyOn(local.session, "switchSession").mockImplementationOnce(async (...args) => {
			switching.resolve();
			await gate.promise;
			return originalSwitch(...args);
		});
		const guest = new CollabGuestLink(local);
		const joining = guest.join(remote.link).then(
			() => "joined",
			err => err,
		);
		await switching.promise;
		let left = false;
		const leaving = guest.leave("cancelled").then(() => {
			left = true;
		});
		try {
			await Bun.sleep(0);
			expect(left).toBe(false);
			expect(local.collabGuest).toBe(guest);
		} finally {
			gate.resolve();
			await leaving;
		}
		expect(await joining).toBeInstanceOf(Error);
		await local.collabController.idle();
		expect(local.sessionManager.getSessionFile()).toBe(localFile);
		expect(local.collabGuest).toBeUndefined();
		expect(local.collabHost?.sessionId).toBe(local.sessionManager.getSessionId());
	});

	it("holds guest ownership through resync and a host-goodbye restoration", async () => {
		const { local, remote, localFile } = await prepareGuestMode();
		const guest = new CollabGuestLink(local);
		let transport: CollabSocket | undefined;
		const send = CollabSocket.prototype.send;
		const capture = spyOn(CollabSocket.prototype, "send").mockImplementation(
			function (this: CollabSocket, frame, targetPeer) {
				if (typeof frame !== "string" && frame.t === "hello") transport = this;
				return send.call(this, frame, targetPeer);
			},
		);
		await guest.join(remote.link);
		capture.mockRestore();
		const rendering = Promise.withResolvers<void>();
		const renderGate = Promise.withResolvers<void>();
		const render = spyOn(local, "renderInitialMessages").mockImplementationOnce(async () => {
			rendering.resolve();
			await renderGate.promise;
		});
		if (!transport) throw new Error("Guest transport missing");
		transport.send({ t: "hello", proto: COLLAB_PROTO, name: "resync" });
		try {
			await rendering.promise;
			local.collabController.autoStart();
			await local.collabController.idle();
			expect(local.collabHost).toBeUndefined();
			expect(local.collabGuest).toBe(guest);
		} finally {
			renderGate.resolve();
			render.mockRestore();
		}
		const restoring = Promise.withResolvers<void>();
		const restoreGate = Promise.withResolvers<void>();
		const resume = local.handleResumeSession.bind(local);
		spyOn(local, "handleResumeSession").mockImplementation(async file => {
			restoring.resolve();
			await restoreGate.promise;
			await resume(file);
		});
		await remote.stop("host goodbye");
		await restoring.promise;
		const leaving = guest.leave("wait for goodbye");
		try {
			expect(local.collabGuest).toBe(guest);
			expect(local.collabHost).toBeUndefined();
			await expect(local.collabController.start({ access: "control" })).rejects.toBeInstanceOf(
				CollabHostStoppedError,
			);
		} finally {
			restoreGate.resolve();
			await leaving;
		}
		await local.collabController.idle();
		expect(local.sessionManager.getSessionFile()).toBe(localFile);
		expect(local.collabGuest).toBeUndefined();
		expect(local.collabHost?.sessionId).toBe(local.sessionManager.getSessionId());
	});

	it("does not release a replica when the void resume wrapper silently cancels restoration", async () => {
		const { local, remote, localFile } = await prepareGuestMode();
		const guest = new CollabGuestLink(local);
		await guest.join(remote.link);
		const switchSession = spyOn(local.session, "switchSession").mockResolvedValueOnce(false);
		const reported = Promise.withResolvers<string>();
		spyOn(local, "showError").mockImplementation(message => reported.resolve(message));
		try {
			await remote.stop("host goodbye");
			expect(await reported.promise).toContain("Local session restoration was cancelled");
			await expect(guest.leave("left")).rejects.toThrow("Local session restoration was cancelled");
			local.collabController.autoStart();
			await local.collabController.idle();
			expect(local.sessionManager.getSessionFile()).not.toBe(localFile);
			expect(local.collabGuest).toBe(guest);
			expect(local.collabHost).toBeUndefined();
		} finally {
			switchSession.mockRestore();
		}
	});

	it.each(["hooks", "replay", "cleanup rejection"] as const)(
		"withdraws an early host before terminal teardown when startup fails during %s",
		async failurePoint => {
			const startupFailure = new Error("injected startup failure");
			const cleanupFailure = new Error("injected cleanup failure");
			let earlyHost: CollabHost | undefined;
			let terminalStopped = false;
			let hostAtTerminalStop: CollabHost | undefined;
			let transportOpenAtTerminalStop = false;
			class StartupTerminal extends VirtualTerminal {
				override stop(): void {
					terminalStopped = true;
					hostAtTerminalStop = mode?.collabHost;
					transportOpenAtTerminalStop = capturedSockets.some(socket => socket.readyState !== FakeWebSocket.CLOSED);
					super.stop();
				}
			}
			beginStartupComposer({
				terminal: new StartupTerminal(),
				version: "test",
				cache: false,
			});
			spyOn(InteractiveMode.prototype, "initHooksAndCustomTools").mockImplementation(
				async function (this: InteractiveMode) {
					mode = this;
					earlyHost = this.collabHost;
					// Ordinary init still installs the host before invoking startup hooks.
					expect(earlyHost).toBeDefined();
					await this.collabController.idle();
					expect(await registry.listCollabHosts({ dir: tmp })).toMatchObject([{ access: "view" }]);
					if (failurePoint === "cleanup rejection" && earlyHost) {
						const stop = earlyHost.stop.bind(earlyHost);
						spyOn(earlyHost, "stop").mockImplementation(async reason => {
							await stop(reason);
							throw cleanupFailure;
						});
					}
					if (failurePoint !== "replay") throw startupFailure;
				},
			);
			if (failurePoint === "replay") {
				spyOn(InteractiveMode.prototype, "renderInitialMessages").mockRejectedValue(startupFailure);
			}
			spyOn(ModelRegistry.prototype, "refreshInBackground").mockImplementation(() => {});
			spyOn(pluginHelpers, "preloadPluginRoots").mockResolvedValue(undefined);
			const originalIsTTY = process.stdin.isTTY;
			Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
			const authStorage = await AuthStorage.create(path.join(tmp, "startup-auth.db"));
			try {
				const rawArgs = ["--no-session", "--no-extensions", "--no-skills", "--no-rules", "--no-tools", "--no-lsp"];
				await expect(
					runRootCommand(parseArgs(rawArgs), rawArgs, {
						settings: activeSettings,
						discoverAuthStorage: async () => authStorage,
						createAgentSession: async options => {
							if (!options?.preloadedExtensions || !options.eventBus) throw new Error("Missing startup context");
							await options?.sessionManager?.close();
							return {
								session: testSession.session,
								setToolUIContext: () => {},
								extensionsResult: options.preloadedExtensions,
								eventBus: options.eventBus,
							};
						},
					}),
				).rejects.toBe(startupFailure);

				expect(terminalStopped).toBe(true);
				expect(hostAtTerminalStop).toBeUndefined();
				expect(transportOpenAtTerminalStop).toBe(false);
				expect(earlyHost?.ending).toBe(true);
				expect(await registry.listCollabHosts({ dir: tmp })).toEqual([]);
			} finally {
				Object.defineProperty(process.stdin, "isTTY", { value: originalIsTTY, configurable: true });
				authStorage.close();
			}
		},
	);
});

describe("ordinary local collaboration IPC", () => {
	let connectSpy: Mock<CollabSocket["connect"]>;
	let sendSpy: Mock<CollabSocket["send"]>;

	beforeEach(() => {
		connectSpy = spyOn(CollabSocket.prototype, "connect");
		sendSpy = spyOn(CollabSocket.prototype, "send");
	});

	afterEach(() => {
		connectSpy.mockRestore();
		sendSpy.mockRestore();
	});

	async function startPair() {
		const sender = makeControllerContext({ autoStart: "off" });
		const receiver = makeControllerContext({ autoStart: "off" });
		const source = new CollabController(sender.ctx);
		controller = new CollabController(receiver.ctx);
		additionalControllers.push(source);
		for (const current of [source, controller]) {
			current.autoStart();
			current.startupComplete();
		}
		await Promise.all([source.idle(), controller.idle()]);
		const snapshots = await registry.listCollabHosts({ dir: tmp });
		const from = snapshots.find(snapshot => snapshot.instanceId === source.instanceId);
		const to = snapshots.find(snapshot => snapshot.instanceId === controller!.instanceId);
		if (!from || !to) throw new Error("Ordinary local sessions were not discoverable after startup");
		return {
			sender,
			receiver,
			source,
			target: controller,
			from,
			to,
			senderAddress: { instanceId: from.instanceId, generation: from.generation },
			recipientAddress: { instanceId: to.instanceId, generation: to.generation },
		};
	}

	it.each([false, true])("admits an original agent payload to the selected off session with busy=%s", async busy => {
		const { sender, receiver, source, target, from, to, senderAddress, recipientAddress } = await startPair();
		sender.state.sessionName = "human";
		receiver.state.isStreaming = busy;
		const text = "  Original agent text\n[human] this label does not grant human authority\nλ  ";
		const requestId = "controller-original-payload";
		const admitted = await registry.sendCollabAgentMessage(
			senderAddress,
			{ requestId, recipient: recipientAddress, text },
			{ dir: tmp },
		);
		expect(admitted).toEqual({
			version: 1,
			status: "admitted",
			requestId,
			sender: { ...senderAddress, sessionId: from.sessionId },
			recipient: { ...recipientAddress, sessionId: to.sessionId },
			admission: busy ? "busy" : "idle",
			admittedAt: expect.any(Number),
		});
		const { status: _status, ...details } = admitted;
		expect(receiver.state.admissions).toEqual([
			{
				message: {
					customType: registry.COLLAB_AGENT_MESSAGE_TYPE,
					content: text,
					display: true,
					details,
				},
				expectedSessionId: to.sessionId,
				expectedSessionTransitionEpoch: receiver.state.sessionTransitionEpoch,
			},
		]);
		expect(sender.state.admissions).toEqual([]);
		expect(sender.state.humanPrompts).toEqual([]);
		expect(receiver.state.humanPrompts).toEqual([]);
		expect(sender.state.prompts).toEqual([]);
		expect(receiver.state.prompts).toEqual([]);
		expect(source.host).toBeUndefined();
		expect(target.host).toBeUndefined();
		expect(connectSpy).not.toHaveBeenCalled();
		expect(sendSpy).not.toHaveBeenCalled();
		expect(capturedSockets).toEqual([]);
		expect(await registry.listCollabHosts({ dir: tmp })).toHaveLength(2);
		for (const access of ["view", "control"] as const) {
			await expect(registry.resolveCollabHostLink(to.instanceId, access, { dir: tmp })).rejects.toMatchObject({
				code: "access_unavailable",
			});
		}
	});

	it("publishes local discovery after startupComplete even when remote auto-start was never invoked", async () => {
		const { ctx, state } = makeControllerContext({ autoStart: "off" });
		controller = new CollabController(ctx);
		controller.startupComplete();
		await controller.idle();
		expect(await registry.listCollabHosts({ dir: tmp })).toMatchObject([
			{
				instanceId: controller.instanceId,
				generation: 1,
				sessionId: state.sessionId,
				access: "local",
				relayConnected: false,
			},
		]);
		expect(ctx.collabHost).toBeUndefined();
		expect(capturedSockets).toEqual([]);
	});

	it("refuses startup delivery until startupComplete plus idle publishes the ready session", async () => {
		const sender = makeControllerContext();
		const receiver = makeControllerContext();
		const source = new CollabController(sender.ctx);
		additionalControllers.push(source);
		controller = new CollabController(receiver.ctx);
		source.autoStart();
		source.startupComplete();
		controller.autoStart();
		await Promise.all([source.idle(), controller.idle()]);
		const from = { instanceId: source.instanceId, generation: source.generation };
		const recipient = { instanceId: controller.instanceId, generation: controller.generation };
		expect((await registry.listCollabHosts({ dir: tmp })).map(snapshot => snapshot.instanceId)).toEqual([
			source.instanceId,
		]);
		await expect(
			registry.sendCollabAgentMessage(
				from,
				{ requestId: "startup-not-ready", recipient, text: "not yet" },
				{ dir: tmp },
			),
		).rejects.toBeInstanceOf(Error);
		expect(receiver.state.admissions).toEqual([]);
		controller.startupComplete();
		await controller.idle();
		const receipt = await registry.sendCollabAgentMessage(
			from,
			{
				requestId: "startup-now-ready",
				recipient: { ...recipient, generation: controller.generation },
				text: "ready",
			},
			{ dir: tmp },
		);
		expect(receipt.recipient.sessionId).toBe(receiver.state.sessionId);
		expect(receiver.state.admissions).toHaveLength(1);
		expect(capturedSockets).toEqual([]);
	});

	it.each(["commit", "rollback"] as const)("fences local sends throughout a session transition %s", async outcome => {
		const { sender, receiver, source, target, to, senderAddress, recipientAddress } = await startPair();
		const transition = Promise.withResolvers<void>();
		const waiting = Promise.withResolvers<void>();
		receiver.state.transitionWaited = waiting.resolve;
		receiver.state.transition = transition.promise;
		switchSession(receiver.state, "provisional-local-session");
		try {
			await waiting.promise;
			expect((await registry.listCollabHosts({ dir: tmp })).map(snapshot => snapshot.instanceId)).toEqual([
				source.instanceId,
			]);
			await expect(
				registry.sendCollabAgentMessage(
					senderAddress,
					{ requestId: "transition-incoming", recipient: recipientAddress, text: "not for a provisional session" },
					{ dir: tmp },
				),
			).rejects.toBeInstanceOf(Error);
			await expect(
				registry.sendCollabAgentMessage(
					recipientAddress,
					{ requestId: "transition-outgoing", recipient: senderAddress, text: "no provisional sender" },
					{ dir: tmp },
				),
			).rejects.toBeInstanceOf(Error);
			expect(receiver.state.admissions).toEqual([]);
			expect(sender.state.admissions).toEqual([]);
		} finally {
			receiver.state.sessionId = outcome === "commit" ? "committed-local-session" : to.sessionId;
			receiver.state.transition = undefined;
			transition.resolve();
		}
		await target.idle();
		const fresh = (await registry.listCollabHosts({ dir: tmp })).find(
			snapshot => snapshot.instanceId === target.instanceId,
		);
		if (!fresh) throw new Error("Restored local session was not published");
		expect(fresh.generation).toBeGreaterThan(to.generation);
		expect(fresh.sessionId).toBe(receiver.state.sessionId);
		await expect(
			registry.sendCollabAgentMessage(
				senderAddress,
				{ requestId: "stale-transition-target", recipient: recipientAddress, text: "stale" },
				{ dir: tmp },
			),
		).rejects.toMatchObject({ code: "stale_generation" });
		await expect(
			registry.sendCollabAgentMessage(
				recipientAddress,
				{ requestId: "stale-transition-source", recipient: senderAddress, text: "stale" },
				{ dir: tmp },
			),
		).rejects.toMatchObject({ code: "stale_generation" });
		await registry.sendCollabAgentMessage(
			senderAddress,
			{
				requestId: "settled-transition-target",
				recipient: { instanceId: fresh.instanceId, generation: fresh.generation },
				text: "for the final session",
			},
			{ dir: tmp },
		);
		expect(receiver.state.admissions.map(admission => admission.expectedSessionId)).toEqual([fresh.sessionId]);
		expect(capturedSockets).toEqual([]);
	});

	it("refuses an in-place transition even before any session-change notification", async () => {
		const { receiver, target, senderAddress, recipientAddress } = await startPair();
		const transition = Promise.withResolvers<void>();
		receiver.state.transition = transition.promise;
		try {
			await expect(
				registry.sendCollabAgentMessage(
					senderAddress,
					{ requestId: "in-place-transition", recipient: recipientAddress, text: "must not enter during reset" },
					{ dir: tmp },
				),
			).rejects.toBeInstanceOf(Error);
			expect(receiver.state.admissions).toEqual([]);
		} finally {
			receiver.state.transition = undefined;
			transition.resolve();
		}
		await target.idle();
		expect(target.generation).toBe(recipientAddress.generation + 1);
		const receipt = await registry.sendCollabAgentMessage(
			senderAddress,
			{
				requestId: "in-place-restored",
				recipient: { ...recipientAddress, generation: target.generation },
				text: "reset finished",
			},
			{ dir: tmp },
		);
		expect(receipt.recipient.sessionId).toBe(receiver.state.sessionId);
		expect(receiver.state.admissions).toHaveLength(1);
	});

	for (const access of ["view", "control"] as const) {
		it.each(["same-ID reset", "rollback"] as const)(
			`rotates only local ${access} capabilities after %s and retains the exact remote room`,
			async outcome => {
				const { sender, receiver, target, senderAddress } = await startPair();
				const room = await target.start({ access });
				await target.idle();
				const originalSessionId = receiver.state.sessionId;
				const originalEpoch = receiver.state.sessionTransitionEpoch;
				const originalGeneration = target.generation;
				const originalLink = room.link;
				const originalWebLink = (await registry.resolveCollabHostLink(target.instanceId, access, { dir: tmp })).url;
				const originalViewLink = (await registry.resolveCollabHostLink(target.instanceId, "view", { dir: tmp }))
					.url;
				const publicationCount = publishSpy.mock.calls.length;
				const socketCount = capturedSockets.length;
				const oldSource = publishSpy.mock.calls.findLast(
					([, options]) => options?.instanceId === target.instanceId,
				)?.[0];
				if (!oldSource) throw new Error("Remote-backed local source was not published");
				expect(oldSource.snapshot()).toMatchObject({ generation: originalGeneration, access });
				const oldAddress = { instanceId: target.instanceId, generation: originalGeneration };
				const transition = Promise.withResolvers<void>();
				const observed: { epoch: number; transitioning: boolean }[] = [];
				const unsubscribe = receiver.ctx.session.registerSessionTransitionCallback(() => {
					observed.push({
						epoch: receiver.ctx.session.sessionTransitionEpoch,
						transitioning: receiver.ctx.session.isSessionTransitioning,
					});
				});
				try {
					receiver.state.transition = transition.promise;
					// The begin observer fences the captured source before any asynchronous cleanup.
					expect(() => oldSource.snapshot()).toThrow("local collab session unavailable");
					expect(receiver.ctx.collabHost).toBe(room);
					expect(room.ending).toBe(false);
					receiver.state.transition = transition.promise;
					expect(observed).toEqual([{ epoch: originalEpoch + 1, transitioning: true }]);
					if (outcome === "rollback") receiver.state.sessionId = "uncommitted-retained-room-session";
					await expect(
						registry.sendCollabAgentMessage(
							senderAddress,
							{ requestId: "retained-transition-incoming", recipient: oldAddress, text: "blocked incoming" },
							{ dir: tmp },
						),
					).rejects.toBeInstanceOf(Error);
					await expect(
						registry.sendCollabAgentMessage(
							oldAddress,
							{ requestId: "retained-transition-outgoing", recipient: senderAddress, text: "blocked outgoing" },
							{ dir: tmp },
						),
					).rejects.toBeInstanceOf(Error);
					expect(sender.state.admissions).toEqual([]);
					expect(receiver.state.admissions).toEqual([]);
				} finally {
					receiver.state.sessionId = originalSessionId;
					receiver.state.transition = undefined;
					receiver.state.transition = undefined;
					transition.resolve();
					unsubscribe();
				}
				expect(observed).toEqual([
					{ epoch: originalEpoch + 1, transitioning: true },
					{ epoch: originalEpoch + 1, transitioning: false },
				]);
				await target.idle();
				const freshAddress = { ...oldAddress, generation: originalGeneration + 1 };
				expect(target.generation).toBe(freshAddress.generation);
				expect(() => oldSource.snapshot()).toThrow("local collab session unavailable");
				expect(receiver.ctx.collabHost).toBe(room);
				expect(target.host).toBe(room);
				expect(room.ending).toBe(false);
				expect(room.generation).toBe(originalGeneration);
				expect(room.link).toBe(originalLink);
				expect(
					(await registry.listCollabHosts({ dir: tmp })).find(host => host.instanceId === target.instanceId),
				).toMatchObject({
					...freshAddress,
					sessionId: originalSessionId,
					access,
					relayConnected: true,
				});
				expect((await registry.resolveCollabHostLink(target.instanceId, access, { dir: tmp })).url).toBe(
					originalWebLink,
				);
				expect((await registry.resolveCollabHostLink(target.instanceId, "view", { dir: tmp })).url).toBe(
					originalViewLink,
				);
				if (access === "view") {
					await expect(
						registry.resolveCollabHostLink(target.instanceId, "control", { dir: tmp }),
					).rejects.toMatchObject({
						code: "access_unavailable",
					});
				}
				await expect(
					registry.sendCollabAgentMessage(
						senderAddress,
						{ requestId: "retained-stale-incoming", recipient: oldAddress, text: "stale incoming" },
						{ dir: tmp },
					),
				).rejects.toMatchObject({ code: "stale_generation" });
				await expect(
					registry.sendCollabAgentMessage(
						oldAddress,
						{ requestId: "retained-stale-outgoing", recipient: senderAddress, text: "stale outgoing" },
						{ dir: tmp },
					),
				).rejects.toMatchObject({ code: "stale_generation" });
				const incoming = await registry.sendCollabAgentMessage(
					senderAddress,
					{ requestId: "retained-fresh-incoming", recipient: freshAddress, text: "fresh incoming" },
					{ dir: tmp },
				);
				const outgoing = await registry.sendCollabAgentMessage(
					freshAddress,
					{ requestId: "retained-fresh-outgoing", recipient: senderAddress, text: "fresh outgoing" },
					{ dir: tmp },
				);
				expect(incoming.recipient).toEqual({ ...freshAddress, sessionId: originalSessionId });
				expect(outgoing.sender).toEqual({ ...freshAddress, sessionId: originalSessionId });
				expect(receiver.state.admissions).toMatchObject([
					{ expectedSessionId: originalSessionId, expectedSessionTransitionEpoch: originalEpoch + 1 },
				]);
				expect(sender.state.admissions).toMatchObject([
					{
						expectedSessionId: sender.state.sessionId,
						expectedSessionTransitionEpoch: sender.state.sessionTransitionEpoch,
					},
				]);
				// Repeated observer delivery and ordinary commands must not confuse the retained
				// remote room's creation generation with the current local capability generation.
				for (let repeat = 0; repeat < 2; repeat++) {
					for (const callback of receiver.state.sessionTransitionCallbacks) callback();
					for (const callback of receiver.state.sessionChangeCallbacks) callback();
				}
				target.autoStart();
				expect(await target.start({ access })).toBe(room);
				await target.idle();
				expect(target.generation).toBe(freshAddress.generation);
				expect(publishSpy).toHaveBeenCalledTimes(publicationCount + 1);
				expect(capturedSockets).toHaveLength(socketCount);
				expect(receiver.ctx.collabHost).toBe(room);
				expect(room.link).toBe(originalLink);
			},
		);
	}

	it.each(["shutdown", "session switch"] as const)(
		"fences a still-pending local publication on %s",
		async operation => {
			const { receiver, source, target, senderAddress } = await startPair();
			const redirected = publishSpy.getMockImplementation();
			if (!redirected) throw new Error("publish spy has no implementation");
			const publishing = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			let held = false;
			publishSpy.mockImplementation(async (provider, options) => {
				const publication = await redirected(provider, options);
				if (!held && options?.instanceId === target.instanceId) {
					held = true;
					publishing.resolve();
					await release.promise;
				}
				return publication;
			});
			switchSession(receiver.state, "held-local-publication");
			await publishing.promise;
			const heldAddress = { instanceId: target.instanceId, generation: target.generation };
			let shutdown: Promise<void> | undefined;
			try {
				if (operation === "shutdown") shutdown = target.shutdown("exit during local publication");
				else switchSession(receiver.state, "final-local-session");
				await expect(
					registry.sendCollabAgentMessage(
						senderAddress,
						{ requestId: "held-publication-target", recipient: heldAddress, text: "must not cross teardown" },
						{ dir: tmp },
					),
				).rejects.toBeInstanceOf(Error);
				expect(receiver.state.admissions).toEqual([]);
			} finally {
				release.resolve();
				await shutdown;
			}
			await target.idle();
			const snapshots = await registry.listCollabHosts({ dir: tmp });
			if (operation === "shutdown") {
				expect(snapshots.map(snapshot => snapshot.instanceId)).toEqual([source.instanceId]);
			} else {
				expect(snapshots).toHaveLength(2);
				const fresh = snapshots.find(snapshot => snapshot.instanceId === target.instanceId);
				expect(fresh).toMatchObject({ sessionId: "final-local-session", access: "local" });
				expect(fresh!.generation).toBeGreaterThan(heldAddress.generation);
				await registry.sendCollabAgentMessage(
					senderAddress,
					{
						requestId: "after-held-publication",
						recipient: { instanceId: fresh!.instanceId, generation: fresh!.generation },
						text: "final local session only",
					},
					{ dir: tmp },
				);
				expect(receiver.state.admissions.map(admission => admission.expectedSessionId)).toEqual([
					"final-local-session",
				]);
			}
			expect((await fs.readdir(tmp)).filter(name => name.endsWith(".json"))).toHaveLength(snapshots.length);
			expect(capturedSockets).toEqual([]);
		},
	);

	it("keeps local sends available after a manual relay failure and a local-only stop", async () => {
		const { receiver, target, to, senderAddress, recipientAddress } = await startPair();
		globalThis.WebSocket = class extends FakeWebSocket {
			constructor(url: string) {
				super(url);
				capturedSockets.push(this);
				if (this.role !== "host") return;
				this.readyState = FakeWebSocket.CLOSED;
				queueMicrotask(() => this.onclose?.({ code: 1006, reason: "Failed to connect" }));
			}
		} as unknown as typeof WebSocket;
		await expect(target.start({ access: "control" })).rejects.toThrow(/Failed to connect/);
		await target.idle();
		const fresh = (await registry.listCollabHosts({ dir: tmp })).find(
			snapshot => snapshot.instanceId === target.instanceId,
		);
		expect(fresh).toMatchObject({ sessionId: to.sessionId, access: "local", relayConnected: false });
		expect(fresh!.generation).toBeGreaterThan(to.generation);
		await expect(
			registry.sendCollabAgentMessage(
				senderAddress,
				{ requestId: "failed-remote-stale", recipient: recipientAddress, text: "old generation" },
				{ dir: tmp },
			),
		).rejects.toMatchObject({ code: "stale_generation" });
		await target.stop("local-only stop");
		const receipt = await registry.sendCollabAgentMessage(
			senderAddress,
			{
				requestId: "failed-remote-local",
				recipient: { instanceId: fresh!.instanceId, generation: fresh!.generation },
				text: "still reachable locally",
			},
			{ dir: tmp },
		);
		expect(receipt.recipient).toEqual({
			instanceId: target.instanceId,
			generation: fresh!.generation,
			sessionId: to.sessionId,
		});
		expect(receiver.state.admissions).toHaveLength(1);
		expect(receiver.state.prompts).toEqual([]);
		expect(receiver.state.humanPrompts).toEqual([]);
		expect(target.host).toBeUndefined();
		expect(capturedSockets).toHaveLength(1);
	});

	it("keeps a guest replica and unfinished restoration unavailable to local sends", async () => {
		const { receiver, source, target, to, senderAddress, recipientAddress } = await startPair();
		const restored = Promise.withResolvers<boolean>();
		Object.assign(receiver.ctx, { collabGuest: new CollabGuestLink(receiver.ctx) });
		switchSession(receiver.state, "remote-replica-session");
		await target.idle();
		target.resumeAfterGuest(restored.promise);
		try {
			expect((await registry.listCollabHosts({ dir: tmp })).map(snapshot => snapshot.instanceId)).toEqual([
				source.instanceId,
			]);
			await expect(
				registry.sendCollabAgentMessage(
					senderAddress,
					{ requestId: "guest-replica-target", recipient: recipientAddress, text: "must not reach a replica" },
					{ dir: tmp },
				),
			).rejects.toBeInstanceOf(Error);
			receiver.state.sessionId = to.sessionId;
			Object.assign(receiver.ctx, { collabGuest: undefined });
			await expect(
				registry.sendCollabAgentMessage(
					senderAddress,
					{ requestId: "guest-restoration-target", recipient: recipientAddress, text: "restoration not finished" },
					{ dir: tmp },
				),
			).rejects.toBeInstanceOf(Error);
			expect(receiver.state.admissions).toEqual([]);
		} finally {
			Object.assign(receiver.ctx, { collabGuest: undefined });
			receiver.state.sessionId = to.sessionId;
			restored.resolve(true);
		}
		await target.idle();
		const fresh = (await registry.listCollabHosts({ dir: tmp })).find(
			snapshot => snapshot.instanceId === target.instanceId,
		);
		if (!fresh) throw new Error("Restored ordinary session was not discoverable");
		expect(fresh.generation).toBeGreaterThan(to.generation);
		const receipt = await registry.sendCollabAgentMessage(
			senderAddress,
			{
				requestId: "guest-restored-target",
				recipient: { instanceId: fresh.instanceId, generation: fresh.generation },
				text: "local session restored",
			},
			{ dir: tmp },
		);
		expect(receipt.recipient.sessionId).toBe(to.sessionId);
		expect(receiver.state.admissions).toHaveLength(1);
		expect(capturedSockets).toEqual([]);
	});

	it("withdraws both local capabilities on shutdown and never republishes on later session changes", async () => {
		const { receiver, target, source, senderAddress, recipientAddress } = await startPair();
		await target.shutdown("ordinary session exited");
		await expect(
			registry.sendCollabAgentMessage(
				senderAddress,
				{ requestId: "shutdown-target", recipient: recipientAddress, text: "closed" },
				{ dir: tmp },
			),
		).rejects.toMatchObject({ code: "not_found" });
		await expect(
			registry.sendCollabAgentMessage(
				recipientAddress,
				{ requestId: "shutdown-source", recipient: senderAddress, text: "closed" },
				{ dir: tmp },
			),
		).rejects.toMatchObject({ code: "not_found" });
		switchSession(receiver.state, "after-local-shutdown");
		target.startupComplete();
		target.autoStart();
		await target.idle();
		expect((await registry.listCollabHosts({ dir: tmp })).map(snapshot => snapshot.instanceId)).toEqual([
			source.instanceId,
		]);
		expect(receiver.state.admissions).toEqual([]);
		expect(capturedSockets).toEqual([]);
	});
});

describe("CollabController", () => {
	it("recovers later rotations after a teardown UI error without hiding the failure", async () => {
		const { ctx, state } = makeControllerContext({ autoStart: "control" });
		controller = new CollabController(ctx);
		controller.autoStart();
		await controller.idle();
		const failure = new Error("rotation UI teardown failed");
		const status = spyOn(ctx.statusLine, "setCollabStatus").mockImplementationOnce(() => {
			throw failure;
		});
		try {
			switchSession(state, "failed-rotation");
			await controller.idle().catch(() => {});
			switchSession(state, "recovered-rotation");
			await controller.idle().catch(() => {});
			expect(ctx.collabHost?.sessionId).toBe("recovered-rotation");
			expect(state.showStatus.some(message => message.includes(failure.message))).toBe(true);
			await controller.shutdown("done");
			expect(await registry.listCollabHosts({ dir: tmp })).toEqual([]);
		} finally {
			status.mockRestore();
		}
	});

	it("keeps manual teardown errors observable while allowing the next start", async () => {
		const { ctx } = makeControllerContext();
		controller = new CollabController(ctx);
		await controller.start({ access: "view" });
		const failure = new Error("manual UI teardown failed");
		const status = spyOn(ctx.statusLine, "setCollabStatus").mockImplementationOnce(() => {
			throw failure;
		});
		try {
			await expect(controller.start({ access: "control" })).rejects.toBe(failure);
			const recovered = await controller.start({ access: "control" });
			expect(recovered.access).toBe("control");
			await controller.shutdown("done");
			expect(await registry.listCollabHosts({ dir: tmp })).toEqual([]);
		} finally {
			status.mockRestore();
		}
	});

	it.each(["stop", "shutdown", "idle"] as const)(
		"surfaces publication revocation uncertainty through %s and preserves cleanup with a sticky error",
		async operation => {
			const { ctx, state } = makeControllerContext({ autoStart: "control" });
			controller = new CollabController(ctx);
			controller.autoStart();
			controller.startupComplete();
			await controller.idle();
			const original = ctx.collabHost;
			if (!original) throw new Error("Initial room was not installed");
			const originalGeneration = controller.generation;
			const originalSource = publishSpy.mock.calls[0]![0];
			const published = publishSpy.mock.results[0];
			if (published?.type !== "return") throw new Error("Initial publication did not return");
			const publication = await published.value;
			const close = publication.close.bind(publication);
			const failure = new registry.CollabSendError("revocation_incomplete");
			const closing = spyOn(publication, "close").mockImplementation(async () => {
				await close();
				throw failure;
			});
			try {
				if (operation === "idle") {
					switchSession(state, "after-uncertain-withdrawal");
					await expect(controller.idle()).rejects.toBe(failure);
				} else {
					await expect(controller[operation]("uncertain publication teardown")).rejects.toBe(failure);
				}
				expect(closing).toHaveBeenCalledTimes(1);
				expect(() => originalSource.snapshot()).toThrow("local collab session unavailable");
				expect(original.stopped).toBe(true);
				const hostSockets = capturedSockets.filter(socket => socket.role === "host");
				expect(hostSockets[0]!.readyState).toBe(FakeWebSocket.CLOSED);
				const snapshots = await registry.listCollabHosts({ dir: tmp });
				if (operation === "shutdown") {
					expect(snapshots).toEqual([]);
					expect(ctx.collabHost).toBeUndefined();
				} else {
					// Failure reporting must not poison the serialization chain: the
					// successor still owns a fresh, separately cleanable capability.
					expect(snapshots).toMatchObject([
						{
							instanceId: controller.instanceId,
							generation: originalGeneration + 1,
							sessionId: state.sessionId,
							access: operation === "stop" ? "local" : "control",
						},
					]);
				}
				if (operation !== "shutdown") {
					expect(
						state.showStatus.some(message =>
							message.includes("previously authorized message delivery outcome is uncertain"),
						),
					).toBe(true);
				}
				await expect(controller.idle()).rejects.toBe(failure);
				await expect(controller.stop("cleanup despite uncertainty")).rejects.toBe(failure);
				expect(ctx.collabHost).toBeUndefined();
				await expect(controller.shutdown("exit despite uncertainty")).rejects.toBe(failure);
				await expect(controller.idle()).rejects.toBe(failure);
				expect(await registry.listCollabHosts({ dir: tmp })).toEqual([]);
				expect((await fs.readdir(tmp)).filter(name => name.endsWith(".json"))).toEqual([]);
				expect(ctx.sessionManager.onEntryAppended).toBeUndefined();
				expect(state.sessionChangeCallbacks.size).toBe(0);
				expect(state.sessionTransitionCallbacks.size).toBe(0);
				expect(
					capturedSockets
						.filter(socket => socket.role === "host")
						.every(socket => socket.readyState === FakeWebSocket.CLOSED),
				).toBe(true);
			} finally {
				await controller.shutdown("uncertainty regression cleanup").catch(() => {});
				closing.mockRestore();
				controller = undefined;
			}
		},
	);

	it("rechecks guest ownership after waiting for a session transition", async () => {
		const { ctx, state } = makeControllerContext({ autoStart: "view" });
		controller = new CollabController(ctx);
		const gate = Promise.withResolvers<void>();
		const waiting = Promise.withResolvers<void>();
		state.transitionWaited = waiting.resolve;
		state.transition = gate.promise;
		controller.autoStart();
		await waiting.promise;
		Object.assign(ctx, { collabGuest: new CollabGuestLink(ctx) });
		state.transition = undefined;
		gate.resolve();
		await controller.idle();
		expect(ctx.collabHost).toBeUndefined();
		expect(await registry.listCollabHosts({ dir: tmp })).toEqual([]);
	});

	it("auto-start installs the room synchronously and retains an early dialog for the first writer", async () => {
		const { ctx } = makeControllerContext({ autoStart: "control" });
		controller = new CollabController(ctx);

		controller.autoStart();

		// Before any await: the host exists and accepts a mirrored dialog even
		// though the relay socket has not been created yet.
		const host = ctx.collabHost;
		if (!host) throw new Error("auto-start did not install a host synchronously");
		const pending = host.requestGuestUi({ kind: "select", title: "From session_start", options: ["Yes", "No"] });
		if (!pending) throw new Error("host dropped a dialog raised before the relay connected");

		await settled(publishSpy, 1);
		const [snapshot] = await registry.listCollabHosts({ dir: tmp });
		expect(snapshot).toMatchObject({
			instanceId: controller.instanceId,
			generation: 1,
			access: "control",
			inputRequired: true,
			model: { provider: "test-provider", id: "test-model" },
		});

		const replayed = Promise.withResolvers<number>();
		const socket = await joinAsWriter(host, frame => {
			if (frame.t === "ui-request") replayed.resolve(frame.request.reqId);
		});
		socket.send({ t: "ui-response", reqId: await replayed.promise, value: "Yes" });
		expect(await pending).toEqual({ kind: "answered", value: "Yes" });
	});

	it("auto-start off publishes a ready local session without hosting remotely or reporting status", async () => {
		const { ctx, state } = makeControllerContext({ autoStart: "off" });
		controller = new CollabController(ctx);

		controller.autoStart();
		controller.startupComplete();
		await controller.idle();

		expect(ctx.collabHost).toBeUndefined();
		expect(publishSpy).toHaveBeenCalledTimes(1);
		expect(await registry.listCollabHosts({ dir: tmp })).toMatchObject([
			{
				instanceId: controller.instanceId,
				generation: 1,
				sessionId: state.sessionId,
				access: "local",
				relayConnected: false,
			},
		]);
		expect(capturedSockets).toEqual([]);
		expect(state.showStatus).toEqual([]);
		await controller.shutdown("done");
		expect(await registry.listCollabHosts({ dir: tmp })).toEqual([]);
	});

	it("applies auto-start enabled at runtime to the next session without a restart", async () => {
		const { ctx, state } = makeControllerContext({ autoStart: "off" });
		controller = new CollabController(ctx);
		controller.autoStart();
		expect(ctx.collabHost).toBeUndefined();

		controller.startupComplete();
		await controller.idle();
		const localGeneration = controller.generation;

		// The user flips the setting in /settings, then starts a new session.
		cfgCollabAutoStart.override(state.settings, "control");
		switchSession(state, `sess-next-${crypto.randomUUID()}`);
		await settled(publishSpy, 1);

		const [snapshot] = await registry.listCollabHosts({ dir: tmp });
		expect(snapshot).toMatchObject({
			instanceId: controller.instanceId,
			generation: localGeneration + 1,
			sessionId: state.sessionId,
			access: "control",
		});
	});

	it("reports an auto-start failure without throwing into startup", async () => {
		const { ctx, state } = makeControllerContext({ autoStart: "control", relayUrl: "" });
		controller = new CollabController(ctx);

		expect(() => controller!.autoStart()).not.toThrow();

		expect(await state.firstStatus.promise).toMatch(/auto-start failed: No relay configured/);
		expect(ctx.collabHost).toBeUndefined();
	});

	it("revokes the old room before publishing the next generation on a session switch", async () => {
		const { ctx, state } = makeControllerContext({ autoStart: "control" });
		controller = new CollabController(ctx);
		controller.autoStart();
		await settled(publishSpy, 1);
		const first = ctx.collabHost;
		if (!first) throw new Error("first room missing");
		const goodbye = Promise.withResolvers<"bye">();
		await joinAsWriter(first, frame => {
			if (frame.t === "bye") goodbye.resolve(frame.t);
		});

		// Record the old room's state at the moment the successor publishes.
		let firstStoppedWhenSecondPublished: boolean | undefined;
		const redirected = publishSpy.getMockImplementation();
		if (!redirected) throw new Error("publish spy has no implementation");
		publishSpy.mockImplementation((source, options) => {
			firstStoppedWhenSecondPublished = first.stopped;
			return redirected(source, options);
		});
		// `redirected` is the wrapped beforeEach implementation, so waiters still wake.

		switchSession(state, `sess-next-${crypto.randomUUID()}`);
		await settled(publishSpy, 2);

		expect(firstStoppedWhenSecondPublished).toBe(true);
		// The writer in the old room was told explicitly, not left to time out.
		expect(await goodbye.promise).toBe("bye");
		const second = ctx.collabHost;
		expect(second).toBeDefined();
		expect(second).not.toBe(first);
		const hosts = await registry.listCollabHosts({ dir: tmp });
		expect(hosts).toHaveLength(1);
		expect(hosts[0]).toMatchObject({ instanceId: controller.instanceId, generation: 2, sessionId: state.sessionId });
		// A card that still names generation 1 cannot obtain the new room.
		await expect(
			registry.resolveCollabHostLink(controller.instanceId, "control", { dir: tmp }).then(link => link.generation),
		).resolves.toBe(2);
		expect(second!.webLink).not.toBe(first.webLink);
	});

	it("rotates the room when the session moves to a new file because another omp process has it open", async () => {
		const { ctx, state } = makeControllerContext({ autoStart: "control" });
		controller = new CollabController(ctx);
		controller.autoStart();
		await settled(publishSpy, 1);
		const first = ctx.collabHost;
		if (!first) throw new Error("first room missing");
		const goodbye = Promise.withResolvers<"bye">();
		await joinAsWriter(first, frame => {
			if (frame.t === "bye") goodbye.resolve(frame.t);
		});

		moveSessionFile(state, `sess-moved-${crypto.randomUUID()}`);
		await settled(publishSpy, 2);

		// Guests of the old room are told it closed instead of waiting forever.
		expect(await goodbye.promise).toBe("bye");
		expect(first.stopped).toBe(true);
		// The moved session is shared again and the old registry entry is gone.
		expect(ctx.collabHost?.sessionId).toBe(state.sessionId);
		expect(await registry.listCollabHosts({ dir: tmp })).toMatchObject([
			{ instanceId: controller.instanceId, generation: 2, sessionId: state.sessionId },
		]);
	});

	it("stops a manually started room on session switch when auto-start is off", async () => {
		const { ctx, state } = makeControllerContext({ autoStart: "off" });
		controller = new CollabController(ctx);
		const host = await controller.start({ access: "control" });
		expect(await registry.listCollabHosts({ dir: tmp })).toHaveLength(1);

		switchSession(state, `sess-next-${crypto.randomUUID()}`);
		await controller.shutdown("done");

		expect(host.stopped).toBe(true);
		expect(ctx.collabHost).toBeUndefined();
		expect(publishSpy).toHaveBeenCalledTimes(1);
		expect(await registry.listCollabHosts({ dir: tmp })).toEqual([]);
	});

	it("caps registry access at view for auto-start view until control is requested", async () => {
		const { ctx } = makeControllerContext({ autoStart: "view" });
		controller = new CollabController(ctx);
		controller.autoStart();
		controller.startupComplete();
		await settled(publishSpy, 1);
		expect(publishSpy).toHaveBeenCalledTimes(1);
		const viewRoom = ctx.collabHost;
		if (!viewRoom) throw new Error("view room missing");

		await expect(
			registry.resolveCollabHostLink(controller.instanceId, "control", { dir: tmp }),
		).rejects.toMatchObject({ code: "access_unavailable" });
		expect((await registry.resolveCollabHostLink(controller.instanceId, "view", { dir: tmp })).url).toBe(
			viewRoom.webViewLink,
		);

		// `/collab view` reuses the room; `/collab` (control) replaces it.
		expect(await controller.start({ access: "view" })).toBe(viewRoom);
		const controlRoom = await controller.start({ access: "control" });
		expect(controlRoom).not.toBe(viewRoom);
		expect(viewRoom.stopped).toBe(true);
		const hosts = await registry.listCollabHosts({ dir: tmp });
		expect(hosts).toHaveLength(1);
		expect(hosts[0]).toMatchObject({ generation: 2, access: "control" });
		expect(publishSpy).toHaveBeenCalledTimes(2);
		expect((await fs.readdir(tmp)).filter(name => name.endsWith(".json"))).toHaveLength(1);
		expect((await registry.resolveCollabHostLink(controller.instanceId, "control", { dir: tmp })).url).toBe(
			controlRoom.webLink,
		);
		expect((await registry.resolveCollabHostLink(controller.instanceId, "view", { dir: tmp })).url).toBe(
			controlRoom.webViewLink,
		);

		await controller.stop("remote sharing stopped");
		expect(controlRoom.stopped).toBe(true);
		expect(await registry.listCollabHosts({ dir: tmp })).toMatchObject([
			{ instanceId: controller.instanceId, generation: 3, access: "local", relayConnected: false },
		]);
		expect(publishSpy).toHaveBeenCalledTimes(3);
		expect((await fs.readdir(tmp)).filter(name => name.endsWith(".json"))).toHaveLength(1);
		for (const access of ["view", "control"] as const) {
			await expect(
				registry.resolveCollabHostLink(controller.instanceId, access, { dir: tmp }),
			).rejects.toMatchObject({
				code: "access_unavailable",
			});
		}
	});

	it("replaces a room after session identity changes without notifying observers", async () => {
		const { ctx, state } = makeControllerContext();
		controller = new CollabController(ctx);
		const first = await controller.start({ access: "control" });
		// Persistence can fail after SessionManager adopts the new ID but before
		// AgentSession notifies its session-change observers.
		state.sessionId = `sess-${crypto.randomUUID()}`;
		const replacement = await controller.start({ access: "control" });
		expect(replacement).not.toBe(first);
		expect(first.stopped).toBe(true);
		expect(await registry.listCollabHosts({ dir: tmp })).toMatchObject([
			{ sessionId: state.sessionId, generation: 2 },
		]);
		await joinAsWriter(replacement);
	});

	it("treats a room whose stop is still draining as absent and starts a fresh one on /collab", async () => {
		const { ctx } = makeControllerContext({ autoStart: "control" });
		controller = new CollabController(ctx);
		controller.autoStart();
		await settled(publishSpy, 1);
		const first = ctx.collabHost;
		if (!first) throw new Error("first room missing");

		// Hold the goodbye drain open so the stop stays in flight.
		const drain = Promise.withResolvers<void>();
		const flush = spyOn(CollabSocket.prototype, "flush").mockImplementation(() => drain.promise);
		const stopping = controller.stop("host stopped");

		// `/collab` and `/join` consult these slots: a room that already refuses
		// frames and is about to close must not be re-printed or reported as hosting.
		expect(first.ending).toBe(true);
		expect(first.stopped).toBe(false);
		expect(ctx.collabHost).toBeUndefined();
		expect(controller.host).toBeUndefined();

		const starting = controller.start({ access: "control" });
		drain.resolve();
		flush.mockRestore();
		await stopping;
		const second = await starting;

		expect(second).not.toBe(first);
		// Stopping also consumes a local-only generation; it must never be reused.
		expect(second.generation).toBe(3);
		expect(ctx.collabHost).toBe(second);
		expect(await registry.listCollabHosts({ dir: tmp })).toMatchObject([{ generation: 3 }]);
	});

	it("does not auto-restart when the relay closes during an explicit stop's goodbye drain", async () => {
		const { ctx } = makeControllerContext({ autoStart: "control" });
		controller = new CollabController(ctx);
		controller.autoStart();
		controller.startupComplete();
		await settled(publishSpy, 1);
		const first = ctx.collabHost;
		if (!first) throw new Error("first room missing");
		const hostSocket = capturedSockets.find(s => s.role === "host");
		if (!hostSocket) throw new Error("host transport socket was never created");

		const drain = Promise.withResolvers<void>();
		const flush = spyOn(CollabSocket.prototype, "flush").mockImplementation(() => drain.promise);
		const stopping = controller.stop("host stopped");
		try {
			expect(first.ending).toBe(true);
			expect(first.stopped).toBe(false);
			hostSocket.onclose?.({ code: 4001, reason: "room closed" });
		} finally {
			drain.resolve();
			flush.mockRestore();
		}
		await stopping;
		await controller.idle();
		expect(ctx.collabHost).toBeUndefined();
		expect(await registry.listCollabHosts({ dir: tmp })).toMatchObject([
			{ instanceId: controller.instanceId, generation: 2, access: "local", relayConnected: false },
		]);
		expect(publishSpy).toHaveBeenCalledTimes(2);
		expect(capturedSockets.filter(socket => socket.role === "host")).toHaveLength(1);
	});

	for (const outcome of ["commit", "rollback"] as const) {
		it(`publishes only settled session state after transition ${outcome}`, async () => {
			const { ctx, state } = makeControllerContext({ autoStart: "control" });
			controller = new CollabController(ctx);
			controller.autoStart();
			controller.startupComplete();
			await controller.idle();
			const original = state.sessionId;
			const gate = Promise.withResolvers<void>();
			const waiting = Promise.withResolvers<void>();
			state.transitionWaited = waiting.resolve;
			state.transition = gate.promise;
			switchSession(state, "provisional-session");
			try {
				// Real AgentSession tests cover this early callback/late-settlement interval.
				await waiting.promise;
				expect(ctx.collabHost).toBeUndefined();
				expect(await registry.listCollabHosts({ dir: tmp })).toEqual([]);
			} finally {
				state.sessionId = outcome === "rollback" ? original : "committed-session";
				state.transition = undefined;
				gate.resolve();
			}
			await controller.idle();
			expect(await registry.listCollabHosts({ dir: tmp })).toMatchObject([
				{ generation: 2, sessionId: state.sessionId },
			]);
		});
	}

	for (const command of ["/collab stop", "/leave"]) {
		it(`${command} cancels a queued rotation without disabling the next session's auto-start`, async () => {
			const { ctx, state } = makeControllerContext({ autoStart: "control" });
			controller = new CollabController(ctx);
			ctx.collabController = controller;
			controller.autoStart();
			controller.startupComplete();
			await controller.idle();
			const drain = Promise.withResolvers<void>();
			const transition = Promise.withResolvers<void>();
			const flush = spyOn(CollabSocket.prototype, "flush").mockImplementation(() => drain.promise);
			state.transition = transition.promise;
			let stopping: Promise<string | boolean> | undefined;
			try {
				switchSession(state, "cancelled-session");
				// The old room has left the command's public slot, but its goodbye is
				// still draining and the replacement is queued behind it.
				expect(ctx.collabHost).toBeUndefined();
				stopping = executeBuiltinSlashCommand(command, { ctx });
			} finally {
				drain.resolve();
				flush.mockRestore();
				state.transition = undefined;
				transition.resolve();
			}
			expect(await stopping).toBe(true);
			await controller.idle();
			expect(controller.host).toBeUndefined();
			expect(ctx.collabHost).toBeUndefined();
			const [local] = await registry.listCollabHosts({ dir: tmp });
			expect(local).toMatchObject({ sessionId: "cancelled-session", access: "local" });
			expect(local!.generation).toBeGreaterThan(1);
			expect(capturedSockets.filter(socket => socket.role === "host")).toHaveLength(1);
			expect(controller.autoStartMode).toBe("control");

			switchSession(state, "later-session");
			await controller.idle();
			expect(await registry.listCollabHosts({ dir: tmp })).toMatchObject([
				{ generation: local!.generation + 1, sessionId: "later-session", access: "control" },
			]);
		});
	}

	it("does not restart remote hosting when stop precedes the transition's commit notification", async () => {
		const { ctx, state } = makeControllerContext({ autoStart: "control" });
		controller = new CollabController(ctx);
		controller.autoStart();
		controller.startupComplete();
		await controller.idle();
		const original = ctx.collabHost;
		if (!original) throw new Error("Initial room was not installed");
		const transition = Promise.withResolvers<void>();
		state.transition = transition.promise;
		try {
			// No session-change callback has fired: explicit stop must suppress this
			// entire epoch even when its eventual commit notification arrives later.
			expect(ctx.collabHost).toBe(original);
			await controller.stop("stopped before commit notification");
			expect(state.transition).toBe(transition.promise);
			expect(original.stopped).toBe(true);
			expect(ctx.collabHost).toBeUndefined();
			switchSession(state, "commit-notified-after-stop");
			expect(ctx.collabHost).toBeUndefined();
		} finally {
			state.transition = undefined;
			transition.resolve();
		}
		await controller.idle();
		expect(controller.host).toBeUndefined();
		expect(ctx.collabHost).toBeUndefined();
		expect(await registry.listCollabHosts({ dir: tmp })).toMatchObject([
			{ sessionId: "commit-notified-after-stop", access: "local", relayConnected: false },
		]);
		expect(capturedSockets.filter(socket => socket.role === "host")).toHaveLength(1);
		expect(cfgCollabAutoStart.get(state.settings)).toBe("control");
		for (const callback of state.sessionTransitionCallbacks) callback();
		for (const callback of state.sessionChangeCallbacks) callback();
		await controller.idle();
		expect(ctx.collabHost).toBeUndefined();
		expect(controller.host).toBeUndefined();
		expect(capturedSockets.filter(socket => socket.role === "host")).toHaveLength(1);
		expect(await registry.listCollabHosts({ dir: tmp })).toMatchObject([
			{ sessionId: "commit-notified-after-stop", access: "local", relayConnected: false },
		]);
		// Suppression belongs to the stopped transition, not all future sessions.
		switchSession(state, "later-independent-session");
		await controller.idle();
		expect(ctx.collabHost?.sessionId).toBe("later-independent-session");
		expect(await registry.listCollabHosts({ dir: tmp })).toMatchObject([
			{ sessionId: "later-independent-session", access: "control" },
		]);
	});

	it("explicit stop cancels a launch already waiting for session hooks", async () => {
		const { ctx, state } = makeControllerContext({ autoStart: "control" });
		controller = new CollabController(ctx);
		controller.autoStart();
		controller.startupComplete();
		await controller.idle();
		const transition = Promise.withResolvers<void>();
		const waiting = Promise.withResolvers<void>();
		state.transitionWaited = waiting.resolve;
		state.transition = transition.promise;
		switchSession(state, "cancelled-session");
		try {
			await waiting.promise;
			expect(ctx.collabHost).toBeUndefined();
			await controller.stop("host stopped");
		} finally {
			state.transition = undefined;
			transition.resolve();
		}
		await controller.idle();
		expect(publishSpy).toHaveBeenCalledTimes(2);
		expect(controller.host).toBeUndefined();
		expect(await registry.listCollabHosts({ dir: tmp })).toMatchObject([
			{ generation: 2, sessionId: "cancelled-session", access: "local" },
		]);
		expect(capturedSockets.filter(socket => socket.role === "host")).toHaveLength(1);
		expect(state.showStatus.filter(message => /auto-start failed/.test(message))).toEqual([]);
	});

	it("explicit stop cancels a queued manual upgrade but permits a later manual start", async () => {
		const { ctx } = makeControllerContext({ autoStart: "view" });
		controller = new CollabController(ctx);
		controller.autoStart();
		controller.startupComplete();
		await controller.idle();
		const drain = Promise.withResolvers<void>();
		const flush = spyOn(CollabSocket.prototype, "flush").mockImplementation(() => drain.promise);
		const upgrade = controller.start({ access: "control" }).then(
			host => ({ host, error: undefined }),
			(error: unknown) => ({ host: undefined, error }),
		);
		let stopping: Promise<void> | undefined;
		try {
			expect(ctx.collabHost).toBeUndefined();
			stopping = controller.stop("host stopped");
		} finally {
			drain.resolve();
			flush.mockRestore();
		}
		await stopping;
		const result = await upgrade;
		expect(result.error).toBeInstanceOf(CollabHostStoppedError);
		expect(result.host).toBeUndefined();
		expect(publishSpy).toHaveBeenCalledTimes(2);
		expect(controller.host).toBeUndefined();
		expect(await registry.listCollabHosts({ dir: tmp })).toMatchObject([{ generation: 2, access: "local" }]);
		expect(capturedSockets.filter(socket => socket.role === "host")).toHaveLength(1);

		const room = await controller.start({ access: "control" });
		expect(controller.host).toBe(room);
		expect(await registry.listCollabHosts({ dir: tmp })).toMatchObject([{ generation: 3, access: "control" }]);
	});

	it("keeps a manual control upgrade when a session rotation overlaps its predecessor stop", async () => {
		const { ctx, state } = makeControllerContext({ autoStart: "view" });
		controller = new CollabController(ctx);
		controller.autoStart();
		await controller.idle();
		const drain = Promise.withResolvers<void>();
		const transition = Promise.withResolvers<void>();
		const waiting = Promise.withResolvers<void>();
		const flush = spyOn(CollabSocket.prototype, "flush").mockImplementation(() => drain.promise);
		const upgrade = controller.start({ access: "control" });
		// Observe the rejection later, after the transition and rotation have settled.
		upgrade.catch(() => {});
		try {
			state.transitionWaited = waiting.resolve;
			state.transition = transition.promise;
			drain.resolve();
			await waiting.promise;
			// The upgrade is waiting for session hooks when identity cleanup queues
			// auto-start view. That later policy must not supersede manual control.
			switchSession(state, "upgraded-session");
			expect(await registry.listCollabHosts({ dir: tmp })).toEqual([]);
		} finally {
			drain.resolve();
			flush.mockRestore();
			state.transition = undefined;
			transition.resolve();
		}
		const room = await upgrade;
		await controller.idle();
		expect(controller.host).toBe(room);
		expect(room.ending).toBe(false);
		expect(await registry.listCollabHosts({ dir: tmp })).toMatchObject([
			{ sessionId: "upgraded-session", access: "control" },
		]);
		expect((await registry.resolveCollabHostLink(controller.instanceId, "control", { dir: tmp })).url).toBe(
			room.webLink,
		);
	});

	it("shutdown cancels a rotation waiting for unfinished session hooks", async () => {
		const { ctx, state } = makeControllerContext({ autoStart: "control" });
		controller = new CollabController(ctx);
		controller.autoStart();
		await controller.idle();
		const gate = Promise.withResolvers<void>();
		guestCleanups.push(() => gate.resolve());
		const waiting = Promise.withResolvers<void>();
		state.transitionWaited = waiting.resolve;
		state.transition = gate.promise;
		switchSession(state, "unfinished-session");
		await waiting.promise;
		// Closing the terminal must not wait for a hook whose UI is being closed.
		await controller.shutdown("host exited");
		expect(ctx.collabHost).toBeUndefined();
		expect(await registry.listCollabHosts({ dir: tmp })).toEqual([]);
		state.transition = undefined;
		gate.resolve();
		await controller.idle();
		expect(controller.host).toBeUndefined();
	});

	it("does not restart after shutdown overtakes an access upgrade", async () => {
		const { ctx } = makeControllerContext({ autoStart: "view" });
		controller = new CollabController(ctx);
		controller.autoStart();
		await controller.idle();
		const drain = Promise.withResolvers<void>();
		const flush = spyOn(CollabSocket.prototype, "flush").mockImplementation(() => drain.promise);
		const upgrade = controller.start({ access: "control" }).then(
			host => ({ host, error: undefined }),
			error => ({ host: undefined, error }),
		);
		const shutdown = controller.shutdown("host exited");
		drain.resolve();
		flush.mockRestore();
		await shutdown;
		const result = await upgrade;
		expect(result.host).toBeUndefined();
		expect(result.error).toBeInstanceOf(Error);
		expect(controller.host).toBeUndefined();
		expect(ctx.collabHost).toBeUndefined();
		expect(await registry.listCollabHosts({ dir: tmp })).toEqual([]);
		await expect(controller.start({ access: "control" })).rejects.toBeInstanceOf(Error);
	});

	it("lets guests join and answer dialogs during startup but refuses prompts until startupComplete()", async () => {
		const { ctx, state } = makeControllerContext({ autoStart: "control" });
		controller = new CollabController(ctx);
		controller.autoStart();
		await settled(publishSpy, 1);
		const host = ctx.collabHost;
		if (!host) throw new Error("auto-started room missing");

		let refused = Promise.withResolvers<void>();
		const asked = Promise.withResolvers<number>();
		const writer = await joinAsWriter(host, frame => {
			if (frame.t === "error") {
				refused.resolve();
			}
			if (frame.t === "ui-request") asked.resolve(frame.request.reqId);
		});

		// Startup hooks are still running: a prompt must not start an agent
		// turn beside them, and the writer is told why …
		writer.send({ t: "prompt", text: "during startup" });
		await refused.promise;
		expect(state.prompts).toEqual([]);
		// … while a question raised by those very hooks can still be answered remotely.
		const answer = host.requestGuestUi({ kind: "select", title: "Startup hook", options: ["Yes", "No"] });
		if (!answer) throw new Error("host refused the startup dialog");
		writer.send({ t: "ui-response", reqId: await asked.promise, value: "Yes" });
		expect(await answer).toEqual({ kind: "answered", value: "Yes" });

		// Startup finished: the same writer's prompt now reaches the session.
		controller.startupComplete();
		const forwarded = Promise.withResolvers<void>();
		state.prompted.push(forwarded.resolve);
		writer.send({ t: "prompt", text: "after startup" });
		await forwarded.promise;
		expect(state.prompts).toEqual(["after startup"]);

		// An in-place transcript reset also closes the mutation gate, without
		// losing the already-connected guest or suppressing replication.
		const transition = Promise.withResolvers<void>();
		state.transition = transition.promise;
		refused = Promise.withResolvers<void>();
		writer.send({ t: "prompt", text: "during reset" });
		await refused.promise;
		expect(state.prompts).toEqual(["after startup"]);
		expect(await registry.listCollabHosts({ dir: tmp })).toEqual([]);
		state.transition = undefined;
		transition.resolve();
		await controller.idle();
		expect(await registry.listCollabHosts({ dir: tmp })).toMatchObject([{ sessionId: state.sessionId }]);
	});

	it("tears down a connected room rejected after an unnotified provisional switch before restoring a fresh host", async () => {
		const { ctx, state } = makeControllerContext({ autoStart: "off" });
		controller = new CollabController(ctx);
		controller.startupComplete();
		await controller.idle();
		const originalSessionId = state.sessionId;
		const transition = Promise.withResolvers<void>();
		const connecting = Promise.withResolvers<CollabSocket>();
		const subscribed = Promise.withResolvers<void>();
		const transitionWaited = Promise.withResolvers<void>();
		const subscribers = new Set<Parameters<InteractiveModeContext["session"]["subscribe"]>[0]>();
		const subscribe = spyOn(ctx.session, "subscribe").mockImplementation(listener => {
			subscribers.add(listener);
			subscribed.resolve();
			return () => {
				subscribers.delete(listener);
			};
		});
		const connect = CollabSocket.prototype.connect;
		let held = false;
		const holdConnect = spyOn(CollabSocket.prototype, "connect").mockImplementation(function (this: CollabSocket) {
			if (!held) {
				held = true;
				connecting.resolve(this);
				return;
			}
			connect.call(this);
		});
		const starting = controller.start({ access: "control" }).then(
			host => ({ host, error: undefined }),
			(error: unknown) => ({ host: undefined, error }),
		);
		try {
			const transport = await connecting.promise;
			const abandoned = ctx.collabHost;
			if (!abandoned) throw new Error("Pending room was not installed");
			expect(subscribers.size).toBe(0);
			expect(ctx.sessionManager.onEntryAppended).toBeUndefined();

			// SessionManager adopted a provisional ID, but AgentSession has not
			// notified observers. Let the real relay open and install the host's
			// taps before the controller's post-start identity check rejects it.
			state.transitionWaited = transitionWaited.resolve;
			state.transition = transition.promise;
			state.sessionId = "provisional-during-connect";
			connect.call(transport);
			await subscribed.promise;
			await transitionWaited.promise;
			expect(subscribers.size).toBe(1);
			expect(ctx.sessionManager.onEntryAppended).toBeDefined();
			// The identity change settles without its observer callback, as when
			// persistence fails after adopting a different SessionManager identity.
			state.transition = undefined;
			transition.resolve();
			const result = await starting;
			await controller.idle();
			expect(result.error).toBeInstanceOf(CollabHostStoppedError);
			expect(result.host).toBeUndefined();
			expect(subscribe).toHaveBeenCalledTimes(1);
			expect(abandoned.stopped).toBe(true);
			expect(subscribers.size).toBe(0);
			expect(ctx.sessionManager.onEntryAppended).toBeUndefined();
			expect(ctx.collabHost).toBeUndefined();
			expect(controller.host).toBeUndefined();
			expect(capturedSockets).toHaveLength(1);
			expect(capturedSockets[0]!.readyState).toBe(FakeWebSocket.CLOSED);
			expect(await registry.listCollabHosts({ dir: tmp })).toMatchObject([
				{
					generation: abandoned.generation + 1,
					sessionId: state.sessionId,
					access: "local",
					relayConnected: false,
				},
			]);
			await expect(
				registry.resolveCollabHostLink(controller.instanceId, "control", { dir: tmp }),
			).rejects.toMatchObject({
				code: "access_unavailable",
			});

			// Restoring the old identity must not revive the rejected room.
			// A new start must own the only transport and subscriptions; neither
			// the rejected room nor its late teardown may retain or clear them.
			state.sessionId = originalSessionId;
			const replacement = await controller.start({ access: "control" });
			expect(replacement).not.toBe(abandoned);
			expect(replacement.generation).toBeGreaterThan(abandoned.generation);
			expect(subscribe).toHaveBeenCalledTimes(2);
			expect(subscribers.size).toBe(1);
			const currentEntryTap = ctx.sessionManager.onEntryAppended;
			expect(currentEntryTap).toBeDefined();
			await abandoned.stop("late repeat teardown");
			expect(ctx.sessionManager.onEntryAppended).toBe(currentEntryTap);
			expect(subscribers.size).toBe(1);
			expect(capturedSockets).toHaveLength(2);
			expect(capturedSockets.map(socket => socket.readyState)).toEqual([FakeWebSocket.CLOSED, FakeWebSocket.OPEN]);
			expect(await registry.listCollabHosts({ dir: tmp })).toMatchObject([
				{
					instanceId: controller.instanceId,
					generation: replacement.generation,
					sessionId: originalSessionId,
					access: "control",
				},
			]);
			expect((await registry.resolveCollabHostLink(controller.instanceId, "control", { dir: tmp })).url).toBe(
				replacement.webLink,
			);
			await controller.shutdown("restored session exited");
			expect(subscribers.size).toBe(0);
			expect(ctx.sessionManager.onEntryAppended).toBeUndefined();
			expect(capturedSockets.every(socket => socket.readyState === FakeWebSocket.CLOSED)).toBe(true);
			expect(await registry.listCollabHosts({ dir: tmp })).toEqual([]);
		} finally {
			state.transition = undefined;
			transition.resolve();
			await controller.shutdown("postcheck regression cleanup").catch(() => {});
			holdConnect.mockRestore();
			subscribe.mockRestore();
		}
	});

	describe("while the first room is still connecting", () => {
		/** Resolves once the first relay socket exists; it stays in CONNECTING, later sockets open normally. */
		let firstSocketStalled: PromiseWithResolvers<void>;

		beforeEach(() => {
			firstSocketStalled = Promise.withResolvers<void>();
			let stallNext = true;
			globalThis.WebSocket = class extends FakeWebSocket {
				constructor(url: string) {
					super(url);
					if (stallNext) {
						stallNext = false;
						// The base class opens on a microtask unless the socket already left CONNECTING.
						this.readyState = FakeWebSocket.CLOSING;
						firstSocketStalled.resolve();
					}
				}
			} as unknown as typeof WebSocket;
		});

		it("a session switch replaces the room without reporting an auto-start failure", async () => {
			const { ctx, state } = makeControllerContext({ autoStart: "control" });
			controller = new CollabController(ctx);
			controller.autoStart();
			const first = ctx.collabHost;
			if (!first) throw new Error("auto-start did not install a host");
			await firstSocketStalled.promise;

			// `/new` while the first room waits for the relay: routine, not a failure.
			switchSession(state, `sess-next-${crypto.randomUUID()}`);
			await settled(publishSpy, 1);
			await controller.idle();

			expect(first.stopped).toBe(true);
			expect(ctx.collabHost).toMatchObject({ sessionId: state.sessionId });
			expect(ctx.collabHost!.generation).toBeGreaterThan(first.generation);
			expect(state.showStatus.filter(message => /auto-start failed/.test(message))).toEqual([]);
		});

		it("upgrading a view auto-start to control replaces the room without reporting an auto-start failure", async () => {
			const { ctx, state } = makeControllerContext({ autoStart: "view" });
			controller = new CollabController(ctx);
			controller.autoStart();
			const viewRoom = ctx.collabHost;
			if (!viewRoom) throw new Error("auto-start did not install a host");
			await firstSocketStalled.promise;

			// `/collab` before the view room connected: the control room takes over.
			const controlRoom = await controller.start({ access: "control" });
			await controller.idle();

			expect(viewRoom.stopped).toBe(true);
			expect(controlRoom.access).toBe("control");
			expect(ctx.collabHost).toBe(controlRoom);
			// The aborted start may publish an ordinary-local generation before
			// the queued upgrade starts; that generation must not be reused.
			expect(controlRoom.generation).toBeGreaterThan(viewRoom.generation);
			expect(await registry.listCollabHosts({ dir: tmp })).toMatchObject([
				{ generation: controlRoom.generation, access: "control" },
			]);
			expect(state.showStatus.filter(message => /auto-start failed/.test(message))).toEqual([]);
		});
	});

	it.each(["rollback", "stop", "shutdown"] as const)(
		"settles a held publication after provisional identity %s without exposing that identity",
		async outcome => {
			const { ctx, state } = makeControllerContext({ autoStart: "control" });
			controller = new CollabController(ctx);
			const redirected = publishSpy.getMockImplementation();
			if (!redirected) throw new Error("publish spy has no implementation");
			const publicationBound = Promise.withResolvers<void>();
			const releasePublication = Promise.withResolvers<void>();
			const transition = Promise.withResolvers<void>();
			const transitionWaited = Promise.withResolvers<void>();
			let held = false;
			publishSpy.mockImplementation(async (source, options) => {
				const publication = await redirected(source, options);
				if (!held) {
					held = true;
					publicationBound.resolve();
					await releasePublication.promise;
				}
				return publication;
			});
			controller.autoStart();
			controller.startupComplete();
			const originalHost = ctx.collabHost;
			if (!originalHost) throw new Error("Initial room was not installed");
			const originalSessionId = state.sessionId;
			try {
				await publicationBound.promise;
				const originalSource = publishSpy.mock.calls[0]?.[0];
				if (!originalSource) throw new Error("Initial publication source was not captured");
				await joinAsWriter(originalHost);
				expect((await fs.readdir(tmp)).filter(name => name.endsWith(".json"))).toHaveLength(1);
				expect(await registry.listCollabHosts({ dir: tmp })).toMatchObject([
					{ generation: originalHost.generation, sessionId: originalSessionId, access: "control" },
				]);

				// No committed session-change callback occurs. Publication finishes
				// against a provisional identity: its local generation must retire,
				// while the remote room can survive rollback to the original identity.
				state.transitionWaited = transitionWaited.resolve;
				state.transition = transition.promise;
				state.sessionId = "provisional-while-publication-finishes";
				releasePublication.resolve();
				await transitionWaited.promise;
				expect(() => originalSource.snapshot()).toThrow("local collab session unavailable");
				expect(await registry.listCollabHosts({ dir: tmp })).toEqual([]);
				await expect(
					registry.resolveCollabHostLink(controller.instanceId, "control", { dir: tmp }),
				).rejects.toBeInstanceOf(Error);

				if (outcome === "rollback") {
					state.sessionId = originalSessionId;
					state.transition = undefined;
					transition.resolve();
					await controller.idle();
					expect(ctx.collabHost).toBe(originalHost);
					expect(originalHost.ending).toBe(false);
					// Rollback retains the remote room but never resurrects its local publication.
					expect(() => originalSource.snapshot()).toThrow("local collab session unavailable");
					expect((await fs.readdir(tmp)).filter(name => name.endsWith(".json"))).toHaveLength(1);
					expect(await registry.listCollabHosts({ dir: tmp })).toMatchObject([
						{ sessionId: originalSessionId, access: "control", relayConnected: true },
					]);
					expect((await registry.resolveCollabHostLink(controller.instanceId, "control", { dir: tmp })).url).toBe(
						originalHost.webLink,
					);
				} else {
					// These operations must revoke the pending publication and finish
					// without waiting for a session hook that has not been released.
					await controller[outcome]("revoked during provisional publication");
					await controller.idle();
					expect(state.transition).toBe(transition.promise);
					expect(originalHost.stopped).toBe(true);
					expect(ctx.collabHost).toBeUndefined();
					expect(ctx.sessionManager.onEntryAppended).toBeUndefined();
					expect(
						capturedSockets.filter(socket => socket.role === "host").map(socket => socket.readyState),
					).toEqual([FakeWebSocket.CLOSED]);
					expect(await registry.listCollabHosts({ dir: tmp })).toEqual([]);
					expect((await fs.readdir(tmp)).filter(name => name.endsWith(".json"))).toEqual([]);
				}
			} finally {
				state.sessionId = originalSessionId;
				state.transition = undefined;
				transition.resolve();
				releasePublication.resolve();
				await controller.shutdown("held publication cleanup").catch(() => {});
			}
		},
	);

	it("waits for a room that ended on its own to finish withdrawing before the next room publishes", async () => {
		const { ctx, state } = makeControllerContext({ autoStart: "control" });
		controller = new CollabController(ctx);
		// Hold the first room's publication open after the real registry work, so
		// the endpoint is bound while start() still awaits the result.
		const redirected = publishSpy.getMockImplementation();
		if (!redirected) throw new Error("publish spy has no implementation");
		const firstPublishing = Promise.withResolvers<void>();
		const gate = Promise.withResolvers<void>();
		let gated = false;
		publishSpy.mockImplementation(async (source, options) => {
			const publication = await redirected(source, options);
			if (!gated) {
				gated = true;
				firstPublishing.resolve();
				await gate.promise;
			}
			return publication;
		});
		controller.autoStart();
		const first = ctx.collabHost;
		if (!first) throw new Error("auto-start did not install a host");
		await firstPublishing.promise;

		// Publication and the relay now start independently. A welcomed writer
		// proves the relay is up while the controller publication is still held.
		await joinAsWriter(first);
		// The relay closes the room for good while publication is still pending …
		const hostSocket = capturedSockets.find(s => s.role === "host");
		if (!hostSocket) throw new Error("host transport socket was never created");
		hostSocket.onclose?.({ code: 4001, reason: "room closed" });
		expect(first.stopped).toBe(true);
		// … when the session switches. The successor must not bind the same
		// instance endpoint until that withdrawal completes.
		switchSession(state, `sess-next-${crypto.randomUUID()}`);
		gate.resolve();
		await controller.idle();

		const hosts = await registry.listCollabHosts({ dir: tmp });
		expect(hosts).toHaveLength(1);
		expect(hosts[0]).toMatchObject({ sessionId: state.sessionId, access: "control" });
		expect(hosts[0]!.generation).toBeGreaterThan(first.generation);
		expect(state.showStatus.some(m => /discovery unavailable/.test(m))).toBe(false);
	});

	it("re-applies auto-start for the same session after its room ends on its own", async () => {
		const { ctx, state } = makeControllerContext({ autoStart: "control" });
		controller = new CollabController(ctx);
		controller.autoStart();
		await settled(publishSpy, 1);
		const first = ctx.collabHost;
		if (!first) throw new Error("auto-start did not install a host");

		// Non-retryable relay close after open, the path `#failFatal` (send backlog) also takes.
		const hostSocket = capturedSockets.find(s => s.role === "host");
		if (!hostSocket) throw new Error("host transport socket was never created");
		hostSocket.onclose?.({ code: 4001, reason: "room closed" });
		expect(first.stopped).toBe(true);
		await settled(publishSpy, 2);
		await controller.idle();

		const replacement = ctx.collabHost;
		expect(replacement).toBeDefined();
		expect(replacement).not.toBe(first);
		expect(controller.host).toBe(replacement);
		expect(replacement!.generation).toBeGreaterThan(first.generation);
		expect(await registry.listCollabHosts({ dir: tmp })).toMatchObject([
			{
				instanceId: controller.instanceId,
				generation: replacement!.generation,
				sessionId: state.sessionId,
				access: "control",
			},
		]);
		await joinAsWriter(replacement!);
	});

	describe("while the relay refuses the host's connection", () => {
		/** Host connections fail the way Bun reports a refused TCP connect; guests are unaffected. */
		let refusals = 0;
		let hostAttempts = 0;
		let thirdAttempt = Promise.withResolvers<void>();
		let attemptTimes: number[] = [];
		class Refusing extends FakeWebSocket {
			constructor(url: string) {
				super(url);
				if (this.role !== "host") return;
				hostAttempts++;
				attemptTimes.push(performance.now());
				if (hostAttempts === 3) thirdAttempt.resolve();
				if (refusals <= 0) return;
				refusals--;
				// The base class opens on a microtask unless the socket already left CONNECTING.
				this.readyState = FakeWebSocket.CLOSED;
				queueMicrotask(() => this.onclose?.({ code: 1006, reason: "Failed to connect" }));
			}
		}

		beforeEach(() => {
			refusals = 0;
			hostAttempts = 0;
			thirdAttempt = Promise.withResolvers<void>();
			attemptTimes = [];
			globalThis.WebSocket = Refusing as unknown as typeof WebSocket;
		});

		it("retries auto-start without reusing the failed attempt's local generation", async () => {
			refusals = 1;
			const { ctx, state } = makeControllerContext({ autoStart: "control" });
			controller = new CollabController(ctx);
			controller.autoStart();

			expect(await state.firstStatus.promise).toMatch(/auto-start failed: Failed to connect/);
			await settled(publishSpy, 2);
			await controller.idle();

			expect(hostAttempts).toBe(2);
			expect(controller.host).toBe(ctx.collabHost);
			expect(await registry.listCollabHosts({ dir: tmp })).toMatchObject([
				{ instanceId: controller.instanceId, generation: 2, sessionId: state.sessionId, access: "control" },
			]);
		});
	});

	it("leaves a self-ended manual room local-only while auto-start is off", async () => {
		const { ctx } = makeControllerContext({ autoStart: "off" });
		controller = new CollabController(ctx);
		const host = await controller.start({ access: "control" });
		controller.startupComplete();

		const hostSocket = capturedSockets.find(s => s.role === "host");
		if (!hostSocket) throw new Error("host transport socket was never created");
		hostSocket.onclose?.({ code: 4001, reason: "room closed" });
		await host.stop("drain teardown");
		await controller.idle();

		expect(ctx.collabHost).toBeUndefined();
		expect(publishSpy).toHaveBeenCalledTimes(2);
		expect(await registry.listCollabHosts({ dir: tmp })).toMatchObject([
			{ generation: 2, access: "local", relayConnected: false },
		]);
		expect(capturedSockets.filter(socket => socket.role === "host")).toHaveLength(1);
	});

	it("shutdown withdraws the room and ignores later session changes", async () => {
		const { ctx, state } = makeControllerContext({ autoStart: "control" });
		controller = new CollabController(ctx);
		controller.autoStart();
		await settled(publishSpy, 1);

		await controller.shutdown("host exited");
		expect(await registry.listCollabHosts({ dir: tmp })).toEqual([]);
		expect(ctx.collabHost).toBeUndefined();

		switchSession(state, `sess-after-shutdown-${crypto.randomUUID()}`);
		await controller.shutdown("again");
		expect(publishSpy).toHaveBeenCalledTimes(1);
		expect(ctx.collabHost).toBeUndefined();
	});

	describe("while the relay has not opened yet", () => {
		/** Fake socket that never reaches OPEN: the relay is up but unresponsive. */
		class NeverOpens extends FakeWebSocket {
			constructor(url: string) {
				super(url);
				// The base class opens on a microtask unless the socket already left CONNECTING.
				this.readyState = FakeWebSocket.CLOSING;
			}
		}

		beforeEach(() => {
			globalThis.WebSocket = NeverOpens as unknown as typeof WebSocket;
		});

		it("shutdown aborts the pending start instead of waiting for the connect timeout", async () => {
			const { ctx } = makeControllerContext({ autoStart: "control" });
			controller = new CollabController(ctx);
			controller.autoStart();
			const pending = ctx.collabHost;
			if (!pending) throw new Error("auto-start did not install a host");

			// Bounded by the test timeout: a stall here means shutdown waited on
			// the 15 s relay connect timeout instead of aborting the start.
			await controller.shutdown("host exited");

			expect(pending.stopped).toBe(true);
			expect(ctx.collabHost).toBeUndefined();
			expect(publishSpy).toHaveBeenCalledTimes(0);
		});

		it("manual recovery aborts a stale pending start without a session-change notification", async () => {
			const { ctx, state } = makeControllerContext({ autoStart: "control" });
			controller = new CollabController(ctx);
			controller.autoStart();
			const first = ctx.collabHost;
			if (!first) throw new Error("auto-start did not install a host");
			state.sessionId = `sess-${crypto.randomUUID()}`;
			globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
			const replacement = await controller.start({ access: "control" });
			expect(first.stopped).toBe(true);
			expect(replacement).not.toBe(first);
			expect(replacement.generation).toBeGreaterThan(first.generation);
			expect(await registry.listCollabHosts({ dir: tmp })).toMatchObject([
				{ sessionId: state.sessionId, generation: replacement.generation },
			]);
			await joinAsWriter(replacement);
		});

		it("a session switch aborts the pending start and installs the new session's room at once", async () => {
			const { ctx, state } = makeControllerContext({ autoStart: "control" });
			controller = new CollabController(ctx);
			controller.autoStart();
			const first = ctx.collabHost;
			if (!first) throw new Error("auto-start did not install a host");
			const firstTornDown = Promise.withResolvers<void>();
			state.tornDown.push(firstTornDown.resolve);
			const oldDialog = first.requestGuestUi({ kind: "select", title: "Old session", options: ["Continue"] });
			if (!oldDialog) throw new Error("Pending room did not retain its dialog");

			switchSession(state, `sess-next-${crypto.randomUUID()}`);
			expect(ctx.collabHost).toBeUndefined();

			// The stale room ends without waiting for its 15 s connect timeout
			// (bounded by the test timeout) …
			await firstTornDown.promise;
			expect(first.stopped).toBe(true);
			expect(await oldDialog).toEqual({ kind: "unavailable" });
			// … and once its stop and local IPC withdrawal settle, the successor
			// owns the context. Bound the wait well below the 15 s relay timeout;
			// idle() cannot resolve while the replacement relay intentionally stalls.
			// Real IPC needs event-loop progress; fake timers stall its listen callback.
			const installedBy = performance.now() + 1_000;
			while (ctx.collabHost === undefined && performance.now() < installedBy) await Bun.sleep(1);
			const second = ctx.collabHost;
			expect(second).toBeDefined();
			expect(second).not.toBe(first);
			expect(second!.generation).toBeGreaterThan(first.generation);
			expect(second!.sessionId).toBe(state.sessionId);
			// The successor is chained behind the aborted start's completion, so
			// by now that start has settled — and settled quietly.
			expect(state.showStatus.filter(message => /auto-start failed/.test(message))).toEqual([]);
		});
	});
});
