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
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { EffectiveExtensionRoots } from "@oh-my-pi/pi-coding-agent/capability/types";
import { AcpAgent } from "@oh-my-pi/pi-coding-agent/modes/acp/acp-agent";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { PersonaRuntime } from "@oh-my-pi/pi-coding-agent/session/persona-runtime";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { SessionToolPolicy, type DiscoveredAgent } from "@oh-my-pi/pi-coding-agent/session/tool-policy";
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
 #listeners = new Set<(event: unknown) => void>();

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
  this.stub.presentationCalls.push({ toolNames: [...toolNames], mountedToolNames: [...mountedToolNames] });
  this.stub.activeToolNames = [...toolNames];
  this.stub.enabledToolNames = [...toolNames];
  this.stub.mountedToolNames = [...mountedToolNames];
 }

 async refreshBaseSystemPrompt(): Promise<void> {
  this.stub.refreshBaseSystemPromptCalls += 1;
 }

 clearInheritedProviderPromptCacheKey(): void { }

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
  return { explicit: [], mode: "merge", configured: [], configuredLevel: "user" };
 }

 setClientBridge(_bridge: unknown): void { }

 getPlanModeState(): undefined {
  return undefined;
 }

 setPlanModeState(_state: undefined): void { }

 setPlanProposalHandler(_handler: ((title: string) => Promise<unknown> | unknown) | null): void { }

 peekPlanProposalHandler(): undefined {
  return undefined;
 }

 customCommands: [] = [];

 skillsSettings = { enableSkillCommands: true };

 skills: Array<{ name: string; description: string; filePath: string; baseDir: string; source: string }> = [];

 async refreshSkills(): Promise<void> { }

 async refreshMCPTools(_tools: unknown[]): Promise<void> { }

 getAvailableModels(): never[] {
  return [];
 }

 getAvailableThinkingLevels(): ReadonlyArray<string> {
  return ["low", "medium", "high"];
 }

 setThinkingLevel(_level: string | undefined): void { }

 setModel(_model: never): Promise<void> {
  return Promise.resolve();
 }

 setSlashCommands(_commands: unknown[]): void { }

 async prompt(_text: string): Promise<boolean> {
  return true;
 }

 subscribe(_listener: (event: unknown) => void): () => void {
  return () => { };
 }

 async waitForIdle(): Promise<void> { }

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

async function createPersonaHarness(): Promise<AcpPersonaHarness> {
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
  return session as unknown as AgentSession;
 };



 const agent = new AcpAgent(connection, factory);
 await agent.initialize({ protocolVersion: 1, clientCapabilities: {} } as Parameters<typeof agent.initialize>[0]);
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
  source.sessionManager.appendMessage({ role: "user", content: "hi", timestamp: Date.now() });
  source.sessionManager.appendModeChange("agent", { name: "acp-testa" });
  await source.sessionManager.ensureOnDisk();
  await source.sessionManager.flush();

  await harness.agent.loadSession({ sessionId: source.sessionId, cwd: harness.cwd, mcpServers: [] });

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
  source.sessionManager.appendMessage({ role: "user", content: "plain session", timestamp: Date.now() });
  await source.sessionManager.ensureOnDisk();
  await source.sessionManager.flush();

  await harness.agent.loadSession({ sessionId: source.sessionId, cwd: harness.cwd, mcpServers: [] });
  const stored = harness.sessions.at(-1)!;
  expect(stored.getPersonaRuntime()!.policy.isPersonaActive()).toBe(false);
  expect(await lastAgentModeChange(stored)).toBeUndefined();
 });

 it("skips reconcile without writing when the persona definition is gone", async () => {
  const harness = await createPersonaHarness();
  const source = new PersonaStubSession(harness.cwd);
  harness.sessions.push(source);
  source.sessionManager.appendModeChange("agent", { name: "deleted-persona" });
  await source.sessionManager.ensureOnDisk();
  await source.sessionManager.flush();

  const entryCountBefore = source.sessionManager.getEntries().length;
  await harness.agent.loadSession({ sessionId: source.sessionId, cwd: harness.cwd, mcpServers: [] });
  const stored = harness.sessions.at(-1)!;
  expect(stored.getPersonaRuntime()!.policy.isPersonaActive()).toBe(false);
  // No drift entry for a persona that cannot resolve.
  expect(stored.sessionManager.getEntries().length).toBe(entryCountBefore);
 });

 it("resolves the persona from the session cwd's project agents dir", async () => {
  const harness = await createPersonaHarness();
  const projectAgentsDir = path.join(harness.cwd, ".omp", "agents");
  await fs.promises.mkdir(projectAgentsDir, { recursive: true });
  await fs.promises.writeFile(
   path.join(projectAgentsDir, "acp-testb.md"),
   ["---", "name: acp-testb", "description: project-scoped persona", "tools: [read]", "---", "Project persona."].join(
    "\n",
   ),
  );

  const source = new PersonaStubSession(harness.cwd);
  harness.sessions.push(source);
  source.sessionManager.appendModeChange("agent", { name: "acp-testb" });
  await source.sessionManager.ensureOnDisk();
  await source.sessionManager.flush();

  await harness.agent.loadSession({ sessionId: source.sessionId, cwd: harness.cwd, mcpServers: [] });
  const stored = harness.sessions.at(-1)!;
  const policy = stored.getPersonaRuntime()!.policy;
  expect(policy.isPersonaActive()).toBe(true);
  expect(policy.effective("read")).toBe(true);
  expect(policy.effective("edit")).toBe(false);
 });

 it("emits an ACP text notice instead of a mid-turn model switch (defer channel)", async () => {
  const harness = await createPersonaHarness();
  const { createAcpPersonaModelHooks } = await import("@oh-my-pi/pi-coding-agent/modes/acp/acp-agent");
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

 it("resume (session/resume) reconciles like load", async () => {
  const harness = await createPersonaHarness();
  const source = new PersonaStubSession(harness.cwd);
  harness.sessions.push(source);
  source.sessionManager.appendMessage({ role: "user", content: "resume me", timestamp: Date.now() });
  source.sessionManager.appendModeChange("agent", { name: "acp-testa", explicit: { thinking: "high" } });
  await source.sessionManager.ensureOnDisk();
  await source.sessionManager.flush();

  await harness.agent.resumeSession({ sessionId: source.sessionId, cwd: harness.cwd, mcpServers: [] });
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
  source.sessionManager.appendMessage({ role: "user", content: "fork me", timestamp: Date.now() });
  source.sessionManager.appendModeChange("agent", { name: "acp-testa" });
  await source.sessionManager.ensureOnDisk();
  await source.sessionManager.flush();

  await harness.agent.unstable_forkSession({ sessionId: source.sessionId, cwd: harness.cwd, mcpServers: [] });
  const forkSession = harness.sessions.at(-1)!;
  const policy = forkSession.getPersonaRuntime()!.policy;
  expect(policy.effective("read")).toBe(true);
  const entry = await lastAgentModeChange(forkSession);
  expect(entry?.mode).toBe("agent");
  expect(entry?.data.name).toBe("acp-testa");
 });
});