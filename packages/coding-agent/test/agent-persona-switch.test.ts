/**
 * Live `/agent` persona switching: mutable session state (spawns + persona
 * prompt), the `/agent` slash-command spec, and `InteractiveMode.switchAgentPersona`
 * applying tools/model/thinking/spawns/prompt from a discovered agent definition
 * with a persisted `mode_change` entry (`mode: "agent"`, `data: { name }`).
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { Effort } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { CustomTool } from "@oh-my-pi/pi-coding-agent/extensibility/custom-tools/types";
import { createAcpSessionFactory } from "@oh-my-pi/pi-coding-agent/main";
import type { AcpSessionFactory } from "@oh-my-pi/pi-coding-agent/modes/acp/acp-mode";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import {
	type CreateAgentSessionOptions,
	type CreateAgentSessionResult,
	createAgentSession,
} from "@oh-my-pi/pi-coding-agent/sdk";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { executeAcpBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/acp-builtins";
import { BUILTIN_MODE_SLASH_COMMANDS } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-modes";
import type { SlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";
import { VIBE_TOOL_NAMES } from "@oh-my-pi/pi-coding-agent/tools/vibe";
import { VibeSessionRegistry } from "@oh-my-pi/pi-coding-agent/vibe/runtime";
import { TempDir } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../src/config/model-registry";
import { InteractiveMode } from "../src/modes/interactive-mode";
import { mainSessionTools } from "../src/task/agent-tools";

function makeTool(name: string): AgentTool {
	return {
		name,
		label: name,
		description: `Fake ${name}`,
		parameters: type({}),
		async execute() {
			return { content: [{ type: "text" as const, text: "ok" }] };
		},
	};
}

function agentMd(name: string, extraFrontmatter: string[] = []): string {
	return ["---", `name: ${name}`, `description: ${name}`, ...extraFrontmatter, "---", `You are ${name}.`].join("\n");
}

describe("AgentSession persona state", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-persona-state-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		Settings.instance.set("startup.quiet", true);
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const registry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled anthropic/claude-sonnet-4-5 to exist");
		const toolRegistry = new Map<string, AgentTool>();
		toolRegistry.set("read", makeTool("read"));
		session = new AgentSession({
			agent: new Agent({
				initialState: {
					model,
					systemPrompt: ["Test"],
					tools: [makeTool("read")],
					messages: [],
					thinkingLevel: Effort.Medium,
				},
			}),
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: registry,
			toolRegistry,
			builtInToolNames: ["read"],
		});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		session = undefined;
		resetSettingsForTest();
	});

	it("seeds the launch spawns and reads a cleared session as unrestricted", async () => {
		// Regression: `setSessionSpawns(null)` (persona cleared) must read as
		// unrestricted `"*"` — NOT fall back to the launch persona's spawns.
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled anthropic/claude-sonnet-4-5 to exist");
		const seeded = new AgentSession({
			agent: new Agent({
				initialState: {
					model,
					systemPrompt: ["Test"],
					tools: [makeTool("read")],
					messages: [],
					thinkingLevel: Effort.Medium,
				},
			}),
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: new ModelRegistry(authStorage, path.join(tempDir.path(), "models-seeded.yml")),
			toolRegistry: new Map([["read", makeTool("read")]]),
			builtInToolNames: ["read"],
			spawns: "scout",
		});
		try {
			expect(seeded.getSessionSpawns()).toBe("scout");
			seeded.setSessionSpawns(null);
			expect(seeded.getSessionSpawns()).toBeNull();
		} finally {
			await seeded.dispose();
		}
	});

	it("does not auto-add task for a persona with an explicit empty spawn list", () => {
		// `spawns: []` is the DISABLED policy (spawnsToString maps it to "",
		// which resolveSpawnPolicy treats as spawning disabled), so
		// advertising a `task` tool whose every invocation fails preflight
		// would be a lie. Omitted or "*" keeps the auto-include; a non-empty
		// list still adds `task` so the persona can spawn its agents.
		expect(mainSessionTools(["read"], [])).toEqual(["read"]);
		expect(mainSessionTools(["read"])).toEqual(["read"]);
		expect(mainSessionTools(["read"], "*")).toEqual(["read", "task"]);
		expect(mainSessionTools(["read"], ["scout"])).toEqual(["read", "task"]);
	});
});

describe("BUILTIN_MODE_SLASH_COMMANDS /agent", () => {
	it("registers /agent with allowArgs", () => {
		const spec = BUILTIN_MODE_SLASH_COMMANDS.find(command => command.name === "agent");
		expect(spec).toBeDefined();
		expect(spec?.allowArgs).toBe(true);
	});
});

describe("InteractiveMode.switchAgentPersona", () => {
	let tempHome: string;
	let projectDir: string;
	let authStorage: AuthStorage;
	let mode: InteractiveMode | undefined;
	let session: AgentSession | undefined;

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "omp-persona-switch-"));
		projectDir = path.join(tempHome, "project");
		await fs.mkdir(path.join(projectDir, ".omp", "agents"), { recursive: true });
		const agentsDir = path.join(projectDir, ".omp", "agents");
		await fs.writeFile(
			path.join(agentsDir, "persona-test.md"),
			agentMd("persona-test", [
				"tools: [read, write]",
				"model: anthropic/claude-haiku-4-5",
				"thinkingLevel: high",
				"spawns: [scout]",
			]),
		);
		await fs.writeFile(
			path.join(agentsDir, "persona-unresolvable.md"),
			agentMd("persona-unresolvable", ["model: nonexistent/model"]),
		);
		await fs.writeFile(path.join(agentsDir, "persona-subagent.md"), agentMd("persona-subagent", ["mode: subagent"]));
		await fs.writeFile(path.join(agentsDir, "persona-readonly.md"), agentMd("persona-readonly", ["tools: [read]"]));
		await fs.writeFile(path.join(agentsDir, "persona-minimal.md"), agentMd("persona-minimal"));
		await fs.writeFile(path.join(agentsDir, "persona-nospawn.md"), agentMd("persona-nospawn", ["spawns: []"]));

		await Settings.init({ inMemory: true, cwd: projectDir });
		Settings.instance.set("startup.quiet", true);
		authStorage = await AuthStorage.create(path.join(tempHome, "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		mode?.stop();
		await session?.dispose();
		authStorage?.close();
		await fs.rm(tempHome, { recursive: true, force: true });
		mode = undefined;
		session = undefined;
		VibeSessionRegistry.resetGlobalForTests();
		resetSettingsForTest();
	});

	function createHarness(settings: Settings, extraTools: string[] = []): InteractiveMode {
		const registry = new ModelRegistry(authStorage, path.join(tempHome, `models-${Bun.nanoseconds()}.yml`));
		const initialModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!initialModel) throw new Error("Expected bundled anthropic/claude-sonnet-4-5 to exist");
		const readTool = makeTool("read");
		const writeTool = makeTool("write");
		const bashTool = makeTool("bash");
		const toolRegistry = new Map<string, AgentTool>();
		toolRegistry.set(readTool.name, readTool);
		toolRegistry.set(writeTool.name, writeTool);
		toolRegistry.set(bashTool.name, bashTool);
		// Goal mode re-activates the `goal` tool on entry; register a stub so the
		// live /goal path can activate it (setActiveToolsByName drops unknown names).
		toolRegistry.set("goal", makeTool("goal"));
		// Optional extra registry entries (e.g. `task`) for tests exercising
		// spawn-surface strips; kept out of the default harness so existing
		// tool-set expectations stay exact.
		for (const name of extraTools) toolRegistry.set(name, makeTool(name));
		const manager = SessionManager.create(projectDir, path.join(tempHome, `active-${Bun.nanoseconds()}`));
		const createdSession = new AgentSession({
			agent: new Agent({
				initialState: {
					model: initialModel,
					systemPrompt: ["Test"],
					tools: [readTool],
					messages: [],
					thinkingLevel: Effort.Medium,
				},
			}),
			sessionManager: manager,
			settings,
			modelRegistry: registry,
			toolRegistry,
			builtInToolNames: ["read", "write", "bash"],
			createVibeTools: () => VIBE_TOOL_NAMES.map(name => makeTool(name)),
		});
		session = createdSession;
		mode = new InteractiveMode(createdSession, "test");
		return mode;
	}

	it("applies tools, model, thinking, spawns, and prompt from the agent definition", async () => {
		const created = createHarness(Settings.isolated({ "compaction.enabled": false }));
		await created.switchAgentPersona("persona-test");

		// The persona's `tools: [read, write]` is the EXACT active set — the
		// registry's bash tool (and any MCP/extension/memory tool) must NOT be
		// widened in (subagent restrictToolNames semantics).
		expect(session?.getEnabledToolNames()).toEqual(["read", "write"]);
		expect(session?.model?.id).toBe("claude-haiku-4-5");
		expect(session?.configuredThinkingLevel()).toBe(Effort.High);
		expect(session?.getSessionSpawns()).toBe("scout");
		expect(session?.getPersonaAppendPrompt()).toBe("You are persona-test.");

		const entries = session?.sessionManager.getEntries() ?? [];
		const modeChange = entries.find(
			(entry): entry is Extract<typeof entry, { type: "mode_change" }> =>
				entry.type === "mode_change" && entry.mode === "agent",
		);
		expect(modeChange).toBeDefined();
		expect(modeChange?.data).toEqual({ name: "persona-test" });
	});

	it("applies the model-suffix thinking level, not frontmatter thinkingLevel, on live switch", async () => {
		const created = createHarness(Settings.isolated({ "compaction.enabled": false }));
		await fs.writeFile(
			path.join(projectDir, ".omp", "agents", "persona-suffix.md"),
			agentMd("persona-suffix", ["model: anthropic/claude-sonnet-4-5:low", "thinkingLevel: high"]),
		);
		await created.switchAgentPersona("persona-suffix");

		// The `:low` suffix on the model pattern is the more specific selector
		// and wins over the frontmatter `thinkingLevel: high` — the same
		// precedence the launch path (`applyAgentPersonaOptions`) gives it.
		expect(session?.model?.id).toBe("claude-sonnet-4-5");
		expect(session?.configuredThinkingLevel()).toBe(Effort.Low);
	});

	it("applies frontmatter thinkingLevel when the model pattern has no thinking suffix", async () => {
		const created = createHarness(Settings.isolated({ "compaction.enabled": false }));
		await fs.writeFile(
			path.join(projectDir, ".omp", "agents", "persona-frontmatter.md"),
			agentMd("persona-frontmatter", ["model: anthropic/claude-sonnet-4-5", "thinkingLevel: high"]),
		);
		await created.switchAgentPersona("persona-frontmatter");

		expect(session?.model?.id).toBe("claude-sonnet-4-5");
		expect(session?.configuredThinkingLevel()).toBe(Effort.High);
	});

	it("applies frontmatter thinkingLevel when only a NON-selected fallback pattern carries a suffix", async () => {
		const created = createHarness(Settings.isolated({ "compaction.enabled": false }));
		await fs.writeFile(
			path.join(projectDir, ".omp", "agents", "persona-fallback-suffix.md"),
			agentMd("persona-fallback-suffix", [
				"model: [missing/model:low, anthropic/claude-haiku-4-5]",
				"thinkingLevel: high",
			]),
		);
		await created.switchAgentPersona("persona-fallback-suffix");

		// The `:low` suffix sits on a fallback pattern that does NOT resolve;
		// the SELECTED pattern (haiku) has no suffix, so the frontmatter
		// `thinkingLevel: high` applies — the any-suffix gate must not
		// suppress it (regression: the old check looked at every pattern).
		expect(session?.model?.id).toBe("claude-haiku-4-5");
		expect(session?.configuredThinkingLevel()).toBe(Effort.High);
	});

	it("deferred (streaming) persona switch lands on the frontmatter thinking level, not the model default", async () => {
		const created = createHarness(Settings.isolated({ "compaction.enabled": false }));
		// kimi-k3 carries `defaultLevel: max`; without the fix the deferred
		// flush re-applies it and clobbers the frontmatter `high`.
		authStorage.setRuntimeApiKey("moonshot", "test-key");
		await fs.writeFile(
			path.join(projectDir, ".omp", "agents", "persona-stream-frontmatter.md"),
			agentMd("persona-stream-frontmatter", ["model: moonshot/kimi-k3", "thinkingLevel: high"]),
		);
		// Mark the session mid-stream: the model switch is queued, not applied.
		Object.defineProperty(session!, "isStreaming", { configurable: true, get: () => true });
		await created.switchAgentPersona("persona-stream-frontmatter");
		// The frontmatter level applies immediately even while streaming.
		expect(session?.configuredThinkingLevel()).toBe(Effort.High);
		// Stream ends → the deferred switch flushes.
		Object.defineProperty(session!, "isStreaming", { configurable: true, get: () => false });
		await created.flushPendingModelSwitch();

		expect(session?.model?.id).toBe("kimi-k3");
		// The frontmatter `high` survives the deferred switch — the queued level
		// must be the effective persona level, not the model's defaultLevel (max).
		expect(session?.configuredThinkingLevel()).toBe(Effort.High);
	});

	it("deferred (streaming) persona switch keeps the model-suffix thinking level over frontmatter", async () => {
		const created = createHarness(Settings.isolated({ "compaction.enabled": false }));
		await fs.writeFile(
			path.join(projectDir, ".omp", "agents", "persona-stream-suffix.md"),
			agentMd("persona-stream-suffix", ["model: anthropic/claude-sonnet-4-5:low", "thinkingLevel: high"]),
		);
		Object.defineProperty(session!, "isStreaming", { configurable: true, get: () => true });
		await created.switchAgentPersona("persona-stream-suffix");
		// The suffix wins: the frontmatter `high` is NOT applied immediately
		// (the model switch itself is deferred, so the level lands on flush).
		Object.defineProperty(session!, "isStreaming", { configurable: true, get: () => false });
		await created.flushPendingModelSwitch();

		expect(session?.model?.id).toBe("claude-sonnet-4-5");
		// The `:low` suffix on the selected pattern wins over frontmatter `high`
		// even on the deferred path.
		expect(session?.configuredThinkingLevel()).toBe(Effort.Low);
	});

	it("keeps current model with a warning when the agent model pattern does not resolve", async () => {
		const created = createHarness(Settings.isolated({ "compaction.enabled": false }));
		const warning = vi.spyOn(created, "showWarning");
		await created.switchAgentPersona("persona-unresolvable");

		expect(session?.model?.id).toBe("claude-sonnet-4-5");
		expect(warning).toHaveBeenCalledWith(
			'Agent "persona-unresolvable" model pattern did not resolve; keeping current model.',
		);
		// The rest of the switch still applies and persists.
		expect(session?.getPersonaAppendPrompt()).toBe("You are persona-unresolvable.");
		const entries = session?.sessionManager.getEntries() ?? [];
		expect(entries.some(entry => entry.type === "mode_change" && entry.mode === "agent")).toBe(true);
	});

	it("keeps current tools/model/thinking when the agent omits those fields", async () => {
		const created = createHarness(Settings.isolated({ "compaction.enabled": false }));
		await created.switchAgentPersona("persona-minimal");

		expect(session?.getEnabledToolNames()).toEqual(["read"]);
		expect(session?.model?.id).toBe("claude-sonnet-4-5");
		expect(session?.configuredThinkingLevel()).toBeUndefined();
		expect(session?.getSessionSpawns()).toBe("*");
		expect(session?.getPersonaAppendPrompt()).toBe("You are persona-minimal.");
	});

	it("drops task for a spawns-disabled persona without a tools list, restores it when the persona is left", async () => {
		// A `spawns: []`-only persona (no `tools:`) leaves the normal top-level
		// baseline active — which includes `task` — while the disabled spawn
		// policy (`""`) makes every task invocation fail preflight. The live
		// switch must drop `task` for the persona's lifetime and restore it
		// (via the unrestricted baseline) when the persona is left.
		const created = createHarness(Settings.isolated({ "compaction.enabled": false }), ["task"]);
		await session!.setActiveToolsByName(["read", "task"]);
		expect(session?.getEnabledToolNames()).toEqual(["read", "task"]);

		await created.switchAgentPersona("persona-nospawn");
		expect(session?.getSessionSpawns()).toBe("");
		expect(session?.getEnabledToolNames()).toEqual(["read"]);
		// No persona tool restriction: the persona grants everything EXCEPT task.
		expect(session?.getPersonaToolRestriction()).toBeUndefined();

		// Leaving agent mode restores the pre-persona baseline — `task` returns.
		await session?.restoreBaselineTools();
		session?.setSessionSpawns(null);
		expect(session?.getEnabledToolNames()).toEqual(["read", "task"]);
	});

	it("rejects subagent-only agents", async () => {
		const created = createHarness(Settings.isolated({ "compaction.enabled": false }));
		const error = vi.spyOn(created, "showError");
		await created.switchAgentPersona("persona-subagent");

		expect(error).toHaveBeenCalledWith(
			'Agent "persona-subagent" is subagent-only and cannot be used as the main-session persona.',
		);
		expect(session?.getPersonaAppendPrompt()).toBeUndefined();
	});

	it("rejects unknown agents", async () => {
		const created = createHarness(Settings.isolated({ "compaction.enabled": false }));
		const error = vi.spyOn(created, "showError");
		await created.switchAgentPersona("does-not-exist");

		expect(error).toHaveBeenCalledWith("Unknown agent: does-not-exist");
	});

	it("rolls back all applied state when the model switch fails mid-apply", async () => {
		const created = createHarness(Settings.isolated({ "compaction.enabled": false }));
		const error = vi.spyOn(created, "showError");
		// First setModelTemporary (the apply) throws; the rollback call uses the real implementation.
		vi.spyOn(session!, "setModelTemporary").mockImplementationOnce(async () => {
			throw new Error("no API key");
		});
		await created.switchAgentPersona("persona-test");

		expect(error).toHaveBeenCalledWith(expect.stringContaining('Failed to switch to agent persona "persona-test"'));
		expect(session?.getEnabledToolNames()).toEqual(["read"]);
		expect(session?.model?.id).toBe("claude-sonnet-4-5");
		expect(session?.configuredThinkingLevel()).toBeUndefined();
		expect(session?.getSessionSpawns()).toBeNull();
		expect(session?.getPersonaAppendPrompt()).toBeUndefined();
		// No mode_change persisted on failure.
		const entries = session?.sessionManager.getEntries() ?? [];
		expect(entries.some(entry => entry.type === "mode_change" && entry.mode === "agent")).toBe(false);
	});

	it("clears the persona restriction when a switch fails mid-apply", async () => {
		// Regression (codex #3819553918): applyPersonaTools sets the live
		// persona restriction before setModelTemporary runs; a failed switch
		// must restore the pre-switch restriction so the failed persona's
		// tool list does not leak as a stale restriction that blocks MCP
		// refresh and suppresses prompt affordances on the rolled-back session.
		const created = createHarness(Settings.isolated({ "compaction.enabled": false }));
		expect(session?.getPersonaToolRestriction()).toBeUndefined();
		vi.spyOn(session!, "setModelTemporary").mockImplementationOnce(async () => {
			throw new Error("no API key");
		});
		await created.switchAgentPersona("persona-test");

		// The restriction must be cleared (restored to the pre-switch undefined),
		// not left as the failed persona's Set{'read','write'}.
		expect(session?.getPersonaToolRestriction()).toBeUndefined();

		// An MCP refresh on the rolled-back session must activate the connected
		// tool (no stale restriction filtering it out).
		const mcpTool: CustomTool = {
			name: "mcp__db_query",
			label: "db/query",
			description: "Query the database",
			parameters: type({}),
			mcpServerName: "db",
			mcpToolName: "query",
			async execute() {
				return { content: [{ type: "text", text: "ok" }] };
			},
		};
		await session!.refreshMCPTools([mcpTool]);
		expect(session?.getEnabledToolNames()).toEqual(["read", "mcp__db_query"]);
	});

	it("does not poison the baseline for a later successful switch when the first switch fails", async () => {
		// Regression (codex #3759764275): a failed FIRST live /agent switch used
		// to leave the first-write-only baseline populated with the failed
		// attempt's tool set. A later successful switch then no-ops on
		// setBaselineToolNames, and leaving agent mode restores the stale
		// failed-attempt tools instead of the real pre-persona set.
		const created = createHarness(Settings.isolated({ "compaction.enabled": false }));
		// First switch FAILS mid-apply (setModelTemporary throws); the rollback
		// call uses the real implementation.
		vi.spyOn(session!, "setModelTemporary").mockImplementationOnce(async () => {
			throw new Error("no API key");
		});
		await created.switchAgentPersona("persona-test");
		expect(session?.getEnabledToolNames()).toEqual(["read"]);

		// The failed attempt must NOT leave the baseline populated: the
		// first-write guard would otherwise keep the failed attempt's [read]
		// forever, even after the user changes tools.
		expect(session?.getBaselineToolNames()).toBeUndefined();
		expect(session?.getBaselineMountedToolNames()).toBeUndefined();

		// The user changes tools after the failure (e.g. enables bash).
		await session!.setActiveToolsByName(["read", "write", "bash"]);
		expect(session?.getEnabledToolNames()).toEqual(["read", "write", "bash"]);

		// A later SUCCESSFUL switch re-captures the real pre-persona set.
		await created.switchAgentPersona("persona-test");
		expect(session?.getEnabledToolNames()).toEqual(["read", "write"]);
		expect(session?.getBaselineToolNames()).toEqual(["read", "write", "bash"]);

		// Leaving agent mode restores the real pre-persona tools, not the
		// failed attempt's restricted [read].
		await session?.restoreBaselineTools();
		expect(session?.getEnabledToolNames()).toEqual(["read", "write", "bash"]);
	});

	it("keeps an asymmetric pre-existing launch baseline when a persona-to-persona switch fails", async () => {
		// Regression (wave-18 P2): the launch `--agent` path with a persona
		// carrying `tools:` frontmatter sets `baselineToolNames` to the full
		// registry but never seeds `baselineMountedToolNames` — xdev is disabled
		// under the persona's tool restriction, so the SDK's mounted snapshot is
		// skipped. The rollback clear used `||`, so a persona→persona switch
		// failing mid-apply cleared that pre-existing asymmetric baseline and a
		// later successful switch re-captured the wrong set. The clear must fire
		// only when BOTH fields were unset before the attempt (the first-switch
		// case, where the attempt itself wrote the pair).
		const created = createHarness(Settings.isolated({ "compaction.enabled": false }));
		// Seed the launch-with-`tools:`-frontmatter baseline pair: the full
		// registry list, mounted subset undefined. `setBaselineToolNames` alone
		// reproduces the pair exactly (the first-write guard passes and the
		// mounted field is never written).
		session!.setBaselineToolNames(["read", "write", "bash"]);
		expect(session?.getBaselineToolNames()).toEqual(["read", "write", "bash"]);
		expect(session?.getBaselineMountedToolNames()).toBeUndefined();

		// The persona→persona switch fails mid-apply (setModelTemporary throws);
		// the rollback call uses the real implementation.
		vi.spyOn(session!, "setModelTemporary").mockImplementationOnce(async () => {
			throw new Error("no API key");
		});
		await created.switchAgentPersona("persona-test");
		expect(session?.getEnabledToolNames()).toEqual(["read"]);

		// The pre-existing launch baseline SURVIVES: the attempt's
		// setBaselineMountedToolNames(getMountedXdevToolNames()=[]) wrote the
		// empty mounted list (its first-write guard passed on the undefined
		// field), but the full-registry baseline must NOT be cleared.
		expect(session?.getBaselineToolNames()).toEqual(["read", "write", "bash"]);
		expect(session?.getBaselineMountedToolNames()).toEqual([]);

		// A later SUCCESSFUL switch + leaving agent mode restores the real
		// pre-persona set (the full registry), not a cleared or stale baseline.
		await created.switchAgentPersona("persona-test");
		expect(session?.getEnabledToolNames()).toEqual(["read", "write"]);
		expect(session?.getBaselineToolNames()).toEqual(["read", "write", "bash"]);

		await session?.restoreBaselineTools();
		expect(session?.getEnabledToolNames()).toEqual(["read", "write", "bash"]);
	});

	it("captures the pre-persona baseline tools for restoration on leaving agent mode", async () => {
		const created = createHarness(Settings.isolated({ "compaction.enabled": false }));
		await created.switchAgentPersona("persona-test");

		// Baseline = the pre-switch tool set (read only), NOT the persona's
		// restricted [read, write] — leaving agent mode must restore the
		// original tools rather than the previous persona's.
		expect(session?.getBaselineToolNames()).toEqual(["read"]);
		expect(session?.getEnabledToolNames()).toEqual(["read", "write"]);
	});

	it("restores the baseline tools when switching to a persona without a tools list", async () => {
		const created = createHarness(Settings.isolated({ "compaction.enabled": false }));
		await created.switchAgentPersona("persona-test");
		expect(session?.getEnabledToolNames()).toEqual(["read", "write"]);

		// persona-minimal has NO tools frontmatter: the previous persona's
		// restricted [read, write] must be cleared back to the pre-persona
		// baseline [read] before the (absent) new tools are applied.
		await created.switchAgentPersona("persona-minimal");

		expect(session?.getEnabledToolNames()).toEqual(["read"]);
		expect(session?.getPersonaAppendPrompt()).toBe("You are persona-minimal.");
	});

	it("applies the new persona's tools when switching to a persona with a tools list", async () => {
		const created = createHarness(Settings.isolated({ "compaction.enabled": false }));
		await created.switchAgentPersona("persona-test");
		expect(session?.getEnabledToolNames()).toEqual(["read", "write"]);
		await created.switchAgentPersona("persona-minimal");
		expect(session?.getEnabledToolNames()).toEqual(["read"]);

		// Switching back to a persona WITH a tools list applies that persona's
		// tools on top of the restored baseline.
		await created.switchAgentPersona("persona-test");

		expect(session?.getEnabledToolNames()).toEqual(["read", "write"]);
		expect(session?.getPersonaAppendPrompt()).toBe("You are persona-test.");
	});

	it("restores the baseline tools when a non-agent session switch removes the persona", async () => {
		const created = createHarness(Settings.isolated({ "compaction.enabled": false }));
		await created.switchAgentPersona("persona-test");
		expect(session?.getEnabledToolNames()).toEqual(["read", "write"]);

		// Simulate the reconcile path for a non-agent target session: persona
		// state is cleared and the baseline tool set restored.
		await session?.restoreBaselineTools();
		session?.setSessionSpawns(null);
		session?.setPersonaAppendPrompt(undefined);

		expect(session?.getEnabledToolNames()).toEqual(["read"]);
		expect(session?.getSessionSpawns()).toBeNull();
		expect(session?.getPersonaAppendPrompt()).toBeUndefined();
	});

	it("clears persona-owned state on a live /plan entry from an agent persona", async () => {
		const created = createHarness(Settings.isolated({ "compaction.enabled": false }));
		await created.switchAgentPersona("persona-test");
		expect(session?.getEnabledToolNames()).toEqual(["read", "write"]);
		expect(session?.getSessionSpawns()).toBe("scout");
		expect(session?.getPersonaAppendPrompt()).toBe("You are persona-test.");

		// Live /plan from the persona: the persisted mode becomes non-agent, so
		// the persona's spawns/prompt/restricted tools must be cleared BEFORE the
		// plan toolset is applied (the reconcile else-branch behavior).
		await created.handlePlanModeCommand();

		expect(created.planModeEnabled).toBe(true);
		expect(session?.getSessionSpawns()).toBeNull();
		expect(session?.getPersonaAppendPrompt()).toBeUndefined();
		// Baseline [read] restored, then plan mode re-added the built-in write.
		expect(session?.getEnabledToolNames()).toEqual(["read", "write"]);
		expect(session?.getBaselineToolNames()).toEqual(["read"]);
	});

	it("clears persona-owned state on a live /vibe entry from an agent persona", async () => {
		const created = createHarness(Settings.isolated({ "compaction.enabled": false }));
		await created.switchAgentPersona("persona-test");
		expect(session?.getEnabledToolNames()).toEqual(["read", "write"]);
		expect(session?.getSessionSpawns()).toBe("scout");
		expect(session?.getPersonaAppendPrompt()).toBe("You are persona-test.");

		// Live /vibe from the persona: the persisted mode becomes non-agent, so
		// the persona's spawns/prompt/restricted tools must be cleared BEFORE the
		// vibe toolset is applied.
		await created.handleVibeModeCommand();

		expect(created.vibeModeEnabled).toBe(true);
		expect(session?.getSessionSpawns()).toBeNull();
		expect(session?.getPersonaAppendPrompt()).toBeUndefined();
		// Baseline [read] restored, then vibe mode activated read + vibe tools.
		expect(session?.getEnabledToolNames()).toEqual(["read", ...VIBE_TOOL_NAMES]);
		expect(session?.getBaselineToolNames()).toEqual(["read"]);
	});

	it("clears persona-owned state on a live /goal entry from an agent persona", async () => {
		const created = createHarness(Settings.isolated({ "compaction.enabled": false }));
		await created.switchAgentPersona("persona-test");
		expect(session?.getEnabledToolNames()).toEqual(["read", "write"]);
		expect(session?.getSessionSpawns()).toBe("scout");
		expect(session?.getPersonaAppendPrompt()).toBe("You are persona-test.");

		// Live /goal from the persona: the persisted mode becomes non-agent, so
		// the persona's spawns/prompt/restricted tools must be cleared BEFORE the
		// goal toolset is applied.
		await created.handleGoalModeCommand("Ship the release");

		expect(created.goalModeEnabled).toBe(true);
		expect(session?.getSessionSpawns()).toBeNull();
		expect(session?.getPersonaAppendPrompt()).toBeUndefined();
		// Baseline [read] restored, then goal mode re-added the goal tool.
		expect(session?.getEnabledToolNames()).toEqual(["read", "goal"]);
		expect(session?.getBaselineToolNames()).toEqual(["read"]);
	});

	it("does not restore a stale baseline on /plan from a normal session after leaving agent mode", async () => {
		// Regression (codex #3758059190): after a persona is used, the baseline
		// tool set stays populated even after leaving agent mode. A later /plan
		// from a NORMAL session used to re-apply the stale pre-persona baseline,
		// discarding tools activated after leaving agent mode (e.g. MCP tools).
		const created = createHarness(Settings.isolated({ "compaction.enabled": false }));
		await created.switchAgentPersona("persona-test");
		expect(session?.getEnabledToolNames()).toEqual(["read", "write"]);
		expect(session?.getBaselineToolNames()).toEqual(["read"]);

		// Leave agent mode: the persona's spawns/prompt/restricted tools are
		// cleared and the pre-persona baseline [read] restored.
		await created.handlePlanModeCommand();
		expect(session?.getSessionSpawns()).toBeNull();
		expect(session?.getPersonaAppendPrompt()).toBeUndefined();
		expect(session?.getEnabledToolNames()).toEqual(["read", "write"]); // plan re-added write
		await created.handlePlanModeCommand(); // plan → paused
		await created.handlePlanModeCommand(); // paused → off
		expect(created.planModeEnabled).toBe(false);
		expect(session?.getEnabledToolNames()).toEqual(["read"]);

		// A tool activated AFTER leaving agent mode (e.g. an MCP server
		// connected/reloaded later) must survive a subsequent /plan entry.
		const mcpTool: CustomTool = {
			name: "mcp__ambient_search",
			label: "ambient/search",
			description: "Search ambient data",
			parameters: type({}),
			mcpServerName: "ambient",
			mcpToolName: "search",
			async execute() {
				return { content: [{ type: "text", text: "ok" }] };
			},
		};
		await session!.refreshMCPTools([mcpTool]);
		expect(session?.getEnabledToolNames()).toEqual(["read", "mcp__ambient_search"]);

		// /plan from the normal session must NOT restore the stale baseline
		// [read] — the post-persona MCP tool stays enabled.
		await created.handlePlanModeCommand();
		expect(created.planModeEnabled).toBe(true);
		expect(session?.getSessionSpawns()).toBeNull();
		expect(session?.getPersonaAppendPrompt()).toBeUndefined();
		expect(session?.getEnabledToolNames()).toEqual(["read", "mcp__ambient_search", "write"]);
	});

	it("does not widen MCP tools past a read-only persona on MCP refresh", async () => {
		// A live `/agent readonly` switch narrows the session to `tools: [read]`.
		// A later MCP refresh (delayed connection, tool-change notification, or
		// `/mcp reload`) must NOT re-activate connected manager tools the persona
		// did not grant — the persona restriction is durable across refreshes
		// (codex #3819553918).
		const created = createHarness(Settings.isolated({ "compaction.enabled": false }));
		await created.switchAgentPersona("persona-readonly");
		expect(session?.getEnabledToolNames()).toEqual(["read"]);

		const mcpTool: CustomTool = {
			name: "mcp__db_query",
			label: "db/query",
			description: "Query the database",
			parameters: type({}),
			mcpServerName: "db",
			mcpToolName: "query",
			async execute() {
				return { content: [{ type: "text", text: "ok" }] };
			},
		};
		await session!.refreshMCPTools([mcpTool]);
		// The MCP tool is registered but NOT activated: the persona's `tools:
		// [read]` grant does not include it, so the refresh must not widen the
		// active set past the persona restriction.
		expect(session?.getEnabledToolNames()).toEqual(["read"]);

		// Leaving agent mode restores the unrestricted baseline, and a refresh
		// then activates the connected MCP tool (the restriction is cleared).
		await created.handlePlanModeCommand();
		await created.handlePlanModeCommand(); // plan → paused
		await created.handlePlanModeCommand(); // paused → off
		expect(session?.getSessionSpawns()).toBeNull();
		expect(session?.getPersonaAppendPrompt()).toBeUndefined();
		await session!.refreshMCPTools([mcpTool]);
		expect(session?.getEnabledToolNames()).toEqual(["read", "mcp__db_query"]);
	});

	it("does not touch the tool set on /plan from a session that never had a persona", async () => {
		// Control: a session that NEVER had a persona (no baseline captured, no
		// persona state) must keep its tool set untouched on /plan entry.
		const created = createHarness(Settings.isolated({ "compaction.enabled": false }));
		expect(session?.getBaselineToolNames()).toBeUndefined();
		expect(session?.getSessionSpawns()).toBeNull();
		expect(session?.getPersonaAppendPrompt()).toBeUndefined();
		expect(session?.getEnabledToolNames()).toEqual(["read"]);

		await created.handlePlanModeCommand();

		expect(created.planModeEnabled).toBe(true);
		expect(session?.getSessionSpawns()).toBeNull();
		expect(session?.getPersonaAppendPrompt()).toBeUndefined();
		// Plan mode re-added the built-in write; nothing else changed.
		expect(session?.getEnabledToolNames()).toEqual(["read", "write"]);
		expect(session?.getBaselineToolNames()).toBeUndefined();
	});

	it("re-applies the persona when switching back to /agent after a live mode change", async () => {
		const created = createHarness(Settings.isolated({ "compaction.enabled": false }));
		await created.switchAgentPersona("persona-test");
		await created.handlePlanModeCommand();
		expect(session?.getSessionSpawns()).toBeNull();
		expect(session?.getPersonaAppendPrompt()).toBeUndefined();

		// Toggle plan mode off (no draft file → no confirm prompt), then /agent
		// re-applies the persona (existing behavior preserved).
		await created.handlePlanModeCommand(); // plan → paused
		await created.handlePlanModeCommand(); // paused → off
		expect(created.planModeEnabled).toBe(false);
		expect(created.planModePaused).toBe(false);

		await created.switchAgentPersona("persona-test");

		expect(session?.getSessionSpawns()).toBe("scout");
		expect(session?.getPersonaAppendPrompt()).toBe("You are persona-test.");
		expect(session?.getEnabledToolNames()).toEqual(["read", "write"]);
	});
});

describe("ACP /agent and /switch-agent handle paths", () => {
	let tempHome: string;
	let projectDir: string;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;

	beforeEach(async () => {
		resetSettingsForTest();
		tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "omp-persona-acp-"));
		projectDir = path.join(tempHome, "project");
		await fs.mkdir(path.join(projectDir, ".omp", "agents"), { recursive: true });
		const agentsDir = path.join(projectDir, ".omp", "agents");
		await fs.writeFile(
			path.join(agentsDir, "persona-test.md"),
			agentMd("persona-test", [
				"tools: [read, write]",
				"model: anthropic/claude-haiku-4-5",
				"thinkingLevel: high",
				"spawns: [scout]",
			]),
		);
		await fs.writeFile(path.join(agentsDir, "persona-subagent.md"), agentMd("persona-subagent", ["mode: subagent"]));
		await fs.writeFile(path.join(agentsDir, "persona-minimal.md"), agentMd("persona-minimal"));

		await Settings.init({ inMemory: true, cwd: projectDir });
		Settings.instance.set("startup.quiet", true);
		authStorage = await AuthStorage.create(path.join(tempHome, "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await session?.dispose();
		authStorage?.close();
		await fs.rm(tempHome, { recursive: true, force: true });
		session = undefined;
		resetSettingsForTest();
	});

	function createAcpRuntime(): SlashCommandRuntime {
		const registry = new ModelRegistry(authStorage, path.join(tempHome, `models-${Bun.nanoseconds()}.yml`));
		const initialModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!initialModel) throw new Error("Expected bundled anthropic/claude-sonnet-4-5 to exist");
		const readTool = makeTool("read");
		const writeTool = makeTool("write");
		const toolRegistry = new Map<string, AgentTool>();
		toolRegistry.set(readTool.name, readTool);
		toolRegistry.set(writeTool.name, writeTool);
		const manager = SessionManager.create(projectDir, path.join(tempHome, `active-${Bun.nanoseconds()}`));
		const createdSession = new AgentSession({
			agent: new Agent({
				initialState: {
					model: initialModel,
					systemPrompt: ["Test"],
					tools: [readTool],
					messages: [],
					thinkingLevel: Effort.Medium,
				},
			}),
			sessionManager: manager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: registry,
			toolRegistry,
			builtInToolNames: ["read", "write"],
		});
		session = createdSession;
		const output = vi.fn();
		return {
			session: createdSession,
			sessionManager: manager,
			settings: createdSession.settings,
			cwd: projectDir,
			output,
			refreshCommands: vi.fn(),
			reloadPlugins: vi.fn(),
		} as unknown as SlashCommandRuntime;
	}

	it("applies the persona and persists mode_change via the ACP handle", async () => {
		const runtime = createAcpRuntime();
		const result = await executeAcpBuiltinSlashCommand("/agent persona-test", runtime);

		expect(result).toEqual({ consumed: true });
		expect(session?.getEnabledToolNames()).toEqual(["read", "write"]);
		expect(session?.model?.id).toBe("claude-haiku-4-5");
		expect(session?.configuredThinkingLevel()).toBe(Effort.High);
		expect(session?.getSessionSpawns()).toBe("scout");
		expect(session?.getPersonaAppendPrompt()).toBe("You are persona-test.");
		const entries = session?.sessionManager.getEntries() ?? [];
		const modeChange = entries.find(
			(entry): entry is Extract<typeof entry, { type: "mode_change" }> =>
				entry.type === "mode_change" && entry.mode === "agent",
		);
		expect(modeChange?.data).toEqual({ name: "persona-test" });
	});

	it("applies the model-suffix thinking level, not frontmatter thinkingLevel, via the ACP handle", async () => {
		const runtime = createAcpRuntime();
		await fs.writeFile(
			path.join(projectDir, ".omp", "agents", "persona-suffix.md"),
			agentMd("persona-suffix", ["model: anthropic/claude-sonnet-4-5:low", "thinkingLevel: high"]),
		);
		const result = await executeAcpBuiltinSlashCommand("/agent persona-suffix", runtime);

		expect(result).toEqual({ consumed: true });
		expect(session?.model?.id).toBe("claude-sonnet-4-5");
		expect(session?.configuredThinkingLevel()).toBe(Effort.Low);
	});

	it("applies frontmatter thinkingLevel when the model pattern has no thinking suffix via the ACP handle", async () => {
		const runtime = createAcpRuntime();
		await fs.writeFile(
			path.join(projectDir, ".omp", "agents", "persona-frontmatter.md"),
			agentMd("persona-frontmatter", ["model: anthropic/claude-sonnet-4-5", "thinkingLevel: high"]),
		);
		const result = await executeAcpBuiltinSlashCommand("/agent persona-frontmatter", runtime);

		expect(result).toEqual({ consumed: true });
		expect(session?.model?.id).toBe("claude-sonnet-4-5");
		expect(session?.configuredThinkingLevel()).toBe(Effort.High);
	});

	it("applies frontmatter thinkingLevel when only a NON-selected fallback pattern carries a suffix via the ACP handle", async () => {
		const runtime = createAcpRuntime();
		await fs.writeFile(
			path.join(projectDir, ".omp", "agents", "persona-fallback-suffix.md"),
			agentMd("persona-fallback-suffix", [
				"model: [missing/model:low, anthropic/claude-haiku-4-5]",
				"thinkingLevel: high",
			]),
		);
		const result = await executeAcpBuiltinSlashCommand("/agent persona-fallback-suffix", runtime);

		expect(result).toEqual({ consumed: true });
		// The `:low` suffix sits on a fallback pattern that does NOT resolve;
		// the SELECTED pattern (haiku) has no suffix, so the frontmatter
		// `thinkingLevel: high` applies.
		expect(session?.model?.id).toBe("claude-haiku-4-5");
		expect(session?.configuredThinkingLevel()).toBe(Effort.High);
	});

	it("restores the baseline tools when switching to a persona without a tools list via the ACP handle", async () => {
		const runtime = createAcpRuntime();
		await executeAcpBuiltinSlashCommand("/agent persona-test", runtime);
		expect(session?.getEnabledToolNames()).toEqual(["read", "write"]);

		// persona-minimal has NO tools frontmatter: the previous persona's
		// restricted [read, write] must be cleared back to the pre-persona
		// baseline [read] before the (absent) new tools are applied.
		await executeAcpBuiltinSlashCommand("/agent persona-minimal", runtime);

		expect(session?.getEnabledToolNames()).toEqual(["read"]);
		expect(session?.getPersonaAppendPrompt()).toBe("You are persona-minimal.");
	});

	it("rejects subagent-only agents via the ACP handle", async () => {
		const runtime = createAcpRuntime();
		const result = await executeAcpBuiltinSlashCommand("/agent persona-subagent", runtime);

		expect(result).toEqual({ consumed: true });
		expect(session?.getPersonaAppendPrompt()).toBeUndefined();
		const entries = session?.sessionManager.getEntries() ?? [];
		expect(entries.some(entry => entry.type === "mode_change" && entry.mode === "agent")).toBe(false);
	});

	it("rejects unknown agents via the ACP handle", async () => {
		const runtime = createAcpRuntime();
		const result = await executeAcpBuiltinSlashCommand("/agent does-not-exist", runtime);

		expect(result).toEqual({ consumed: true });
		expect(session?.getPersonaAppendPrompt()).toBeUndefined();
	});

	it("rejects ACP persona switches while plan mode is active", async () => {
		// Regression (codex #3821198710): the shared ACP/RPC handler applied
		// the persona without the plan/goal/vibe guards InteractiveMode uses,
		// letting a persona replace the active tool set (potentially dropping
		// the plan proposal tools) while plan mode stayed enabled.
		const runtime = createAcpRuntime();
		session!.setPlanModeState({ enabled: true, planFilePath: "/tmp/plan.md" });

		const result = await executeAcpBuiltinSlashCommand("/agent persona-test", runtime);

		expect(result).toEqual({ consumed: true });
		expect(session?.getPersonaAppendPrompt()).toBeUndefined();
		expect(session?.getSessionSpawns()).toBeNull();
		expect(session?.getEnabledToolNames()).toEqual(["read"]);
		const entries = session?.sessionManager.getEntries() ?? [];
		expect(entries.some(entry => entry.type === "mode_change" && entry.mode === "agent")).toBe(false);
	});

	it("rejects ACP persona switches while goal mode is active", async () => {
		const runtime = createAcpRuntime();
		session!.setGoalModeState({
			enabled: true,
			mode: "active",
			goal: {
				id: "g1",
				objective: "Ship",
				status: "active",
				tokensUsed: 0,
				timeUsedSeconds: 0,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			},
		});

		const result = await executeAcpBuiltinSlashCommand("/agent persona-test", runtime);

		expect(result).toEqual({ consumed: true });
		expect(session?.getPersonaAppendPrompt()).toBeUndefined();
		const entries = session?.sessionManager.getEntries() ?? [];
		expect(entries.some(entry => entry.type === "mode_change" && entry.mode === "agent")).toBe(false);
	});

	it("rejects ACP persona switches while vibe mode is active", async () => {
		const runtime = createAcpRuntime();
		session!.setVibeModeState({ enabled: true });

		const result = await executeAcpBuiltinSlashCommand("/agent persona-test", runtime);

		expect(result).toEqual({ consumed: true });
		expect(session?.getPersonaAppendPrompt()).toBeUndefined();
		const entries = session?.sessionManager.getEntries() ?? [];
		expect(entries.some(entry => entry.type === "mode_change" && entry.mode === "agent")).toBe(false);
	});

	it("rolls back partial apply failures via the ACP handle", async () => {
		const runtime = createAcpRuntime();
		vi.spyOn(session!, "setModelTemporary").mockImplementationOnce(async () => {
			throw new Error("no API key");
		});
		const result = await executeAcpBuiltinSlashCommand("/agent persona-test", runtime);

		expect(result).toEqual({ consumed: true });
		expect(session?.getEnabledToolNames()).toEqual(["read"]);
		expect(session?.model?.id).toBe("claude-sonnet-4-5");
		expect(session?.getPersonaAppendPrompt()).toBeUndefined();
		const entries = session?.sessionManager.getEntries() ?? [];
		expect(entries.some(entry => entry.type === "mode_change" && entry.mode === "agent")).toBe(false);
	});

	it("does not poison the baseline for a later successful switch when the first switch fails via the ACP handle", async () => {
		// Regression (codex #3759764275, ACP mirror): a failed FIRST /agent
		// switch used to leave the first-write-only baseline populated with the
		// failed attempt's tool set. A later successful switch then no-ops on
		// setBaselineToolNames, and leaving agent mode restores the stale
		// failed-attempt tools instead of the real pre-persona set.
		const runtime = createAcpRuntime();
		// First switch FAILS mid-apply (setModelTemporary throws); the rollback
		// call uses the real implementation.
		vi.spyOn(session!, "setModelTemporary").mockImplementationOnce(async () => {
			throw new Error("no API key");
		});
		const failed = await executeAcpBuiltinSlashCommand("/agent persona-test", runtime);
		expect(failed).toEqual({ consumed: true });
		expect(session?.getEnabledToolNames()).toEqual(["read"]);

		// The failed attempt must NOT leave the baseline populated: the
		// first-write guard would otherwise keep the failed attempt's [read]
		// forever, even after the user changes tools.
		expect(session?.getBaselineToolNames()).toBeUndefined();
		expect(session?.getBaselineMountedToolNames()).toBeUndefined();

		// The user changes tools after the failure (drops read, keeps write).
		await session!.setActiveToolsByName(["write"]);
		expect(session?.getEnabledToolNames()).toEqual(["write"]);

		// A later SUCCESSFUL switch re-captures the real pre-persona set.
		const ok = await executeAcpBuiltinSlashCommand("/agent persona-test", runtime);
		expect(ok).toEqual({ consumed: true });
		expect(session?.getEnabledToolNames()).toEqual(["read", "write"]);
		expect(session?.getBaselineToolNames()).toEqual(["write"]);

		// Leaving agent mode restores the real pre-persona tools, not the
		// failed attempt's stale [read].
		await session?.restoreBaselineTools();
		expect(session?.getEnabledToolNames()).toEqual(["write"]);
	});

	it("keeps a pre-existing baseline when a persona-to-persona switch fails via the ACP handle", async () => {
		// The rollback clear must fire only when THIS attempt captured the
		// baseline pair (snapshot undefined). A pre-existing baseline
		// (persona→persona failure) describes the real pre-persona set and
		// must survive the failed second switch.
		const runtime = createAcpRuntime();
		// First switch SUCCEEDS and captures the pre-persona baseline.
		const ok = await executeAcpBuiltinSlashCommand("/agent persona-test", runtime);
		expect(ok).toEqual({ consumed: true });
		expect(session?.getBaselineToolNames()).toEqual(["read"]);

		// A persona→persona switch fails mid-apply.
		vi.spyOn(session!, "setModelTemporary").mockImplementationOnce(async () => {
			throw new Error("no API key");
		});
		const failed = await executeAcpBuiltinSlashCommand("/agent persona-test", runtime);
		expect(failed).toEqual({ consumed: true });

		// The pre-existing baseline survives: leaving agent mode still
		// restores the real pre-persona set.
		expect(session?.getBaselineToolNames()).toEqual(["read"]);
		expect(session?.getBaselineMountedToolNames()).toEqual([]);
		await session?.restoreBaselineTools();
		expect(session?.getEnabledToolNames()).toEqual(["read"]);
	});

	it("keeps an asymmetric pre-existing launch baseline when a persona-to-persona switch fails via the ACP handle", async () => {
		// Regression (wave-18 P2, ACP mirror): the `||` rollback clear fired
		// whenever ONE baseline field was unset pre-attempt, destroying a
		// pre-existing ASYMMETRIC baseline (full-registry `baselineToolNames`
		// with `baselineMountedToolNames` undefined — the launch `--agent`
		// with `tools:` frontmatter state). Only a fully-unset pair marks this
		// attempt's own first-write capture and may be cleared.
		const runtime = createAcpRuntime();
		// Seed the asymmetric launch baseline: full-registry list, mounted
		// subset never written.
		session!.setBaselineToolNames(["read", "write"]);
		expect(session?.getBaselineToolNames()).toEqual(["read", "write"]);
		expect(session?.getBaselineMountedToolNames()).toBeUndefined();

		// A persona→persona switch fails mid-apply.
		vi.spyOn(session!, "setModelTemporary").mockImplementationOnce(async () => {
			throw new Error("no API key");
		});
		const failed = await executeAcpBuiltinSlashCommand("/agent persona-test", runtime);
		expect(failed).toEqual({ consumed: true });

		// The pre-existing asymmetric baseline survives.
		expect(session?.getBaselineToolNames()).toEqual(["read", "write"]);
		expect(session?.getBaselineMountedToolNames()).toEqual([]);

		// A later successful switch + leaving agent mode restores the real
		// pre-persona set, not a cleared or stale baseline.
		const ok = await executeAcpBuiltinSlashCommand("/agent persona-test", runtime);
		expect(ok).toEqual({ consumed: true });
		expect(session?.getEnabledToolNames()).toEqual(["read", "write"]);
		expect(session?.getBaselineToolNames()).toEqual(["read", "write"]);
		await session?.restoreBaselineTools();
		expect(session?.getEnabledToolNames()).toEqual(["read", "write"]);
	});
});

describe("createAcpSessionFactory --agent persona", () => {
	let tempHome: string;
	let projectDir: string;
	let authStorage: AuthStorage;

	beforeEach(async () => {
		resetSettingsForTest();
		tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "omp-persona-acp-factory-"));
		projectDir = path.join(tempHome, "project");
		await fs.mkdir(path.join(projectDir, ".omp", "agents"), { recursive: true });
		await fs.writeFile(
			path.join(projectDir, ".omp", "agents", "persona-test.md"),
			agentMd("persona-test", [
				"tools: [read, write]",
				"model: anthropic/claude-haiku-4-5",
				"thinkingLevel: high",
				"spawns: [scout]",
			]),
		);
		await fs.writeFile(
			path.join(projectDir, ".omp", "agents", "persona-low.md"),
			agentMd("persona-low", ["thinkingLevel: low"]),
		);
		await Settings.init({ inMemory: true, cwd: projectDir });
		Settings.instance.set("startup.quiet", true);
		authStorage = await AuthStorage.create(path.join(tempHome, "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		authStorage?.close();
		await fs.rm(tempHome, { recursive: true, force: true });
		resetSettingsForTest();
	});

	function createFactory(
		parsedArgs: Record<string, unknown>,
		baseOptions: CreateAgentSessionOptions,
	): { factory: AcpSessionFactory; captured: CreateAgentSessionOptions[] } {
		const captured: CreateAgentSessionOptions[] = [];
		const fakeSession = {} as AgentSession;
		const factory = createAcpSessionFactory({
			baseOptions,
			settings: Settings.isolated({}),
			sessionDir: path.join(tempHome, "sessions"),
			authStorage,
			modelRegistry: new ModelRegistry(authStorage, path.join(tempHome, "models.yml")),
			parsedArgs: parsedArgs as never,
			rawArgs: [],
			createSession: async options => {
				captured.push(options);
				return {
					session: fakeSession,
					extensionsResult: { extensions: [], errors: [], runner: undefined },
					setToolUIContext: () => {},
					eventBus: { emit: () => {}, on: () => () => {}, off: () => {} },
				} as unknown as CreateAgentSessionResult;
			},
		});
		return { factory, captured };
	}

	it("re-resolves the persona against the session cwd and applies it once", async () => {
		const { factory, captured } = createFactory({ agent: "persona-test" }, {});
		await factory(projectDir);

		expect(captured).toHaveLength(1);
		expect(captured[0].toolNames).toEqual(["read", "write", "task"]);
		// The persona's tool list is the EXACT active set (subagent
		// restrictToolNames semantics) — no MCP/LSP/extension/memory widening.
		expect(captured[0].restrictToolNames).toBe(true);
		expect(captured[0].modelPattern).toEqual(["anthropic/claude-haiku-4-5"]);
		expect(captured[0].thinkingLevel).toBe(Effort.High);
		expect(captured[0].spawns).toBe("scout");
		// The persona prompt lives in the MUTABLE persona channel (not the
		// immutable launch append) so a later /agent switch replaces it.
		expect(captured[0].personaAppendPrompt).toBe("You are persona-test.");
		expect(captured[0].appendSystemPrompt).toBeUndefined();
		expect(captured[0].personaName).toBe("persona-test");
	});

	it("does not persist a phantom persona when the agent is absent from the session cwd", async () => {
		const { factory, captured } = createFactory({ agent: "missing-agent" }, {});
		await factory(projectDir);

		expect(captured).toHaveLength(1);
		expect(captured[0].toolNames).toBeUndefined();
		expect(captured[0].personaAppendPrompt).toBeUndefined();
		expect(captured[0].personaName).toBeUndefined();
	});

	it("honors CLI --model precedence over the agent's model", async () => {
		// Precedence derives from the explicit CLI flag (parsedArgs.model), not
		// resolved baseOptions: settings defaults must not suppress the persona.
		const { factory, captured } = createFactory({ agent: "persona-test", model: "anthropic/claude-opus-4-5" }, {});
		await factory(projectDir);

		expect(captured[0].modelPattern).toBeUndefined();
		expect(captured[0].toolNames).toEqual(["read", "write", "task"]);
	});

	it("settings-seeded baseOptions thinking does not suppress the persona's thinkingLevel", async () => {
		// Regression: `sessionOptions.thinkingLevel` can be seeded from settings
		// defaults (enabledModels scoped thinking) independently of the CLI
		// --model suffix. A settings default must NOT count as an explicit CLI
		// override against the persona's thinkingLevel.
		const { factory, captured } = createFactory(
			{ agent: "persona-test", model: "anthropic/claude-sonnet-4-5" },
			{ thinkingLevel: Effort.Low },
		);
		await factory(projectDir);

		expect(captured[0].modelPattern).toBeUndefined();
		expect(captured[0].thinkingLevel).toBe(Effort.High);
	});

	it("--model thinking suffix wins over the persona's thinkingLevel", async () => {
		// Positive control: a `--model` pattern carrying a thinking suffix is
		// an explicit CLI override and must beat the persona's frontmatter.
		const { factory, captured } = createFactory(
			{ agent: "persona-test", model: "anthropic/claude-sonnet-4-5:low" },
			{ thinkingLevel: Effort.Low },
		);
		await factory(projectDir);

		expect(captured[0].modelPattern).toBeUndefined();
		expect(captured[0].thinkingLevel).toBe(Effort.Low);
	});

	it("deferred role-alias --model suffix wins over the persona's frontmatter thinkingLevel", async () => {
		// Regression (codex wave-14 P2): `--agent` + `--model @review:high`
		// (a role alias resolving to an EXTENSION-provided model, deferred
		// until extensions register) used to let the persona's frontmatter
		// `thinkingLevel` clobber the CLI suffix — `modelSuffixThinking` was
		// derived from the RESOLVED model, which is undefined pre-extension.
		// The suffix must be read from the selector SYNTAX so a deferred
		// pattern still counts as an explicit override.
		const settings = Settings.isolated();
		settings.setModelRole("review", "runtime-provider/runtime-reasoning-model");
		const { factory, captured } = createFactory(
			{ agent: "persona-low", model: "@review:high" },
			// Settings-seeded default (distinct from the persona's `low`):
			// must survive untouched — the CLI suffix is explicit, so the
			// persona's frontmatter thinkingLevel must NOT be applied.
			{ thinkingLevel: Effort.Medium },
		);
		// The factory clones the settings for the session cwd; the role must
		// survive the clone for the syntactic suffix check to see it.
		vi.spyOn(Settings.prototype, "cloneForCwd").mockResolvedValue(settings);
		await factory(projectDir);

		expect(captured[0].thinkingLevel).toBe(Effort.Medium);
	});

	it("deferred role-alias --model without a suffix keeps the persona's frontmatter thinkingLevel", async () => {
		// Control: `--model @review` (no suffix) is not an explicit thinking
		// override, so the persona's frontmatter `thinkingLevel: low` applies.
		const settings = Settings.isolated();
		settings.setModelRole("review", "runtime-provider/runtime-reasoning-model");
		const { factory, captured } = createFactory(
			{ agent: "persona-low", model: "@review" },
			{ thinkingLevel: Effort.Medium },
		);
		vi.spyOn(Settings.prototype, "cloneForCwd").mockResolvedValue(settings);
		await factory(projectDir);

		expect(captured[0].thinkingLevel).toBe(Effort.Low);
	});

	it("applies the persona's model frontmatter over a baseOptions default model", async () => {
		// Regression (codex #3754547620): the ACP factory re-applies the persona
		// per session cwd. When `baseOptions.model` holds the startup-selected
		// default (no explicit --model), the persona's `model:` frontmatter must
		// replace it — the populated default must not short-circuit the deferred
		// persona pattern in createAgentSession.
		const defaultModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!defaultModel) throw new Error("Expected bundled anthropic/claude-sonnet-4-5 to exist");
		const { factory, captured } = createFactory({ agent: "persona-test" }, { model: defaultModel });
		await factory(projectDir);

		expect(captured[0].model).toBeUndefined();
		expect(captured[0].modelPattern).toEqual(["anthropic/claude-haiku-4-5"]);
		// The default is preserved as the fallback for an unresolvable persona
		// model, mirroring the subagent path's parent-model fallback.
		expect(captured[0].modelPatternFallbackModel?.id).toBe("claude-sonnet-4-5");
		// The persona's thinkingLevel still applies (no suffix on its model).
		expect(captured[0].thinkingLevel).toBe(Effort.High);
	});

	it("keeps an explicit --model over the persona's model frontmatter in ACP", async () => {
		// Negative control: an explicit `--model` is the ONLY documented
		// override — the persona's `model:` frontmatter must be ignored.
		const { factory, captured } = createFactory({ agent: "persona-test", model: "anthropic/claude-sonnet-4-5" }, {});
		await factory(projectDir);

		expect(captured[0].modelPattern).toBeUndefined();
		expect(captured[0].modelPatternFallbackModel).toBeUndefined();
	});
});

describe("ToolSession spawns after persona clear", () => {
	let tempHome: string;
	let projectDir: string;
	let authStorage: AuthStorage;

	beforeEach(async () => {
		resetSettingsForTest();
		tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "omp-persona-spawns-"));
		projectDir = path.join(tempHome, "project");
		await fs.mkdir(projectDir, { recursive: true });
		await Settings.init({ inMemory: true, cwd: projectDir });
		Settings.instance.set("startup.quiet", true);
		authStorage = await AuthStorage.create(path.join(tempHome, "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		authStorage?.close();
		await fs.rm(tempHome, { recursive: true, force: true });
		resetSettingsForTest();
	});

	it("clearing the persona spawns lifts the launch restriction for the task tool", async () => {
		// Regression: the ToolSession host closure used to treat a cleared
		// session (`setSessionSpawns(null)`) as absent and fall back to
		// `options.spawns` — the launch persona's restriction (e.g. "scout").
		// After clearing, the task tool's parentSpawns must resolve to "*".
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled anthropic/claude-sonnet-4-5 to exist");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempHome, "models.yml"));
		const sessionManager = SessionManager.inMemory(projectDir);
		const { session } = await createAgentSession({
			cwd: projectDir,
			agentDir: tempHome,
			modelRegistry,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			model,
			spawns: "scout",
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
		});
		try {
			// Launch persona restriction is live: the session reports "scout"
			// and the task tool advertises scout as the default spawn.
			expect(session.getSessionSpawns()).toBe("scout");
			const taskTool = session.getToolByName("task");
			expect(taskTool).toBeDefined();
			expect(taskTool!.description).toContain("spawn-policy default (`scout`)");

			// Clearing the persona must read as unrestricted "*" — the task
			// tool must NOT keep advertising the launch persona's restriction.
			session.setSessionSpawns(null);
			expect(session.getSessionSpawns()).toBeNull();
			expect(taskTool!.description).toContain("spawn-policy default (`task`)");
		} finally {
			await session.dispose();
		}
	});
});

describe("Residual CLI restriction after leaving a launch persona", () => {
	let tempHome: string;
	let projectDir: string;
	let authStorage: AuthStorage;

	beforeEach(async () => {
		resetSettingsForTest();
		tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "omp-persona-residual-"));
		projectDir = path.join(tempHome, "project");
		await fs.mkdir(projectDir, { recursive: true });
		await Settings.init({ inMemory: true, cwd: projectDir });
		Settings.instance.set("startup.quiet", true);
		authStorage = await AuthStorage.create(path.join(tempHome, "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		authStorage?.close();
		await fs.rm(tempHome, { recursive: true, force: true });
		resetSettingsForTest();
	});

	it("keeps the explicit CLI grant enforced on MCP refresh after leaving the persona", async () => {
		// P1 (codex #3845551575): a launch `--agent` persona combined with an
		// explicit `--tools read` made `restoreBaselineTools` unconditionally
		// clear the ONLY durable restriction when the persona was left. Persona
		// sessions load extensions and MCP/RPC tools, so a later refresh saw no
		// restriction and auto-activated newly registered tools — mutating ones
		// included — past the explicit CLI grant. The residual CLI restriction
		// (the grant MINUS tools the persona itself granted) must survive the
		// persona exit and keep filtering late refreshes.
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled anthropic/claude-sonnet-4-5 to exist");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempHome, "models.yml"));
		const sessionManager = SessionManager.inMemory(projectDir);
		const { session } = await createAgentSession({
			cwd: projectDir,
			agentDir: tempHome,
			modelRegistry,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			model,
			personaName: "launch-persona",
			personaCliToolOverride: true,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			toolNames: ["read"],
		});
		try {
			// Launch state: only the CLI grant is active.
			expect(session.getEnabledToolNames()).toEqual(["read"]);

			// Leaving the persona: the baseline (the CLI list) is restored and
			// the persona restriction drops — but the RESIDUAL CLI restriction
			// must stay in force.
			await session.restoreBaselineTools();
			expect(session.getEnabledToolNames()).toEqual(["read"]);

			// A later MCP-style refresh (delayed server connection) must NOT
			// auto-activate the connected tool past the CLI grant.
			const mcpTool: CustomTool = {
				name: "mcp__db_query",
				label: "db/query",
				description: "Query the database",
				parameters: type({}),
				mcpServerName: "db",
				mcpToolName: "query",
				async execute() {
					return { content: [{ type: "text", text: "ok" }] };
				},
			};
			await session.refreshMCPTools([mcpTool]);
			expect(session.getEnabledToolNames()).toEqual(["read"]);
			// The tool is registered for a later persona that grants it.
			expect(session.getAllToolNames()).toContain("mcp__db_query");

			// A persona switch whose `tools:` list grants the tool activates it
			// (the live persona grant supersedes the residual while active).
			await session.applyPersonaTools(["read", "mcp__db_query"]);
			expect(session.getEnabledToolNames()).toEqual(["read", "mcp__db_query"]);

			// Leaving again restores the CLI-list baseline — the persona grant
			// was LIVE (frontmatter applied over the session, not the CLI
			// baseline), so the residual keeps constraining: a later refresh
			// must NOT re-activate the tool past the CLI grant.
			await session.restoreBaselineTools();
			await session.refreshMCPTools([mcpTool]);
			expect(session.getEnabledToolNames()).toEqual(["read"]);
		} finally {
			await session.dispose();
		}
	});
});

describe("Persona tools on a restricted-tools session", () => {
	let tempHome: string;
	let projectDir: string;
	let authStorage: AuthStorage;

	beforeEach(async () => {
		resetSettingsForTest();
		tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "omp-persona-tools-"));
		projectDir = path.join(tempHome, "project");
		await fs.mkdir(projectDir, { recursive: true });
		await Settings.init({ inMemory: true, cwd: projectDir });
		Settings.instance.set("startup.quiet", true);
		authStorage = await AuthStorage.create(path.join(tempHome, "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		authStorage?.close();
		await fs.rm(tempHome, { recursive: true, force: true });
		resetSettingsForTest();
	});

	async function createRestrictedSession(settings: Settings, options: { enableLsp?: boolean } = {}) {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled anthropic/claude-sonnet-4-5 to exist");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempHome, "models.yml"));
		const sessionManager = SessionManager.inMemory(projectDir);
		return createAgentSession({
			cwd: projectDir,
			agentDir: tempHome,
			modelRegistry,
			sessionManager,
			settings,
			model,
			toolNames: ["read"],
			restrictToolNames: true,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			// Omitted by default: a restricted launch with no explicit LSP
			// policy defaults `enableLsp` to false (the restricted-session
			// DEFAULT, not an explicit `--no-lsp`). Pass `{ enableLsp: false }`
			// to simulate an explicit `--no-lsp`.
			...(options.enableLsp === undefined ? {} : { enableLsp: options.enableLsp }),
			skipPythonPreflight: true,
		});
	}

	it("registers and activates a persona tool the launch registry omitted", async () => {
		// Regression: a session started with `--tools read` holds only the
		// requested built-ins (no `expandRegistryToAllBuiltins`), so a live
		// `/agent` switch to a persona whose `tools:` list names `bash` used
		// to silently drop it — `applyActiveToolsByName` skips names absent
		// from the registry. `applyPersonaTools` must register the missing
		// built-in through the same allowance gate the launch path uses.
		const { session } = await createRestrictedSession(Settings.isolated({ "compaction.enabled": false }));
		try {
			// Launch state: only `read` is registered and active.
			expect(session.getToolByName("bash")).toBeUndefined();
			expect(session.getActiveToolNames()).toEqual(["read"]);

			// Live persona switch: `bash` must be registered and activated.
			await session.applyPersonaTools(["read", "bash"]);
			expect(session.getToolByName("bash")).toBeDefined();
			expect(session.getActiveToolNames()).toEqual(["read", "bash"]);
		} finally {
			await session.dispose();
		}
	});

	it("keeps a settings-denied tool unregistered on persona switch", async () => {
		// The on-demand registration must respect the same allowance gate as
		// launch: a session whose settings deny `bash` (`bash.enabled: false`)
		// must not gain the tool via a persona's `tools:` list.
		const { session } = await createRestrictedSession(
			Settings.isolated({ "compaction.enabled": false, "bash.enabled": false }),
		);
		try {
			await session.applyPersonaTools(["read", "bash"]);
			expect(session.getToolByName("bash")).toBeUndefined();
			expect(session.getActiveToolNames()).toEqual(["read"]);
		} finally {
			await session.dispose();
		}
	});
});

describe("Persona lsp on a restricted-tools session", () => {
	let tempHome: string;
	let projectDir: string;
	let authStorage: AuthStorage;

	beforeEach(async () => {
		resetSettingsForTest();
		tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "omp-persona-lsp-"));
		projectDir = path.join(tempHome, "project");
		await fs.mkdir(projectDir, { recursive: true });
		await Settings.init({ inMemory: true, cwd: projectDir });
		Settings.instance.set("startup.quiet", true);
		authStorage = await AuthStorage.create(path.join(tempHome, "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		authStorage?.close();
		await fs.rm(tempHome, { recursive: true, force: true });
		resetSettingsForTest();
	});

	async function createRestrictedSession(settings: Settings, options: { enableLsp?: boolean } = {}) {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled anthropic/claude-sonnet-4-5 to exist");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempHome, "models.yml"));
		const sessionManager = SessionManager.inMemory(projectDir);
		return createAgentSession({
			cwd: projectDir,
			agentDir: tempHome,
			modelRegistry,
			sessionManager,
			settings,
			model,
			toolNames: ["read"],
			restrictToolNames: true,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			// Omitted by default: a restricted launch with no explicit LSP
			// policy defaults `enableLsp` to false (the restricted-session
			// DEFAULT, not an explicit `--no-lsp`). Pass `{ enableLsp: false }`
			// to simulate an explicit `--no-lsp`.
			...(options.enableLsp === undefined ? {} : { enableLsp: options.enableLsp }),
			skipPythonPreflight: true,
		});
	}

	it("registers and activates lsp on a live persona switch when the restricted launch defaulted enableLsp false", async () => {
		// Regression (codex #3756546770): a session started under a restricted
		// `--agent` whose `tools:` list omits `lsp` defaults `enableLsp` to
		// false. A later `/agent` switch to a persona whose frontmatter
		// EXPLICITLY includes `lsp` must register and activate the tool —
		// the restricted-session default is not an explicit `--no-lsp`, and
		// the launch path's `enableLsp !== false` guard (main.ts) already
		// grants the persona's explicit request.
		const { session } = await createRestrictedSession(Settings.isolated({ "compaction.enabled": false }));
		try {
			// Launch state: only `read` is registered and active; `lsp` is absent.
			expect(session.getToolByName("lsp")).toBeUndefined();
			expect(session.getActiveToolNames()).toEqual(["read"]);

			// Live persona switch to a persona with `tools: [lsp, read]`.
			await session.applyPersonaTools(["lsp", "read"]);
			expect(session.getToolByName("lsp")).toBeDefined();
			expect(session.getEnabledToolNames()).toEqual(["lsp", "read"]);
		} finally {
			await session.dispose();
		}
	});

	it("keeps lsp disabled on persona switch when the session was launched with an explicit --no-lsp", async () => {
		// Control: an explicit `--no-lsp` (enableLsp: false passed at
		// creation) must still win — even a persona that explicitly requests
		// `lsp` cannot re-enable it.
		const { session } = await createRestrictedSession(Settings.isolated({ "compaction.enabled": false }), {
			enableLsp: false,
		});
		try {
			await session.applyPersonaTools(["lsp", "read"]);
			expect(session.getToolByName("lsp")).toBeUndefined();
			expect(session.getEnabledToolNames()).toEqual(["read"]);
		} finally {
			await session.dispose();
		}
	});

	it("keeps lsp disabled on persona switch when the persona does not request it", async () => {
		// Control: a persona whose `tools:` list omits `lsp` must not gain
		// the tool — the restricted-session default stays in force.
		const { session } = await createRestrictedSession(Settings.isolated({ "compaction.enabled": false }));
		try {
			await session.applyPersonaTools(["read"]);
			expect(session.getToolByName("lsp")).toBeUndefined();
			expect(session.getEnabledToolNames()).toEqual(["read"]);
		} finally {
			await session.dispose();
		}
	});
});

describe("Persona hub on a restricted-tools session", () => {
	let tempHome: string;
	let projectDir: string;
	let authStorage: AuthStorage;

	beforeEach(async () => {
		resetSettingsForTest();
		tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "omp-persona-hub-"));
		projectDir = path.join(tempHome, "project");
		await fs.mkdir(projectDir, { recursive: true });
		await Settings.init({ inMemory: true, cwd: projectDir });
		Settings.instance.set("startup.quiet", true);
		authStorage = await AuthStorage.create(path.join(tempHome, "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		authStorage?.close();
		await fs.rm(tempHome, { recursive: true, force: true });
		resetSettingsForTest();
	});

	async function createRestrictedSession(settings: Settings, options: { enableIrc?: boolean } = {}) {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled anthropic/claude-sonnet-4-5 to exist");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempHome, "models.yml"));
		const sessionManager = SessionManager.inMemory(projectDir);
		return createAgentSession({
			cwd: projectDir,
			agentDir: tempHome,
			modelRegistry,
			sessionManager,
			settings,
			model,
			toolNames: ["read"],
			restrictToolNames: true,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			// Omitted by default: a restricted launch without an explicit IRC
			// policy leaves `baselineHubEnabled` true while the non-persona
			// hub policy holds (spawning enabled, `enableIrc` not false).
			// Pass `{ enableIrc: false }` to simulate an internal caller that
			// explicitly disables IRC (security coordinator, persisted revive).
			...(options.enableIrc === undefined ? {} : { enableIrc: options.enableIrc }),
			skipPythonPreflight: true,
		});
	}

	it("registers and activates hub on a live persona switch when the persona explicitly requests it", async () => {
		// Regression (de-novo review, P2): a session started under a
		// restricted launch holds only the requested built-ins
		// (`restrictToolNames` forces `enableIrc` off for the gate), so a
		// live `/agent` switch to a persona whose frontmatter EXPLICITLY
		// includes `hub` used to silently drop it — `applyPersonaTools`
		// never passed `personaRequestsHub`, so the SDK closure's
		// `hubLifted` lift (which requires it) never fired. The launch path
		// honors the same persona via `createTools`'s `hubLifted`, so a
		// live switch must too: the persona's explicit request lifts hub
		// through the restricted gate whenever the non-persona hub policy
		// (spawning enabled, IRC not explicitly disabled) holds.
		const { session } = await createRestrictedSession(Settings.isolated({ "compaction.enabled": false }));
		try {
			// Launch state: only `read` is registered and active; `hub` is absent.
			expect(session.getToolByName("hub")).toBeUndefined();
			expect(session.getActiveToolNames()).toEqual(["read"]);

			// Live persona switch to a persona with `tools: [hub, read]`.
			await session.applyPersonaTools(["hub", "read"]);
			expect(session.getToolByName("hub")).toBeDefined();
			expect(session.getEnabledToolNames()).toEqual(["hub", "read"]);
		} finally {
			await session.dispose();
		}
	});

	it("keeps hub dropped on persona switch when the persona does not request it", async () => {
		// Control: a persona whose `tools:` list omits `hub` must not gain
		// the tool — the restricted-session gate stays in force.
		const { session } = await createRestrictedSession(Settings.isolated({ "compaction.enabled": false }));
		try {
			await session.applyPersonaTools(["read"]);
			expect(session.getToolByName("hub")).toBeUndefined();
			expect(session.getEnabledToolNames()).toEqual(["read"]);
		} finally {
			await session.dispose();
		}
	});

	it("keeps hub dropped on persona switch when the session explicitly disabled IRC", async () => {
		// Control: an explicit `enableIrc: false` (only ever set by internal
		// callers — security coordinator, persisted revive) must still win
		// even when the persona's tools list requests hub —
		// `baselineHubEnabled` stays false, so the lift never fires.
		const { session } = await createRestrictedSession(Settings.isolated({ "compaction.enabled": false }), {
			enableIrc: false,
		});
		try {
			await session.applyPersonaTools(["hub", "read"]);
			expect(session.getToolByName("hub")).toBeUndefined();
			expect(session.getEnabledToolNames()).toEqual(["read"]);
		} finally {
			await session.dispose();
		}
	});
});
