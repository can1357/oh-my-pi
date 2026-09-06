/**
 * Interactive resume persona reconciliation (plan §3, PR 9510):
 *
 * - `omp --resume` of a session whose journal ends under agent mode
 *   (`mode_change agent {name}`) re-activates the persona through
 *   `InteractiveMode.#reconcilePersonaFromSession` → `PersonaRuntime.reconcile`.
 * - A persona definition deleted before resume degrades gracefully: the session
 *   lands unrestricted and a transient status notice explains the fallback.
 * - The CLI `--agent OTHER` launch seam (pendingPersonaAgent in sdk.ts) appends
 *   its own `mode_change agent` entry during construction, so it is the LAST
 *   entry on the journal when InteractiveMode reconciles — the CLI override
 *   wins without a second reconcile fighting the flag.
 *
 * Drives the real pipeline: real AgentSession + SessionToolPolicy +
 * PersonaRuntime over a real on-disk journal, with persona discovery pointed at
 * the temp project's `.omp/agents` dir.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { type Api, Effort, type Model } from "@oh-my-pi/pi-ai";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { PersonaRuntime } from "@oh-my-pi/pi-coding-agent/session/persona-runtime";
import { SessionToolPolicy } from "@oh-my-pi/pi-coding-agent/session/tool-policy";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { TempDir } from "@oh-my-pi/pi-utils";
import { InteractiveMode } from "../src/modes/interactive-mode";

const READER_AGENT_MD = `---
name: fixture-reader
description: Read-only fixture persona
tools:
  - read
---

You are the fixture reader persona.`;

describe("InteractiveMode persona resume reconcile", () => {
 let tempDir: TempDir;
 let authStorage: AuthStorage;
 let mode: InteractiveMode | undefined;
 let session: AgentSession | undefined;
 let statusMessages: string[];
 let model: Model<Api>;

 beforeAll(() => {
  initTheme();
 });

 beforeEach(async () => {
  resetSettingsForTest();
  tempDir = TempDir.createSync("@omp-resume-persona-");
  await Settings.init({ inMemory: true, cwd: tempDir.path() });
  Settings.instance.set("startup.quiet", true);
  authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
  authStorage.setRuntimeApiKey("anthropic", "test-key");
  const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
  if (!bundled) throw new Error("Expected built-in anthropic model to exist");
  model = bundled;
  statusMessages = [];
 });

 afterEach(async () => {
  vi.restoreAllMocks();
  mode?.stop();
  await session?.dispose();
  authStorage?.close();
  tempDir?.removeSync();
  mode = undefined;
  session = undefined;
  authStorage = undefined as unknown as AuthStorage;
  tempDir = undefined as unknown as TempDir;
  resetSettingsForTest();
 });

 async function writeFixtureAgent(content: string, name = "fixture-reader.md"): Promise<void> {
  const agentsDir = path.join(tempDir.path(), ".omp", "agents");
  await fs.mkdir(agentsDir, { recursive: true });
  await fs.writeFile(path.join(agentsDir, name), content, "utf-8");
 }

 /**
  * Build a session the way the harness's other tests do, but with the
  * persona-capable plumbing sdk.ts installs: SessionToolPolicy +
  * PersonaRuntime wired via setPersonaRuntime. `sessionManager` may be a
  * pre-built manager carrying the journal to resume.
  */
 function createSession(sessionManager: SessionManager): AgentSession {
  const readTool = {
   name: "read",
   label: "read",
   description: "Fake read",
   parameters: {} as never,
   async execute() {
    return { content: [{ type: "text" as const, text: "ok" }] };
   },
  };
  const writeTool = {
   name: "write",
   label: "write",
   description: "Fake write",
   parameters: {} as never,
   async execute() {
    return { content: [{ type: "text" as const, text: "ok" }] };
   },
  };
  const toolRegistry = new Map<string, typeof readTool>();
  toolRegistry.set("read", readTool);
  toolRegistry.set("write", writeTool);
  const createdSession = new AgentSession({
   agent: new Agent({
    initialState: {
     model,
     systemPrompt: ["Test"],
     tools: [readTool, writeTool],
     messages: [],
     thinkingLevel: Effort.Medium,
    },
   }),
   sessionManager,
   settings: Settings.instance,
   modelRegistry: new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml")),
   toolRegistry,
   builtInToolNames: ["read", "write"],
   toolPolicy: new SessionToolPolicy({
    registry: () => new Set(["read", "write"]),
    isDefaultActive: () => true,
   }),
  });
  session = createdSession;
  createdSession.setPersonaRuntime(
   new PersonaRuntime(createdSession.getToolPolicy()!, createdSession),
  );
  return createdSession;
 }

 function createMode(createdSession: AgentSession): InteractiveMode {
  mode = new InteractiveMode(createdSession, "test");
  return mode;
 }

 function spyStatus(created: InteractiveMode): InteractiveMode {
  vi.spyOn(created, "showStatus").mockImplementation(((message: string) => {
   statusMessages.push(message);
  }) as typeof created.showStatus);
  return created;
 }

 async function lastAgentModeChange(
  sessionManager: SessionManager,
 ): Promise<{ mode: string; data: Record<string, unknown> } | undefined> {
  const entries = sessionManager
   .getEntries()
   .filter(entry => entry.type === "mode_change")
   .map(entry => entry as { mode: string; data?: Record<string, unknown> });
  const last = entries.at(-1);
  if (!last) return undefined;
  return { mode: last.mode, data: last.data ?? {} };
 }

 it("restores the persisted persona on resume", async () => {
  // Build the stored persona session: journal ends under agent mode.
  const sourceManager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions"));
  sourceManager.appendMessage({ role: "user", content: "prior turn", timestamp: Date.now() });
  sourceManager.appendModeChange("agent", { name: "fixture-reader" });
  await sourceManager.ensureOnDisk();
  await sourceManager.flush();
  const sourceFile = sourceManager.getSessionFile();
  if (!sourceFile) throw new Error("Expected session file");
  await sourceManager.close();

  await writeFixtureAgent(READER_AGENT_MD);

  const resumedManager = await SessionManager.open(sourceFile, path.join(tempDir.path(), "sessions"));
  const createdSession = createSession(resumedManager);
  const created = createMode(createdSession);
  await created.init({ suppressWelcomeIntro: true });

  const policy = createdSession.getPersonaRuntime()!.policy;
  expect(policy.isPersonaActive()).toBe(true);
  // Persona grant narrows the live set: write is out, read stays.
  expect(createdSession.getPersonaAppendPrompt()).toContain("fixture reader persona");
  const active = new Set(createdSession.getActiveToolNames());
  expect(active.has("read")).toBe(true);
  expect(active.has("write")).toBe(false);
 });

 it("falls back gracefully with a notice when the persona definition is gone", async () => {
  const sourceManager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions"));
  sourceManager.appendMessage({ role: "user", content: "prior turn", timestamp: Date.now() });
  sourceManager.appendModeChange("agent", { name: "evaporated-persona" });
  await sourceManager.ensureOnDisk();
  await sourceManager.flush();
  const sourceFile = sourceManager.getSessionFile();
  if (!sourceFile) throw new Error("Expected session file");
  await sourceManager.close();

  // No agent file written: the persona definition was deleted pre-resume.
  const createdSession = createSession(await SessionManager.open(sourceFile, path.join(tempDir.path(), "sessions")));
  const created = spyStatus(createMode(createdSession));
  await created.init({ suppressWelcomeIntro: true });

  expect(createdSession.getPersonaRuntime()!.policy.isPersonaActive()).toBe(false);
  expect(createdSession.getPersonaAppendPrompt()).toBeUndefined();
  // Unrestricted: the default tool set survives.
  expect(createdSession.getActiveToolNames()).toContain("write");
  expect(statusMessages.some(message => message.includes("evaporated-persona"))).toBe(true);
 });

 it("CLI --agent override wins: the launch seam's entry is last, so the journal reconcile is a no-op", async () => {
  // Stored persona session, like acceptance 1 but resumed with --agent OTHER:
  // buildSessionOptions resolved the CLI agent BEFORE the session existed and
  // sdk.ts appended its own mode_change during construction, so the journal
  // read by #reconcilePersonaFromSession sees the OVERRIDE as the last entry.
  const sourceManager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions"));
  sourceManager.appendMessage({ role: "user", content: "prior turn", timestamp: Date.now() });
  sourceManager.appendModeChange("agent", { name: "stale-persona" });
  await sourceManager.ensureOnDisk();
  await sourceManager.flush();
  const sourceFile = sourceManager.getSessionFile();
  if (!sourceFile) throw new Error("Expected session file");
  await sourceManager.close();

  await writeFixtureAgent(READER_AGENT_MD, "fixture-reader.md");

  const resumedManager = await SessionManager.open(sourceFile, path.join(tempDir.path(), "sessions"));
  const createdSession = createSession(resumedManager);
  // Launch seam parity: the CLI-selected persona entered during session
  // construction and appended its journal entry (what sdk.ts does for
  // pendingPersonaAgent). The interactive reconcile must not clobber it.
  const runtime = createdSession.getPersonaRuntime()!;
  await runtime.enter(
   { name: "fixture-reader", description: "", systemPrompt: "", tools: ["read"], source: "bundled" },
   {},
   { apply: async () => { }, restore: async () => { } },
  );
  resumedManager.appendModeChange("agent", { name: "fixture-reader" });

  const created = createMode(createdSession);
  await created.init({ suppressWelcomeIntro: true });

  const policy = createdSession.getPersonaRuntime()!.policy;
  expect(policy.isPersonaActive()).toBe(true);
  const entry = await lastAgentModeChange(resumedManager);
  expect(entry?.data.name).toBe("fixture-reader");
  expect(statusMessages.some(message => message.includes("stale-persona"))).toBe(false);
 });
});