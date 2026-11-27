import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel, type MockHandler } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAcpConnection } from "@oh-my-pi/pi-coding-agent/modes/acp/acp-mode";
import { AcpAgent } from "@oh-my-pi/pi-coding-agent/modes/acp/acp-agent";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { INTERRUPTED_TURN_ERROR } from "@oh-my-pi/pi-coding-agent/session/exit-diagnostics";
import { USER_INTERRUPT_LABEL } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { postmortem, TempDir } from "@oh-my-pi/pi-utils";
import {
	type Client,
	ClientSideConnection,
	type CreateTerminalRequest,
	type CreateTerminalResponse,
	type RequestPermissionRequest,
	type RequestPermissionResponse,
	type SessionNotification,
} from "@oh-my-pi/pi-utils/acp";

class TestClient implements Client {
	async requestPermission(_params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
		return { outcome: { outcome: "selected", optionId: "allow_once" } };
	}

	async sessionUpdate(_params: SessionNotification): Promise<void> {}

	async createTerminal(_params: CreateTerminalRequest): Promise<CreateTerminalResponse> {
		return { terminalId: "test-terminal" };
	}
}

/**
 * Close one direction of the in-memory transport. `RpcConnection`'s writer
 * lock releases on a queued microtask after the final frame. Closing while it
 * is held rejects; wait for the lock to clear (bounded) first, mirroring
 * acp-lazy-startup.test.ts.
 */
async function closeTransport(writable: WritableStream<unknown>): Promise<void> {
	for (let i = 0; i < 100 && writable.locked; i++) {
		const { promise, resolve } = Promise.withResolvers<void>();
		setImmediate(resolve);
		await promise;
	}
	await Promise.allSettled([writable.close()]);
}

describe("AcpAgent.dispose under a running turn", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;

	beforeAll(async () => {
		tempDir = TempDir.createSync("@pi-acp-dispose-");
		authStorage = await AuthStorage.create(":memory:");
		authStorage.keys.setRuntime("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	function open(sessionManager: SessionManager, responses: MockHandler[]) {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled Anthropic test model to exist");
		const mock = createMockModel({ responses });
		const session = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: {
					model,
					systemPrompt: ["Test"],
					tools: [],
					messages: sessionManager.buildSessionContext().messages,
				},
				streamFn: mock.stream,
			}),
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false, "retry.enabled": false }),
			modelRegistry,
		});
		session.subscribe(() => {});
		return { session, mock };
	}

	it("records host shutdown as interrupted and Ctrl+C as a user stop", async () => {
		const rows = [
			{ reason: postmortem.Reason.SIGTERM, errorMessage: INTERRUPTED_TURN_ERROR, restored: true },
			{ reason: postmortem.Reason.SIGINT, errorMessage: USER_INTERRUPT_LABEL, restored: false },
		];
		for (const [index, { reason, errorMessage, restored }] of rows.entries()) {
			const sessionManager = SessionManager.create(tempDir.path(), tempDir.join(`acp-${index}`));
			const requested = Promise.withResolvers<void>();
			const { session } = open(sessionManager, [
				() => {
					requested.resolve();
					return { delayMs: 60_000, content: ["never streamed"] };
				},
			]);

			// Real in-memory ACP transport. The agent side compiles against the
			// actual `AgentSideConnection` contract (acp-lazy-startup.test.ts pairing).
			const clientToAgent = new TransformStream();
			const agentToClient = new TransformStream();
			const clientConnection = new ClientSideConnection(() => new TestClient(), {
				writable: clientToAgent.writable,
				readable: agentToClient.readable,
			});
			let acp: AcpAgent | undefined;
			const serverConnection = createAcpConnection(
				{ writable: agentToClient.writable, readable: clientToAgent.readable },
				async () => session,
				undefined,
				agent => {
					acp = agent;
				},
			);

			try {
				await clientConnection.initialize({ protocolVersion: 1, clientCapabilities: {} });
				const { sessionId } = await clientConnection.newSession({
					cwd: tempDir.path(),
					mcpServers: [],
				});
				const running = clientConnection.prompt({ sessionId, prompt: [{ type: "text", text: "work" }] });
				await requested.promise;
				if (!acp) throw new Error("Expected ACP agent to be initialized");
				await acp.dispose(reason);
				expect((await running).stopReason).toBe("cancelled");
			} finally {
				if (acp) await acp.dispose(reason);
				await closeTransport(clientToAgent.writable);
				await closeTransport(agentToClient.writable);
				await Promise.allSettled([clientConnection.closed, serverConnection.closed]);
			}

			const file = sessionManager.getSessionFile();
			if (!file) throw new Error("Expected a persisted session file");
			const reopened = await SessionManager.open(file);
			const last = reopened
				.getBranch()
				.findLast(entry => entry.type === "message" && entry.message.role === "assistant");
			const assistant = last?.type === "message" && last.message.role === "assistant" ? last.message : undefined;
			expect({ reason, stopReason: assistant?.stopReason, errorMessage: assistant?.errorMessage }).toEqual({
				reason,
				stopReason: "aborted",
				errorMessage,
			});

			const { session: second, mock } = open(reopened, [{ content: ["done after restore"], stopReason: "stop" }]);
			try {
				expect({ reason, restored: await second.restoreInterruptedTurn() }).toEqual({ reason, restored });
				await second.waitForIdle();
				expect({ reason, calls: mock.calls.length }).toEqual({ reason, calls: restored ? 1 : 0 });
			} finally {
				await second.dispose();
			}
		}
	});
});
