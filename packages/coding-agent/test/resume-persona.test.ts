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

/** Plan-mode journal marker URL (built at runtime; literals get rewritten). */
const PLAN_URL = "local" + "://" + "PLAN.md";

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
	function createSession(
		sessionManager: SessionManager,
		options?: { vetoBeforeSwitch?: boolean; toolNames?: string[] },
	): AgentSession {
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
				...(options?.toolNames ? { toolNames: options.toolNames } : {}),
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
		const modeChangesBefore = (await lastAgentModeChange(resumedManager))?.data.name;
		await created.init({ suppressWelcomeIntro: true });

		const policy = createdSession.getPersonaRuntime()!.policy;
		expect(policy.isPersonaActive()).toBe(true);
		const entry = await lastAgentModeChange(resumedManager);
		expect(entry?.data.name).toBe("fixture-reader");
		// fvInv double-enter guard: the same-name reconcile must be a no-op —
		// no fresh exit/enter, so no NEW journal entry after the seam's.
		expect(entry?.data.name).toBe(modeChangesBefore);
		expect(statusMessages.some(message => message.includes("stale-persona"))).toBe(false);
	});

	it("retains the persona across a plan-mode journal interleave on resume", async () => {
		// fo0dT regression: persona entered, then plan mode opened. The journal's
		// `plan` entry no longer hides the preceding `agent` entry on resume —
		// the persona identity survives the temporary mode partition.
		const sourceManager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions"));
		sourceManager.appendMessage({ role: "user", content: "prior turn", timestamp: Date.now() });
		sourceManager.appendModeChange("agent", { name: "fixture-reader" });
		sourceManager.appendModeChange("plan", { planFilePath: PLAN_URL });
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

	// fvFVp: a persona whose MODEL pattern carries the thinking suffix
	// (`model: [provider/m:high]`, no `thinkingLevel` frontmatter) mid-turn —
	// the deferred queue must carry the PATTERN-DERIVED level, not just the
	// frontmatter one; the flush would otherwise land on the model's default.
	it("modeled persona with suffix pattern queues the pattern-derived thinking mid-turn (fvFVp)", async () => {
		await writeFixtureAgent(
			`---
name: fixture-suffixed
description: Persona whose model pattern carries a thinking suffix
tools:
  - read
model:
  - anthropic/claude-opus-4-5:high
---

You are the suffixed persona.`,
			"fixture-suffixed.md",
		);

		const manager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions"));
		const liveSession = createSession(manager);
		const created = spyStatus(createMode(liveSession));
		await created.init({ suppressWelcomeIntro: true });

		Object.defineProperty(liveSession, "isStreaming", { configurable: true, get: () => true });
		const setModelSpy = vi.spyOn(liveSession, "setModelTemporary").mockResolvedValue(undefined);
		await created.switchAgentPersona("fixture-suffixed");
		expect(liveSession.getPersonaRuntime()!.policy.isPersonaActive()).toBe(true);
		expect(setModelSpy).not.toHaveBeenCalled();

		Object.defineProperty(liveSession, "isStreaming", { configurable: true, get: () => false });
		await created.flushPendingModelSwitch();

		expect(setModelSpy).toHaveBeenCalledTimes(1);
		const [switchModel, switchThinking] = setModelSpy.mock.calls[0] ?? [];
		expect(switchModel?.id).toBe("claude-opus-4-5");
		expect(switchThinking).toBe(Effort.High);
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

	// Regression (Codex P2, TUI parity with the ACP flush fix): when the
	// turn-end flush's setModelTemporary REJECTS (extension model-change hook,
	// provider reset), the queued persona restore must stay owed — clearing it
	// up front strands a persona the user already exited on its persona model
	// with nothing left to restore. A later boundary must still land it.
	it("failed TUI flush keeps the persona restore queued for the next boundary", async () => {
		await writeFixtureAgent(
			`---
name: fixture-modeled-retry
description: Modeled persona
tools:
  - read
model:
  - anthropic/claude-opus-4-5
---

You are the retry persona.`,
			"fixture-modeled-retry.md",
		);
		const manager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions"));
		const liveSession = createSession(manager);
		const created = spyStatus(createMode(liveSession));
		await created.init({ suppressWelcomeIntro: true });

		// Mid-turn enter: the persona model switch defers into #pendingModelSwitch.
		Object.defineProperty(liveSession, "isStreaming", { configurable: true, get: () => true });
		const flushSpy = vi.spyOn(liveSession, "setModelTemporary");
		flushSpy.mockRejectedValueOnce(new Error("extension hook veto"));
		await created.switchAgentPersona("fixture-modeled-retry");

		// Turn ends; the flush attempts the apply once and it FAILS.
		Object.defineProperty(liveSession, "isStreaming", { configurable: true, get: () => false });
		await created.flushPendingModelSwitch();
		expect(flushSpy).toHaveBeenCalledTimes(1);
		expect(liveSession.model?.id).not.toBe("claude-opus-4-5"); // never applied

		// The entry stayed owed: the next boundary lands it.
		flushSpy.mockRestore();
		await created.flushPendingModelSwitch();
		expect(liveSession.model?.id).toBe("claude-opus-4-5");
	});

	// Regression (Codex P2): chained mid-turn switch. Persona A enters during a
	// turn — its model switch is QUEUED in #pendingModelSwitch. The user then
	// switches to B in the same turn; B's apply fails (refresh throws), so the
	// runtime rolls back to A and calls onPersonaSwitchFailed. Pre-fix the
	// rollback cleared the whole queue slot, deleting A's still-owed switch —
	// at agent_end A stayed active while the session sat on the pre-A model.
	// The rollback must restore the transaction-start entry, not clear it.
	it("failed chained switch keeps the earlier persona's queued switch (rollback restore)", async () => {
		await writeFixtureAgent(
			`---
name: fixture-a
description: Modeled persona A
tools:
  - read
model:
  - anthropic/claude-opus-4-5
---

You are persona A.`,
			"fixture-a.md",
		);
		await writeFixtureAgent(
			`---
name: fixture-b
description: Modeled persona B
tools:
  - write
model:
  - anthropic/claude-haiku-4-5
---

You are persona B.`,
			"fixture-b.md",
		);

		const manager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions"));
		const liveSession = createSession(manager);
		const created = spyStatus(createMode(liveSession));
		await created.init({ suppressWelcomeIntro: true });

		// Mid-turn: both switches defer to the queue.
		Object.defineProperty(liveSession, "isStreaming", { configurable: true, get: () => true });
		const setModelSpy = vi.spyOn(liveSession, "setModelTemporary").mockResolvedValue(undefined);

		await created.switchAgentPersona("fixture-a");
		expect(liveSession.getPersonaRuntime()!.policy.isPersonaActive()).toBe(true);
		expect(setModelSpy).not.toHaveBeenCalled(); // A's opus switch is queued, not applied

		// B's enter fails AFTER its defer channels ran (B queued its own
		// haiku switch over A's restore; the runtime rollback reinstates A).
		const refreshSpy = vi.spyOn(liveSession, "refreshBaseSystemPrompt");
		refreshSpy.mockRejectedValueOnce(new Error("boom"));
		// rollback restore() also refreshes; let later calls resolve.
		refreshSpy.mockResolvedValue(undefined);
		await expect(created.switchAgentPersona("fixture-b")).rejects.toThrow("boom");

		// The rollback kept A active and undid B's queue mutation; the
		// pre-fix rollback cleared A's queued opus switch instead.
		expect(liveSession.getPersonaRuntime()!.policy.snapshot().persona?.agent.name).toBe("fixture-a");
		Object.defineProperty(liveSession, "isStreaming", { configurable: true, get: () => false });
		await created.flushPendingModelSwitch();

		expect(setModelSpy).toHaveBeenCalledTimes(1);
		expect(setModelSpy.mock.calls[0]?.[0]?.id).toBe("claude-opus-4-5");
	});

	it("exiting a resumed persona restores the pre-persona baseline captured at original launch", async () => {
		const manager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions"));
		const liveSession = createSession(manager);
		const sonnet = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		await liveSession.setModelTemporary(sonnet);

		await writeFixtureAgent(
			`---
name: fixture-modeled
description: Modeled fixture persona
tools:
  - read
model:
  - anthropic/claude-opus-4-5
---

You are the modeled fixture persona.`,
			"fixture-modeled.md",
		);

		const created = spyStatus(createMode(liveSession));
		await created.init({ suppressWelcomeIntro: true });

		await created.switchAgentPersona("fixture-modeled");
		expect(liveSession.model?.id).toBe("claude-opus-4-5");

		await manager.ensureOnDisk();
		await manager.flush();
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");
		await created.stop();
		await liveSession.dispose();

		// Resume: the journal's baseline is authoritative; exiting the
		// restored persona lands on Sonnet (the original pre-persona model).
		const resumedManager = await SessionManager.open(sessionFile, path.join(tempDir.path(), "sessions"));
		const resumedSession = createSession(resumedManager);
		const resumed = spyStatus(createMode(resumedSession));
		await resumed.init({ suppressWelcomeIntro: true });
		expect(resumedSession.getPersonaRuntime()!.policy.isPersonaActive()).toBe(true);
		expect(resumedSession.model?.id).toBe("claude-opus-4-5");
		await resumed.exitAgentPersona();
		expect(resumedSession.model?.id).toBe("claude-sonnet-4-5");
		await resumedSession.dispose();
	});

	// Codex R3-2 (P1): a session launched `--tools read` persists that ceiling
	// in the persona entry's `explicit.tools`. Resuming WITHOUT the flag must
	// reinstall it as the session baseline — otherwise bare `/agent` exit (or a
	// switch to a wider persona) restores/derives from cliGrant=null and
	// silently enables write past the launch ceiling.
	it("resume reinstalls the persisted --tools ceiling across persona changes", async () => {
		const manager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions"));
		const liveSession = createSession(manager, { toolNames: ["read"] });
		await writeFixtureAgent(READER_AGENT_MD);
		await writeFixtureAgent(
			`---
name: fixture-wide
description: Wide fixture persona
tools:
  - read
  - write
---

You are the wide fixture persona.`,
			"fixture-wide.md",
		);
		// Launch with the CLI ceiling, then enter the persona (serializes
		// explicit.tools = the ceiling into the journal).
		const created = spyStatus(createMode(liveSession));
		await created.init({ suppressWelcomeIntro: true });
		await created.switchAgentPersona("fixture-reader");
		expect(liveSession.getPersonaRuntime()!.policy.effective("write")).toBe(false);

		await manager.ensureOnDisk();
		await manager.flush();
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");
		await created.stop();
		await liveSession.dispose();

		// Resume with NO --tools flag: a fresh null-grant policy + the journal.
		const resumedManager = await SessionManager.open(sessionFile, path.join(tempDir.path(), "sessions"));
		const resumedSession = createSession(resumedManager);
		const resumed = spyStatus(createMode(resumedSession));
		await resumed.init({ suppressWelcomeIntro: true });
		const policy = resumedSession.getPersonaRuntime()!.policy;
		expect(policy.isPersonaActive()).toBe(true);
		// Baseline ceiling reinstalled (not just the persona grant).
		expect([...(policy.cliGrant ?? [])]).toEqual(["read"]);
		// Bare exit: the ceiling survives (previously reverted to unrestricted)
		// in BOTH layers — effective() denies, and the restored PRESENTATION must
		// not re-activate write either (the exit snapshot replays through
		// granted(), which gates journal ceilings).
		await resumed.exitAgentPersona();
		expect(policy.effective("write")).toBe(false);
		expect(resumedSession.getActiveToolNames()).not.toContain("write");
		expect(resumedSession.getEnabledToolNames()).not.toContain("write");
		// Switch to a wider persona: its grant intersects the ceiling.
		await resumed.switchAgentPersona("fixture-wide");
		expect(policy.effective("read")).toBe(true);
		expect(policy.effective("write")).toBe(false);
		await resumedSession.dispose();
	});

	// Review R4-A/B: a mid-turn exit whose flush FAILED leaves the restore in
	// #pendingModelSwitch (retained by design). A subsequent PRE-TURN enter must
	// (1) adopt that owed baseline into the new persona's exit lineage — the live
	// model is still the old persona's, the restore never landed — and (2) drop
	// the queue entry so it cannot land mid-persona at the next agent_end.
	it("pre-turn enter adopts and clears the TUI owed restore", async () => {
		await writeFixtureAgent(
			`---
name: fixture-alpha
description: Alpha persona
tools:
  - read
model:
  - anthropic/claude-opus-4-5
---

Alpha.`,
			"fixture-alpha.md",
		);
		await writeFixtureAgent(
			`---
name: fixture-beta
description: Beta persona
tools:
  - read
model:
  - anthropic/claude-haiku-4-5
---

Beta.`,
			"fixture-beta.md",
		);
		const manager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions"));
		const liveSession = createSession(manager);
		const created = spyStatus(createMode(liveSession));
		await created.init({ suppressWelcomeIntro: true });

		// Enter alpha pre-turn (its model applies), then exit MID-TURN so the
		// baseline restore is queued rather than applied.
		await created.switchAgentPersona("fixture-alpha");
		expect(liveSession.model?.id).toBe("claude-opus-4-5");
		Object.defineProperty(liveSession, "isStreaming", { configurable: true, get: () => true });
		await created.exitAgentPersona();
		Object.defineProperty(liveSession, "isStreaming", { configurable: true, get: () => false });

		// The turn-end flush FAILS: the restore stays owed (round 4 behavior).
		const spy = vi.spyOn(liveSession, "setModelTemporary").mockRejectedValueOnce(new Error("veto"));
		await created.flushPendingModelSwitch();
		expect(spy).toHaveBeenCalledTimes(1);
		spy.mockRestore();

		// Pre-turn enter of beta: it must adopt the owed base and clear the queue.
		await created.switchAgentPersona("fixture-beta");
		expect(liveSession.model?.id).toBe("claude-haiku-4-5");
		const runtime = liveSession.getPersonaRuntime()!;
		// Adopted: beta's eventual exit restores the owed base, not alpha's model.
		expect(runtime.getActiveBaseline()?.model?.id).not.toBe("claude-opus-4-5");
		// Cleared: the next boundary must not drop the session off beta's model.
		const flushSpy = vi.spyOn(liveSession, "setModelTemporary");
		await created.flushPendingModelSwitch();
		expect(flushSpy).not.toHaveBeenCalled();
		expect(liveSession.model?.id).toBe("claude-haiku-4-5");
	});

	// Review P2-1/b: the mode guards were reordered so UNWIND paths stay
	// available under a persona — mode ENTRY must still refuse.
	it("fresh mode entry still refuses under an active persona after the reorder", async () => {
		await writeFixtureAgent(READER_AGENT_MD);
		const manager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions"));
		const liveSession = createSession(manager);
		liveSession.settings.set("goal.enabled", true);
		const created = spyStatus(createMode(liveSession));
		await created.init({ suppressWelcomeIntro: true });
		const warnings: string[] = [];
		vi.spyOn(created, "showWarning").mockImplementation(((message: string) => {
			warnings.push(message);
		}) as typeof created.showWarning);
		await created.switchAgentPersona("fixture-reader");
		expect(liveSession.getPersonaRuntime()!.policy.isPersonaActive()).toBe(true);

		// /plan entry refuses (no active plan to unwind).
		expect(await created.handlePlanModeCommand()).toBe(false);
		expect(created.planModeEnabled).toBe(false);
		expect(warnings.some(message => message.includes("Exit the agent persona first"))).toBe(true);
		// /goal set (fresh start through the dispatcher, which runs BEFORE the
		// top-level guard) must not start a goal under the persona either.
		warnings.length = 0;
		expect(await created.handleGoalModeCommand("set a fresh objective")).toBe(false);
		expect(created.goalModeEnabled).toBe(false);
		expect(warnings.some(message => message.includes("Exit the agent persona first"))).toBe(true);
	});

	// Review F-A8/P3-1 (surface parity): a same-session RELOAD is not a session
	// boundary — the TUI's pending model queue belongs to the continuing session
	// and must survive it (the session-level slot already scopes to
	// switchingToDifferentSession).
	it("keeps a retained TUI persona restore across a same-session reload", async () => {
		await writeFixtureAgent(
			`---
name: fixture-alpha
description: Alpha persona
tools:
  - read
model:
  - anthropic/claude-opus-4-5
---

Alpha.`,
			"fixture-alpha.md",
		);
		const manager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions"));
		const liveSession = createSession(manager);
		const created = spyStatus(createMode(liveSession));
		await created.init({ suppressWelcomeIntro: true });
		await created.switchAgentPersona("fixture-alpha");
		// Mid-turn exit queues the base restore; its flush FAILS -> retained.
		Object.defineProperty(liveSession, "isStreaming", { configurable: true, get: () => true });
		await created.exitAgentPersona();
		Object.defineProperty(liveSession, "isStreaming", { configurable: true, get: () => false });
		const veto = vi.spyOn(liveSession, "setModelTemporary").mockRejectedValueOnce(new Error("veto"));
		await created.flushPendingModelSwitch();
		veto.mockRestore();

		// Reload the SAME session (the installed session-switch reconciler runs
		// from switchSession, which reload() delegates to).
		await created.sessionManager.ensureOnDisk();
		await created.sessionManager.flush();
		await liveSession.reload();
		// still owed: the next boundary (with the veto gone) lands it.
		const flushSpy = vi.spyOn(liveSession, "setModelTemporary");
		await created.flushPendingModelSwitch();
		expect(flushSpy).toHaveBeenCalledTimes(1);
	});

	// Review F2 (surface parity): /new crosses a REAL boundary, so the TUI's
	// pending model queue must not survive into the fresh transcript — its first
	// agent_end would apply the outgoing session's persona restore.
	it("drops the retained TUI restore when /new commits", async () => {
		await writeFixtureAgent(
			`---
name: fixture-alpha
description: Alpha persona
tools:
  - read
model:
  - anthropic/claude-opus-4-5
---

Alpha.`,
			"fixture-alpha.md",
		);
		const manager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions"));
		const liveSession = createSession(manager);
		const created = spyStatus(createMode(liveSession));
		await created.init({ suppressWelcomeIntro: true });
		await created.switchAgentPersona("fixture-alpha");
		Object.defineProperty(liveSession, "isStreaming", { configurable: true, get: () => true });
		await created.exitAgentPersona();
		Object.defineProperty(liveSession, "isStreaming", { configurable: true, get: () => false });
		const veto = vi.spyOn(liveSession, "setModelTemporary").mockRejectedValueOnce(new Error("veto"));
		await created.flushPendingModelSwitch();
		veto.mockRestore();

		await created.handleClearCommand();
		// Nothing owed on the fresh transcript: the next boundary applies nothing.
		const flushSpy = vi.spyOn(liveSession, "setModelTemporary");
		await created.flushPendingModelSwitch();
		expect(flushSpy).not.toHaveBeenCalled();
	});

	// Codex R6-2: the TUI's persona-less switch branch bypasses
	// reconcileSessionPersona (the only other clear site), and switchSession has
	// already exited the source persona — so this branch must clear the
	// journal-installed ceiling itself, or the plain target stays restricted by
	// the SOURCE session's persisted grant.
	it("switch to a persona-less session clears the source journal ceiling", async () => {
		await writeFixtureAgent(READER_AGENT_MD);
		// Source journal: persona entry carrying the persisted ceiling.
		const personaTarget = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions"));
		personaTarget.appendMessage({ role: "user", content: "turn", timestamp: Date.now() });
		personaTarget.appendModeChange("agent", { name: "fixture-reader", explicit: { tools: ["read"] } });
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

		const liveManager = await SessionManager.open(personaFile, path.join(tempDir.path(), "sessions"));
		const liveSession = createSession(liveManager);
		const created = spyStatus(createMode(liveSession));
		await created.init({ suppressWelcomeIntro: true });
		expect([...(liveSession.getToolPolicy()!.cliGrant ?? [])]).toEqual(["read"]);

		const switched = await liveSession.switchSession(plainFile);
		expect(switched).toBe(true);
		const policy = liveSession.getPersonaRuntime()!.policy;
		expect(policy.isPersonaActive()).toBe(false);
		expect(policy.cliGrant).toBeNull();
		expect(policy.effective("write")).toBe(true);
	});

	// Codex R5-1: when the gone-persona baseline restore FAILS (an extension
	// model-change hook vetoes setModelTemporary), the journal's persona entry
	// is the only record of the baseline — clearing it (mode_change none) would
	// strand the session on the deleted persona's model with no retry path.
	// The failure must propagate so the outer reconcile leaves the entry intact.
	it("gone persona keeps the journal entry when baseline restore fails", async () => {
		const sonnet = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const opus = getBundledModel("anthropic", "claude-opus-4-5")!;
		const manager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions"));
		manager.appendMessage({ role: "user", content: "turn", timestamp: Date.now() });
		manager.appendModeChange("agent", {
			name: "no-such-persona",
			baseline: { model: `${sonnet.provider}/${sonnet.id}` },
		});
		manager.appendModelChange(`${opus.provider}/${opus.id}`, "default");
		await manager.ensureOnDisk();
		await manager.flush();
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");
		await manager.close();

		const resumedManager = await SessionManager.open(sessionFile, path.join(tempDir.path(), "sessions"));
		const resumedSession = createSession(resumedManager);
		await resumedSession.setModelTemporary(opus, undefined, { ephemeral: true });
		const veto = vi.spyOn(resumedSession, "setModelTemporary").mockRejectedValue(new Error("hook veto"));
		const resumed = spyStatus(createMode(resumedSession));
		await resumed.init({ suppressWelcomeIntro: true });
		veto.mockRestore();

		// Entry retained (no clear marker) so the next resume retries.
		const modes = resumedSession.sessionManager
			.getEntries()
			.filter(entry => entry.type === "mode_change")
			.map(entry => entry as { mode: string });
		expect(modes.at(-1)?.mode).toBe("agent");
	});

	// Codex R5-2: a baseline whose MODEL dropped out of the registry degrades to
	// undefined but its recorded thinking level is still restorable; the gone
	// branch must apply the thinking half instead of skipping the restore.
	it("gone persona restores thinking when its baseline model is gone", async () => {
		const manager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions"));
		manager.appendMessage({ role: "user", content: "turn", timestamp: Date.now() });
		manager.appendModeChange("agent", {
			name: "no-such-persona",
			baseline: { model: "anthropic/claude-vanished-9", thinkingLevel: "high" },
		});
		await manager.ensureOnDisk();
		await manager.flush();
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");
		await manager.close();

		const resumedManager = await SessionManager.open(sessionFile, path.join(tempDir.path(), "sessions"));
		const resumedSession = createSession(resumedManager);
		const spy = vi.spyOn(resumedSession, "setModelTemporary");
		const resumed = spyStatus(createMode(resumedSession));
		await resumed.init({ suppressWelcomeIntro: true });
		// thinking-only apply (live model preserved), and the clear marker lands.
		expect(spy).toHaveBeenCalledTimes(1);
		expect(spy.mock.calls[0]?.[1]).toBe(Effort.High);
		expect(resumedSession.configuredThinkingLevel()).toBe(Effort.High);
		expect(resumedSession.model?.id).toBe("claude-sonnet-4-5");
		await resumedSession.dispose();
	});

	// Codex R5-4: a resumed `agent -> plan` journal activates BOTH the persona
	// and plan mode. /agent refuses under an active plan, so /plan's exit
	// branches must run BEFORE the persona entry guard — guarding them too
	// deadlocks the user in both states with no command able to unwind either.
	it("/plan exits a transparent resumed plan under an active persona", async () => {
		await writeFixtureAgent(READER_AGENT_MD);
		const manager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions"));
		manager.appendMessage({ role: "user", content: "turn", timestamp: Date.now() });
		manager.appendModeChange("agent", { name: "fixture-reader" });
		manager.appendModeChange("plan", { planFilePath: PLAN_URL });
		await manager.ensureOnDisk();
		await manager.flush();
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");
		await manager.close();

		const resumedManager = await SessionManager.open(sessionFile, path.join(tempDir.path(), "sessions"));
		const resumedSession = createSession(resumedManager);
		resumedSession.settings.set("plan.enabled", true);
		const resumed = spyStatus(createMode(resumedSession));
		await resumed.init({ suppressWelcomeIntro: true });
		expect(resumedSession.getPersonaRuntime()!.policy.isPersonaActive()).toBe(true);
		expect(resumed.planModeEnabled).toBe(true);

		// /plan's first toggle PAUSES the mode even with the persona active
		// (pre-fix the persona guard blocked the exit branches entirely, so
		// neither /plan nor /agent could unwind anything — a hard deadlock).
		await resumed.handlePlanModeCommand();
		expect(resumed.planModeEnabled).toBe(false);
		expect(resumed.planModePaused).toBe(true);
		expect(resumedSession.getPersonaRuntime()!.policy.isPersonaActive()).toBe(true);
		// Second toggle clears the paused flag; then the persona exit is
		// available too (no deadlock in either direction).
		await resumed.handlePlanModeCommand();
		expect(resumed.planModePaused).toBe(false);
		await resumed.exitAgentPersona();
		expect(resumedSession.getPersonaRuntime()!.policy.isPersonaActive()).toBe(false);
		expect(resumedSession.getPersonaRuntime()!.policy.isPersonaActive()).toBe(false);
		await resumedSession.dispose();
	});

	// Review R4-C: a journal-reinstalled ceiling must not outlive its carrier
	// session — switching into another persona session whose journal records a
	// DIFFERENT ceiling replaces the prior journal install (a fresh CLI flag
	// would still win, but there is none here).
	it("session switch replaces one journal ceiling with the other's", async () => {
		await writeFixtureAgent(
			`---
name: fixture-wide
description: Wide fixture persona
tools:
  - read
  - write
---

You are the wide fixture persona.`,
			"fixture-wide.md",
		);
		await writeFixtureAgent(READER_AGENT_MD);
		const mkJournal = async (name: string, persona: string, ceiling: string[]) => {
			const m = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions"));
			m.appendMessage({ role: "user", content: "turn", timestamp: Date.now() });
			m.appendModeChange("agent", { name: persona, explicit: { tools: ceiling } });
			await m.ensureOnDisk();
			await m.flush();
			const file = m.getSessionFile();
			if (!file) throw new Error("Expected session file");
			await m.close();
			return file;
		};
		const s1File = await mkJournal("s1", "fixture-reader", ["read"]);
		const s2File = await mkJournal("s2", "fixture-wide", ["write"]);

		const liveManager = await SessionManager.open(s1File, path.join(tempDir.path(), "sessions"));
		const liveSession = createSession(liveManager);
		const created = spyStatus(createMode(liveSession));
		await created.init({ suppressWelcomeIntro: true });
		expect([...liveSession.getToolPolicy()!.cliGrant!]).toEqual(["read"]);

		const switched = await liveSession.switchSession(s2File);
		expect(switched).toBe(true);
		// S2's OWN ceiling rules: write bounded-in, read bounded-out. Pre-fix S1's
		// [read] survived (null-to-set) and silently narrowed S2 past its record.
		expect([...liveSession.getToolPolicy()!.cliGrant!]).toEqual(["write"]);
		expect(liveSession.getPersonaRuntime()!.policy.effective("write")).toBe(true);
		expect(liveSession.getPersonaRuntime()!.policy.effective("read")).toBe(false);
	});

	// Review R4-D: the ceiling's only journal carrier is the persona entry, and
	// the gone-persona branch ERASES it — the install must run BEFORE the
	// degrade so the resumed session stays bounded this resume too.
	it("gone persona with a persisted ceiling keeps the session bounded", async () => {
		const manager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions"));
		manager.appendMessage({ role: "user", content: "turn", timestamp: Date.now() });
		manager.appendModeChange("agent", { name: "no-such-persona", explicit: { tools: ["read"] } });
		await manager.ensureOnDisk();
		await manager.flush();
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");
		await manager.close();

		const resumedManager = await SessionManager.open(sessionFile, path.join(tempDir.path(), "sessions"));
		const resumedSession = createSession(resumedManager);
		const resumed = spyStatus(createMode(resumedSession));
		await resumed.init({ suppressWelcomeIntro: true });
		const policy = resumedSession.getPersonaRuntime()!.policy;
		expect(policy.isPersonaActive()).toBe(false);
		expect([...(policy.cliGrant ?? [])]).toEqual(["read"]);
		expect(policy.effective("write")).toBe(false);
		await resumedSession.dispose();
	});

	// Review R4-A(2): a re-queued failed persona restore is source-session state
	// — surviving the switch would clobber the target's restored model.
	it("session switch discards a retained failed restore", async () => {
		await writeFixtureAgent(
			`---
name: fixture-alpha
description: Alpha persona
tools:
  - read
model:
  - anthropic/claude-opus-4-5
---

Alpha.`,
			"fixture-alpha.md",
		);
		const plainTarget = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions"));
		plainTarget.appendMessage({ role: "user", content: "plain", timestamp: Date.now() });
		const haiku = getBundledModel("anthropic", "claude-haiku-4-5")!;
		plainTarget.appendModelChange(`${haiku.provider}/${haiku.id}`, "default");
		await plainTarget.ensureOnDisk();
		await plainTarget.flush();
		const plainFile = plainTarget.getSessionFile();
		if (!plainFile) throw new Error("Expected session file");
		await plainTarget.close();

		const manager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions"));
		const liveSession = createSession(manager);
		const created = spyStatus(createMode(liveSession));
		await created.init({ suppressWelcomeIntro: true });
		await created.switchAgentPersona("fixture-alpha");
		Object.defineProperty(liveSession, "isStreaming", { configurable: true, get: () => true });
		await created.exitAgentPersona();
		Object.defineProperty(liveSession, "isStreaming", { configurable: true, get: () => false });
		const spy = vi.spyOn(liveSession, "setModelTemporary").mockRejectedValueOnce(new Error("veto"));
		await created.flushPendingModelSwitch();
		spy.mockRestore();

		const switched = await liveSession.switchSession(plainFile);
		expect(switched).toBe(true);
		expect(liveSession.model?.id).toBe("claude-haiku-4-5");
		const flushSpy = vi.spyOn(liveSession, "setModelTemporary");
		await created.flushPendingModelSwitch();
		expect(flushSpy).not.toHaveBeenCalled();
		expect(liveSession.model?.id).toBe("claude-haiku-4-5");
	});

	// Review R4-A(4): a persistently failing restore must give up after three
	// consecutive rejections instead of warning every turn forever.
	it("failed restore gives up after three consecutive rejections", async () => {
		await writeFixtureAgent(
			`---
name: fixture-alpha
description: Alpha persona
tools:
  - read
model:
  - anthropic/claude-opus-4-5
---

Alpha.`,
			"fixture-alpha.md",
		);
		const manager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions"));
		const liveSession = createSession(manager);
		const created = spyStatus(createMode(liveSession));
		await created.init({ suppressWelcomeIntro: true });
		await created.switchAgentPersona("fixture-alpha");
		Object.defineProperty(liveSession, "isStreaming", { configurable: true, get: () => true });
		await created.exitAgentPersona();
		Object.defineProperty(liveSession, "isStreaming", { configurable: true, get: () => false });
		const spy = vi.spyOn(liveSession, "setModelTemporary").mockRejectedValue(new Error("no api key"));
		const warnings = vi.spyOn(created, "showWarning").mockImplementation(() => {});
		await created.flushPendingModelSwitch();
		await created.flushPendingModelSwitch();
		await created.flushPendingModelSwitch();
		expect(spy).toHaveBeenCalledTimes(3);
		await created.flushPendingModelSwitch();
		expect(spy).toHaveBeenCalledTimes(3); // entry dropped; no fourth attempt
		expect(warnings.mock.calls.some(call => String(call[0]).includes("Giving up"))).toBe(true);
	});

	// Codex R3-3: cold resume of a journal whose persona was DELETED leaves no
	// live runtime to exit; session restoration has already landed on the
	// persona's last model. The gone branch must adopt the journal's recorded
	// pre-persona baseline before appending the clear marker, or the session
	// stays on the deleted persona's model permanently while claiming it
	// resumed without it.
	it("gone persona on cold resume restores its persisted baseline model", async () => {
		const sonnet = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const opus = getBundledModel("anthropic", "claude-opus-4-5")!;
		const manager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions"));
		manager.appendMessage({ role: "user", content: "prior turn", timestamp: Date.now() });
		manager.appendModeChange("agent", {
			name: "no-such-persona",
			baseline: { model: `${sonnet.provider}/${sonnet.id}` },
		});
		// The persona's model applied at enter time — recorded like the real flow.
		manager.appendModelChange(`${opus.provider}/${opus.id}`, "default");
		await manager.ensureOnDisk();
		await manager.flush();
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");
		await manager.close();

		const resumedManager = await SessionManager.open(sessionFile, path.join(tempDir.path(), "sessions"));
		const resumedSession = createSession(resumedManager);
		// The real resume flow lands on the journal's LAST model_change (the
		// persona's opus) during construction; replay that before reconciling.
		await resumedSession.setModelTemporary(opus, undefined, { ephemeral: true });
		const resumed = spyStatus(createMode(resumedSession));
		await resumed.init({ suppressWelcomeIntro: true });
		// Restored onto the persona model, then pulled back to the baseline —
		// not left stranded on opus.
		expect(resumedSession.model?.id).toBe("claude-sonnet-4-5");
		expect(statusMessages.some(message => message.includes("no longer available"))).toBe(true);
		await resumedSession.dispose();
	});

	// Codex R3-4: a persona resumed UNDER plan mode leaves the plan snapshot
	// holding the persona's restricted presentation. The forced session switch
	// exits the persona pre-switch; the post-switch #clearTransientModeState
	// would then replay that SOURCE snapshot onto the TARGET, restricting a
	// plain target with the source persona's tool set. The switch must discard
	// the source-mode snapshot instead.
	it("switch discards source plan-mode tool snapshot when exiting its persona", async () => {
		// Source journal: persona entry (definition exists), then a transparent
		// plan mode entry.
		const personaTarget = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions"));
		personaTarget.appendMessage({ role: "user", content: "prior turn", timestamp: Date.now() });
		personaTarget.appendModeChange("agent", { name: "fixture-reader" });
		// Transparent plan-mode entry AFTER the persona (persona stays active
		// underneath; resume enters plan after reconciling the persona).
		personaTarget.appendModeChange("plan", { planFilePath: PLAN_URL });
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
		// plan.enabled lets the restored plan entry re-enter; it happens AFTER
		// the persona reconcile, so the plan snapshot captures the
		// persona-narrowed presentation.
		liveSession.settings.set("plan.enabled", true);
		const created = spyStatus(createMode(liveSession));
		await created.init({ suppressWelcomeIntro: true });
		expect(created.planModeEnabled).toBe(true);
		expect(liveSession.getPersonaRuntime()!.policy.isPersonaActive()).toBe(true);

		const switched = await liveSession.switchSession(plainFile);
		expect(switched).toBe(true);
		// The plain target keeps its unrestricted set: the source persona's
		// snapshot must not be replayed onto it.
		expect(liveSession.getActiveToolNames()).toContain("write");
		await created.stop();
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

	// fured: the gone-persona degrade on a headless switch surfaces as a
	// session notice (the client-facing channel on ACP/RPC surfaces), not a
	// silent journal write only.
	it("headless switch to a session whose persona is gone emits a notice (fured)", async () => {
		// Target journal names a persona no fixture defines.
		const goneTarget = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions"));
		goneTarget.appendMessage({ role: "user", content: "gone persona turn", timestamp: Date.now() });
		goneTarget.appendModeChange("agent", { name: "no-such-persona" });
		await goneTarget.ensureOnDisk();
		await goneTarget.flush();
		const goneFile = goneTarget.getSessionFile();
		if (!goneFile) throw new Error("Expected session file");
		await goneTarget.close();

		const plainSource = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions"));
		plainSource.appendMessage({ role: "user", content: "plain", timestamp: Date.now() });
		await plainSource.ensureOnDisk();
		await plainSource.flush();
		const plainFile = plainSource.getSessionFile();
		if (!plainFile) throw new Error("Expected session file");
		await plainSource.close();

		const sourceManager = await SessionManager.open(plainFile, path.join(tempDir.path(), "sessions"));
		const liveSession = createSession(sourceManager);
		const notices: Array<{ level: string; message: string }> = [];
		liveSession.subscribe(event => {
			if (event.type === "notice") notices.push({ level: event.level, message: event.message });
		});

		const switched = await liveSession.switchSession(goneFile);
		expect(switched).toBe(true);
		expect(liveSession.getPersonaRuntime()!.policy.isPersonaActive()).toBe(false);
		expect(
			notices.some(
				notice => notice.message.includes('"no-such-persona"') && notice.message.includes("no longer available"),
			),
		).toBe(true);
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

	// fvIn0: a FAILED persona teardown (runtime.exit throws) aborts the switch —
	// the rollback inside exit keeps the source persona intact, and continuing
	// would load the target with the source's stale grant/prompt/presentation.
	it("failed persona teardown aborts the switch (fvIn0)", async () => {
		const sourcePersona = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions"));
		sourcePersona.appendMessage({ role: "user", content: "source turn", timestamp: Date.now() });
		sourcePersona.appendModeChange("agent", { name: "fixture-reader" });
		await sourcePersona.ensureOnDisk();
		await sourcePersona.flush();
		const sourceFile = sourcePersona.getSessionFile();
		if (!sourceFile) throw new Error("Expected session file");
		await sourcePersona.close();

		const plainTarget = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions"));
		plainTarget.appendMessage({ role: "user", content: "plain", timestamp: Date.now() });
		await plainTarget.ensureOnDisk();
		await plainTarget.flush();
		const plainFile = plainTarget.getSessionFile();
		if (!plainFile) throw new Error("Expected session file");
		await plainTarget.close();

		await writeFixtureAgent(READER_AGENT_MD);

		const liveManager = await SessionManager.open(sourceFile, path.join(tempDir.path(), "sessions"));
		const liveSession = createSession(liveManager);
		const runtime = liveSession.getPersonaRuntime()!;

		// Enter the persona, then sabotage the teardown: setActiveToolPresentation
		// throws so runtime.exit rolls back and rethrows (the same channel a
		// failing presentation apply exercises in production).
		const boom = new Error("teardown boom");
		const fixtureAgent = getAgent(await discoverAgents(tempDir.path()).then(d => d.agents), "fixture-reader");
		if (!fixtureAgent) throw new Error("Expected fixture persona to resolve");
		await runtime.reconcile(
			{ agent: fixtureAgent },
			{
				apply: async () => {},
			},
		);
		expect(runtime.policy.isPersonaActive()).toBe(true);
		const presentationSpy = vi.spyOn(liveSession, "setActiveToolPresentation").mockImplementation(async () => {
			throw boom;
		});
		const exiting = runtime.exit({ apply: async () => {} });
		await expect(exiting).rejects.toThrow(boom);
		expect(runtime.policy.isPersonaActive()).toBe(true); // rollback reinstated
		presentationSpy.mockRestore();

		// fvIn0 (the agent-session change): a teardown failure DURING switchSession
		// aborts the switch — the source persona survives intact. The exit inside
		// switchSession re-throws through the same sabotaged presentation channel.
		vi.spyOn(liveSession, "setActiveToolPresentation").mockImplementation(async () => {
			throw boom;
		});
		const switched = await liveSession.switchSession(plainFile);
		expect(switched).toBe(false);
		expect(runtime.policy.isPersonaActive()).toBe(true); // source persona intact
	});
});
