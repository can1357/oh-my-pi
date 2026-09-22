/**
 * ACP agent wake (`clientCapabilities._meta["bb.dev"].agentWake`): wake-aware
 * clients get parked agent-initiated turns plus `_omp/session/wake`
 * notifications instead of server-initiated turns they cannot show as busy,
 * and `session/prompt` responses carry `pendingAsyncJobs` in
 * `PromptResponse._meta`. Non-advertising clients keep today's behavior.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AcpAgent } from "@oh-my-pi/pi-coding-agent/modes/acp/acp-agent";
import { createAcpClientBridge } from "@oh-my-pi/pi-coding-agent/modes/acp/acp-client-bridge";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { getConfigRootDir, setAgentDir } from "@oh-my-pi/pi-utils";
import type {
	AgentSideConnection,
	ClientCapabilities,
	InitializeRequest,
	NewSessionRequest,
	PromptRequest,
	SessionNotification,
	Validator,
} from "@oh-my-pi/pi-utils/acp";
import { zNewSessionResponse, zPromptResponse } from "@oh-my-pi/pi-utils/acp";

/** Validates an ACP wire payload against the in-house protocol schemas. */
function expectAcpStructure(schema: Validator<unknown>, value: unknown): void {
	const result = schema.safeParse(value);
	expect(result.success, result.success ? undefined : JSON.stringify(result.error.issues, null, 2)).toBe(true);
}

const TEST_MODELS: Model[] = [
	buildModel({
		id: "claude-sonnet-4-20250514",
		name: "Claude Sonnet",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://example.invalid",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8_192,
	}),
];

interface RecordedNotification {
	method: string;
	params: unknown;
}

function createRecordingConnection(): { connection: AgentSideConnection; notifications: RecordedNotification[] } {
	const notifications: RecordedNotification[] = [];
	const connection = {
		sessionUpdate: async (_notification: SessionNotification) => {},
		notify: async (method: string, params: unknown) => {
			notifications.push({ method, params });
		},
		signal: new AbortController().signal,
		closed: Promise.withResolvers<void>().promise,
	} as unknown as AgentSideConnection;
	return { connection, notifications };
}

function wakeAdvertiseRequest(): InitializeRequest {
	return {
		protocolVersion: 1,
		clientCapabilities: { _meta: { "bb.dev": { agentWake: 1 } } } as ClientCapabilities,
	} as InitializeRequest;
}

function plainAdvertiseRequest(): InitializeRequest {
	return { protocolVersion: 1, clientCapabilities: {} } as InitializeRequest;
}

function makeAssistantMessage(text: string) {
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text }],
		api: "anthropic-messages" as const,
		provider: "anthropic" as const,
		model: TEST_MODELS[0]!.id,
		usage: {
			input: 10,
			output: 5,
			cacheRead: 2,
			cacheWrite: 1,
			totalTokens: 18,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop" as const,
		timestamp: Date.now(),
	};
}

class FakeAgentSession {
	sessionManager: SessionManager;
	sessionId: string;
	agent: { sessionId: string; waitForIdle: () => Promise<void> };
	model: Model | undefined;
	thinkingLevel: string | undefined;
	customCommands: [] = [];
	extensionRunner = undefined;
	isStreaming = false;
	queuedMessageCount = 0;
	systemPrompt = "system";
	disposed = false;
	fastMode = false;
	promptCalls: string[] = [];
	skillsSettings = { enableSkillCommands: true };
	skills: Array<{ name: string; description: string; filePath: string; baseDir: string; source: string }> = [];
	planModeState: unknown;
	waitForIdleCalls = 0;
	pendingAsyncJobCount = 0;
	#listeners = new Set<(event: unknown) => void>();

	constructor(cwd: string) {
		this.sessionManager = SessionManager.create(cwd);
		this.sessionId = this.sessionManager.getSessionId();
		this.agent = {
			sessionId: this.sessionId,
			waitForIdle: async () => {
				this.waitForIdleCalls++;
			},
		};
		this.model = TEST_MODELS[0];
	}

	get settings() {
		return { get: (_path: string) => false };
	}

	get sessionName(): string {
		return this.sessionManager.getHeader()?.title ?? `Session ${this.sessionId}`;
	}

	get modelRegistry(): { getApiKey: (model: Model) => Promise<string> } {
		return { getApiKey: async (_model: Model) => "test-key" };
	}

	getAvailableModels(): Model[] {
		return TEST_MODELS;
	}

	getAvailableThinkingLevels(): ReadonlyArray<string> {
		return ["low", "medium", "high"];
	}

	setThinkingLevel(_level: string | undefined): void {}
	setSlashCommands(_commands: unknown[]): void {}
	async setModel(_model: Model): Promise<void> {}
	subscribe(listener: (event: unknown) => void): () => void {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	}

	async prompt(text: string): Promise<boolean> {
		this.promptCalls.push(text);
		this.isStreaming = true;
		this.sessionManager.appendMessage({ role: "user", content: text, timestamp: Date.now() });
		const assistantMessage = makeAssistantMessage("pong");
		for (const listener of this.#listeners) {
			listener({
				type: "message_update",
				message: assistantMessage,
				assistantMessageEvent: { type: "text_delta", delta: "pong" },
			});
		}
		this.sessionManager.appendMessage(assistantMessage);
		for (const listener of this.#listeners) {
			listener({ type: "agent_end", messages: [assistantMessage] });
		}
		this.isStreaming = false;
		return true;
	}

	async waitForIdle(): Promise<void> {
		this.waitForIdleCalls++;
	}

	getPendingAsyncJobCount(): number {
		return this.pendingAsyncJobCount;
	}

	async drainAsyncJobDeliveriesForAcp(_options?: { timeoutMs?: number }): Promise<boolean> {
		return false;
	}

	async abort(): Promise<void> {
		this.isStreaming = false;
	}

	async promptCustomMessage(): Promise<void> {}
	async refreshMCPTools(_tools: unknown[]): Promise<void> {}
	getContextUsage(): undefined {
		return undefined;
	}
	async switchSession(sessionPath: string): Promise<boolean> {
		await this.sessionManager.setSessionFile(sessionPath);
		this.sessionId = this.sessionManager.getSessionId();
		this.agent.sessionId = this.sessionId;
		return true;
	}
	async dispose(): Promise<void> {
		this.disposed = true;
		await this.sessionManager.close();
	}
	async reload(): Promise<void> {}
	async newSession(): Promise<boolean> {
		await this.sessionManager.newSession();
		this.sessionId = this.sessionManager.getSessionId();
		this.agent.sessionId = this.sessionId;
		return true;
	}
	async branch(): Promise<{ cancelled: boolean }> {
		return { cancelled: false };
	}
	async navigateTree(): Promise<{ cancelled: boolean }> {
		return { cancelled: false };
	}
	getActiveToolNames(): string[] {
		return [];
	}
	getAllToolNames(): string[] {
		return [];
	}
	setActiveToolsByName(_toolNames: string[]): void {}
	setClientBridge(_bridge: unknown): void {}
	getPlanModeState(): unknown {
		return this.planModeState;
	}
	setPlanModeState(_state: unknown): void {}
	setPlanProposalHandler(_handler: unknown): void {}
	peekPlanProposalHandler(): undefined {
		return undefined;
	}
	setPlanReferencePath(_path: string): void {}
	getToolByName(_name: string): undefined {
		return undefined;
	}
	toggleFastMode(): boolean {
		this.fastMode = !this.fastMode;
		return this.fastMode;
	}
	setFastMode(_enabled: boolean): boolean {
		return true;
	}
	isFastModeEnabled(): boolean {
		return this.fastMode;
	}
	setForcedToolChoice(_toolName: string): void {}
	async sendCustomMessage(): Promise<void> {}
	async sendUserMessage(): Promise<void> {}
	async compact(): Promise<void> {}
	async fork(): Promise<boolean> {
		return false;
	}
}

const cleanupRoots: string[] = [];
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const fallbackAgentDir = path.join(getConfigRootDir(), "agent");

async function createAcpHarness(): Promise<{
	agent: AcpAgent;
	notifications: RecordedNotification[];
	sessions: FakeAgentSession[];
	cwd: string;
}> {
	const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-acp-wake-"));
	cleanupRoots.push(root);
	const agentDir = path.join(root, "agent");
	const cwd = path.join(root, "cwd");
	await fs.promises.mkdir(agentDir, { recursive: true });
	await fs.promises.mkdir(cwd, { recursive: true });
	setAgentDir(agentDir);

	const { connection, notifications } = createRecordingConnection();
	const sessions: FakeAgentSession[] = [new FakeAgentSession(cwd)];
	const factory = async (next: string) => {
		const session = new FakeAgentSession(next);
		sessions.push(session);
		return { session: session as unknown as AgentSession, setToolUIContext: () => {} };
	};
	const agent = new AcpAgent(connection, factory, sessions[0] as unknown as AgentSession);
	return { agent, notifications, sessions, cwd };
}
describe("ACP agent wake advertisement", () => {
	afterEach(async () => {
		if (originalAgentDir) {
			setAgentDir(originalAgentDir);
		} else {
			setAgentDir(fallbackAgentDir);
			delete process.env.PI_CODING_AGENT_DIR;
		}
		for (const root of cleanupRoots.splice(0)) {
			await fs.promises.rm(root, { recursive: true, force: true });
		}
	});

	it("mirrors agentWake in agentCapabilities._meta only for wake-advertised clients", async () => {
		const { agent } = await createAcpHarness();
		const wakeResponse = await agent.initialize(wakeAdvertiseRequest());
		expect(wakeResponse.agentCapabilities?._meta).toEqual({ "oh-my-pi": { agentWake: 1 } });

		const plainResponse = await agent.initialize(plainAdvertiseRequest());
		expect(plainResponse.agentCapabilities?._meta).toBeUndefined();
	});

	it("stamps pendingAsyncJobs on prompt responses only for wake-aware clients with pending work", async () => {
		const { agent, sessions, cwd } = await createAcpHarness();
		await agent.initialize(wakeAdvertiseRequest());
		const created = await agent.newSession({ cwd, mcpServers: [] } as NewSessionRequest);
		expectAcpStructure(zNewSessionResponse, created);
		const session = sessions.find(candidate => candidate.sessionId === created.sessionId)!;
		session.pendingAsyncJobCount = 2;

		const pending = await agent.prompt({
			sessionId: created.sessionId,
			prompt: [{ type: "text", text: "ping" }],
		} as PromptRequest);
		expectAcpStructure(zPromptResponse, pending);
		expect(pending.stopReason).toBe("end_turn");
		expect(pending._meta).toEqual({ "oh-my-pi": { pendingAsyncJobs: 2 } });

		session.pendingAsyncJobCount = 0;
		const idle = await agent.prompt({
			sessionId: created.sessionId,
			prompt: [{ type: "text", text: "ping again" }],
		} as PromptRequest);
		expect(idle._meta).toBeUndefined();
	});

	it("leaves prompt responses _meta-free for non-advertising clients even with pending work", async () => {
		const { agent, sessions, cwd } = await createAcpHarness();
		await agent.initialize(plainAdvertiseRequest());
		const created = await agent.newSession({ cwd, mcpServers: [] } as NewSessionRequest);
		const session = sessions.find(candidate => candidate.sessionId === created.sessionId)!;
		session.pendingAsyncJobCount = 2;

		const response = await agent.prompt({
			sessionId: created.sessionId,
			prompt: [{ type: "text", text: "ping" }],
		} as PromptRequest);
		expectAcpStructure(zPromptResponse, response);
		expect(response._meta).toBeUndefined();
	});
});

describe("ACP client bridge wake notifications", () => {
	it("sends _omp/session/wake on the connection for wake-aware bridges only", async () => {
		const { connection, notifications } = createRecordingConnection();
		const wakeBridge = createAcpClientBridge(connection, "session-1", undefined, true);
		wakeBridge.notifyAgentWake!({ reason: "async-jobs-settled", batchId: "batch-1" });
		await Promise.resolve();

		expect(notifications).toEqual([
			{
				method: "_omp/session/wake",
				params: { sessionId: "session-1", reason: "async-jobs-settled", batchId: "batch-1" },
			},
		]);

		const plainBridge = createAcpClientBridge(connection, "session-2", undefined, false);
		expect(plainBridge.notifyAgentWake).toBeUndefined();
		expect(notifications).toHaveLength(1);
	});
});

describe("AgentSession wake-aware parked delivery", () => {
	const authStorages: AuthStorage[] = [];
	const sessions: AgentSession[] = [];

	afterEach(async () => {
		for (const session of sessions.splice(0)) {
			await session.dispose();
		}
		for (const authStorage of authStorages.splice(0)) {
			authStorage.close();
		}
		AsyncJobManager.resetForTests();
	});

	interface WakeSessionHarness {
		session: AgentSession;
		mock: MockModel;
		notifications: RecordedNotification[];
		manager: AsyncJobManager;
	}

	async function createWakeSession(wakeAware: boolean): Promise<WakeSessionHarness> {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({ handler: () => ({ content: ["Done"] }) });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			convertToLlm,
			streamFn: mock.stream,
		});
		const authStorage = await AuthStorage.create(":memory:");
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const manager = new AsyncJobManager({});
		AsyncJobManager.setInstance(manager);

		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			modelRegistry: new ModelRegistry(authStorage),
			agentId: "Main",
			asyncJobManager: manager,
		});
		sessions.push(session);
		const { connection, notifications } = createRecordingConnection();
		session.setClientBridge(createAcpClientBridge(connection, session.sessionId, undefined, wakeAware));
		return { session, mock, notifications, manager };
	}

	function messageIncludes(messages: Array<{ content: unknown }>, needle: string): boolean {
		return messages.some(message => {
			if (typeof message.content === "string") {
				return message.content.includes(needle);
			}
			return (
				Array.isArray(message.content) &&
				message.content.some(content => content.type === "text" && content.text.includes(needle))
			);
		});
	}

	function observeAsyncResultEnqueue(session: AgentSession): Promise<void> {
		const queued = Promise.withResolvers<void>();
		const enqueue = session.yieldQueue.enqueueWithReceipt.bind(session.yieldQueue);
		vi.spyOn(session.yieldQueue, "enqueueWithReceipt").mockImplementation((kind, entry) => {
			const receipt = enqueue(kind, entry);
			if (kind === "async-result") queued.resolve();
			return receipt;
		});
		return queued.promise;
	}

	it("parks an agent-initiated turn and emits _omp/session/wake instead of prompting", async () => {
		const { session, mock, notifications } = await createWakeSession(true);

		const dispatched = await session.sendCustomMessage(
			{ customType: "hub-yield", content: "peer result ready", display: true },
			{ deliverAs: "nextTurn", triggerTurn: true },
		);
		expect(dispatched).toBe(false);
		expect(mock.calls).toHaveLength(0);
		expect(notifications).toEqual([
			{
				method: "_omp/session/wake",
				params: {
					sessionId: session.sessionId,
					reason: "agent-initiated",
					batchId: expect.any(String),
				},
			},
		]);

		// The parked message rides along with the client's next real prompt.
		await session.prompt("drain the parked batch");
		expect(mock.calls).toHaveLength(1);
		expect(messageIncludes(mock.calls[0]!.context.messages, "peer result ready")).toBe(true);
	});

	it("parks settled async results and emits async-jobs-settled without a detached prompt", async () => {
		const { session, mock, notifications, manager } = await createWakeSession(true);

		const gate = Promise.withResolvers<string>();
		manager.register("bash", "gated job", () => gate.promise, { id: "wake-job", ownerId: "Main" });
		expect(session.getPendingAsyncJobCount()).toBe(1);

		gate.resolve("job finished: ALL GREEN");
		await session.settleAsyncWork();

		expect(mock.calls).toHaveLength(0);
		expect(notifications).toEqual([
			{
				method: "_omp/session/wake",
				params: {
					sessionId: session.sessionId,
					reason: "async-jobs-settled",
					batchId: expect.any(String),
				},
			},
		]);

		// The wake-answer prompt drains the parked batch as context.
		await session.prompt("what finished?");
		expect(mock.calls).toHaveLength(1);
		expect(messageIncludes(mock.calls[0]!.context.messages, "ALL GREEN")).toBe(true);
	});

	it("injects within-prompt while drainAsyncJobDeliveriesForAcp holds agent-initiated turns open", async () => {
		const { session, mock, notifications, manager } = await createWakeSession(true);

		const enqueued = observeAsyncResultEnqueue(session);
		const gate = Promise.withResolvers<string>();
		manager.register("bash", "gated job", () => gate.promise, { id: "drain-job", ownerId: "Main" });
		gate.resolve("job finished: DRAINED IN PROMPT");
		await enqueued;

		const drained = await session.drainAsyncJobDeliveriesForAcp();
		await session.waitForIdle();
		expect(drained).toBe(true);
		expect(mock.calls).toHaveLength(1);
		expect(messageIncludes(mock.calls[0]!.context.messages, "DRAINED IN PROMPT")).toBe(true);
		expect(notifications).toEqual([]);
	});

	it("keeps non-advertising clients byte-identical: silent parking and autonomous follow-ups", async () => {
		const parked = await createWakeSession(false);
		const dispatched = await parked.session.sendCustomMessage(
			{ customType: "hub-yield", content: "peer result ready", display: true },
			{ deliverAs: "nextTurn", triggerTurn: true },
		);
		expect(dispatched).toBe(false);
		expect(parked.mock.calls).toHaveLength(0);
		expect(parked.notifications).toEqual([]);
		await parked.session.prompt("drain the parked batch");
		expect(parked.mock.calls).toHaveLength(1);

		const settled = await createWakeSession(false);
		const gate = Promise.withResolvers<string>();
		settled.manager.register("bash", "gated job", () => gate.promise, { id: "plain-job", ownerId: "Main" });
		gate.resolve("job finished: ALL GREEN");
		await settled.session.settleAsyncWork();

		// Today's behavior: the async result still autonomously prompts.
		expect(settled.mock.calls).toHaveLength(1);
		expect(messageIncludes(settled.mock.calls[0]!.context.messages, "ALL GREEN")).toBe(true);
		expect(settled.notifications).toEqual([]);
	});
});
