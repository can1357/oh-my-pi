import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentSideConnection } from "@agentclientprotocol/sdk";
import type { Model } from "@pk-nerdsaver-ai/pi-ai";
import { resetSettingsForTest, Settings } from "@pk-nerdsaver-ai/pi-coding-agent/config/settings";
import { AcpAgent } from "@pk-nerdsaver-ai/pi-coding-agent/modes/acp/acp-agent";
import type { PlanModeState } from "@pk-nerdsaver-ai/pi-coding-agent/plan-mode/state";
import type { AgentSession, AgentSessionEvent } from "@pk-nerdsaver-ai/pi-coding-agent/session/agent-session";
import * as fusionSidekickModule from "@pk-nerdsaver-ai/pi-coding-agent/session/fusion-sidekick";
import { SessionManager } from "@pk-nerdsaver-ai/pi-coding-agent/session/session-manager";
import { getConfigRootDir, removeWithRetries, setAgentDir } from "@pk-nerdsaver-ai/pi-utils";

// ---------------------------------------------------------------------------
// Test models
// ---------------------------------------------------------------------------

const TEST_MODELS: Model[] = [
	{
		api: " Pi",
		id: "test/smol",
		provider: "test",
		kind: "text",
		streamable: true,
		inputs: 128000,
		outputs: 64000,
	} as unknown as Model,
];

// ---------------------------------------------------------------------------
// FakeAgentSession — minimal stand-in for a real AgentSession
// ---------------------------------------------------------------------------

class FakeAgentSession {
	sessionManager: SessionManager;
	sessionId: string;
	agent: { sessionId: string; waitForIdle: () => Promise<void> };
	model: Model | undefined;
	thinkingLevel: string | undefined;
	customCommands: [] = [];
	extensionRunner = undefined;
	setSlashCommands(_commands: unknown[]): void {}
	isStreaming = false;
	queuedMessageCount = 0;
	systemPrompt = "system";
	disposed = false;
	fastMode = false;
	forcedToolChoice: string | undefined;
	skillsSettings = { enableSkillCommands: true };
	skills: Array<{ name: string; description: string; filePath: string; baseDir: string; source: string }> = [];
	planModeState: PlanModeState | undefined;
	waitForIdleCalls = 0;
	asyncJobDrain: ((options?: { timeoutMs?: number }) => Promise<boolean>) | undefined;
	#listeners = new Set<(event: AgentSessionEvent) => void>();

	get settings(): Settings {
		return Settings.instance;
	}

	constructor(
		cwd: string,
		private readonly models: Model[] = TEST_MODELS,
	) {
		this.sessionManager = SessionManager.create(cwd);
		this.sessionId = this.sessionManager.getSessionId();
		this.agent = {
			sessionId: this.sessionId,
			waitForIdle: async () => {},
		};
		this.model = models[0];
	}

	get sessionName(): string {
		return this.sessionManager.getHeader()?.title ?? `Session ${this.sessionId}`;
	}

	get modelRegistry(): { getApiKey: (model: Model) => Promise<string> } {
		return { getApiKey: async (_model: Model) => "test-key" };
	}

	getAvailableModels(): Model[] {
		return this.models;
	}

	getAvailableThinkingLevels(): ReadonlyArray<string> {
		return ["low", "medium", "high"];
	}

	setThinkingLevel(level: string | undefined): void {
		this.thinkingLevel = level;
	}

	async setModel(model: Model): Promise<void> {
		this.model = model;
	}

	subscribe(listener: (event: AgentSessionEvent) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	listeners(): Array<(event: AgentSessionEvent) => void> {
		return [...this.#listeners];
	}

	async prompt(_text: string): Promise<boolean> {
		return true;
	}

	async waitForIdle(): Promise<void> {
		this.waitForIdleCalls++;
	}

	async drainAsyncJobDeliveriesForAcp(_options?: { timeoutMs?: number }): Promise<boolean> {
		return false;
	}

	async abort(): Promise<void> {
		this.isStreaming = false;
	}

	async promptCustomMessage(_message: { customType: string; content: string; details?: unknown }): Promise<void> {}

	async refreshMCPTools(_tools: unknown[]): Promise<void> {}

	async refreshSshTool(_options?: { activateIfAvailable?: boolean }): Promise<void> {}

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

	async fork(): Promise<boolean> {
		await this.sessionManager.flush();
		const forked = await this.sessionManager.fork();
		if (!forked) return false;
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

	setClientBridge(_bridge: unknown): void {}

	getPlanModeState(): PlanModeState | undefined {
		return this.planModeState;
	}

	setPlanModeState(state: PlanModeState | undefined): void {
		this.planModeState = state;
	}

	setStandingResolveHandler(_handler: ((input: unknown) => Promise<unknown> | unknown) | null): void {}

	peekStandingResolveHandler(): ((input: unknown) => Promise<unknown> | unknown) | undefined {
		return undefined;
	}

	planReferencePath: string | undefined;

	setPlanReferencePath(p: string): void {
		this.planReferencePath = p;
	}

	getToolByName(_name: string): undefined {
		return undefined;
	}

	toggleFastMode(): boolean {
		this.fastMode = !this.fastMode;
		return this.fastMode;
	}

	setFastMode(enabled: boolean): void {
		this.fastMode = enabled;
	}

	isFastModeEnabled(): boolean {
		return this.fastMode;
	}

	isFastModeActive(): boolean {
		return this.fastMode;
	}

	setForcedToolChoice(_toolName: string): void {}

	async sendCustomMessage(_message: string, _options?: unknown): Promise<void> {}

	async sendUserMessage(_content: string, _options?: unknown): Promise<void> {}

	async compact(_instructions?: string, _options?: unknown): Promise<void> {}
}

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

interface AgentHarness {
	agent: AcpAgent;
	abortController: AbortController;
	sessions: FakeAgentSession[];
	cwdA: string;
	cwdB: string;
	findSession(sessionId: string): FakeAgentSession | undefined;
}

const cleanupRoots: string[] = [];
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const fallbackAgentDir = path.join(getConfigRootDir(), "agent");

// Restore each spy individually instead of calling `mock.restore()`. These spies
// patch an ESM module namespace, which is sealed; the global restore walks Bun's
// whole mock registry to undo that and segfaults the process (`panic(main
// thread): Segmentation fault at address 0x4`) once a later file in the same run
// imports an overlapping module graph. The singleton bucket shares one process by
// design, so the crash took the entire bucket down — reliably reproducible as
// `bun test acp-agent-fusion-sidekick.test.ts system-prompt-model.test.ts`.
const trackedSpies: Array<{ mockRestore: () => void }> = [];
const track = <T extends { mockRestore: () => void }>(spy: T): T => {
	trackedSpies.push(spy);
	return spy;
};

afterEach(async () => {
	for (const spy of trackedSpies.splice(0)) spy.mockRestore();
	if (originalAgentDir) {
		setAgentDir(originalAgentDir);
	} else {
		setAgentDir(fallbackAgentDir);
		delete process.env.PI_CODING_AGENT_DIR;
	}
	resetSettingsForTest();

	for (const root of cleanupRoots.splice(0)) {
		// Best-effort: the harness leaves session handles open long enough that
		// Windows refuses the delete even after removeWithRetries exhausts its
		// retries. Reclaiming an OS temp dir is not what these tests assert, so a
		// teardown failure must not fail a test whose assertions all passed.
		await removeWithRetries(root).catch(() => {});
	}
});

async function createHarness(): Promise<AgentHarness> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-acp-fusion-test-"));
	cleanupRoots.push(root);
	const agentDir = path.join(root, "agent");
	const cwdA = path.join(root, "cwd-a");
	const cwdB = path.join(root, "cwd-b");
	await fs.mkdir(agentDir, { recursive: true });
	await fs.mkdir(cwdA, { recursive: true });
	await fs.mkdir(cwdB, { recursive: true });
	setAgentDir(agentDir);
	await Settings.init({ agentDir, inMemory: true });

	const abortController = new AbortController();
	const sessions: FakeAgentSession[] = [];
	const connection = {
		sessionUpdate: async () => {},
		unstable_createElicitation: undefined,
		signal: abortController.signal,
		closed: Promise.withResolvers<void>().promise,
	} as unknown as AgentSideConnection;

	const initialSession = new FakeAgentSession(cwdA);
	sessions.push(initialSession);
	const factory = async (cwd: string): Promise<AgentSession> => {
		const session = new FakeAgentSession(cwd);
		sessions.push(session);
		return session as unknown as AgentSession;
	};

	const agent = new AcpAgent(connection, factory, initialSession as unknown as AgentSession);
	return {
		agent,
		abortController,
		sessions,
		cwdA,
		cwdB,
		findSession: (sessionId: string) => sessions.findLast(s => s.sessionId === sessionId),
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ACP agent fusion sidekick spawn", () => {
	it("calls ensureFusionSidekick when newSession creates a fresh session", async () => {
		const spy = track(spyOn(fusionSidekickModule, "ensureFusionSidekick"));
		const harness = await createHarness();

		const result = await harness.agent.newSession({ cwd: harness.cwdA, mcpServers: [] });
		const session = harness.findSession(result.sessionId)!;

		expect(spy).toHaveBeenCalledTimes(1);
		const [host, options] = spy.mock.calls[0]!;
		expect(host.session).toBe(session as unknown as AgentSession);
		expect(host.settings).toBe(session.settings);
		expect(host.sessionManager).toBe(session.sessionManager);
		expect(host.mcpManager).toBeUndefined();
		expect(host.eventBus).toBeUndefined();
		expect(options).toEqual({});
	});

	it("does NOT call ensureFusionSidekick when resumeManagedSession finds an in-memory session", async () => {
		const spy = track(spyOn(fusionSidekickModule, "ensureFusionSidekick"));
		const harness = await createHarness();

		// Create the session first so it is cached in memory
		const first = await harness.agent.newSession({ cwd: harness.cwdA, mcpServers: [] });
		spy.mockClear();

		// Resume from the in-memory cache — no new managed session record is created
		const second = await harness.agent.resumeSession({
			sessionId: first.sessionId,
			cwd: harness.cwdA,
			mcpServers: [],
		});

		expect(spy).not.toHaveBeenCalled();
		expect(second).toHaveProperty("configOptions");
	});

	it("calls ensureFusionSidekick when resumeManagedSession loads a stored session from disk", async () => {
		const spy = track(spyOn(fusionSidekickModule, "ensureFusionSidekick"));
		const harness = await createHarness();

		// Create and persist a session to disk
		const created = await harness.agent.newSession({ cwd: harness.cwdA, mcpServers: [] });
		const session = harness.findSession(created.sessionId)!;
		await session.sessionManager.ensureOnDisk();
		await harness.agent.closeSession({ sessionId: created.sessionId });

		spy.mockClear();

		// Resume from disk — forces a new managed session record
		await harness.agent.resumeSession({
			sessionId: created.sessionId,
			cwd: harness.cwdA,
			mcpServers: [],
		});
		const resumedSession = harness.findSession(created.sessionId)!;

		expect(spy).toHaveBeenCalledTimes(1);
		const [host, options] = spy.mock.calls[0]!;
		expect(host.session).toBe(resumedSession as unknown as AgentSession);
		expect(host.settings).toBe(resumedSession.settings);
		expect(host.sessionManager).toBe(resumedSession.sessionManager);
		expect(host.mcpManager).toBeUndefined();
		expect(host.eventBus).toBeUndefined();
		expect(options).toEqual({});
	});

	it("calls ensureFusionSidekick when loadManagedSession loads a stored session from disk", async () => {
		const spy = track(spyOn(fusionSidekickModule, "ensureFusionSidekick"));
		const harness = await createHarness();

		// Create and persist a session to disk
		const created = await harness.agent.newSession({ cwd: harness.cwdA, mcpServers: [] });
		const session = harness.findSession(created.sessionId)!;
		await session.sessionManager.ensureOnDisk();

		await harness.agent.closeSession({ sessionId: created.sessionId });
		spy.mockClear();

		// Load from disk — forces a new managed session record
		await harness.agent.loadSession({
			sessionId: created.sessionId,
			cwd: harness.cwdA,
			mcpServers: [],
		});
		const loadedSession = harness.findSession(created.sessionId)!;

		expect(spy).toHaveBeenCalledTimes(1);
		const [host, options] = spy.mock.calls[0]!;
		expect(host.session).toBe(loadedSession as unknown as AgentSession);
		expect(host.settings).toBe(loadedSession.settings);
		expect(host.sessionManager).toBe(loadedSession.sessionManager);
		expect(host.mcpManager).toBeUndefined();
		expect(host.eventBus).toBeUndefined();
		expect(options).toEqual({});
	});

	it("does NOT call ensureFusionSidekick when loadManagedSession finds an in-memory session", async () => {
		const spy = track(spyOn(fusionSidekickModule, "ensureFusionSidekick"));
		const harness = await createHarness();

		// Create the session first so it is cached in memory
		const first = await harness.agent.newSession({ cwd: harness.cwdA, mcpServers: [] });
		spy.mockClear();

		// Load from the in-memory cache
		const second = await harness.agent.loadSession({
			sessionId: first.sessionId,
			cwd: harness.cwdA,
			mcpServers: [],
		});

		expect(spy).not.toHaveBeenCalled();
		expect(second).toHaveProperty("configOptions");
	});

	it("calls ensureFusionSidekick when forkManagedSession creates a forked session", async () => {
		const spy = track(spyOn(fusionSidekickModule, "ensureFusionSidekick"));
		const harness = await createHarness();

		// Create and persist a source session
		const source = await harness.agent.newSession({ cwd: harness.cwdA, mcpServers: [] });
		const sourceSession = harness.findSession(source.sessionId)!;
		await sourceSession.sessionManager.ensureOnDisk();

		spy.mockClear();

		// Fork creates a new managed session record
		const forked = await harness.agent.unstable_forkSession({
			sessionId: source.sessionId,
			cwd: harness.cwdB,
			mcpServers: [],
		});
		const forkedSession = harness.findSession(forked.sessionId)!;

		expect(spy).toHaveBeenCalledTimes(1);
		const [host, options] = spy.mock.calls[0]!;
		expect(host.session).toBe(forkedSession as unknown as AgentSession);
		expect(host.settings).toBe(forkedSession.settings);
		expect(host.sessionManager).toBe(forkedSession.sessionManager);
		expect(host.mcpManager).toBeUndefined();
		expect(host.eventBus).toBeUndefined();
		expect(options).toEqual({});
	});
});
