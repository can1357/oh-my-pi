/**
 * Branch-aware persona journal reads (`reconcileSessionPersona`, plan §3):
 *
 * - `readPersistedAgentPersona` must follow the CURRENT LEAF's ancestry
 *   (`sessionManager.getBranch()`), not every physical entry
 *   (`getEntries()`): a `/tree` rewind before the persona's `mode_change
 *   agent` marker mints a branch whose ancestry predates the persona
 *   activation — the abandoned-branch marker must not resume a persona there.
 *
 * Drives the real pipeline over a real on-disk journal with persona discovery
 * pointed at the temp project's `.omp/agents` dir (same harness convention as
 * resume-persona.test.ts).
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
import { reconcileSessionPersona } from "@oh-my-pi/pi-coding-agent/session/persisted-persona";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { TempDir } from "@oh-my-pi/pi-utils";

const READER_AGENT_MD = `---
name: fixture-reader
description: Read-only fixture persona
tools:
  - read
---

You are the fixture reader persona.`;

describe("reconcileSessionPersona branch ancestry", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@omp-persona-branch-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		session = undefined;
		authStorage = undefined as unknown as AuthStorage;
		tempDir = undefined as unknown as TempDir;
		resetSettingsForTest();
	});

	async function writeFixtureAgent(content: string = READER_AGENT_MD, name = "fixture-reader.md"): Promise<void> {
		const agentsDir = path.join(tempDir.path(), ".omp", "agents");
		await fs.mkdir(agentsDir, { recursive: true });
		await fs.writeFile(path.join(agentsDir, name), content, "utf-8");
	}

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
		const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!bundled) throw new Error("Expected built-in anthropic model to exist");
		const model: Model<Api> = bundled;
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
		createdSession.setPersonaRuntime(new PersonaRuntime(createdSession.getToolPolicy()!, createdSession));
		return createdSession;
	}

	it("a persona marker on an abandoned branch does not activate on the current leaf", async () => {
		const manager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions"));
		manager.appendMessage({ role: "user", content: "turn one", timestamp: Date.now() });
		const rewindPoint = manager.getEntries().at(-1)!.id;
		manager.appendMessage({ role: "user", content: "turn two", timestamp: Date.now() });
		// Persona entered on the abandoned continuation.
		manager.appendModeChange("agent", { name: "fixture-reader" });
		// `/tree` rewind: leaf moves BEFORE the persona marker.
		manager.branch(rewindPoint);
		// The new branch continues without ever entering the persona.
		manager.appendMessage({ role: "user", content: "rewound turn", timestamp: Date.now() });
		await manager.ensureOnDisk();
		await manager.flush();

		await writeFixtureAgent();
		const created = createSession(manager);

		await reconcileSessionPersona(created, { buildHooks: () => ({ apply: async () => {} }) });

		// The abandoned branch's `agent` marker is not on this leaf's ancestry:
		// the persona must stay OFF. (Pre-fix, getEntries() saw the marker.)
		expect(created.getPersonaRuntime()!.policy.isPersonaActive()).toBe(false);
		expect(created.getPersonaAppendPrompt()).toBeUndefined();
	});

	it("a persona marker ON the current ancestry still activates", async () => {
		const manager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions"));
		manager.appendMessage({ role: "user", content: "turn one", timestamp: Date.now() });
		const rewindPoint = manager.getEntries().at(-1)!.id;
		manager.appendMessage({ role: "user", content: "turn two", timestamp: Date.now() });
		// Rewind to turn one, then enter the persona on the new branch — the
		// marker IS on the current leaf's ancestry.
		manager.branch(rewindPoint);
		manager.appendModeChange("agent", { name: "fixture-reader" });
		manager.appendMessage({ role: "user", content: "rewound turn", timestamp: Date.now() });
		await manager.ensureOnDisk();
		await manager.flush();

		await writeFixtureAgent();
		const created = createSession(manager);

		await reconcileSessionPersona(created, { buildHooks: () => ({ apply: async () => {} }) });

		expect(created.getPersonaRuntime()!.policy.isPersonaActive()).toBe(true);
		expect(created.getPersonaAppendPrompt()).toContain("fixture reader persona");
	});
	// fwULw regression: a resumed `agent -> plan` journal keeps the persona
	// active underneath the transparent plan marker. An ordinary outer-mode
	// exit path (plan disabled at settings-load time) appends `mode_change
	// none` WITHOUT exiting the persona — that `none` must not be read as a
	// persona exit, or the NEXT reconcile drops the still-active persona.
	it("a `none` appended under a still-active persona does not end it", async () => {
		const manager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions"));
		manager.appendMessage({ role: "user", content: "turn", timestamp: Date.now() });
		manager.appendModeChange("agent", { name: "fixture-reader" });
		manager.appendModeChange("plan", { planFilePath: "local://PLAN.md" });
		// The outer-mode exit path's marker (plan mode unwound while the
		// persona stays active).
		manager.appendModeChange("none");
		await manager.ensureOnDisk();
		await manager.flush();

		await writeFixtureAgent();
		const created = createSession(manager);

		await reconcileSessionPersona(created, { buildHooks: () => ({ apply: async () => {} }) });

		expect(created.getPersonaRuntime()!.policy.isPersonaActive()).toBe(true);
		expect(created.getPersonaAppendPrompt()).toContain("fixture reader persona");
	});

	// The counterpart of fwULw: after resuming an `agent -> plan` journal the
	// user can unwind the outer mode AND then explicitly exit the persona,
	// producing CONSECUTIVE `none` markers. The first one unwinds the
	// transparent plan marker; the second has nothing left to unwind and IS the
	// persona exit — treating every `none` under a persona as transparent would
	// keep a persona the user explicitly left.
	it("a second consecutive `none` ends the persona", async () => {
		const manager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions"));
		manager.appendMessage({ role: "user", content: "turn", timestamp: Date.now() });
		manager.appendModeChange("agent", { name: "fixture-reader" });
		manager.appendModeChange("plan", { planFilePath: "local://PLAN.md" });
		// Outer-mode exit, then the explicit persona exit on top of it.
		manager.appendModeChange("none");
		manager.appendModeChange("none");
		await manager.ensureOnDisk();
		await manager.flush();

		await writeFixtureAgent();
		const created = createSession(manager);

		await reconcileSessionPersona(created, { buildHooks: () => ({ apply: async () => {} }) });

		expect(created.getPersonaRuntime()!.policy.isPersonaActive()).toBe(false);
	});

	// An explicit `/agent` exit (`clearPersonaJournalEntry`) appends `none`
	// while NO persona runs anymore: that marker must still end the persona.
	it("an explicit `none` with no persona underneath still clears it", async () => {
		const manager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions"));
		manager.appendMessage({ role: "user", content: "turn", timestamp: Date.now() });
		manager.appendModeChange("agent", { name: "fixture-reader" });
		manager.appendModeChange("none");
		await manager.ensureOnDisk();
		await manager.flush();

		await writeFixtureAgent();
		const created = createSession(manager);

		await reconcileSessionPersona(created, { buildHooks: () => ({ apply: async () => {} }) });

		expect(created.getPersonaRuntime()!.policy.isPersonaActive()).toBe(false);
		expect(created.getPersonaAppendPrompt()).toBeUndefined();
	});

	// fwULv regression: when the journal ends `agent -> plan` and the persona
	// definition was DELETED, the gone-persona degrade must not overwrite the
	// transparent outer-mode marker with `none` — buildSessionContext() treats
	// the LAST mode_change as authoritative, so appending `none` would lose the
	// plan state. The clear marker lands only when `agent` is already the mode
	// tail; the gone notice still fires and the runtime persona still exits.
	it("gone-persona degrade preserves a transparent outer-mode tail", async () => {
		const manager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions"));
		manager.appendMessage({ role: "user", content: "turn", timestamp: Date.now() });
		manager.appendModeChange("agent", { name: "evaporated-persona" });
		manager.appendModeChange("plan", { planFilePath: "local://PLAN.md" });
		await manager.ensureOnDisk();
		await manager.flush();

		// No agent file written: the persona definition was deleted pre-resume.
		const created = createSession(manager);
		const gone: string[] = [];

		await reconcileSessionPersona(created, {
			buildHooks: () => ({ apply: async () => {} }),
			onGone: (_session, name) => {
				gone.push(name);
			},
		});

		// The degrade still ran...
		expect(gone).toEqual(["evaporated-persona"]);
		expect(created.getPersonaRuntime()!.policy.isPersonaActive()).toBe(false);
		// ...but the transparent outer-mode marker stays the mode tail: the
		// plan state survives into the next resume.
		const modes = manager
			.getEntries()
			.filter(entry => entry.type === "mode_change")
			.map(entry => (entry as { mode: string }).mode);
		expect(modes.at(-1)).toBe("plan");
		expect(manager.buildSessionContext().mode).toBe("plan");
	});

	// fwULu regression: a persona-active RUNTIME (retained across an
	// in-process switch) reconciling into ANOTHER persisted persona with a
	// different `explicit.tools` ceiling must not stay governed by the TARGET
	// ceiling when the transaction FAILS — the ceiling is replaced BEFORE
	// discovery and the fallible transaction, and the PolicySnapshot rollback
	// deliberately does not restore cliGrant. The catch branch must reinstate
	// the ceiling the rolled-back SOURCE persona carries.
	it("a failed reconcile-to-another-persona restores the source's journal ceiling", async () => {
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
		// Source session: reader persona ACTIVE in the live runtime (like a
		// persona-active source switching in-process to another persona
		// session whose journal records the wide persona + its ceiling).
		const sourceManager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions"));
		sourceManager.appendMessage({ role: "user", content: "source turn", timestamp: Date.now() });
		sourceManager.appendModeChange("agent", { name: "fixture-reader", explicit: { tools: ["read"] } });
		await sourceManager.ensureOnDisk();
		await sourceManager.flush();
		const created = createSession(sourceManager);
		const runtime = created.getPersonaRuntime()!;
		await runtime.reconcile(
			{ agent: { name: "fixture-reader", description: "", systemPrompt: "", tools: ["read"], source: "bundled" } },
			{ apply: async () => {} },
		);
		expect(runtime.policy.isPersonaActive()).toBe(true);
		runtime.policy.installJournalCeiling(["read"]);
		expect([...(created.getToolPolicy()!.cliGrant ?? [])]).toEqual(["read"]);

		// TARGET journal: wide persona with the [read, write] ceiling. The
		// switch lands the manager on it, then the reconcile runs.
		const targetManager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions"));
		targetManager.appendMessage({ role: "user", content: "target turn", timestamp: Date.now() });
		targetManager.appendModeChange("agent", { name: "fixture-wide", explicit: { tools: ["read", "write"] } });
		await targetManager.ensureOnDisk();
		await targetManager.flush();
		const targetFile = targetManager.getSessionFile();
		if (!targetFile) throw new Error("Expected target session file");
		await targetManager.close();
		await created.sessionManager.setSessionFile(targetFile);

		// Sabotage the presentation apply (the channel a failing presentation
		// apply exercises in production): discovery succeeds, the transaction
		// FAILS, the runtime rolls back to fixture-reader.
		const presentationSpy = vi.spyOn(created, "setActiveToolPresentation").mockImplementationOnce(async () => {
			throw new Error("apply veto");
		});
		await reconcileSessionPersona(created, { buildHooks: () => ({ apply: async () => {} }) });
		presentationSpy.mockRestore();

		// The runtime rolled back to the SOURCE persona, and the ceiling must
		// roll back with it: [read], not the target's [read, write].
		expect(runtime.policy.isPersonaActive()).toBe(true);
		expect(runtime.policy.snapshot().persona?.agent.name).toBe("fixture-reader");
		expect([...(created.getToolPolicy()!.cliGrant ?? [])]).toEqual(["read"]);
	});

	// The exit direction of the same contract: when the persona-less branch of
	// reconcileSessionPersona clears the journal ceiling and then FAILS to roll
	// the runtime off the persona, the rolled-back persona must get its ceiling
	// back. The clear runs before the fallible transaction, and the runtime's
	// PolicySnapshot rollback deliberately does not restore cliGrant — without
	// the catch reinstating it, a still-active persona is left unrestricted.
	it("a failed persona-less reconcile restores the ceiling the rolled-back persona carries", async () => {
		await writeFixtureAgent(READER_AGENT_MD);
		const sourceManager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions"));
		sourceManager.appendMessage({ role: "user", content: "source turn", timestamp: Date.now() });
		sourceManager.appendModeChange("agent", { name: "fixture-reader", explicit: { tools: ["read"] } });
		await sourceManager.ensureOnDisk();
		await sourceManager.flush();
		const created = createSession(sourceManager);
		const runtime = created.getPersonaRuntime()!;
		await runtime.reconcile(
			{ agent: { name: "fixture-reader", description: "", systemPrompt: "", tools: ["read"], source: "bundled" } },
			{ apply: async () => {} },
		);
		expect(runtime.policy.isPersonaActive()).toBe(true);
		runtime.policy.installJournalCeiling(["read"]);
		expect([...(created.getToolPolicy()!.cliGrant ?? [])]).toEqual(["read"]);

		// Persona-less journal: no `agent` entry, so reconcile targets NO persona
		// and clears the ceiling first.
		const plainManager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions"));
		plainManager.appendMessage({ role: "user", content: "plain turn", timestamp: Date.now() });
		await plainManager.ensureOnDisk();
		await plainManager.flush();
		const plainFile = plainManager.getSessionFile();
		if (!plainFile) throw new Error("Expected plain session file");
		await plainManager.close();
		await created.sessionManager.setSessionFile(plainFile);

		// Sabotage the roll-off: the transaction fails and the runtime rolls back
		// to the still-active persona.
		const presentationSpy = vi.spyOn(created, "setActiveToolPresentation").mockImplementationOnce(async () => {
			throw new Error("apply veto");
		});
		await reconcileSessionPersona(created, { buildHooks: () => ({ apply: async () => {} }) });
		presentationSpy.mockRestore();

		// Rolled back INTO the persona, so its ceiling must still govern it.
		expect(runtime.policy.isPersonaActive()).toBe(true);
		expect([...(created.getToolPolicy()!.cliGrant ?? [])]).toEqual(["read"]);
	});
});
