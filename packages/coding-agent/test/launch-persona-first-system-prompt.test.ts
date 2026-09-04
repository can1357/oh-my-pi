/**
 * Launch persona first system prompt: `--agent` stores the persona's prompt in
 * `options.personaAppendPrompt`, and the FIRST `rebuildSystemPrompt` (which runs
 * before `session = new AgentSession(...)` is assigned) must include it. The
 * session's seeded `agent.state.systemPrompt` comes from that first build, so
 * asserting on `session.systemPrompt` after a real `createAgentSession` proves
 * the persona prompt reached the first provider request.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Effort } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { saveLearnedLesson } from "@oh-my-pi/pi-coding-agent/memories";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { type CreateAgentSessionOptions, createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { ModelRegistry } from "../src/config/model-registry";
import { applyAgentPersonaOptions } from "../src/main";
import * as discovery from "../src/task/discovery";

const PERSONA_PROMPT = "You are the launch persona. Follow the launch persona rules.";
const SECOND_PERSONA_PROMPT = "You are the second persona. Follow the second persona rules.";

function agentMd(name: string, extraFrontmatter: string[] = []): string {
 return ["---", `name: ${name}`, `description: ${name}`, ...extraFrontmatter, "---", PERSONA_PROMPT].join("\n");
}

describe("launch persona first system prompt", () => {
 let tempHome: string;
 let projectDir: string;
 let agentsDir: string;
 let authStorage: AuthStorage;
 let modelRegistry: ModelRegistry;
 let session: AgentSession | undefined;

 beforeAll(() => {
  initTheme();
 });

 beforeEach(async () => {
  resetSettingsForTest();
  tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "omp-launch-persona-prompt-"));
  projectDir = path.join(tempHome, "project");
  agentsDir = path.join(projectDir, ".omp", "agents");
  await fs.mkdir(agentsDir, { recursive: true });
  await Settings.init({ inMemory: true, cwd: projectDir });
  Settings.instance.set("startup.quiet", true);
  authStorage = await AuthStorage.create(path.join(tempHome, "testauth.db"));
  modelRegistry = new ModelRegistry(authStorage, path.join(tempHome, "models.yml"));
 });

 afterEach(async () => {
  await session?.dispose();
  authStorage?.close();
  await fs.rm(tempHome, { recursive: true, force: true });
  session = undefined;
  resetSettingsForTest();
 });

 it("includes the persona's system prompt in the FIRST system prompt build", async () => {
  await fs.writeFile(path.join(agentsDir, "launch-persona.md"), agentMd("launch-persona"));

  const model = getBundledModel("anthropic", "claude-sonnet-4-5");
  if (!model) throw new Error("Expected bundled anthropic/claude-sonnet-4-5 to exist");

  const sessionManager = SessionManager.inMemory(projectDir);
  const options: Parameters<typeof createAgentSession>[0] = {
   cwd: projectDir,
   agentDir: tempHome,
   authStorage,
   modelRegistry,
   sessionManager,
   settings: Settings.isolated({ "compaction.enabled": false }),
   model,
   disableExtensionDiscovery: true,
   skills: [],
   contextFiles: [],
   promptTemplates: [],
   slashCommands: [],
   enableMCP: false,
   enableLsp: false,
   skipPythonPreflight: true,
   toolNames: ["read", "write"],
  };
  // Mirror the launch path: `--agent` applies the persona's frontmatter at
  // session creation (buildSessionOptions → applyAgentPersonaOptions).
  const { agents } = await discovery.discoverAgents(projectDir, tempHome);
  const agent = agents.find(candidate => candidate.name === "launch-persona");
  expect(agent).toBeDefined();
  applyAgentPersonaOptions(options, agent!, { modelSet: false, thinkingSet: false, toolsSet: false });
  options.personaName = "launch-persona";

  const result = await createAgentSession(options);
  session = result.session;

  // `agent.state.systemPrompt` is seeded from the FIRST rebuildSystemPrompt
  // (which runs before the session is constructed). The persona prompt must
  // be present there — the first provider request starts with it.
  expect(session.systemPrompt.join("\n")).toContain(PERSONA_PROMPT);
 });

 it("captures the full built-in baseline so restoreBaselineTools re-enables bash/write", async () => {
  // Regression: `--agent` with a `tools:` list used to build the tool
  // registry from ONLY the requested names, so `baselineToolNames` (the
  // set `restoreBaselineTools` re-activates when the persona is left)
  // was the restricted list — bash/write were never registered and could
  // not be restored. The registry must hold every allowed built-in while
  // the ACTIVE set stays restricted to the persona's tools.
  await fs.writeFile(
   path.join(agentsDir, "read-only-persona.md"),
   agentMd("read-only-persona", ["tools: [read]", "spawns: [scout]"]),
  );

  const model = getBundledModel("anthropic", "claude-sonnet-4-5");
  if (!model) throw new Error("Expected bundled anthropic/claude-sonnet-4-5 to exist");

  const sessionManager = SessionManager.inMemory(projectDir);
  const options: Parameters<typeof createAgentSession>[0] = {
   cwd: projectDir,
   agentDir: tempHome,
   authStorage,
   modelRegistry,
   sessionManager,
   settings: Settings.isolated({ "compaction.enabled": false }),
   model,
   disableExtensionDiscovery: true,
   skills: [],
   contextFiles: [],
   promptTemplates: [],
   slashCommands: [],
   enableMCP: false,
   enableLsp: false,
   skipPythonPreflight: true,
   toolNames: ["read", "write"],
  };
  const { agents } = await discovery.discoverAgents(projectDir, tempHome);
  const agent = agents.find(candidate => candidate.name === "read-only-persona");
  expect(agent).toBeDefined();
  applyAgentPersonaOptions(options, agent!, { modelSet: false, thinkingSet: false, toolsSet: false });
  options.personaName = "read-only-persona";

  const result = await createAgentSession(options);
  session = result.session;

  // The persona's `tools: [read]` restricts the ACTIVE set to EXACTLY
  // [read] — no bash/write/MCP/extension/memory widening (subagent
  // restrictToolNames semantics).
  const enabled = session.getEnabledToolNames();
  expect(enabled).toEqual(["read", "task"]);
  // The persona's spawn policy is the session's spawn policy.
  expect(session.getSessionSpawns()).toBe("scout");

  // ...but the baseline (what leaving agent mode restores) is the FULL
  // registry minus default-inactive tools — bash/write included.
  const baseline = session.getBaselineToolNames();
  expect(baseline).toBeDefined();
  expect(baseline).toEqual(expect.arrayContaining(["read", "bash", "write"]));

  // Leaving the persona re-enables the tools that were never active.
  await session.restoreBaselineTools();
  const restored = session.getEnabledToolNames();
  expect(restored).toContain("bash");
  expect(restored).toContain("write");
  expect(restored).toContain("read");
 });

 it("enables the LSP tool for a main-session persona that explicitly requests it", async () => {
  // Regression (codex #3755364827): a main-session persona with
  // `tools: [lsp, ...]` used to start WITHOUT the LSP tool — the persona
  // restriction made the SDK session restricted, `createAgentSession`
  // defaulted `enableLsp` to false for restricted sessions, and
  // `createTools` filtered `lsp` out via `isBuiltinToolAllowed`. A later
  // live `/agent` switch to the same persona CAN enable it (the normal
  // session's `enableLsp` is already true). The persona's explicit
  // request must be honored at launch too.
  await fs.writeFile(path.join(agentsDir, "lsp-persona.md"), agentMd("lsp-persona", ["tools: [lsp, read]"]));

  const model = getBundledModel("anthropic", "claude-sonnet-4-5");
  if (!model) throw new Error("Expected bundled anthropic/claude-sonnet-4-5 to exist");

  const sessionManager = SessionManager.inMemory(projectDir);
  const options: Parameters<typeof createAgentSession>[0] = {
   cwd: projectDir,
   agentDir: tempHome,
   authStorage,
   modelRegistry,
   sessionManager,
   settings: Settings.isolated({ "compaction.enabled": false }),
   model,
   disableExtensionDiscovery: true,
   skills: [],
   contextFiles: [],
   promptTemplates: [],
   slashCommands: [],
   enableMCP: false,
   skipPythonPreflight: true,
   toolNames: ["read", "write"],
  };
  const { agents } = await discovery.discoverAgents(projectDir, tempHome);
  const agent = agents.find(candidate => candidate.name === "lsp-persona");
  expect(agent).toBeDefined();
  applyAgentPersonaOptions(options, agent!, { modelSet: false, thinkingSet: false, toolsSet: false });
  options.personaName = "lsp-persona";

  const result = await createAgentSession(options);
  session = result.session;

  // The persona's explicit `tools: [lsp, read]` is the EXACT active set —
  // lsp must be present and registered, not filtered by the restricted-
  // session LSP disablement.
  expect(session.getEnabledToolNames()).toEqual(["lsp", "read"]);
  expect(session.getToolByName("lsp")).toBeDefined();
 });

 it("keeps LSP disabled for a main-session persona that does not request it", async () => {
  // Control: a persona WITHOUT lsp in its tools list must not get LSP —
  // the restricted-session default (enableLsp false) stays in force.
  await fs.writeFile(path.join(agentsDir, "read-only-persona.md"), agentMd("read-only-persona", ["tools: [read]"]));

  const model = getBundledModel("anthropic", "claude-sonnet-4-5");
  if (!model) throw new Error("Expected bundled anthropic/claude-sonnet-4-5 to exist");

  const sessionManager = SessionManager.inMemory(projectDir);
  const options: Parameters<typeof createAgentSession>[0] = {
   cwd: projectDir,
   agentDir: tempHome,
   authStorage,
   modelRegistry,
   sessionManager,
   settings: Settings.isolated({ "compaction.enabled": false }),
   model,
   disableExtensionDiscovery: true,
   skills: [],
   contextFiles: [],
   promptTemplates: [],
   slashCommands: [],
   enableMCP: false,
   skipPythonPreflight: true,
   toolNames: ["read", "write"],
  };
  const { agents } = await discovery.discoverAgents(projectDir, tempHome);
  const agent = agents.find(candidate => candidate.name === "read-only-persona");
  expect(agent).toBeDefined();
  applyAgentPersonaOptions(options, agent!, { modelSet: false, thinkingSet: false, toolsSet: false });
  options.personaName = "read-only-persona";

  const result = await createAgentSession(options);
  session = result.session;

  expect(session.getEnabledToolNames()).toEqual(["read"]);
  expect(session.getToolByName("lsp")).toBeUndefined();
 });

 it("activates the hub tool at launch for a main-session persona that explicitly requests it", async () => {
  // Regression (codex #3762787590): a main-session persona with
  // `tools: [hub, ...]` used to start WITHOUT the hub tool — the
  // persona restriction set `restrictToolNames`, `isBuiltinToolAllowed`
  // rejects `hub` whenever `restrictToolNames` is true, and the launch
  // registration filtered the persona's exact request out of the active
  // set (unlike the wave-20 restore path, which lifts hub on demand
  // when the baseline policy holds). The persona's explicit request
  // must be honored at launch too.
  await fs.writeFile(path.join(agentsDir, "hub-persona.md"), agentMd("hub-persona", ["tools: [hub, read]"]));

  const model = getBundledModel("anthropic", "claude-sonnet-4-5");
  if (!model) throw new Error("Expected bundled anthropic/claude-sonnet-4-5 to exist");

  const sessionManager = SessionManager.inMemory(projectDir);
  const options: Parameters<typeof createAgentSession>[0] = {
   cwd: projectDir,
   agentDir: tempHome,
   authStorage,
   modelRegistry,
   sessionManager,
   settings: Settings.isolated({ "compaction.enabled": false }),
   model,
   disableExtensionDiscovery: true,
   skills: [],
   contextFiles: [],
   promptTemplates: [],
   slashCommands: [],
   enableMCP: false,
   skipPythonPreflight: true,
   toolNames: ["read", "write"],
  };
  const { agents } = await discovery.discoverAgents(projectDir, tempHome);
  const agent = agents.find(candidate => candidate.name === "hub-persona");
  expect(agent).toBeDefined();
  applyAgentPersonaOptions(options, agent!, { modelSet: false, thinkingSet: false, toolsSet: false });
  options.personaName = "hub-persona";

  const result = await createAgentSession(options);
  session = result.session;

  // The persona's explicit `tools: [hub, read]` is the EXACT active
  // set — hub must be present and registered, not filtered by the
  // restricted-session gate. Spawning is enabled at top level (default
  // task.maxRecursionDepth 2), so the non-persona hub policy holds.
  expect(session.getEnabledToolNames()).toEqual(["hub", "read"]);
  expect(session.getToolByName("hub")).toBeDefined();
 });

 it("keeps hub disabled for a main-session persona that does not request it", async () => {
  // Control: a persona WITHOUT hub in its tools list must not get hub —
  // the restricted gate (`restrictToolNames` / forced-off `enableIrc`)
  // stays in force.
  await fs.writeFile(path.join(agentsDir, "read-only-persona.md"), agentMd("read-only-persona", ["tools: [read]"]));

  const model = getBundledModel("anthropic", "claude-sonnet-4-5");
  if (!model) throw new Error("Expected bundled anthropic/claude-sonnet-4-5 to exist");

  const sessionManager = SessionManager.inMemory(projectDir);
  const options: Parameters<typeof createAgentSession>[0] = {
   cwd: projectDir,
   agentDir: tempHome,
   authStorage,
   modelRegistry,
   sessionManager,
   settings: Settings.isolated({ "compaction.enabled": false }),
   model,
   disableExtensionDiscovery: true,
   skills: [],
   contextFiles: [],
   promptTemplates: [],
   slashCommands: [],
   enableMCP: false,
   skipPythonPreflight: true,
   toolNames: ["read", "write"],
  };
  const { agents } = await discovery.discoverAgents(projectDir, tempHome);
  const agent = agents.find(candidate => candidate.name === "read-only-persona");
  expect(agent).toBeDefined();
  applyAgentPersonaOptions(options, agent!, { modelSet: false, thinkingSet: false, toolsSet: false });
  options.personaName = "read-only-persona";

  const result = await createAgentSession(options);
  session = result.session;

  expect(session.getEnabledToolNames()).toEqual(["read"]);
  expect(session.getToolByName("hub")).toBeUndefined();
 });

 it("keeps hub disabled when the persona launch explicitly disabled IRC", async () => {
  // Control: an explicit `enableIrc: false` (the only way IRC is
  // disabled — there is no `--no-irc` CLI flag; internal callers like
  // the security coordinator set it) must still win even when the
  // persona's tools list requests hub — `baselineHubEnabled` stays
  // false, so the launch lift never fires.
  await fs.writeFile(path.join(agentsDir, "hub-persona.md"), agentMd("hub-persona", ["tools: [hub, read]"]));

  const model = getBundledModel("anthropic", "claude-sonnet-4-5");
  if (!model) throw new Error("Expected bundled anthropic/claude-sonnet-4-5 to exist");

  const sessionManager = SessionManager.inMemory(projectDir);
  const options: Parameters<typeof createAgentSession>[0] = {
   cwd: projectDir,
   agentDir: tempHome,
   authStorage,
   modelRegistry,
   sessionManager,
   settings: Settings.isolated({ "compaction.enabled": false }),
   model,
   disableExtensionDiscovery: true,
   skills: [],
   contextFiles: [],
   promptTemplates: [],
   slashCommands: [],
   enableMCP: false,
   enableIrc: false,
   skipPythonPreflight: true,
   toolNames: ["read", "write"],
  };
  const { agents } = await discovery.discoverAgents(projectDir, tempHome);
  const agent = agents.find(candidate => candidate.name === "hub-persona");
  expect(agent).toBeDefined();
  applyAgentPersonaOptions(options, agent!, { modelSet: false, thinkingSet: false, toolsSet: false });
  options.personaName = "hub-persona";

  const result = await createAgentSession(options);
  session = result.session;

  expect(session.getEnabledToolNames()).toEqual(["read"]);
  expect(session.getToolByName("hub")).toBeUndefined();
 });

 it("restores lsp after leaving a persona whose tools omitted it (restricted default, no --no-lsp)", async () => {
  // Regression (codex #3760616705): `--agent` with a restrictive
  // `tools:` list that omits `lsp` (e.g. tools: [read]) while
  // `lsp.enabled` is left at its default true makes session creation
  // default `enableLsp` to false (the restricted-session DEFAULT, not an
  // explicit `--no-lsp`). The baseline expansion used that restricted
  // gate, so the widened registry/baseline never contained `lsp` and
  // `restoreBaselineTools()` could not restore the LSP tool a normal
  // unrestricted session would have. The baseline must be built with the
  // non-persona LSP policy: `lsp` is included (and restored) unless
  // `--no-lsp` was explicit.
  await fs.writeFile(path.join(agentsDir, "read-only-persona.md"), agentMd("read-only-persona", ["tools: [read]"]));

  const model = getBundledModel("anthropic", "claude-sonnet-4-5");
  if (!model) throw new Error("Expected bundled anthropic/claude-sonnet-4-5 to exist");

  const sessionManager = SessionManager.inMemory(projectDir);
  const options: Parameters<typeof createAgentSession>[0] = {
   cwd: projectDir,
   agentDir: tempHome,
   authStorage,
   modelRegistry,
   sessionManager,
   settings: Settings.isolated({ "compaction.enabled": false }),
   model,
   disableExtensionDiscovery: true,
   skills: [],
   contextFiles: [],
   promptTemplates: [],
   slashCommands: [],
   enableMCP: false,
   skipPythonPreflight: true,
   toolNames: ["read", "write"],
  };
  const { agents } = await discovery.discoverAgents(projectDir, tempHome);
  const agent = agents.find(candidate => candidate.name === "read-only-persona");
  expect(agent).toBeDefined();
  applyAgentPersonaOptions(options, agent!, { modelSet: false, thinkingSet: false, toolsSet: false });
  options.personaName = "read-only-persona";

  const result = await createAgentSession(options);
  session = result.session;

  // The persona's `tools: [read]` restricts the ACTIVE set to EXACTLY
  // [read] — lsp stays out while the persona is active.
  expect(session.getEnabledToolNames()).toEqual(["read"]);
  expect(session.getToolByName("lsp")).toBeUndefined();

  // ...but the baseline (what leaving agent mode restores) is the full
  // registry minus default-inactive tools, PLUS lsp — the tool set a
  // normal unrestricted session would have (lsp.enabled defaults true).
  const baseline = session.getBaselineToolNames();
  expect(baseline).toBeDefined();
  expect(baseline).toEqual(expect.arrayContaining(["read", "bash", "write", "lsp"]));

  // Leaving the persona re-enables the tools that were never active,
  // including lsp (registered on demand from the baseline).
  await session.restoreBaselineTools();
  const restored = session.getEnabledToolNames();
  expect(restored).toContain("bash");
  expect(restored).toContain("write");
  expect(restored).toContain("read");
  expect(restored).toContain("lsp");
  expect(session.getToolByName("lsp")).toBeDefined();
 });

 it("keeps lsp out of the baseline when the persona launch combined an explicit --no-lsp", async () => {
  // Control: an explicit `--no-lsp` (enableLsp: false passed at
  // creation) must still win — the baseline excludes lsp and
  // restoreBaselineTools does not restore it.
  await fs.writeFile(path.join(agentsDir, "read-only-persona.md"), agentMd("read-only-persona", ["tools: [read]"]));

  const model = getBundledModel("anthropic", "claude-sonnet-4-5");
  if (!model) throw new Error("Expected bundled anthropic/claude-sonnet-4-5 to exist");

  const sessionManager = SessionManager.inMemory(projectDir);
  const options: Parameters<typeof createAgentSession>[0] = {
   cwd: projectDir,
   agentDir: tempHome,
   authStorage,
   modelRegistry,
   sessionManager,
   settings: Settings.isolated({ "compaction.enabled": false }),
   model,
   disableExtensionDiscovery: true,
   skills: [],
   contextFiles: [],
   promptTemplates: [],
   slashCommands: [],
   enableMCP: false,
   enableLsp: false,
   skipPythonPreflight: true,
   toolNames: ["read", "write"],
  };
  const { agents } = await discovery.discoverAgents(projectDir, tempHome);
  const agent = agents.find(candidate => candidate.name === "read-only-persona");
  expect(agent).toBeDefined();
  applyAgentPersonaOptions(options, agent!, { modelSet: false, thinkingSet: false, toolsSet: false });
  options.personaName = "read-only-persona";

  const result = await createAgentSession(options);
  session = result.session;

  expect(session.getEnabledToolNames()).toEqual(["read"]);

  const baseline = session.getBaselineToolNames();
  expect(baseline).toBeDefined();
  expect(baseline).toEqual(expect.arrayContaining(["read", "bash", "write"]));
  expect(baseline).not.toContain("lsp");

  await session.restoreBaselineTools();
  const restored = session.getEnabledToolNames();
  expect(restored).toContain("bash");
  expect(restored).toContain("write");
  expect(restored).not.toContain("lsp");
  expect(session.getToolByName("lsp")).toBeUndefined();
 });

 it("restores hub after leaving a persona whose tools omitted it (spawning enabled)", async () => {
  // Regression (codex #3761223376): `--agent` with a restrictive
  // `tools:` list that omits `hub` (e.g. tools: [read]) makes the
  // expandRegistryToAllBuiltins expansion use the restricted
  // `isToolAllowed()` context, and `isBuiltinToolAllowed` rejects `hub`
  // whenever `restrictToolNames` is true — so the widened registry and
  // the baseline never contained `hub` and `restoreBaselineTools()`
  // could not restore peer/job supervision after leaving agent mode.
  // The baseline must use the non-persona hub policy: `hub` is included
  // (and restored on demand) when a normal unrestricted session would
  // have it — spawning enabled (`task.maxRecursionDepth` default 2 at
  // top level) and IRC not explicitly disabled.
  await fs.writeFile(path.join(agentsDir, "read-only-persona.md"), agentMd("read-only-persona", ["tools: [read]"]));

  const model = getBundledModel("anthropic", "claude-sonnet-4-5");
  if (!model) throw new Error("Expected bundled anthropic/claude-sonnet-4-5 to exist");

  const sessionManager = SessionManager.inMemory(projectDir);
  const options: Parameters<typeof createAgentSession>[0] = {
   cwd: projectDir,
   agentDir: tempHome,
   authStorage,
   modelRegistry,
   sessionManager,
   settings: Settings.isolated({ "compaction.enabled": false }),
   model,
   disableExtensionDiscovery: true,
   skills: [],
   contextFiles: [],
   promptTemplates: [],
   slashCommands: [],
   enableMCP: false,
   skipPythonPreflight: true,
   toolNames: ["read", "write"],
  };
  const { agents } = await discovery.discoverAgents(projectDir, tempHome);
  const agent = agents.find(candidate => candidate.name === "read-only-persona");
  expect(agent).toBeDefined();
  applyAgentPersonaOptions(options, agent!, { modelSet: false, thinkingSet: false, toolsSet: false });
  options.personaName = "read-only-persona";

  const result = await createAgentSession(options);
  session = result.session;

  // The persona's `tools: [read]` restricts the ACTIVE set to EXACTLY
  // [read] — hub stays out while the persona is active.
  expect(session.getEnabledToolNames()).toEqual(["read"]);
  expect(session.getToolByName("hub")).toBeUndefined();

  // ...but the baseline (what leaving agent mode restores) is the full
  // registry minus default-inactive tools, PLUS hub — the tool set a
  // normal unrestricted session would have (spawning enabled at top
  // level, IRC not explicitly disabled).
  const baseline = session.getBaselineToolNames();
  expect(baseline).toBeDefined();
  expect(baseline).toEqual(expect.arrayContaining(["read", "bash", "write", "hub"]));

  // Leaving the persona re-enables the tools that were never active,
  // including hub (registered on demand from the baseline).
  await session.restoreBaselineTools();
  const restored = session.getEnabledToolNames();
  expect(restored).toContain("bash");
  expect(restored).toContain("write");
  expect(restored).toContain("read");
  expect(restored).toContain("hub");
  expect(session.getToolByName("hub")).toBeDefined();
 });

 it("keeps hub in the baseline for a persona without a tools list (unrestricted session)", async () => {
  // Control: a persona WITHOUT `tools:` leaves the session unrestricted,
  // so the launch registry already holds hub and the baseline includes
  // it — the existing behavior must not regress.
  await fs.writeFile(path.join(agentsDir, "no-tools-persona.md"), agentMd("no-tools-persona"));

  const model = getBundledModel("anthropic", "claude-sonnet-4-5");
  if (!model) throw new Error("Expected bundled anthropic/claude-sonnet-4-5 to exist");

  const sessionManager = SessionManager.inMemory(projectDir);
  const options: Parameters<typeof createAgentSession>[0] = {
   cwd: projectDir,
   agentDir: tempHome,
   authStorage,
   modelRegistry,
   sessionManager,
   settings: Settings.isolated({ "compaction.enabled": false }),
   model,
   disableExtensionDiscovery: true,
   skills: [],
   contextFiles: [],
   promptTemplates: [],
   slashCommands: [],
   enableMCP: false,
   skipPythonPreflight: true,
   toolNames: ["read", "write"],
  };
  const { agents } = await discovery.discoverAgents(projectDir, tempHome);
  const agent = agents.find(candidate => candidate.name === "no-tools-persona");
  expect(agent).toBeDefined();
  applyAgentPersonaOptions(options, agent!, { modelSet: false, thinkingSet: false, toolsSet: false });
  options.personaName = "no-tools-persona";

  const result = await createAgentSession(options);
  session = result.session;

  const baseline = session.getBaselineToolNames();
  expect(baseline).toBeDefined();
  expect(baseline).toContain("hub");
 });

 it("keeps hub out of the baseline when the persona launch explicitly disabled IRC", async () => {
  // Control: an explicit `enableIrc: false` (the only way IRC is
  // disabled — there is no `--no-irc` CLI flag; internal callers like
  // the security coordinator set it) must still win — the baseline
  // excludes hub and restoreBaselineTools does not restore it.
  await fs.writeFile(path.join(agentsDir, "read-only-persona.md"), agentMd("read-only-persona", ["tools: [read]"]));

  const model = getBundledModel("anthropic", "claude-sonnet-4-5");
  if (!model) throw new Error("Expected bundled anthropic/claude-sonnet-4-5 to exist");

  const sessionManager = SessionManager.inMemory(projectDir);
  const options: Parameters<typeof createAgentSession>[0] = {
   cwd: projectDir,
   agentDir: tempHome,
   authStorage,
   modelRegistry,
   sessionManager,
   settings: Settings.isolated({ "compaction.enabled": false }),
   model,
   disableExtensionDiscovery: true,
   skills: [],
   contextFiles: [],
   promptTemplates: [],
   slashCommands: [],
   enableMCP: false,
   enableIrc: false,
   skipPythonPreflight: true,
   toolNames: ["read", "write"],
  };
  const { agents } = await discovery.discoverAgents(projectDir, tempHome);
  const agent = agents.find(candidate => candidate.name === "read-only-persona");
  expect(agent).toBeDefined();
  applyAgentPersonaOptions(options, agent!, { modelSet: false, thinkingSet: false, toolsSet: false });
  options.personaName = "read-only-persona";

  const result = await createAgentSession(options);
  session = result.session;

  expect(session.getEnabledToolNames()).toEqual(["read"]);

  const baseline = session.getBaselineToolNames();
  expect(baseline).toBeDefined();
  expect(baseline).toEqual(expect.arrayContaining(["read", "bash", "write"]));
  expect(baseline).not.toContain("hub");

  await session.restoreBaselineTools();
  const restored = session.getEnabledToolNames();
  expect(restored).toContain("bash");
  expect(restored).toContain("write");
  expect(restored).not.toContain("hub");
  expect(session.getToolByName("hub")).toBeUndefined();
 });

 it("keeps the explicit CLI tool override as the baseline when --agent is combined with --tools", async () => {
  // Regression (wave-8 review P2): with `--agent` PLUS an explicit tool
  // override (`--tools read`), startup keeps the active tools restricted
  // to read, but the baseline was captured from the FULL registry solely
  // because personaName is set. After switching to a persona without a
  // tools list, or to a non-agent transcript, restoreBaselineTools()
  // re-enabled bash/write — the explicit CLI override stopped being
  // honored after the first persona transition. The baseline must be the
  // explicit CLI tool set, so leaving agent mode re-enables exactly the
  // CLI list.
  await fs.writeFile(
   path.join(agentsDir, "cli-tools-persona.md"),
   agentMd("cli-tools-persona", ["tools: [read, write]"]),
  );

  const model = getBundledModel("anthropic", "claude-sonnet-4-5");
  if (!model) throw new Error("Expected bundled anthropic/claude-sonnet-4-5 to exist");

  const sessionManager = SessionManager.inMemory(projectDir);
  const options: Parameters<typeof createAgentSession>[0] = {
   cwd: projectDir,
   agentDir: tempHome,
   authStorage,
   modelRegistry,
   sessionManager,
   settings: Settings.isolated({ "compaction.enabled": false }),
   model,
   disableExtensionDiscovery: true,
   skills: [],
   contextFiles: [],
   promptTemplates: [],
   slashCommands: [],
   enableMCP: false,
   enableLsp: false,
   skipPythonPreflight: true,
   toolNames: ["read", "write"],
  };
  const { agents } = await discovery.discoverAgents(projectDir, tempHome);
  const agent = agents.find(candidate => candidate.name === "cli-tools-persona");
  expect(agent).toBeDefined();
  // Mirror the launch path: `--tools read` sets options.toolNames BEFORE
  // the persona is applied, and toolsSet: true means the persona's
  // `tools: [read, write]` frontmatter is NOT applied.
  options.toolNames = ["read"];
  applyAgentPersonaOptions(options, agent!, { modelSet: false, thinkingSet: false, toolsSet: true });
  options.personaName = "cli-tools-persona";

  const result = await createAgentSession(options);
  session = result.session;

  // The explicit CLI override wins: the active set is EXACTLY [read],
  // not the persona's [read, write].
  expect(session.getEnabledToolNames()).toEqual(["read"]);

  // ...and the baseline (what leaving agent mode restores) is the CLI
  // tool set, NOT the full registry — bash/write must not come back.
  const baseline = session.getBaselineToolNames();
  expect(baseline).toEqual(["read"]);

  // Leaving the persona re-enables exactly the CLI list: bash/write stay
  // out.
  await session.restoreBaselineTools();
  const restored = session.getEnabledToolNames();
  expect(restored).toEqual(["read"]);
  expect(restored).not.toContain("bash");
  expect(restored).not.toContain("write");
 });

 it("expands the registry baseline when a persona's tools list normalizes to empty", async () => {
  // Regression (wave-8 review P2): the `expandRegistryToAllBuiltins`
  // block was gated on `filteredRequestedTools.length > 0`, so a persona
  // whose explicit `tools:` list leaves no currently allowed main-session
  // tools (e.g. `tools: [computer]` with computer.enabled false, or a
  // copied subagent list stripping down to only yield/goal) started with
  // an EMPTY registry. The SDK then captured an empty baseline and
  // `restoreBaselineTools` could never re-enable the normal builtins.
  // The expansion must run whenever a requested list exists — even when
  // filtering leaves it empty — so the baseline holds the full builtin
  // set while the ACTIVE set stays empty.
  await fs.writeFile(
   path.join(agentsDir, "empty-tools-persona.md"),
   agentMd("empty-tools-persona", ["tools: [computer]"]),
  );

  const model = getBundledModel("anthropic", "claude-sonnet-4-5");
  if (!model) throw new Error("Expected bundled anthropic/claude-sonnet-4-5 to exist");

  const sessionManager = SessionManager.inMemory(projectDir);
  const options: Parameters<typeof createAgentSession>[0] = {
   cwd: projectDir,
   agentDir: tempHome,
   authStorage,
   modelRegistry,
   sessionManager,
   settings: Settings.isolated({ "compaction.enabled": false }),
   model,
   disableExtensionDiscovery: true,
   skills: [],
   contextFiles: [],
   promptTemplates: [],
   slashCommands: [],
   enableMCP: false,
   enableLsp: false,
   skipPythonPreflight: true,
   toolNames: ["read", "write"],
  };
  const { agents } = await discovery.discoverAgents(projectDir, tempHome);
  const agent = agents.find(candidate => candidate.name === "empty-tools-persona");
  expect(agent).toBeDefined();
  applyAgentPersonaOptions(options, agent!, { modelSet: false, thinkingSet: false, toolsSet: false });
  options.personaName = "empty-tools-persona";

  const result = await createAgentSession(options);
  session = result.session;

  // computer.enabled is false by default, so the persona's `tools:
  // [computer]` filters to nothing: the ACTIVE set is empty.
  expect(session.getEnabledToolNames()).toEqual([]);

  // ...but the baseline (what leaving agent mode restores) is the FULL
  // registry minus default-inactive tools — read/bash/write included.
  const baseline = session.getBaselineToolNames();
  expect(baseline).toBeDefined();
  expect(baseline).toEqual(expect.arrayContaining(["read", "bash", "write"]));

  // Leaving the persona re-enables the normal builtins.
  await session.restoreBaselineTools();
  const restored = session.getEnabledToolNames();
  expect(restored).toContain("bash");
  expect(restored).toContain("write");
  expect(restored).toContain("read");
 });

 it("delegates ToolSession.hasEditTool to the live session after restoreBaselineTools", async () => {
  // Regression (wave-6 review P2): `ToolSession.hasEditTool` was a static
  // closure over launch-time `options.toolNames`, so after leaving a
  // read-only persona (restoreBaselineTools re-activates edit) AgentSession
  // file mentions showed hashlines (SessionTools.hasEditTool, active-set
  // based) but ReadTool/GrepTool suppressed them (ToolSession closure).
  // The closure must delegate to the live session once it exists.
  await fs.writeFile(path.join(agentsDir, "read-only-persona.md"), agentMd("read-only-persona", ["tools: [read]"]));

  const model = getBundledModel("anthropic", "claude-sonnet-4-5");
  if (!model) throw new Error("Expected bundled anthropic/claude-sonnet-4-5 to exist");

  const sessionManager = SessionManager.inMemory(projectDir);
  const options: Parameters<typeof createAgentSession>[0] = {
   cwd: projectDir,
   agentDir: tempHome,
   authStorage,
   modelRegistry,
   sessionManager,
   settings: Settings.isolated({ "compaction.enabled": false }),
   model,
   disableExtensionDiscovery: true,
   skills: [],
   contextFiles: [],
   promptTemplates: [],
   slashCommands: [],
   enableMCP: false,
   enableLsp: false,
   skipPythonPreflight: true,
   toolNames: ["read", "write"],
  };
  const { agents } = await discovery.discoverAgents(projectDir, tempHome);
  const agent = agents.find(candidate => candidate.name === "read-only-persona");
  expect(agent).toBeDefined();
  applyAgentPersonaOptions(options, agent!, { modelSet: false, thinkingSet: false, toolsSet: false });
  options.personaName = "read-only-persona";

  const result = await createAgentSession(options);
  session = result.session;

  // While the read-only persona is active, edit is not granted anywhere.
  expect(session.hasEditTool).toBe(false);
  const readTool = session.getToolByName("read");
  expect(readTool).toBeDefined();
  // The tool instance's ToolSession must agree with the session-level
  // grant (the delegation fix): both false under the persona...
  expect((readTool as unknown as { session?: { hasEditTool?: boolean } }).session?.hasEditTool).toBe(false);

  // ...and both true after leaving the persona re-activates edit.
  await session.restoreBaselineTools();
  expect(session.hasEditTool).toBe(true);
  expect((readTool as unknown as { session?: { hasEditTool?: boolean } }).session?.hasEditTool).toBe(true);
 });

 it("restores the baseline xd:// partition after leaving a persona", async () => {
  // Regression (wave-6 review P3): `restoreBaselineTools` used
  // `setActiveToolsByName`, which pins every name in
  // `#runtimeSelectedToolNames` — preventing `applyActiveToolsByName`
  // from mounting the discoverable tools that a fresh non-persona session
  // presents under `xd://`. The baseline partition (which tools were
  // xdev-mounted at creation) must be restored via
  // `setActiveToolPresentation`.
  await fs.writeFile(path.join(agentsDir, "no-tools-persona.md"), agentMd("no-tools-persona"));

  const model = getBundledModel("anthropic", "claude-sonnet-4-5");
  if (!model) throw new Error("Expected bundled anthropic/claude-sonnet-4-5 to exist");

  const sessionManager = SessionManager.inMemory(projectDir);
  const options: Parameters<typeof createAgentSession>[0] = {
   cwd: projectDir,
   agentDir: tempHome,
   authStorage,
   modelRegistry,
   sessionManager,
   settings: Settings.isolated({ "compaction.enabled": false }),
   model,
   disableExtensionDiscovery: true,
   skills: [],
   contextFiles: [],
   promptTemplates: [],
   slashCommands: [],
   enableMCP: false,
   enableLsp: false,
   skipPythonPreflight: true,
   toolNames: ["read", "write"],
  };
  const { agents } = await discovery.discoverAgents(projectDir, tempHome);
  const agent = agents.find(candidate => candidate.name === "no-tools-persona");
  expect(agent).toBeDefined();
  applyAgentPersonaOptions(options, agent!, { modelSet: false, thinkingSet: false, toolsSet: false });
  options.personaName = "no-tools-persona";

  const result = await createAgentSession(options);
  session = result.session;

  // The baseline mounted subset is captured at creation: the discoverable
  // builtins (ast_edit/debug) that a fresh non-persona session would
  // present under `xd://`. Browser/computer are eval preludes upstream
  // (64508e1259), never xd://-mounted.
  const baselineMounted = session.getBaselineMountedToolNames();
  expect(baselineMounted).toBeDefined();
  expect(baselineMounted).toEqual(expect.arrayContaining(["ast_edit", "debug"]));

  // Leaving the persona restores the exact partition: the baseline
  // mounted names are xdev-mounted again, not pinned top-level.
  await session.restoreBaselineTools();
  const restoredMounted = session.getMountedXdevToolNames();
  expect(restoredMounted).toEqual(expect.arrayContaining(["ast_edit", "debug"]));
 });

 it("does not auto-activate manage_skill/learn for a read-only persona with autolearn enabled", async () => {
  // Regression (wave-6 review P3): with `expandRegistryToAllBuiltins`,
  // `builtInToolNames` includes manage_skill/learn when autolearn is on,
  // so the auto-activation block pushed them into the active set even for
  // a read-only persona that did not request them. The auto-activation
  // must be gated on the launch-requested list.
  await fs.writeFile(path.join(agentsDir, "read-only-persona.md"), agentMd("read-only-persona", ["tools: [read]"]));

  const model = getBundledModel("anthropic", "claude-sonnet-4-5");
  if (!model) throw new Error("Expected bundled anthropic/claude-sonnet-4-5 to exist");

  const sessionManager = SessionManager.inMemory(projectDir);
  const options: Parameters<typeof createAgentSession>[0] = {
   cwd: projectDir,
   agentDir: tempHome,
   authStorage,
   modelRegistry,
   sessionManager,
   settings: Settings.isolated({ "compaction.enabled": false, "autolearn.enabled": true }),
   model,
   disableExtensionDiscovery: true,
   skills: [],
   contextFiles: [],
   promptTemplates: [],
   slashCommands: [],
   enableMCP: false,
   enableLsp: false,
   skipPythonPreflight: true,
   toolNames: ["read", "write"],
  };
  const { agents } = await discovery.discoverAgents(projectDir, tempHome);
  const agent = agents.find(candidate => candidate.name === "read-only-persona");
  expect(agent).toBeDefined();
  applyAgentPersonaOptions(options, agent!, { modelSet: false, thinkingSet: false, toolsSet: false });
  options.personaName = "read-only-persona";

  const result = await createAgentSession(options);
  session = result.session;

  // The read-only persona's active set is EXACTLY [read] — manage_skill
  // and learn are NOT auto-activated from registry presence.
  const active = session.getActiveToolNames();
  expect(active).toEqual(["read"]);
  expect(active).not.toContain("manage_skill");
  expect(active).not.toContain("learn");
 });

 it("auto-activates manage_skill in a default session (no explicit tools) with autolearn enabled", async () => {
  // The default session (no explicit toolNames) builds every allowed
  // built-in, so manage_skill is present and active — the guidance and
  // controller point at a callable tool.
  const model = getBundledModel("anthropic", "claude-sonnet-4-5");
  if (!model) throw new Error("Expected bundled anthropic/claude-sonnet-4-5 to exist");

  const sessionManager = SessionManager.inMemory(projectDir);
  const result = await createAgentSession({
   cwd: projectDir,
   agentDir: tempHome,
   authStorage,
   modelRegistry,
   sessionManager,
   settings: Settings.isolated({ "compaction.enabled": false, "autolearn.enabled": true }),
   model,
   disableExtensionDiscovery: true,
   skills: [],
   contextFiles: [],
   promptTemplates: [],
   slashCommands: [],
   enableMCP: false,
   enableLsp: false,
   skipPythonPreflight: true,
  });
  session = result.session;

  const active = session.getActiveToolNames();
  expect(active).toContain("read");
  expect(active).toContain("manage_skill");
 });

 it("advertises scout as available with default spawns", async () => {
  // Positive contract: a session with default spawns ("*") may spawn
  // scout, so the Delegation guidance in the system prompt advertises it.
  const model = getBundledModel("anthropic", "claude-sonnet-4-5");
  if (!model) throw new Error("Expected bundled anthropic/claude-sonnet-4-5 to exist");

  const sessionManager = SessionManager.inMemory(projectDir);
  const result = await createAgentSession({
   cwd: projectDir,
   agentDir: tempHome,
   authStorage,
   modelRegistry,
   sessionManager,
   settings: Settings.isolated({ "compaction.enabled": false }),
   model,
   disableExtensionDiscovery: true,
   skills: [],
   contextFiles: [],
   promptTemplates: [],
   slashCommands: [],
   enableMCP: false,
   enableLsp: false,
   skipPythonPreflight: true,
   toolNames: ["read", "write", "task"],
  });
  session = result.session;

  expect(session.getSessionSpawns()).toBeNull();
  expect(session.systemPrompt.join("\n")).toContain("one read-only scout while working is allowed");
 }, 20000);

 it("drops the scout guidance after a live persona switch restricts spawns", async () => {
  // Regression (de-novo review P2): rebuildSystemPrompt read the LAUNCH
  // `options.spawns` for scoutAvailable, so after a live `/agent foo`
  // switch where foo sets `spawns: [reviewer]`, setSessionSpawns updated
  // the session and refreshBaseSystemPrompt rebuilt — but scoutAvailable
  // still read the stale launch default "*" and the prompt advertised
  // scout as available even though the persona restricts it.
  await fs.writeFile(path.join(agentsDir, "reviewer-only.md"), agentMd("reviewer-only", ["spawns: [reviewer]"]));

  const model = getBundledModel("anthropic", "claude-sonnet-4-5");
  if (!model) throw new Error("Expected bundled anthropic/claude-sonnet-4-5 to exist");

  const sessionManager = SessionManager.inMemory(projectDir);
  const result = await createAgentSession({
   cwd: projectDir,
   agentDir: tempHome,
   authStorage,
   modelRegistry,
   sessionManager,
   settings: Settings.isolated({ "compaction.enabled": false }),
   model,
   disableExtensionDiscovery: true,
   skills: [],
   contextFiles: [],
   promptTemplates: [],
   slashCommands: [],
   enableMCP: false,
   enableLsp: false,
   skipPythonPreflight: true,
   toolNames: ["read", "write", "task"],
  });
  session = result.session;

  // Baseline: default spawns advertise scout.
  expect(session.systemPrompt.join("\n")).toContain("one read-only scout while working is allowed");

  // The live `/agent reviewer-only` switch applies `spawns: [reviewer]`
  // via setSessionSpawns + refreshBaseSystemPrompt (interactive-mode.ts
  // switchAgentPersona). The rebuilt prompt must NOT advertise scout.
  session.setSessionSpawns("reviewer");
  await session.refreshBaseSystemPrompt();

  expect(session.getSessionSpawns()).toBe("reviewer");
  expect(session.systemPrompt.join("\n")).not.toContain("one read-only scout while working is allowed");
 }, 20000);

 it("re-advertises scout after a live persona restriction is lifted", async () => {
  // Reverse direction of the live-switch regression: the cached
  // launch-time scout verdict never updated on `setSessionSpawns`, so
  // leaving a spawn-restricting persona kept the guidance suppressed
  // after spawning became unrestricted again. Scout availability is now
  // computed from the LIVE policy, so both transitions must hold.
  const model = getBundledModel("anthropic", "claude-sonnet-4-5");
  if (!model) throw new Error("Expected bundled anthropic/claude-sonnet-4-5 to exist");

  const sessionManager = SessionManager.inMemory(projectDir);
  const result = await createAgentSession({
   cwd: projectDir,
   agentDir: tempHome,
   authStorage,
   modelRegistry,
   sessionManager,
   settings: Settings.isolated({ "compaction.enabled": false }),
   model,
   disableExtensionDiscovery: true,
   skills: [],
   contextFiles: [],
   promptTemplates: [],
   slashCommands: [],
   enableMCP: false,
   enableLsp: false,
   skipPythonPreflight: true,
   toolNames: ["read", "write", "task"],
  });
  const liveSession = result.session;
  try {
   expect(liveSession.systemPrompt.join("\n")).toContain("one read-only scout while working is allowed");
   liveSession.setSessionSpawns("reviewer");
   await liveSession.refreshBaseSystemPrompt();
   expect(liveSession.systemPrompt.join("\n")).not.toContain("one read-only scout while working is allowed");
   // Leaving the persona restores the unrestricted default: the
   // guidance must come back (cached-field regression: it did not).
   liveSession.setSessionSpawns(null);
   await liveSession.refreshBaseSystemPrompt();
   expect(liveSession.systemPrompt.join("\n")).toContain("one read-only scout while working is allowed");
  } finally {
   await liveSession.dispose();
  }
 }, 20000);

 it("does not advertise scout for a launch persona whose spawns restrict it", async () => {
  // Launch-path contract: `--agent` with `spawns: [reviewer]` seeds the
  // session spawn policy at creation, so the FIRST system prompt build
  // must already omit the scout guidance.
  await fs.writeFile(path.join(agentsDir, "reviewer-only.md"), agentMd("reviewer-only", ["spawns: [reviewer]"]));

  const model = getBundledModel("anthropic", "claude-sonnet-4-5");
  if (!model) throw new Error("Expected bundled anthropic/claude-sonnet-4-5 to exist");

  const sessionManager = SessionManager.inMemory(projectDir);
  const options: Parameters<typeof createAgentSession>[0] = {
   cwd: projectDir,
   agentDir: tempHome,
   authStorage,
   modelRegistry,
   sessionManager,
   settings: Settings.isolated({ "compaction.enabled": false }),
   model,
   disableExtensionDiscovery: true,
   skills: [],
   contextFiles: [],
   promptTemplates: [],
   slashCommands: [],
   enableMCP: false,
   enableLsp: false,
   skipPythonPreflight: true,
   toolNames: ["read", "write", "task"],
  };
  const { agents } = await discovery.discoverAgents(projectDir, tempHome);
  const agent = agents.find(candidate => candidate.name === "reviewer-only");
  expect(agent).toBeDefined();
  applyAgentPersonaOptions(options, agent!, { modelSet: false, thinkingSet: false, toolsSet: false });
  options.personaName = "reviewer-only";

  const result = await createAgentSession(options);
  session = result.session;

  expect(session.getSessionSpawns()).toBe("reviewer");
  expect(session.systemPrompt.join("\n")).not.toContain("one read-only scout while working is allowed");
 }, 20000);

 it("applies the persona's model frontmatter when a default model was already selected", async () => {
  // Regression (codex #3754547620): with `--agent` and NO explicit
  // `--model`, buildSessionOptions populates `options.model` from the
  // scoped default (enabledModels). `applyAgentPersonaOptions` must clear
  // that default and defer the persona's `model:` pattern, or
  // createAgentSession treats the populated `model` as explicit and the
  // persona's frontmatter is silently ignored.
  await fs.writeFile(
   path.join(agentsDir, "model-persona.md"),
   agentMd("model-persona", ["model: anthropic/claude-sonnet-4-5"]),
  );

  const defaultModel = getBundledModel("anthropic", "claude-haiku-4-5");
  if (!defaultModel) throw new Error("Expected bundled anthropic/claude-haiku-4-5 to exist");

  const sessionManager = SessionManager.inMemory(projectDir);
  const options: Parameters<typeof createAgentSession>[0] = {
   cwd: projectDir,
   agentDir: tempHome,
   authStorage,
   modelRegistry,
   sessionManager,
   settings: Settings.isolated({ "compaction.enabled": false }),
   // The startup-selected default (scoped model) — the persona must
   // replace it, not be ignored by it.
   model: defaultModel,
   disableExtensionDiscovery: true,
   skills: [],
   contextFiles: [],
   promptTemplates: [],
   slashCommands: [],
   enableMCP: false,
   enableLsp: false,
   skipPythonPreflight: true,
   toolNames: ["read", "write"],
  };
  const { agents } = await discovery.discoverAgents(projectDir, tempHome);
  const agent = agents.find(candidate => candidate.name === "model-persona");
  expect(agent).toBeDefined();
  applyAgentPersonaOptions(options, agent!, { modelSet: false, thinkingSet: false, toolsSet: false });
  options.personaName = "model-persona";

  // The default is deferred, not dropped: an unresolvable persona model
  // must fall back to it instead of failing startup.
  expect(options.model).toBeUndefined();
  expect(options.modelPattern).toEqual(["anthropic/claude-sonnet-4-5"]);
  expect(options.modelPatternFallbackModel?.id).toBe("claude-haiku-4-5");

  const result = await createAgentSession(options);
  session = result.session;

  expect(session.model?.provider).toBe("anthropic");
  expect(session.model?.id).toBe("claude-sonnet-4-5");
  expect(result.modelFallbackMessage).toBeUndefined();
 }, 20000);

 it("keeps an explicit --model over the persona's model frontmatter", async () => {
  // Negative control: an explicit `--model` is the ONLY documented
  // override — the persona's `model:` frontmatter must be ignored.
  await fs.writeFile(
   path.join(agentsDir, "model-persona.md"),
   agentMd("model-persona", ["model: anthropic/claude-sonnet-4-5"]),
  );

  const explicitModel = getBundledModel("anthropic", "claude-haiku-4-5");
  if (!explicitModel) throw new Error("Expected bundled anthropic/claude-haiku-4-5 to exist");

  const sessionManager = SessionManager.inMemory(projectDir);
  const options: Parameters<typeof createAgentSession>[0] = {
   cwd: projectDir,
   agentDir: tempHome,
   authStorage,
   modelRegistry,
   sessionManager,
   settings: Settings.isolated({ "compaction.enabled": false }),
   model: explicitModel,
   disableExtensionDiscovery: true,
   skills: [],
   contextFiles: [],
   promptTemplates: [],
   slashCommands: [],
   enableMCP: false,
   enableLsp: false,
   skipPythonPreflight: true,
   toolNames: ["read", "write"],
  };
  const { agents } = await discovery.discoverAgents(projectDir, tempHome);
  const agent = agents.find(candidate => candidate.name === "model-persona");
  expect(agent).toBeDefined();
  applyAgentPersonaOptions(options, agent!, { modelSet: true, thinkingSet: false, toolsSet: false });
  options.personaName = "model-persona";

  expect(options.model?.id).toBe("claude-haiku-4-5");
  expect(options.modelPattern).toBeUndefined();

  const result = await createAgentSession(options);
  session = result.session;

  expect(session.model?.id).toBe("claude-haiku-4-5");
 }, 20000);

 it("falls back to the selected default when the persona's model pattern does not resolve", async () => {
  // The persona's deferred model pattern failing to resolve must degrade
  // to the startup-selected default (preserved via
  // `modelPatternFallbackModel`), mirroring the subagent path's
  // parent-model fallback — not fail startup.
  await fs.writeFile(
   path.join(agentsDir, "missing-model-persona.md"),
   agentMd("missing-model-persona", ["model: nonexistent-provider/nonexistent-model"]),
  );

  const defaultModel = getBundledModel("anthropic", "claude-haiku-4-5");
  if (!defaultModel) throw new Error("Expected bundled anthropic/claude-haiku-4-5 to exist");

  const sessionManager = SessionManager.inMemory(projectDir);
  const options: Parameters<typeof createAgentSession>[0] = {
   cwd: projectDir,
   agentDir: tempHome,
   authStorage,
   modelRegistry,
   sessionManager,
   settings: Settings.isolated({ "compaction.enabled": false }),
   model: defaultModel,
   disableExtensionDiscovery: true,
   skills: [],
   contextFiles: [],
   promptTemplates: [],
   slashCommands: [],
   enableMCP: false,
   enableLsp: false,
   skipPythonPreflight: true,
   toolNames: ["read", "write"],
  };
  const { agents } = await discovery.discoverAgents(projectDir, tempHome);
  const agent = agents.find(candidate => candidate.name === "missing-model-persona");
  expect(agent).toBeDefined();
  applyAgentPersonaOptions(options, agent!, { modelSet: false, thinkingSet: false, toolsSet: false });
  options.personaName = "missing-model-persona";

  const result = await createAgentSession(options);
  session = result.session;

  expect(session.model?.id).toBe("claude-haiku-4-5");
  expect(result.modelFallbackMessage).toContain("nonexistent-provider/nonexistent-model");
 }, 20000);

 it("lets a thinking suffix on the persona's model pattern win over its thinkingLevel", async () => {
  // A `:level` suffix on the persona's own model pattern is the more
  // specific selector and wins over the frontmatter `thinkingLevel` —
  // the same precedence the subagent path gives a resolved pattern's
  // explicit suffix and the CLI path gives `--model X:high`.
  await fs.writeFile(
   path.join(agentsDir, "suffix-persona.md"),
   agentMd("suffix-persona", ["model: anthropic/claude-sonnet-4-5:low", "thinkingLevel: high"]),
  );

  const defaultModel = getBundledModel("anthropic", "claude-haiku-4-5");
  if (!defaultModel) throw new Error("Expected bundled anthropic/claude-haiku-4-5 to exist");

  const sessionManager = SessionManager.inMemory(projectDir);
  const options: Parameters<typeof createAgentSession>[0] = {
   cwd: projectDir,
   agentDir: tempHome,
   authStorage,
   modelRegistry,
   sessionManager,
   settings: Settings.isolated({ "compaction.enabled": false }),
   model: defaultModel,
   disableExtensionDiscovery: true,
   skills: [],
   contextFiles: [],
   promptTemplates: [],
   slashCommands: [],
   enableMCP: false,
   enableLsp: false,
   skipPythonPreflight: true,
   toolNames: ["read", "write"],
  };
  const { agents } = await discovery.discoverAgents(projectDir, tempHome);
  const agent = agents.find(candidate => candidate.name === "suffix-persona");
  expect(agent).toBeDefined();
  applyAgentPersonaOptions(options, agent!, { modelSet: false, thinkingSet: false, toolsSet: false });
  options.personaName = "suffix-persona";

  // The frontmatter `thinkingLevel: high` must not clobber the suffix.
  expect(options.thinkingLevel).toBeUndefined();

  const result = await createAgentSession(options);
  session = result.session;

  expect(session.model?.id).toBe("claude-sonnet-4-5");
  expect(session.thinkingLevel).toBe(Effort.Low);
 }, 20000);

 it("applies frontmatter thinkingLevel when only a NON-selected fallback pattern carries a suffix", async () => {
  // Regression (codex #3754895375): a `:level` suffix anywhere in the
  // persona's model fallback list used to suppress the frontmatter
  // `thinkingLevel`, even when the suffix sits on a pattern that does
  // NOT win. `model: [missing/model:low, anthropic/claude-haiku-4-5]`
  // selects haiku (no suffix), so `thinkingLevel: high` must apply —
  // only the ACTUALLY SELECTED pattern's suffix wins.
  await fs.writeFile(
   path.join(agentsDir, "fallback-suffix-persona.md"),
   agentMd("fallback-suffix-persona", [
    "model: [missing/model:low, anthropic/claude-haiku-4-5]",
    "thinkingLevel: high",
   ]),
  );

  const defaultModel = getBundledModel("anthropic", "claude-sonnet-4-5");
  if (!defaultModel) throw new Error("Expected bundled anthropic/claude-sonnet-4-5 to exist");

  const sessionManager = SessionManager.inMemory(projectDir);
  const options: Parameters<typeof createAgentSession>[0] = {
   cwd: projectDir,
   agentDir: tempHome,
   authStorage,
   modelRegistry,
   sessionManager,
   settings: Settings.isolated({ "compaction.enabled": false }),
   model: defaultModel,
   disableExtensionDiscovery: true,
   skills: [],
   contextFiles: [],
   promptTemplates: [],
   slashCommands: [],
   enableMCP: false,
   enableLsp: false,
   skipPythonPreflight: true,
   toolNames: ["read", "write"],
  };
  const { agents } = await discovery.discoverAgents(projectDir, tempHome);
  const agent = agents.find(candidate => candidate.name === "fallback-suffix-persona");
  expect(agent).toBeDefined();
  applyAgentPersonaOptions(options, agent!, { modelSet: false, thinkingSet: false, toolsSet: false });
  options.personaName = "fallback-suffix-persona";

  // The suffix on the unresolvable first pattern must not clear the
  // frontmatter level: it is deferred through resolution and applied
  // because the SELECTED pattern (haiku) has no suffix.
  expect(options.thinkingLevel).toBeUndefined();
  expect(options.personaThinkingLevel).toBe(Effort.High);

  const result = await createAgentSession(options);
  session = result.session;

  expect(session.model?.id).toBe("claude-haiku-4-5");
  expect(session.thinkingLevel).toBe(Effort.High);
 }, 20000);

 it("lets a persona model suffix win over settings-seeded scoped thinking", async () => {
  // A settings-seeded default (enabledModels scoped thinking) must not
  // suppress the persona's own model suffix — the same principle as the
  // existing "settings-seeded scoped thinking does not suppress the
  // persona's thinkingLevel" test, applied to the suffix selector.
  await fs.writeFile(
   path.join(agentsDir, "suffix-persona.md"),
   agentMd("suffix-persona", ["model: anthropic/claude-sonnet-4-5:high", "thinkingLevel: low"]),
  );

  const defaultModel = getBundledModel("anthropic", "claude-haiku-4-5");
  if (!defaultModel) throw new Error("Expected bundled anthropic/claude-haiku-4-5 to exist");

  const sessionManager = SessionManager.inMemory(projectDir);
  const options: CreateAgentSessionOptions = {
   cwd: projectDir,
   agentDir: tempHome,
   authStorage,
   modelRegistry,
   sessionManager,
   settings: Settings.isolated({ "compaction.enabled": false }),
   model: defaultModel,
   // Settings-seeded scoped thinking (enabledModels `:low`), NOT an
   // explicit CLI override — the persona's `:high` suffix must win.
   thinkingLevel: Effort.Low,
   disableExtensionDiscovery: true,
   skills: [],
   contextFiles: [],
   promptTemplates: [],
   slashCommands: [],
   enableMCP: false,
   enableLsp: false,
   skipPythonPreflight: true,
   toolNames: ["read", "write"],
  };
  const { agents } = await discovery.discoverAgents(projectDir, tempHome);
  const agent = agents.find(candidate => candidate.name === "suffix-persona");
  expect(agent).toBeDefined();
  applyAgentPersonaOptions(options, agent!, { modelSet: false, thinkingSet: false, toolsSet: false });
  options.personaName = "suffix-persona";

  // The seeded scoped thinking is dropped so the suffix applies.
  expect(options.thinkingLevel).toBeUndefined();

  const result = await createAgentSession(options);
  session = result.session;

  expect(session.model?.id).toBe("claude-sonnet-4-5");
  expect(session.thinkingLevel).toBe(Effort.High);
 }, 20000);

 it("lets a persona model suffix win over settings-seeded scoped thinking even without thinkingLevel frontmatter", async () => {
  // Regression: the suffix-clearing used to be nested inside
  // `if (!explicit.thinkingSet && agent.thinkingLevel)`, so a persona with
  // a `:level` model suffix but NO frontmatter `thinkingLevel` kept the
  // settings-seeded scoped default — and `pickInitialThinkingLevel` checks
  // `options.thinkingLevel` FIRST, silently clobbering the suffix.
  await fs.writeFile(
   path.join(agentsDir, "suffix-no-frontmatter-persona.md"),
   agentMd("suffix-no-frontmatter-persona", ["model: anthropic/claude-sonnet-4-5:high"]),
  );

  const defaultModel = getBundledModel("anthropic", "claude-haiku-4-5");
  if (!defaultModel) throw new Error("Expected bundled anthropic/claude-haiku-4-5 to exist");

  const sessionManager = SessionManager.inMemory(projectDir);
  const options: CreateAgentSessionOptions = {
   cwd: projectDir,
   agentDir: tempHome,
   authStorage,
   modelRegistry,
   sessionManager,
   settings: Settings.isolated({ "compaction.enabled": false }),
   model: defaultModel,
   // Settings-seeded scoped thinking (enabledModels `:low`), NOT an
   // explicit CLI override — the persona's `:high` suffix must win.
   thinkingLevel: Effort.Low,
   disableExtensionDiscovery: true,
   skills: [],
   contextFiles: [],
   promptTemplates: [],
   slashCommands: [],
   enableMCP: false,
   enableLsp: false,
   skipPythonPreflight: true,
   toolNames: ["read", "write"],
  };
  const { agents } = await discovery.discoverAgents(projectDir, tempHome);
  const agent = agents.find(candidate => candidate.name === "suffix-no-frontmatter-persona");
  expect(agent).toBeDefined();
  applyAgentPersonaOptions(options, agent!, { modelSet: false, thinkingSet: false, toolsSet: false });
  options.personaName = "suffix-no-frontmatter-persona";

  // The seeded scoped thinking is dropped even without a frontmatter
  // `thinkingLevel`, so the deferred suffix resolution can apply.
  expect(options.thinkingLevel).toBeUndefined();

  const result = await createAgentSession(options);
  session = result.session;

  expect(session.model?.id).toBe("claude-sonnet-4-5");
  expect(session.thinkingLevel).toBe(Effort.High);
 }, 20000);

 it("applies the settings-seeded scoped thinking default when the persona model has no suffix", async () => {
  // Control: with no `:level` suffix and no frontmatter `thinkingLevel`,
  // there is nothing to override the settings-seeded default — it must
  // apply unchanged.
  await fs.writeFile(
   path.join(agentsDir, "no-suffix-persona.md"),
   agentMd("no-suffix-persona", ["model: anthropic/claude-sonnet-4-5"]),
  );

  const defaultModel = getBundledModel("anthropic", "claude-haiku-4-5");
  if (!defaultModel) throw new Error("Expected bundled anthropic/claude-haiku-4-5 to exist");

  const sessionManager = SessionManager.inMemory(projectDir);
  const options: CreateAgentSessionOptions = {
   cwd: projectDir,
   agentDir: tempHome,
   authStorage,
   modelRegistry,
   sessionManager,
   settings: Settings.isolated({ "compaction.enabled": false }),
   model: defaultModel,
   // Settings-seeded scoped thinking (enabledModels `:low`).
   thinkingLevel: Effort.Low,
   disableExtensionDiscovery: true,
   skills: [],
   contextFiles: [],
   promptTemplates: [],
   slashCommands: [],
   enableMCP: false,
   enableLsp: false,
   skipPythonPreflight: true,
   toolNames: ["read", "write"],
  };
  const { agents } = await discovery.discoverAgents(projectDir, tempHome);
  const agent = agents.find(candidate => candidate.name === "no-suffix-persona");
  expect(agent).toBeDefined();
  applyAgentPersonaOptions(options, agent!, { modelSet: false, thinkingSet: false, toolsSet: false });
  options.personaName = "no-suffix-persona";

  // No suffix to override the seeded default — it survives untouched.
  expect(options.thinkingLevel).toBe(Effort.Low);

  const result = await createAgentSession(options);
  session = result.session;

  expect(session.model?.id).toBe("claude-sonnet-4-5");
  expect(session.thinkingLevel).toBe(Effort.Low);
 }, 20000);

 it("does not resurrect the launch persona append after a live persona clear", async () => {
  // Regression: `rebuildSystemPrompt` coalesced the session persona
  // channel with `??`, so after a live clear (`setPersonaAppendPrompt(undefined)`
  // when a mode entry or /agent exit leaves the persona) the LAUNCH
  // persona's append leaked back into every rebuilt prompt. Pre-
  // construction the launch option must still feed the first build, and
  // an explicit post-construction clear must stick.
  await fs.writeFile(path.join(agentsDir, "clear-launch-persona.md"), agentMd("clear-launch-persona"));
  await fs.writeFile(
   path.join(agentsDir, "clear-second-persona.md"),
   ["---", "name: clear-second-persona", "description: clear-second-persona", "---", SECOND_PERSONA_PROMPT].join(
    "\n",
   ),
  );

  const model = getBundledModel("anthropic", "claude-sonnet-4-5");
  if (!model) throw new Error("Expected bundled anthropic/claude-sonnet-4-5 to exist");

  const sessionManager = SessionManager.inMemory(projectDir);
  const options: CreateAgentSessionOptions = {
   cwd: projectDir,
   agentDir: tempHome,
   authStorage,
   modelRegistry,
   sessionManager,
   settings: Settings.isolated({ "compaction.enabled": false }),
   model,
   disableExtensionDiscovery: true,
   skills: [],
   contextFiles: [],
   promptTemplates: [],
   slashCommands: [],
   enableMCP: false,
   enableLsp: false,
   skipPythonPreflight: true,
   toolNames: ["read", "write"],
  };
  const { agents } = await discovery.discoverAgents(projectDir, tempHome);
  const launchAgent = agents.find(candidate => candidate.name === "clear-launch-persona");
  expect(launchAgent).toBeDefined();
  applyAgentPersonaOptions(options, launchAgent!, { modelSet: false, thinkingSet: false, toolsSet: false });
  options.personaName = "clear-launch-persona";

  const result = await createAgentSession(options);
  session = result.session;

  // First build (pre-construction): `options.personaAppendPrompt`
  // supplies the launch persona's append.
  expect(session.systemPrompt.join("\n")).toContain(PERSONA_PROMPT);

  // Post-construction with no live write yet, a refresh still exposes
  // the launch append (the session's seeded value equals the option).
  await session.refreshBaseSystemPrompt();
  expect(session.systemPrompt.join("\n")).toContain(PERSONA_PROMPT);

  // Live clear — exactly what mode-entry `clearPersonaOwnedState` does —
  // then rebuild: the launch append must NOT come back.
  session.setSessionSpawns(null);
  session.setPersonaAppendPrompt(undefined);
  await session.refreshBaseSystemPrompt();
  expect(session.systemPrompt.join("\n")).not.toContain(PERSONA_PROMPT);

  // A live switch to a second persona exposes that persona's append...
  session.setPersonaAppendPrompt(SECOND_PERSONA_PROMPT);
  await session.refreshBaseSystemPrompt();
  expect(session.systemPrompt.join("\n")).toContain(SECOND_PERSONA_PROMPT);

  // ...and leaving it clears the channel without resurrecting EITHER
  // the launch or the second persona's append.
  session.setSessionSpawns(null);
  session.setPersonaAppendPrompt(undefined);
  await session.refreshBaseSystemPrompt();
  const leftPrompt = session.systemPrompt.join("\n");
  expect(leftPrompt).not.toContain(PERSONA_PROMPT);
  expect(leftPrompt).not.toContain(SECOND_PERSONA_PROMPT);
 }, 20000);
 it("loads extensions for a launch persona but keeps the active set restricted to the grant", async () => {
  // P1 (codex #3821198710): `--agent` with a `tools:` list used to skip
  // extension loading entirely (the subagent-style `restrictToolNames`
  // branch), so a persona that grants an extension-defined tool by name
  // could never use it at launch. Extensions must load (registry +
  // providers) while the ACTIVE set stays restricted to the persona's
  // exact `tools:` list.
  await fs.writeFile(path.join(agentsDir, "ext-persona.md"), agentMd("ext-persona", ["tools: [read, ext_tool]"]));

  const model = getBundledModel("anthropic", "claude-sonnet-4-5");
  if (!model) throw new Error("Expected bundled anthropic/claude-sonnet-4-5 to exist");

  const sessionManager = SessionManager.inMemory(projectDir);
  const options: Parameters<typeof createAgentSession>[0] = {
   cwd: projectDir,
   agentDir: tempHome,
   authStorage,
   modelRegistry,
   sessionManager,
   settings: Settings.isolated({ "compaction.enabled": false }),
   model,
   disableExtensionDiscovery: true,
   extensions: [
    pi => {
     pi.registerTool({
      name: "ext_tool",
      label: "Extension Tool",
      description: "Extension-registered tool granted by the persona.",
      parameters: type({}),
      async execute() {
       return { content: [{ type: "text", text: "ext" }] };
      },
     });
     pi.registerTool({
      name: "other_tool",
      label: "Other Tool",
      description: "Extension-registered tool NOT granted by the persona.",
      parameters: type({}),
      async execute() {
       return { content: [{ type: "text", text: "other" }] };
      },
     });
    },
   ],
   skills: [],
   contextFiles: [],
   promptTemplates: [],
   slashCommands: [],
   enableMCP: false,
   enableLsp: false,
   skipPythonPreflight: true,
   toolNames: ["read", "write"],
  };
  const { agents } = await discovery.discoverAgents(projectDir, tempHome);
  const agent = agents.find(candidate => candidate.name === "ext-persona");
  expect(agent).toBeDefined();
  applyAgentPersonaOptions(options, agent!, { modelSet: false, thinkingSet: false, toolsSet: false });
  options.personaName = "ext-persona";

  const result = await createAgentSession(options);
  session = result.session;

  // The persona-granted extension tool is ACTIVE; the un-granted one is
  // registered but NOT active; the active set stays exactly the grant.
  expect(session.getEnabledToolNames()).toEqual(["read", "ext_tool"]);
  // The un-granted extension tool is still in the registry (so a later
  // live switch to a persona that grants it can activate it).
  expect(session.getAllToolNames()).toContain("other_tool");
  // The baseline (leaving agent mode) is the full registry minus
  // default-inactive tools — the extension tools included.
  const baseline = session.getBaselineToolNames();
  expect(baseline).toBeDefined();
  expect(baseline).toContain("ext_tool");
  expect(baseline).toContain("other_tool");
 });

 it("restores memory/autolearn prompt affordances after leaving a launch persona", async () => {
  // P2 (codex #3845551582): `applyAgentPersonaOptions` sets the
  // creation-time `restrictToolNames` flag for a launch `--agent` persona
  // with a `tools:` list. `promptRestricted` folded that flag in
  // unconditionally, so after leaving the persona (`restoreBaselineTools`
  // restored the unrestricted tool set and cleared the live restriction)
  // every later prompt rebuild STILL omitted the memory guidance, the
  // auto-learn guidance, AutoQA, and IRC affordances. A launch persona
  // without an explicit `--tools` override must lift the suppression
  // with the restriction; an explicit `--tools` launch keeps it.
  await fs.writeFile(
   path.join(agentsDir, "affordance-persona.md"),
   agentMd("affordance-persona", ["tools: [read]"]),
  );

  const model = getBundledModel("anthropic", "claude-sonnet-4-5");
  if (!model) throw new Error("Expected bundled anthropic/claude-sonnet-4-5 to exist");

  const personaSettings = Settings.isolated({
   "compaction.enabled": false,
   "autolearn.enabled": true,
   "memory.backend": "local",
  });
  // The local backend's read-path instructions render only when memory
  // content exists; seed a lesson so the restored prompt can carry them.
  await saveLearnedLesson(tempHome, personaSettings.getCwd(), {
   content: "T11 memory affordances restored.",
  });

  const sessionManager = SessionManager.inMemory(projectDir);
  const options: Parameters<typeof createAgentSession>[0] = {
   cwd: projectDir,
   agentDir: tempHome,
   authStorage,
   modelRegistry,
   sessionManager,
   settings: personaSettings,
   model,
   disableExtensionDiscovery: true,
   skills: [],
   contextFiles: [],
   promptTemplates: [],
   slashCommands: [],
   enableMCP: false,
   enableLsp: false,
   skipPythonPreflight: true,
   toolNames: ["read", "write"],
  };
  const { agents } = await discovery.discoverAgents(projectDir, tempHome);
  const agent = agents.find(candidate => candidate.name === "affordance-persona");
  expect(agent).toBeDefined();
  applyAgentPersonaOptions(options, agent!, { modelSet: false, thinkingSet: false, toolsSet: false });
  options.personaName = "affordance-persona";

  const result = await createAgentSession(options);
  session = result.session;

  // While the persona is active the affordances are suppressed: the
  // memory backend resolved, but `promptRestricted` withheld the memory
  // and auto-learn guidance from the prompt.
  const restrictedPrompt = session.systemPrompt.join("\n");
  expect(restrictedPrompt).not.toContain("Auto-Learn (experimental)");
  expect(restrictedPrompt).not.toContain("memory://root/memory_summary.md");

  // Leaving the persona restores the unrestricted tool set AND the
  // affordances: the rebuilt prompt must carry the auto-learn guidance
  // (manage_skill/learn are in the registry via autolearn+local backend)
  // and the memory read-path instructions.
  await session.restoreBaselineTools();
  await session.refreshBaseSystemPrompt();
  const restoredPrompt = session.systemPrompt.join("\n");
  expect(session.getActiveToolNames()).toContain("manage_skill");
  expect(restoredPrompt).toContain("Auto-Learn (experimental)");
  expect(restoredPrompt).toContain("memory://root/memory_summary.md");
 }, 20000);
});
