import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AgentBusyError } from "@oh-my-pi/pi-agent-core";
import {
	byteOffset,
	createLiveTerminalBinding,
	streamId,
	ToolPresentationStream,
	toolExecutionId,
} from "@oh-my-pi/pi-agent-core/presentation";
import type { Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ExtensionUIContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { resolveLocalUrlToPath } from "@oh-my-pi/pi-coding-agent/internal-urls";
import {
	ACP_BOOTSTRAP_RACE_GUARD_MS,
	AcpAgent,
	createAcpExtensionUiContext,
} from "@oh-my-pi/pi-coding-agent/modes/acp/acp-agent";
import type { PlanModeState } from "@oh-my-pi/pi-coding-agent/plan-mode/state";
import type {
	AgentSession,
	AgentSessionEvent,
	UsageFallbackConfirmation,
} from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { ClientBridge } from "@oh-my-pi/pi-coding-agent/session/client-bridge";
import { SILENT_ABORT_MARKER } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { DEFAULT_STT_MODEL_KEY, STT_MODEL_OPTIONS } from "@oh-my-pi/pi-coding-agent/stt/models";
import { TaskTool } from "@oh-my-pi/pi-coding-agent/task";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { EvalTool } from "@oh-my-pi/pi-coding-agent/tools/eval";
import {
	DEFAULT_TTS_LOCAL_MODEL_KEY,
	DEFAULT_TTS_VOICE,
	TTS_LOCAL_MODELS,
	TTS_LOCAL_VOICE_OPTIONS,
} from "@oh-my-pi/pi-coding-agent/tts/models";
import { getConfigRootDir, setAgentDir } from "@oh-my-pi/pi-utils";
import type {
	AgentSideConnection,
	ClientCapabilities,
	CreateElicitationRequest,
	CreateElicitationResponse,
	PromptRequest,
	SessionNotification,
	Validator,
} from "@oh-my-pi/pi-utils/acp";
import {
	RequestError,
	zForkSessionResponse,
	zLoadSessionResponse,
	zNewSessionResponse,
	zPromptResponse,
	zSessionNotification,
} from "@oh-my-pi/pi-utils/acp";
import {
	checkedNotificationPayload,
	encodeToolFrames,
	INITIAL_ACP_TOOL_VIEW,
	reduceAcpToolView,
} from "../src/modes/acp/view";
import { hydrateReplayableToolExecution } from "../src/presentation/hydrate";
import type { ReplayableToolExecution } from "../src/presentation/journal";
import { TOOL_NAME as DELAYED_MCP_TOOL_NAME } from "./fixtures/delayed-tool-mcp";

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
	buildModel({
		id: "gpt-5.4",
		name: "GPT-5.4",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://example.invalid",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8_192,
	}),
];

function createTaskSession(cwd: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		settings: Settings.isolated({}),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
	} as unknown as ToolSession;
}

function makeAssistantMessage(text: string, thinking?: string) {
	const content: Array<{ type: "text"; text: string } | { type: "thinking"; thinking: string }> = [
		{ type: "text", text },
	];
	if (thinking) {
		content.push({ type: "thinking" as const, thinking });
	}
	return {
		role: "assistant" as const,
		content,
		api: "anthropic-messages" as const,
		provider: "anthropic" as const,
		model: TEST_MODELS[0].id,
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
	agent: {
		sessionId: string;
		waitForIdle: () => Promise<void>;
		state: { tools: Array<{ name: string; customWireName?: string }> };
	};
	model: Model | undefined;
	thinkingLevel: string | undefined;
	customCommands: [] = [];
	extensionRunner = undefined;
	isStreaming = false;
	queuedMessageCount = 0;
	systemPrompt = "system";
	disposed = false;
	fastMode = false;
	forcedToolChoice: string | undefined;
	get settings(): Settings {
		return Settings.instance;
	}
	promptCalls: string[] = [];
	customMessages: Array<{ customType: string; content: string; details?: unknown }> = [];
	customMessageOptions: Array<{ streamingBehavior?: "steer" | "followUp"; queueChipText?: string } | undefined> = [];
	skillsSettings = { enableSkillCommands: true };
	skills: Array<{ name: string; description: string; filePath: string; baseDir: string; source: string }> = [];
	refreshSkillsCalls = 0;
	async refreshSkills(): Promise<void> {
		this.refreshSkillsCalls++;
	}
	buildTranscriptSessionContext(options?: { keepDanglingToolCalls?: boolean; collapseCompactedHistory?: boolean }) {
		return this.sessionManager.buildSessionContext({ transcript: true, ...options });
	}
	planModeState: PlanModeState | undefined;
	waitForIdleCalls = 0;
	waitForIdleBlocker: (() => Promise<void>) | undefined;
	asyncJobDrain: ((options?: { timeoutMs?: number }) => Promise<boolean>) | undefined;
	usageFallbackConfirmer: ((confirmation: UsageFallbackConfirmation) => Promise<boolean>) | undefined;
	retryResult = false;
	retryCalls = 0;
	#listeners = new Set<(event: AgentSessionEvent) => void>();
	#builtInToolNames = new Set<string>();

	constructor(
		cwd: string,
		private readonly models: Model[] = TEST_MODELS,
	) {
		this.sessionManager = SessionManager.create(cwd);
		this.sessionId = this.sessionManager.getSessionId();
		this.agent = {
			sessionId: this.sessionId,
			waitForIdle: async () => {
				await this.waitForIdle();
			},
			state: { tools: [] },
		};
		this.model = models[0];
		this.registerBuiltinTool("edit", "apply_patch");
		this.registerBuiltinTool("patch");
	}

	get sessionName(): string {
		return this.sessionManager.getHeader()?.title ?? `Session ${this.sessionId}`;
	}

	get modelRegistry(): { getApiKey: (model: Model) => Promise<string> } {
		return {
			getApiKey: async (_model: Model) => "test-key",
		};
	}

	getAvailableModels(): Model[] {
		return this.models;
	}

	getAvailableThinkingLevels(): ReadonlyArray<string> {
		return ["low", "medium", "high"];
	}

	/** Test double for the session registry's exact-name-first dispatch provenance. */
	hasBuiltInToolDispatch(name: string): boolean {
		const tools = this.agent.state.tools;
		const dispatched =
			tools.find(tool => tool.name === name) ??
			tools.find(tool => tool.customWireName !== undefined && tool.customWireName === name);
		return dispatched !== undefined && this.#builtInToolNames.has(dispatched.name);
	}

	registerBuiltinTool(name: string, customWireName?: string): void {
		this.#builtInToolNames.add(name);
		this.#registerTool({ name, ...(customWireName === undefined ? {} : { customWireName }) });
	}

	registerExternalTool(name: string): void {
		this.#builtInToolNames.delete(name);
		this.#registerTool({ name });
	}

	#registerTool(tool: { name: string; customWireName?: string }): void {
		const index = this.agent.state.tools.findIndex(existing => existing.name === tool.name);
		if (index === -1) this.agent.state.tools.push(tool);
		else this.agent.state.tools[index] = tool;
	}

	setThinkingLevel(level: string | undefined): void {
		const isChanging = this.thinkingLevel !== level;
		this.thinkingLevel = level;
		if (isChanging) {
			for (const listener of this.#listeners) {
				listener({
					type: "thinking_level_changed",
					thinkingLevel: level,
				} as AgentSessionEvent);
			}
		}
	}

	setSlashCommands(_commands: unknown[]): void {
		// no-op for tests
	}
	setUsageFallbackConfirmer(
		confirmer: ((confirmation: UsageFallbackConfirmation) => Promise<boolean>) | undefined,
	): void {
		this.usageFallbackConfirmer = confirmer;
	}

	async setModel(model: Model): Promise<void> {
		const isChanging = this.model?.provider !== model.provider || this.model?.id !== model.id;
		this.model = model;
		if (isChanging) {
			for (const listener of this.#listeners) {
				listener({ type: "model_changed" } as AgentSessionEvent);
			}
		}
	}

	subscribe(listener: (event: AgentSessionEvent) => void): () => void {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	}

	listeners(): Array<(event: AgentSessionEvent) => void> {
		return [...this.#listeners];
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
			} as AgentSessionEvent);
		}
		this.sessionManager.appendMessage(assistantMessage);
		for (const listener of this.#listeners) {
			listener({
				type: "agent_end",
				messages: [assistantMessage],
			} as AgentSessionEvent);
		}
		this.isStreaming = false;
		return true;
	}

	async retry(): Promise<boolean> {
		this.retryCalls++;
		return this.retryResult;
	}

	async waitForIdle(): Promise<void> {
		this.waitForIdleCalls++;
		await this.waitForIdleBlocker?.();
	}

	async drainAsyncJobDeliveriesForAcp(options?: { timeoutMs?: number }): Promise<boolean> {
		return (await this.asyncJobDrain?.(options)) ?? false;
	}

	async abort(): Promise<void> {
		this.isStreaming = false;
	}

	async promptCustomMessage(
		message: { customType: string; content: string; details?: unknown },
		options?: { streamingBehavior?: "steer" | "followUp"; queueChipText?: string },
	): Promise<void> {
		this.customMessages.push(message);
		this.customMessageOptions.push(options);
		this.isStreaming = true;
		const assistantMessage = makeAssistantMessage("skill pong");
		for (const listener of this.#listeners) {
			listener({
				type: "message_update",
				message: assistantMessage,
				assistantMessageEvent: { type: "text_delta", delta: "skill pong" },
			} as AgentSessionEvent);
		}
		this.sessionManager.appendMessage(assistantMessage);
		for (const listener of this.#listeners) {
			listener({
				type: "agent_end",
				messages: [assistantMessage],
			} as AgentSessionEvent);
		}
		this.isStreaming = false;
	}

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

	async branch(_entryId: string): Promise<{ cancelled: boolean }> {
		return { cancelled: false };
	}

	async navigateTree(_targetId: string): Promise<{ cancelled: boolean }> {
		return { cancelled: false };
	}

	getActiveToolNames(): string[] {
		return [];
	}

	getAllToolNames(): string[] {
		return [];
	}

	setActiveToolsByName(_toolNames: string[]): void {}

	/** The bridge `AcpAgent` installed, so a test can drive its real permission path. */
	clientBridge: ClientBridge | undefined;

	setClientBridge(bridge: unknown): void {
		this.clientBridge = bridge as ClientBridge;
	}

	getPlanModeState(): PlanModeState | undefined {
		return this.planModeState;
	}

	setPlanModeState(state: PlanModeState | undefined): void {
		this.planModeState = state;
	}

	planProposalHandler: ((title: string) => Promise<unknown> | unknown) | undefined;

	setPlanProposalHandler(handler: ((title: string) => Promise<unknown> | unknown) | null): void {
		this.planProposalHandler = handler ?? undefined;
	}

	peekPlanProposalHandler(): ((title: string) => Promise<unknown> | unknown) | undefined {
		return this.planProposalHandler;
	}

	planReferencePath: string | undefined;

	setPlanReferencePath(path: string): void {
		this.planReferencePath = path;
	}

	getToolByName(_name: string): undefined {
		return undefined;
	}

	toggleFastMode(): boolean {
		this.fastMode = !this.fastMode;
		return this.fastMode;
	}

	setFastMode(enabled: boolean): boolean {
		this.fastMode = enabled;
		return true;
	}

	isFastModeEnabled(): boolean {
		return this.fastMode;
	}

	setForcedToolChoice(toolName: string): void {
		this.forcedToolChoice = toolName;
	}

	async sendCustomMessage(_message: string, _options?: unknown): Promise<void> {}

	async sendUserMessage(_content: string, _options?: unknown): Promise<void> {}

	async compact(_instructions?: string, _options?: unknown): Promise<void> {}

	async fork(): Promise<boolean> {
		await this.sessionManager.flush();
		const forked = await this.sessionManager.fork();
		if (!forked) {
			return false;
		}
		this.sessionId = this.sessionManager.getSessionId();
		this.agent.sessionId = this.sessionId;
		return true;
	}
}

function holdPromptStreaming(session: FakeAgentSession): () => void {
	let finishPrompt!: () => void;
	session.prompt = async (text: string): Promise<boolean> => {
		session.promptCalls.push(text);
		session.isStreaming = true;
		const blocker = Promise.withResolvers<void>();
		finishPrompt = blocker.resolve;
		await blocker.promise;
		const assistantMessage = makeAssistantMessage("pong");
		for (const listener of session.listeners()) {
			listener({
				type: "message_update",
				message: assistantMessage,
				assistantMessageEvent: { type: "text_delta", delta: "pong" },
			} as AgentSessionEvent);
		}
		session.sessionManager.appendMessage(assistantMessage);
		for (const listener of session.listeners()) {
			listener({
				type: "agent_end",
				messages: [assistantMessage],
			} as AgentSessionEvent);
		}
		session.isStreaming = false;
		return true;
	};
	return () => finishPrompt();
}

type SetToolUIContextSpy = (uiContext: ExtensionUIContext, hasUI: boolean) => void;

interface AgentHarness {
	agent: AcpAgent;
	updates: SessionNotification[];
	/**
	 * Labels of everything that actually reached the fake writer, in wire order —
	 * session updates *and* the `session/request_permission` request, which is a
	 * separate JSON-RPC call that has to join the same ordering domain.
	 */
	writes: string[];
	/**
	 * Resolve once a write with exactly this label has landed in {@link writes}.
	 * Resolves immediately if it already has. Deterministic completion signal for
	 * ordering assertions — never a fixed-duration sleep.
	 */
	waitForWrite(label: string): Promise<void>;
	abortController: AbortController;
	sessions: FakeAgentSession[];
	setToolUIContextSpies: SetToolUIContextSpy[];
	sessionFactoryOptions: Array<{ interactivePrompts?: boolean } | undefined>;
	cwdA: string;
	cwdB: string;
	findSession(sessionId: string): FakeAgentSession | undefined;
}

/** Short, stable label for one outbound notification. */
function writeLabel(notification: SessionNotification): string {
	const update = notification.update as { sessionUpdate?: string; toolCallId?: string };
	return update.toolCallId === undefined
		? String(update.sessionUpdate)
		: `${update.sessionUpdate}:${update.toolCallId}`;
}

function getChunkMessageId(notification: SessionNotification): string | undefined {
	const update = notification.update as { messageId?: string | null };
	return typeof update.messageId === "string" ? update.messageId : undefined;
}

function expectAcpNotifications(updates: SessionNotification[]): void {
	for (const update of updates) {
		expectAcpStructure(zSessionNotification, update);
	}
}

const cleanupRoots: string[] = [];
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const fallbackAgentDir = path.join(getConfigRootDir(), "agent");

afterEach(async () => {
	vi.useRealTimers();
	if (originalAgentDir) {
		setAgentDir(originalAgentDir);
	} else {
		setAgentDir(fallbackAgentDir);
		delete process.env.PI_CODING_AGENT_DIR;
	}
	resetSettingsForTest();

	for (const root of cleanupRoots.splice(0)) {
		await fs.promises.rm(root, { recursive: true, force: true });
	}
});

async function createHarness(
	options: {
		elicitationHandler?: (req: CreateElicitationRequest) => Promise<CreateElicitationResponse>;
		clientCapabilities?: ClientCapabilities;
		/** Runs before a notification is recorded, so a test can delay one delivery. */
		sessionUpdateHook?: (notification: SessionNotification) => Promise<void> | void;
		/** Advertise `_meta.terminal_output` so the reducer picks the display-only meta terminal. */
		terminalMeta?: boolean;
		/** Advertise a real client terminal and record its lifecycle calls on `writes`. */
		terminal?: boolean;
		/** Optional raw ACP terminal/release hook, including intentionally hung peers. */
		terminalRelease?: () => Promise<void>;
		/** Delay every session update, simulating a slow client write. */
		writeDelayMs?: number;
		/** Reject a session update the way a broken connection would. */
		failWrite?: (notification: SessionNotification) => Error | undefined;
		/** Handle `session/request_permission`; the label recorded is `request_permission:<id>`. */
		requestPermission?: (request: {
			toolCall: { toolCallId: string };
		}) => Promise<{ outcome: { outcome: "selected"; optionId: string } | { outcome: "cancelled" } }>;
	} = {},
): Promise<AgentHarness> {
	const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-acp-test-"));
	cleanupRoots.push(root);
	const agentDir = path.join(root, "agent");
	const cwdA = path.join(root, "cwd-a");
	const cwdB = path.join(root, "cwd-b");
	await fs.promises.mkdir(agentDir, { recursive: true });
	await fs.promises.mkdir(cwdA, { recursive: true });
	await fs.promises.mkdir(cwdB, { recursive: true });
	setAgentDir(agentDir);
	await Settings.init({ agentDir, inMemory: true });

	const updates: SessionNotification[] = [];
	const writes: string[] = [];
	const writeWaiters = new Map<string, Array<() => void>>();
	const notifyWrite = (label: string): void => {
		const waiters = writeWaiters.get(label);
		if (waiters === undefined) return;
		writeWaiters.delete(label);
		for (const resolve of waiters) resolve();
	};
	const waitForWrite = (label: string): Promise<void> => {
		if (writes.includes(label)) return Promise.resolve();
		const { promise, resolve } = Promise.withResolvers<void>();
		const waiters = writeWaiters.get(label) ?? [];
		waiters.push(resolve);
		writeWaiters.set(label, waiters);
		return promise;
	};
	const abortController = new AbortController();
	const sessions: FakeAgentSession[] = [];
	const setToolUIContextSpies: SetToolUIContextSpy[] = [];
	const sessionFactoryOptions: Array<{ interactivePrompts?: boolean } | undefined> = [];
	const connection = {
		sessionUpdate: async (notification: SessionNotification) => {
			// Only await when a hook is configured: `await undefined` would insert a
			// microtask before the push and perturb ordering-sensitive tests.
			if (options.sessionUpdateHook) await options.sessionUpdateHook(notification);
			if (options.writeDelayMs !== undefined) await Bun.sleep(options.writeDelayMs);
			const failure = options.failWrite?.(notification);
			if (failure) throw failure;
			updates.push(notification);
			const label = writeLabel(notification);
			writes.push(label);
			notifyWrite(label);
		},
		requestPermission: options.requestPermission
			? async (request: { toolCall: { toolCallId: string } }) => {
					// The *write* happens when the request is issued; the user's answer comes
					// later, which is the whole point of the reserved slot.
					const label = `request_permission:${request.toolCall.toolCallId}`;
					writes.push(label);
					notifyWrite(label);
					return options.requestPermission!(request);
				}
			: undefined,
		createTerminal: options.terminal
			? async () => ({
					id: "client-term-1",
					currentOutput: async () => ({ output: "", truncated: false }),
					waitForExit: async () => ({ exitCode: 0, signal: null }),
					kill: async () => {},
					release: async () => {
						writes.push("release_terminal:client-term-1");
						notifyWrite("release_terminal:client-term-1");
						await options.terminalRelease?.();
					},
				})
			: undefined,
		unstable_createElicitation: options.elicitationHandler
			? async (req: CreateElicitationRequest) => options.elicitationHandler!(req)
			: undefined,
		signal: abortController.signal,
		closed: Promise.withResolvers<void>().promise,
	} as unknown as AgentSideConnection;

	const initialSession = new FakeAgentSession(cwdA);
	sessions.push(initialSession);
	const factory = async (cwd: string, factoryOptions?: { interactivePrompts?: boolean }) => {
		const session = new FakeAgentSession(cwd);
		const setToolUIContext = vi.fn();
		sessions.push(session);
		setToolUIContextSpies.push(setToolUIContext);
		sessionFactoryOptions.push(factoryOptions);
		return { session: session as unknown as AgentSession, setToolUIContext };
	};

	const agent = new AcpAgent(connection, factory, initialSession as unknown as AgentSession);
	const clientCapabilities =
		options.clientCapabilities ?? (options.elicitationHandler ? { elicitation: { form: {} } } : undefined);
	if (options.terminalMeta || options.terminal) {
		await agent.initialize({
			protocolVersion: 1,
			clientCapabilities: {
				...(options.terminalMeta ? { _meta: { terminal_output: true } } : {}),
				...(options.terminal ? { terminal: true } : {}),
			},
		} as Parameters<typeof agent.initialize>[0]);
	}
	if (clientCapabilities) {
		await agent.initialize({
			protocolVersion: 1,
			clientCapabilities,
		} as Parameters<typeof agent.initialize>[0]);
	}

	return {
		agent,
		updates,
		writes,
		waitForWrite,
		abortController,
		sessions,
		setToolUIContextSpies,
		sessionFactoryOptions,
		cwdA,
		cwdB,
		findSession: (sessionId: string) => sessions.find(session => session.sessionId === sessionId),
	};
}

/** Fire `#scheduleBootstrapUpdates`'s guard without paying wall-clock time. */
async function advanceBootstrapGuard(): Promise<void> {
	vi.advanceTimersByTime(ACP_BOOTSTRAP_RACE_GUARD_MS);
	await Promise.resolve();
}
/**
 * Wait until `#scheduleBootstrapUpdates`'s timer has fired and the
 * session-lifetime subscription is installed. 30 ms of slack absorbs
 * `setTimeout` drift without slowing tests meaningfully.
 */
async function waitForBootstrapGuard(): Promise<void> {
	await Bun.sleep(ACP_BOOTSTRAP_RACE_GUARD_MS + 150);
}

describe("ACP agent", () => {
	it("supports multiple live ACP sessions with model and lifecycle handlers", async () => {
		const harness = await createHarness();
		const first = await harness.agent.newSession({ cwd: harness.cwdA, mcpServers: [] });
		const second = await harness.agent.newSession({ cwd: harness.cwdB, mcpServers: [] });
		expectAcpStructure(zNewSessionResponse, first);
		expectAcpStructure(zNewSessionResponse, second);

		const modelOption = first.configOptions?.find(opt => opt.id === "model");
		expect(modelOption?.type).toBe("select");
		expect((modelOption as any).options?.map((opt: any) => opt.value)).toEqual(
			TEST_MODELS.map(model => `${model.provider}/${model.id}`),
		);

		await harness.agent.setSessionConfigOption({
			sessionId: first.sessionId,
			configId: "model",
			value: `${TEST_MODELS[1]!.provider}/${TEST_MODELS[1]!.id}`,
		});
		await harness.agent.setSessionConfigOption({
			sessionId: first.sessionId,
			configId: "thinking",
			value: "high",
		});
		// Both model and thinking-level changes must surface as ACP
		// `config_option_update` notifications scoped to the right session;
		// the schema check alone would still pass if either method stopped
		// emitting notifications entirely.
		const configUpdatesForFirst = harness.updates.filter(
			n => n.sessionId === first.sessionId && n.update.sessionUpdate === "config_option_update",
		);
		expect(configUpdatesForFirst.length).toBeGreaterThanOrEqual(2);
		expectAcpNotifications(harness.updates);

		const firstSession = harness.findSession(first.sessionId);
		const secondSession = harness.findSession(second.sessionId);
		expect(firstSession?.model?.id).toBe(TEST_MODELS[1]!.id);
		expect(firstSession?.thinkingLevel).toBe("high");
		expect(secondSession?.model?.id).toBe(TEST_MODELS[0]!.id);
		expect(secondSession?.thinkingLevel).toBeUndefined();

		firstSession?.sessionManager.appendMessage({ role: "user", content: "fork me", timestamp: Date.now() });
		await firstSession?.sessionManager.flush();

		const forked = await harness.agent.unstable_forkSession({
			sessionId: first.sessionId,
			cwd: harness.cwdA,
			mcpServers: [],
		});
		expectAcpStructure(zForkSessionResponse, forked);
		const forkedSession = harness.findSession(forked.sessionId);
		const forkedMessages = forkedSession?.sessionManager.buildSessionContext().messages ?? [];
		expect(forked.sessionId).not.toBe(first.sessionId);
		expect(forkedMessages.some(message => message.role === "user" && message.content === "fork me")).toBe(true);

		await harness.agent.closeSession({ sessionId: forked.sessionId });
		await expect(harness.agent.setSessionMode({ sessionId: forked.sessionId, modeId: "default" })).rejects.toThrow(
			"Unsupported ACP session",
		);

		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("advertises plan mode and emits schema-valid mode updates", async () => {
		const harness = await createHarness();
		Settings.instance.set("plan.enabled", true);

		const created = await harness.agent.newSession({ cwd: harness.cwdA, mcpServers: [] });
		expectAcpStructure(zNewSessionResponse, created);
		expect(created.modes?.availableModes.map(mode => mode.id)).toEqual(["default", "plan"]);
		const initialModeConfig = created.configOptions?.find(option => option.id === "mode") as
			| { currentValue?: unknown; options?: Array<{ value: string }> }
			| undefined;
		expect(initialModeConfig?.currentValue).toBe("default");
		expect(initialModeConfig?.options?.map(option => option.value)).toEqual(["default", "plan"]);

		await harness.agent.setSessionMode({ sessionId: created.sessionId, modeId: "plan" });

		const session = harness.findSession(created.sessionId)!;
		expect(session.planModeState).toEqual(
			expect.objectContaining({ enabled: true, planFilePath: "local://PLAN.md", workflow: "parallel" }),
		);
		const modeNotifications = harness.updates.filter(
			notification =>
				notification.sessionId === created.sessionId &&
				(notification.update.sessionUpdate === "current_mode_update" ||
					notification.update.sessionUpdate === "config_option_update"),
		);
		expectAcpNotifications(modeNotifications);
		expect(
			modeNotifications.some(
				notification =>
					notification.update.sessionUpdate === "current_mode_update" &&
					notification.update.currentModeId === "plan",
			),
		).toBe(true);
		const configNotification = modeNotifications.findLast(
			notification => notification.update.sessionUpdate === "config_option_update",
		);
		const currentModeConfig =
			configNotification?.update.sessionUpdate === "config_option_update"
				? (configNotification.update.configOptions.find(option => option.id === "mode") as
						| { currentValue?: unknown }
						| undefined)
				: undefined;
		expect(currentModeConfig?.currentValue).toBe("plan");

		// Regression for #1869: entering plan mode must wire a plan-proposal
		// handler so the agent's `xd://propose` write has a gate to dispatch to
		// instead of erroring with no approval path.
		expect(typeof session.planProposalHandler).toBe("function");

		await harness.agent.setSessionMode({ sessionId: created.sessionId, modeId: "default" });
		expect(session.planModeState).toBeUndefined();
		expect(session.planProposalHandler).toBeUndefined();

		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("plan-proposal handler errors when the plan file is missing", async () => {
		const harness = await createHarness();
		Settings.instance.set("plan.enabled", true);

		const created = await harness.agent.newSession({ cwd: harness.cwdA, mcpServers: [] });
		const session = harness.findSession(created.sessionId)!;
		await harness.agent.setSessionMode({ sessionId: created.sessionId, modeId: "plan" });

		const handler = session.planProposalHandler;

		// No plan file written → handler surfaces a ToolError telling the
		// agent to write the plan before requesting approval.
		await expect(handler!("demo")).rejects.toThrow(/Plan file not found/);
		// Plan mode must remain active so the agent can recover.
		expect(session.planModeState?.enabled).toBe(true);
		expect(typeof session.planProposalHandler).toBe("function");

		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("plan-proposal handler approves the agent-named plan and exits plan mode on submit", async () => {
		const harness = await createHarness();
		Settings.instance.set("plan.enabled", true);

		const created = await harness.agent.newSession({ cwd: harness.cwdA, mcpServers: [] });
		const session = harness.findSession(created.sessionId)!;
		await harness.agent.setSessionMode({ sessionId: created.sessionId, modeId: "plan" });

		const localOptions = {
			getArtifactsDir: () => session.sessionManager.getArtifactsDir(),
			getSessionId: () => session.sessionManager.getSessionId(),
		};
		cleanupRoots.push(resolveLocalUrlToPath("local://", localOptions));
		// On Windows, long artifact roots are shortened by the local:// resolver to
		// avoid MAX_PATH. Write through the same resolver the ACP handler reads from.
		const planPath = resolveLocalUrlToPath("local://words-counter-plan.md", localOptions);
		await Bun.write(planPath, "# Words Counter\n\nFile contents.");

		const updatesBefore = harness.updates.length;
		const handler = session.planProposalHandler!;
		const result = (await handler("words-counter")) as {
			content: Array<{ type: string; text: string }>;
			details: { planFilePath: string; title: string; planExists: boolean };
		};

		// Plan-approval payload is shaped for `event-controller` / ACP renderers.
		expect(result.details.title).toBe("words-counter");
		expect(result.details.planFilePath).toBe("local://words-counter-plan.md");
		expect(result.details.planExists).toBe(true);
		expect(result.content[0]?.text).toMatch(/Plan approved/);
		// Plan file keeps its agent-chosen name — no rename.
		expect(await Bun.file(planPath).exists()).toBe(true);
		// Mode + handler are cleared; the agent regains write tools next turn.
		expect(session.planModeState).toBeUndefined();
		expect(session.planProposalHandler).toBeUndefined();
		expect(session.planReferencePath).toBe("local://words-counter-plan.md");
		const approvalUpdates = harness.updates.slice(updatesBefore);
		// Mode-change notifications reached the client so Zed's UI and config
		// selector both reflect the approval-driven exit.
		expect(
			approvalUpdates.some(
				notification =>
					notification.update.sessionUpdate === "current_mode_update" &&
					notification.update.currentModeId === "default",
			),
		).toBe(true);
		const configUpdate = approvalUpdates.find(
			notification => notification.update.sessionUpdate === "config_option_update",
		);
		if (configUpdate?.update.sessionUpdate !== "config_option_update") {
			throw new Error("expected config_option_update after plan approval");
		}
		const modeConfig = configUpdate.update.configOptions.find(option => option.id === "mode") as
			| { currentValue?: unknown }
			| undefined;
		expect(modeConfig?.currentValue).toBe("default");

		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("plan-proposal handler treats dismissed elicitation as refine, never approves", async () => {
		// Regression: when a form-capable
		// ACP client dismissed/cancelled the elicitation, the handler was
		// returning the dismissal as approval — silently granting write
		// access without explicit consent. Dismissal MUST fall through to
		// refine semantics: plan mode stays active, the plan file stays put,
		// and no mode/config updates are emitted.
		const harness = await createHarness({
			elicitationHandler: async () => ({ action: "cancel" }),
		});
		Settings.instance.set("plan.enabled", true);

		const created = await harness.agent.newSession({ cwd: harness.cwdA, mcpServers: [] });
		const session = harness.findSession(created.sessionId)!;
		await harness.agent.setSessionMode({ sessionId: created.sessionId, modeId: "plan" });

		const localOptions = {
			getArtifactsDir: () => session.sessionManager.getArtifactsDir(),
			getSessionId: () => session.sessionManager.getSessionId(),
		};
		cleanupRoots.push(resolveLocalUrlToPath("local://", localOptions));
		const planPath = resolveLocalUrlToPath("local://PLAN.md", localOptions);
		await Bun.write(planPath, "# Words Counter\n\nFile contents.");

		const updatesBefore = harness.updates.length;
		const handler = session.planProposalHandler!;
		const result = (await handler("words-counter")) as { content: Array<{ type: string; text: string }> };

		expect(result.content[0]?.text).toMatch(/refinement requested/i);
		// Plan file stays put; no rename, no write-access grant.
		expect(await Bun.file(planPath).exists()).toBe(true);
		expect(await Bun.file(resolveLocalUrlToPath("local://words-counter.md", localOptions)).exists()).toBe(false);
		// Plan mode + proposal handler stay active so the agent can iterate.
		expect(session.planModeState?.enabled).toBe(true);
		expect(typeof session.planProposalHandler).toBe("function");
		expect(session.planReferencePath).toBeUndefined();
		// No mode-exit notifications were emitted.
		const postDismissUpdates = harness.updates.slice(updatesBefore);
		expect(
			postDismissUpdates.some(
				notification =>
					notification.update.sessionUpdate === "current_mode_update" &&
					notification.update.currentModeId === "default",
			),
		).toBe(false);

		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("pushes config_option_update when thinking level changes internally", async () => {
		// Internal callers (slash commands, model auto-adjust, extension UI) call
		// AgentSession.setThinkingLevel directly without going through the ACP
		// setSessionConfigOption surface. Once the session-lifetime subscription
		// is installed (after the 50ms bootstrap guard so the response has
		// reached the client first), those changes must surface to clients as
		// `config_option_update` so TORTAS-style fleet views stay in sync.
		const harness = await createHarness();
		vi.useFakeTimers();
		const created = await harness.agent.newSession({ cwd: harness.cwdA, mcpServers: [] });
		const session = harness.findSession(created.sessionId)!;
		// Advance past the 50ms bootstrap timer so the lifetime subscription is
		// installed before we drive an internal thinking-level change.
		await advanceBootstrapGuard();

		const updatesBefore = harness.updates.length;
		session.setThinkingLevel("high");

		const pushedAfter = harness.updates.slice(updatesBefore);
		const configUpdates = pushedAfter.filter(
			notification =>
				notification.sessionId === created.sessionId &&
				notification.update.sessionUpdate === "config_option_update",
		);
		expect(configUpdates.length).toBeGreaterThanOrEqual(1);
		expectAcpNotifications(configUpdates);
		const firstUpdate = configUpdates[0]!.update;
		if (firstUpdate.sessionUpdate !== "config_option_update") {
			throw new Error("expected config_option_update");
		}
		const thinkingConfig = firstUpdate.configOptions.find(option => option.id === "thinking") as
			| { currentValue?: unknown }
			| undefined;
		expect(thinkingConfig?.currentValue).toBe("high");

		// Setting to the same level must not produce a redundant notification.
		const updatesBeforeRedundant = harness.updates.length;
		session.setThinkingLevel("high");
		expect(harness.updates.length).toBe(updatesBeforeRedundant);

		vi.useRealTimers();
		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("suppresses lifetime config_option_update during the bootstrap window", async () => {
		// Regression: an extension `session_start`
		// handler calling `setThinkingLevel` must not push a
		// `config_option_update` for a session id the client has not been told
		// about yet (matches Zed's `Received session notification for unknown
		// session` race that `#scheduleBootstrapUpdates` already guards).
		// The fake harness lets us simulate that pre-bootstrap window by
		// driving the change before advancing past the 50ms guard.
		const harness = await createHarness();
		vi.useFakeTimers();
		const created = await harness.agent.newSession({ cwd: harness.cwdA, mcpServers: [] });
		const session = harness.findSession(created.sessionId)!;

		const updatesBefore = harness.updates.length;
		// Synchronously after `newSession` returns, the bootstrap timer has
		// not fired yet, so the lifetime subscription is not installed.
		session.setThinkingLevel("high");

		const beforeBootstrap = harness.updates
			.slice(updatesBefore)
			.filter(
				notification =>
					notification.sessionId === created.sessionId &&
					notification.update.sessionUpdate === "config_option_update",
			);
		expect(beforeBootstrap.length).toBe(0);
		// After advancing through the 50ms bootstrap timer, the subscription is
		// installed and subsequent changes do surface.
		await advanceBootstrapGuard();
		const baseline = harness.updates.length;
		session.setThinkingLevel("medium");
		const afterBootstrap = harness.updates
			.slice(baseline)
			.filter(
				notification =>
					notification.sessionId === created.sessionId &&
					notification.update.sessionUpdate === "config_option_update",
			);
		expect(afterBootstrap.length).toBeGreaterThanOrEqual(1);

		vi.useRealTimers();
		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("emits a single config_option_update per setSessionConfigOption(thinking) call", async () => {
		// Client-initiated thinking changes flow through #setThinkingLevelById,
		// which fires `thinking_level_changed` and lets the lifetime subscription
		// push the notification. The ACP surface must not also push a duplicate
		// `config_option_update` of its own.
		const harness = await createHarness();
		vi.useFakeTimers();
		const created = await harness.agent.newSession({ cwd: harness.cwdA, mcpServers: [] });
		// Wait past the bootstrap guard so the lifetime subscription is
		// installed and the client-driven setSessionConfigOption produces
		// exactly one notification through it.
		await advanceBootstrapGuard();

		const updatesBefore = harness.updates.length;
		const response = await harness.agent.setSessionConfigOption({
			sessionId: created.sessionId,
			configId: "thinking",
			value: "high",
		});

		const configUpdates = harness.updates
			.slice(updatesBefore)
			.filter(
				notification =>
					notification.sessionId === created.sessionId &&
					notification.update.sessionUpdate === "config_option_update",
			);
		expect(configUpdates.length).toBe(1);
		expectAcpNotifications(configUpdates);

		// The response still carries the fresh configOptions tree so the caller
		// gets the new state without relying on the notification.
		const thinkingOption = response.configOptions.find(option => option.id === "thinking") as
			| { currentValue?: unknown }
			| undefined;
		expect(thinkingOption?.currentValue).toBe("high");

		vi.useRealTimers();
		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("pushes config_option_update when the model changes internally", async () => {
		// Internal callers (prewalk hand-offs, retry-fallback, model cycling)
		// change AgentSession's model directly without going through the ACP
		// setSessionConfigOption surface. Once the session-lifetime subscription
		// is installed, those changes must surface to clients as
		// `config_option_update` — otherwise a client's model indicator (e.g.
		// Zed's status bar) goes stale the moment prewalk hands off to a
		// cheaper model mid-session.
		const harness = await createHarness();
		vi.useFakeTimers();
		const created = await harness.agent.newSession({ cwd: harness.cwdA, mcpServers: [] });
		const session = harness.findSession(created.sessionId)!;
		await advanceBootstrapGuard();

		const updatesBefore = harness.updates.length;
		await session.setModel(TEST_MODELS[1]!);

		const pushedAfter = harness.updates.slice(updatesBefore);
		const configUpdates = pushedAfter.filter(
			notification =>
				notification.sessionId === created.sessionId &&
				notification.update.sessionUpdate === "config_option_update",
		);
		expect(configUpdates.length).toBeGreaterThanOrEqual(1);
		expectAcpNotifications(configUpdates);
		const firstUpdate = configUpdates[0]!.update;
		if (firstUpdate.sessionUpdate !== "config_option_update") {
			throw new Error("expected config_option_update");
		}
		const modelConfig = firstUpdate.configOptions.find(option => option.id === "model") as
			| { currentValue?: unknown }
			| undefined;
		expect(modelConfig?.currentValue).toBe(`${TEST_MODELS[1]!.provider}/${TEST_MODELS[1]!.id}`);

		// Setting to the same model must not produce a redundant notification.
		const updatesBeforeRedundant = harness.updates.length;
		await session.setModel(TEST_MODELS[1]!);
		expect(harness.updates.length).toBe(updatesBeforeRedundant);

		vi.useRealTimers();
		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("emits a single config_option_update per setSessionConfigOption(model) call", async () => {
		// Client-initiated model changes flow through #setModelById, which now
		// changes the session model and fires `model_changed`, letting the
		// lifetime subscription push the notification. The ACP surface must not
		// also push a duplicate `config_option_update` of its own.
		const harness = await createHarness();
		vi.useFakeTimers();
		const created = await harness.agent.newSession({ cwd: harness.cwdA, mcpServers: [] });
		await advanceBootstrapGuard();

		const updatesBefore = harness.updates.length;
		const response = await harness.agent.setSessionConfigOption({
			sessionId: created.sessionId,
			configId: "model",
			value: `${TEST_MODELS[1]!.provider}/${TEST_MODELS[1]!.id}`,
		});

		const configUpdates = harness.updates
			.slice(updatesBefore)
			.filter(
				notification =>
					notification.sessionId === created.sessionId &&
					notification.update.sessionUpdate === "config_option_update",
			);
		expect(configUpdates.length).toBe(1);
		expectAcpNotifications(configUpdates);

		const modelOption = response.configOptions.find(option => option.id === "model") as
			| { currentValue?: unknown }
			| undefined;
		expect(modelOption?.currentValue).toBe(`${TEST_MODELS[1]!.provider}/${TEST_MODELS[1]!.id}`);

		vi.useRealTimers();
		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("lists static speech models for ACP mobile voice settings", async () => {
		const harness = await createHarness();
		const voices = TTS_LOCAL_VOICE_OPTIONS.map(({ value, label }) => ({ value, label }));

		const result = await harness.agent.extMethod("speech.models.list", {});

		expect(result).toEqual({
			settings: {
				speechToTextModel: "stt.modelName",
				textToSpeechModel: "tts.localModel",
				textToSpeechVoice: "tts.localVoice",
				speechVoice: "speech.voice",
			},
			defaults: {
				speechToTextModel: DEFAULT_STT_MODEL_KEY,
				textToSpeechModel: DEFAULT_TTS_LOCAL_MODEL_KEY,
				voice: DEFAULT_TTS_VOICE,
			},
			speechToText: {
				setting: "stt.modelName",
				defaultValue: DEFAULT_STT_MODEL_KEY,
				models: STT_MODEL_OPTIONS.map(({ value, label, description }) => ({ value, label, description })),
			},
			textToSpeech: {
				modelSetting: "tts.localModel",
				voiceSetting: "tts.localVoice",
				speechVoiceSetting: "speech.voice",
				defaultModel: DEFAULT_TTS_LOCAL_MODEL_KEY,
				defaultVoice: DEFAULT_TTS_VOICE,
				models: TTS_LOCAL_MODELS.map(({ key, label, description, voices: modelVoices }) => ({
					value: key,
					label,
					description,
					voices: modelVoices.map(({ id, label: voiceLabel }) => ({ value: id, label: voiceLabel })),
				})),
				voices,
			},
		});

		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("accepts OMP extension methods and rejects unknown unprefixed methods", async () => {
		const harness = await createHarness();

		const result = await harness.agent.extMethod("_omp/sessions/listAll", { limit: 2 });

		expect(Array.isArray(result.sessions)).toBe(true);
		expect(typeof result.total).toBe("number");
		await expect(harness.agent.extMethod("omp/sessions/listAll", { limit: 2 })).rejects.toThrow(
			"Unknown ACP ext method",
		);

		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("replays messageIds and returns turn usage for prompts", async () => {
		const harness = await createHarness();
		const stored = new FakeAgentSession(harness.cwdA);
		harness.sessions.push(stored);
		stored.sessionManager.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
		stored.sessionManager.appendMessage(makeAssistantMessage("reply", "reasoning"));
		await stored.sessionManager.ensureOnDisk();
		await stored.sessionManager.flush();

		const loaded = await harness.agent.loadSession({
			sessionId: stored.sessionId,
			cwd: harness.cwdA,
			mcpServers: [],
		});
		expectAcpStructure(zLoadSessionResponse, loaded);
		const replayChunks = harness.updates.filter(
			update =>
				update.sessionId === stored.sessionId &&
				(update.update.sessionUpdate === "user_message_chunk" ||
					update.update.sessionUpdate === "agent_message_chunk" ||
					update.update.sessionUpdate === "agent_thought_chunk"),
		);
		const replayAssistantChunks = replayChunks.filter(
			update =>
				update.update.sessionUpdate === "agent_message_chunk" ||
				update.update.sessionUpdate === "agent_thought_chunk",
		);

		expect(
			replayChunks.every(
				update => typeof getChunkMessageId(update) === "string" && getChunkMessageId(update)!.length > 0,
			),
		).toBe(true);
		expect(new Set(replayAssistantChunks.map(update => getChunkMessageId(update))).size).toBe(1);

		const live = await harness.agent.newSession({ cwd: harness.cwdB, mcpServers: [] });
		const response = await harness.agent.prompt({
			sessionId: live.sessionId,
			prompt: [{ type: "text", text: "ping" }],
		});
		expectAcpStructure(zPromptResponse, response);
		expectAcpNotifications(harness.updates);

		const liveChunks = harness.updates.filter(
			update => update.sessionId === live.sessionId && update.update.sessionUpdate === "agent_message_chunk",
		);
		expect(response.usage).toEqual({
			inputTokens: 10,
			outputTokens: 5,
			cachedReadTokens: 2,
			cachedWriteTokens: 1,
			totalTokens: 18,
		});
		expect(
			liveChunks.some(
				update => typeof getChunkMessageId(update) === "string" && getChunkMessageId(update)!.length > 0,
			),
		).toBe(true);

		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("loads a session stored under a legacy/hashed project directory (#7779)", async () => {
		const harness = await createHarness();
		const stored = new FakeAgentSession(harness.cwdA);
		harness.sessions.push(stored);
		stored.sessionManager.appendMessage({ role: "user", content: "legacy hello", timestamp: Date.now() });
		stored.sessionManager.appendMessage(makeAssistantMessage("legacy reply"));
		await stored.sessionManager.ensureOnDisk();
		await stored.sessionManager.flush();

		const sessionFile = stored.sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("session file not persisted");
		const sessionId = stored.sessionId;
		// Release the writer so the directory can be renamed out from under it.
		await stored.dispose();

		// Simulate the hashed-directory era (#7397, reverted in #7656): the
		// session file lives under a project directory whose name the current
		// cwd->dir scheme would never produce, so the cwd-scoped scan misses it.
		const cwdDerivedDir = path.dirname(sessionFile);
		const sessionsRoot = path.dirname(cwdDerivedDir);
		const hashedDir = path.join(sessionsRoot, `home-cwd-a-${"a".repeat(64)}`);
		await fs.promises.rename(cwdDerivedDir, hashedDir);

		const loaded = await harness.agent.loadSession({
			sessionId,
			cwd: harness.cwdA,
			mcpServers: [],
		});
		expectAcpStructure(zLoadSessionResponse, loaded);

		const replayChunks = harness.updates.filter(
			update =>
				update.sessionId === sessionId &&
				(update.update.sessionUpdate === "user_message_chunk" ||
					update.update.sessionUpdate === "agent_message_chunk"),
		);
		expect(replayChunks.length).toBeGreaterThan(0);

		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("delivers the final visible answer when agent_end overtakes the assistant message_end (#4902)", async () => {
		const harness = await createHarness();
		const created = await harness.agent.newSession({ cwd: harness.cwdA, mcpServers: [] });
		const session = harness.findSession(created.sessionId);
		if (!session) throw new Error("session not registered");

		// Live turn as observed through the prompt subscription when the
		// fire-and-forget assistant message_end handler loses the race against
		// the agent_end flush: thinking streams, then the turn ends. No
		// text_delta and no message_end ever reach this subscriber — the final
		// text exists only on the agent_end payload.
		const assistantMessage = makeAssistantMessage("Final visible answer.", "Considering the greeting.");
		session.prompt = async (text: string): Promise<boolean> => {
			session.promptCalls.push(text);
			session.isStreaming = true;
			for (const listener of session.listeners()) {
				listener({
					type: "message_update",
					message: assistantMessage,
					assistantMessageEvent: { type: "thinking_delta", delta: "Considering the greeting." },
				} as AgentSessionEvent);
			}
			session.sessionManager.appendMessage(assistantMessage);
			for (const listener of session.listeners()) {
				listener({ type: "agent_end", messages: [assistantMessage] } as AgentSessionEvent);
			}
			session.isStreaming = false;
			return true;
		};

		const response = await harness.agent.prompt({
			sessionId: created.sessionId,
			prompt: [{ type: "text", text: "Say hello" }],
		});
		expectAcpStructure(zPromptResponse, response);
		expect(response.stopReason).toBe("end_turn");

		const chunks = harness.updates.filter(update => update.sessionId === created.sessionId);
		const thoughtChunks = chunks.filter(update => update.update.sessionUpdate === "agent_thought_chunk");
		const messageChunks = chunks.filter(update => update.update.sessionUpdate === "agent_message_chunk");
		expect(thoughtChunks).toHaveLength(1);
		// The visible answer must reach the client exactly once even though the
		// assistant message_end never arrived on this subscription.
		expect(messageChunks).toHaveLength(1);
		expect(messageChunks[0]?.update).toEqual(
			expect.objectContaining({
				sessionUpdate: "agent_message_chunk",
				content: { type: "text", text: "Final visible answer." },
			}),
		);
		// Flushed answer belongs to the same live message as the thought chunk.
		expect(getChunkMessageId(messageChunks[0]!)).toBe(getChunkMessageId(thoughtChunks[0]!)!);
		expectAcpNotifications(harness.updates);

		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("does not duplicate the final answer when the assistant message_end arrives before agent_end", async () => {
		// Companion to the #4902 regression: when message_end IS delivered, its
		// fallback emission wins and the agent_end flush must stay silent.
		const harness = await createHarness();
		const created = await harness.agent.newSession({ cwd: harness.cwdA, mcpServers: [] });
		const session = harness.findSession(created.sessionId);
		if (!session) throw new Error("session not registered");

		const assistantMessage = makeAssistantMessage("Composed offline.", "quiet planning");
		session.prompt = async (text: string): Promise<boolean> => {
			session.promptCalls.push(text);
			session.isStreaming = true;
			for (const listener of session.listeners()) {
				listener({
					type: "message_update",
					message: assistantMessage,
					assistantMessageEvent: { type: "thinking_delta", delta: "quiet planning" },
				} as AgentSessionEvent);
			}
			for (const listener of session.listeners()) {
				listener({ type: "message_end", message: assistantMessage } as AgentSessionEvent);
			}
			session.sessionManager.appendMessage(assistantMessage);
			for (const listener of session.listeners()) {
				listener({ type: "agent_end", messages: [assistantMessage] } as AgentSessionEvent);
			}
			session.isStreaming = false;
			return true;
		};

		const response = await harness.agent.prompt({
			sessionId: created.sessionId,
			prompt: [{ type: "text", text: "Say hello" }],
		});
		expectAcpStructure(zPromptResponse, response);

		const messageChunks = harness.updates.filter(
			update => update.sessionId === created.sessionId && update.update.sessionUpdate === "agent_message_chunk",
		);
		expect(messageChunks).toHaveLength(1);
		expect(messageChunks[0]?.update).toEqual(
			expect.objectContaining({
				content: { type: "text", text: "Composed offline." },
			}),
		);
		expectAcpNotifications(harness.updates);

		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("surfaces a provider error that reaches the client only via agent_end", async () => {
		// A request that fails before streaming any assistant events (e.g.
		// GitHub Copilot's HTTP 400 model_not_supported after retries) emits no
		// message_update/message_end — only agent_end carrying an empty
		// assistant message with errorMessage. The client must still see why
		// the turn ended instead of a silent stop.
		const harness = await createHarness();
		const created = await harness.agent.newSession({ cwd: harness.cwdA, mcpServers: [] });
		const session = harness.findSession(created.sessionId);
		if (!session) throw new Error("session not registered");

		const errorText =
			"GitHub Copilot rejected this model (HTTP 400 model_not_supported) after retries. Try again in a few seconds.";
		const failedMessage = {
			...makeAssistantMessage(""),
			stopReason: "error" as const,
			errorMessage: errorText,
		};
		session.prompt = async (text: string): Promise<boolean> => {
			session.promptCalls.push(text);
			session.isStreaming = true;
			session.sessionManager.appendMessage(failedMessage);
			for (const listener of session.listeners()) {
				listener({ type: "agent_end", messages: [failedMessage] } as AgentSessionEvent);
			}
			session.isStreaming = false;
			return true;
		};

		const response = await harness.agent.prompt({
			sessionId: created.sessionId,
			prompt: [{ type: "text", text: "Say hello" }],
		});
		expectAcpStructure(zPromptResponse, response);

		const messageChunks = harness.updates.filter(
			update => update.sessionId === created.sessionId && update.update.sessionUpdate === "agent_message_chunk",
		);
		expect(messageChunks).toHaveLength(1);
		expect(messageChunks[0]?.update).toEqual(expect.objectContaining({ content: { type: "text", text: errorText } }));
		expectAcpNotifications(harness.updates);

		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("does not re-send a streamed error chunk from the agent_end fallback", async () => {
		// When the error DID stream (message_update with an `error` event maps
		// to an agent_message_chunk), the agent_end fallback must stay silent —
		// even though agent_end races the in-flight chunk delivery.
		const harness = await createHarness();
		const created = await harness.agent.newSession({ cwd: harness.cwdA, mcpServers: [] });
		const session = harness.findSession(created.sessionId);
		if (!session) throw new Error("session not registered");

		const errorText = "upstream stream failed";
		const failedMessage = {
			...makeAssistantMessage(""),
			stopReason: "error" as const,
			errorMessage: errorText,
		};
		session.prompt = async (text: string): Promise<boolean> => {
			session.promptCalls.push(text);
			session.isStreaming = true;
			for (const listener of session.listeners()) {
				listener({
					type: "message_update",
					message: failedMessage,
					assistantMessageEvent: { type: "error", error: { errorMessage: errorText } },
				} as AgentSessionEvent);
			}
			session.sessionManager.appendMessage(failedMessage);
			for (const listener of session.listeners()) {
				listener({ type: "agent_end", messages: [failedMessage] } as AgentSessionEvent);
			}
			session.isStreaming = false;
			return true;
		};

		const response = await harness.agent.prompt({
			sessionId: created.sessionId,
			prompt: [{ type: "text", text: "Say hello" }],
		});
		expectAcpStructure(zPromptResponse, response);

		const messageChunks = harness.updates.filter(
			update => update.sessionId === created.sessionId && update.update.sessionUpdate === "agent_message_chunk",
		);
		expect(messageChunks).toHaveLength(1);
		expect(messageChunks[0]?.update).toEqual(expect.objectContaining({ content: { type: "text", text: errorText } }));
		expectAcpNotifications(harness.updates);

		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("replays assistant tool calls and matching results without duplicating the start", async () => {
		const harness = await createHarness();
		const stored = new FakeAgentSession(harness.cwdA);
		harness.sessions.push(stored);
		stored.sessionManager.appendMessage({ role: "user", content: "run tests", timestamp: Date.now() });
		stored.sessionManager.appendMessage({
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "toolu_bash_replay",
					name: "bash",
					arguments: { command: "npm test" },
				},
			],
			api: "anthropic-messages",
			provider: "anthropic",
			model: TEST_MODELS[0].id,
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: Date.now(),
		});
		stored.sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: "toolu_bash_replay",
			toolName: "bash",
			content: [{ type: "text", text: "tests passed" }],
			isError: false,
			timestamp: Date.now(),
		});
		await stored.sessionManager.ensureOnDisk();
		await stored.sessionManager.flush();

		await harness.agent.loadSession({
			sessionId: stored.sessionId,
			cwd: harness.cwdA,
			mcpServers: [],
		});

		const toolUpdates = harness.updates
			.filter(update => update.sessionId === stored.sessionId)
			.map(notification => notification.update)
			.filter(update => "toolCallId" in update && update.toolCallId === "toolu_bash_replay");
		const starts = toolUpdates.filter(update => update.sessionUpdate === "tool_call");
		const completions = toolUpdates.filter(
			update => update.sessionUpdate === "tool_call_update" && update.status === "completed",
		);

		expect(starts).toHaveLength(1);
		expect(starts[0]).toEqual(
			expect.objectContaining({
				sessionUpdate: "tool_call",
				toolCallId: "toolu_bash_replay",
				rawInput: { command: "npm test" },
			}),
		);
		expect("content" in starts[0]!).toBe(false);
		expect(starts.some(update => "rawInput" in update && JSON.stringify(update.rawInput) === "{}")).toBe(false);
		expect(completions).toHaveLength(1);
		expect(completions[0]).toEqual(
			expect.objectContaining({
				content: expect.arrayContaining([{ type: "content", content: { type: "text", text: "tests passed" } }]),
			}),
		);

		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("replays terminal-shaped legacy results as their settled body without terminal frames", async () => {
		const harness = await createHarness();
		await harness.agent.initialize({
			protocolVersion: 1,
			clientCapabilities: { _meta: { terminal_output: true } },
		} as Parameters<typeof harness.agent.initialize>[0]);
		const stored = new FakeAgentSession(harness.cwdA);
		harness.sessions.push(stored);
		stored.sessionManager.appendMessage({ role: "user", content: "run code", timestamp: Date.now() });
		stored.sessionManager.appendMessage({
			...makeAssistantMessage(""),
			content: [
				{
					type: "tool_use",
					id: "toolu_legacy_eval",
					name: "eval",
					input: { language: "py", code: "print('legacy')" },
				},
			] as unknown as Array<{ type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> }>,
			stopReason: "toolUse",
		});
		stored.sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: "toolu_legacy_eval",
			toolName: "eval",
			content: [
				{ type: "text", text: "legacy stdout\n" },
				{ type: "image", data: "aGVsbG8=", mimeType: "image/png" },
			],
			details: { terminalId: "stale-terminal", exitCode: 0, notices: "ignored legacy notice" },
			isError: false,
			timestamp: Date.now(),
		});
		await stored.sessionManager.ensureOnDisk();
		await stored.sessionManager.flush();

		await harness.agent.loadSession({
			sessionId: stored.sessionId,
			cwd: harness.cwdA,
			mcpServers: [],
		});

		const toolUpdates = harness.updates
			.filter(notification => notification.sessionId === stored.sessionId)
			.map(notification => notification.update)
			.filter(update => "toolCallId" in update && update.toolCallId === "toolu_legacy_eval");
		expect(toolUpdates).toEqual([
			{
				sessionUpdate: "tool_call",
				toolCallId: "toolu_legacy_eval",
				title: "[py]",
				kind: "execute",
				status: "pending",
				rawInput: { language: "py", code: "print('legacy')" },
			},
			{
				sessionUpdate: "tool_call_update",
				toolCallId: "toolu_legacy_eval",
				status: "completed",
				content: [
					{ type: "content", content: { type: "text", text: "legacy stdout\n" } },
					{ type: "content", content: { type: "image", data: "aGVsbG8=", mimeType: "image/png" } },
				],
			},
		]);

		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("does not replay internal Hub messages to ACP clients", async () => {
		const harness = await createHarness();
		const stored = new FakeAgentSession(harness.cwdA);
		harness.sessions.push(stored);
		stored.sessionManager.appendMessage({ role: "user", content: "Delegate this task", timestamp: Date.now() });
		stored.sessionManager.appendMessage({
			...makeAssistantMessage(""),
			content: [
				{
					type: "toolCall",
					id: "toolu_hub_replay",
					name: "hub",
					arguments: { op: "send", to: "Scout", message: "Private coordination" },
				},
			],
			stopReason: "toolUse",
		});
		stored.sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: "toolu_hub_replay",
			toolName: "hub",
			content: [{ type: "text", text: "Private reply" }],
			isError: false,
			timestamp: Date.now(),
		});
		await stored.sessionManager.ensureOnDisk();
		await stored.sessionManager.flush();

		await harness.agent.loadSession({
			sessionId: stored.sessionId,
			cwd: harness.cwdA,
			mcpServers: [],
		});

		const hubUpdates = harness.updates
			.filter(update => update.sessionId === stored.sessionId)
			.map(notification => notification.update)
			.filter(update => "toolCallId" in update && update.toolCallId === "toolu_hub_replay");
		expect(hubUpdates).toEqual([]);

		harness.abortController.abort();
	});

	it("preserves tool_use input payloads when replaying assistant tool calls", async () => {
		const harness = await createHarness();
		const stored = new FakeAgentSession(harness.cwdA);
		harness.sessions.push(stored);
		stored.sessionManager.appendMessage({ role: "user", content: "use custom tool", timestamp: Date.now() });
		stored.sessionManager.appendMessage({
			role: "assistant",
			content: [
				{
					type: "tool_use",
					id: "toolu_custom",
					name: "custom_tool",
					input: "raw custom payload",
				},
			] as unknown as Array<{ type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> }>,
			api: "openai-responses",
			provider: "openai",
			model: TEST_MODELS[1].id,
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: Date.now(),
		});
		await stored.sessionManager.ensureOnDisk();
		await stored.sessionManager.flush();

		await harness.agent.loadSession({
			sessionId: stored.sessionId,
			cwd: harness.cwdA,
			mcpServers: [],
		});

		const start = harness.updates
			.filter(update => update.sessionId === stored.sessionId)
			.map(notification => notification.update)
			.find(update => "toolCallId" in update && update.toolCallId === "toolu_custom");

		expect(start).toEqual(
			expect.objectContaining({
				sessionUpdate: "tool_call",
				toolCallId: "toolu_custom",
				rawInput: "raw custom payload",
			}),
		);

		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("marks a dangling replayed tool call failed instead of leaving it pending forever", async () => {
		// Regression test: a process killed after persisting the assistant's
		// tool_use but before its result leaves `toolu_dangling` with a
		// tool_execution_start replay and no matching toolResult message.
		// `keepDanglingToolCalls` is what makes it replay at all (rather than
		// being silently dropped) -- but Zed only clears a Pending tool-call
		// card on cancel/error, never at normal turn end, so leaving it as
		// `pending` spins forever. It must resolve to `failed`.
		const harness = await createHarness();
		const stored = new FakeAgentSession(harness.cwdA);
		harness.sessions.push(stored);
		stored.sessionManager.appendMessage({ role: "user", content: "run something", timestamp: Date.now() });
		stored.sessionManager.appendMessage({
			role: "assistant",
			content: [
				{ type: "tool_use", id: "toolu_dangling", name: "bash", input: { command: "sleep 100" } },
			] as unknown as Array<{ type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> }>,
			api: "openai-responses",
			provider: "openai",
			model: TEST_MODELS[1].id,
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: Date.now(),
		});
		await stored.sessionManager.ensureOnDisk();
		await stored.sessionManager.flush();

		await harness.agent.loadSession({
			sessionId: stored.sessionId,
			cwd: harness.cwdA,
			mcpServers: [],
		});

		const toolUpdates = harness.updates
			.filter(update => update.sessionId === stored.sessionId)
			.map(notification => notification.update)
			.filter(
				(update): update is Extract<typeof update, { toolCallId: string }> =>
					"toolCallId" in update && update.toolCallId === "toolu_dangling",
			);
		expect(toolUpdates.at(-1)).toEqual(expect.objectContaining({ status: "failed" }));
		expect(toolUpdates.some(update => update.sessionUpdate === "tool_call" && update.status === "pending")).toBe(
			true,
		);

		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("settles a dangling legacy tool call as interrupted without a terminal frame", async () => {
		const harness = await createHarness();
		await harness.agent.initialize({
			protocolVersion: 1,
			clientCapabilities: { _meta: { terminal_output: true } },
		} as Parameters<typeof harness.agent.initialize>[0]);
		const stored = new FakeAgentSession(harness.cwdA);
		harness.sessions.push(stored);
		stored.sessionManager.appendMessage({ role: "user", content: "run something", timestamp: Date.now() });
		stored.sessionManager.appendMessage({
			role: "assistant",
			content: [
				{
					type: "tool_use",
					id: "toolu_dangling_meta",
					name: "eval",
					input: { language: "py", code: "print('interrupted')" },
				},
			] as unknown as Array<{ type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> }>,
			api: "openai-responses",
			provider: "openai",
			model: TEST_MODELS[1].id,
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: Date.now(),
		});
		await stored.sessionManager.ensureOnDisk();
		await stored.sessionManager.flush();

		await harness.agent.loadSession({
			sessionId: stored.sessionId,
			cwd: harness.cwdA,
			mcpServers: [],
		});

		const toolUpdates = harness.updates
			.filter(update => update.sessionId === stored.sessionId)
			.map(notification => notification.update)
			.filter(
				(update): update is Extract<typeof update, { toolCallId: string }> =>
					"toolCallId" in update && update.toolCallId === "toolu_dangling_meta",
			);
		expect(toolUpdates).toEqual([
			{
				sessionUpdate: "tool_call",
				toolCallId: "toolu_dangling_meta",
				title: "[py]",
				kind: "execute",
				status: "pending",
				rawInput: { language: "py", code: "print('interrupted')" },
			},
			{
				sessionUpdate: "tool_call_update",
				toolCallId: "toolu_dangling_meta",
				status: "failed",
				content: [
					{
						type: "content",
						content: { type: "text", text: "Interrupted: no result recorded before the process ended." },
					},
				],
			},
		]);

		harness.abortController.abort();
		await Bun.sleep(0);
	});

	/** Compute the notifications `hydrateReplayableToolExecution` + `reduceAcpToolView(phase:'replay')` + `encodeToolFrames` produce directly, for comparison against the wired replay path. */
	function computeDirectHydratedNotifications(
		sessionId: string,
		cwd: string,
		execution: ReplayableToolExecution,
	): Extract<SessionNotification["update"], { toolCallId: string }>[] {
		let state = INITIAL_ACP_TOOL_VIEW;
		const frames = [];
		for (const event of hydrateReplayableToolExecution(execution)) {
			const step = reduceAcpToolView(state, event, {
				phase: "replay",
				terminal: { kind: "none" },
				cwd,
				fence: true,
			});
			state = step.state;
			frames.push(...step.frames);
		}
		return encodeToolFrames(sessionId, frames)
			.map(checked => checkedNotificationPayload(checked).update)
			.filter(
				(update): update is Extract<SessionNotification["update"], { toolCallId: string }> =>
					"toolCallId" in update,
			);
	}

	function appendPresentationCallEntries(
		stored: FakeAgentSession,
		toolCallId: string,
		toolName: string,
		toolInput: Record<string, unknown>,
	): void {
		stored.sessionManager.appendMessage({ role: "user", content: "run marker command", timestamp: Date.now() });
		stored.sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "tool_use", id: toolCallId, name: toolName, input: toolInput }] as unknown as Array<{
				type: "toolCall";
				id: string;
				name: string;
				arguments: Record<string, unknown>;
			}>,
			api: "openai-responses",
			provider: "openai",
			model: TEST_MODELS[1].id,
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: Date.now(),
		});
	}

	it("routes a settled presentation-protocol tool journal entry through the hydration adapter on replay", async () => {
		// Proves the hydration path is genuinely wired, not merely present in
		// code -- the walk must locate the v4 journal pair via
		// `correlateReplayableToolExecution(getBranch(), ...)` and produce exactly
		// what `hydrateReplayableToolExecution` + `reduceAcpToolView(phase:'replay')`
		// + `encodeToolFrames` compute directly for the same execution.
		const harness = await createHarness();
		const stored = new FakeAgentSession(harness.cwdA);
		harness.sessions.push(stored);
		const toolCallId = "toolu_pres_settled_9K2M";
		appendPresentationCallEntries(stored, toolCallId, "bash", { command: "echo MARKER_SETTLE_9K2M" });
		const executionId = toolExecutionId("exec-pres-settled-9K2M");
		stored.sessionManager.appendToolExecutionStarted({
			recordVersion: 1,
			executionId,
			call: { toolCallId, toolName: "bash", title: "run marker", kind: "execute" },
			presentation: { version: 1, facts: [] },
		});
		const outputText = "MARKER_SETTLE_9K2M_OUTPUT_LINE";
		stored.sessionManager.appendToolExecutionSettled({
			recordVersion: 1,
			executionId,
			outcome: { kind: "succeeded" },
			presentation: {
				version: 1,
				stream: {
					streamId: streamId(toolCallId),
					startByte: byteOffset(0),
					endByte: byteOffset(outputText.length),
					text: outputText,
					gaps: [],
				},
				facts: [],
				attachments: [],
			},
			modelProjection: { version: 1, content: [{ type: "text", text: outputText }] },
		});
		// The legacy-shaped `toolResult` message a real agent loop also persists
		// alongside the journal pair; the new path must suppress its own start/
		// settlement, not double-announce.
		stored.sessionManager.appendMessage({
			role: "toolResult",
			toolCallId,
			toolName: "bash",
			content: [{ type: "text", text: outputText }],
			isError: false,
			timestamp: Date.now(),
		});
		await stored.sessionManager.ensureOnDisk();
		await stored.sessionManager.flush();

		await harness.agent.loadSession({ sessionId: stored.sessionId, cwd: harness.cwdA, mcpServers: [] });

		const toolUpdates = harness.updates
			.filter(update => update.sessionId === stored.sessionId)
			.map(notification => notification.update)
			.filter(
				(update): update is Extract<typeof update, { toolCallId: string }> =>
					"toolCallId" in update && update.toolCallId === toolCallId,
			);
		const execution: ReplayableToolExecution = {
			state: "settled",
			call: { toolCallId, toolName: "bash", title: "run marker", kind: "execute" },
			outcome: { kind: "succeeded" },
			presentation: {
				version: 1,
				stream: {
					streamId: streamId(toolCallId),
					startByte: byteOffset(0),
					endByte: byteOffset(outputText.length),
					text: outputText,
					gaps: [],
				},
				facts: [],
				attachments: [],
			},
			modelProjection: { version: 1, content: [{ type: "text", text: outputText }] },
		};
		expect(toolUpdates).toEqual(computeDirectHydratedNotifications(stored.sessionId, harness.cwdA, execution));
		expect(toolUpdates).toEqual([
			expect.objectContaining({ sessionUpdate: "tool_call", toolCallId, status: "pending" }),
			expect.objectContaining({
				sessionUpdate: "tool_call_update",
				toolCallId,
				status: "completed",
				content: [{ type: "content", content: { type: "text", text: `\`\`\`\n${outputText}\n\`\`\`` } }],
			}),
		]);

		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("streams a forked session's message and tool-call history to the client", async () => {
		// New coverage: the existing fork test at ~line 719 only asserts backend
		// session-manager state (`buildSessionContext().messages`). Nothing
		// previously asserted that the ACP client actually receives the copied
		// history over the wire for the FORKED sessionId, mirroring what
		// "replays messageIds and returns turn usage for prompts" asserts for
		// `loadSession`.
		const harness = await createHarness();
		const created = await harness.agent.newSession({ cwd: harness.cwdA, mcpServers: [] });
		const source = harness.findSession(created.sessionId)!;
		source.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "FORKHIST_USER_MARKER_7QX2" }],
			timestamp: Date.now(),
		});
		source.sessionManager.appendMessage(makeAssistantMessage("FORKHIST_ASSISTANT_MARKER_7QX2"));
		await source.sessionManager.ensureOnDisk();
		await source.sessionManager.flush();

		const forked = await harness.agent.unstable_forkSession({
			sessionId: created.sessionId,
			cwd: harness.cwdA,
			mcpServers: [],
		});
		expectAcpStructure(zForkSessionResponse, forked);
		expect(forked.sessionId).not.toBe(created.sessionId);

		// The replay is deferred behind the bootstrap race guard (see
		// `#replayForkedSessionHistory`) because the client cannot have
		// registered this brand-new session id before observing this response.
		await waitForBootstrapGuard();

		const forkedUpdates = harness.updates.filter(update => update.sessionId === forked.sessionId);
		const userChunk = forkedUpdates.find(
			update =>
				update.update.sessionUpdate === "user_message_chunk" &&
				update.update.content.type === "text" &&
				update.update.content.text === "FORKHIST_USER_MARKER_7QX2",
		);
		const assistantChunk = forkedUpdates.find(
			update =>
				update.update.sessionUpdate === "agent_message_chunk" &&
				update.update.content.type === "text" &&
				update.update.content.text === "FORKHIST_ASSISTANT_MARKER_7QX2",
		);
		expect(userChunk).toBeDefined();
		expect(assistantChunk).toBeDefined();

		// The replay must target the FORKED id, never the source -- a misroute
		// here would silently duplicate the source session's history onto its
		// own transcript instead of streaming it to the new one.
		const sourceMarkerLeak = harness.updates.some(
			update =>
				update.sessionId === created.sessionId &&
				update.update.sessionUpdate === "user_message_chunk" &&
				update.update.content.type === "text" &&
				update.update.content.text === "FORKHIST_USER_MARKER_7QX2",
		);
		expect(sourceMarkerLeak).toBe(false);

		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("replays a forked session's v4-journaled tool call through the same hydration adapter as session/load", async () => {
		// (b): a settled presentation_events journal entry must replay through
		// the shared hydration adapter (`hydrateReplayableToolExecution` ->
		// `reduceAcpToolView(phase:'replay')` -> `encodeToolFrames`) on fork,
		// not a second, parallel mechanism -- proven by an exact match against
		// what the same helper computes directly, identical to the loadSession
		// assertion in "routes a settled presentation-protocol tool journal
		// entry through the hydration adapter on replay" above.
		const harness = await createHarness();
		const created = await harness.agent.newSession({ cwd: harness.cwdA, mcpServers: [] });
		const source = harness.findSession(created.sessionId)!;
		const toolCallId = "toolu_fork_pres_settled_5H8N";
		appendPresentationCallEntries(source, toolCallId, "bash", { command: "echo MARKER_FORK_SETTLE_5H8N" });
		const executionId = toolExecutionId("exec-fork-pres-settled-5H8N");
		source.sessionManager.appendToolExecutionStarted({
			recordVersion: 1,
			executionId,
			call: { toolCallId, toolName: "bash", title: "run marker", kind: "execute" },
			presentation: { version: 1, facts: [] },
		});
		const outputText = "MARKER_FORK_SETTLE_5H8N_OUTPUT_LINE";
		source.sessionManager.appendToolExecutionSettled({
			recordVersion: 1,
			executionId,
			outcome: { kind: "succeeded" },
			presentation: {
				version: 1,
				stream: {
					streamId: streamId(toolCallId),
					startByte: byteOffset(0),
					endByte: byteOffset(outputText.length),
					text: outputText,
					gaps: [],
				},
				facts: [],
				attachments: [],
			},
			modelProjection: { version: 1, content: [{ type: "text", text: outputText }] },
		});
		source.sessionManager.appendMessage({
			role: "toolResult",
			toolCallId,
			toolName: "bash",
			content: [{ type: "text", text: outputText }],
			isError: false,
			timestamp: Date.now(),
		});
		await source.sessionManager.ensureOnDisk();
		await source.sessionManager.flush();

		const forked = await harness.agent.unstable_forkSession({
			sessionId: created.sessionId,
			cwd: harness.cwdA,
			mcpServers: [],
		});
		await waitForBootstrapGuard();

		const toolUpdates = harness.updates
			.filter(update => update.sessionId === forked.sessionId)
			.map(notification => notification.update)
			.filter(
				(update): update is Extract<typeof update, { toolCallId: string }> =>
					"toolCallId" in update && update.toolCallId === toolCallId,
			);
		const execution: ReplayableToolExecution = {
			state: "settled",
			call: { toolCallId, toolName: "bash", title: "run marker", kind: "execute" },
			outcome: { kind: "succeeded" },
			presentation: {
				version: 1,
				stream: {
					streamId: streamId(toolCallId),
					startByte: byteOffset(0),
					endByte: byteOffset(outputText.length),
					text: outputText,
					gaps: [],
				},
				facts: [],
				attachments: [],
			},
			modelProjection: { version: 1, content: [{ type: "text", text: outputText }] },
		};
		expect(toolUpdates).toEqual(computeDirectHydratedNotifications(forked.sessionId, harness.cwdA, execution));
		expect(toolUpdates).toEqual([
			expect.objectContaining({ sessionUpdate: "tool_call", toolCallId, status: "pending" }),
			expect.objectContaining({
				sessionUpdate: "tool_call_update",
				toolCallId,
				status: "completed",
				content: [{ type: "content", content: { type: "text", text: `\`\`\`\n${outputText}\n\`\`\`` } }],
			}),
		]);

		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("settles a dangling presentation-protocol tool call as interrupted through the hydration adapter", async () => {
		// An execution whose `tool_execution_started` journal entry has
		// no matching settled counterpart folds to `interrupted` and replays
		// through the same hydration adapter, not the legacy dangling-cleanup
		// synthetic-`failed` loop.
		const harness = await createHarness();
		const stored = new FakeAgentSession(harness.cwdA);
		harness.sessions.push(stored);
		const toolCallId = "toolu_pres_dangling_4M7Q";
		appendPresentationCallEntries(stored, toolCallId, "bash", { command: "sleep 100" });
		const executionId = toolExecutionId("exec-pres-dangling-4M7Q");
		stored.sessionManager.appendToolExecutionStarted({
			recordVersion: 1,
			executionId,
			call: { toolCallId, toolName: "bash", title: "run marker", kind: "execute" },
			presentation: { version: 1, facts: [] },
		});
		await stored.sessionManager.ensureOnDisk();
		await stored.sessionManager.flush();

		await harness.agent.loadSession({ sessionId: stored.sessionId, cwd: harness.cwdA, mcpServers: [] });

		const toolUpdates = harness.updates
			.filter(update => update.sessionId === stored.sessionId)
			.map(notification => notification.update)
			.filter(
				(update): update is Extract<typeof update, { toolCallId: string }> =>
					"toolCallId" in update && update.toolCallId === toolCallId,
			);
		const execution: ReplayableToolExecution = {
			state: "interrupted",
			call: { toolCallId, toolName: "bash", title: "run marker", kind: "execute" },
			reason: "Interrupted: no settlement record was persisted before the process ended.",
			presentation: { version: 1, facts: [] },
		};
		expect(toolUpdates).toEqual(computeDirectHydratedNotifications(stored.sessionId, harness.cwdA, execution));
		// The hydrated interrupted call must resolve on its own -- it must never
		// also be swept into `#replaySessionHistory`'s legacy dangling-cleanup
		// synthetic-`failed` loop (that loop's text differs: "no result recorded",
		// not "no settlement record was persisted").
		expect(
			toolUpdates.some(
				update =>
					update.sessionUpdate === "tool_call_update" &&
					JSON.stringify(update.content ?? []).includes("no result recorded"),
			),
		).toBe(false);
		expect(toolUpdates.at(-1)).toEqual(
			expect.objectContaining({ sessionUpdate: "tool_call_update", status: "failed" }),
		);

		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("replays a mixed legacy_snapshot and presentation-protocol pair from the same session correctly", async () => {
		// A legacy_snapshot call (no journal entry, falls back
		// to the untouched legacy reconstruction) and a presentation_events call
		// (journal entry present, routes through hydration) must coexist in one
		// replay walk without cross-contaminating each other's notifications.
		const harness = await createHarness();
		const stored = new FakeAgentSession(harness.cwdA);
		harness.sessions.push(stored);

		const legacyToolCallId = "toolu_legacy_mix_2P8L";
		stored.sessionManager.appendMessage({ role: "user", content: "run legacy command", timestamp: Date.now() });
		stored.sessionManager.appendMessage({
			role: "assistant",
			content: [
				{ type: "tool_use", id: legacyToolCallId, name: "read", input: { path: "/repo/legacy.txt" } },
			] as unknown as Array<{ type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> }>,
			api: "openai-responses",
			provider: "openai",
			model: TEST_MODELS[1].id,
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: Date.now(),
		});
		const legacyOutputText = "MARKER_LEGACY_2P8L_BODY";
		stored.sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: legacyToolCallId,
			toolName: "read",
			content: [{ type: "text", text: legacyOutputText }],
			isError: false,
			timestamp: Date.now(),
		});

		const presentToolCallId = "toolu_present_mix_6R3W";
		appendPresentationCallEntries(stored, presentToolCallId, "bash", { command: "echo MARKER_MIX_6R3W" });
		const executionId = toolExecutionId("exec-pres-mix-6R3W");
		stored.sessionManager.appendToolExecutionStarted({
			recordVersion: 1,
			executionId,
			call: { toolCallId: presentToolCallId, toolName: "bash", title: "run marker mix", kind: "execute" },
			presentation: { version: 1, facts: [] },
		});
		const presentOutputText = "MARKER_MIX_6R3W_OUTPUT_LINE";
		stored.sessionManager.appendToolExecutionSettled({
			recordVersion: 1,
			executionId,
			outcome: { kind: "succeeded" },
			presentation: {
				version: 1,
				stream: {
					streamId: streamId(presentToolCallId),
					startByte: byteOffset(0),
					endByte: byteOffset(presentOutputText.length),
					text: presentOutputText,
					gaps: [],
				},
				facts: [],
				attachments: [],
			},
			modelProjection: { version: 1, content: [{ type: "text", text: presentOutputText }] },
		});
		stored.sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: presentToolCallId,
			toolName: "bash",
			content: [{ type: "text", text: presentOutputText }],
			isError: false,
			timestamp: Date.now(),
		});
		await stored.sessionManager.ensureOnDisk();
		await stored.sessionManager.flush();

		await harness.agent.loadSession({ sessionId: stored.sessionId, cwd: harness.cwdA, mcpServers: [] });

		const updatesFor = (toolCallId: string) =>
			harness.updates
				.filter(update => update.sessionId === stored.sessionId)
				.map(notification => notification.update)
				.filter(
					(update): update is Extract<typeof update, { toolCallId: string }> =>
						"toolCallId" in update && update.toolCallId === toolCallId,
				);

		// Legacy call: untouched settled-body-only reconstruction.
		expect(updatesFor(legacyToolCallId)).toEqual([
			expect.objectContaining({ sessionUpdate: "tool_call", toolCallId: legacyToolCallId }),
			expect.objectContaining({
				sessionUpdate: "tool_call_update",
				toolCallId: legacyToolCallId,
				status: "completed",
				content: [{ type: "content", content: { type: "text", text: legacyOutputText } }],
			}),
		]);
		// Presentation call: hydrated through the new path, matching the direct
		// pipeline computation, and carrying its own marker rather than the
		// legacy call's.
		const presentExecution: ReplayableToolExecution = {
			state: "settled",
			call: { toolCallId: presentToolCallId, toolName: "bash", title: "run marker mix", kind: "execute" },
			outcome: { kind: "succeeded" },
			presentation: {
				version: 1,
				stream: {
					streamId: streamId(presentToolCallId),
					startByte: byteOffset(0),
					endByte: byteOffset(presentOutputText.length),
					text: presentOutputText,
					gaps: [],
				},
				facts: [],
				attachments: [],
			},
			modelProjection: { version: 1, content: [{ type: "text", text: presentOutputText }] },
		};
		expect(updatesFor(presentToolCallId)).toEqual(
			computeDirectHydratedNotifications(stored.sessionId, harness.cwdA, presentExecution),
		);
		expect(
			updatesFor(presentToolCallId).some(
				update =>
					update.sessionUpdate === "tool_call_update" && JSON.stringify(update.content).includes(legacyOutputText),
			),
		).toBe(false);

		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("replays a fully-journaled recycled toolCallId as two independent executions without rejecting the load", async () => {
		// Regression: a provider recycling a
		// toolCallId across two turns, with BOTH occurrences correctly journaled
		// (distinct executionIds, distinct output), must not carry the first
		// hydrated execution's terminal `settled` reducer state into the second
		// -- that made `reduceStarted` reject the second occurrence as "started
		// twice", which the fail-closed catch turned into a rejected
		// `session/load` for a fully-valid pair.
		const harness = await createHarness();
		const stored = new FakeAgentSession(harness.cwdA);
		harness.sessions.push(stored);
		const recycledId = "toolu_recycled_5K9J";

		appendPresentationCallEntries(stored, recycledId, "bash", { command: "echo RECYCLED_FIRST_5K9J" });
		const firstExecutionId = toolExecutionId("exec-recycled-first-5K9J");
		stored.sessionManager.appendToolExecutionStarted({
			recordVersion: 1,
			executionId: firstExecutionId,
			call: { toolCallId: recycledId, toolName: "bash", title: "run marker recycled first", kind: "execute" },
			presentation: { version: 1, facts: [] },
		});
		const firstOutputText = "RECYCLED_FIRST_OUTPUT_LINE_5K9J";
		stored.sessionManager.appendToolExecutionSettled({
			recordVersion: 1,
			executionId: firstExecutionId,
			outcome: { kind: "succeeded" },
			presentation: {
				version: 1,
				stream: {
					streamId: streamId(recycledId),
					startByte: byteOffset(0),
					endByte: byteOffset(firstOutputText.length),
					text: firstOutputText,
					gaps: [],
				},
				facts: [],
				attachments: [],
			},
			modelProjection: { version: 1, content: [{ type: "text", text: firstOutputText }] },
		});
		stored.sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: recycledId,
			toolName: "bash",
			content: [{ type: "text", text: firstOutputText }],
			isError: false,
			timestamp: Date.now(),
		});

		// Second occurrence: the SAME toolCallId, a fresh journal pair with its
		// own executionId and its own output.
		appendPresentationCallEntries(stored, recycledId, "bash", { command: "echo RECYCLED_SECOND_5K9J" });
		const secondExecutionId = toolExecutionId("exec-recycled-second-5K9J");
		stored.sessionManager.appendToolExecutionStarted({
			recordVersion: 1,
			executionId: secondExecutionId,
			call: { toolCallId: recycledId, toolName: "bash", title: "run marker recycled second", kind: "execute" },
			presentation: { version: 1, facts: [] },
		});
		const secondOutputText = "RECYCLED_SECOND_OUTPUT_LINE_5K9J";
		stored.sessionManager.appendToolExecutionSettled({
			recordVersion: 1,
			executionId: secondExecutionId,
			outcome: { kind: "succeeded" },
			presentation: {
				version: 1,
				stream: {
					streamId: streamId(recycledId),
					startByte: byteOffset(0),
					endByte: byteOffset(secondOutputText.length),
					text: secondOutputText,
					gaps: [],
				},
				facts: [],
				attachments: [],
			},
			modelProjection: { version: 1, content: [{ type: "text", text: secondOutputText }] },
		});
		stored.sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: recycledId,
			toolName: "bash",
			content: [{ type: "text", text: secondOutputText }],
			isError: false,
			timestamp: Date.now(),
		});
		await stored.sessionManager.ensureOnDisk();
		await stored.sessionManager.flush();

		// The load itself must resolve -- a rejection here is exactly the regression this guards.
		await harness.agent.loadSession({ sessionId: stored.sessionId, cwd: harness.cwdA, mcpServers: [] });

		const toolUpdates = harness.updates
			.filter(update => update.sessionId === stored.sessionId)
			.map(notification => notification.update)
			.filter(
				(update): update is Extract<typeof update, { toolCallId: string }> =>
					"toolCallId" in update && update.toolCallId === recycledId,
			);
		expect(toolUpdates).toEqual([
			expect.objectContaining({ sessionUpdate: "tool_call", toolCallId: recycledId, status: "pending" }),
			expect.objectContaining({
				sessionUpdate: "tool_call_update",
				toolCallId: recycledId,
				status: "completed",
				content: [{ type: "content", content: { type: "text", text: `\`\`\`\n${firstOutputText}\n\`\`\`` } }],
			}),
			expect.objectContaining({ sessionUpdate: "tool_call", toolCallId: recycledId, status: "pending" }),
			expect.objectContaining({
				sessionUpdate: "tool_call_update",
				toolCallId: recycledId,
				status: "completed",
				content: [{ type: "content", content: { type: "text", text: `\`\`\`\n${secondOutputText}\n\`\`\`` } }],
			}),
		]);

		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("falls every occurrence of a partially-journaled recycled toolCallId back to legacy replay instead of misattributing the lone record", async () => {
		// Regression: a provider recycling a
		// toolCallId where only the LATER occurrence was journaled must not
		// assign that record to the earlier occurrence -- that erased the
		// earlier call's own real legacy history and rendered the later record's
		// title/output at the earlier call's position. Both occurrences must
		// replay through the untouched legacy path, each with its own body.
		const harness = await createHarness();
		const stored = new FakeAgentSession(harness.cwdA);
		harness.sessions.push(stored);
		const mixedId = "toolu_recycled_mixed_2Q4T";

		// First occurrence: pure legacy_snapshot, no journal entry at all.
		stored.sessionManager.appendMessage({ role: "user", content: "run recycled mixed first", timestamp: Date.now() });
		stored.sessionManager.appendMessage({
			role: "assistant",
			content: [
				{ type: "tool_use", id: mixedId, name: "bash", input: { command: "echo MIXED_FIRST_2Q4T" } },
			] as unknown as Array<{ type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> }>,
			api: "openai-responses",
			provider: "openai",
			model: TEST_MODELS[1].id,
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: Date.now(),
		});
		const firstLegacyBody = "MIXED_FIRST_LEGACY_BODY_2Q4T";
		stored.sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: mixedId,
			toolName: "bash",
			content: [{ type: "text", text: firstLegacyBody }],
			isError: false,
			timestamp: Date.now(),
		});

		// Second occurrence: the SAME toolCallId, this time with a real v4
		// journal pair -- the only journal record for this id on the branch.
		appendPresentationCallEntries(stored, mixedId, "bash", { command: "echo MIXED_SECOND_2Q4T" });
		const secondExecutionId = toolExecutionId("exec-recycled-mixed-second-2Q4T");
		stored.sessionManager.appendToolExecutionStarted({
			recordVersion: 1,
			executionId: secondExecutionId,
			call: { toolCallId: mixedId, toolName: "bash", title: "run marker recycled mixed second", kind: "execute" },
			presentation: { version: 1, facts: [] },
		});
		const secondJournaledOutput = "MIXED_SECOND_JOURNALED_OUTPUT_2Q4T";
		stored.sessionManager.appendToolExecutionSettled({
			recordVersion: 1,
			executionId: secondExecutionId,
			outcome: { kind: "succeeded" },
			presentation: {
				version: 1,
				stream: {
					streamId: streamId(mixedId),
					startByte: byteOffset(0),
					endByte: byteOffset(secondJournaledOutput.length),
					text: secondJournaledOutput,
					gaps: [],
				},
				facts: [],
				attachments: [],
			},
			modelProjection: { version: 1, content: [{ type: "text", text: secondJournaledOutput }] },
		});
		stored.sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: mixedId,
			toolName: "bash",
			content: [{ type: "text", text: secondJournaledOutput }],
			isError: false,
			timestamp: Date.now(),
		});
		await stored.sessionManager.ensureOnDisk();
		await stored.sessionManager.flush();

		await harness.agent.loadSession({ sessionId: stored.sessionId, cwd: harness.cwdA, mcpServers: [] });

		const toolUpdates = harness.updates
			.filter(update => update.sessionId === stored.sessionId)
			.map(notification => notification.update)
			.filter(
				(update): update is Extract<typeof update, { toolCallId: string }> =>
					"toolCallId" in update && update.toolCallId === mixedId,
			);
		// Both occurrences replay via the legacy plain-content shape (unfenced,
		// args-derived title) -- neither ever reaches the hydration adapter.
		expect(toolUpdates).toEqual([
			expect.objectContaining({ sessionUpdate: "tool_call", toolCallId: mixedId, status: "pending" }),
			expect.objectContaining({
				sessionUpdate: "tool_call_update",
				toolCallId: mixedId,
				status: "completed",
				content: [{ type: "content", content: { type: "text", text: firstLegacyBody } }],
			}),
			expect.objectContaining({ sessionUpdate: "tool_call", toolCallId: mixedId, status: "pending" }),
			expect.objectContaining({
				sessionUpdate: "tool_call_update",
				toolCallId: mixedId,
				status: "completed",
				content: [{ type: "content", content: { type: "text", text: secondJournaledOutput } }],
			}),
		]);
		// The earlier occurrence's real body must survive intact -- a regression
		// once erased it by attaching the later record to the earlier position instead.
		expect(JSON.stringify(toolUpdates)).toContain(firstLegacyBody);
		// Neither occurrence is fenced (the hydration adapter's markdown-fence
		// signature) -- proves neither took the hydrated path.
		expect(JSON.stringify(toolUpdates)).not.toContain("```");

		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("settles a recycled toolCallId's dangling second occurrence failed without letting the first occurrence's settlement mask it", async () => {
		// Regression: `ReplayToolCallBookkeeping` used to track `announced`/
		// `resolved` as one Set per id, so a first occurrence's settlement set
		// the id's single `resolved` bit and a later dangling occurrence of the
		// SAME id was invisible to `danglingAnnouncedIds()` -- its card stayed
		// `pending` forever. Bookkeeping must count occurrences instead: the
		// second announcement outnumbering the one resolution is what makes
		// this id dangling, not `resolved.has(id)`.
		const harness = await createHarness();
		const stored = new FakeAgentSession(harness.cwdA);
		harness.sessions.push(stored);
		const recycledId = "toolu_recycled_settled_then_dangling_7N2X";

		// First occurrence: legacy tool_use with a matching toolResult -- settles cleanly.
		stored.sessionManager.appendMessage({ role: "user", content: "run recycled first", timestamp: Date.now() });
		stored.sessionManager.appendMessage({
			role: "assistant",
			content: [
				{ type: "tool_use", id: recycledId, name: "bash", input: { command: "echo RECYCLED_SETTLED_FIRST_7N2X" } },
			] as unknown as Array<{ type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> }>,
			api: "openai-responses",
			provider: "openai",
			model: TEST_MODELS[1].id,
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: Date.now(),
		});
		const firstBody = "RECYCLED_SETTLED_FIRST_BODY_7N2X";
		stored.sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: recycledId,
			toolName: "bash",
			content: [{ type: "text", text: firstBody }],
			isError: false,
			timestamp: Date.now(),
		});

		// Second occurrence: the SAME toolCallId, tool_use persisted but no
		// matching toolResult -- the process died before the result landed.
		stored.sessionManager.appendMessage({ role: "user", content: "run recycled second", timestamp: Date.now() });
		stored.sessionManager.appendMessage({
			role: "assistant",
			content: [
				{ type: "tool_use", id: recycledId, name: "bash", input: { command: "sleep 100" } },
			] as unknown as Array<{ type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> }>,
			api: "openai-responses",
			provider: "openai",
			model: TEST_MODELS[1].id,
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: Date.now(),
		});
		await stored.sessionManager.ensureOnDisk();
		await stored.sessionManager.flush();

		await harness.agent.loadSession({ sessionId: stored.sessionId, cwd: harness.cwdA, mcpServers: [] });

		const toolUpdates = harness.updates
			.filter(update => update.sessionId === stored.sessionId)
			.map(notification => notification.update)
			.filter(
				(update): update is Extract<typeof update, { toolCallId: string }> =>
					"toolCallId" in update && update.toolCallId === recycledId,
			);
		// Two `tool_call` starts (one per occurrence), the first occurrence
		// settling `completed` with its real body, the second's card ending in
		// a synthetic `failed` -- never left `pending`.
		expect(toolUpdates).toEqual([
			expect.objectContaining({ sessionUpdate: "tool_call", toolCallId: recycledId, status: "pending" }),
			expect.objectContaining({
				sessionUpdate: "tool_call_update",
				toolCallId: recycledId,
				status: "completed",
				content: [{ type: "content", content: { type: "text", text: firstBody } }],
			}),
			expect.objectContaining({ sessionUpdate: "tool_call", toolCallId: recycledId, status: "pending" }),
			expect.objectContaining({
				sessionUpdate: "tool_call_update",
				toolCallId: recycledId,
				status: "failed",
				content: [
					{
						type: "content",
						content: { type: "text", text: "Interrupted: no result recorded before the process ended." },
					},
				],
			}),
		]);

		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("does not synthesize a failed update for a dangling internal Hub call", async () => {
		// Regression test: an internal Hub coordination call
		// (`isInternalHubMessageTool`) never gets a `tool_call` notification --
		// the mapper returns `[]` for its start. If a process dies before that
		// call's result is persisted, the dangling-cleanup loop must not
		// synthesize a `tool_call_update` for a `toolCallId` the client was
		// never told about in the first place (an orphan update that would also
		// leak an internal call's existence).
		const harness = await createHarness();
		const stored = new FakeAgentSession(harness.cwdA);
		harness.sessions.push(stored);
		stored.sessionManager.appendMessage({ role: "user", content: "Delegate this task", timestamp: Date.now() });
		stored.sessionManager.appendMessage({
			...makeAssistantMessage(""),
			content: [
				{
					type: "toolCall",
					id: "toolu_hub_dangling",
					name: "hub",
					arguments: { op: "send", to: "Scout", message: "Private coordination" },
				},
			],
			stopReason: "toolUse",
		});
		// No matching toolResult message -- the process died before persisting one.
		await stored.sessionManager.ensureOnDisk();
		await stored.sessionManager.flush();

		await harness.agent.loadSession({
			sessionId: stored.sessionId,
			cwd: harness.cwdA,
			mcpServers: [],
		});

		const hubUpdates = harness.updates
			.filter(update => update.sessionId === stored.sessionId)
			.map(notification => notification.update)
			.filter(update => "toolCallId" in update && update.toolCallId === "toolu_hub_dangling");
		expect(hubUpdates).toEqual([]);

		harness.abortController.abort();
	});

	it("does not synthesize a failed update for a tool call that already resolved", async () => {
		const harness = await createHarness();
		const stored = new FakeAgentSession(harness.cwdA);
		harness.sessions.push(stored);
		stored.sessionManager.appendMessage({ role: "user", content: "read a file", timestamp: Date.now() });
		stored.sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "toolCall", id: "toolu_resolved", name: "read", arguments: { path: "foo.ts" } }],
			api: "openai-responses",
			provider: "openai",
			model: TEST_MODELS[1].id,
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: Date.now(),
		});
		stored.sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: "toolu_resolved",
			toolName: "read",
			content: [{ type: "text", text: "file contents" }],
			isError: false,
			timestamp: Date.now(),
		});
		await stored.sessionManager.ensureOnDisk();
		await stored.sessionManager.flush();

		await harness.agent.loadSession({
			sessionId: stored.sessionId,
			cwd: harness.cwdA,
			mcpServers: [],
		});

		const toolUpdates = harness.updates
			.filter(update => update.sessionId === stored.sessionId)
			.map(notification => notification.update)
			.filter(
				(update): update is Extract<typeof update, { toolCallId: string }> =>
					"toolCallId" in update && update.toolCallId === "toolu_resolved",
			);
		expect(toolUpdates.some(update => "status" in update && update.status === "failed")).toBe(false);

		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("does not replay silent-abort marker as agent_message_chunk to ACP clients", async () => {
		const harness = await createHarness();
		const stored = new FakeAgentSession(harness.cwdA);
		harness.sessions.push(stored);
		stored.sessionManager.appendMessage({ role: "user", content: "start", timestamp: Date.now() });
		// Simulate a silent-abort assistant message: empty content, errorMessage = marker
		stored.sessionManager.appendMessage({
			role: "assistant",
			content: [],
			api: "anthropic-messages",
			provider: "anthropic",
			model: TEST_MODELS[0].id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "aborted",
			errorMessage: SILENT_ABORT_MARKER,
			timestamp: Date.now(),
		});
		await stored.sessionManager.ensureOnDisk();
		await stored.sessionManager.flush();

		await harness.agent.loadSession({
			sessionId: stored.sessionId,
			cwd: harness.cwdA,
			mcpServers: [],
		});
		const replayChunks = harness.updates.filter(
			update => update.sessionId === stored.sessionId && update.update.sessionUpdate === "agent_message_chunk",
		);
		// The silent-abort marker MUST NOT surface as a replayed message chunk
		const markerChunks = replayChunks.filter(
			update =>
				update.update.sessionUpdate === "agent_message_chunk" &&
				update.update.content.type === "text" &&
				update.update.content.text === SILENT_ABORT_MARKER,
		);
		expect(markerChunks).toHaveLength(0);

		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("emits ACP plan updates from live todo results", async () => {
		const harness = await createHarness();
		const created = await harness.agent.newSession({ cwd: harness.cwdA, mcpServers: [] });
		const session = harness.findSession(created.sessionId)!;

		session.prompt = async (text: string): Promise<boolean> => {
			session.promptCalls.push(text);
			session.isStreaming = true;
			for (const listener of session.listeners()) {
				listener({
					type: "tool_execution_end",
					toolCallId: "todo_1",
					toolName: "todo",
					isError: false,
					result: {
						content: [{ type: "text", text: "updated" }],
						details: {
							phases: [
								{
									name: "Work",
									tasks: [
										{ content: "Fix bug", status: "in_progress" },
										{ content: "Run tests", status: "completed" },
									],
								},
							],
						},
					},
				} as AgentSessionEvent);
				listener({
					type: "tool_execution_end",
					toolCallId: "todo_empty",
					toolName: "todo",
					isError: false,
					result: {
						content: [{ type: "text", text: "cleared" }],
						details: { phases: [] },
					},
				} as AgentSessionEvent);
				listener({ type: "agent_end", messages: [] } as AgentSessionEvent);
			}
			session.isStreaming = false;
			return true;
		};

		await harness.agent.prompt({
			sessionId: created.sessionId,
			messageId: "00000000-0000-4000-8000-000000000047",
			prompt: [{ type: "text", text: "write todos" }],
		} as PromptRequest);

		expect(harness.updates.map(update => update.update)).toContainEqual({
			sessionUpdate: "plan",
			entries: [
				{ content: "Fix bug", priority: "medium", status: "in_progress" },
				{ content: "Run tests", priority: "medium", status: "completed" },
			],
		});
		expect(harness.updates.map(update => update.update)).toContainEqual({ sessionUpdate: "plan", entries: [] });
		expectAcpNotifications(harness.updates);

		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("settles a replayed todo call before replaying its plan update", async () => {
		const harness = await createHarness();
		const stored = new FakeAgentSession(harness.cwdA);
		harness.sessions.push(stored);
		stored.sessionManager.appendMessage({
			...makeAssistantMessage(""),
			content: [{ type: "toolCall", id: "todo_replay", name: "todo", arguments: {} }],
			stopReason: "toolUse",
		});
		stored.sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: "todo_replay",
			toolName: "todo",
			content: [{ type: "text", text: "updated" }],
			details: {
				phases: [{ name: "Replay", tasks: [{ content: "Restore plan", status: "pending" }] }],
			},
			isError: false,
			timestamp: Date.now(),
		});
		await stored.sessionManager.ensureOnDisk();
		await stored.sessionManager.flush();

		await harness.agent.loadSession({
			sessionId: stored.sessionId,
			cwd: harness.cwdA,
			mcpServers: [],
		});

		const replayUpdates = harness.updates
			.filter(notification => notification.sessionId === stored.sessionId)
			.map(notification => notification.update)
			.filter(
				update =>
					("toolCallId" in update && update.toolCallId === "todo_replay") || update.sessionUpdate === "plan",
			);
		expect(replayUpdates).toEqual([
			{
				sessionUpdate: "tool_call",
				toolCallId: "todo_replay",
				title: "todo",
				kind: "think",
				status: "pending",
				rawInput: {},
			},
			{
				sessionUpdate: "tool_call_update",
				toolCallId: "todo_replay",
				status: "completed",
				content: [{ type: "content", content: { type: "text", text: "updated" } }],
			},
			{
				sessionUpdate: "plan",
				entries: [{ content: "Restore plan", priority: "medium", status: "pending" }],
			},
		]);
		expectAcpNotifications(harness.updates);

		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("refreshes task agent descriptions on ACP /reload-plugins", async () => {
		const harness = await createHarness();
		const agentDir = path.join(harness.cwdA, ".omp", "agents");
		const agentFile = path.join(agentDir, "acp-reload-agent.md");
		await fs.promises.mkdir(agentDir, { recursive: true });
		await fs.promises.writeFile(
			agentFile,
			"---\nname: acp-reload-agent\ndescription: VERSION_ONE\n---\nACP reload agent.\n",
		);
		const taskTool = await TaskTool.create(createTaskSession(harness.cwdA));
		expect(taskTool.description).toContain("VERSION_ONE");
		const created = await harness.agent.newSession({ cwd: harness.cwdA, mcpServers: [] });

		await fs.promises.writeFile(
			agentFile,
			"---\nname: acp-reload-agent\ndescription: VERSION_TWO\n---\nACP reload agent.\n",
		);
		await harness.agent.prompt({
			sessionId: created.sessionId,
			messageId: "00000000-0000-4000-8000-000000000006",
			prompt: [{ type: "text", text: "/reload-plugins" }],
		} as PromptRequest);

		expect(taskTool.description).toContain("VERSION_TWO");
		expect(taskTool.description).not.toContain("VERSION_ONE");
		harness.abortController.abort();
	});

	it("advertises ACP-safe builtins and skill commands", async () => {
		const harness = await createHarness();
		const created = await harness.agent.newSession({ cwd: harness.cwdA, mcpServers: [] });
		const session = harness.findSession(created.sessionId)!;
		const skillDir = path.join(harness.cwdA, ".skills", "sample");
		const skillPath = path.join(skillDir, "SKILL.md");
		await fs.promises.mkdir(skillDir, { recursive: true });
		await fs.promises.writeFile(skillPath, "---\ndescription: Sample skill\n---\n# Sample\nDo work.\n");
		session.skills = [
			{
				name: "sample",
				description: "Sample skill",
				filePath: skillPath,
				baseDir: skillDir,
				source: "test",
			},
		];
		await harness.agent.prompt({
			sessionId: created.sessionId,
			messageId: "00000000-0000-4000-8000-000000000004",
			prompt: [{ type: "text", text: "/reload-plugins" }],
		} as PromptRequest);

		const commandUpdates = harness.updates.filter(
			update =>
				update.sessionId === created.sessionId && update.update.sessionUpdate === "available_commands_update",
		);
		const names = commandUpdates.flatMap(update =>
			update.update.sessionUpdate === "available_commands_update"
				? update.update.availableCommands.map(command => command.name)
				: [],
		);
		expect(names).toContain("fast");
		expect(names).toContain("retry");
		expect(names).toContain("force");
		expect(names).toContain("skill:sample");
		expect(names).not.toContain("settings");
		expect(names).not.toContain("copy");
		expect(names).not.toContain("plan");
		expect(names).not.toContain("loop");
		expect(names).not.toContain("login");
		expect(names).not.toContain("new");
		expect(names).toContain("handoff");
		expect(names).not.toContain("fork");
		expect(names).not.toContain("btw");
		expect(names).not.toContain("drop");
		expect(names).not.toContain("resume");
		expect(names).not.toContain("agents");
		expect(names).not.toContain("extensions");
		expect(names).not.toContain("hotkeys");

		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("includes extension-registered commands in available_commands_update and excludes ACP-builtin collisions", async () => {
		const harness = await createHarness();
		const created = await harness.agent.newSession({ cwd: harness.cwdA, mcpServers: [] });
		const session = harness.findSession(created.sessionId)!;

		// Extension command colliding with a custom TS command; extension wins (dispatch order).
		(session as unknown as { customCommands: unknown[] }).customCommands = [
			{ command: { name: "my-ext-cmd", description: "Custom TS version" } },
		];
		// Extension runner: unique command + one colliding with an ACP builtin
		// ("fast") + a colon-namespaced one whose prefix is a builtin
		// ("model:foo" parses as builtin `/model` with args `foo` at dispatch).
		(session as unknown as { extensionRunner: unknown }).extensionRunner = {
			getRegisteredCommands(reserved?: Set<string>) {
				return [
					{ name: "my-ext-cmd", description: "Extension command", handler: async () => {} },
					{ name: "fast", description: "Would shadow builtin", handler: async () => {} },
					{ name: "model:foo", description: "Colon-shadowed by /model", handler: async () => {} },
				].filter(cmd => !reserved?.has(cmd.name));
			},
		};

		// Drive a deterministic re-advertisement instead of sleeping through
		// the bootstrap timer: under full-suite load the 50ms guard plus the
		// awaited slash-command scan can outlive the fixed wait, leaving zero
		// command updates observed (#flake). `/reload-plugins` awaits the
		// refresh and emits an advertisement that includes the stubs above.
		await harness.agent.prompt({
			sessionId: created.sessionId,
			messageId: "00000000-0000-4000-8000-000000000005",
			prompt: [{ type: "text", text: "/reload-plugins" }],
		} as PromptRequest);

		const commandUpdates = harness.updates.filter(
			update =>
				update.sessionId === created.sessionId && update.update.sessionUpdate === "available_commands_update",
		);
		// Each update is a complete advertisement; assert on the latest one
		// (the bootstrap update may or may not have landed by now).
		const lastUpdate = commandUpdates.at(-1);
		const allCommands =
			lastUpdate?.update.sessionUpdate === "available_commands_update" ? lastUpdate.update.availableCommands : [];
		const names = allCommands.map(c => c.name);

		// Extension command must surface.
		expect(names).toContain("my-ext-cmd");
		// Extension wins the name collision: advertised description is the extension's, not the custom TS one.
		const extCmdEntry = allCommands.find(c => c.name === "my-ext-cmd");
		expect(extCmdEntry?.description).toBe("Extension command");
		// ACP builtin "fast" appears exactly once (reserved-set exclusion, no duplicate from extension).
		expect(names.filter(n => n === "fast").length).toBe(1);
		// Colon-namespaced collision with a builtin prefix is not advertised:
		// ACP would dispatch `/model:foo` to the `/model` builtin, not the extension.
		expect(names).not.toContain("model:foo");

		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("executes skill commands through custom skill messages", async () => {
		const harness = await createHarness();
		const created = await harness.agent.newSession({ cwd: harness.cwdA, mcpServers: [] });
		const session = harness.findSession(created.sessionId);
		if (!session) throw new Error("expected ACP session to exist after newSession");
		const skillDir = path.join(harness.cwdA, ".skills", "sample");
		const skillPath = path.join(skillDir, "SKILL.md");
		await fs.promises.mkdir(skillDir, { recursive: true });
		await fs.promises.writeFile(skillPath, "---\ndescription: Sample skill\n---\n# Sample\nDo work.\n");
		session.skills = [
			{
				name: "sample",
				description: "Sample skill",
				filePath: skillPath,
				baseDir: skillDir,
				source: "test",
			},
		];

		await harness.agent.prompt({
			sessionId: created.sessionId,
			messageId: "00000000-0000-4000-8000-000000000001",
			prompt: [{ type: "text", text: "/skill:sample extra context" }],
		} as PromptRequest);

		expect(session.promptCalls).toEqual([]);
		expect(session.customMessages).toHaveLength(1);
		const customMessage = session.customMessages[0];
		if (!customMessage) throw new Error("expected ACP skill prompt custom message");
		expect(customMessage.customType).toBe("skill-prompt");
		expect(customMessage.content).toContain("# Sample\nDo work.");
		expect(customMessage.content).toContain(`[Skill directory: ${skillDir}]`);
		expect(customMessage.content).toContain("User: extra context");
		expect(session.customMessageOptions[0]).toEqual({ streamingBehavior: "steer" });

		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("auto-cancels an in-progress turn and queues a new prompt when called mid-flight", async () => {
		const harness = await createHarness();
		const created = await harness.agent.newSession({ cwd: harness.cwdA, mcpServers: [] });
		const session = harness.findSession(created.sessionId)!;

		// Block abort() until released so we can assert the second prompt waits
		let releaseAbort!: () => void;
		const abortStarted = Promise.withResolvers<void>();
		const abortRelease = new Promise<void>(resolve => {
			releaseAbort = resolve;
		});
		session.abort = async () => {
			session.isStreaming = false;
			abortStarted.resolve();
			await abortRelease;
		};

		const blockers: Array<() => void> = [];
		session.prompt = async (text: string): Promise<boolean> => {
			session.promptCalls.push(text);
			session.isStreaming = true;
			const { promise, resolve } = Promise.withResolvers<void>();
			blockers.push(resolve);
			await promise;
			const assistantMessage = makeAssistantMessage("pong");
			session.sessionManager.appendMessage(assistantMessage);
			for (const listener of session.listeners()) {
				listener({ type: "agent_end", messages: [assistantMessage] } as AgentSessionEvent);
			}
			session.isStreaming = false;
			return true;
		};

		const firstPrompt = harness.agent.prompt({
			sessionId: created.sessionId,
			messageId: "00000000-0000-4000-8000-000000000035",
			prompt: [{ type: "text", text: "long running" }],
		} as PromptRequest);
		await Bun.sleep(0);
		expect(session.promptCalls).toEqual(["long running"]);

		// Second prompt arrives mid-flight — must auto-cancel first, then queue
		const secondPrompt = harness.agent.prompt({
			sessionId: created.sessionId,
			messageId: "00000000-0000-4000-8000-000000000036",
			prompt: [{ type: "text", text: "overlap" }],
		} as PromptRequest);

		// First resolves immediately as cancelled
		const firstResponse = await firstPrompt;
		expect(firstResponse.stopReason).toBe("cancelled");

		// abort() must have been called as part of cancel cleanup
		await abortStarted.promise;

		// Second prompt must NOT start until abort cleanup completes
		await Bun.sleep(0);
		expect(session.promptCalls).toEqual(["long running"]);

		// Release abort — second session.prompt should now start
		releaseAbort();
		await Bun.sleep(0);
		expect(session.promptCalls).toEqual(["long running", "overlap"]);

		// Unblock both session.prompt calls (first is fire-and-forget, second drives the response)
		for (const resolve of blockers) resolve();
		const secondResponse = await secondPrompt;
		expect(secondResponse.stopReason).toBe("end_turn");

		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("closes the ACP session when implicit cancel cleanup times out", async () => {
		const harness = await createHarness();
		const created = await harness.agent.newSession({ cwd: harness.cwdA, mcpServers: [] });
		const session = harness.findSession(created.sessionId)!;
		harness.agent.setCancelCleanupTimeoutForTesting(10);
		session.abort = async () => new Promise<void>(() => undefined);
		const finishPrompt = holdPromptStreaming(session);

		const firstPrompt = harness.agent.prompt({
			sessionId: created.sessionId,
			messageId: "00000000-0000-4000-8000-000000000045",
			prompt: [{ type: "text", text: "long running" }],
		} as PromptRequest);
		await Bun.sleep(0);

		// Overlapping prompt triggers the implicit cancel; abort() never resolves,
		// so cleanup times out, the queued prompt fails, and the session is closed.
		const secondPrompt = harness.agent
			.prompt({
				sessionId: created.sessionId,
				messageId: "00000000-0000-4000-8000-000000000046",
				prompt: [{ type: "text", text: "overlap" }],
			} as PromptRequest)
			.catch(error => error);

		const firstResponse = await firstPrompt;
		expect(firstResponse.stopReason).toBe("cancelled");

		const queuedError = await secondPrompt;
		expect(queuedError).toBeInstanceOf(Error);
		expect((queuedError as Error).message).toBe("ACP cancel cleanup timed out");

		// The fire-and-forget close runs off the same cleanup rejection; give it a
		// few ticks to settle before asserting.
		for (let i = 0; i < 20 && !session.disposed; i++) {
			await Bun.sleep(0);
		}
		expect(session.disposed).toBe(true);
		await expect(
			harness.agent.prompt({
				sessionId: created.sessionId,
				messageId: "00000000-0000-4000-8000-000000000047",
				prompt: [{ type: "text", text: "after stuck implicit cancel" }],
			} as PromptRequest),
		).rejects.toThrow("Unsupported ACP session");

		finishPrompt();
		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("waits for AgentSession idle cleanup after agent_end before returning", async () => {
		const harness = await createHarness();
		const created = await harness.agent.newSession({ cwd: harness.cwdA, mcpServers: [] });
		const session = harness.findSession(created.sessionId)!;
		const { promise: idleBlocked, resolve: markIdleBlocked } = Promise.withResolvers<void>();
		const { promise: releaseIdle, resolve: unblockIdle } = Promise.withResolvers<void>();
		session.waitForIdleBlocker = async () => {
			markIdleBlocked();
			await releaseIdle;
		};

		const firstPrompt = harness.agent.prompt({
			sessionId: created.sessionId,
			prompt: [{ type: "text", text: "wait for cleanup" }],
		});
		await idleBlocked;

		try {
			const returnedBeforeIdle = await Promise.race([firstPrompt.then(() => true), Bun.sleep(0).then(() => false)]);
			expect(returnedBeforeIdle).toBe(false);
			expect(session.waitForIdleCalls).toBe(1);

			unblockIdle();
			await firstPrompt;
		} finally {
			unblockIdle();
			harness.abortController.abort();
			await Bun.sleep(0);
		}
	});

	it("streams the retried turn inside the /retry prompt turn", async () => {
		const harness = await createHarness();
		const created = await harness.agent.newSession({ cwd: harness.cwdA, mcpServers: [] });
		const session = harness.findSession(created.sessionId)!;
		session.retryResult = true;

		let emitted = false;
		session.waitForIdleBlocker = async () => {
			// One-shot: `#waitForAcpPromptIdle` calls `session.waitForIdle()` again
			// while handling the retried turn's own `agent_end`, so an unguarded
			// blocker would re-enter and recurse forever.
			if (emitted) return;
			emitted = true;
			const assistantMessage = makeAssistantMessage("Recovered answer.");
			for (const listener of session.listeners()) {
				listener({
					type: "message_update",
					message: assistantMessage,
					assistantMessageEvent: { type: "text_delta", delta: "Recovered answer." },
				} as AgentSessionEvent);
			}
			session.sessionManager.appendMessage(assistantMessage);
			for (const listener of session.listeners()) {
				listener({ type: "agent_end", messages: [assistantMessage] } as AgentSessionEvent);
			}
		};

		const response = await harness.agent.prompt({
			sessionId: created.sessionId,
			prompt: [{ type: "text", text: "/retry" }],
		});

		expect(response.stopReason).toBe("end_turn");
		expect(session.retryCalls).toBe(1);

		const chunkTexts = harness.updates
			.filter(
				update =>
					update.sessionId === created.sessionId &&
					update.update.sessionUpdate === "agent_message_chunk" &&
					update.update.content.type === "text",
			)
			.map(update => (update.update as { content: { type: "text"; text: string } }).content.text);
		expect(chunkTexts).toEqual(["Retrying the last failed turn.", "Recovered answer."]);

		expect(session.waitForIdleCalls).toBeGreaterThanOrEqual(1);
		expectAcpNotifications(harness.updates);

		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("drains in-flight ACP event handlers before closing a /retry turn with no agent_end", async () => {
		// `AgentSession.#emit()` does not await listeners, so a retried turn's
		// update can still be in delivery once the session reports idle. When the
		// scheduled continuation never emits `agent_end` (e.g. a generation
		// mismatch skips it), `#runPromptOrCommand`'s trailing `#finishPrompt` is
		// what closes the turn — so the turn-holding hook must drain
		// `record.promptEventHandlers` first or the response overtakes its chunk.
		const deliveryBlocked = Promise.withResolvers<void>();
		const deliveryRelease = Promise.withResolvers<void>();
		let held = false;
		const harness = await createHarness({
			sessionUpdateHook: async notification => {
				if (
					held ||
					notification.update.sessionUpdate !== "agent_message_chunk" ||
					notification.update.content.type !== "text" ||
					notification.update.content.text !== "Recovered answer."
				) {
					return;
				}
				held = true;
				deliveryBlocked.resolve();
				await deliveryRelease.promise;
			},
		});
		const created = await harness.agent.newSession({ cwd: harness.cwdA, mcpServers: [] });
		const session = harness.findSession(created.sessionId)!;
		session.retryResult = true;

		let emitted = false;
		session.waitForIdleBlocker = async () => {
			if (emitted) return;
			emitted = true;
			// Deliberately no `agent_end`: this exercises the trailing-finishPrompt
			// path rather than the `#handlePromptEvent` one.
			const assistantMessage = makeAssistantMessage("Recovered answer.");
			for (const listener of session.listeners()) {
				listener({
					type: "message_update",
					message: assistantMessage,
					assistantMessageEvent: { type: "text_delta", delta: "Recovered answer." },
				} as AgentSessionEvent);
			}
		};

		const prompt = harness.agent.prompt({
			sessionId: created.sessionId,
			prompt: [{ type: "text", text: "/retry" }],
		});
		await deliveryBlocked.promise;

		try {
			const resolvedEarly = await Promise.race([prompt.then(() => true), Bun.sleep(0).then(() => false)]);
			expect(resolvedEarly).toBe(false);

			deliveryRelease.resolve();
			const response = await prompt;
			expect(response.stopReason).toBe("end_turn");
			expect(
				harness.updates.some(
					update =>
						update.update.sessionUpdate === "agent_message_chunk" &&
						update.update.content.type === "text" &&
						update.update.content.text === "Recovered answer.",
				),
			).toBe(true);
		} finally {
			deliveryRelease.resolve();
			harness.abortController.abort();
			await Bun.sleep(0);
		}
	});

	it("drains async job deliveries before completing the ACP prompt", async () => {
		const harness = await createHarness();
		const created = await harness.agent.newSession({ cwd: harness.cwdA, mcpServers: [] });
		const session = harness.findSession(created.sessionId)!;
		let releaseDelivery!: () => void;
		let drainCalls = 0;
		const deliveryBlocked = Promise.withResolvers<void>();
		const deliveryRelease = new Promise<void>(resolve => {
			releaseDelivery = resolve;
		});
		session.asyncJobDrain = async () => {
			drainCalls++;
			if (drainCalls > 1) return false;
			deliveryBlocked.resolve();
			await deliveryRelease;
			return true;
		};

		const prompt = harness.agent.prompt({
			sessionId: created.sessionId,
			prompt: [{ type: "text", text: "wait for async delivery" }],
		});
		await deliveryBlocked.promise;

		try {
			const returnedBeforeDelivery = await Promise.race([prompt.then(() => true), Bun.sleep(0).then(() => false)]);
			expect(returnedBeforeDelivery).toBe(false);
			expect(session.waitForIdleCalls).toBe(1);

			releaseDelivery();
			await prompt;
			expect(session.waitForIdleCalls).toBe(2);
			expect(drainCalls).toBe(2);
		} finally {
			releaseDelivery();
			harness.abortController.abort();
			await Bun.sleep(0);
		}
	});

	it("keeps async delivery follow-up updates inside the owning ACP prompt", async () => {
		const harness = await createHarness();
		const created = await harness.agent.newSession({ cwd: harness.cwdA, mcpServers: [] });
		const session = harness.findSession(created.sessionId)!;
		let delivered = false;
		let drainCalls = 0;
		session.asyncJobDrain = async () => {
			drainCalls++;
			if (delivered) return false;
			delivered = true;
			const assistantMessage = makeAssistantMessage("async continuation");
			for (const listener of session.listeners()) {
				listener({
					type: "message_update",
					message: assistantMessage,
					assistantMessageEvent: { type: "text_delta", delta: "async continuation" },
				} as AgentSessionEvent);
			}
			return true;
		};

		await harness.agent.prompt({
			sessionId: created.sessionId,
			messageId: "00000000-0000-4000-8000-000000000048",
			prompt: [{ type: "text", text: "deliver async follow-up" }],
		} as PromptRequest);

		expect(harness.updates.some(notification => JSON.stringify(notification).includes("async continuation"))).toBe(
			true,
		);
		expect(session.waitForIdleCalls).toBe(2);
		expect(drainCalls).toBe(2);
		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("queues next prompt until AgentSession idle cleanup completes", async () => {
		const harness = await createHarness();
		const created = await harness.agent.newSession({ cwd: harness.cwdA, mcpServers: [] });
		const session = harness.findSession(created.sessionId)!;
		const { promise: idleBlocked, resolve: markIdleBlocked } = Promise.withResolvers<void>();
		const { promise: releaseIdle, resolve: unblockIdle } = Promise.withResolvers<void>();
		session.waitForIdleBlocker = async () => {
			markIdleBlocked();
			await releaseIdle;
		};

		const firstPrompt = harness.agent.prompt({
			sessionId: created.sessionId,
			messageId: "00000000-0000-4000-8000-000000000030",
			prompt: [{ type: "text", text: "wait for cleanup" }],
		} as PromptRequest);
		await idleBlocked;

		try {
			const secondPrompt = harness.agent.prompt({
				sessionId: created.sessionId,
				messageId: "00000000-0000-4000-8000-000000000031",
				prompt: [{ type: "text", text: "after cleanup" }],
			} as PromptRequest);
			await Bun.sleep(0);
			expect(session.promptCalls).toEqual(["wait for cleanup"]);

			unblockIdle();
			await firstPrompt;
			await secondPrompt;
			expect(session.promptCalls).toEqual(["wait for cleanup", "after cleanup"]);
		} finally {
			unblockIdle();
			harness.abortController.abort();
			await Bun.sleep(0);
		}
	});

	it("serializes multiple prompts queued during idle cleanup", async () => {
		const harness = await createHarness();
		const created = await harness.agent.newSession({ cwd: harness.cwdA, mcpServers: [] });
		const session = harness.findSession(created.sessionId)!;
		const { promise: idleBlocked, resolve: markIdleBlocked } = Promise.withResolvers<void>();
		const { promise: releaseIdle, resolve: unblockIdle } = Promise.withResolvers<void>();
		session.waitForIdleBlocker = async () => {
			markIdleBlocked();
			await releaseIdle;
		};

		const firstPrompt = harness.agent.prompt({
			sessionId: created.sessionId,
			messageId: "00000000-0000-4000-8000-000000000032",
			prompt: [{ type: "text", text: "wait for cleanup" }],
		} as PromptRequest);
		await idleBlocked;

		try {
			const secondPrompt = harness.agent.prompt({
				sessionId: created.sessionId,
				messageId: "00000000-0000-4000-8000-000000000033",
				prompt: [{ type: "text", text: "after cleanup A" }],
			} as PromptRequest);
			const thirdPrompt = harness.agent.prompt({
				sessionId: created.sessionId,
				messageId: "00000000-0000-4000-8000-000000000034",
				prompt: [{ type: "text", text: "after cleanup B" }],
			} as PromptRequest);
			await Bun.sleep(0);
			expect(session.promptCalls).toEqual(["wait for cleanup"]);

			unblockIdle();
			await firstPrompt;
			await secondPrompt;
			await thirdPrompt;
			expect(session.promptCalls).toEqual(["wait for cleanup", "after cleanup A", "after cleanup B"]);
		} finally {
			unblockIdle();
			harness.abortController.abort();
			await Bun.sleep(0);
		}
	});

	it("suppresses late updates after cancel and waits cleanup before the next prompt", async () => {
		const harness = await createHarness();
		const created = await harness.agent.newSession({ cwd: harness.cwdA, mcpServers: [] });
		const session = harness.findSession(created.sessionId)!;
		let releaseAbort!: () => void;
		const abortBlocked = Promise.withResolvers<void>();
		const releaseAbortPromise = new Promise<void>(resolve => {
			releaseAbort = resolve;
		});
		session.abort = async () => {
			session.isStreaming = false;
			abortBlocked.resolve();
			await releaseAbortPromise;
		};
		const finishPrompt = holdPromptStreaming(session);

		const firstPrompt = harness.agent.prompt({
			sessionId: created.sessionId,
			messageId: "00000000-0000-4000-8000-000000000039",
			prompt: [{ type: "text", text: "cancel me" }],
		} as PromptRequest);
		await Bun.sleep(0);
		const beforeCancelUpdates = harness.updates.length;

		const cancelPrompt = harness.agent.cancel({ sessionId: created.sessionId });
		await abortBlocked.promise;
		const returnedBeforeCleanup = await Promise.race([firstPrompt.then(() => true), Bun.sleep(0).then(() => false)]);
		expect(returnedBeforeCleanup).toBe(true);
		const cancelledResponse = await firstPrompt;
		expect(cancelledResponse.stopReason).toBe("cancelled");

		for (const listener of session.listeners()) {
			listener({
				type: "message_update",
				message: makeAssistantMessage("late"),
				assistantMessageEvent: { type: "text_delta", delta: "late" },
			} as AgentSessionEvent);
		}
		expect(harness.updates).toHaveLength(beforeCancelUpdates);

		const secondPrompt = harness.agent.prompt({
			sessionId: created.sessionId,
			messageId: "00000000-0000-4000-8000-000000000040",
			prompt: [{ type: "text", text: "after cancel" }],
		} as PromptRequest);
		await Bun.sleep(0);
		expect(session.promptCalls).toEqual(["cancel me"]);

		releaseAbort();
		await cancelPrompt;
		finishPrompt();
		await secondPrompt;
		expect(session.promptCalls).toEqual(["cancel me", "after cancel"]);

		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("dispatches a legacy tool's permission request right after its start frame", async () => {
		// The literal writer order for a permission-gated **legacy** route. The reserved
		// slot keys off delivered starts, and the legacy mapper path used to enqueue its
		// `tool_call` announcement untagged — so the start could not pass the slot that
		// was waiting for it, and both the card and the dialog appeared only after the
		// 10-second barrier expired.
		const answer = Promise.withResolvers<{ outcome: { outcome: "selected"; optionId: string } }>();
		const harness = await createHarness({ requestPermission: () => answer.promise });
		const created = await harness.agent.newSession({ cwd: harness.cwdA, mcpServers: [] });
		const session = harness.findSession(created.sessionId)!;
		const finishPrompt = holdPromptStreaming(session);

		const prompt = harness.agent.prompt({
			sessionId: created.sessionId,
			messageId: "00000000-0000-4000-8000-000000000071",
			prompt: [{ type: "text", text: "edit a file" }],
		} as PromptRequest);
		await Bun.sleep(0);
		harness.writes.length = 0;

		// The permission gate wraps `execute`, and `processAgentEvent` fan-out is async,
		// so the gate can reach the bridge before the start frame has been written.
		const bridge = session.clientBridge;
		if (!bridge?.requestPermission) throw new Error("expected the ACP client bridge to own requestPermission");
		const permission = bridge.requestPermission({ toolCallId: "edit-1", toolName: "edit", title: "edit a.txt" }, [
			{ optionId: "allow", name: "Allow", kind: "allow_once" },
		]);

		const emit = (event: AgentSessionEvent): void => {
			for (const listener of session.listeners()) listener(event);
		};
		emit({
			type: "tool_execution_start",
			toolCallId: "edit-1",
			toolName: "edit",
			args: { path: "a.txt", old_text: "a", new_text: "b" },
		} as AgentSessionEvent);
		emit({
			type: "message_update",
			message: makeAssistantMessage("unrelated"),
			assistantMessageEvent: { type: "text_delta", delta: "unrelated" },
		} as AgentSessionEvent);

		// Deterministic completion signals, not a latency snapshot: wait for exactly
		// the writes this assertion cares about to land, in the order they must land.
		await harness.waitForWrite("tool_call:edit-1");
		await harness.waitForWrite("request_permission:edit-1");
		await harness.waitForWrite("agent_message_chunk");

		// Bootstrap notifications (`available_commands_update`, `session_info_update`)
		// ride the same writer but belong to session setup, not to this ordering claim.
		const ordered = harness.writes.filter(label => !label.endsWith("_update") || label.includes(":"));
		expect(ordered).toEqual(["tool_call:edit-1", "request_permission:edit-1", "agent_message_chunk"]);

		// ...and all of that happened while the dialog was still open: race the
		// permission response against an already-resolved sentinel and require the
		// sentinel wins, proving `permission` has not settled yet.
		const sentinel = Symbol("still-pending");
		const raced = await Promise.race([permission, Promise.resolve(sentinel)]);
		expect(raced).toBe(sentinel);

		answer.resolve({ outcome: { outcome: "selected", optionId: "allow" } });
		expect(await permission).toEqual({ outcome: "selected", optionId: "allow", kind: "allow_once" });

		finishPrompt();
		await prompt;
		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("delivers a live apply_patch start, snapshot, and terminal edit frame through the encoded queue exactly once", async () => {
		const harness = await createHarness({ writeDelayMs: 5 });
		const created = await harness.agent.newSession({ cwd: harness.cwdA, mcpServers: [] });
		const session = harness.findSession(created.sessionId)!;
		const finishPrompt = holdPromptStreaming(session);
		const prompt = harness.agent.prompt({
			sessionId: created.sessionId,
			messageId: "00000000-0000-4000-8000-000000000073",
			prompt: [{ type: "text", text: "patch a file" }],
		} as PromptRequest);
		await Bun.sleep(0);

		const emit = (event: AgentSessionEvent): void => {
			for (const listener of session.listeners()) listener(event);
		};
		emit({
			type: "tool_execution_start",
			toolCallId: "live-apply-patch",
			toolName: "apply_patch",
			args: { path: "src/live.ts", input: "*** Begin Patch" },
		} as AgentSessionEvent);
		emit({
			type: "tool_execution_update",
			toolCallId: "live-apply-patch",
			toolName: "apply_patch",
			args: { path: "src/live.ts" },
			partialResult: { content: [{ type: "text", text: "in progress" }], details: { diff: "" } },
		} as AgentSessionEvent);
		emit({
			type: "tool_execution_end",
			toolCallId: "live-apply-patch",
			toolName: "apply_patch",
			isError: false,
			result: {
				content: [{ type: "text", text: "applied" }],
				details: {
					diff: "",
					perFileResults: [{ path: "src/live.ts", diff: "", oldText: "before\n", newText: "after\n" }],
				},
			},
		} as AgentSessionEvent);

		finishPrompt();
		await prompt;
		const updates = harness.updates
			.map(
				notification =>
					notification.update as {
						sessionUpdate?: string;
						toolCallId?: string;
						status?: string;
						content?: unknown[];
						locations?: unknown[];
					},
			)
			.filter(update => update.toolCallId === "live-apply-patch");
		expect(updates.map(update => update.sessionUpdate)).toEqual([
			"tool_call",
			"tool_call_update",
			"tool_call_update",
		]);
		expect(updates[1]).toMatchObject({
			status: "in_progress",
			content: [{ type: "content", content: { type: "text", text: "```\nin progress\n```" } }],
			locations: [{ path: path.join(harness.cwdA, "src/live.ts") }],
		});
		expect(updates[2]).toMatchObject({
			status: "completed",
			content: [{ type: "diff", path: "src/live.ts", oldText: "before\n", newText: "after\n" }],
			locations: [{ path: path.join(harness.cwdA, "src/live.ts") }],
		});
		expect(updates.filter(update => update.status === "completed")).toHaveLength(1);

		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("keeps an exact external apply_patch shadow on the live external path without poisoning the queue", async () => {
		const harness = await createHarness();
		const created = await harness.agent.newSession({ cwd: harness.cwdA, mcpServers: [] });
		const session = harness.findSession(created.sessionId)!;
		// Match the real dispatcher setup: the built-in edit tool advertises the
		// apply_patch wire alias, but an exact external name wins before aliases.
		session.registerBuiltinTool("edit", "apply_patch");
		session.registerExternalTool("apply_patch");
		expect(session.hasBuiltInToolDispatch("apply_patch")).toBeFalse();

		const finishPrompt = holdPromptStreaming(session);
		const prompt = harness.agent.prompt({
			sessionId: created.sessionId,
			messageId: "00000000-0000-4000-8000-000000000074",
			prompt: [{ type: "text", text: "run external patch" }],
		} as PromptRequest);
		await Bun.sleep(0);

		const emit = (event: AgentSessionEvent): void => {
			for (const listener of session.listeners()) listener(event);
		};
		emit({
			type: "tool_execution_start",
			toolCallId: "external-apply-patch",
			toolName: "apply_patch",
			args: { external: true },
		} as AgentSessionEvent);
		emit({
			type: "tool_execution_end",
			toolCallId: "external-apply-patch",
			toolName: "apply_patch",
			isError: false,
			// A built-in edit parse must reject this missing-diff payload. Its
			// successful external delivery proves the live witness chose the
			// dispatcher-selected external tool instead.
			result: { content: [{ type: "text", text: "external result" }], details: { external: true } },
		} as AgentSessionEvent);

		finishPrompt();
		await expect(prompt).resolves.toMatchObject({ stopReason: "end_turn" });

		const updates = harness.updates
			.map(
				notification =>
					notification.update as {
						sessionUpdate?: string;
						toolCallId?: string;
						kind?: string;
						status?: string;
						content?: unknown[];
					},
			)
			.filter(update => update.toolCallId === "external-apply-patch");
		expect(updates).toMatchObject([
			{ sessionUpdate: "tool_call", kind: "other" },
			{
				sessionUpdate: "tool_call_update",
				status: "completed",
				content: [{ type: "content", content: { type: "text", text: "external result" } }],
			},
		]);

		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("routes a real built-in EvalTool proxy result through typed ACP frames", async () => {
		const harness = await createHarness({ terminalMeta: true });
		const created = await harness.agent.newSession({ cwd: harness.cwdA, mcpServers: [] });
		const session = harness.findSession(created.sessionId)!;
		session.registerBuiltinTool("eval");
		const finishPrompt = holdPromptStreaming(session);
		const prompt = harness.agent.prompt({
			sessionId: created.sessionId,
			messageId: "00000000-0000-4000-8000-000000000077",
			prompt: [{ type: "text", text: "run proxied eval" }],
		} as PromptRequest);
		await Bun.sleep(0);

		const proxy = new EvalTool(null, {
			proxyExecutor: async () => ({
				content: [{ type: "text", text: "proxy stdout" }],
				details: { notice: "Fell back to the js backend." },
			}),
		});
		const args = { language: "js", code: "fallback()" };
		const result = await proxy.execute("proxy-eval", args as never);
		const emit = (event: AgentSessionEvent): void => {
			for (const listener of session.listeners()) listener(event);
		};
		emit({
			type: "tool_execution_start",
			toolCallId: "proxy-eval",
			toolName: "eval",
			args,
			progressProtocol: "legacy_snapshot",
		} as AgentSessionEvent);
		emit({
			type: "tool_execution_end",
			toolCallId: "proxy-eval",
			toolName: "eval",
			isError: false,
			result,
			progressProtocol: "legacy_snapshot",
		} as AgentSessionEvent);

		finishPrompt();
		await prompt;
		const updates = harness.updates
			.map(notification => notification.update)
			.filter(
				(update): update is Extract<typeof update, { toolCallId: string }> =>
					"toolCallId" in update && update.toolCallId === "proxy-eval",
			);
		expect(updates).toEqual([
			{
				sessionUpdate: "tool_call",
				toolCallId: "proxy-eval",
				title: "[js]",
				kind: "execute",
				status: "pending",
				rawInput: args,
				content: [{ type: "terminal", terminalId: "proxy-eval" }],
				_meta: { terminal_info: { terminal_id: "proxy-eval", cwd: harness.cwdA } },
			},
			{
				sessionUpdate: "tool_call_update",
				toolCallId: "proxy-eval",
				status: "in_progress",
				_meta: {
					terminal_output: { terminal_id: "proxy-eval", data: `fallback()\n${"─".repeat(48)}\nproxy stdout` },
				},
			},
			{
				sessionUpdate: "tool_call_update",
				toolCallId: "proxy-eval",
				_meta: { terminal_output: { terminal_id: "proxy-eval", data: "\nFell back to the js backend.\n" } },
			},
			{
				sessionUpdate: "tool_call_update",
				toolCallId: "proxy-eval",
				status: "completed",
				rawOutput: { kind: "tool_settlement", tool: "eval", outcome: "completed" },
				_meta: { terminal_exit: { terminal_id: "proxy-eval", exit_code: 0, signal: null } },
			},
		]);
		// Exactly one update carries rawOutput — the bounded settlement marker,
		// never a raw result object.
		expect(updates.filter(update => "rawOutput" in update).map(update => update.rawOutput)).toEqual([
			{ kind: "tool_settlement", tool: "eval", outcome: "completed" },
		]);

		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("keeps the real local EvalTool presentation route out of the proxy adapter", async () => {
		const harness = await createHarness({ terminalMeta: true });
		const created = await harness.agent.newSession({ cwd: harness.cwdA, mcpServers: [] });
		const session = harness.findSession(created.sessionId)!;
		session.registerBuiltinTool("eval");
		const finishPrompt = holdPromptStreaming(session);
		const prompt = harness.agent.prompt({
			sessionId: created.sessionId,
			messageId: "00000000-0000-4000-8000-000000000079",
			prompt: [{ type: "text", text: "run local eval" }],
		} as PromptRequest);
		await Bun.sleep(0);

		const local = new EvalTool(null);
		const args = { language: "js", code: "local()" };
		expect(local.presentation.selects.call(local, args as never, undefined)).toBe(true);
		const call = local.presentation.start.call(local, "local-eval", args as never, undefined);
		const emit = (event: AgentSessionEvent): void => {
			for (const listener of session.listeners()) listener(event);
		};
		emit({
			type: "tool_execution_start",
			toolCallId: "local-eval",
			toolName: "eval",
			args,
			progressProtocol: "presentation_events",
		} as AgentSessionEvent);
		emit({ type: "tool_presentation", toolCallId: "local-eval", toolName: "eval", event: { type: "started", call } });
		emit({
			type: "tool_presentation",
			toolCallId: "local-eval",
			toolName: "eval",
			event: { type: "settled", outcome: { kind: "succeeded", process: { kind: "exited", code: 0 } } },
		});
		emit({
			type: "tool_execution_end",
			toolCallId: "local-eval",
			toolName: "eval",
			result: { content: [], details: {} },
			progressProtocol: "presentation_events",
		} as AgentSessionEvent);

		finishPrompt();
		await expect(prompt).resolves.toMatchObject({ stopReason: "end_turn" });
		const updates = harness.updates
			.map(notification => notification.update)
			.filter(
				(update): update is Extract<typeof update, { toolCallId: string }> =>
					"toolCallId" in update && update.toolCallId === "local-eval",
			);
		expect(updates).toEqual([
			{
				sessionUpdate: "tool_call",
				toolCallId: "local-eval",
				title: "Eval",
				kind: "execute",
				status: "pending",
				rawInput: args,
				content: [{ type: "terminal", terminalId: "local-eval" }],
				_meta: { terminal_info: { terminal_id: "local-eval", cwd: harness.cwdA } },
			},
			{
				sessionUpdate: "tool_call_update",
				toolCallId: "local-eval",
				status: "completed",
				rawOutput: { kind: "tool_settlement", tool: "eval", outcome: "completed" },
				_meta: {
					terminal_output: {
						terminal_id: "local-eval",
						data: `local()\n${"─".repeat(48)}\n`,
					},
					terminal_exit: { terminal_id: "local-eval", exit_code: 0, signal: null },
				},
			},
		]);

		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("routes a real built-in EvalTool proxy result with an image through a replacement content card", async () => {
		// Companion to the notice/image proxy-eval coverage above: an image in
		// the result forces the reducer's meta-terminal-to-content transition
		// (`acp-view-reducer.test.ts`'s "finalizes the display-only terminal in
		// its own frame before emitting attachment content"), so the terminal
		// card's sourceEcho/notice text must survive onto the final content
		// frame alongside the image instead of vanishing behind the dropped
		// terminal item.
		const harness = await createHarness({ terminalMeta: true });
		const created = await harness.agent.newSession({ cwd: harness.cwdA, mcpServers: [] });
		const session = harness.findSession(created.sessionId)!;
		session.registerBuiltinTool("eval");
		const finishPrompt = holdPromptStreaming(session);
		const prompt = harness.agent.prompt({
			sessionId: created.sessionId,
			messageId: "00000000-0000-4000-8000-000000000201",
			prompt: [{ type: "text", text: "run proxied eval with image" }],
		} as PromptRequest);
		await Bun.sleep(0);

		const proxy = new EvalTool(null, {
			proxyExecutor: async () => ({
				content: [{ type: "text", text: "(displayed image)" }],
				details: {
					notice: "Fell back to the js backend.",
					images: [{ type: "image", data: "image-data", mimeType: "image/png" }],
				},
			}),
		});
		const args = { language: "py", code: "show()" };
		const result = await proxy.execute("proxy-eval-image", args as never);
		const emit = (event: AgentSessionEvent): void => {
			for (const listener of session.listeners()) listener(event);
		};
		emit({
			type: "tool_execution_start",
			toolCallId: "proxy-eval-image",
			toolName: "eval",
			args,
			progressProtocol: "legacy_snapshot",
		} as AgentSessionEvent);
		emit({
			type: "tool_execution_end",
			toolCallId: "proxy-eval-image",
			toolName: "eval",
			isError: false,
			result,
			progressProtocol: "legacy_snapshot",
		} as AgentSessionEvent);

		finishPrompt();
		await prompt;
		const updates = harness.updates
			.map(notification => notification.update)
			.filter(
				(update): update is Extract<typeof update, { toolCallId: string }> =>
					"toolCallId" in update && update.toolCallId === "proxy-eval-image",
			);
		expect(updates.at(-1)).toMatchObject({
			sessionUpdate: "tool_call_update",
			toolCallId: "proxy-eval-image",
			content: [
				{
					type: "content",
					content: { type: "text", text: "show()\n\n```\n(displayed image)\n```\n\nFell back to the js backend." },
				},
				{ type: "content", content: { type: "image", data: "image-data", mimeType: "image/png" } },
			],
		});
		// Exactly one update carries rawOutput — the bounded settlement marker,
		// never a raw result object.
		expect(updates.filter(update => "rawOutput" in update).map(update => update.rawOutput)).toEqual([
			{ kind: "tool_settlement", tool: "eval", outcome: "completed" },
		]);

		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("streams a built-in proxy eval update as an appended terminal chunk without snapshot overlap reconciliation", async () => {
		const harness = await createHarness({ terminalMeta: true });
		const created = await harness.agent.newSession({ cwd: harness.cwdA, mcpServers: [] });
		const session = harness.findSession(created.sessionId)!;
		session.registerBuiltinTool("eval");
		const finishPrompt = holdPromptStreaming(session);
		const prompt = harness.agent.prompt({
			sessionId: created.sessionId,
			messageId: "00000000-0000-4000-8000-000000000202",
			prompt: [{ type: "text", text: "run streaming proxied eval" }],
		} as PromptRequest);
		await Bun.sleep(0);

		const args = { language: "js", code: "stream()" };
		const emit = (event: AgentSessionEvent): void => {
			for (const listener of session.listeners()) listener(event);
		};
		emit({
			type: "tool_execution_start",
			toolCallId: "proxy-eval-update",
			toolName: "eval",
			args,
			progressProtocol: "legacy_snapshot",
		} as AgentSessionEvent);
		emit({
			type: "tool_execution_update",
			toolCallId: "proxy-eval-update",
			toolName: "eval",
			args,
			partialResult: {
				content: [{ type: "text", text: "one explicit legacy snapshot" }],
				details: { notice: "still running" },
			},
			progressProtocol: "legacy_snapshot",
		} as AgentSessionEvent);

		finishPrompt();
		await prompt;
		const updates = harness.updates
			.map(notification => notification.update)
			.filter(
				(update): update is Extract<typeof update, { toolCallId: string }> =>
					"toolCallId" in update && update.toolCallId === "proxy-eval-update",
			);
		expect(updates.slice(1)).toEqual([
			{
				sessionUpdate: "tool_call_update",
				toolCallId: "proxy-eval-update",
				status: "in_progress",
				_meta: {
					terminal_output: {
						terminal_id: "proxy-eval-update",
						data: `stream()\n${"─".repeat(48)}\none explicit legacy snapshot`,
					},
				},
			},
			{
				sessionUpdate: "tool_call_update",
				toolCallId: "proxy-eval-update",
				_meta: { terminal_output: { terminal_id: "proxy-eval-update", data: "\nstill running\n" } },
			},
		]);

		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("derives real proxy eval failure and cancellation settlements from strict details", async () => {
		const harness = await createHarness({ terminalMeta: true });
		const created = await harness.agent.newSession({ cwd: harness.cwdA, mcpServers: [] });
		const session = harness.findSession(created.sessionId)!;
		session.registerBuiltinTool("eval");
		const finishPrompt = holdPromptStreaming(session);
		const prompt = harness.agent.prompt({
			sessionId: created.sessionId,
			messageId: "00000000-0000-4000-8000-000000000203",
			prompt: [{ type: "text", text: "run failing and cancelled proxied eval" }],
		} as PromptRequest);
		await Bun.sleep(0);

		const args = { language: "py", code: "sleep()" };
		const emit = (event: AgentSessionEvent): void => {
			for (const listener of session.listeners()) listener(event);
		};
		emit({
			type: "tool_execution_start",
			toolCallId: "proxy-eval-failure",
			toolName: "eval",
			args,
			progressProtocol: "legacy_snapshot",
		} as AgentSessionEvent);
		emit({
			type: "tool_execution_end",
			toolCallId: "proxy-eval-failure",
			toolName: "eval",
			isError: false,
			result: {
				content: [{ type: "text", text: "failed" }],
				details: { cells: [{ index: 0, code: "", output: "", status: "error", exitCode: 7 }] },
			},
			progressProtocol: "legacy_snapshot",
		} as AgentSessionEvent);
		emit({
			type: "tool_execution_start",
			toolCallId: "proxy-eval-cancelled",
			toolName: "eval",
			args,
			progressProtocol: "legacy_snapshot",
		} as AgentSessionEvent);
		emit({
			type: "tool_execution_end",
			toolCallId: "proxy-eval-cancelled",
			toolName: "eval",
			isError: true,
			result: { content: [{ type: "text", text: "aborted" }], details: { termination: { kind: "interrupted" } } },
			progressProtocol: "legacy_snapshot",
		} as AgentSessionEvent);

		finishPrompt();
		await prompt;
		const updateFor = (toolCallId: string) =>
			harness.updates
				.map(notification => notification.update)
				.filter(
					(update): update is Extract<typeof update, { toolCallId: string }> =>
						"toolCallId" in update && update.toolCallId === toolCallId,
				)
				.at(-1);
		expect(updateFor("proxy-eval-failure")).toMatchObject({
			status: "failed",
			_meta: { terminal_exit: { terminal_id: "proxy-eval-failure", exit_code: 7, signal: null } },
		});
		expect(updateFor("proxy-eval-cancelled")).toMatchObject({
			status: "failed",
			_meta: { terminal_exit: { terminal_id: "proxy-eval-cancelled", exit_code: null, signal: null } },
		});

		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("uses replacement content frames for a real built-in proxy eval without terminal capability", async () => {
		const harness = await createHarness();
		const created = await harness.agent.newSession({ cwd: harness.cwdA, mcpServers: [] });
		const session = harness.findSession(created.sessionId)!;
		session.registerBuiltinTool("eval");
		const finishPrompt = holdPromptStreaming(session);
		const prompt = harness.agent.prompt({
			sessionId: created.sessionId,
			messageId: "00000000-0000-4000-8000-000000000204",
			prompt: [{ type: "text", text: "run plain proxied eval" }],
		} as PromptRequest);
		await Bun.sleep(0);

		const args = { language: "js", code: "plain()" };
		const emit = (event: AgentSessionEvent): void => {
			for (const listener of session.listeners()) listener(event);
		};
		emit({
			type: "tool_execution_start",
			toolCallId: "proxy-eval-plain",
			toolName: "eval",
			args,
			progressProtocol: "legacy_snapshot",
		} as AgentSessionEvent);
		emit({
			type: "tool_execution_end",
			toolCallId: "proxy-eval-plain",
			toolName: "eval",
			isError: false,
			result: { content: [{ type: "text", text: "plain result" }], details: {} },
			progressProtocol: "legacy_snapshot",
		} as AgentSessionEvent);

		finishPrompt();
		await prompt;
		const updates = harness.updates
			.map(notification => notification.update)
			.filter(
				(update): update is Extract<typeof update, { toolCallId: string }> =>
					"toolCallId" in update && update.toolCallId === "proxy-eval-plain",
			);
		expect(updates[0]).toMatchObject({
			sessionUpdate: "tool_call",
			toolCallId: "proxy-eval-plain",
			status: "pending",
			content: [{ type: "content", content: { type: "text", text: "plain()" } }],
		});
		expect(updates.at(-1)).toMatchObject({
			sessionUpdate: "tool_call_update",
			toolCallId: "proxy-eval-plain",
			status: "completed",
			content: [{ type: "content", content: { type: "text", text: expect.stringContaining("plain result") } }],
		});

		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("routes omitted-protocol synthetic built-in eval through the checked legacy lifecycle", async () => {
		const harness = await createHarness({ terminalMeta: true });
		const created = await harness.agent.newSession({ cwd: harness.cwdA, mcpServers: [] });
		const session = harness.findSession(created.sessionId)!;
		session.registerBuiltinTool("eval");
		const finishPrompt = holdPromptStreaming(session);
		const prompt = harness.agent.prompt({
			sessionId: created.sessionId,
			messageId: "00000000-0000-4000-8000-000000000080",
			prompt: [{ type: "text", text: "synthetic skipped eval" }],
		} as PromptRequest);
		await Bun.sleep(0);

		const args = { language: "js", code: "never()" };
		const result = {
			content: [{ type: "text", text: "Tool call was not executed because the assistant ended its turn." }],
			details: { __synthetic: true, source: "assistant_stop_skipped", executed: false },
		};
		const emit = (event: AgentSessionEvent): void => {
			for (const listener of session.listeners()) listener(event);
		};
		// `AgentSessionEvent` intentionally omits progressProtocol for synthetic
		// skipped/aborted calls; absence means legacy_snapshot.
		emit({ type: "tool_execution_start", toolCallId: "synthetic-eval", toolName: "eval", args } as AgentSessionEvent);
		emit({
			type: "tool_execution_end",
			toolCallId: "synthetic-eval",
			toolName: "eval",
			isError: true,
			result,
		} as AgentSessionEvent);

		finishPrompt();
		await expect(prompt).resolves.toMatchObject({ stopReason: "end_turn" });
		const updates = harness.updates
			.map(notification => notification.update)
			.filter(
				(update): update is Extract<typeof update, { toolCallId: string }> =>
					"toolCallId" in update && update.toolCallId === "synthetic-eval",
			);
		expect(updates).toEqual([
			{
				sessionUpdate: "tool_call",
				toolCallId: "synthetic-eval",
				title: "[js]",
				kind: "execute",
				status: "pending",
				rawInput: args,
				content: [{ type: "terminal", terminalId: "synthetic-eval" }],
				_meta: { terminal_info: { terminal_id: "synthetic-eval", cwd: harness.cwdA } },
			},
			{
				sessionUpdate: "tool_call_update",
				toolCallId: "synthetic-eval",
				status: "in_progress",
				_meta: {
					terminal_output: {
						terminal_id: "synthetic-eval",
						data: `never()\n${"─".repeat(48)}\nTool call was not executed because the assistant ended its turn.`,
					},
				},
			},
			{
				sessionUpdate: "tool_call_update",
				toolCallId: "synthetic-eval",
				status: "failed",
				rawOutput: { kind: "tool_settlement", tool: "eval", outcome: "failed" },
				_meta: { terminal_exit: { terminal_id: "synthetic-eval", exit_code: null, signal: null } },
			},
		]);
		// Exactly one update carries rawOutput — the bounded settlement marker,
		// never a raw result object.
		expect(updates.filter(update => "rawOutput" in update).map(update => update.rawOutput)).toEqual([
			{ kind: "tool_settlement", tool: "eval", outcome: "failed" },
		]);

		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("fails closed for an omitted-protocol built-in eval end without its legacy start", async () => {
		const harness = await createHarness({ terminalMeta: true });
		const created = await harness.agent.newSession({ cwd: harness.cwdA, mcpServers: [] });
		const session = harness.findSession(created.sessionId)!;
		session.registerBuiltinTool("eval");
		const finishPrompt = holdPromptStreaming(session);
		const prompt = harness.agent.prompt({
			sessionId: created.sessionId,
			messageId: "00000000-0000-4000-8000-000000000081",
			prompt: [{ type: "text", text: "orphan synthetic eval" }],
		} as PromptRequest);
		await Bun.sleep(0);

		const emit = (event: AgentSessionEvent): void => {
			for (const listener of session.listeners()) listener(event);
		};
		emit({
			type: "tool_execution_end",
			toolCallId: "orphan-synthetic-eval",
			toolName: "eval",
			isError: true,
			result: {
				content: [{ type: "text", text: "Tool execution was aborted" }],
				details: { __synthetic: true, source: "assistant_stop_aborted", executed: false },
			},
		} as AgentSessionEvent);

		finishPrompt();
		await expect(prompt).rejects.toThrow("ACP built-in eval ended without a legacy start: orphan-synthetic-eval");
		expect(
			harness.updates.some(
				(update: { update: unknown }) =>
					typeof update.update === "object" &&
					update.update !== null &&
					"toolCallId" in update.update &&
					(update.update as { toolCallId?: unknown }).toolCallId === "orphan-synthetic-eval",
			),
		).toBe(false);

		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("keeps an exact external eval shadow on the generic ACP compatibility route", async () => {
		const harness = await createHarness();
		const created = await harness.agent.newSession({ cwd: harness.cwdA, mcpServers: [] });
		const session = harness.findSession(created.sessionId)!;
		session.registerBuiltinTool("eval");
		session.registerExternalTool("eval");
		expect(session.hasBuiltInToolDispatch("eval")).toBeFalse();
		const finishPrompt = holdPromptStreaming(session);
		const prompt = harness.agent.prompt({
			sessionId: created.sessionId,
			messageId: "00000000-0000-4000-8000-000000000078",
			prompt: [{ type: "text", text: "run external eval" }],
		} as PromptRequest);
		await Bun.sleep(0);
		const emit = (event: AgentSessionEvent): void => {
			for (const listener of session.listeners()) listener(event);
		};
		emit({
			type: "tool_execution_start",
			toolCallId: "external-eval",
			toolName: "eval",
			args: { external: true },
		} as AgentSessionEvent);
		emit({
			type: "tool_execution_end",
			toolCallId: "external-eval",
			toolName: "eval",
			isError: false,
			result: { content: [{ type: "text", text: "external result" }], details: { notice: 42 } },
		} as AgentSessionEvent);

		finishPrompt();
		await expect(prompt).resolves.toMatchObject({ stopReason: "end_turn" });
		const end = harness.updates
			.map(notification => notification.update)
			.find(update => update.sessionUpdate === "tool_call_update" && update.toolCallId === "external-eval");
		expect(end).toMatchObject({
			status: "completed",
			content: [{ type: "content", content: { type: "text", text: "```\nexternal result\n```" } }],
			rawOutput: { kind: "tool_settlement", tool: "eval", outcome: "completed" },
		});
		// Bounded settlement marker only — never the raw result above (Zed's
		// `acp_thread.rs` gates tool-output-refusal classification on
		// `raw_output.is_some()` for a completed call).
		expect(JSON.stringify((end as { rawOutput?: unknown } | undefined)?.rawOutput)).not.toContain("external result");

		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("routes an omitted-protocol synthetic built-in shell alias through checked typed frames", async () => {
		const harness = await createHarness({ terminalMeta: true });
		const created = await harness.agent.newSession({ cwd: harness.cwdA, mcpServers: [] });
		const session = harness.findSession(created.sessionId)!;
		session.registerBuiltinTool("bash", "shell");
		const finishPrompt = holdPromptStreaming(session);
		const prompt = harness.agent.prompt({
			sessionId: created.sessionId,
			messageId: "00000000-0000-4000-8000-000000000082",
			prompt: [{ type: "text", text: "synthetic skipped shell" }],
		} as PromptRequest);
		await Bun.sleep(0);

		const args = { command: "echo never" };
		const emit = (event: AgentSessionEvent): void => {
			for (const listener of session.listeners()) listener(event);
		};
		// Synthetic lifecycle emitters have no producer handle. Their omitted tag is
		// therefore an explicit legacy_snapshot declaration, not a route guess.
		emit({
			type: "tool_execution_start",
			toolCallId: "synthetic-shell",
			toolName: "shell",
			args,
		} as AgentSessionEvent);
		emit({
			type: "tool_execution_end",
			toolCallId: "synthetic-shell",
			toolName: "shell",
			isError: true,
			result: {
				content: [{ type: "text", text: "Tool call was not executed because the assistant ended its turn." }],
				details: { __synthetic: true, source: "assistant_stop_skipped", executed: false },
			},
		} as AgentSessionEvent);

		finishPrompt();
		await expect(prompt).resolves.toMatchObject({ stopReason: "end_turn" });
		const updates = harness.updates
			.map(notification => notification.update)
			.filter(
				(update): update is Extract<typeof update, { toolCallId: string }> =>
					"toolCallId" in update && update.toolCallId === "synthetic-shell",
			);
		expect(updates).toEqual([
			{
				sessionUpdate: "tool_call",
				toolCallId: "synthetic-shell",
				title: "echo never",
				kind: "execute",
				status: "pending",
				rawInput: args,
				content: [{ type: "terminal", terminalId: "synthetic-shell" }],
				_meta: { terminal_info: { terminal_id: "synthetic-shell", cwd: harness.cwdA } },
			},
			{
				sessionUpdate: "tool_call_update",
				toolCallId: "synthetic-shell",
				status: "in_progress",
				_meta: {
					terminal_output: {
						terminal_id: "synthetic-shell",
						data: "Tool call was not executed because the assistant ended its turn.",
					},
				},
			},
			{
				sessionUpdate: "tool_call_update",
				toolCallId: "synthetic-shell",
				status: "failed",
				rawOutput: { kind: "tool_settlement", tool: "shell", outcome: "failed" },
				_meta: { terminal_exit: { terminal_id: "synthetic-shell", exit_code: null, signal: null } },
			},
		]);
		// Exactly one update carries rawOutput — the bounded settlement marker,
		// never a raw result object.
		expect(updates.filter(update => "rawOutput" in update).map(update => update.rawOutput)).toEqual([
			{ kind: "tool_settlement", tool: "shell", outcome: "failed" },
		]);

		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("keeps an explicit-presentation built-in bash route out of the legacy adapter", async () => {
		const harness = await createHarness({ terminalMeta: true });
		const created = await harness.agent.newSession({ cwd: harness.cwdA, mcpServers: [] });
		const session = harness.findSession(created.sessionId)!;
		session.registerBuiltinTool("bash");
		const finishPrompt = holdPromptStreaming(session);
		const prompt = harness.agent.prompt({
			sessionId: created.sessionId,
			messageId: "00000000-0000-4000-8000-000000000083",
			prompt: [{ type: "text", text: "local bash presentation" }],
		} as PromptRequest);
		await Bun.sleep(0);

		const args = { command: "echo local" };
		const emit = (event: AgentSessionEvent): void => {
			for (const listener of session.listeners()) listener(event);
		};
		emit({
			type: "tool_execution_start",
			toolCallId: "local-bash",
			toolName: "bash",
			args,
			progressProtocol: "presentation_events",
		} as AgentSessionEvent);
		emit({
			type: "tool_presentation",
			toolCallId: "local-bash",
			toolName: "bash",
			event: {
				type: "started",
				call: {
					toolCallId: "local-bash",
					toolName: "bash",
					title: "echo local",
					kind: "execute",
					cwd: harness.cwdA,
					rawInput: args,
				},
			},
		});
		emit({
			type: "tool_presentation",
			toolCallId: "local-bash",
			toolName: "bash",
			event: { type: "settled", outcome: { kind: "succeeded", process: { kind: "exited", code: 0 } } },
		});
		// This would fail the strict legacy parser if the explicit presentation route
		// accidentally re-entered the compatibility adapter at end-of-lifecycle.
		emit({
			type: "tool_execution_end",
			toolCallId: "local-bash",
			toolName: "bash",
			result: { content: [], details: { exitCode: "not-a-number" } },
			progressProtocol: "presentation_events",
		} as AgentSessionEvent);

		finishPrompt();
		await expect(prompt).resolves.toMatchObject({ stopReason: "end_turn" });
		const updates = harness.updates
			.map(notification => notification.update)
			.filter(
				(update): update is Extract<typeof update, { toolCallId: string }> =>
					"toolCallId" in update && update.toolCallId === "local-bash",
			);
		expect(updates).toEqual([
			{
				sessionUpdate: "tool_call",
				toolCallId: "local-bash",
				title: "echo local",
				kind: "execute",
				status: "pending",
				rawInput: args,
				content: [{ type: "terminal", terminalId: "local-bash" }],
				_meta: { terminal_info: { terminal_id: "local-bash", cwd: harness.cwdA } },
			},
			{
				sessionUpdate: "tool_call_update",
				toolCallId: "local-bash",
				status: "completed",
				rawOutput: { kind: "tool_settlement", tool: "bash", outcome: "completed" },
				_meta: { terminal_exit: { terminal_id: "local-bash", exit_code: 0, signal: null } },
			},
		]);
		// Exactly one update carries rawOutput — the bounded settlement marker,
		// never a raw result object.
		expect(updates.filter(update => "rawOutput" in update).map(update => update.rawOutput)).toEqual([
			{ kind: "tool_settlement", tool: "bash", outcome: "completed" },
		]);

		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("keeps an exact external shell shadow on the generic ACP compatibility route", async () => {
		const harness = await createHarness();
		const created = await harness.agent.newSession({ cwd: harness.cwdA, mcpServers: [] });
		const session = harness.findSession(created.sessionId)!;
		session.registerBuiltinTool("bash", "shell");
		session.registerExternalTool("shell");
		expect(session.hasBuiltInToolDispatch("shell")).toBeFalse();
		const finishPrompt = holdPromptStreaming(session);
		const prompt = harness.agent.prompt({
			sessionId: created.sessionId,
			messageId: "00000000-0000-4000-8000-000000000084",
			prompt: [{ type: "text", text: "external shell" }],
		} as PromptRequest);
		await Bun.sleep(0);

		const result = { content: [{ type: "text", text: "external result" }], details: { external: true } };
		const emit = (event: AgentSessionEvent): void => {
			for (const listener of session.listeners()) listener(event);
		};
		emit({
			type: "tool_execution_start",
			toolCallId: "external-shell",
			toolName: "shell",
			args: { external: true },
		} as AgentSessionEvent);
		emit({
			type: "tool_execution_end",
			toolCallId: "external-shell",
			toolName: "shell",
			isError: false,
			result,
		} as AgentSessionEvent);

		finishPrompt();
		await expect(prompt).resolves.toMatchObject({ stopReason: "end_turn" });
		const end = harness.updates
			.map(notification => notification.update)
			.find(update => update.sessionUpdate === "tool_call_update" && update.toolCallId === "external-shell");
		expect(end).toMatchObject({
			status: "completed",
			content: [{ type: "content", content: { type: "text", text: "```\nexternal result\n```" } }],
			rawOutput: { kind: "tool_settlement", tool: "shell", outcome: "completed" },
		});
		// Bounded settlement marker only — never the raw result above (Zed's
		// `acp_thread.rs` gates tool-output-refusal classification on
		// `raw_output.is_some()` for a completed call).
		expect(JSON.stringify((end as { rawOutput?: unknown } | undefined)?.rawOutput)).not.toContain("external result");

		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("publishes only a settled full body for an external shell shadow's meta terminal, with no live progress and no discontinuity notice", async () => {
		// The one remaining live consumer of the display-only meta-terminal
		// convention's raw mapper arm: an external/MCP tool literally
		// named `bash`/`shell`/`exec`/`eval` that fails `hasBuiltInToolDispatch`.
		// `wantsMetaTerminal` gates on the *name*, never on origin, and a
		// terminalMeta-capable client with no real terminal routes it here.
		const harness = await createHarness({ terminalMeta: true });
		const created = await harness.agent.newSession({ cwd: harness.cwdA, mcpServers: [] });
		const session = harness.findSession(created.sessionId)!;
		session.registerBuiltinTool("bash", "shell");
		session.registerExternalTool("shell");
		expect(session.hasBuiltInToolDispatch("shell")).toBeFalse();
		const finishPrompt = holdPromptStreaming(session);
		const prompt = harness.agent.prompt({
			sessionId: created.sessionId,
			messageId: "00000000-0000-4000-8000-000000000085",
			prompt: [{ type: "text", text: "external shell meta terminal" }],
		} as PromptRequest);
		await Bun.sleep(0);

		const args = { external: true };
		const emit = (event: AgentSessionEvent): void => {
			for (const listener of session.listeners()) listener(event);
		};
		emit({
			type: "tool_execution_start",
			toolCallId: "external-shell-meta",
			toolName: "shell",
			args,
		} as AgentSessionEvent);
		// Two bounded-window snapshots that would previously have forced the
		// KMP overlap/rollover-resync branch: neither is a prefix extension of
		// the last, so the deleted machinery would have fabricated a
		// "[terminal output discontinuity]" notice and duplicated bytes. The
		// settled-body-only policy must instead publish nothing here at all.
		emit({
			type: "tool_execution_update",
			toolCallId: "external-shell-meta",
			toolName: "shell",
			args,
			partialResult: { content: [{ type: "text", text: "abcde" }], details: {} },
		} as AgentSessionEvent);
		emit({
			type: "tool_execution_update",
			toolCallId: "external-shell-meta",
			toolName: "shell",
			args,
			partialResult: { content: [{ type: "text", text: "cdefg" }], details: {} },
		} as AgentSessionEvent);
		emit({
			type: "tool_execution_end",
			toolCallId: "external-shell-meta",
			toolName: "shell",
			isError: false,
			result: { content: [{ type: "text", text: "cdefgh" }], details: { exitCode: 0 } },
		} as AgentSessionEvent);

		finishPrompt();
		await expect(prompt).resolves.toMatchObject({ stopReason: "end_turn" });
		const callUpdates = harness.updates
			.map(notification => notification.update)
			.filter(
				(update): update is Extract<typeof update, { toolCallId: string }> =>
					"toolCallId" in update && update.toolCallId === "external-shell-meta",
			);
		const terminalOutputs = callUpdates
			.map(update =>
				"_meta" in update
					? (update._meta as { terminal_output?: { data?: string } } | undefined)?.terminal_output?.data
					: undefined,
			)
			.filter((data): data is string => typeof data === "string");
		// Nothing published while the call ran; settlement is the single
		// publish, carrying the true final body with no fabricated notice.
		expect(terminalOutputs).toEqual(["cdefgh"]);
		expect(terminalOutputs.join("\n")).not.toContain("terminal output discontinuity");
		const end = callUpdates.find(update => "status" in update && update.status === "completed");
		expect(end).toMatchObject({
			status: "completed",
			content: [{ type: "terminal", terminalId: "external-shell-meta" }],
		});

		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("fails closed for an omitted-protocol built-in bash alias end without a legacy start", async () => {
		const harness = await createHarness({ terminalMeta: true });
		const created = await harness.agent.newSession({ cwd: harness.cwdA, mcpServers: [] });
		const session = harness.findSession(created.sessionId)!;
		session.registerBuiltinTool("bash", "exec");
		const finishPrompt = holdPromptStreaming(session);
		const prompt = harness.agent.prompt({
			sessionId: created.sessionId,
			messageId: "00000000-0000-4000-8000-000000000085",
			prompt: [{ type: "text", text: "orphan synthetic exec" }],
		} as PromptRequest);
		await Bun.sleep(0);

		for (const listener of session.listeners()) {
			listener({
				type: "tool_execution_end",
				toolCallId: "orphan-exec",
				toolName: "exec",
				isError: true,
				result: {
					content: [{ type: "text", text: "Tool execution was aborted" }],
					details: { __synthetic: true, source: "assistant_stop_aborted", executed: false },
				},
			} as AgentSessionEvent);
		}

		finishPrompt();
		await expect(prompt).rejects.toThrow("ACP built-in bash ended without a legacy start: orphan-exec");
		expect(
			harness.updates.some(
				(update: { update: unknown }) =>
					typeof update.update === "object" &&
					update.update !== null &&
					"toolCallId" in update.update &&
					(update.update as { toolCallId?: unknown }).toolCallId === "orphan-exec",
			),
		).toBe(false);

		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("settles a real argument-validation failure as a typed failed frame without poisoning the prompt", async () => {
		const harness = await createHarness({ terminalMeta: true });
		const created = await harness.agent.newSession({ cwd: harness.cwdA, mcpServers: [] });
		const session = harness.findSession(created.sessionId)!;
		session.registerBuiltinTool("bash");
		const finishPrompt = holdPromptStreaming(session);
		const prompt = harness.agent.prompt({
			sessionId: created.sessionId,
			messageId: "00000000-0000-4000-8000-000000000086",
			prompt: [{ type: "text", text: "validation failure bash" }],
		} as PromptRequest);
		await Bun.sleep(0);

		const args = { command: 42 };
		const emit = (event: AgentSessionEvent): void => {
			for (const listener of session.listeners()) listener(event);
		};
		// Mirrors `agent-loop.ts`'s `record.validationErrorMessage` branch exactly:
		// both events explicitly declare `legacy_snapshot`, and the result details
		// carry `{ isError: true, error }` rather than a bash-specific shape.
		emit({
			type: "tool_execution_start",
			toolCallId: "validation-bash",
			toolName: "bash",
			args,
			progressProtocol: "legacy_snapshot",
		} as AgentSessionEvent);
		emit({
			type: "tool_execution_end",
			toolCallId: "validation-bash",
			toolName: "bash",
			isError: true,
			result: {
				content: [{ type: "text", text: "bad args" }],
				details: { isError: true, error: "bad args" },
			},
			progressProtocol: "legacy_snapshot",
		} as AgentSessionEvent);

		finishPrompt();
		// The old behavior failed the built-in schema on this well-formed
		// validation-failure shape and poisoned the queue, rejecting the prompt.
		await expect(prompt).resolves.toMatchObject({ stopReason: "end_turn" });
		const end = harness.updates
			.map(notification => notification.update)
			.find(
				update =>
					update.sessionUpdate === "tool_call_update" &&
					update.toolCallId === "validation-bash" &&
					"status" in update &&
					update.status === "failed",
			);
		expect(end).toBeDefined();

		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("degrades a schema-violating built-in bash result into a minimal failed frame without poisoning the prompt", async () => {
		const harness = await createHarness({ terminalMeta: true });
		const created = await harness.agent.newSession({ cwd: harness.cwdA, mcpServers: [] });
		const session = harness.findSession(created.sessionId)!;
		session.registerBuiltinTool("bash");
		const finishPrompt = holdPromptStreaming(session);
		const prompt = harness.agent.prompt({
			sessionId: created.sessionId,
			messageId: "00000000-0000-4000-8000-000000000087",
			prompt: [{ type: "text", text: "degraded bash result" }],
		} as PromptRequest);
		await Bun.sleep(0);

		const args = { command: "echo degraded" };
		const emit = (event: AgentSessionEvent): void => {
			for (const listener of session.listeners()) listener(event);
		};
		emit({
			type: "tool_execution_start",
			toolCallId: "degraded-bash",
			toolName: "bash",
			args,
			progressProtocol: "legacy_snapshot",
		} as AgentSessionEvent);
		emit({
			type: "tool_execution_end",
			toolCallId: "degraded-bash",
			toolName: "bash",
			isError: true,
			// A well-formed envelope whose `details` fail `legacyBashDetailsSchema`
			// — reachable without any producer bug via an extension
			// `afterToolCall` transform_external_result — must settle as a minimal
			// typed FAILED card carrying the salvaged content text instead of
			// poisoning the queue via `record.outbound.poison`.
			result: {
				content: [{ type: "text", text: "salvaged output" }],
				details: { exitCode: "three" },
			},
			progressProtocol: "legacy_snapshot",
		} as AgentSessionEvent);

		finishPrompt();
		await expect(prompt).resolves.toMatchObject({ stopReason: "end_turn" });
		// With `terminalMeta` negotiated, the settled bash body streams as
		// terminal_output rather than inline update content — assert the salvaged
		// text reached the wire anywhere on this call's update stream.
		const end = harness.updates
			.map(notification => notification.update)
			.find(
				update =>
					update.sessionUpdate === "tool_call_update" &&
					update.toolCallId === "degraded-bash" &&
					"status" in update &&
					update.status === "failed",
			);
		expect(end).toBeDefined();
		expect(JSON.stringify(harness.updates)).toContain("salvaged output");

		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("degrades a schema-violating built-in apply_patch result into an empty completed card without poisoning the prompt", async () => {
		// Companion to the degraded-bash test above, for the legacy edit adapter:
		// a real `apply_patch`/`edit`/`patch` result that fails
		// `parseLegacyToolResult`'s strict schema degrades into a minimal typed
		// edit result — salvaged content blocks, envelope `isError`, empty details
		// (`editDetailsRows()` yields no rows for `strictObject({})`) — so it
		// settles as an empty completed card instead of poisoning the queue.
		// This is the real route that replaced the old mapper-level
		// `BuiltinResultSchemaError`-throw coverage in
		// `acp-producer-wire.test.ts`'s legacy edit parser boundary tests —
		// `apply_patch` never reaches the mapper at all once the session
		// registers it as a built-in dispatch.
		const harness = await createHarness({ terminalMeta: true });
		const created = await harness.agent.newSession({ cwd: harness.cwdA, mcpServers: [] });
		const session = harness.findSession(created.sessionId)!;
		session.registerBuiltinTool("edit", "apply_patch");
		const finishPrompt = holdPromptStreaming(session);
		const prompt = harness.agent.prompt({
			sessionId: created.sessionId,
			messageId: "00000000-0000-4000-8000-000000000205",
			prompt: [{ type: "text", text: "degraded apply_patch result" }],
		} as PromptRequest);
		await Bun.sleep(0);

		const args = { input: "*** Begin Patch\n*** End Patch\n" };
		const emit = (event: AgentSessionEvent): void => {
			for (const listener of session.listeners()) listener(event);
		};
		emit({
			type: "tool_execution_start",
			toolCallId: "degraded-apply-patch",
			toolName: "apply_patch",
			args,
		} as AgentSessionEvent);
		emit({
			type: "tool_execution_end",
			toolCallId: "degraded-apply-patch",
			toolName: "apply_patch",
			isError: false,
			// A well-formed content array but a `perFileResults` entry whose
			// `path` is the wrong type — fails the built-in edit schema before
			// any diff/notice framing runs.
			result: {
				content: [{ type: "text", text: "applied" }],
				details: { perFileResults: [{ path: 42 }] },
			},
		} as AgentSessionEvent);

		finishPrompt();
		await expect(prompt).resolves.toMatchObject({ stopReason: "end_turn" });
		const end = harness.updates
			.map(notification => notification.update)
			.find(
				update =>
					update.sessionUpdate === "tool_call_update" &&
					update.toolCallId === "degraded-apply-patch" &&
					"status" in update &&
					update.status === "completed",
			);
		expect(end).toBeDefined();
		expect(JSON.stringify(end)).toContain("applied");

		harness.abortController.abort();
		await Bun.sleep(0);
	});
	it("settles envelope-corrupt built-in bash results as a FAILED degraded card, not a succeeded empty one", async () => {
		// Sibling of the two details-violation degrade tests above, guarding the
		// OTHER failure class that reaches `degradeOrThrow`: when the *envelope
		// itself* fails `legacyEnvelopeSchema` (`result: "not-an-envelope"`),
		// the salvaged base collapses to `content: []`/`isError: false`. Without
		// the seam's fail-closed rule this would flip producer/transport
		// corruption into a succeeded empty card — reachable without a transport
		// bug, since an extension `afterToolCall` transform can return a
		// non-envelope just as easily as bad details.
		const harness = await createHarness({ terminalMeta: true });
		const created = await harness.agent.newSession({ cwd: harness.cwdA, mcpServers: [] });
		const session = harness.findSession(created.sessionId)!;
		session.registerBuiltinTool("bash");
		const finishPrompt = holdPromptStreaming(session);
		const prompt = harness.agent.prompt({
			sessionId: created.sessionId,
			messageId: "00000000-0000-4000-8000-000000000089",
			prompt: [{ type: "text", text: "malformed bash envelope" }],
		} as PromptRequest);
		await Bun.sleep(0);

		const emit = (event: AgentSessionEvent): void => {
			for (const listener of session.listeners()) listener(event);
		};
		emit({
			type: "tool_execution_start",
			toolCallId: "corrupt-bash",
			toolName: "bash",
			args: { command: "echo corrupt" },
			progressProtocol: "legacy_snapshot",
		} as AgentSessionEvent);
		emit({
			type: "tool_execution_end",
			toolCallId: "corrupt-bash",
			toolName: "bash",
			isError: false,
			result: "not-an-envelope",
			progressProtocol: "legacy_snapshot",
		} as AgentSessionEvent);

		finishPrompt();
		await expect(prompt).resolves.toMatchObject({ stopReason: "end_turn" });
		const end = harness.updates
			.map(notification => notification.update)
			.find(
				update =>
					update.sessionUpdate === "tool_call_update" &&
					update.toolCallId === "corrupt-bash" &&
					"status" in update &&
					update.status === "failed",
			);
		expect(end).toBeDefined();

		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("degrades a schema-violating built-in eval result into a minimal failed frame without poisoning the prompt", async () => {
		// Eval companion to the degraded-bash/degraded-apply-patch tests above:
		// all three legacy adapters share the unmodelled_builtin conversion, so
		// each family needs its own live-route regression against drift.
		const harness = await createHarness({ terminalMeta: true });
		const created = await harness.agent.newSession({ cwd: harness.cwdA, mcpServers: [] });
		const session = harness.findSession(created.sessionId)!;
		session.registerBuiltinTool("eval");
		const finishPrompt = holdPromptStreaming(session);
		const prompt = harness.agent.prompt({
			sessionId: created.sessionId,
			messageId: "00000000-0000-4000-8000-000000000090",
			prompt: [{ type: "text", text: "degraded eval result" }],
		} as PromptRequest);
		await Bun.sleep(0);

		const emit = (event: AgentSessionEvent): void => {
			for (const listener of session.listeners()) listener(event);
		};
		emit({
			type: "tool_execution_start",
			toolCallId: "degraded-eval",
			toolName: "eval",
			args: { code: "1+1" },
			progressProtocol: "legacy_snapshot",
		} as AgentSessionEvent);
		emit({
			type: "tool_execution_end",
			toolCallId: "degraded-eval",
			toolName: "eval",
			isError: false,
			// A well-formed envelope whose `details` fail `evalDetailsSchema`.
			result: {
				content: [{ type: "text", text: "salvaged eval output" }],
				details: { cells: "three" },
			},
			progressProtocol: "legacy_snapshot",
		} as AgentSessionEvent);

		finishPrompt();
		await expect(prompt).resolves.toMatchObject({ stopReason: "end_turn" });
		const end = harness.updates
			.map(notification => notification.update)
			.find(
				update =>
					update.sessionUpdate === "tool_call_update" &&
					update.toolCallId === "degraded-eval" &&
					"status" in update &&
					update.status === "completed",
			);
		expect(end).toBeDefined();
		expect(JSON.stringify(harness.updates)).toContain("salvaged eval output");

		harness.abortController.abort();
		await Bun.sleep(0);
	});
	it("publishes only the final settled body for legacy bash progress, never a duplicated or lossy live delta", async () => {
		const harness = await createHarness({ terminalMeta: true });
		const created = await harness.agent.newSession({ cwd: harness.cwdA, mcpServers: [] });

		const session = harness.findSession(created.sessionId)!;
		session.registerBuiltinTool("bash");
		const finishPrompt = holdPromptStreaming(session);
		const prompt = harness.agent.prompt({
			sessionId: created.sessionId,
			messageId: "00000000-0000-4000-8000-000000000088",
			prompt: [{ type: "text", text: "cumulative legacy bash" }],
		} as PromptRequest);
		await Bun.sleep(0);

		const args = { command: "print-progressively" };
		const emit = (event: AgentSessionEvent): void => {
			for (const listener of session.listeners()) listener(event);
		};
		emit({
			type: "tool_execution_start",
			toolCallId: "cumulative-bash",
			toolName: "bash",
			args,
			progressProtocol: "legacy_snapshot",
		} as AgentSessionEvent);
		// A bounded tail window slides on every chunk (`TailBuffer`): none of
		// these three snapshots is a prefix extension of the last, so an
		// append-the-whole-thing publish would duplicate ("abcde" + "bcdef" +
		// "cdefg") and a prefix-diff against the previous snapshot would
		// permanently lose "fg" the instant the window first slides.
		for (const snapshot of ["abcde", "bcdef", "cdefg"]) {
			emit({
				type: "tool_execution_update",
				toolCallId: "cumulative-bash",
				toolName: "bash",
				args,
				partialResult: { content: [{ type: "text", text: snapshot }], details: {} },
			} as AgentSessionEvent);
		}
		emit({
			type: "tool_execution_end",
			toolCallId: "cumulative-bash",
			toolName: "bash",
			isError: false,
			result: { content: [{ type: "text", text: "cdefgh" }], details: { exitCode: 0 } },
			progressProtocol: "legacy_snapshot",
		} as AgentSessionEvent);

		finishPrompt();
		await expect(prompt).resolves.toMatchObject({ stopReason: "end_turn" });
		const terminalOutputs = harness.updates
			.map(notification => notification.update)
			.filter(
				(update): update is Extract<typeof update, { toolCallId: string }> =>
					"toolCallId" in update && update.toolCallId === "cumulative-bash",
			)
			.map(update =>
				"_meta" in update
					? (update._meta as { terminal_output?: { data?: string } } | undefined)?.terminal_output?.data
					: undefined,
			)
			.filter((data): data is string => typeof data === "string");
		// None of the three intermediate snapshots produced a live delta — a
		// bounded rolling snapshot cannot be safely diffed without either
		// duplicating or losing bytes, so this adapter never tries.
		// Settlement is the single publish, carrying the true final body byte
		// for byte, with nothing lost from the window sliding underneath it.
		expect(terminalOutputs).toEqual(["cdefgh"]);

		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("does not resolve prompt() before queued tool frames reach a slow writer", async () => {
		// The reducer enqueues frame batches fire-and-forget (delivery order is the
		// coordinator's job). Without an explicit drain the ACP response overtook the
		// settlement frame that describes the turn's own result.
		const harness = await createHarness({ terminalMeta: true, writeDelayMs: 15 });
		const created = await harness.agent.newSession({ cwd: harness.cwdA, mcpServers: [] });
		const session = harness.findSession(created.sessionId)!;
		const finishPrompt = holdPromptStreaming(session);

		const prompt = harness.agent.prompt({
			sessionId: created.sessionId,
			messageId: "00000000-0000-4000-8000-000000000072",
			prompt: [{ type: "text", text: "run a command" }],
		} as PromptRequest);
		await Bun.sleep(0);

		const emit = (event: AgentSessionEvent): void => {
			for (const listener of session.listeners()) listener(event);
		};
		emit({
			type: "tool_presentation",
			toolCallId: "slow-call",
			toolName: "bash",
			event: {
				type: "started",
				call: { toolCallId: "slow-call", toolName: "bash", title: "echo hi", kind: "execute" },
			},
		} as AgentSessionEvent);
		emit({
			type: "tool_presentation",
			toolCallId: "slow-call",
			toolName: "bash",
			event: { type: "settled", outcome: { kind: "succeeded" } },
		} as AgentSessionEvent);

		finishPrompt();
		await prompt;

		// Snapshot immediately after the response resolves — no extra sleep, which is
		// exactly what a client sees.
		expect(harness.writes).toContain("tool_call:slow-call");
		expect(harness.writes).toContain("tool_call_update:slow-call");
		const settlement = harness.updates.find(
			update => (update.update as { toolCallId?: string; status?: string }).status === "completed",
		);
		expect((settlement?.update as { _meta?: { terminal_exit?: unknown } } | undefined)?._meta?.terminal_exit).toEqual(
			{ terminal_id: "slow-call", exit_code: 0, signal: null },
		);

		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("releases a client terminal only after slow-writer settlement delivery for normal, timeout, and cancellation", async () => {
		const cases = [
			{
				name: "normal",
				fact: { kind: "wall_time", ms: 12 } as const,
				outcome: { kind: "succeeded", process: { kind: "exited", code: 0 } } as const,
				status: "completed",
			},
			{
				name: "timeout",
				fact: { kind: "stop_annotation", text: "Command timed out after 1 seconds" } as const,
				outcome: {
					kind: "failed",
					failure: { reason: "process", message: "Command timed out after 1 seconds" },
					process: { kind: "timed_out", timeoutMs: 1_000 },
				} as const,
				status: "failed",
			},
			{
				name: "cancellation",
				fact: { kind: "stop_annotation", text: "[Command aborted]" } as const,
				outcome: { kind: "interrupted", reason: "User interrupted the run" } as const,
				status: "failed",
			},
		] as const;

		for (const scenario of cases) {
			const harness = await createHarness({ terminalMeta: true, terminal: true, writeDelayMs: 15 });
			const created = await harness.agent.newSession({ cwd: harness.cwdA, mcpServers: [] });
			const session = harness.findSession(created.sessionId)!;
			const bridge = session.clientBridge;
			if (!bridge?.createTerminal) throw new Error("expected the ACP client terminal bridge");
			const toolCallId = `release-${scenario.name}`;
			const terminal = await bridge.createTerminal({ toolCallId, command: "/bin/sh" });
			const finishPrompt = holdPromptStreaming(session);
			const prompt = harness.agent.prompt({
				sessionId: created.sessionId,
				messageId: `00000000-0000-4000-8000-00000000008${cases.indexOf(scenario)}`,
				prompt: [{ type: "text", text: scenario.name }],
			} as PromptRequest);
			await Bun.sleep(0);

			const emit = (event: AgentSessionEvent): void => {
				for (const listener of session.listeners()) listener(event);
			};
			const producer = new ToolPresentationStream(streamId(toolCallId), event =>
				emit({ type: "tool_presentation", toolCallId, toolName: "bash", event } as AgentSessionEvent),
			);
			emit({
				type: "tool_presentation",
				toolCallId,
				toolName: "bash",
				event: {
					type: "started",
					call: { toolCallId, toolName: "bash", title: "sleep 1", kind: "execute", awaitsLiveTerminal: true },
				},
			} as AgentSessionEvent);
			producer.attachLiveTerminal(createLiveTerminalBinding(terminal.terminalId));
			producer.fact(scenario.fact);
			await producer.freeze();
			emit({
				type: "tool_presentation",
				toolCallId,
				toolName: "bash",
				event: { type: "settled", outcome: scenario.outcome },
			} as AgentSessionEvent);

			finishPrompt();
			await prompt;
			const releaseAt = harness.writes.indexOf("release_terminal:client-term-1");
			expect(releaseAt).toBeGreaterThan(-1);
			const finalUpdateAt = harness.writes.lastIndexOf(`tool_call_update:${toolCallId}`);
			expect(releaseAt).toBeGreaterThan(finalUpdateAt);
			const settlement = harness.updates.find(
				update =>
					(update.update as { toolCallId?: string; status?: string }).toolCallId === toolCallId &&
					(update.update as { status?: string }).status === scenario.status,
			);
			expect(settlement).toBeDefined();
			expect(
				(settlement?.update as { _meta?: { terminal_exit?: { terminal_id?: string } } } | undefined)?._meta
					?.terminal_exit?.terminal_id,
			).toBe("client-term-1");
			harness.abortController.abort();
			await Bun.sleep(0);
		}
	});

	it("bounds a hung raw ACP terminal release after settlement without blocking prompt delivery", async () => {
		// This exercises the actual ACP bridge hand-off: the raw terminal/release hook
		// never resolves, so an unbounded await in the final FIFO task would leave both
		// the queued assistant write and prompt() permanently blocked.
		const neverRelease = new Promise<void>(() => {});
		const harness = await createHarness({
			terminalMeta: true,
			terminal: true,
			writeDelayMs: 15,
			terminalRelease: () => neverRelease,
		});
		const created = await harness.agent.newSession({ cwd: harness.cwdA, mcpServers: [] });
		const session = harness.findSession(created.sessionId)!;
		const bridge = session.clientBridge;
		if (!bridge?.createTerminal) throw new Error("expected the ACP client terminal bridge");
		const toolCallId = "hung-release";
		const terminal = await bridge.createTerminal({ toolCallId, command: "/bin/sh" });
		const finishPrompt = holdPromptStreaming(session);
		const prompt = harness.agent.prompt({
			sessionId: created.sessionId,
			messageId: "00000000-0000-4000-8000-000000000083",
			prompt: [{ type: "text", text: "hung release" }],
		} as PromptRequest);
		await Bun.sleep(0);

		const emit = (event: AgentSessionEvent): void => {
			for (const listener of session.listeners()) listener(event);
		};
		const producer = new ToolPresentationStream(streamId(toolCallId), event =>
			emit({ type: "tool_presentation", toolCallId, toolName: "bash", event } as AgentSessionEvent),
		);
		emit({
			type: "tool_presentation",
			toolCallId,
			toolName: "bash",
			event: {
				type: "started",
				call: { toolCallId, toolName: "bash", title: "sleep 1", kind: "execute", awaitsLiveTerminal: true },
			},
		} as AgentSessionEvent);
		producer.attachLiveTerminal(createLiveTerminalBinding(terminal.terminalId));
		producer.fact({ kind: "wall_time", ms: 12 });
		await producer.freeze();
		emit({
			type: "tool_presentation",
			toolCallId,
			toolName: "bash",
			event: { type: "settled", outcome: { kind: "succeeded", process: { kind: "exited", code: 0 } } },
		} as AgentSessionEvent);

		finishPrompt();
		expect(await Promise.race([prompt.then(() => "completed"), Bun.sleep(2_500).then(() => "timed_out")])).toBe(
			"completed",
		);
		const releaseAt = harness.writes.indexOf("release_terminal:client-term-1");
		const finalUpdateAt = harness.writes.lastIndexOf(`tool_call_update:${toolCallId}`);
		expect(releaseAt).toBeGreaterThan(finalUpdateAt);
		expect(harness.writes).toContain("agent_message_chunk");

		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("tears the managed session down when an outbound write fails", async () => {
		// Poisoning is terminal for the session, and the teardown has exactly one owner.
		// The earlier hand-rolled rejection left the subscription installed, the prompt
		// slot occupied and — worst — the record in `#sessions` holding a permanently
		// poisoned coordinator, so the next prompt subscribed again and had every frame
		// rejected without a wire attempt.
		const failure = new Error("connection closed");
		const harness = await createHarness({
			terminalMeta: true,
			failWrite: notification =>
				(notification.update as { sessionUpdate?: string }).sessionUpdate === "tool_call_update"
					? failure
					: undefined,
		});
		const created = await harness.agent.newSession({ cwd: harness.cwdA, mcpServers: [] });
		const session = harness.findSession(created.sessionId)!;
		const finishPrompt = holdPromptStreaming(session);
		let aborts = 0;
		session.abort = async () => {
			aborts++;
			session.isStreaming = false;
		};
		// Deterministic teardown-completion signal: `#tearDownPoisonedSession` runs
		// fire-and-forget after `#finishPrompt` rejects the prompt, so awaiting the
		// prompt alone does not prove `dispose()` (and therefore `disposed`/listener
		// cleanup) has actually finished.
		const disposed = Promise.withResolvers<void>();
		const originalDispose = session.dispose.bind(session);
		session.dispose = async () => {
			await originalDispose();
			disposed.resolve();
		};

		const prompt = harness.agent
			.prompt({
				sessionId: created.sessionId,
				messageId: "00000000-0000-4000-8000-000000000073",
				prompt: [{ type: "text", text: "run a command" }],
			} as PromptRequest)
			.then(
				() => "resolved",
				(error: unknown) => error,
			);
		await Bun.sleep(0);

		const emit = (event: AgentSessionEvent): void => {
			for (const listener of session.listeners()) listener(event);
		};
		emit({
			type: "tool_presentation",
			toolCallId: "poison-call",
			toolName: "bash",
			event: {
				type: "started",
				call: { toolCallId: "poison-call", toolName: "bash", title: "echo hi", kind: "execute" },
			},
		} as AgentSessionEvent);
		await harness.waitForWrite("tool_call:poison-call");
		expect(harness.writes).toEqual(["tool_call:poison-call"]);

		// The settlement write fails.
		emit({
			type: "tool_presentation",
			toolCallId: "poison-call",
			toolName: "bash",
			event: { type: "settled", outcome: { kind: "succeeded" } },
		} as AgentSessionEvent);

		// The active prompt is rejected exactly once, with the send failure.
		expect(await prompt).toBe(failure);
		// Wait for the managed teardown this poison triggers, not a fixed duration.
		await disposed.promise;
		// The session was aborted through the managed path and disposed, so its lifetime
		// subscription is gone too.
		expect(aborts).toBe(1);
		expect(session.disposed).toBe(true);
		expect(session.listeners()).toHaveLength(0);

		// No later write is even attempted. Listeners are already empty, so this emit
		// is synchronously a no-op — no wait needed to prove nothing was attempted.
		const writesAfterPoison = harness.writes.length;
		emit({
			type: "tool_presentation",
			toolCallId: "later-call",
			toolName: "bash",
			event: {
				type: "started",
				call: { toolCallId: "later-call", toolName: "bash", title: "echo later", kind: "execute" },
			},
		} as AgentSessionEvent);
		expect(harness.writes).toHaveLength(writesAfterPoison);

		// And a subsequent prompt cannot silently reuse the poisoned coordinator.
		await expect(
			harness.agent.prompt({
				sessionId: created.sessionId,
				messageId: "00000000-0000-4000-8000-000000000074",
				prompt: [{ type: "text", text: "try again" }],
			} as PromptRequest),
		).rejects.toThrow();

		finishPrompt();
		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("poisons the queue and rejects the prompt when the frame encoder rejects a reduced frame", async () => {
		// Same failure class and same required outcome as an outbound write failure,
		// but triggered *before* any write is attempted: the reducer accepts a
		// malformed `started` call (it does not validate `kind`), and the encoder's
		// own runtime assertion — real, not weakened for this test — rejects the
		// resulting announce frame for missing `kind`. That must poison the queue
		// exactly like a transport failure, not just get logged while the prompt
		// finishes as though delivery had succeeded.
		const harness = await createHarness({ terminalMeta: true });
		const created = await harness.agent.newSession({ cwd: harness.cwdA, mcpServers: [] });
		const session = harness.findSession(created.sessionId)!;
		const finishPrompt = holdPromptStreaming(session);
		let aborts = 0;
		session.abort = async () => {
			aborts++;
			session.isStreaming = false;
		};
		// Deterministic teardown-completion signal — see the identical pattern in
		// "tears the managed session down when an outbound write fails" above.
		const disposed = Promise.withResolvers<void>();
		const originalDispose = session.dispose.bind(session);
		session.dispose = async () => {
			await originalDispose();
			disposed.resolve();
		};

		const prompt = harness.agent
			.prompt({
				sessionId: created.sessionId,
				messageId: "00000000-0000-4000-8000-000000000075",
				prompt: [{ type: "text", text: "run a command" }],
			} as PromptRequest)
			.then(
				() => "resolved",
				(error: unknown) => error,
			);
		await Bun.sleep(0);

		const emit = (event: AgentSessionEvent): void => {
			for (const listener of session.listeners()) listener(event);
		};
		const writesBeforeMalformedEvent = harness.writes.length;
		emit({
			type: "tool_presentation",
			toolCallId: "malformed-call",
			toolName: "bash",
			event: {
				type: "started",
				call: { toolCallId: "malformed-call", toolName: "bash", title: "echo hi", kind: undefined as never },
			},
		} as AgentSessionEvent);

		// The prompt is rejected, not resolved as though the turn completed normally —
		// this is the deterministic completion signal for the whole encoder→poison→
		// finishPrompt chain triggered synchronously above.
		const outcome = await prompt;
		expect(outcome).not.toBe("resolved");
		expect(outcome).toBeInstanceOf(Error);
		// No write was attempted for the malformed announce; the encoder rejected it
		// before the coordinator ever saw a batch.
		expect(harness.writes.length).toBe(writesBeforeMalformedEvent);
		// Teardown follows the existing single-owner poison path — same as a
		// transport failure — not a bespoke recovery for encoder errors. Wait for the
		// managed teardown itself, not a fixed duration: `#tearDownPoisonedSession`
		// runs fire-and-forget after the prompt already rejected.
		await disposed.promise;
		expect(aborts).toBe(1);
		expect(session.disposed).toBe(true);
		expect(session.listeners()).toHaveLength(0);

		// No later write is even attempted, for an unrelated, well-formed call. Listeners
		// are already empty, so this emit is synchronously a no-op — no wait needed.
		const writesAfterPoison = harness.writes.length;
		emit({
			type: "tool_presentation",
			toolCallId: "later-call",
			toolName: "bash",
			event: {
				type: "started",
				call: { toolCallId: "later-call", toolName: "bash", title: "echo later", kind: "execute" },
			},
		} as AgentSessionEvent);
		expect(harness.writes).toHaveLength(writesAfterPoison);

		// A subsequent prompt cannot silently reuse the poisoned coordinator.
		await expect(
			harness.agent.prompt({
				sessionId: created.sessionId,
				messageId: "00000000-0000-4000-8000-000000000076",
				prompt: [{ type: "text", text: "try again" }],
			} as PromptRequest),
		).rejects.toThrow();

		finishPrompt();
		harness.abortController.abort();
		await Bun.sleep(0);
	});
	it("keeps reducing a started tool call to its terminal exit after cancel", async () => {
		// Cancellation resolves the ACP response immediately, but a tool call that
		// already announced itself must still reach its one `settled` event: otherwise
		// its card and its display-only terminal stay "running" forever. Ordinary
		// assistant content is still suppressed — that is what the cancel asked for.
		const harness = await createHarness({ terminalMeta: true });
		const created = await harness.agent.newSession({ cwd: harness.cwdA, mcpServers: [] });
		const session = harness.findSession(created.sessionId)!;
		let releaseAbort!: () => void;
		const abortBlocked = Promise.withResolvers<void>();
		const abortReleased = new Promise<void>(resolve => {
			releaseAbort = resolve;
		});
		session.abort = async () => {
			session.isStreaming = false;
			abortBlocked.resolve();
			await abortReleased;
		};
		const finishPrompt = holdPromptStreaming(session);

		const firstPrompt = harness.agent.prompt({
			sessionId: created.sessionId,
			messageId: "00000000-0000-4000-8000-000000000061",
			prompt: [{ type: "text", text: "cancel mid-tool" }],
		} as PromptRequest);
		await Bun.sleep(0);

		const emit = (event: AgentSessionEvent): void => {
			for (const listener of session.listeners()) listener(event);
		};
		// The call announces itself before the cancel lands.
		emit({
			type: "tool_presentation",
			toolCallId: "cleanup-call",
			toolName: "bash",
			event: {
				type: "started",
				call: { toolCallId: "cleanup-call", toolName: "bash", title: "sleep 20", kind: "execute" },
			},
		} as AgentSessionEvent);
		await Bun.sleep(5);
		expect(
			harness.updates.some(update => (update.update as { sessionUpdate?: string }).sessionUpdate === "tool_call"),
		).toBe(true);

		const cancelPrompt = harness.agent.cancel({ sessionId: created.sessionId });
		await abortBlocked.promise;
		expect((await firstPrompt).stopReason).toBe("cancelled");

		const afterCancel = harness.updates.length;
		// Assistant prose after the cancel stays suppressed...
		emit({
			type: "message_update",
			message: makeAssistantMessage("late"),
			assistantMessageEvent: { type: "text_delta", delta: "late" },
		} as AgentSessionEvent);
		// ...while the tool call's settlement is still delivered.
		emit({
			type: "tool_presentation",
			toolCallId: "cleanup-call",
			toolName: "bash",
			event: { type: "settled", outcome: { kind: "interrupted", reason: "User interrupted the run" } },
		} as AgentSessionEvent);
		await Bun.sleep(20);

		const cleanupFrames = harness.updates.slice(afterCancel);
		expect(cleanupFrames).toHaveLength(1);
		const settlement = cleanupFrames[0]?.update as unknown as {
			sessionUpdate: string;
			status: string;
			_meta: { terminal_exit: { terminal_id: string; exit_code: number | null; signal: string | null } };
		};
		expect(settlement.sessionUpdate).toBe("tool_call_update");
		// Status and terminal exit arrive together, in one frame — never split.
		expect(settlement.status).toBe("failed");
		expect(settlement._meta.terminal_exit).toEqual({
			terminal_id: "cleanup-call",
			exit_code: null,
			signal: null,
		});

		releaseAbort();
		await cancelPrompt;
		finishPrompt();
		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("closes the ACP session when cancel cleanup times out", async () => {
		const harness = await createHarness();
		const created = await harness.agent.newSession({ cwd: harness.cwdA, mcpServers: [] });
		const session = harness.findSession(created.sessionId)!;
		harness.agent.setCancelCleanupTimeoutForTesting(10);
		session.abort = async () => new Promise<void>(() => undefined);
		const finishPrompt = holdPromptStreaming(session);

		const firstPrompt = harness.agent.prompt({
			sessionId: created.sessionId,
			messageId: "00000000-0000-4000-8000-000000000041",
			prompt: [{ type: "text", text: "stuck cancel" }],
		} as PromptRequest);
		await Bun.sleep(0);

		const cancelPrompt = harness.agent.cancel({ sessionId: created.sessionId });
		const returnedBeforeTimeout = await Promise.race([firstPrompt.then(() => true), Bun.sleep(0).then(() => false)]);
		expect(returnedBeforeTimeout).toBe(true);
		await expect(cancelPrompt).resolves.toBeUndefined();
		expect(session.disposed).toBe(true);
		await expect(
			harness.agent.prompt({
				sessionId: created.sessionId,
				messageId: "00000000-0000-4000-8000-000000000042",
				prompt: [{ type: "text", text: "after stuck cancel" }],
			} as PromptRequest),
		).rejects.toThrow("Unsupported ACP session");

		finishPrompt();
		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("rejects a queued prompt when cancel cleanup closes the session", async () => {
		const harness = await createHarness();
		const created = await harness.agent.newSession({ cwd: harness.cwdA, mcpServers: [] });
		const session = harness.findSession(created.sessionId)!;
		harness.agent.setCancelCleanupTimeoutForTesting(10);
		session.abort = async () => new Promise<void>(() => undefined);
		const finishPrompt = holdPromptStreaming(session);

		const firstPrompt = harness.agent.prompt({
			sessionId: created.sessionId,
			messageId: "00000000-0000-4000-8000-000000000043",
			prompt: [{ type: "text", text: "stuck cancel before queued" }],
		} as PromptRequest);
		await Bun.sleep(0);

		const cancelPrompt = harness.agent.cancel({ sessionId: created.sessionId });
		await firstPrompt;
		const queuedPrompt = harness.agent
			.prompt({
				sessionId: created.sessionId,
				messageId: "00000000-0000-4000-8000-000000000044",
				prompt: [{ type: "text", text: "queued after stuck cancel" }],
			} as PromptRequest)
			.catch(error => error);

		await cancelPrompt;
		const queuedError = await queuedPrompt;
		expect(queuedError).toBeInstanceOf(Error);
		expect(queuedError.message).toBe("ACP cancel cleanup timed out");
		expect(session.promptCalls).toEqual(["stuck cancel before queued"]);

		finishPrompt();
		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("maps agent-busy rejections to a typed session_busy error instead of internalError", async () => {
		const harness = await createHarness();
		const created = await harness.agent.newSession({ cwd: harness.cwdA, mcpServers: [] });
		const session = harness.findSession(created.sessionId)!;
		// Autonomous turns stream without an owning ACP promptTurn, so prompt()'s
		// implicit-cancel guard never fires. Mirror AgentSession's contract: a
		// bare prompt while streaming throws AgentBusyError.
		session.isStreaming = true;
		session.prompt = async (): Promise<boolean> => {
			if (session.isStreaming) throw new AgentBusyError();
			return true;
		};

		const error = await harness.agent
			.prompt({
				sessionId: created.sessionId,
				prompt: [{ type: "text", text: "ping during autonomous turn" }],
			} as PromptRequest)
			.catch((reason: unknown) => reason);

		expect(error).toBeInstanceOf(RequestError);
		const requestError = error as RequestError;
		expect(requestError.code).toBe(-32003);
		expect(requestError.message).toContain("already processing");
		expect(requestError.data).toEqual({ reason: "session_busy", hint: "steer|followUp|wait" });
	});

	it("keeps closeSession gated while cancel cleanup is pending", async () => {
		const harness = await createHarness();
		const created = await harness.agent.newSession({ cwd: harness.cwdA, mcpServers: [] });
		const session = harness.findSession(created.sessionId)!;
		let releaseAbort!: () => void;
		const abortBlocked = Promise.withResolvers<void>();
		const releaseAbortPromise = new Promise<void>(resolve => {
			releaseAbort = resolve;
		});
		session.abort = async () => {
			session.isStreaming = false;
			abortBlocked.resolve();
			await releaseAbortPromise;
		};
		const finishPrompt = holdPromptStreaming(session);

		const firstPrompt = harness.agent.prompt({
			sessionId: created.sessionId,
			messageId: "00000000-0000-4000-8000-000000000045",
			prompt: [{ type: "text", text: "cancel before close" }],
		} as PromptRequest);
		await Bun.sleep(0);

		const cancelPrompt = harness.agent.cancel({ sessionId: created.sessionId });
		await abortBlocked.promise;
		await firstPrompt;

		const closePrompt = harness.agent.closeSession({ sessionId: created.sessionId });
		await Bun.sleep(0);
		expect(session.disposed).toBe(false);

		releaseAbort();
		await cancelPrompt;
		await closePrompt;
		expect(session.disposed).toBe(true);

		finishPrompt();
		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("rejects fork while cancel cleanup is pending", async () => {
		const harness = await createHarness();
		const created = await harness.agent.newSession({ cwd: harness.cwdA, mcpServers: [] });
		const session = harness.findSession(created.sessionId)!;
		let releaseAbort!: () => void;
		const abortBlocked = Promise.withResolvers<void>();
		const releaseAbortPromise = new Promise<void>(resolve => {
			releaseAbort = resolve;
		});
		session.abort = async () => {
			session.isStreaming = false;
			abortBlocked.resolve();
			await releaseAbortPromise;
		};
		const finishPrompt = holdPromptStreaming(session);

		const firstPrompt = harness.agent.prompt({
			sessionId: created.sessionId,
			messageId: "00000000-0000-4000-8000-000000000046",
			prompt: [{ type: "text", text: "cancel before fork" }],
		} as PromptRequest);
		await Bun.sleep(0);

		const cancelPrompt = harness.agent.cancel({ sessionId: created.sessionId });
		await abortBlocked.promise;
		await firstPrompt;

		await expect(
			harness.agent.unstable_forkSession({
				sessionId: created.sessionId,
				cwd: harness.cwdA,
				mcpServers: [],
			}),
		).rejects.toThrow("ACP session fork is unavailable while a prompt is in progress");

		releaseAbort();
		await cancelPrompt;
		finishPrompt();
		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("executes consumed ACP builtins without prompting the agent", async () => {
		const harness = await createHarness();
		const created = await harness.agent.newSession({ cwd: harness.cwdA, mcpServers: [] });
		const session = harness.findSession(created.sessionId)!;

		await harness.agent.prompt({
			sessionId: created.sessionId,
			prompt: [{ type: "text", text: "/fast status" }],
		});

		const chunks = harness.updates.filter(
			update => update.sessionId === created.sessionId && update.update.sessionUpdate === "agent_message_chunk",
		);
		expect(session.promptCalls).toEqual([]);
		expect(
			chunks.some(
				update =>
					update.update.sessionUpdate === "agent_message_chunk" &&
					update.update.content.type === "text" &&
					update.update.content.text === "Fast mode is off.",
			),
		).toBe(true);

		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("executes force builtins and forwards remaining prompt text", async () => {
		const harness = await createHarness();
		const created = await harness.agent.newSession({ cwd: harness.cwdA, mcpServers: [] });
		const session = harness.findSession(created.sessionId)!;

		await harness.agent.prompt({
			sessionId: created.sessionId,
			messageId: "00000000-0000-4000-8000-000000000003",
			prompt: [{ type: "text", text: "/force read inspect package.json" }],
		} as PromptRequest);

		expect(session.forcedToolChoice).toBe("read");
		expect(session.promptCalls).toEqual(["inspect package.json"]);

		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("settles the prompt turn when a force residual prompt resolves locally (#9206)", async () => {
		const harness = await createHarness();
		const created = await harness.agent.newSession({ cwd: harness.cwdA, mcpServers: [] });
		const session = harness.findSession(created.sessionId)!;

		// The residual prompt (e.g. an extension/custom-TS command) is handled
		// locally: no agent turn starts, so `prompt()` returns false and no
		// `agent_end` ever fires. The ACP turn must be settled by the trailing
		// `#finishPrompt`, or the `session/prompt` request never resolves.
		session.prompt = async (text: string): Promise<boolean> => {
			session.promptCalls.push(text);
			return false;
		};

		const response = await harness.agent.prompt({
			sessionId: created.sessionId,
			messageId: "00000000-0000-4000-8000-000000000009",
			prompt: [{ type: "text", text: "/force bash /local-command" }],
		} as PromptRequest);

		expectAcpStructure(zPromptResponse, response);
		expect(response.stopReason).toBe("end_turn");
		expect(session.forcedToolChoice).toBe("bash");
		expect(session.promptCalls).toEqual(["/local-command"]);

		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("installs the tool UI context when form elicitation is available", async () => {
		const harness = await createHarness({ clientCapabilities: { elicitation: { form: {} } } });
		const session = await harness.agent.newSession({ cwd: harness.cwdA, mcpServers: [] });
		await harness.agent.prompt({
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: "ping" }],
		} as PromptRequest);

		expect(harness.sessionFactoryOptions).toEqual([{ interactivePrompts: true }]);
		expect(harness.setToolUIContextSpies).toHaveLength(1);
		expect(harness.setToolUIContextSpies[0]).toHaveBeenCalledTimes(1);
		expect(harness.setToolUIContextSpies[0]).toHaveBeenCalledWith(
			expect.objectContaining({ askDialog: expect.any(Function) }),
			true,
		);

		await harness.agent.dispose();
	});

	it("does not install the tool UI context without form elicitation", async () => {
		const harness = await createHarness({ clientCapabilities: {} });
		const session = await harness.agent.newSession({ cwd: harness.cwdA, mcpServers: [] });
		await harness.agent.prompt({
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: "ping" }],
		} as PromptRequest);

		expect(harness.sessionFactoryOptions).toEqual([{ interactivePrompts: false }]);
		expect(harness.setToolUIContextSpies).toHaveLength(1);
		expect(harness.setToolUIContextSpies[0]).not.toHaveBeenCalled();

		await harness.agent.dispose();
	});

	describe("ACP elicitation bridge", () => {
		const FORM_CAPABILITIES: ClientCapabilities = { elicitation: { form: {} } };

		function createElicitConnection(handler: (req: CreateElicitationRequest) => Promise<CreateElicitationResponse>): {
			connection: AgentSideConnection;
			calls: CreateElicitationRequest[];
		} {
			const calls: CreateElicitationRequest[] = [];
			const connection = {
				unstable_createElicitation: async (req: CreateElicitationRequest) => {
					calls.push(req);
					return handler(req);
				},
			} as unknown as AgentSideConnection;
			return { connection, calls };
		}

		/** Narrows `CreateElicitationRequest` to the `mode: "form"` branch; the SDK's `mode: string` catch-all arm otherwise defeats literal narrowing on `mode !== "form"`. */
		function isFormElicitation(
			request: CreateElicitationRequest,
		): request is Extract<CreateElicitationRequest, { mode: "form" }> {
			return request.mode === "form";
		}
		it("translates a recommended single-choice ask into one form", async () => {
			const { connection, calls } = createElicitConnection(async () => ({
				action: "accept",
				content: { q0: "Approach B" },
			}));
			const ctx = createAcpExtensionUiContext(connection, () => "session-ask-single", FORM_CAPABILITIES);

			const result = await ctx.askDialog!([
				{
					id: "approach",
					question: "Which approach?",
					header: "Choose one",
					options: [
						{ label: "Approach A", description: "Faster" },
						{ label: "Approach B", description: "Safer" },
					],
					recommended: 0,
				},
			]);

			expect(calls).toHaveLength(1);
			const request = calls[0]!;
			if (!isFormElicitation(request)) throw new Error("expected form-mode elicitation");
			expect(request.message).toBe("Which approach?");
			expect(request.requestedSchema.required).toBeUndefined();
			expect(request.requestedSchema.properties.q0).toEqual({
				type: "string",
				title: "Which approach?",
				description: "Choose one",
				oneOf: [
					{ const: "Approach A", title: "Approach A", description: "Faster" },
					{ const: "Approach B", title: "Approach B", description: "Safer" },
				],
				default: "Approach A",
			});
			expect(request.requestedSchema.properties.q0__other).toEqual({
				type: "string",
				title: "Other (type your own)",
			});
			expect(result).toEqual({
				kind: "submit",
				results: [
					{
						id: "approach",
						question: "Which approach?",
						options: ["Approach A", "Approach B"],
						multi: false,
						selectedOptions: ["Approach B"],
						customInput: undefined,
					},
				],
			});
		});

		it("translates a multi-select ask into an array anyOf schema", async () => {
			const { connection, calls } = createElicitConnection(async () => ({
				action: "accept",
				content: { q0: ["A", "C"] },
			}));
			const ctx = createAcpExtensionUiContext(connection, () => "session-ask-multi", FORM_CAPABILITIES);

			const result = await ctx.askDialog!([
				{
					id: "features",
					question: "Which features?",
					options: [{ label: "A" }, { label: "B" }, { label: "C" }],
					multi: true,
				},
			]);

			expect(calls).toHaveLength(1);
			const request = calls[0]!;
			if (!isFormElicitation(request)) throw new Error("expected form-mode elicitation");
			expect(request.requestedSchema.properties.q0).toEqual({
				type: "array",
				title: "Which features?",
				items: {
					anyOf: [
						{ const: "A", title: "A" },
						{ const: "B", title: "B" },
						{ const: "C", title: "C" },
					],
				},
			});
			expect(result?.kind === "submit" ? result.results[0]?.selectedOptions : undefined).toEqual(["A", "C"]);
		});

		it("accepts a trimmed free-text-only ask response", async () => {
			const { connection } = createElicitConnection(async () => ({
				action: "accept",
				content: { q0__other: "  widget " },
			}));
			const ctx = createAcpExtensionUiContext(connection, () => "session-ask-other", FORM_CAPABILITIES);

			const result = await ctx.askDialog!([
				{ id: "widget", question: "Which widget?", options: [{ label: "Standard" }] },
			]);

			expect(result?.kind === "submit" ? result.results[0] : undefined).toMatchObject({
				selectedOptions: [],
				customInput: "widget",
			});
		});
		it("treats a single-choice custom answer as exclusive", async () => {
			const { connection } = createElicitConnection(async () => ({
				action: "accept",
				content: { q0: "Standard", q0__other: "custom" },
			}));
			const ctx = createAcpExtensionUiContext(connection, () => "session-ask-exclusive-other", FORM_CAPABILITIES);

			const result = await ctx.askDialog!([
				{ id: "widget", question: "Which widget?", options: [{ label: "Standard" }] },
			]);

			expect(result?.kind === "submit" ? result.results[0] : undefined).toMatchObject({
				selectedOptions: [],
				customInput: "custom",
			});
		});

		it("uses only free-text fields for questions without options", async () => {
			const { connection, calls } = createElicitConnection(async () => ({
				action: "accept",
				content: { q0__other: "single answer", q1__other: "multi answer" },
			}));
			const ctx = createAcpExtensionUiContext(connection, () => "session-ask-no-options", FORM_CAPABILITIES);

			const result = await ctx.askDialog!([
				{ id: "single", question: "Single?", options: [] },
				{ id: "multi", question: "Multi?", options: [], multi: true },
			]);

			expect(calls).toHaveLength(1);
			const request = calls[0]!;
			if (!isFormElicitation(request)) throw new Error("expected form-mode elicitation");
			expect(Object.keys(request.requestedSchema.properties)).toEqual(["q0__other", "q1__other"]);
			expect(result?.kind === "submit" ? result.results : undefined).toMatchObject([
				{ id: "single", selectedOptions: [], customInput: "single answer" },
				{ id: "multi", selectedOptions: [], customInput: "multi answer" },
			]);
		});

		it("drops ask values the client was never offered", async () => {
			const { connection } = createElicitConnection(async () => ({
				action: "accept",
				content: { q0: "Nonexistent" },
			}));
			const ctx = createAcpExtensionUiContext(connection, () => "session-ask-invalid", FORM_CAPABILITIES);

			const result = await ctx.askDialog!([{ id: "choice", question: "Choose", options: [{ label: "Existing" }] }]);

			expect(result?.kind === "submit" ? result.results[0]?.selectedOptions : undefined).toEqual([]);
		});

		it("packs multiple ask questions into one ordered form", async () => {
			const { connection, calls } = createElicitConnection(async () => ({
				action: "accept",
				content: { q0: "PostgreSQL", q1: ["auth", "search"] },
			}));
			const ctx = createAcpExtensionUiContext(connection, () => "session-ask-many", FORM_CAPABILITIES);

			const result = await ctx.askDialog!([
				{
					id: "storage",
					question: "Storage?",
					options: [{ label: "SQLite" }, { label: "PostgreSQL" }],
				},
				{
					id: "features",
					question: "Features?",
					options: [{ label: "auth" }, { label: "billing" }, { label: "search" }],
					multi: true,
				},
			]);

			expect(calls).toHaveLength(1);
			const request = calls[0]!;
			if (!isFormElicitation(request)) throw new Error("expected form-mode elicitation");
			expect(request.message).toBe("Answer 2 questions");
			expect(Object.keys(request.requestedSchema.properties)).toEqual(["q0", "q0__other", "q1", "q1__other"]);
			expect(result?.kind === "submit" ? result.results.map(item => item.id) : undefined).toEqual([
				"storage",
				"features",
			]);
			expect(result?.kind === "submit" ? result.results.map(item => item.selectedOptions) : undefined).toEqual([
				["PostgreSQL"],
				["auth", "search"],
			]);
		});

		it("returns undefined when an ask form is cancelled", async () => {
			const { connection } = createElicitConnection(async () => ({ action: "cancel" }));
			const ctx = createAcpExtensionUiContext(connection, () => "session-ask-cancel", FORM_CAPABILITIES);

			const result = await ctx.askDialog!([
				{ id: "choice", question: "Choose", options: [{ label: "A" }, { label: "B" }] },
			]);

			expect(result).toBeUndefined();
		});
		it("returns ordered fallback answers when an ask form times out", async () => {
			vi.useFakeTimers();
			try {
				const { promise: never } = Promise.withResolvers<CreateElicitationResponse>();
				const { connection } = createElicitConnection(() => never);
				const ctx = createAcpExtensionUiContext(connection, () => "session-ask-timeout", FORM_CAPABILITIES);
				const onTimeout = vi.fn();

				const pending = ctx.askDialog!(
					[
						{
							id: "choice",
							question: "Choose",
							options: [{ label: "A" }, { label: "B" }],
							recommended: 1,
						},
						{ id: "free-text", question: "Explain", options: [] },
					],
					{ timeout: 10, onTimeout },
				);
				await Promise.resolve();
				vi.advanceTimersByTime(10);
				await Promise.resolve();

				expect(await pending).toEqual({
					kind: "submit",
					results: [
						{
							id: "choice",
							question: "Choose",
							options: ["A", "B"],
							multi: false,
							selectedOptions: ["B"],
							customInput: undefined,
							timedOut: true,
						},
						{
							id: "free-text",
							question: "Explain",
							options: [],
							multi: false,
							selectedOptions: [],
							customInput: undefined,
							timedOut: true,
						},
					],
				});
				expect(onTimeout).toHaveBeenCalledTimes(1);
			} finally {
				vi.useRealTimers();
			}
		});

		it("translates select to a single-property string-enum elicitation", async () => {
			const { connection, calls } = createElicitConnection(async () => ({
				action: "accept",
				content: { value: "second" },
			}));
			const ctx = createAcpExtensionUiContext(connection, () => "session-select", FORM_CAPABILITIES);

			const result = await ctx.select("Pick one", ["first", "second", "third"]);

			expect(result).toBe("second");
			expect(calls).toHaveLength(1);
			const request = calls[0]!;
			expect(request.mode).toBe("form");
			expect(request.message).toBe("Pick one");
			if (!isFormElicitation(request) || !("sessionId" in request)) {
				throw new Error("expected session-scoped form elicitation");
			}
			expect(request.sessionId).toBe("session-select");
			expect(request.requestedSchema).toEqual({
				type: "object",
				properties: { value: { type: "string", enum: ["first", "second", "third"] } },
				required: ["value"],
			});
		});

		it("translates confirm to a boolean elicitation and returns the accepted value", async () => {
			const { connection, calls } = createElicitConnection(async () => ({
				action: "accept",
				content: { value: true },
			}));
			const ctx = createAcpExtensionUiContext(connection, () => "session-confirm", FORM_CAPABILITIES);

			const result = await ctx.confirm("Proceed?", "This will overwrite the file.");

			expect(result).toBe(true);
			expect(calls).toHaveLength(1);
			const request = calls[0]!;
			if (!isFormElicitation(request)) {
				throw new Error("expected form-mode elicitation");
			}
			expect(request.message).toBe("Proceed?\n\nThis will overwrite the file.");
			expect(request.requestedSchema.properties?.value).toEqual({ type: "boolean" });
			expect(request.requestedSchema.required).toEqual(["value"]);
		});

		it("translates input to a string elicitation and surfaces the placeholder as description", async () => {
			const { connection, calls } = createElicitConnection(async () => ({
				action: "accept",
				content: { value: "claude" },
			}));
			const ctx = createAcpExtensionUiContext(connection, () => "session-input", FORM_CAPABILITIES);

			const result = await ctx.input("Your name?", "e.g. claude");

			expect(result).toBe("claude");
			expect(calls).toHaveLength(1);
			const request = calls[0]!;
			if (!isFormElicitation(request)) {
				throw new Error("expected form-mode elicitation");
			}
			expect(request.message).toBe("Your name?");
			expect(request.requestedSchema.properties?.value).toEqual({
				type: "string",
				description: "e.g. claude",
			});
		});

		it("translates editor to a string elicitation with the prefill as default", async () => {
			const { connection, calls } = createElicitConnection(async () => ({
				action: "accept",
				content: { value: "Reviewing auth changes" },
			}));
			const ctx = createAcpExtensionUiContext(connection, () => "session-editor", FORM_CAPABILITIES);

			const result = await ctx.editor("Enter custom review instructions", "Review the following:\n\n");

			expect(result).toBe("Reviewing auth changes");
			expect(calls).toHaveLength(1);
			const request = calls[0]!;
			if (!isFormElicitation(request)) {
				throw new Error("expected form-mode elicitation");
			}
			expect(request.message).toBe("Enter custom review instructions");
			expect(request.requestedSchema.properties?.value).toEqual({
				type: "string",
				default: "Review the following:\n\n",
			});
		});

		it("omits default on editor only when the prefill is empty, but preserves whitespace-only prefill", async () => {
			const { connection, calls } = createElicitConnection(async () => ({
				action: "accept",
				content: { value: "text" },
			}));
			const ctx = createAcpExtensionUiContext(connection, () => "session-editor-empty", FORM_CAPABILITIES);

			await ctx.editor("Title", "");

			const emptyRequest = calls[0]!;
			if (!isFormElicitation(emptyRequest)) throw new Error("expected form-mode elicitation");
			expect(emptyRequest.requestedSchema.properties?.value).toEqual({ type: "string" });

			// Unlike `input`'s placeholder, `editor` prefill is the document being
			// edited: whitespace/blank lines are meaningful content, not absence,
			// so they must round-trip verbatim (matching the interactive/RPC
			// implementations, which set the editor's text to any truthy prefill).
			await ctx.editor("Title", "   ");

			const whitespaceRequest = calls[1]!;
			if (!isFormElicitation(whitespaceRequest)) throw new Error("expected form-mode elicitation");
			expect(whitespaceRequest.requestedSchema.properties?.value).toEqual({
				type: "string",
				default: "   ",
			});
		});

		it("returns undefined / false for decline and cancel actions", async () => {
			let nextAction: "decline" | "cancel" = "decline";
			const { connection } = createElicitConnection(async () => ({ action: nextAction }));
			const ctx = createAcpExtensionUiContext(connection, () => "session-cancel", FORM_CAPABILITIES);

			for (const action of ["decline", "cancel"] as const) {
				nextAction = action;
				expect(await ctx.select("X", ["a"])).toBeUndefined();
				expect(await ctx.confirm("X", "Y")).toBe(false);
				expect(await ctx.input("X")).toBeUndefined();
				expect(await ctx.editor("X")).toBeUndefined();
			}
		});

		it("falls back to the stubbed behaviour when the client does not advertise form elicitation", async () => {
			const { connection, calls } = createElicitConnection(async () => ({
				action: "accept",
				content: { value: "ignored" },
			}));
			const ctx = createAcpExtensionUiContext(connection, () => "session-nocaps", {});

			expect(await ctx.select("X", ["a"])).toBeUndefined();
			expect(await ctx.confirm("X", "Y")).toBe(false);
			expect(await ctx.input("X")).toBeUndefined();
			expect(await ctx.editor("X")).toBeUndefined();
			expect(
				await ctx.askDialog!([{ id: "choice", question: "Choose", options: [{ label: "A" }] }]),
			).toBeUndefined();
			expect(calls).toHaveLength(0);
		});

		it("treats transport-level elicitation failures as undecided input", async () => {
			const { connection, calls } = createElicitConnection(async () => {
				throw new Error("connection closed");
			});
			const ctx = createAcpExtensionUiContext(connection, () => "session-throw", FORM_CAPABILITIES);

			expect(await ctx.select("X", ["a"])).toBeUndefined();
			expect(await ctx.confirm("X", "Y")).toBe(false);
			expect(await ctx.input("X")).toBeUndefined();
			expect(calls).toHaveLength(3);
		});

		it("skips the SDK call entirely when dialogOptions.signal is already aborted", async () => {
			const { connection, calls } = createElicitConnection(async () => ({
				action: "accept",
				content: { value: "ignored" },
			}));
			const ctx = createAcpExtensionUiContext(connection, () => "session-preabort", FORM_CAPABILITIES);
			const controller = new AbortController();
			controller.abort();

			expect(await ctx.select("X", ["a"], { signal: controller.signal })).toBeUndefined();
			expect(await ctx.confirm("X", "Y", { signal: controller.signal })).toBe(false);
			expect(await ctx.input("X", undefined, { signal: controller.signal })).toBeUndefined();
			expect(calls).toHaveLength(0);
		});

		it("resolves to the stub fallback when dialogOptions.signal aborts mid-flight", async () => {
			const { resolve, promise: never } = Promise.withResolvers<CreateElicitationResponse>();
			const { connection, calls } = createElicitConnection(() => never);
			const ctx = createAcpExtensionUiContext(connection, () => "session-midabort", FORM_CAPABILITIES);
			const controller = new AbortController();

			const pending = ctx.select("X", ["a"], { signal: controller.signal });
			controller.abort();
			expect(await pending).toBeUndefined();
			expect(calls).toHaveLength(1);
			// Resolve the never-promise so the bridge's `.then(finish)` chain settles
			// and Bun's promise tracker doesn't flag a leaked pending promise.
			resolve({ action: "decline" });
		});

		it("returns the stub fallback when the client sends a wrong-typed accept payload", async () => {
			// confirm expects a boolean; a string `value` must narrow to `false`.
			const stringForBool = createElicitConnection(async () => ({
				action: "accept",
				content: { value: "yes" },
			}));
			const boolCtx = createAcpExtensionUiContext(
				stringForBool.connection,
				() => "session-wrongtype-bool",
				FORM_CAPABILITIES,
			);
			expect(await boolCtx.confirm("Proceed?", "")).toBe(false);

			// select expects a string; a boolean `value` must narrow to `undefined`.
			const boolForString = createElicitConnection(async () => ({
				action: "accept",
				content: { value: true },
			}));
			const selectCtx = createAcpExtensionUiContext(
				boolForString.connection,
				() => "session-wrongtype-str",
				FORM_CAPABILITIES,
			);
			expect(await selectCtx.select("Pick", ["a"])).toBeUndefined();
		});

		it("returns the stub fallback when accept arrives without the expected `value` key", async () => {
			// content present but missing the `value` key — the bridge looks up
			// `response.content.value` which is `undefined`, so the typeof guard fires.
			const missingKey = createElicitConnection(async () => ({
				action: "accept",
				content: { other: "noise" } as never,
			}));
			const ctx = createAcpExtensionUiContext(missingKey.connection, () => "session-missingkey", FORM_CAPABILITIES);
			expect(await ctx.select("Pick", ["a"])).toBeUndefined();
			expect(await ctx.confirm("Proceed?", "")).toBe(false);
			expect(await ctx.input("Name?")).toBeUndefined();
		});

		it("returns the stub fallback when accept arrives with no content at all", async () => {
			// content omitted entirely — the `!response.content` guard short-circuits
			// before the per-method narrow has a chance to run.
			const noContent = createElicitConnection(async () => ({ action: "accept" }));
			const ctx = createAcpExtensionUiContext(noContent.connection, () => "session-nocontent", FORM_CAPABILITIES);
			expect(await ctx.select("Pick", ["a"])).toBeUndefined();
			expect(await ctx.confirm("Proceed?", "")).toBe(false);
			expect(await ctx.input("Name?")).toBeUndefined();
		});

		it("fires onTimeout and resolves to the stub fallback when dialogOptions.timeout expires", async () => {
			const { promise: never } = Promise.withResolvers<CreateElicitationResponse>();
			const { connection, calls } = createElicitConnection(() => never);
			const ctx = createAcpExtensionUiContext(connection, () => "session-timeout", FORM_CAPABILITIES);
			let timeoutFired = 0;
			const result = await ctx.select("Pick", ["a"], { timeout: 1, onTimeout: () => timeoutFired++ });
			expect(result).toBeUndefined();
			expect(timeoutFired).toBe(1);
			expect(calls).toHaveLength(1);
		});

		it("treats whitespace-only placeholder as absent on `input`", async () => {
			const { connection, calls } = createElicitConnection(async () => ({
				action: "accept",
				content: { value: "n" },
			}));
			const ctx = createAcpExtensionUiContext(connection, () => "session-ws-placeholder", FORM_CAPABILITIES);

			await ctx.input("Name?", "   ");

			expect(calls).toHaveLength(1);
			const request = calls[0]!;
			if (!isFormElicitation(request)) throw new Error("expected form-mode elicitation");
			expect(request.requestedSchema.properties?.value).toEqual({ type: "string" });
		});

		it("sends `message === title` on `confirm` when the message is empty (no join)", async () => {
			const { connection, calls } = createElicitConnection(async () => ({
				action: "accept",
				content: { value: true },
			}));
			const ctx = createAcpExtensionUiContext(connection, () => "session-confirm-empty", FORM_CAPABILITIES);

			await ctx.confirm("Proceed?", "");
			// Whitespace-only message must follow the same branch as empty —
			// CHANGELOG says join only when the message is non-empty.
			await ctx.confirm("Proceed?", "   ");

			expect(calls).toHaveLength(2);
			expect(calls[0]!.message).toBe("Proceed?");
			expect(calls[1]!.message).toBe("Proceed?");
		});

		it("still resolves to the stub fallback when dialogOptions.onTimeout throws", async () => {
			const { promise: never } = Promise.withResolvers<CreateElicitationResponse>();
			const { connection } = createElicitConnection(() => never);
			const ctx = createAcpExtensionUiContext(connection, () => "session-timeout-throw", FORM_CAPABILITIES);

			const result = await ctx.select("Pick", ["a"], {
				timeout: 1,
				onTimeout: () => {
					throw new Error("boom");
				},
			});

			expect(result).toBeUndefined();
		});

		it("reads the sessionId getter on every elicitation so mid-flight session changes are reflected", async () => {
			// `record.session.sessionId` mutates when an extension command calls
			// `ctx.switchSession` / `ctx.newSession`. Snapshotting it once at
			// factory time would route later elicitations to the pre-switch id.
			const { connection, calls } = createElicitConnection(async () => ({
				action: "accept",
				content: { value: "ok" },
			}));
			let currentSessionId = "session-before-switch";
			const ctx = createAcpExtensionUiContext(connection, () => currentSessionId, FORM_CAPABILITIES);

			await ctx.select("Pick", ["a"]);
			currentSessionId = "session-after-switch";
			await ctx.confirm("Continue?", "post-switch");
			await ctx.input("Name?");

			expect(calls).toHaveLength(3);
			// Each call must be a session-scoped form elicitation. Spelled as three
			// separate narrows because `mode === "form"` alone leaves both
			// `ElicitationRequestScope` and `ElicitationSessionScope` in the union —
			// only `"sessionId" in call` picks the session-scoped variant — and
			// loop-style narrows don't propagate to the assertions below.
			const [first, second, third] = calls;
			if (first?.mode !== "form" || !("sessionId" in first)) throw new Error("first call missing sessionId");
			if (second?.mode !== "form" || !("sessionId" in second)) throw new Error("second call missing sessionId");
			if (third?.mode !== "form" || !("sessionId" in third)) throw new Error("third call missing sessionId");
			expect(first.sessionId).toBe("session-before-switch");
			expect(second.sessionId).toBe("session-after-switch");
			expect(third.sessionId).toBe("session-after-switch");
		});
	});
});

describe("ACP agent MCP server configuration (late-connecting servers)", () => {
	const FIXTURE_PATH = path.join(import.meta.dir, "fixtures", "delayed-tool-mcp.ts");
	const BUN_EXEC = process.execPath;

	// Real polling, not fake timers: the fixture is a genuine child process
	// racing MCPManager's own `Bun.sleep`-based 250ms startup window, and a
	// subprocess's timers cannot be advanced from this test's fake-timer clock.
	async function pollUntil(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		while (!predicate()) {
			if (Date.now() >= deadline) throw new Error("pollUntil timed out");
			await Bun.sleep(5);
		}
	}

	/**
	 * Regression test: an MCP server that finishes connecting after
	 * `MCPManager`'s 250ms startup race window used to have its tools
	 * silently discarded — `#configureMcpServers` only called
	 * `session.refreshMCPTools` once, synchronously, with whatever
	 * `connectServers` returned inside the race window. The background
	 * `onToolsChanged` -> `refreshMCPTools` follow-up now runs through a
	 * `refreshChain` queue so late connections still land in the session.
	 */
	it("delivers a late-connecting server's tools via a queued refreshMCPTools call", async () => {
		const harness = await createHarness();
		const refreshSpy = spyOn(FakeAgentSession.prototype, "refreshMCPTools");
		const namesOf = (tools: unknown[]) => (tools as Array<{ name: string }>).map(tool => tool.name);

		try {
			const created = await harness.agent.newSession({
				cwd: harness.cwdA,
				mcpServers: [{ name: "delayed", command: BUN_EXEC, args: [FIXTURE_PATH], env: [] }],
			});
			expectAcpStructure(zNewSessionResponse, created);

			// The fixture delays its `initialize` response past the 250ms startup
			// race, so the first (synchronous) refresh inside `#configureMcpServers`
			// must see no tools yet.
			expect(refreshSpy.mock.calls).toHaveLength(1);
			expect(namesOf(refreshSpy.mock.calls[0]?.[0] ?? [])).toEqual([]);

			// Once the delayed `initialize` response lands, the background
			// `onToolsChanged` -> queued `refreshMCPTools` call must deliver the
			// server's tool. Before the fix, this late arrival was dropped.
			await pollUntil(() => refreshSpy.mock.calls.length > 1);
			expect(namesOf(refreshSpy.mock.calls.at(-1)?.[0] ?? [])).toEqual([`mcp__delayed_${DELAYED_MCP_TOOL_NAME}`]);
		} finally {
			refreshSpy.mockRestore();
		}
	}, 15_000);
});
