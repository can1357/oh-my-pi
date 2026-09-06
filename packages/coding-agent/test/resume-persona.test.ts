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
import type { ConfiguredThinkingLevel } from "@oh-my-pi/pi-coding-agent/thinking";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { PersonaRuntime } from "@oh-my-pi/pi-coding-agent/session/persona-runtime";
import { SessionToolPolicy } from "@oh-my-pi/pi-coding-agent/session/tool-policy";
import { appendPersonaJournalEntry } from "@oh-my-pi/pi-coding-agent/session/persisted-persona";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { TempDir } from "@oh-my-pi/pi-utils";
import { InteractiveMode } from "../src/modes/interactive-mode";
import { discoverAgents, getAgent } from "../src/task";

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
	function createSession(sessionManager: SessionManager, options?: { vetoBeforeSwitch?: boolean }): AgentSession {
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
			...(options?.vetoBeforeSwitch
				? {
						extensionRunner: {
							hasHandlers: (eventType: string) => eventType === "session_before_switch",
							emit: async () => ({ cancel: true }),
						} as never,
					}
				: {}),
		});
		session = createdSession;
		createdSession.setPersonaRuntime(new PersonaRuntime(createdSession.getToolPolicy()!, createdSession));
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

	it("falls back gracefully with a notice, journals the degrade, and does not re-notice on second resume", async () => {
		const sourceManager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions"));
		sourceManager.appendMessage({ role: "user", content: "prior turn", timestamp: Date.now() });
		sourceManager.appendModeChange("agent", { name: "evaporated-persona" });
		await sourceManager.ensureOnDisk();
		await sourceManager.flush();
		const sourceFile = sourceManager.getSessionFile();
		if (!sourceFile) throw new Error("Expected session file");
		await sourceManager.close();

		// No agent file written: the persona definition was deleted pre-resume.
		const createdSession = createSession(
			await SessionManager.open(sourceFile, path.join(tempDir.path(), "sessions")),
		);
		const created = spyStatus(createMode(createdSession));
		await created.init({ suppressWelcomeIntro: true });

		expect(createdSession.getPersonaRuntime()!.policy.isPersonaActive()).toBe(false);
		expect(createdSession.getPersonaAppendPrompt()).toBeUndefined();
		// Unrestricted: the default tool set survives.
		expect(createdSession.getActiveToolNames()).toContain("write");
		expect(statusMessages.some(message => message.includes("evaporated-persona"))).toBe(true);
		const goneNoticeCount = statusMessages.filter(message => message.includes("evaporated-persona")).length;

		// Journal clear marker: the stale `agent` entry no longer stays LAST.
		const entry = await lastAgentModeChange(createdSession.sessionManager);
		expect(entry?.mode).toBe("none");

		// Second resume: the `none` marker means no re-notice for the dead persona.
		created.stop();
		await createdSession.dispose();
		statusMessages.length = 0;
		const secondSession = createSession(await SessionManager.open(sourceFile, path.join(tempDir.path(), "sessions")));
		const second = spyStatus(createMode(secondSession));
		await second.init({ suppressWelcomeIntro: true });
		expect(secondSession.getPersonaRuntime()!.policy.isPersonaActive()).toBe(false);
		expect(statusMessages.some(message => message.includes("evaporated-persona"))).toBe(false);
		expect(goneNoticeCount).toBe(1);
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
			{ apply: async () => {} },
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

	it("retains the persona across a plan-mode journal interleave on resume", async () => {
		// fo0dT regression: persona entered, then plan mode opened. The journal's
		// `plan` entry no longer hides the preceding `agent` entry on resume —
		// the persona identity survives the temporary mode partition.
		const sourceManager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions"));
		sourceManager.appendMessage({ role: "user", content: "prior turn", timestamp: Date.now() });
		sourceManager.appendModeChange("agent", { name: "fixture-reader" });
		sourceManager.appendModeChange("plan", { planFilePath: "local://PLAN.md" });
		sourceManager.appendModeChange("plan_paused");
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
		expect(createdSession.getPersonaAppendPrompt()).toContain("fixture reader persona");
		const active = new Set(createdSession.getActiveToolNames());
		expect(active.has("read")).toBe(true);
	});

	it("clears the persona on resume after an explicit none mode_change", async () => {
		const sourceManager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions"));
		sourceManager.appendMessage({ role: "user", content: "prior turn", timestamp: Date.now() });
		sourceManager.appendModeChange("agent", { name: "fixture-reader" });
		sourceManager.appendModeChange("none");
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

		expect(createdSession.getPersonaRuntime()!.policy.isPersonaActive()).toBe(false);
		expect(createdSession.getPersonaAppendPrompt()).toBeUndefined();
	});

	it("switch to a stored session without a persona exits the source persona", async () => {
		// foxlv/foy5j regression: the PersonaRuntime survives an in-process
		// switchSession, so a persona-active source switching to an ordinary
		// target must exit the persona during reconcile instead of leaking the
		// grant/identity/presentation into the target.
		const personaTarget = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions"));
		personaTarget.appendMessage({ role: "user", content: "prior turn", timestamp: Date.now() });
		personaTarget.appendModeChange("agent", { name: "fixture-reader" });
		await personaTarget.ensureOnDisk();
		await personaTarget.flush();
		const personaFile = personaTarget.getSessionFile();
		if (!personaFile) throw new Error("Expected session file");
		await personaTarget.close();

		const plainTarget = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions"));
		plainTarget.appendMessage({ role: "user", content: "plain", timestamp: Date.now() });
		await plainTarget.ensureOnDisk();
		await plainTarget.flush();
		const plainFile = plainTarget.getSessionFile();
		if (!plainFile) throw new Error("Expected session file");
		await plainTarget.close();

		await writeFixtureAgent(READER_AGENT_MD);

		const sourceManager = await SessionManager.open(personaFile, path.join(tempDir.path(), "sessions"));
		const liveSession = createSession(sourceManager);
		const created = spyStatus(createMode(liveSession));
		await created.init({ suppressWelcomeIntro: true });
		expect(liveSession.getPersonaRuntime()!.policy.isPersonaActive()).toBe(true);

		const switched = await liveSession.switchSession(plainFile);
		expect(switched).toBe(true);
		// Target has no persona entry: the source persona must be gone, and the
		// narrowed persona partition restored to the unrestricted set.
		const policy = liveSession.getPersonaRuntime()!.policy;
		expect(policy.isPersonaActive()).toBe(false);
		expect(policy.effective("write")).toBe(true);
		expect(liveSession.getPersonaAppendPrompt()).toBeUndefined();
	});

	it("switch exits the source persona BEFORE the target model is restored (j2d)", async () => {
		// j2d regression: the persona teardown used to run in the POST-switch
		// reconciler — after switchSession had already restored the target's
		// model/thinking. The exit then re-applied the SOURCE persona's baseline
		// via setModel, clobbering the target's restored model (and journaling
		// the clobber as a model_change). The teardown must run BEFORE the
		// switch restores anything.
		const personaTarget = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions"));
		personaTarget.appendMessage({ role: "user", content: "prior turn", timestamp: Date.now() });
		personaTarget.appendModeChange("agent", { name: "fixture-reader" });
		await personaTarget.ensureOnDisk();
		await personaTarget.flush();
		const personaFile = personaTarget.getSessionFile();
		if (!personaFile) throw new Error("Expected session file");
		await personaTarget.close();

		// The TARGET session has its OWN distinct model recorded, so a correct
		// switch ends on the target model — not the source persona's baseline.
		const otherModel = getBundledModel("anthropic", "claude-haiku-4-5");
		if (!otherModel) throw new Error("Expected built-in anthropic haiku model to exist");
		const plainTarget = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions"));
		plainTarget.appendMessage({ role: "user", content: "plain", timestamp: Date.now() });
		plainTarget.appendModelChange(`${otherModel.provider}/${otherModel.id}`, "default");
		await plainTarget.ensureOnDisk();
		await plainTarget.flush();
		const plainFile = plainTarget.getSessionFile();
		if (!plainFile) throw new Error("Expected session file");
		await plainTarget.close();

		// The persona DECLARES a model distinct from both, so its exit baseline
		// (the pre-enter model) differs from the target's recorded model.
		await writeFixtureAgent(`---
name: fixture-reader
description: Read-only fixture persona
model: ["claude-sonnet-4-5"]
tools:
  - read
---

You are the fixture reader persona.`);

		const sourceManager = await SessionManager.open(personaFile, path.join(tempDir.path(), "sessions"));
		const liveSession = createSession(sourceManager);
		const created = spyStatus(createMode(liveSession));
		await created.init({ suppressWelcomeIntro: true });
		await created.switchAgentPersona("fixture-reader");
		expect(liveSession.getPersonaRuntime()!.policy.isPersonaActive()).toBe(true);
		// The persona's model applied (sonnet). Its exit baseline is sonnet too
		// (the session had no earlier model_change), while the TARGET recorded
		// haiku: if the exit runs post-restore, sonnet clobbers haiku.
		expect(liveSession.model?.id).toBe("claude-sonnet-4-5");

		const switched = await liveSession.switchSession(plainFile);
		expect(switched).toBe(true);

		// Persona gone AND the target's own model survived the switch.
		expect(liveSession.getPersonaRuntime()!.policy.isPersonaActive()).toBe(false);
		expect(liveSession.model?.id).toBe("claude-haiku-4-5");
		// No spurious model_change from the persona-exit clobber: the journal
		// must not record sonnet after the switch.
		const modelChanges = liveSession.sessionManager
			.getEntries()
			.filter(entry => entry.type === "model_change")
			.map(entry => (entry as { model: string }).model);
		expect(modelChanges.includes("anthropic/claude-sonnet-4-5")).toBe(false);
	});

	it("switch to a session whose persona no longer exists exits the source persona", async () => {
		// Regression: the target journal names an agent, but discovery can no
		// longer resolve it (the definition was deleted after the entry was
		// written). The reused runtime must exit the SOURCE persona before
		// landing in the target, not keep it attached with the target's
		// unresolved name reported.
		const personaTarget = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions"));
		personaTarget.appendMessage({ role: "user", content: "prior turn", timestamp: Date.now() });
		personaTarget.appendModeChange("agent", { name: "evaporated-persona" });
		await personaTarget.ensureOnDisk();
		await personaTarget.flush();
		const personaFile = personaTarget.getSessionFile();
		if (!personaFile) throw new Error("Expected session file");
		await personaTarget.close();

		// The SOURCE session's persona resolves (fixture written); the TARGET's
		// does not. Only fixture-reader is defined, never evaporated-persona.
		await writeFixtureAgent(READER_AGENT_MD);

		const sourceManager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions"));
		sourceManager.appendMessage({ role: "user", content: "source turn", timestamp: Date.now() });
		sourceManager.appendModeChange("agent", { name: "fixture-reader" });
		await sourceManager.ensureOnDisk();
		await sourceManager.flush();
		const sourceFile = sourceManager.getSessionFile();
		if (!sourceFile) throw new Error("Expected session file");
		await sourceManager.close();

		const liveManager = await SessionManager.open(sourceFile, path.join(tempDir.path(), "sessions"));
		const liveSession = createSession(liveManager);
		const created = spyStatus(createMode(liveSession));
		await created.init({ suppressWelcomeIntro: true });
		expect(liveSession.getPersonaRuntime()!.policy.isPersonaActive()).toBe(true);

		const switched = await liveSession.switchSession(personaFile);
		expect(switched).toBe(true);

		// Source persona cleared despite the target naming an unknown agent.
		const policy = liveSession.getPersonaRuntime()!.policy;
		expect(policy.isPersonaActive()).toBe(false);
		expect(liveSession.getPersonaAppendPrompt()).toBeUndefined();
		// Unrestricted presentation restored.
		expect(liveSession.getActiveToolNames()).toContain("write");
		expect(statusMessages.some(message => message.includes("evaporated-persona"))).toBe(true);
	});

	it("refuses /agent <name> while plan mode is active", async () => {
		const manager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions"));
		const liveSession = createSession(manager);
		const created = spyStatus(createMode(liveSession));
		await created.init({ suppressWelcomeIntro: true });

		await created.handlePlanModeCommand();
		expect(created.planModeEnabled).toBe(true);

		const warningSpy = vi.spyOn(created, "showWarning").mockImplementation(() => {});
		await created.switchAgentPersona("fixture-reader");

		expect(warningSpy.mock.calls.some(call => call[0].includes("Exit plan mode"))).toBe(true);
		expect(liveSession.getPersonaRuntime()!.policy.isPersonaActive()).toBe(false);
		expect(liveSession.getPersonaAppendPrompt()).toBeUndefined();
		const lastEntry = await lastAgentModeChange(manager);
		// The plan entry (or none) is last; no agent entry was appended.
		expect(lastEntry?.mode === "agent").toBe(false);
		warningSpy.mockRestore();
	});

	it("refuses plan mode while a persona is active, and exiting the persona recovers", async () => {
		const manager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions"));
		const liveSession = createSession(manager);
		const created = spyStatus(createMode(liveSession));
		await created.init({ suppressWelcomeIntro: true });
		await writeFixtureAgent(READER_AGENT_MD);

		await created.switchAgentPersona("fixture-reader");
		expect(liveSession.getPersonaRuntime()!.policy.isPersonaActive()).toBe(true);

		// Mode entry refuses while the persona is active — the persona owns the
		// tool grant and the mode's partition would fight it.
		const warningSpy = vi.spyOn(created, "showWarning").mockImplementation(() => {});
		await created.handlePlanModeCommand();
		expect(warningSpy.mock.calls.some(call => call[0].includes("Exit the agent persona"))).toBe(true);
		expect(created.planModeEnabled).toBe(false);
		expect(liveSession.getPersonaRuntime()!.policy.isPersonaActive()).toBe(true);
		warningSpy.mockRestore();

		// Exiting the persona is always available — it is the recovery path
		// out of the refusal above (no deadlock).
		await created.exitAgentPersona();
		expect(liveSession.getPersonaRuntime()!.policy.isPersonaActive()).toBe(false);
		expect(liveSession.getPersonaAppendPrompt()).toBeUndefined();

		// With the persona gone, the mode enters.
		await created.handlePlanModeCommand();
		expect(created.planModeEnabled).toBe(true);
	});
	it("thinking-only persona mid-turn queues the thinking level instead of dropping it (fo80k)", async () => {
		// A persona with `thinkingLevel` but NO model: the mid-turn defer hook
		// used to return early on the missing model, silently losing the
		// thinking change. The pending-switch channel carries thinkingLevel
		// alongside model, and flushPendingModelSwitch forwards both to
		// setModelTemporary — which applies a thinking-only change without
		// touching the model.
		await writeFixtureAgent(
			`---
name: fixture-thinker
description: Thinking-only persona
tools:
  - read
thinkingLevel: high
---

You are the fixture thinker persona.`,
			"fixture-thinker.md",
		);

		const manager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions"));
		const liveSession = createSession(manager);
		const created = spyStatus(createMode(liveSession));
		await created.init({ suppressWelcomeIntro: true });

		// Mid-turn: the persona's tools/prompt apply immediately, the thinking
		// switch defers to the pending queue.
		Object.defineProperty(liveSession, "isStreaming", { configurable: true, get: () => true });
		const setModelSpy = vi.spyOn(liveSession, "setModelTemporary").mockResolvedValue(undefined);
		await created.switchAgentPersona("fixture-thinker");
		expect(liveSession.getPersonaRuntime()!.policy.isPersonaActive()).toBe(true);
		expect(setModelSpy).not.toHaveBeenCalled(); // nothing applied into the live turn

		// Turn ends → event-controller flushes the queued switch.
		Object.defineProperty(liveSession, "isStreaming", { configurable: true, get: () => false });
		await created.flushPendingModelSwitch();

		expect(setModelSpy).toHaveBeenCalledTimes(1);
		const [switchModel, switchThinking] = setModelSpy.mock.calls[0] ?? [];
		expect(switchThinking).toBe(Effort.High); // thinking rides the queue
		// The model is untouched: the queue forwarded the session's own model.
		expect(switchModel).toBe(liveSession.model as Model);
	});

	it("thinking-only persona B merges into persona A's queued restore (j2w)", async () => {
		// A (modeled persona) exits mid-turn: its PRE-persona model restore is
		// queued. B (thinking-only, no model) then enters mid-turn: the queue
		// must MERGE — keep A's queued restore model, adopt B's thinking —
		// instead of replacing the entry with A's live persona model.
		await writeFixtureAgent(
			`---
name: fixture-modeled
description: Modeled fixture persona
tools:
	- read
model:
	- anthropic/claude-sonnet-4-5
---

You are the modeled fixture persona.`,
			"fixture-modeled.md",
		);
		await writeFixtureAgent(
			`---
name: fixture-thinker
description: Thinking-only persona
tools:
	- read
thinkingLevel: low
---

You are the fixture thinker persona.`,
			"fixture-thinker.md",
		);

		const manager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions"));
		const liveSession = createSession(manager);
		const created = spyStatus(createMode(liveSession));
		await created.init({ suppressWelcomeIntro: true });

		// Pre-persona baseline: the session's default (sonnet).
		const prePersonaModel = liveSession.model;
		expect(prePersonaModel?.id).toBe("claude-sonnet-4-5");

		// A enters BETWEEN turns (model applied), then the turn starts.
		await created.switchAgentPersona("fixture-modeled");
		expect(liveSession.model?.id).toBe("claude-sonnet-4-5");
		Object.defineProperty(liveSession, "isStreaming", { configurable: true, get: () => true });

		// A exits mid-turn: the pre-persona restore is QUEUED.
		await created.exitAgentPersona();
		expect(liveSession.getPersonaRuntime()!.policy.isPersonaActive()).toBe(false);

		// B enters mid-turn (thinking-only): must merge into the queued restore.
		const setModelSpy = vi.spyOn(liveSession, "setModelTemporary").mockResolvedValue(undefined);
		await created.switchAgentPersona("fixture-thinker");
		expect(liveSession.getPersonaRuntime()!.policy.isPersonaActive()).toBe(true);

		// Turn ends → flush: the queued entry carries A's restore model + B's
		// thinking — NOT A's live persona model (identical here, but the queue
		// must never hold the live model when a restore was queued).
		Object.defineProperty(liveSession, "isStreaming", { configurable: true, get: () => false });
		await created.flushPendingModelSwitch();
		expect(setModelSpy).toHaveBeenCalledTimes(1);
		const [switchModel, switchThinking] = setModelSpy.mock.calls[0] ?? [];
		expect(switchModel).toBe(prePersonaModel as Model);
		expect(switchThinking).toBe("low" as ConfiguredThinkingLevel);
	});

	it("user /model pick under a persona re-roots the exit baseline (j2p)", async () => {
		// Enter persona (baseline M0 → persona model applied), then the user
		// deliberately picks a DIFFERENT model through the session API. The
		// persona's exit must restore the USER's model, not the pre-enter M0.
		await writeFixtureAgent(
			`---
name: fixture-modeled
description: Modeled fixture persona
tools:
  - read
model:
  - anthropic/claude-sonnet-4-5
---

You are the modeled fixture persona.`,
			"fixture-modeled.md",
		);

		const manager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions"));
		const liveSession = createSession(manager);
		const created = spyStatus(createMode(liveSession));
		await created.init({ suppressWelcomeIntro: true });
		const baselineModel = liveSession.model;
		expect(baselineModel?.id).toBe("claude-sonnet-4-5"); // session default

		await created.switchAgentPersona("fixture-modeled");
		expect(liveSession.getPersonaRuntime()!.policy.isPersonaActive()).toBe(true);
		expect(liveSession.model?.id).toBe("claude-sonnet-4-5");

		// The user picks opus mid-persona (same channel the /model picker uses).
		const opus = getBundledModel("anthropic", "claude-opus-4-5");
		if (!opus) throw new Error("Expected built-in anthropic opus model to exist");
		await liveSession.setModelTemporary(opus, Effort.High);
		expect(liveSession.model?.id).toBe("claude-opus-4-5");

		await created.exitAgentPersona();
		expect(liveSession.getPersonaRuntime()!.policy.isPersonaActive()).toBe(false);
		// The USER's pick survives the persona exit — not the pre-enter model.
		expect(liveSession.model?.id).toBe("claude-opus-4-5");
	});

	it("user model pick under a persona persists the rerooted baseline to the journal (j2r)", async () => {
		// Enter persona (baseline M0), user picks M1 mid-persona, DISPOSE without
		// exiting. The reroot must be journaled: a resume re-enters with M1 as
		// the authoritative baseline, and the subsequent exit restores M1.
		await writeFixtureAgent(
			`---
name: fixture-modeled
description: Modeled fixture persona
tools:
	- read
model:
	- anthropic/claude-sonnet-4-5
---

You are the modeled fixture persona.`,
			"fixture-modeled.md",
		);

		const manager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions"));
		const liveSession = createSession(manager);
		// Wire the reroot journal the way the session factory does (sdk.ts j2r).
		const personaRuntime = liveSession.getPersonaRuntime()!;
		personaRuntime.setBaselineRerootCallback(() => {
			const active = personaRuntime.policy.snapshot().persona;
			if (!active || personaRuntime.getActiveBaseline() === undefined) return;
			appendPersonaJournalEntry(liveSession, {
				name: active.agent.name,
				explicit: active.explicit,
				baseline: personaRuntime.getActiveBaseline(),
			});
		});
		const created = spyStatus(createMode(liveSession));
		await created.init({ suppressWelcomeIntro: true });

		await created.switchAgentPersona("fixture-modeled");
		const opus = getBundledModel("anthropic", "claude-opus-4-5");
		if (!opus) throw new Error("Expected built-in anthropic opus model to exist");
		await liveSession.setModelTemporary(opus, Effort.High);

		// The reroot appended a fresh agent entry carrying the UPDATED baseline.
		const entries = manager
			.getEntries()
			.filter(entry => entry.type === "mode_change")
			.map(entry => entry as { mode: string; data?: Record<string, unknown> })
			.filter(entry => entry.mode === "agent");
		const last = entries.at(-1);
		expect(last?.data?.name).toBe("fixture-modeled");
		expect(last?.data?.baseline).toEqual({ model: "anthropic/claude-opus-4-5", thinkingLevel: "high" });

		await manager.ensureOnDisk();
		await manager.flush();
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");
		await created.stop();
		await liveSession.dispose();

		// Resume: the journal's rerooted baseline is authoritative; exiting the
		// restored persona must land on M1 (the user's pick), not the persona's
		// own model.
		const resumedManager = await SessionManager.open(sessionFile, path.join(tempDir.path(), "sessions"));
		const resumedSession = createSession(resumedManager);
		const resumed = spyStatus(createMode(resumedSession));
		await resumed.init({ suppressWelcomeIntro: true });
		expect(resumedSession.getPersonaRuntime()!.policy.isPersonaActive()).toBe(true);
		await resumed.exitAgentPersona();
		expect(resumedSession.model?.id).toBe("claude-opus-4-5");
		await resumedSession.dispose();
	});

	it("headless switchSession to a persona session re-enters the target persona (j2n)", async () => {
		// ACP/SDK-shaped surface: NO InteractiveMode, so no reconciler slot is
		// installed. switchSession must run the session-level persona reconcile
		// — the target journal's persona becomes active after the switch.
		const personaTarget = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions"));
		personaTarget.appendMessage({ role: "user", content: "persona turn", timestamp: Date.now() });
		personaTarget.appendModeChange("agent", { name: "fixture-reader" });
		await personaTarget.ensureOnDisk();
		await personaTarget.flush();
		const personaFile = personaTarget.getSessionFile();
		if (!personaFile) throw new Error("Expected session file");
		await personaTarget.close();

		const plainSource = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions"));
		plainSource.appendMessage({ role: "user", content: "plain", timestamp: Date.now() });
		await plainSource.ensureOnDisk();
		await plainSource.flush();
		const plainFile = plainSource.getSessionFile();
		if (!plainFile) throw new Error("Expected session file");
		await plainSource.close();

		await writeFixtureAgent(READER_AGENT_MD);

		const sourceManager = await SessionManager.open(plainFile, path.join(tempDir.path(), "sessions"));
		const liveSession = createSession(sourceManager);
		// No InteractiveMode, no reconciler: the raw session IS the surface.
		expect(liveSession.getPersonaRuntime()!.policy.isPersonaActive()).toBe(false);

		const switched = await liveSession.switchSession(personaFile);
		expect(switched).toBe(true);
		const policy = liveSession.getPersonaRuntime()!.policy;
		expect(policy.isPersonaActive()).toBe(true);
		expect(liveSession.getPersonaAppendPrompt()).toContain("fixture reader persona");
		expect(policy.effective("read")).toBe(true);
		expect(policy.effective("write")).toBe(false);
	});

	it("failed headless switch restores the source persona from the rollback (j2n)", async () => {
		// A FAILED switch rolls the session state back to the SOURCE session;
		// its persona must be re-entered by the session-level reconcile —
		// without this the rollback loses the persona (it was torn down before
		// the switch attempt).
		const sourcePersona = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions"));
		sourcePersona.appendMessage({ role: "user", content: "source turn", timestamp: Date.now() });
		sourcePersona.appendModeChange("agent", { name: "fixture-reader" });
		await sourcePersona.ensureOnDisk();
		await sourcePersona.flush();
		const sourceFile = sourcePersona.getSessionFile();
		if (!sourceFile) throw new Error("Expected session file");
		await sourcePersona.close();

		const otherTarget = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions"));
		otherTarget.appendMessage({ role: "user", content: "other", timestamp: Date.now() });
		await otherTarget.ensureOnDisk();
		await otherTarget.flush();
		const otherFile = otherTarget.getSessionFile();
		if (!otherFile) throw new Error("Expected session file");
		await otherTarget.close();

		await writeFixtureAgent(READER_AGENT_MD);

		const liveManager = await SessionManager.open(sourceFile, path.join(tempDir.path(), "sessions"));
		const liveSession = createSession(liveManager, { vetoBeforeSwitch: true });
		expect(liveSession.getPersonaRuntime()!.policy.isPersonaActive()).toBe(false);

		// Enter the persona live (as a user /agent would have before switching).
		const runtime = liveSession.getPersonaRuntime()!;
		const { agents } = await discoverAgents(tempDir.path());
		const agent = getAgent(agents, "fixture-reader");
		if (!agent) throw new Error("Expected fixture persona to resolve");
		await runtime.reconcile({ agent }, { apply: async () => {} });
		expect(runtime.policy.isPersonaActive()).toBe(true);

		const switched = await liveSession.switchSession(otherFile);
		expect(switched).toBe(false);

		// Rollback reinstated the SOURCE persona.
		expect(runtime.policy.isPersonaActive()).toBe(true);
		expect(liveSession.getPersonaAppendPrompt()).toContain("fixture reader persona");
	});
});
