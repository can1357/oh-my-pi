/**
 * Contract: `CollabController` owns hosting for one interactive process.
 * `collab.autoStart` installs a room before extension hooks run and retains
 * dialogs raised before the relay connects; the registry sees one entry per
 * process keyed by a stable instance ID with an increasing generation; a
 * session switch revokes the old room before its successor is published; and
 * the published access level caps what `omp collab link` can obtain.
 *
 * Real CollabHost/CollabSocket run over the in-memory relay; the registry's
 * real Unix-socket IPC is redirected into a temp dir via a spy on
 * `publishCollabHost`, exactly as in host-registry.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, type Mock, spyOn, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
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
import { runRootCommand } from "@oh-my-pi/pi-coding-agent/main";
import { Composer } from "@oh-my-pi/pi-coding-agent/modes/composer";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { beginStartupComposer, stopPendingStartupComposer } from "@oh-my-pi/pi-coding-agent/modes/startup-composer";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import { getProjectDir, setProjectDir } from "@oh-my-pi/pi-utils";
import * as utils from "@oh-my-pi/pi-utils";
import { VirtualTerminal } from "../../../tui/test/virtual-terminal";
import { createTestSession, type TestSessionContext } from "../utilities";
import { FakeWebSocket, installInMemoryRelay, uninstallInMemoryRelay } from "./helpers/in-memory-relay";

const RELAY_URL = "ws://localhost:8788";
const WEB_URL = "https://collab.example";

interface ControllerContextState {
	sessionId: string;
	transition?: Promise<void>;
	transitionWaited?: () => void;
	autoStart: "off" | "view" | "control";
	relayUrl: string;
	showStatus: string[];
	/** Resolves with the first status message the controller shows. */
	firstStatus: PromiseWithResolvers<string>;
	/** Session-change callbacks registered by the controller under test. */
	sessionChangeCallbacks: Set<() => void>;
	/** Resolves each time a host clears its status-line segment (tore down). */
	tornDown: (() => void)[];
	/** Guest prompts a host forwarded into the session. */
	prompts: string[];
	/** Resolves each time a guest prompt is forwarded. */
	prompted: (() => void)[];
}

/**
 * Minimal InteractiveModeContext for a controller: settings, the mutable
 * session identity, the session-change subscription, and the observable
 * seams (status messages, status-line collab segment).
 */
function makeControllerContext(over: Partial<Pick<ControllerContextState, "autoStart" | "relayUrl">> = {}): {
	ctx: InteractiveModeContext;
	state: ControllerContextState;
} {
	const state: ControllerContextState = {
		sessionId: `sess-${crypto.randomUUID()}`,
		autoStart: over.autoStart ?? "off",
		relayUrl: over.relayUrl ?? RELAY_URL,
		showStatus: [],
		firstStatus: Promise.withResolvers<string>(),
		sessionChangeCallbacks: new Set(),
		tornDown: [],
		prompts: [],
		prompted: [],
	};
	const settingValues = (): Record<string, string> => ({
		"collab.autoStart": state.autoStart,
		"collab.relayUrl": state.relayUrl,
		"collab.webUrl": WEB_URL,
	});
	const ctx = {
		settings: { get: (key: string) => settingValues()[key] ?? "" },
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
		},
		session: {
			get isSessionTransitioning() {
				return state.transition !== undefined;
			},
			waitForSessionTransition: async () => {
				state.transitionWaited?.();
				await state.transition;
			},
			isStreaming: false,
			queuedMessageCount: 0,
			sessionName: "controller-test",
			model: { provider: "test-provider", id: "test-model" },
			thinkingLevel: undefined,
			subscribe: () => () => {},
			emitNotice: () => {},
			promptCustomMessage: (message: { content: unknown }) => {
				state.prompts.push(String(message.content));
				state.prompted.shift()?.();
				return Promise.resolve();
			},
			abort: () => Promise.resolve(),
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
}

let tmp: string;
let publishSpy: Mock<typeof registry.publishCollabHost>;
let controller: CollabController | undefined;
const guestCleanups: (() => void)[] = [];
const publishWaiters: (() => void)[] = [];
let capturedSockets: FakeWebSocket[] = [];

beforeEach(async () => {
	tmp = await fs.mkdtemp(path.join(os.tmpdir(), "omp-collabctl-"));
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
	uninstallInMemoryRelay();
	publishSpy?.mockRestore();
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
		activeSettings.override("startup.checkUpdate", false);
		activeSettings.override("startup.changelogMode", "hidden");
		activeSettings.override("startup.setupWizard", false);
		activeSettings.override("startup.showSplash", false);
		activeSettings.override("marketplace.autoUpdate", "off");
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
			undefined,
			new Composer({ terminal: new VirtualTerminal() }),
		);
		spyOn(mode.statusLine, "watchBranch").mockImplementation(() => {});

		await mode.init({ suppressWelcomeIntro: true });

		expect(mode.collabHost).toBeUndefined();
		expect(await registry.listCollabHosts({ dir: tmp })).toEqual([]);
		expect(mode.settings.get("collab.autoStart")).toBe("view");
		// Renderer-only initialization must not disable a later explicit start.
		await mode.collabController.start({ access: "view" });
		expect(await registry.listCollabHosts({ dir: tmp })).toMatchObject([{ access: "view", generation: 1 }]);
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
				if (this.sessionManager.getSessionId() === remote.sessionId)
					throw new Error("dedicated replica rendering failed");
				await render.call(this, options);
			},
		);
		beginStartupComposer({ terminal: new VirtualTerminal(), version: "test", cache: false });
		spyOn(InteractiveMode.prototype, "getUserInput").mockImplementation(async function (this: InteractiveMode) {
			mode = this;
			await this.collabController.idle();
			expect(this.sessionManager.getSessionFile()).toBe(localFile);
			expect(this.session.messages).toMatchObject([{ role: "user", content: "dedicated local transcript" }]);
			expect(
				(await registry.listCollabHosts({ dir: tmp })).filter(
					host => host.instanceId === this.collabController.instanceId,
				),
			).toMatchObject([{ access: "view", generation: 1 }]);
			await this.session.newSession();
			await this.collabController.idle();
			expect(
				(await registry.listCollabHosts({ dir: tmp })).filter(
					host => host.instanceId === this.collabController.instanceId,
				),
			).toMatchObject([{ access: "view", generation: 2, sessionId: this.sessionManager.getSessionId() }]);
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
		expect(local.settings.get("collab.autoStart")).toBe("view");
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
			expect(local.settings.get("collab.autoStart")).toBe("view");
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
				if (frame.t === "hello") transport = this;
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
			beginStartupComposer({ terminal: new StartupTerminal(), version: "test", cache: false });
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

	it("rechecks guest ownership after waiting for a session transition", async () => {
		const { ctx, state } = makeControllerContext({ autoStart: "view" });
		controller = new CollabController(ctx);
		const gate = Promise.withResolvers<void>();
		const waiting = Promise.withResolvers<void>();
		state.transition = gate.promise;
		state.transitionWaited = waiting.resolve;
		controller.autoStart();
		await waiting.promise;
		ctx.collabGuest = new CollabGuestLink(ctx);
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

	it("auto-start off leaves the session unhosted and reports nothing", async () => {
		const { ctx, state } = makeControllerContext({ autoStart: "off" });
		controller = new CollabController(ctx);

		controller.autoStart();
		await controller.shutdown("done");

		expect(ctx.collabHost).toBeUndefined();
		expect(publishSpy).toHaveBeenCalledTimes(0);
		expect(state.showStatus).toEqual([]);
	});

	it("applies auto-start enabled at runtime to the next session without a restart", async () => {
		const { ctx, state } = makeControllerContext({ autoStart: "off" });
		controller = new CollabController(ctx);
		controller.autoStart();
		expect(ctx.collabHost).toBeUndefined();

		// The user flips the setting in /settings, then starts a new session.
		state.autoStart = "control";
		switchSession(state, `sess-next-${crypto.randomUUID()}`);
		await settled(publishSpy, 1);

		const [snapshot] = await registry.listCollabHosts({ dir: tmp });
		expect(snapshot).toMatchObject({ instanceId: controller.instanceId, generation: 1, sessionId: state.sessionId });
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
		const goodbye = Promise.withResolvers<string>();
		await joinAsWriter(first, frame => {
			if (frame.t === "bye") goodbye.resolve(frame.reason);
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
		expect(await goodbye.promise).toBe("session switched");
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
		await settled(publishSpy, 1);
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
		expect((await registry.resolveCollabHostLink(controller.instanceId, "control", { dir: tmp })).url).toBe(
			controlRoom.webLink,
		);
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
		expect(second.generation).toBe(2);
		expect(ctx.collabHost).toBe(second);
		expect(await registry.listCollabHosts({ dir: tmp })).toMatchObject([{ generation: 2 }]);
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
			state.transition = gate.promise;
			state.transitionWaited = waiting.resolve;
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
			expect(publishSpy).toHaveBeenCalledTimes(1);
			expect(controller.host).toBeUndefined();
			expect(ctx.collabHost).toBeUndefined();
			expect(await registry.listCollabHosts({ dir: tmp })).toEqual([]);
			expect(controller.autoStartMode).toBe("control");

			switchSession(state, "later-session");
			await controller.idle();
			expect(await registry.listCollabHosts({ dir: tmp })).toMatchObject([
				{ generation: 2, sessionId: "later-session", access: "control" },
			]);
		});
	}

	it("explicit stop cancels a launch already waiting for session hooks", async () => {
		const { ctx, state } = makeControllerContext({ autoStart: "control" });
		controller = new CollabController(ctx);
		controller.autoStart();
		await controller.idle();
		const transition = Promise.withResolvers<void>();
		const waiting = Promise.withResolvers<void>();
		state.transition = transition.promise;
		state.transitionWaited = waiting.resolve;
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
		expect(publishSpy).toHaveBeenCalledTimes(1);
		expect(controller.host).toBeUndefined();
		expect(await registry.listCollabHosts({ dir: tmp })).toEqual([]);
		expect(state.showStatus.filter(message => /auto-start failed/.test(message))).toEqual([]);
	});

	it("explicit stop cancels a queued manual upgrade but permits a later manual start", async () => {
		const { ctx } = makeControllerContext({ autoStart: "view" });
		controller = new CollabController(ctx);
		controller.autoStart();
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
		expect(publishSpy).toHaveBeenCalledTimes(1);
		expect(controller.host).toBeUndefined();
		expect(await registry.listCollabHosts({ dir: tmp })).toEqual([]);

		const room = await controller.start({ access: "control" });
		expect(controller.host).toBe(room);
		expect(await registry.listCollabHosts({ dir: tmp })).toMatchObject([{ generation: 2, access: "control" }]);
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
			state.transition = transition.promise;
			state.transitionWaited = waiting.resolve;
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
		state.transition = gate.promise;
		state.transitionWaited = waiting.resolve;
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
		expect(await registry.listCollabHosts({ dir: tmp })).toMatchObject([{ sessionId: state.sessionId }]);
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
			expect(ctx.collabHost).toMatchObject({ generation: 2, sessionId: state.sessionId });
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
			expect(await registry.listCollabHosts({ dir: tmp })).toMatchObject([{ generation: 2, access: "control" }]);
			expect(state.showStatus.filter(message => /auto-start failed/.test(message))).toEqual([]);
		});
	});

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

		// The relay closes the room for good: the host tears itself down (nobody
		// awaits that) and its publication is still being withdrawn …
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
		expect(hosts.map(h => ({ generation: h.generation, sessionId: h.sessionId }))).toEqual([
			{ generation: 2, sessionId: state.sessionId },
		]);
		expect(state.showStatus.some(m => /discovery unavailable/.test(m))).toBe(false);
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

		it("a session switch aborts the pending start and installs the new session's room at once", async () => {
			const { ctx, state } = makeControllerContext({ autoStart: "control" });
			controller = new CollabController(ctx);
			controller.autoStart();
			const first = ctx.collabHost;
			if (!first) throw new Error("auto-start did not install a host");
			const firstTornDown = Promise.withResolvers<void>();
			state.tornDown.push(firstTornDown.resolve);

			switchSession(state, `sess-next-${crypto.randomUUID()}`);

			// The stale room ends without waiting for its 15 s connect timeout
			// (bounded by the test timeout) …
			await firstTornDown.promise;
			expect(first.stopped).toBe(true);
			// … and once its stop settles, the successor owns the context, so a
			// dialog raised now is retained by the new session's room. Only
			// microtask hops separate the two; no timer or I/O is involved.
			for (let flush = 0; flush < 10 && ctx.collabHost === undefined; flush++) await Promise.resolve();
			const second = ctx.collabHost;
			expect(second).toBeDefined();
			expect(second).not.toBe(first);
			expect(second!.generation).toBe(2);
			expect(second!.sessionId).toBe(state.sessionId);
			// The successor is chained behind the aborted start's completion, so
			// by now that start has settled — and settled quietly.
			expect(state.showStatus.filter(message => /auto-start failed/.test(message))).toEqual([]);
		});
	});
});
