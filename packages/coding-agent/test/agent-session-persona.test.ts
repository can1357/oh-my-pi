import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { Effort } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRunner, loadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import type { HookCommandContext } from "@oh-my-pi/pi-coding-agent/extensibility/hooks/types";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import { TempDir } from "@oh-my-pi/pi-utils";

/** Minimal AgentDefinition for persona tests — only the fields applyAgentPersona reads. */
function makePersona(name: string, systemPrompt: string, order?: number): AgentDefinition {
	return {
		name,
		description: `${name} agent`,
		systemPrompt,
		mode: "primary",
		order,
		source: "user" as const,
		tools: [],
	};
}

describe("AgentSession persona swap", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	const authStorages: AuthStorage[] = [];

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-persona-");
	});

	afterEach(async () => {
		if (session) await session.dispose();
		for (const as of authStorages.splice(0)) as.close();
		tempDir.removeSync();
	});

	async function createSession(globalBlocks: string[] = ["global-block"]) {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("claude-sonnet-4-5 not found in bundled models");
		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: globalBlocks,
				tools: [],
				messages: [],
				thinkingLevel: Effort.Low,
			},
		});
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			modelRegistry,
		});
	}

	it("starts with no active persona", async () => {
		await createSession();
		expect(session.activePersonaName).toBeNull();
	});

	it("applyAgentPersona sets system prompt to globalBlocks + HOW block", async () => {
		await createSession(["global-a", "global-b"]);
		const persona = makePersona("sisyphus", "HOW-sisyphus");

		await session.applyAgentPersona(persona);

		expect(session.systemPrompt).toEqual(["global-a", "global-b", "HOW-sisyphus"]);
	});

	it("applyAgentPersona sets activePersonaName", async () => {
		await createSession();
		await session.applyAgentPersona(makePersona("beta", "HOW-beta"));
		expect(session.activePersonaName).toBe("beta");
	});

	it("switching persona replaces HOW block, keeps global blocks", async () => {
		await createSession(["global"]);
		await session.applyAgentPersona(makePersona("sisyphus", "HOW-sisyphus"));
		await session.applyAgentPersona(makePersona("beta", "HOW-beta"));

		expect(session.systemPrompt).toEqual(["global", "HOW-beta"]);
		expect(session.activePersonaName).toBe("beta");
	});

	it("applyAgentPersona(null) resets to global blocks only", async () => {
		await createSession(["global"]);
		await session.applyAgentPersona(makePersona("sisyphus", "HOW-sisyphus"));
		await session.applyAgentPersona(null);

		expect(session.systemPrompt).toEqual(["global"]);
		expect(session.activePersonaName).toBeNull();
	});
	it("globalBlocks stays in sync with rebuilt prompt so persona swap uses current base (C1)", async () => {
		// Construct session with a rebuildSystemPrompt that returns an expanded base
		// (simulates what happens when MCP servers connect mid-session)
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("claude-sonnet-4-5 not found in bundled models");
		const agent = new Agent({
			initialState: { model, systemPrompt: ["initial"], tools: [], messages: [], thinkingLevel: Effort.Low },
		});
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth-c1.db"));
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models-c1.yml"));
		// Simulates a tool rebuild that adds MCP tool instructions to the base prompt
		const expandedBase = ["initial", "mcp-tool-instructions"];
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			modelRegistry,
			rebuildSystemPrompt: async () => ({ systemPrompt: expandedBase }),
		});

		// Load initial persona
		await session.applyAgentPersona(makePersona("sisyphus", "HOW-sisyphus"));
		expect(session.systemPrompt).toEqual(["initial", "HOW-sisyphus"]);

		// Simulate MCP tool discovery / tool rebuild
		await session.refreshBaseSystemPrompt();
		expect(session.systemPrompt).toEqual(["initial", "mcp-tool-instructions", "HOW-sisyphus"]);

		// Switch to a different persona.
		// C1 regression: if #globalBlocks was not updated at refresh, applyAgentPersona
		// would reconstruct from the stale ["initial"] snapshot, producing
		// ["initial", "HOW-beta"] — dropping the MCP tool instructions.
		await session.applyAgentPersona(makePersona("beta", "HOW-beta"));
		expect(session.systemPrompt).toEqual(["initial", "mcp-tool-instructions", "HOW-beta"]);
	});
});

describe("applyAgentPersona — model behavior", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	const authStorages: AuthStorage[] = [];

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-persona-model-");
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		if (session) await session.dispose();
		for (const as of authStorages.splice(0)) as.close();
		tempDir.removeSync();
	});

	async function createSession() {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("claude-sonnet-4-5 not found in bundled models");
		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["global-block"],
				tools: [],
				messages: [],
				thinkingLevel: Effort.Low,
			},
		});
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			modelRegistry,
		});
	}

	it("applies the first resolvable model from the persona's model list", async () => {
		await createSession();
		const persona = { ...makePersona("beta", "HOW-beta"), model: ["anthropic/claude-opus-4-5"] };

		const result = await session.applyAgentPersona(persona);

		expect(result).toEqual({});
		expect(session.model?.id).toBe("claude-opus-4-5");
	});

	it("returns { modelFailed } and keeps current model when applyRoleModel throws", async () => {
		await createSession();
		const originalModelId = session.model?.id;
		vi.spyOn(session, "applyRoleModel").mockRejectedValue(new Error("forced failure"));
		const persona = { ...makePersona("beta", "HOW-beta"), model: ["anthropic/claude-sonnet-4-5"] };

		const result = await session.applyAgentPersona(persona);

		expect(typeof result.modelFailed).toBe("string");
		// Persona HOW block still applies despite model failure
		expect(session.activePersonaName).toBe("beta");
		// Model is unchanged
		expect(session.model?.id).toBe(originalModelId);
	});

	it("records model_change entry for user-initiated cycle (default recordModelChange)", async () => {
		await createSession();
		const persona = { ...makePersona("beta", "HOW-beta"), model: ["anthropic/claude-sonnet-4-5"] };

		await session.applyAgentPersona(persona);

		const branch = session.sessionManager.getBranch();
		const modelEntries = branch.filter(e => e.type === "model_change");
		expect(modelEntries.length).toBeGreaterThan(0);
	});

	it("does NOT record model_change in restore mode (silent restoration)", async () => {
		await createSession();
		const originalModelId = session.model?.id;
		const persona = { ...makePersona("beta", "HOW-beta"), model: ["anthropic/claude-sonnet-4-5"] };

		await session.applyAgentPersona(persona, { mode: "restore" });

		expect(session.model?.id).toBe(originalModelId);
		const branch = session.sessionManager.getBranch();
		const modelEntries = branch.filter(e => e.type === "model_change");
		expect(modelEntries).toHaveLength(0);
	});

	it("does NOT record thinking_level_change in restore mode", async () => {
		await createSession();
		// :high gives explicitThinkingLevel: true; initial session level is Effort.Low so it
		// WOULD change under "cycle" mode — "restore" must leave it untouched and unrecorded.
		const persona = { ...makePersona("beta", "HOW-beta"), model: ["anthropic/claude-sonnet-4-5:high"] };

		await session.applyAgentPersona(persona, { mode: "restore" });

		const branch = session.sessionManager.getBranch();
		const thinkingEntries = branch.filter(e => e.type === "thinking_level_change");
		expect(thinkingEntries).toHaveLength(0);
	});

	it("returns { modelFailed } when no model in the list can be resolved", async () => {
		await createSession();
		const originalModelId = session.model?.id;
		// Use a model string that will never match any available model (bad provider/id).
		const persona = { ...makePersona("beta", "HOW-beta"), model: ["nonexistent-provider/nonexistent-model-xyz"] };

		const result = await session.applyAgentPersona(persona);

		// modelFailed must be set even though no exception was thrown — the model just
		// couldn't be resolved from the registry.
		expect(typeof result.modelFailed).toBe("string");
		// Persona HOW block still applies.
		expect(session.activePersonaName).toBe("beta");
		// Model is unchanged.
		expect(session.model?.id).toBe(originalModelId);
	});

	it("continues past an unresolvable first model candidate to a resolvable second candidate", async () => {
		await createSession();
		// First entry never matches any available model; second is a valid bundled
		// model. The loop must not stop at the first unresolvable candidate.
		const persona = {
			...makePersona("beta", "HOW-beta"),
			model: ["nonexistent-provider/nonexistent-model-xyz", "anthropic/claude-opus-4-5"],
		};

		const result = await session.applyAgentPersona(persona);

		expect(result).toEqual({});
		expect(session.model?.id).toBe("claude-opus-4-5");
	});

	it("continues past a throwing applyRoleModel call to a resolvable second candidate without reporting modelFailed", async () => {
		await createSession();
		// Spy on the real instance method so only the first invocation rejects;
		// the second call falls through to the real implementation (no full mock
		// of applyAgentPersona/applyRoleModel), proving the loop actually retries
		// rather than aborting on the first failure.
		vi.spyOn(session, "applyRoleModel").mockRejectedValueOnce(new Error("forced failure"));
		const persona = {
			...makePersona("beta", "HOW-beta"),
			model: ["anthropic/claude-sonnet-4-5", "anthropic/claude-opus-4-5"],
		};

		const result = await session.applyAgentPersona(persona);

		expect(result).toEqual({});
		expect(session.model?.id).toBe("claude-opus-4-5");
	});

	it("resolves a bare pi/default alias to the session's active model, not the configured default (session-inherit parity with spawned agents)", async () => {
		// Settings.isolated() with no modelRoles override — configured default is
		// unset, so pre-fix resolution of "pi/default" via resolveModelRoleValue
		// (role→settings.getModelRole("default")→undefined→resolveConfiguredRolePattern
		// returns []) failed outright even though the session was already on a
		// perfectly valid model.
		await createSession();
		await session.setModel(getBundledModel("anthropic", "claude-opus-4-5")!, "default");
		const persona = { ...makePersona("beta", "HOW-beta"), model: ["pi/default"] };

		const result = await session.applyAgentPersona(persona);

		expect(result).toEqual({});
		// Inherited the session's active model (opus) — did not fail, and did not
		// snap to some unrelated configured default.
		expect(session.model?.id).toBe("claude-opus-4-5");
	});

	it("resolves a bare pi/task alias to the session's active model when no task role is configured", async () => {
		// Same bug as pi/default, on the "task" role: MODEL_PRIO has no "task"
		// entry, so pre-fix resolution failed outright instead of inheriting the
		// active model the way a spawned agent's `model: pi/task` would.
		await createSession();
		await session.setModel(getBundledModel("anthropic", "claude-opus-4-5")!, "default");
		const persona = { ...makePersona("beta", "HOW-beta"), model: ["pi/task"] };

		const result = await session.applyAgentPersona(persona);

		expect(result).toEqual({});
		expect(session.model?.id).toBe("claude-opus-4-5");
	});

	it("an explicitly configured task role still wins over the active model for pi/task", async () => {
		// Session-inherit is a fallback, not a hard override: when the user
		// configured modelRoles.task explicitly, that configuration must still
		// take precedence — matches resolveAgentModelPatterns()'s own contract
		// (configured patterns win unless the pattern is the bare inherited alias
		// with nothing configured).
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("claude-sonnet-4-5 not found in bundled models");
		const agent = new Agent({
			initialState: { model, systemPrompt: ["global-block"], tools: [], messages: [], thinkingLevel: Effort.Low },
		});
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ modelRoles: { task: "anthropic/claude-haiku-4-5" } }),
			modelRegistry,
		});
		await session.setModel(getBundledModel("anthropic", "claude-opus-4-5")!, "default");
		const persona = { ...makePersona("beta", "HOW-beta"), model: ["pi/task"] };

		const result = await session.applyAgentPersona(persona);

		expect(result).toEqual({});
		// Configured task role (haiku) wins, NOT the active model (opus).
		expect(session.model?.id).toBe("claude-haiku-4-5");
	});
});

// Tested by Sisyphus — 2026-07-08
describe("applyAgentPersona — fresh mode across persona identity", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	const authStorages: AuthStorage[] = [];

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-persona-fresh-");
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		if (session) await session.dispose();
		for (const as of authStorages.splice(0)) as.close();
		tempDir.removeSync();
	});

	async function createSession() {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("claude-sonnet-4-5 not found in bundled models");
		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["global-block"],
				tools: [],
				messages: [],
				thinkingLevel: Effort.Low,
			},
		});
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			modelRegistry,
		});
	}

	it("fresh mode re-applies the resolved persona's own model when the persona identity changed since the last apply", async () => {
		await createSession();
		const sisyphus = { ...makePersona("sisyphus", "HOW-sisyphus"), model: ["anthropic/claude-sonnet-4-5"] };
		const beta = { ...makePersona("beta", "HOW-beta"), model: ["anthropic/claude-opus-4-5"] };

		// Startup: load default persona (sisyphus).
		await session.applyAgentPersona(sisyphus);
		// Tab-cycle to beta.
		await session.applyAgentPersona(beta);
		expect(session.model?.id).toBe("claude-opus-4-5");

		// /new always resolves back to the default persona (sisyphus) via mode: "fresh".
		await session.applyAgentPersona(sisyphus, { mode: "fresh" });

		// Must NOT stay on beta's model — sisyphus's own frontmatter model applies.
		expect(session.model?.id).toBe("claude-sonnet-4-5");
		expect(session.activePersonaName).toBe("sisyphus");
	});

	it("fresh mode leaves the active model untouched when /new resolves back to the SAME persona that was already active", async () => {
		await createSession();
		const sisyphus = { ...makePersona("sisyphus", "HOW-sisyphus"), model: ["anthropic/claude-sonnet-4-5"] };

		await session.applyAgentPersona(sisyphus);
		// Simulate a manual /model override while staying on the same persona.
		await session.setModel(getBundledModel("anthropic", "claude-opus-4-5")!, "default");
		expect(session.model?.id).toBe("claude-opus-4-5");

		// /new resolves to the SAME persona (sisyphus) — the manual override must survive.
		await session.applyAgentPersona(sisyphus, { mode: "fresh" });

		expect(session.model?.id).toBe("claude-opus-4-5");
		expect(session.activePersonaName).toBe("sisyphus");
	});

	it("fresh mode applies the resolved persona's frontmatter thinking level when persona identity changed", async () => {
		await createSession(); // initial thinkingLevel is Effort.Low per createSession()'s Agent initialState
		const sisyphus = {
			...makePersona("sisyphus", "HOW-sisyphus"),
			model: ["anthropic/claude-sonnet-4-5"],
			thinkingLevel: Effort.High,
		};
		const beta = { ...makePersona("beta", "HOW-beta"), model: ["anthropic/claude-opus-4-5"] };

		await session.applyAgentPersona(sisyphus);
		expect(session.thinkingLevel).toBe(Effort.High);

		await session.applyAgentPersona(beta);
		// beta has no thinkingLevel field — cycling to it must not force a level of its own,
		// but it also doesn't need to reset it for this test; just move on to sisyphus again.

		await session.applyAgentPersona(sisyphus, { mode: "fresh" });

		expect(session.thinkingLevel).toBe(Effort.High);
		expect(session.activePersonaName).toBe("sisyphus");
	});
});
describe("applyAgentPersona — /agents override exclusivity", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	const authStorages: AuthStorage[] = [];

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-persona-override-");
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		if (session) await session.dispose();
		for (const as of authStorages.splice(0)) as.close();
		tempDir.removeSync();
	});

	async function createSessionWithOverride(agentName: string, overrideModel: string) {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("claude-sonnet-4-5 not found in bundled models");
		const agent = new Agent({
			initialState: { model, systemPrompt: ["global"], tools: [], messages: [], thinkingLevel: Effort.Low },
		});
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "task.agentModelOverrides": { [agentName]: overrideModel } }),
			modelRegistry,
		});
	}

	it("does not fall through to frontmatter when /agents override fails to resolve", async () => {
		// Override is present but bogus — frontmatter model is real and would succeed.
		// The override must be treated as exclusive so the fallback never fires silently.
		await createSessionWithOverride("beta", "nonexistent-provider/nonexistent-model");
		const originalModelId = session.model?.id;
		const persona = {
			...makePersona("beta", "HOW-beta"),
			// Real model — would resolve if the loop continued past the override.
			model: ["anthropic/claude-opus-4-5"],
		};

		const result = await session.applyAgentPersona(persona);

		// Override failed → modelFailed must be set.
		expect(typeof result.modelFailed).toBe("string");
		// Persona HOW block still applied.
		expect(session.activePersonaName).toBe("beta");
		// Model unchanged — did NOT fall through to the frontmatter candidate.
		expect(session.model?.id).toBe(originalModelId);
	});

	it("applies /agents override when it resolves, ignoring frontmatter model", async () => {
		// Both override and frontmatter are real models; override should win.
		await createSessionWithOverride("beta", "anthropic/claude-opus-4-5");
		const persona = {
			...makePersona("beta", "HOW-beta"),
			model: ["anthropic/claude-sonnet-4-5"],
		};

		const result = await session.applyAgentPersona(persona);

		expect(result).toEqual({});
		// Override model applied, not the frontmatter model.
		expect(session.model?.id).toBe("claude-opus-4-5");
	});
});

describe("newSession — model recording", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	const authStorages: AuthStorage[] = [];

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-new-session-");
	});

	afterEach(async () => {
		if (session) await session.dispose();
		for (const as of authStorages.splice(0)) as.close();
		tempDir.removeSync();
	});

	it("records current model in new session branch so resume can restore it", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("claude-sonnet-4-5 not found in bundled models");
		const agent = new Agent({
			initialState: { model, systemPrompt: ["global"], tools: [], messages: [], thinkingLevel: Effort.Low },
		});
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			modelRegistry,
		});

		// Switch to a different model to simulate the "carry-over after persona switch" scenario.
		const opusModel = getBundledModel("anthropic", "claude-opus-4-5");
		if (!opusModel) throw new Error("claude-opus-4-5 not found in bundled models");
		await session.setModel(opusModel, "default");
		expect(session.model?.id).toBe("claude-opus-4-5");

		await session.newSession();

		// The new session branch must contain a model_change entry so resume can
		// restore claude-opus-4-5 rather than defaulting to startup state.
		const branch = session.sessionManager.getBranch();
		const modelEntries = branch.filter(e => e.type === "model_change") as Array<{ model: string }>;
		expect(modelEntries.length).toBeGreaterThan(0);
		const recorded = modelEntries[modelEntries.length - 1].model;
		expect(recorded).toBe("anthropic/claude-opus-4-5");
	});
});

describe("newSession — fresh persona model warning", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	const authStorages: AuthStorage[] = [];

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-new-session-persona-warn-");
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		if (session) await session.dispose();
		for (const as of authStorages.splice(0)) as.close();
		tempDir.removeSync();
	});

	it("surfaces a visible warning when /new resolves to a default persona whose model can't be resolved", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("claude-sonnet-4-5 not found in bundled models");
		const agent = new Agent({
			initialState: { model, systemPrompt: ["global"], tools: [], messages: [], thinkingLevel: Effort.Low },
		});
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		// The default persona's own model can never resolve — matches the
		// review scenario: outgoing persona is "beta" on a resolvable model,
		// /new falls back to a default persona ("alpha") whose model is bogus.
		const alpha = { ...makePersona("alpha", "HOW-alpha"), model: ["nonexistent-provider/nonexistent-model-xyz"] };
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			modelRegistry,
			resolvePersona: async () => alpha,
		});
		await session.applyAgentPersona({ ...makePersona("beta", "HOW-beta"), model: ["anthropic/claude-sonnet-4-5"] });
		expect(session.activePersonaName).toBe("beta");

		const noticeSpy = vi.spyOn(session, "emitNotice");
		await session.newSession();

		// Persona prompt switches to alpha despite the model failure...
		expect(session.activePersonaName).toBe("alpha");
		// ...but the model silently stayed on beta's resolvable model instead of
		// alpha's advertised (unresolvable) one — that silent retention is exactly
		// what the visible warning below must call out.
		expect(session.model?.id).toBe("claude-sonnet-4-5");
		expect(noticeSpy).toHaveBeenCalledWith(
			"warning",
			expect.stringContaining('Persona "alpha" loaded — model not available, using current model'),
		);
	});
});

describe("custom command context — activePersonaName liveness", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	const authStorages: AuthStorage[] = [];

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-custom-command-persona-");
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		if (session) await session.dispose();
		for (const as of authStorages.splice(0)) as.close();
		tempDir.removeSync();
	});

	it("ctx.activePersonaName in a custom command reflects a persona switch that happens mid-handler", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("claude-sonnet-4-5 not found in bundled models");
		const agent = new Agent({
			initialState: { model, systemPrompt: ["global"], tools: [], messages: [], thinkingLevel: Effort.Low },
		});
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));

		const { promise: gate, resolve: releaseGate } = Promise.withResolvers<void>();
		let duringName: string | null | undefined;
		let afterName: string | null | undefined;
		const command = {
			path: "/virtual/check.ts",
			resolvedPath: "/virtual/check.ts",
			source: "user" as const,
			command: {
				name: "check",
				description: "test command",
				execute: async (_args: string[], ctx: HookCommandContext) => {
					const persona = ctx as unknown as { activePersonaName: string | null };
					duringName = persona.activePersonaName;
					await gate;
					afterName = persona.activePersonaName;
					return undefined;
				},
			},
		};

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			modelRegistry,
			customCommands: [command],
		});
		await session.applyAgentPersona(makePersona("alpha", "HOW-alpha"));

		const promptDone = session.prompt("/check");
		// Let the handler's synchronous prefix run and park on `gate`.
		await Promise.resolve();
		await Promise.resolve();
		expect(duringName).toBe("alpha");

		// Switch persona while the handler is parked mid-flight, then release it.
		await session.applyAgentPersona(makePersona("beta", "HOW-beta"));
		releaseGate();
		await promptDone;

		expect(afterName).toBe("beta");
	});
});

// Regression coverage for the SessionTools/AgentSession field split
// (upstream commit 7eeaba047 extracted system-prompt assembly into
// `SessionTools`): `applyAgentPersona()` correctly primes `#personaBlock` and
// the agent's system prompt once, but SessionTools owns three independent
// `setSystemPrompt()` rebuild call sites (tool-set change, model/edit-mode
// change, and the per-turn `buildSystemPromptForAgentStart` rebuild that runs
// before every single turn) — none of which know the persona feature exists.
// Every test below asserts the HOW block survives past the *next*
// SessionTools-triggered rebuild, not just the moment applyAgentPersona() ran.
describe("applyAgentPersona — persona block survives SessionTools-triggered rebuilds", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	const authStorages: AuthStorage[] = [];

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-persona-rebuild-");
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		if (session) await session.dispose();
		for (const as of authStorages.splice(0)) as.close();
		tempDir.removeSync();
	});

	async function createDeps() {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("claude-sonnet-4-5 not found in bundled models");
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		return { model, modelRegistry };
	}

	function createReadTool(): AgentTool {
		return {
			name: "read",
			label: "read",
			description: "read tool",
			parameters: type({}),
			async execute() {
				return { content: [{ type: "text" as const, text: "read" }] };
			},
		};
	}

	it("survives a tool-set-changing action (setActiveToolPresentation)", async () => {
		const { model, modelRegistry } = await createDeps();
		const readTool = createReadTool();
		const agent = new Agent({
			initialState: { model, systemPrompt: ["initial"], tools: [], messages: [], thinkingLevel: Effort.Low },
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			modelRegistry,
			toolRegistry: new Map([["read", readTool]]),
			builtInToolNames: ["read"],
			rebuildSystemPrompt: async toolNames => ({ systemPrompt: [`tools:${toolNames.sort().join(",")}`] }),
		});

		await session.applyAgentPersona(makePersona("sisyphus", "HOW-sisyphus"));
		expect(session.systemPrompt).toEqual(["initial", "HOW-sisyphus"]);

		await session.setActiveToolPresentation(["read"], []);

		// The tool-set rebuild replaced the base ("initial" -> "tools:read");
		// the persona's HOW block must still be the last thing in the prompt,
		// not silently dropped by SessionTools' persona-agnostic rebuild.
		expect(session.systemPrompt).toEqual(["tools:read", "HOW-sisyphus"]);
		expect(session.activePersonaName).toBe("sisyphus");
	});

	it("survives a model-changing action (setModel)", async () => {
		const { model, modelRegistry } = await createDeps();
		const opus = getBundledModel("anthropic", "claude-opus-4-5");
		if (!opus) throw new Error("claude-opus-4-5 not found in bundled models");
		const agent = new Agent({
			initialState: { model, systemPrompt: ["initial"], tools: [], messages: [], thinkingLevel: Effort.Low },
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			modelRegistry,
			rebuildSystemPrompt: async () => ({ systemPrompt: ["rebuilt-for-new-model"] }),
		});

		await session.applyAgentPersona(makePersona("sisyphus", "HOW-sisyphus"));
		expect(session.systemPrompt).toEqual(["initial", "HOW-sisyphus"]);

		await session.setModel(opus, "default");

		expect(session.systemPrompt).toEqual(["rebuilt-for-new-model", "HOW-sisyphus"]);
		expect(session.activePersonaName).toBe("sisyphus");
	});

	it("survives a tool-set change AND a model change in the same session (acceptance contract)", async () => {
		const { model, modelRegistry } = await createDeps();
		const opus = getBundledModel("anthropic", "claude-opus-4-5");
		if (!opus) throw new Error("claude-opus-4-5 not found in bundled models");
		const readTool = createReadTool();
		const agent = new Agent({
			initialState: { model, systemPrompt: ["initial"], tools: [], messages: [], thinkingLevel: Effort.Low },
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			modelRegistry,
			toolRegistry: new Map([["read", readTool]]),
			builtInToolNames: ["read"],
			rebuildSystemPrompt: async toolNames => ({ systemPrompt: [`tools:${toolNames.sort().join(",")}`] }),
		});

		await session.applyAgentPersona(makePersona("sisyphus", "HOW-sisyphus"));
		expect(session.systemPrompt.at(-1)).toBe("HOW-sisyphus");

		await session.setActiveToolPresentation(["read"], []);
		expect(session.systemPrompt.at(-1)).toBe("HOW-sisyphus");
		expect(session.activePersonaName).toBe("sisyphus");

		await session.setModel(opus, "default");
		expect(session.systemPrompt.at(-1)).toBe("HOW-sisyphus");
		expect(session.activePersonaName).toBe("sisyphus");
	});

	it("survives a plain per-turn rebuild with no memory-backend or extension override (the live regression)", async () => {
		const { model, modelRegistry } = await createDeps();
		const mock = createMockModel({ responses: [{ content: ["ok"] }] });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["initial"], tools: [], messages: [] },
			streamFn: mock.stream,
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false, "memory.backend": "off" }),
			modelRegistry,
			// `buildSystemPromptForAgentStart` runs this on every turn even when
			// nothing else changed — reproduces the exact live regression where
			// this call site's result was force-applied without ever
			// re-appending the persona block.
			rebuildSystemPrompt: async () => ({ systemPrompt: ["initial"] }),
		});

		await session.applyAgentPersona(makePersona("sisyphus", "HOW-sisyphus"));
		expect(session.systemPrompt).toEqual(["initial", "HOW-sisyphus"]);

		await session.prompt("hello, who are you?");

		expect(session.systemPrompt).toEqual(["initial", "HOW-sisyphus"]);
		expect(session.activePersonaName).toBe("sisyphus");
		// The actual wire payload sent to the model must carry the HOW block too —
		// not just the session's own bookkeeping.
		expect(mock.calls[0]?.context.systemPrompt).toEqual(["initial", "HOW-sisyphus"]);
	});

	it("survives a memory-backend-style per-turn systemPrompt override from an extension", async () => {
		const { model, modelRegistry } = await createDeps();
		const sessionManager = SessionManager.inMemory();
		const extensionsResult = await loadExtensions([], tempDir.path());
		const extensionRunner = new ExtensionRunner(
			extensionsResult.extensions,
			extensionsResult.runtime,
			tempDir.path(),
			sessionManager,
			modelRegistry,
		);
		// Simulates a memory-backend-style (or any other) `before_agent_start`
		// handler that replaces the turn's system prompt wholesale — exactly
		// the shape SessionTools' own one-turn memory injection produces.
		vi.spyOn(extensionRunner, "emitBeforeAgentStart").mockResolvedValueOnce({
			systemPrompt: ["memory-injected-turn-prompt"],
		});
		vi.spyOn(extensionRunner, "emit").mockResolvedValue(undefined);

		const mock = createMockModel({ responses: [{ content: ["ok"] }] });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["initial"], tools: [], messages: [] },
			streamFn: mock.stream,
		});
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false, "memory.backend": "off" }),
			modelRegistry,
			extensionRunner,
		});

		await session.applyAgentPersona(makePersona("sisyphus", "HOW-sisyphus"));
		expect(session.systemPrompt).toEqual(["initial", "HOW-sisyphus"]);

		await session.prompt("hello");

		// The one-turn override must not silently strip the HOW block — both the
		// session's own state and the actual wire payload sent to the model must
		// still carry it, appended after the override content (not the stale
		// pre-override base).
		expect(session.systemPrompt).toEqual(["memory-injected-turn-prompt", "HOW-sisyphus"]);
		expect(session.activePersonaName).toBe("sisyphus");
		expect(mock.calls[0]?.context.systemPrompt).toEqual(["memory-injected-turn-prompt", "HOW-sisyphus"]);
	});
});
