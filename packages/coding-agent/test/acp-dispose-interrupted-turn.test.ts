import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel, type MockHandler } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AcpAgent } from "@oh-my-pi/pi-coding-agent/modes/acp/acp-agent";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { INTERRUPTED_TURN_ERROR } from "@oh-my-pi/pi-coding-agent/session/exit-diagnostics";
import { USER_INTERRUPT_LABEL } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { postmortem, TempDir } from "@oh-my-pi/pi-utils";
import { AgentSideConnection, type AnyMessage, type Stream } from "@oh-my-pi/pi-utils/acp";

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
			let acp: AcpAgent;
			const sink: Stream = {
				writable: new WritableStream<AnyMessage>(),
				readable: new ReadableStream<AnyMessage>(),
			};
			const connection = new AgentSideConnection(() => acp, sink);
			acp = new AcpAgent(connection, async () => session);
			try {
				await acp.initialize({ protocolVersion: 1, clientCapabilities: {} });
				const { sessionId } = await acp.newSession({ cwd: tempDir.path(), mcpServers: [] });
				const running = acp.prompt({ sessionId, prompt: [{ type: "text", text: "work" }] });
				await requested.promise;
				await acp.dispose(reason);
				expect((await running).stopReason).toBe("cancelled");
			} finally {
				await acp.dispose(reason);
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
