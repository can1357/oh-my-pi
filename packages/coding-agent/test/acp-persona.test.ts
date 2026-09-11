/**
 * ACP persona reconciliation through PersonaRuntime (plan §3):
 *
 * - `session/load` / `session/resume` / `unstable_session/fork` of a stored
 *   session whose journal ends under agent mode re-activates the persona via
 *   `PersonaRuntime.reconcile` and appends a fresh `mode_change agent` entry so
 *   the resume is drift-free.
 * - A mid-turn persona model switch is skipped with an in-band ACP text notice
 *   (`deferModelSwitchWhileStreaming`), matching the pre-runtime ACP semantics.
 *
 * Uses a real PersonaRuntime + SessionToolPolicy over a stubbed AgentSession
 * (same cast-through-unknown convention as acp-agent.test.ts), with a real
 * SessionManager journal so the mode_change persistence round-trips through
 * disk exactly like a stored session does.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { EffectiveExtensionRoots } from "@oh-my-pi/pi-coding-agent/capability/types";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ConfiguredThinkingLevel } from "@oh-my-pi/pi-coding-agent/thinking";
import { AcpAgent, createAcpPersonaModelHooks } from "@oh-my-pi/pi-coding-agent/modes/acp/acp-agent";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { PersonaRuntime } from "@oh-my-pi/pi-coding-agent/session/persona-runtime";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	type DiscoveredAgent,
	type PersonaExplicitOverrides,
	SessionToolPolicy,
} from "@oh-my-pi/pi-coding-agent/session/tool-policy";
import { __resetDirsFromEnvForTests, getConfigRootDir, setAgentDir } from "@oh-my-pi/pi-utils";
import type { AgentSideConnection, SessionNotification } from "@oh-my-pi/pi-utils/acp";

const PERSONA_AGENT_MD = [
	"---",
	"name: acp-testa",
	"description: ACP persona reconciliation test agent",
	"tools: [read, grep]",
	"---",
	"You are the ACP reconciliation test persona.",
].join("\n");

interface PersonaSessionStub {
	isStreaming: boolean;
	enabledToolNames: string[];
	mountedToolNames: string[];
	activeToolNames: string[];
	model: undefined;
	thinkingLevel: undefined;
	refreshBaseSystemPromptCalls: number;
	presentationCalls: Array<{ toolNames: string[]; mountedToolNames: string[] }>;
	spawns: string[] | "*" | null;
	appendPrompt: string | undefined;
	registry: ReadonlySet<string>;
}

/**
 * A stubbed AgentSession carrying a REAL SessionToolPolicy + PersonaRuntime so
 * `getPersonaRuntime().reconcile(...)` performs the actual switch transaction,
 * plus a real SessionManager journal for mode_change persistence.
 */
class PersonaStubSession {
	sessionManager: SessionManager;
	sessionId: string;
	extensionRunner = undefined;
	disposed = false;
	#personaRuntime: PersonaRuntime | undefined;

	stub: PersonaSessionStub;

	constructor(
		readonly cwd: string,
		stubOverrides?: Partial<PersonaSessionStub>,
	) {
		this.sessionManager = SessionManager.create(cwd);
		this.sessionId = this.sessionManager.getSessionId();
		const registry = new Set(["read", "grep", "glob", "write", "edit", "bash", "task", "hub"]);
		this.stub = {
			isStreaming: false,
			enabledToolNames: ["read", "grep", "glob", "write"],
			mountedToolNames: [],
			activeToolNames: ["read", "grep", "glob", "write"],
			model: undefined,
			thinkingLevel: undefined,
			refreshBaseSystemPromptCalls: 0,
			presentationCalls: [],
			spawns: null,
			appendPrompt: undefined,
			registry,
			...stubOverrides,
		};
		const policy = new SessionToolPolicy({
			registry: () => this.stub.registry,
			isDefaultActive: () => true,
		});
		this.#personaRuntime = new PersonaRuntime(policy, this as unknown as AgentSession);
	}

	get settings(): Settings {
		return Settings.instance;
	}

	get sessionName(): string {
		return this.sessionManager.getHeader()?.title ?? `Session ${this.sessionId}`;
	}

	get modelRegistry(): { getAvailable: () => never[] } {
		return { getAvailable: () => [] };
	}

	get model(): undefined {
		return undefined;
	}

	get isStreaming(): boolean {
		return this.stub.isStreaming;
	}

	configuredThinkingLevel(): undefined {
		return undefined;
	}

	getEnabledToolNames(): string[] {
		return [...this.stub.enabledToolNames];
	}

	getActiveToolNames(): string[] {
		return [...this.stub.activeToolNames];
	}

	getMountedXdevToolNames(): string[] {
		return [...this.stub.mountedToolNames];
	}

	getAllToolNames(): string[] {
		return [...this.stub.registry];
	}

	setActiveToolsByName(names: string[]): void {
		this.stub.activeToolNames = [...names];
		this.stub.enabledToolNames = [...names];
	}

	async setActiveToolPresentation(toolNames: string[], mountedToolNames: string[]): Promise<void> {
		this.stub.presentationCalls.push({
			toolNames: [...toolNames],
			mountedToolNames: [...mountedToolNames],
		});
		this.stub.activeToolNames = [...toolNames];
		this.stub.enabledToolNames = [...toolNames];
		this.stub.mountedToolNames = [...mountedToolNames];
	}

	async refreshBaseSystemPrompt(): Promise<void> {
		this.stub.refreshBaseSystemPromptCalls += 1;
	}

	clearInheritedProviderPromptCacheKey(): void {}

	getSessionSpawns(): string[] | "*" | null {
		return this.stub.spawns;
	}

	setSessionSpawns(spawns: string[] | "*" | null): void {
		this.stub.spawns = spawns;
	}

	applyPersonaAppendPrompt(personaText: string | undefined): void {
		this.stub.appendPrompt = personaText;
	}

	getPersonaAppendPrompt(): string | undefined {
		return this.stub.appendPrompt;
	}

	getToolPolicy(): SessionToolPolicy {
		return this.#personaRuntime!.policy;
	}

	setPersonaRuntime(runtime: PersonaRuntime): void {
		this.#personaRuntime = runtime;
	}

	getPersonaRuntime(): PersonaRuntime | undefined {
		return this.#personaRuntime;
	}

	get effectiveExtensionRoots(): EffectiveExtensionRoots {
		return {
			explicit: [],
			mode: "merge",
			configured: [],
			configuredLevel: "user",
		};
	}

	setClientBridge(_bridge: unknown): void {}

	getPlanModeState(): undefined {
		return undefined;
	}

	setPlanModeState(_state: undefined): void {}

	setPlanProposalHandler(_handler: ((title: string) => Promise<unknown> | unknown) | null): void {}

	peekPlanProposalHandler(): undefined {
		return undefined;
	}

	customCommands: [] = [];

	skillsSettings = { enableSkillCommands: true };

	skills: Array<{
		name: string;
		description: string;
		filePath: string;
		baseDir: string;
		source: string;
	}> = [];

	async refreshSkills(): Promise<void> {}

	async refreshMCPTools(_tools: unknown[]): Promise<void> {}

	getAvailableModels(): never[] {
		return [];
	}

	getAvailableThinkingLevels(): ReadonlyArray<string> {
		return ["low", "medium", "high"];
	}

	setThinkingLevel(_level: string | undefined): void {}

	setModel(_model: never): Promise<void> {
		return Promise.resolve();
	}

	setSlashCommands(_commands: unknown[]): void {}

	async prompt(_text: string): Promise<boolean> {
		return true;
	}

	subscribe(_listener: (event: unknown) => void): () => void {
		return () => {};
	}

	async waitForIdle(): Promise<void> {}

	async drainAsyncJobDeliveriesForAcp(_options?: { timeoutMs?: number }): Promise<boolean> {
		return false;
	}

	async dispose(): Promise<void> {
		this.disposed = true;
		await this.sessionManager.close();
	}

	async switchSession(sessionPath: string): Promise<boolean> {
		await this.sessionManager.setSessionFile(sessionPath);
		this.sessionId = this.sessionManager.getSessionId();
		return true;
	}

	async fork(): Promise<boolean> {
		await this.sessionManager.flush();
		const forked = await this.sessionManager.fork();
		if (!forked) {
			return false;
		}
		this.sessionId = this.sessionManager.getSessionId();
		return true;
	}
}

const cleanupRoots: string[] = [];
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const originalConfigDir = process.env.PI_CONFIG_DIR;
const fallbackAgentDir = getConfigRootDir();

afterEach(async () => {
	if (originalConfigDir === undefined) {
		delete process.env.PI_CONFIG_DIR;
	} else {
		process.env.PI_CONFIG_DIR = originalConfigDir;
	}
	if (originalAgentDir) {
		setAgentDir(originalAgentDir);
	} else {
		setAgentDir(fallbackAgentDir);
		delete process.env.PI_CODING_AGENT_DIR;
	}
	__resetDirsFromEnvForTests();
	resetSettingsForTest();
	for (const root of cleanupRoots.splice(0)) {
		await fs.promises.rm(root, { recursive: true, force: true });
	}
});

interface AcpPersonaHarness {
	agent: AcpAgent;
	updates: SessionNotification[];
	sessions: PersonaStubSession[];
	cwd: string;
	home: string;
}

async function createPersonaHarness(launchPersona?: {
	agent: DiscoveredAgent;
	explicit?: PersonaExplicitOverrides;
}): Promise<AcpPersonaHarness> {
	const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-acp-persona-test-"));
	cleanupRoots.push(root);
	const agentDir = path.join(root, "agent");
	const cwd = path.join(root, "cwd-a");
	const home = path.join(root, "home");
	await fs.promises.mkdir(agentDir, { recursive: true });
	await fs.promises.mkdir(cwd, { recursive: true });
	await fs.promises.mkdir(home, { recursive: true });
	// Persona discovery has two filesystem lanes: project `.omp/agents` under the
	// session cwd and the user config root (`$HOME/$PI_CONFIG_DIR/agent/agents`,
	// where PI_CONFIG_DIR is HOME-relative). The relative PI_CONFIG_DIR + dirs
	// reset (same convention as keybindings-migration.test.ts) points BOTH lanes
	// at the temp root; setAgentDir points the sessions store under it too.
	process.env.PI_CONFIG_DIR = path.relative(os.homedir(), root);
	__resetDirsFromEnvForTests();
	setAgentDir(agentDir);
	await Settings.init({ agentDir, inMemory: true });

	const agentsDir = path.join(agentDir, "agents");
	await fs.promises.mkdir(agentsDir, { recursive: true });
	await fs.promises.writeFile(path.join(agentsDir, "acp-testa.md"), PERSONA_AGENT_MD);

	const updates: SessionNotification[] = [];
	const sessions: PersonaStubSession[] = [];
	const connection = {
		sessionUpdate: async (notification: SessionNotification) => {
			updates.push(notification);
		},
		signal: new AbortController().signal,
		closed: Promise.withResolvers<void>().promise,
	} as unknown as AgentSideConnection;

	const factory = async (factoryCwd: string) => {
		const session = new PersonaStubSession(factoryCwd);
		sessions.push(session);
		// The production factory answers with an AcpSessionHandle; carry the
		// `--agent` launch persona on it when the test simulates that flag.
		return (launchPersona
			? { session, setToolUIContext: undefined, launchPersona }
			: session) as unknown as AgentSession;
	};

	const agent = new AcpAgent(connection, factory);
	await agent.initialize({
		protocolVersion: 1,
		clientCapabilities: {},
	} as Parameters<typeof agent.initialize>[0]);
	return { agent, updates, sessions, cwd, home };
}

async function lastAgentModeChange(
	session: PersonaStubSession,
): Promise<{ mode: string; data: Record<string, unknown> } | undefined> {
	await session.sessionManager.flush();
	const entries = session.sessionManager
		.getEntries()
		.filter(entry => entry.type === "mode_change")
		.map(entry => entry as { mode: string; data?: Record<string, unknown> });
	const last = entries.at(-1);
	if (!last) return undefined;
	return { mode: last.mode, data: last.data ?? {} };
}

describe("ACP persona reconciliation", () => {
	it("re-activates the persisted persona on session/load and appends a fresh mode_change entry", async () => {
		const harness = await createPersonaHarness();
		const source = new PersonaStubSession(harness.cwd);
		harness.sessions.push(source);
		// Simulate a persona session stored by a previous host: agent mode_change
		// on the journal plus conversation content so resume has context.
		source.sessionManager.appendMessage({
			role: "user",
			content: "hi",
			timestamp: Date.now(),
		});
		source.sessionManager.appendModeChange("agent", { name: "acp-testa" });
		await source.sessionManager.ensureOnDisk();
		await source.sessionManager.flush();

		await harness.agent.loadSession({
			sessionId: source.sessionId,
			cwd: harness.cwd,
			mcpServers: [],
		});

		const stored = harness.sessions.at(-1)!;
		const policy = stored.getPersonaRuntime()!.policy;
		expect(policy.isPersonaActive()).toBe(true);
		expect(policy.effective("read")).toBe(true);
		expect(policy.effective("write")).toBe(false); // persona grant narrows
		expect(stored.getPersonaAppendPrompt()).toContain("reconciliation test persona");

		// Drift-free: the load appended its own agent entry after reconcile.
		const entry = await lastAgentModeChange(stored);
		expect(entry?.mode).toBe("agent");
		expect(entry?.data.name).toBe("acp-testa");
		expect(stored.stub.refreshBaseSystemPromptCalls).toBeGreaterThanOrEqual(1);
	});

	it("does not reconcile when the stored journal has no agent mode_change", async () => {
		const harness = await createPersonaHarness();
		const source = new PersonaStubSession(harness.cwd);
		harness.sessions.push(source);
		source.sessionManager.appendMessage({
			role: "user",
			content: "plain session",
			timestamp: Date.now(),
		});
		await source.sessionManager.ensureOnDisk();
		await source.sessionManager.flush();

		await harness.agent.loadSession({
			sessionId: source.sessionId,
			cwd: harness.cwd,
			mcpServers: [],
		});
		const stored = harness.sessions.at(-1)!;
		expect(stored.getPersonaRuntime()!.policy.isPersonaActive()).toBe(false);
		expect(await lastAgentModeChange(stored)).toBeUndefined();
	});

	it("degrades with a notice and appends a `none` journal entry when the persona definition is gone", async () => {
		const harness = await createPersonaHarness();
		const source = new PersonaStubSession(harness.cwd);
		harness.sessions.push(source);
		source.sessionManager.appendModeChange("agent", {
			name: "deleted-persona",
		});
		await source.sessionManager.ensureOnDisk();
		await source.sessionManager.flush();

		// Persona-gone notices surface as agent_message_chunk text (the only
		// update kind #emitPersonaNotices produces).
		const noticeChunks = (): number =>
			harness.updates.filter(
				notification =>
					notification.update.sessionUpdate === "agent_message_chunk" &&
					String((notification.update.content as { text?: string }).text ?? "").includes("deleted-persona"),
			).length;

		await harness.agent.loadSession({
			sessionId: source.sessionId,
			cwd: harness.cwd,
			mcpServers: [],
		});
		const stored = harness.sessions.at(-1)!;
		expect(stored.getPersonaRuntime()!.policy.isPersonaActive()).toBe(false);
		expect(noticeChunks()).toBe(1);
		// Journal clear marker: the stale `agent` entry no longer stays LAST,
		// so a second resume does not re-notice the degrade.
		const entry = await lastAgentModeChange(stored);
		expect(entry?.mode).toBe("none");

		// Second resume: no re-notice for the cleared persona.
		await harness.agent.loadSession({
			sessionId: stored.sessionId,
			cwd: harness.cwd,
			mcpServers: [],
		});
		const reopened = harness.sessions.at(-1)!;
		expect(reopened.getPersonaRuntime()!.policy.isPersonaActive()).toBe(false);
		expect(noticeChunks()).toBe(1);
	});

	// Regression (Codex P2, fvInv parity): ACP `--agent X` must win over the
	// STORED persona across session/load. The per-workspace factory entered X at
	// construction, but switchSession tears that source persona down and restores
	// the loaded journal; without a re-assert after reconcile, the launch flag
	// silently disappears for load/resume/fork while the stored persona wins.
	it("launch --agent overrides the stored persona on session/load", async () => {
		const launchAgent: DiscoveredAgent = {
			name: "acp-launch",
			description: "launch-flag persona",
			systemPrompt: "You are the launch-flag persona.",
			source: "bundled",
			tools: ["read"],
		};
		const harness = await createPersonaHarness({ agent: launchAgent });
		const source = new PersonaStubSession(harness.cwd);
		harness.sessions.push(source);
		source.sessionManager.appendMessage({ role: "user", content: "hi", timestamp: Date.now() });
		source.sessionManager.appendModeChange("agent", { name: "acp-testa" });
		await source.sessionManager.ensureOnDisk();
		await source.sessionManager.flush();

		await harness.agent.loadSession({
			sessionId: source.sessionId,
			cwd: harness.cwd,
			mcpServers: [],
		});

		const stored = harness.sessions.at(-1)!;
		const runtime = stored.getPersonaRuntime()!;
		expect(runtime.policy.isPersonaActive()).toBe(true);
		// The launch persona won over the journal's stored acp-testa.
		expect(runtime.policy.snapshot().persona?.agent.name).toBe("acp-launch");
		expect(stored.getPersonaAppendPrompt()).toContain("launch-flag persona");
		// Drift-free journal: the LAST agent entry records the launch persona.
		const entry = await lastAgentModeChange(stored);
		expect(entry?.mode).toBe("agent");
		expect(entry?.data.name).toBe("acp-launch");
	});

	it("resolves the persona from the session cwd's project agents dir", async () => {
		const harness = await createPersonaHarness();
		const projectAgentsDir = path.join(harness.cwd, ".omp", "agents");
		await fs.promises.mkdir(projectAgentsDir, { recursive: true });
		await fs.promises.writeFile(
			path.join(projectAgentsDir, "acp-testb.md"),
			[
				"---",
				"name: acp-testb",
				"description: project-scoped persona",
				"tools: [read]",
				"---",
				"Project persona.",
			].join("\n"),
		);

		const source = new PersonaStubSession(harness.cwd);
		harness.sessions.push(source);
		source.sessionManager.appendModeChange("agent", { name: "acp-testb" });
		await source.sessionManager.ensureOnDisk();
		await source.sessionManager.flush();

		await harness.agent.loadSession({
			sessionId: source.sessionId,
			cwd: harness.cwd,
			mcpServers: [],
		});
		const stored = harness.sessions.at(-1)!;
		const policy = stored.getPersonaRuntime()!.policy;
		expect(policy.isPersonaActive()).toBe(true);
		expect(policy.effective("read")).toBe(true);
		expect(policy.effective("edit")).toBe(false);
	});

	it("emits an ACP text notice instead of a mid-turn model switch (defer channel)", async () => {
		const harness = await createPersonaHarness();
		const session = new PersonaStubSession(harness.cwd);
		session.stub.isStreaming = true;
		const notices: string[] = [];
		const hooks = createAcpPersonaModelHooks(session as unknown as AgentSession, async text => {
			notices.push(text);
		});

		expect(hooks.shouldDeferModelSwitch?.()).toBe(true);
		const agentDef: DiscoveredAgent = {
			name: "acp-testa",
			description: "",
			systemPrompt: "prompt",
			source: "bundled",
			model: ["stub/some-model"],
		};
		hooks.deferModelSwitchWhileStreaming?.(agentDef);
		expect(notices).toHaveLength(1);
		expect(notices[0]).toContain('Agent "acp-testa" model switch deferred');
		expect(notices[0]).toContain("mid-turn");
	});

	it("emits an ACP text notice for a mid-turn model restore (defer-restore channel)", async () => {
		const harness = await createPersonaHarness();
		const session = new PersonaStubSession(harness.cwd);
		session.stub.isStreaming = true;
		const notices: string[] = [];
		const hooks = createAcpPersonaModelHooks(session as unknown as AgentSession, async text => {
			notices.push(text);
		});

		// A baseline without a model restores nothing — no notice.
		hooks.deferModelRestoreWhileStreaming?.({
			model: undefined,
			thinkingLevel: undefined,
		});
		expect(notices).toHaveLength(0);

		hooks.deferModelRestoreWhileStreaming?.({
			model: {} as Model,
			thinkingLevel: undefined,
		});
		expect(notices).toHaveLength(1);
		expect(notices[0]).toContain("model restore deferred");
	});

	const prePersonaBaseline = () => ({ model: { id: "pre" } as Model, thinkingLevel: undefined });

	// Regression (Codex P2 ×2): the ACP surface queues ONE deferred model
	// operation on the session, flushed at agent_end. Mid-turn enter of a
	// modeled persona B while A is active must REPLACE A's queued baseline
	// restore with B's resolved switch (else agent_end applies the pre-A model
	// while B runs and B's model never lands), and a FAILED transaction must
	// restore the entry that existed before it rather than clearing (TUI
	// #pendingModelSwitch parity).
	function makeDeferredQueueStub(harness: { cwd: string }) {
		const session = new PersonaStubSession(harness.cwd);
		session.stub.isStreaming = true;
		let queued: { model: Model; thinkingLevel: ConfiguredThinkingLevel | undefined } | undefined;
		const target = session as unknown as AgentSession & {
			queueDeferredModelRestore: (model: Model, thinkingLevel?: ConfiguredThinkingLevel) => void;
			clearDeferredModelRestore: () => void;
			getDeferredModelRestore: () =>
				| { model: Model; thinkingLevel: ConfiguredThinkingLevel | undefined }
				| undefined;
		};
		target.queueDeferredModelRestore = (model, thinkingLevel) => {
			queued = { model, thinkingLevel };
		};
		target.clearDeferredModelRestore = () => {
			queued = undefined;
		};
		target.getDeferredModelRestore = () => queued;
		return { session, target, peek: () => queued };
	}

	it("mid-turn modeled persona enter replaces the queued baseline restore (chained A→B)", async () => {
		const personaModel = buildModel({
			id: "persona-model",
			name: "Persona Model",
			api: "anthropic-messages",
			provider: "stub",
			baseUrl: "https://example.invalid",
			reasoning: false,
			input: ["text"],
			cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 },
			contextWindow: 128000,
			maxTokens: 8192,
		}) as Model<Api>;
		let queued: { model: Model; thinkingLevel: unknown } | undefined;
		const target = {
			isStreaming: true,
			model: undefined,
			settings: Settings.isolated(),
			modelRegistry: { getAvailable: () => [personaModel] },
			queueDeferredModelRestore: (model: Model, thinkingLevel?: unknown) => {
				queued = { model, thinkingLevel };
			},
			clearDeferredModelRestore: () => {
				queued = undefined;
			},
			getDeferredModelRestore: () => queued,
		} as unknown as AgentSession;
		const hooks = createAcpPersonaModelHooks(target, async () => {});
		// A's exit queued its pre-persona baseline first (a prior transaction).
		const preA = buildModel({
			id: "pre-a",
			name: "Pre A",
			api: "anthropic-messages",
			provider: "stub",
			baseUrl: "https://example.invalid",
			reasoning: false,
			input: ["text"],
			cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 },
			contextWindow: 128000,
			maxTokens: 8192,
		}) as Model<Api>;
		hooks.deferModelRestoreWhileStreaming?.({ model: preA, thinkingLevel: undefined });
		expect(queued?.model).toBe(preA);

		hooks.deferModelSwitchWhileStreaming?.({
			name: "acp-b",
			description: "",
			systemPrompt: "prompt",
			source: "bundled",
			model: ["stub/persona-model"],
		} as DiscoveredAgent);
		// B's switch REPLACES A's restore; agent_end now lands B's model.
		// Pre-fix the enter path only noticed, so the queue still held A's
		// pre-persona model and B ran on the wrong model.
		expect(queued?.model).toBe(personaModel);
	});

	it("failed ACP transaction restores the prior deferred entry instead of clearing", async () => {
		const harness = await createPersonaHarness();
		const { target, peek } = makeDeferredQueueStub(harness);
		const owed = { model: { id: "owed" } as Model, thinkingLevel: undefined };
		// A restore queued by an EARLIER (successful) transaction exists when
		// this hooks instance is created — its rollback must put it back.
		const owedModel = owed.model;
		target.queueDeferredModelRestore(owedModel, owed.thinkingLevel);
		const failing = createAcpPersonaModelHooks(target, async () => {});
		// The failed transaction mutated the queue…
		failing.deferModelRestoreWhileStreaming?.({ model: { id: "this-tx" } as Model, thinkingLevel: undefined });
		expect(peek()?.model.id).toBe("this-tx");
		// …rollback restores the prior owner's entry.
		failing.onPersonaSwitchFailed?.();
		expect(peek()?.model).toBe(owedModel);

		// With an EMPTY prior, the same rollback clears the transaction's entry.
		target.clearDeferredModelRestore();
		const fresh = createAcpPersonaModelHooks(target, async () => {});
		fresh.deferModelRestoreWhileStreaming?.(prePersonaBaseline());
		expect(peek()?.model).toBeDefined();
		fresh.onPersonaSwitchFailed?.();
		expect(peek()).toBeUndefined();
	});

	it("emits the defer notice for a thinking-only persona mid-turn (fo80k)", async () => {
		// A persona with `thinkingLevel` but NO model used to skip the notice
		// entirely, silently dropping the thinking change. The thinking-only
		// persona still defers (its tools/prompt apply now; the thinking rides
		// the same turn-end retry), so the client must be told.
		const harness = await createPersonaHarness();
		const session = new PersonaStubSession(harness.cwd);
		session.stub.isStreaming = true;
		const notices: string[] = [];
		const hooks = createAcpPersonaModelHooks(session as unknown as AgentSession, async text => {
			notices.push(text);
		});

		hooks.deferModelSwitchWhileStreaming?.({
			name: "acp-thinker",
			description: "",
			systemPrompt: "prompt",
			source: "bundled",
			thinkingLevel: "high",
		} as DiscoveredAgent);
		expect(notices).toHaveLength(1);
		expect(notices[0]).toContain('Agent "acp-thinker" model switch deferred');
	});

	it("resume (session/resume) reconciles like load", async () => {
		const harness = await createPersonaHarness();
		const source = new PersonaStubSession(harness.cwd);
		harness.sessions.push(source);
		source.sessionManager.appendMessage({
			role: "user",
			content: "resume me",
			timestamp: Date.now(),
		});
		source.sessionManager.appendModeChange("agent", {
			name: "acp-testa",
			explicit: { thinking: "high" },
		});
		await source.sessionManager.ensureOnDisk();
		await source.sessionManager.flush();

		await harness.agent.resumeSession({
			sessionId: source.sessionId,
			cwd: harness.cwd,
			mcpServers: [],
		});
		const stored = harness.sessions.at(-1)!;
		expect(stored.getPersonaRuntime()!.policy.isPersonaActive()).toBe(true);
		const entry = await lastAgentModeChange(stored);
		expect(entry?.mode).toBe("agent");
		expect(entry?.data.name).toBe("acp-testa");
	});

	it("fork of a persona session reconciles and appends a fresh entry", async () => {
		const harness = await createPersonaHarness();
		const source = new PersonaStubSession(harness.cwd);
		harness.sessions.push(source);
		source.sessionManager.appendMessage({
			role: "user",
			content: "fork me",
			timestamp: Date.now(),
		});
		source.sessionManager.appendModeChange("agent", { name: "acp-testa" });
		await source.sessionManager.ensureOnDisk();
		await source.sessionManager.flush();

		await harness.agent.unstable_forkSession({
			sessionId: source.sessionId,
			cwd: harness.cwd,
			mcpServers: [],
		});
		const forkSession = harness.sessions.at(-1)!;
		const policy = forkSession.getPersonaRuntime()!.policy;
		expect(policy.effective("read")).toBe(true);
		const entry = await lastAgentModeChange(forkSession);
		expect(entry?.mode).toBe("agent");
		expect(entry?.data.name).toBe("acp-testa");
	});
});
