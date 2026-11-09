import { afterEach, beforeEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { closeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { createAgentSessionSocket, type RpcSessionSocket } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-socket";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { HistoryStorage } from "@oh-my-pi/pi-coding-agent/session/history-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { closeSessionIndex } from "@oh-my-pi/pi-coding-agent/session/session-index";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { IpcConnection } from "@oh-my-pi/pi-natives";
import { APPROVE_ARM_MS } from "@oh-my-pi/pi-tui/overlays/approval-dialog";
import { Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { getProjectDir, setProjectDir, Snowflake, withTimeout } from "@oh-my-pi/pi-utils";
import * as utils from "@oh-my-pi/pi-utils";
import { VirtualTerminal } from "../../../tui/test/virtual-terminal";

const GENERATION = "probe-generation";
const FRAME_TIMEOUT_MS = 10_000;

type Frame = Record<string, unknown> & { type?: string };

class SocketPeer {
	readonly seen: Frame[] = [];
	#queue: Frame[] = [];
	#wake: (() => void) | undefined;
	closed = false;

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
				peer.seen.push(frame);
				peer.#queue.push(frame);
				peer.#wake?.();
			},
			() => {
				peer.closed = true;
			},
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

interface RefreshFixture {
	session: AgentSession;
	mode: InteractiveMode;
	socket: RpcSessionSocket;
	terminal: VirtualTerminal;
	dir: string;
	endpoint: string;
	dispose(): Promise<void>;
}

async function createRefreshFixture(): Promise<RefreshFixture> {
	const dir = path.join(os.tmpdir(), `omp-terminal-refresh-${Snowflake.next()}`);
	fs.mkdirSync(dir, { recursive: true });
	const terminal = new VirtualTerminal(120, 40);
	const mock = createMockModel({ responses: [] });
	const sessionManager = SessionManager.inMemory(dir);
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model: mock.model, systemPrompt: ["Test"], tools: [], messages: [] },
		convertToLlm,
		streamFn: mock.stream,
	});
	const authStorage = await AuthStorage.create(path.join(dir, "auth.db"));
	const session = new AgentSession({
		agent,
		sessionManager,
		settings: Settings.isolated({ "compaction.enabled": false }),
		modelRegistry: new ModelRegistry(authStorage, path.join(dir, "models.yml")),
		toolRegistry: new Map(),
	});
	session.subscribe(() => {});
	const socket = createAgentSessionSocket(session, { endpointDir: dir });
	const mode = new InteractiveMode(
		session,
		"test",
		undefined,
		undefined,
		undefined,
		undefined,
		new Composer({ terminal }),
	);
	await mode.attachSessionSocket(socket, { generation: GENERATION });
	await mode.init({ suppressWelcomeIntro: true });
	return {
		session,
		mode,
		socket,
		terminal,
		dir,
		endpoint: path.join(dir, `${session.sessionId}.sock`),
		dispose: async () => {
			mode.stop();
			await socket.close();
			await session.dispose();
			authStorage.close();
			fs.rmSync(dir, { recursive: true, force: true });
		},
	};
}

async function waitFor(condition: () => boolean, message: string): Promise<void> {
	const deadline = Date.now() + FRAME_TIMEOUT_MS;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error(message);
		await Bun.sleep(10);
	}
}

describe("a terminal refresh on a live session", () => {
	let fixture: RefreshFixture | undefined;
	let originalProject: string;

	beforeEach(async () => {
		const configRoot = path.join(os.tmpdir(), `omp-terminal-refresh-config-${Snowflake.next()}`);
		fs.mkdirSync(configRoot, { recursive: true });
		originalProject = getProjectDir();
		setProjectDir(configRoot);
		spyOn(utils, "getConfigRootDir").mockReturnValue(configRoot);
		resetSettingsForTest();
		await initTheme();
		await Settings.init({ inMemory: true, cwd: configRoot });
	});

	afterEach(async () => {
		await fixture?.dispose();
		fixture = undefined;
		vi.restoreAllMocks();
		resetSettingsForTest();
		setProjectDir(originalProject);
		AgentStorage.close();
		HistoryStorage.close();
		closeSessionIndex();
		closeModelCache();
	});

	it("keeps the draft and a pending approval answerable after the renderer restarts", async () => {
		fixture = await createRefreshFixture();
		const mode = fixture.mode;
		const dispose = spyOn(fixture.session, "dispose");
		const stopMode = spyOn(mode, "stop");
		const closeSocket = spyOn(fixture.socket, "close");

		mode.editor.setText("draft λ");
		const realNow = performance.now.bind(performance);
		let clockOffsetMs = 0;
		spyOn(performance, "now").mockImplementation(() => realNow() + clockOffsetMs);
		const approve = mode.getToolUIContext()?.approve;
		expect(approve).toBeDefined();
		if (!approve) throw new Error("interactive mode exposes no approval prompt");
		const approval = approve({
			full: "Allow tool: write\nPath: /tmp/out.txt",
			compact: "Allow tool: write\nPath: /tmp/out.txt",
		});
		let settledWith: unknown;
		let settled = false;
		void approval.then(value => {
			settled = true;
			settledWith = value;
		});
		await waitFor(() => mode.editorContainer.children.length === 2, "approval dialog never presented");

		mode.refreshTerminalAttachment();

		expect(mode.editor.getText()).toBe("draft λ");
		expect(settled).toBe(false);

		clockOffsetMs = APPROVE_ARM_MS * 2;
		fixture.terminal.sendInput("\x11");

		expect(await approval).toBe("once");
		expect(settledWith).toBe("once");
		expect(mode.editor.getText()).toBe("draft λ");
		expect(dispose).not.toHaveBeenCalled();
		expect(closeSocket).not.toHaveBeenCalled();
		expect(stopMode).not.toHaveBeenCalled();
	}, 30_000);

	it("serves a fenced terminal_refresh over the session endpoint and keeps serving get_state", async () => {
		fixture = await createRefreshFixture();
		const mode = fixture.mode;
		const dispose = spyOn(fixture.session, "dispose");
		const peer = await SocketPeer.connect(fixture.endpoint);
		try {
			await peer.next(frame => frame.type === "ready");
			const stop = spyOn(mode.ui, "stop");
			const start = spyOn(mode.ui, "start");
			const sessionId = fixture.session.sessionId;

			peer.send({
				type: "terminal_refresh",
				id: "wrong-session",
				sessionId: "someone-else",
				generation: GENERATION,
			});
			expect(await peer.next(frame => frame.id === "wrong-session")).toMatchObject({
				type: "terminal_refresh_error",
			});

			peer.send({ type: "terminal_refresh", id: "wrong-generation", sessionId, generation: "stale" });
			expect(await peer.next(frame => frame.id === "wrong-generation")).toMatchObject({
				type: "terminal_refresh_error",
			});
			expect(stop).not.toHaveBeenCalled();

			peer.send({ id: "during", type: "get_state" });
			peer.send({ type: "terminal_refresh", id: "refresh", sessionId, generation: GENERATION });
			expect(await peer.next(frame => frame.id === "refresh")).toMatchObject({
				type: "terminal_refreshed",
				id: "refresh",
				sessionId,
				generation: GENERATION,
			});
			expect((await peer.next(frame => frame.id === "during")).success).toBe(true);
			expect(stop).toHaveBeenCalledTimes(1);
			expect(start).toHaveBeenCalledTimes(1);
			expect(dispose).not.toHaveBeenCalled();

			peer.send({ id: "after", type: "get_state" });
			const after = await peer.next(frame => frame.id === "after");
			expect(after.success).toBe(true);
			expect((after.data as Record<string, unknown>).sessionId).toBe(sessionId);
		} finally {
			peer.close();
		}
	}, 30_000);
});
