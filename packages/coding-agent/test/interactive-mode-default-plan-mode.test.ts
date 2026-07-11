import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentTool } from "@pk-nerdsaver-ai/pi-agent-core";
import { type Api, Effort, type Model } from "@pk-nerdsaver-ai/pi-ai";
import { resetSettingsForTest, Settings } from "@pk-nerdsaver-ai/pi-coding-agent/config/settings";
import { initTheme } from "@pk-nerdsaver-ai/pi-coding-agent/modes/theme/theme";
import { AgentSession } from "@pk-nerdsaver-ai/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@pk-nerdsaver-ai/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@pk-nerdsaver-ai/pi-coding-agent/session/session-manager";
import { TempDir } from "@pk-nerdsaver-ai/pi-utils";
import { type } from "arktype";
import { ModelRegistry } from "../src/config/model-registry";
import { InteractiveMode } from "../src/modes/interactive-mode";

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

interface HarnessOptions {
	extraRegistryTools?: readonly AgentTool[];
	builtInToolNames?: Iterable<string>;
}

describe("InteractiveMode plan.defaultOnStartup", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let mode: InteractiveMode | undefined;
	let session: AgentSession | undefined;

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-default-plan-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		Settings.instance.set("startup.quiet", true);
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
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

	function modelOrThrow(registry: ModelRegistry, id: string): Model<Api> {
		const model = registry.find("anthropic", id);
		if (!model) throw new Error(`Expected anthropic model ${id} to exist`);
		return model;
	}

	/** Build an InteractiveMode over a brand-new (never-persisted) session.
	 *  `extraRegistryTools` registers additional tools that are NOT initially
	 *  active — modeling tools hidden by `tools.discoveryMode === "all"` that
	 *  modes may force-activate on entry. `builtInToolNames` marks which registry
	 *  entries still have built-in provenance after extension shadowing. */
	function createHarness(settings: Settings, options: HarnessOptions = {}): InteractiveMode {
		const registry = new ModelRegistry(authStorage, path.join(tempDir.path(), `models-${Bun.nanoseconds()}.yml`));
		const initialModel = modelOrThrow(registry, "claude-sonnet-4-5");
		const readTool = makeTool("read");
		const resolveTool = makeTool("resolve");
		// AgentSession requires a Map-typed tool registry; the harness needs both
		// `read` (the initial active tool) and `resolve` (added on plan-mode entry).
		const toolRegistry = new Map<string, AgentTool>([
			[readTool.name, readTool],
			[resolveTool.name, resolveTool],
		]);
		for (const tool of options.extraRegistryTools ?? []) {
			toolRegistry.set(tool.name, tool);
		}
		const manager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), `active-${Bun.nanoseconds()}`));
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
			builtInToolNames: options.builtInToolNames ?? ["read", "resolve"],
		});
		session = createdSession;
		mode = new InteractiveMode(createdSession, "test");
		return mode;
	}

	it("enters plan mode at startup when the setting is enabled", async () => {
		const created = createHarness(Settings.isolated({ "plan.defaultOnStartup": true, "compaction.enabled": false }));

		await created.init({ suppressWelcomeIntro: true });

		expect(created.planModeEnabled).toBe(true);
		expect(session?.getPlanModeState()).toMatchObject({ enabled: true, planFilePath: "local://PLAN.md" });
		expect(session?.getActiveToolNames()).toContain("resolve");
	});

	it("activates write when entering plan mode even if it was hidden by discoveryMode (issue #3165)", async () => {
		// `plan-mode-active.md` instructs the agent to draft the plan file with
		// `write` and refine it with `edit`. Under `tools.discoveryMode === "all"`
		// `write` is hidden behind `search_tool_bm25` so it's in the registry but
		// not the initial active set. Plan-mode entry must force-activate it or
		// the agent only has `edit`, which fails on a non-existent file.
		const writeTool = makeTool("write");
		const created = createHarness(Settings.isolated({ "plan.defaultOnStartup": true, "compaction.enabled": false }), {
			extraRegistryTools: [writeTool],
			builtInToolNames: ["read", "resolve", "write"],
		});

		expect(session?.getActiveToolNames()).not.toContain("write");

		await created.init({ suppressWelcomeIntro: true });

		expect(created.planModeEnabled).toBe(true);
		expect(session?.getActiveToolNames()).toContain("write");
		expect(session?.getActiveToolNames()).toContain("resolve");
	});

	it("does not activate an extension-shadowed write tool in plan mode", async () => {
		const shadowWriteTool = makeTool("write");
		const created = createHarness(Settings.isolated({ "plan.defaultOnStartup": true, "compaction.enabled": false }), {
			extraRegistryTools: [shadowWriteTool],
		});

		await created.init({ suppressWelcomeIntro: true });

		expect(created.planModeEnabled).toBe(true);
		expect(session?.getActiveToolNames()).toContain("resolve");
		expect(session?.getActiveToolNames()).not.toContain("write");
	});

	it("does not enter plan mode at startup by default", async () => {
		const created = createHarness(Settings.isolated({ "compaction.enabled": false }));

		await created.init({ suppressWelcomeIntro: true });

		expect(created.planModeEnabled).toBe(false);
		expect(session?.getPlanModeState()).toBeUndefined();
	});

	it("does not enter plan mode when the session has restored conversation", async () => {
		// A genuinely resumed session has prior conversation messages. Gating on
		// message entries (not the CLI resume flag) means a `--continue` that
		// created a *fresh* session still gets the startup default (above), while
		// one with restored conversation is left in its reconciled mode.
		const created = createHarness(Settings.isolated({ "plan.defaultOnStartup": true, "compaction.enabled": false }));
		created.sessionManager.appendMessage({ role: "user", content: "prior turn", timestamp: Date.now() });

		await created.init({ suppressWelcomeIntro: true });

		expect(created.planModeEnabled).toBe(false);
		expect(session?.getPlanModeState()).toBeUndefined();
	});

	it("enters plan mode for a fresh session that carries only startup metadata", async () => {
		// createAgentSession appends model_change / thinking_level_change for a
		// brand-new session before init(); those are not conversation history, so
		// the startup default must still apply (regression: gating on entry count
		// instead of message entries skipped plan mode for every real new session).
		const created = createHarness(Settings.isolated({ "plan.defaultOnStartup": true, "compaction.enabled": false }));
		created.sessionManager.appendModelChange("anthropic/claude-sonnet-4-5");
		created.sessionManager.appendThinkingLevelChange("medium");

		await created.init({ suppressWelcomeIntro: true });

		expect(created.planModeEnabled).toBe(true);
		expect(session?.getPlanModeState()).toMatchObject({ enabled: true });
	});

	it("enters plan mode for a fresh session that carries an extension custom entry", async () => {
		// An extension can persist a custom entry during session_start; that is not
		// conversation or a mode change, so the startup default must still apply
		// (regression: an allowlist of SDK metadata types skipped plan mode here).
		const created = createHarness(Settings.isolated({ "plan.defaultOnStartup": true, "compaction.enabled": false }));
		created.sessionManager.appendModelChange("anthropic/claude-sonnet-4-5");
		created.sessionManager.appendCustomEntry("my-extension-state", { foo: "bar" });

		await created.init({ suppressWelcomeIntro: true });

		expect(created.planModeEnabled).toBe(true);
		expect(session?.getPlanModeState()).toMatchObject({ enabled: true });
	});

	it("does not enter plan mode for a compacted session with no trailing message", async () => {
		// A compacted branch carries summary context (buildSessionContext emits the
		// compaction summary as a message), so it is not fresh even without a literal
		// `message` entry; the startup default must not override its restored mode.
		const created = createHarness(Settings.isolated({ "plan.defaultOnStartup": true, "compaction.enabled": false }));
		created.sessionManager.appendModelChange("anthropic/claude-sonnet-4-5");
		created.sessionManager.appendCompaction("prior conversation summary", undefined, "first-kept", 1000);

		await created.init({ suppressWelcomeIntro: true });

		expect(created.planModeEnabled).toBe(false);
		expect(session?.getPlanModeState()).toBeUndefined();
	});

	it("does not re-enter plan mode when a restored mode_change turned it off (no message yet)", async () => {
		// User enabled plan, toggled it off (mode_change "none"), then quit before
		// sending a turn. On --continue the reconciler restores that off state; the
		// startup default must not override it just because there is no message entry.
		const created = createHarness(Settings.isolated({ "plan.defaultOnStartup": true, "compaction.enabled": false }));
		created.sessionManager.appendModeChange("plan", { planFilePath: "local://PLAN.md" });
		created.sessionManager.appendModeChange("none");

		await created.init({ suppressWelcomeIntro: true });

		expect(created.planModeEnabled).toBe(false);
		expect(session?.getPlanModeState()).toBeUndefined();
	});

	it("does not enter plan mode when plan mode is globally disabled", async () => {
		const created = createHarness(
			Settings.isolated({ "plan.defaultOnStartup": true, "plan.enabled": false, "compaction.enabled": false }),
		);

		await created.init({ suppressWelcomeIntro: true });

		expect(created.planModeEnabled).toBe(false);
		expect(session?.getPlanModeState()).toBeUndefined();
	});
});
