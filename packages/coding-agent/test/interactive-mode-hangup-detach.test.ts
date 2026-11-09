import { afterEach, beforeEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { closeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ExtensionUIDialogOptions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import type { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import {
	cfgMarketplaceAutoUpdate,
	cfgStartupChangelogMode,
	cfgStartupCheckUpdate,
	cfgStartupSetupWizard,
	cfgStartupShowSplash,
} from "@oh-my-pi/pi-coding-agent/modes/settings";
import { createAgentSessionSocket, type RpcSessionSocket } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-socket";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { HistoryStorage } from "@oh-my-pi/pi-coding-agent/session/history-storage";
import { closeSessionIndex } from "@oh-my-pi/pi-coding-agent/session/session-index";
import { IpcConnection } from "@oh-my-pi/pi-natives";
import { Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { getProjectDir, postmortem, setProjectDir, Snowflake, withTimeout } from "@oh-my-pi/pi-utils";
import * as utils from "@oh-my-pi/pi-utils";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";
import { createTestSession, type TestSessionContext } from "./utilities";

type Frame = Record<string, unknown> & { type?: string };

const FRAME_TIMEOUT_MS = 5000;

class SocketPeer {
	readonly #queue: Frame[] = [];
	#wake: (() => void) | undefined;
	private constructor(private readonly conn: IpcConnection) {}

	static async connect(endpoint: string): Promise<SocketPeer> {
		const conn = await IpcConnection.connect(endpoint, { framing: "lines", timeoutMs: 4000 });
		const peer = new SocketPeer(conn);
		conn.start(
			line => {
				let frame: Frame;
				try {
					frame = JSON.parse(line) as Frame;
				} catch {
					return;
				}
				peer.#queue.push(frame);
				peer.#wake?.();
			},
			() => {},
		);
		return peer;
	}

	async next(predicate: (frame: Frame) => boolean, timeoutMs = FRAME_TIMEOUT_MS): Promise<Frame> {
		for (;;) {
			const index = this.#queue.findIndex(predicate);
			if (index >= 0) return this.#queue.splice(index, 1)[0]!;
			const arrived = Promise.withResolvers<void>();
			this.#wake = arrived.resolve;
			await withTimeout(
				arrived.promise,
				timeoutMs,
				`timed out waiting for frame; saw ${JSON.stringify(this.#queue)}`,
			);
			this.#wake = undefined;
		}
	}

	send(frame: object): void {
		this.conn.send(JSON.stringify(frame));
	}

	close(): void {
		this.conn.destroy();
	}
}

describe("terminal hangup detaches the view, not the session", () => {
	let tmp: string;
	let originalProject: string;
	let testSession: TestSessionContext | undefined;
	let mode: InteractiveMode | undefined;
	let socket: RpcSessionSocket | undefined;
	let shutdownEvents: string[] = [];

	const extensionRunner = {
		hasHandlers: (type: string) => type === "session_shutdown",
		emit: async (event: { type: string }) => {
			shutdownEvents.push(event.type);
		},
		disposeFileFallbacks: () => {},
		clearManagedTimers: () => {},
		setToolApprovalPreviewWaiter: () => () => {},
		onSuspensionChange: () => () => {},
		onToolRegistered: () => () => {},
		getShortcuts: () => [],
		getComposerShapes: () => [],
		getMessageRenderer: () => undefined,
		getAssistantThinkingRenderers: () => undefined,
		getLoadedExtensions: () => [],
		getRegisteredCommands: () => [],
	};
	const runnerStub = new Proxy(extensionRunner, {
		get(target, prop, receiver) {
			if (prop in target) return Reflect.get(target, prop, receiver);
			if (typeof prop === "string") return () => undefined;
			return undefined;
		},
	}) as unknown as ExtensionRunner;

	beforeEach(async () => {
		tmp = path.join(os.tmpdir(), `omp-hangup-detach-${Snowflake.next()}`);
		await fs.mkdir(tmp, { recursive: true });
		originalProject = getProjectDir();
		setProjectDir(tmp);
		spyOn(utils, "getConfigRootDir").mockReturnValue(tmp);
		resetSettingsForTest();
		await initTheme();
		await Settings.init({ inMemory: true, cwd: tmp });
		shutdownEvents = [];
	});

	afterEach(async () => {
		mode?.stop();
		mode = undefined;
		await socket?.close();
		socket = undefined;
		if (testSession) {
			await testSession.cleanup();
			testSession = undefined;
		}
		vi.restoreAllMocks();
		resetSettingsForTest();
		setProjectDir(originalProject);
		AgentStorage.close();
		HistoryStorage.close();
		closeSessionIndex();
		closeModelCache();
		await fs.rm(tmp, { recursive: true, force: true });
	});

	async function startMode(): Promise<{ session: TestSessionContext["session"]; endpoint: string }> {
		testSession = await createTestSession({ extensionRunner: runnerStub });
		const session = testSession.session;
		cfgStartupCheckUpdate.override(session.settings, false);
		cfgStartupChangelogMode.override(session.settings, "hidden");
		cfgStartupSetupWizard.override(session.settings, false);
		cfgStartupShowSplash.override(session.settings, false);
		cfgMarketplaceAutoUpdate.override(session.settings, "off");
		vi.spyOn(session, "prewarmModelConnection").mockImplementation(() => {});
		mode = new InteractiveMode(
			session,
			"test",
			undefined,
			undefined,
			undefined,
			undefined,
			new Composer({ terminal: new VirtualTerminal(200, 60) }),
		);
		spyOn(mode.statusLine, "watchBranch").mockImplementation(() => {});
		socket = createAgentSessionSocket(session, { endpointDir: tmp });
		await mode.attachSessionSocket(socket);
		await mode.init({ suppressWelcomeIntro: true, autoStartCollab: false });
		const endpoint = socket.endpoint;
		if (!endpoint) throw new Error("attach endpoint was not published");
		return { session, endpoint };
	}

	async function readState(endpoint: string): Promise<Frame> {
		const peer = await SocketPeer.connect(endpoint);
		try {
			await peer.next(frame => frame.type === "ready");
			peer.send({ id: "state", type: "get_state" });
			return await peer.next(frame => frame.type === "response" && frame.id === "state");
		} finally {
			peer.close();
		}
	}

	it("keeps the session and its attach endpoint serving after the hangup path runs", async () => {
		const { session, endpoint } = await startMode();
		const draft = "unsent draft before the terminal vanished";
		mode!.editor.setText(draft);

		// The endpoint answered before the hangup, so the post-detach answer
		// cannot come from a listener that was already dead.
		expect((await readState(endpoint)).success).toBe(true);

		await mode!.detachForHangup();

		expect(session.isDisposed).toBe(false);
		expect(socket!.endpoint).toBe(endpoint);
		const artifactsDir = testSession!.sessionManager.getArtifactsDir();
		if (!artifactsDir) throw new Error("test session has no artifacts directory");
		expect(await Bun.file(path.join(artifactsDir, "draft.txt")).text()).toBe(draft);

		const state = await readState(endpoint);
		expect(state.success).toBe(true);
		expect(state).toMatchObject({ data: { sessionId: session.sessionId } });
	}, 60_000);

	it("keeps a pending dialog answerable by an attached client across the hangup", async () => {
		const { endpoint } = await startMode();
		const peer = await SocketPeer.connect(endpoint);
		try {
			await peer.next(frame => frame.type === "ready");
			const tui = Promise.withResolvers<string | undefined>();
			const pending = mode!.dialogFirstResponder.select(
				(dialogOptions?: ExtensionUIDialogOptions) => {
					dialogOptions?.signal?.addEventListener("abort", () => tui.resolve(undefined), { once: true });
					return tui.promise;
				},
				"Pick one",
				["one", "two"],
			);
			const request = await peer.next(frame => frame.type === "extension_ui_request" && frame.method === "select");

			await mode!.detachForHangup();
			expect(mode!.dialogFirstResponder.hasAttachedClients()).toBe(true);

			peer.send({ type: "extension_ui_response", id: request.id, value: "two" });
			await expect(pending).resolves.toBe("two");
		} finally {
			peer.close();
		}
	}, 60_000);

	it("still performs the full teardown on an explicit exit", async () => {
		const { session } = await startMode();
		vi.spyOn(postmortem, "quit").mockResolvedValue(undefined);

		await mode!.shutdown();
		mode = undefined;

		expect(session.isDisposed).toBe(true);
		expect(shutdownEvents).toContain("session_shutdown");
	}, 60_000);
});
