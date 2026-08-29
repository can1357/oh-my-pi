/**
 * Persona session restore: `#reconcileModeFromSession` re-applies a persisted
 * `mode_change` (`mode: "agent"`, `data: { name }`) persona from its CURRENT
 * agent definition on resume, and falls back to a warning (leaving the launch
 * baseline tools/prompt untouched) when the agent is gone, subagent-only, or
 * disabled. Model + thinking are restored by the existing
 * `model_change`/`thinking_level_change` flow in `createAgentSession` and must
 * not be touched by the fallback path.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Effort } from "@oh-my-pi/pi-ai";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { ModelRegistry } from "../src/config/model-registry";
import { applyAgentPersonaOptions, resolveRestorableSessionModel } from "../src/main";
import { InteractiveMode } from "../src/modes/interactive-mode";
import * as discovery from "../src/task/discovery";

function agentMd(name: string, extraFrontmatter: string[] = []): string {
	return ["---", `name: ${name}`, `description: ${name}`, ...extraFrontmatter, "---", `You are ${name}.`].join("\n");
}

/** Session file carrying a restored model/thinking plus a `mode_change` entry. */
async function writePersonaSession(
	sessionFile: string,
	cwd: string,
	data: Record<string, unknown> | undefined,
	mode: string = "agent",
	persistedThinkingLevel: string = "medium",
): Promise<void> {
	const timestamp = "2026-06-01T00:00:00.000Z";
	const entries = [
		{ type: "session", version: 3, id: "persona-session", timestamp, cwd },
		{
			type: "model_change",
			id: "m1",
			parentId: null,
			timestamp,
			model: "anthropic/claude-sonnet-4-5",
			role: "default",
		},
		{
			type: "thinking_level_change",
			id: "t1",
			parentId: "m1",
			timestamp,
			thinkingLevel: persistedThinkingLevel,
			configured: persistedThinkingLevel,
		},
		{ type: "mode_change", id: "mc1", parentId: "t1", timestamp, mode, data },
	];
	await Bun.write(sessionFile, `${entries.map(entry => JSON.stringify(entry)).join("\n")}\n`);
}

describe("InteractiveMode persona session restore", () => {
	let tempHome: string;
	let projectDir: string;
	let agentsDir: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let mode: InteractiveMode | undefined;
	let session: AgentSession | undefined;

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "omp-persona-restore-"));
		projectDir = path.join(tempHome, "project");
		agentsDir = path.join(projectDir, ".omp", "agents");
		await fs.mkdir(agentsDir, { recursive: true });
		await fs.mkdir(path.join(tempHome, "startup"), { recursive: true });
		await Settings.init({ inMemory: true, cwd: projectDir });
		Settings.instance.set("startup.quiet", true);
		authStorage = await AuthStorage.create(path.join(tempHome, "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage, path.join(tempHome, "models.yml"));
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		mode?.stop();
		await session?.dispose();
		authStorage?.close();
		await fs.rm(tempHome, { recursive: true, force: true });
		mode = undefined;
		session = undefined;
		resetSettingsForTest();
	});

	/**
	 * Resume a persisted persona session through the real startup path.
	 * `explicitPersonaOverrides` mirrors the launch CLI override state
	 * (`--model`/`--thinking`/`--tools`) threaded through init options; when
	 * provided, init runs inside the harness so the reconcile sees the state
	 * (the same ordering as the real `runInteractiveMode` → `mode.init` path).
	 */
	async function resumePersonaSession(
		settings: Settings,
		sessionFile: string,
		personaName?: string,
		explicitPersonaOverrides?: { modelSet: boolean; thinkingSet: boolean; toolsSet: boolean },
	): Promise<{ mode: InteractiveMode; session: AgentSession }> {
		const sessionManager = await SessionManager.open(sessionFile, path.join(tempHome, "startup"));
		const options: Parameters<typeof createAgentSession>[0] = {
			cwd: projectDir,
			agentDir: tempHome,
			authStorage,
			modelRegistry,
			sessionManager,
			settings,
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
		// Mirror the launch path's explicit CLI flags (`--model`, `--thinking`,
		// `--tools`): buildSessionOptions applies them to the session options at
		// creation (BEFORE the persona), and the resume reconcile must not
		// re-apply the persona's frontmatter over them.
		if (explicitPersonaOverrides) {
			if (explicitPersonaOverrides.modelSet) {
				options.model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
			}
			if (explicitPersonaOverrides.thinkingSet) {
				options.thinkingLevel = Effort.Medium;
			}
			if (explicitPersonaOverrides.toolsSet) {
				options.toolNames = ["read"];
			}
		}
		// Mirror the launch path: `--agent` applies the persona's frontmatter at
		// session creation (buildSessionOptions → applyAgentPersonaOptions).
		if (personaName) {
			const { agents } = await discovery.discoverAgents(projectDir, tempHome);
			const agent = agents.find(candidate => candidate.name === personaName);
			expect(agent).toBeDefined();
			// Mirror the launch path: `resolveExplicitPersonaOverrides` passes
			// the CLI override state into `applyAgentPersonaOptions`, which
			// sets `personaCliToolOverride` (the `--tools`/`--no-tools`
			// baseline) from `explicit.toolsSet`. On a resume, buildSessionOptions
			// also threads the transcript's restorable model so an unresolvable
			// persona model falls back to the saved model (codex #3758059195).
			const restorableModel = resolveRestorableSessionModel(sessionManager, modelRegistry);
			applyAgentPersonaOptions(
				options,
				agent!,
				explicitPersonaOverrides ?? { modelSet: false, thinkingSet: false, toolsSet: false },
				undefined,
				restorableModel,
			);
			// Marks the session as persona-owned so the SDK captures the baseline
			// tool set (without the persona's `tools:` restriction) for restoration
			// when a non-agent session switch removes the persona.
			options.personaName = personaName;
		}
		const result = await createAgentSession(options);
		const created = new InteractiveMode(result.session, "test");
		if (explicitPersonaOverrides) {
			// Mirror the real startup ordering: `runInteractiveMode` passes the
			// explicit state into `mode.init`, which runs the reconcile.
			await created.init({ suppressWelcomeIntro: true, explicitPersonaOverrides });
		}
		return { mode: created, session: result.session };
	}

	function collectNotices(target: AgentSession): Array<Extract<AgentSessionEvent, { type: "notice" }>> {
		const notices: Array<Extract<AgentSessionEvent, { type: "notice" }>> = [];
		target.subscribe(event => {
			if (event.type === "notice") notices.push(event);
		});
		return notices;
	}

	it(
		"re-applies the persona from its current definition on resume",
		async () => {
			await fs.writeFile(
				path.join(agentsDir, "persona-test.md"),
				agentMd("persona-test", [
					"tools: [read, write]",
					"model: anthropic/claude-haiku-4-5",
					"thinkingLevel: high",
					"spawns: [scout]",
				]),
			);
			const sessionFile = path.join(tempHome, "persona.jsonl");
			await writePersonaSession(sessionFile, projectDir, { name: "persona-test" });

			const created = await resumePersonaSession(Settings.isolated({ "compaction.enabled": false }), sessionFile);
			mode = created.mode;
			session = created.session;
			await created.mode.init({ suppressWelcomeIntro: true });

			expect(session.getEnabledToolNames()).toEqual(["read", "write", "task"]);
			expect(session.model?.id).toBe("claude-haiku-4-5");
			expect(session.configuredThinkingLevel()).toBe(Effort.High);
			expect(session.getSessionSpawns()).toBe("scout");
			expect(session.getPersonaAppendPrompt()).toBe("You are persona-test.");
		},
		{ timeout: 30_000 },
	);

	it(
		"resume with --agent applies the persona frontmatter thinkingLevel over the restored transcript thinking (deferred suffixed-fallback model)",
		async () => {
			// Regression (codex #3760616694): on RESUME with --agent, the
			// persona's frontmatter `thinkingLevel` was ignored when its model
			// list contained a `:level` fallback before an unsuffixed selected
			// model. `applyAgentPersonaOptions` routes through the deferred
			// `personaThinkingLevel` when ANY pattern carries a suffix, and
			// `pickInitialThinkingLevel` consulted that field only AFTER the
			// restored transcript thinking had already filled `level` — so the
			// restored Effort.Low won even though the same persona wins on a
			// new session and with an entirely unsuffixed model list. The
			// persona's explicit launch level must override the restored
			// session thinking, matching the immediate path where it lands
			// directly on `options.thinkingLevel`.
			await fs.writeFile(
				path.join(agentsDir, "persona-test.md"),
				agentMd("persona-test", [
					"tools: [read, write]",
					"model: [nonexistent/model:low, anthropic/claude-haiku-4-5]",
					"thinkingLevel: high",
					"spawns: [scout]",
				]),
			);
			const sessionFile = path.join(tempHome, "persona.jsonl");
			// The transcript carries a persisted `thinking_level_change` (low).
			await writePersonaSession(sessionFile, projectDir, { name: "persona-test" }, "agent", "low");

			const created = await resumePersonaSession(
				Settings.isolated({ "compaction.enabled": false }),
				sessionFile,
				"persona-test",
			);
			mode = created.mode;
			session = created.session;

			// The deferred pattern's `:low` sits on a NON-selected fallback;
			// the selected model (haiku) has no suffix, so the frontmatter
			// `high` must win over the restored Effort.Low.
			expect(session.model?.id).toBe("claude-haiku-4-5");
			expect(session.configuredThinkingLevel()).toBe(Effort.High);
			expect(session.thinkingLevel).toBe(Effort.High);
		},
		{ timeout: 30_000 },
	);

	it(
		"resume without --agent restores the transcript's persisted thinking level",
		async () => {
			// Control: without an explicit launch persona the restored
			// `thinking_level_change` entry wins — the SDK's session-restore
			// path is untouched (existing behavior).
			await fs.writeFile(
				path.join(agentsDir, "persona-test.md"),
				agentMd("persona-test", [
					"tools: [read, write]",
					"model: [nonexistent/model:low, anthropic/claude-haiku-4-5]",
					"thinkingLevel: high",
					"spawns: [scout]",
				]),
			);
			const sessionFile = path.join(tempHome, "persona.jsonl");
			await writePersonaSession(sessionFile, projectDir, { name: "persona-test" }, "agent", "low");

			const created = await resumePersonaSession(Settings.isolated({ "compaction.enabled": false }), sessionFile);
			mode = created.mode;
			session = created.session;

			expect(session.model?.id).toBe("claude-sonnet-4-5");
			expect(session.configuredThinkingLevel()).toBe(Effort.Low);
		},
		{ timeout: 30_000 },
	);

	it(
		"new session with --agent applies the persona frontmatter thinkingLevel with a suffixed-fallback model list",
		async () => {
			// Control: on a NEW session (no persisted thinking) the same
			// persona already applies `high` — the deferred suffixed-fallback
			// path was only broken on resume (codex #3760616694).
			await fs.writeFile(
				path.join(agentsDir, "persona-test.md"),
				agentMd("persona-test", [
					"tools: [read, write]",
					"model: [nonexistent/model:low, anthropic/claude-haiku-4-5]",
					"thinkingLevel: high",
					"spawns: [scout]",
				]),
			);
			// A session file with only a header — no model/thinking/mode entries.
			const sessionFile = path.join(tempHome, "fresh.jsonl");
			await Bun.write(
				sessionFile,
				`${JSON.stringify({ type: "session", version: 3, id: "fresh-session", timestamp: "2026-06-01T00:00:00.000Z", cwd: projectDir })}\n`,
			);

			const created = await resumePersonaSession(
				Settings.isolated({ "compaction.enabled": false }),
				sessionFile,
				"persona-test",
			);
			mode = created.mode;
			session = created.session;

			expect(session.model?.id).toBe("claude-haiku-4-5");
			expect(session.configuredThinkingLevel()).toBe(Effort.High);
		},
		{ timeout: 30_000 },
	);

	it(
		"resume with --agent + explicit --thinking low keeps the CLI level over the persona frontmatter",
		async () => {
			// Control: an explicit `--thinking` CLI flag wins over everything —
			// the persona's frontmatter `high` (deferred via the suffixed
			// fallback) and the restored transcript thinking.
			await fs.writeFile(
				path.join(agentsDir, "persona-test.md"),
				agentMd("persona-test", [
					"tools: [read, write]",
					"model: [nonexistent/model:low, anthropic/claude-haiku-4-5]",
					"thinkingLevel: high",
					"spawns: [scout]",
				]),
			);
			const sessionFile = path.join(tempHome, "persona.jsonl");
			await writePersonaSession(sessionFile, projectDir, { name: "persona-test" }, "agent", "low");

			// `thinkingSet: true` mirrors `--thinking low` (explicit CLI
			// override): it seeds `options.thinkingLevel` in the harness,
			// which `applyAgentPersonaOptions` honors over the frontmatter
			// level.
			const created = await resumePersonaSession(
				Settings.isolated({ "compaction.enabled": false }),
				sessionFile,
				"persona-test",
				{ modelSet: false, thinkingSet: true, toolsSet: false },
			);
			mode = created.mode;
			session = created.session;

			expect(session.model?.id).toBe("claude-haiku-4-5");
			expect(session.configuredThinkingLevel()).toBe(Effort.Medium);
		},
		{ timeout: 30_000 },
	);

	it(
		"keeps explicit CLI model/thinking/tools overrides over the persisted persona on resume",
		async () => {
			// The persona's frontmatter would set haiku/high/[read, write]; the
			// explicit launch overrides (--model sonnet, --thinking medium,
			// --tools read) must win on resume — the reconcile must not re-apply
			// the frontmatter over what createAgentSession already honored.
			await fs.writeFile(
				path.join(agentsDir, "persona-test.md"),
				agentMd("persona-test", [
					"tools: [read, write]",
					"model: anthropic/claude-haiku-4-5",
					"thinkingLevel: high",
					"spawns: [scout]",
				]),
			);
			const sessionFile = path.join(tempHome, "persona.jsonl");
			await writePersonaSession(sessionFile, projectDir, { name: "persona-test" });

			const created = await resumePersonaSession(
				Settings.isolated({ "compaction.enabled": false }),
				sessionFile,
				undefined,
				{ modelSet: true, thinkingSet: true, toolsSet: true },
			);
			mode = created.mode;
			session = created.session;

			// The explicit overrides win: the persona's model/thinking/tools are
			// NOT applied. The persona's non-overridden state (spawns, prompt)
			// still applies.
			expect(session.model?.id).toBe("claude-sonnet-4-5");
			expect(session.configuredThinkingLevel()).toBe(Effort.Medium);
			expect(session.getEnabledToolNames()).toEqual(["read"]);
			expect(session.getSessionSpawns()).toBe("scout");
			expect(session.getPersonaAppendPrompt()).toBe("You are persona-test.");
		},
		{ timeout: 30_000 },
	);

	it(
		"applies the persona's model/thinking/tools when no explicit overrides are passed",
		async () => {
			// Negative control: without explicit overrides the persisted persona
			// IS applied from its current definition on resume.
			await fs.writeFile(
				path.join(agentsDir, "persona-test.md"),
				agentMd("persona-test", [
					"tools: [read, write]",
					"model: anthropic/claude-haiku-4-5",
					"thinkingLevel: high",
					"spawns: [scout]",
				]),
			);
			const sessionFile = path.join(tempHome, "persona.jsonl");
			await writePersonaSession(sessionFile, projectDir, { name: "persona-test" });

			const created = await resumePersonaSession(Settings.isolated({ "compaction.enabled": false }), sessionFile);
			mode = created.mode;
			session = created.session;
			await created.mode.init({ suppressWelcomeIntro: true });

			expect(session.getEnabledToolNames()).toEqual(["read", "write", "task"]);
			expect(session.model?.id).toBe("claude-haiku-4-5");
			expect(session.configuredThinkingLevel()).toBe(Effort.High);
			expect(session.getSessionSpawns()).toBe("scout");
			expect(session.getPersonaAppendPrompt()).toBe("You are persona-test.");
		},
		{ timeout: 30_000 },
	);

	it(
		"keeps the frontmatter thinkingLevel when the persona model has a defaultLevel on resume",
		async () => {
			// kimi-k3 (moonshot) carries `thinking.defaultLevel: max` in the
			// bundled catalog. setModelTemporary with no explicit level
			// re-applies that default, which must NOT clobber the frontmatter
			// `thinkingLevel: high` — the frontmatter level is applied AFTER
			// the model switch (regression: it used to be set before, so the
			// model default overwrote it).
			authStorage.setRuntimeApiKey("moonshot", "test-key");
			await fs.writeFile(
				path.join(agentsDir, "persona-test.md"),
				agentMd("persona-test", [
					"tools: [read, write]",
					"model: moonshot/kimi-k3",
					"thinkingLevel: high",
					"spawns: [scout]",
				]),
			);
			const sessionFile = path.join(tempHome, "persona.jsonl");
			await writePersonaSession(sessionFile, projectDir, { name: "persona-test" });

			const created = await resumePersonaSession(Settings.isolated({ "compaction.enabled": false }), sessionFile);
			mode = created.mode;
			session = created.session;
			await created.mode.init({ suppressWelcomeIntro: true });

			expect(session.model?.id).toBe("kimi-k3");
			expect(session.configuredThinkingLevel()).toBe(Effort.High);
		},
		{ timeout: 30_000 },
	);

	it(
		"applies the model-suffix thinking level, not frontmatter thinkingLevel, on resume",
		async () => {
			// Control: a `:level` suffix on the SELECTED pattern is the more
			// specific selector and wins over the frontmatter `thinkingLevel` —
			// the same precedence the launch path gives it.
			await fs.writeFile(
				path.join(agentsDir, "persona-test.md"),
				agentMd("persona-test", [
					"tools: [read, write]",
					"model: anthropic/claude-sonnet-4-5:low",
					"thinkingLevel: high",
					"spawns: [scout]",
				]),
			);
			const sessionFile = path.join(tempHome, "persona.jsonl");
			await writePersonaSession(sessionFile, projectDir, { name: "persona-test" });

			const created = await resumePersonaSession(Settings.isolated({ "compaction.enabled": false }), sessionFile);
			mode = created.mode;
			session = created.session;
			await created.mode.init({ suppressWelcomeIntro: true });

			expect(session.model?.id).toBe("claude-sonnet-4-5");
			expect(session.configuredThinkingLevel()).toBe(Effort.Low);
		},
		{ timeout: 30_000 },
	);

	it(
		"applies the edited agent definition (not the old snapshot) on resume",
		async () => {
			await fs.writeFile(
				path.join(agentsDir, "persona-test.md"),
				agentMd("persona-test", [
					"tools: [read, write]",
					"model: anthropic/claude-haiku-4-5",
					"thinkingLevel: high",
					"spawns: [scout]",
				]),
			);
			const sessionFile = path.join(tempHome, "persona.jsonl");
			await writePersonaSession(sessionFile, projectDir, { name: "persona-test" });

			const created = await resumePersonaSession(Settings.isolated({ "compaction.enabled": false }), sessionFile);
			mode = created.mode;
			session = created.session;
			await created.mode.init({ suppressWelcomeIntro: true });
			expect(session.getEnabledToolNames()).toEqual(["read", "write", "task"]);

			// Edit the agent file: tools change from [read, write] to [read].
			await fs.writeFile(
				path.join(agentsDir, "persona-test.md"),
				agentMd("persona-test", [
					"tools: [read]",
					"model: anthropic/claude-haiku-4-5",
					"thinkingLevel: high",
					"spawns: [scout]",
				]),
			);

			// Re-resume the same session file: the persona must be re-discovered
			// fresh and the CURRENT definition applied.
			await expect(session.switchSession(sessionFile)).resolves.toBe(true);

			expect(session.getEnabledToolNames()).toEqual(["read", "task"]);
			expect(session.getPersonaAppendPrompt()).toBe("You are persona-test.");
		},
		{ timeout: 30_000 },
	);

	it(
		"emits a warning and keeps the launch baseline when the agent is gone",
		async () => {
			await fs.writeFile(
				path.join(agentsDir, "persona-test.md"),
				agentMd("persona-test", [
					"tools: [read, write]",
					"model: anthropic/claude-haiku-4-5",
					"thinkingLevel: high",
					"spawns: [scout]",
				]),
			);
			const sessionFile = path.join(tempHome, "persona.jsonl");
			await writePersonaSession(sessionFile, projectDir, { name: "persona-test" });

			// Delete the agent file before resume.
			await fs.rm(path.join(agentsDir, "persona-test.md"));

			const created = await resumePersonaSession(Settings.isolated({ "compaction.enabled": false }), sessionFile);
			mode = created.mode;
			session = created.session;
			const notices = collectNotices(session);

			await created.mode.init({ suppressWelcomeIntro: true });

			expect(
				notices.some(
					notice =>
						notice.level === "warning" && notice.message.includes('Agent "persona-test" is no longer available'),
				),
			).toBe(true);
			// Launch baseline tools/prompt untouched.
			expect(session.getEnabledToolNames()).toEqual(["read", "write"]);
			expect(session.getPersonaAppendPrompt()).toBeUndefined();
			expect(session.getSessionSpawns()).toBeNull();
			// Model + thinking restored from the session log.
			expect(session.model?.id).toBe("claude-sonnet-4-5");
			expect(session.configuredThinkingLevel()).toBe(Effort.Medium);
		},
		{ timeout: 30_000 },
	);

	it(
		"returns silently when the mode data has no agent name",
		async () => {
			const sessionFile = path.join(tempHome, "persona.jsonl");
			await writePersonaSession(sessionFile, projectDir, undefined);

			const created = await resumePersonaSession(Settings.isolated({ "compaction.enabled": false }), sessionFile);
			mode = created.mode;
			session = created.session;
			const notices = collectNotices(session);

			await created.mode.init({ suppressWelcomeIntro: true });

			expect(notices.some(notice => notice.message.includes("no longer available"))).toBe(false);
			expect(session.getEnabledToolNames()).toEqual(["read", "write"]);
			expect(session.getPersonaAppendPrompt()).toBeUndefined();
		},
		{ timeout: 30_000 },
	);

	it(
		"warns and keeps the baseline when the agent became subagent-only",
		async () => {
			await fs.writeFile(path.join(agentsDir, "persona-test.md"), agentMd("persona-test", ["mode: subagent"]));
			const sessionFile = path.join(tempHome, "persona.jsonl");
			await writePersonaSession(sessionFile, projectDir, { name: "persona-test" });

			const created = await resumePersonaSession(Settings.isolated({ "compaction.enabled": false }), sessionFile);
			mode = created.mode;
			session = created.session;
			const notices = collectNotices(session);

			await created.mode.init({ suppressWelcomeIntro: true });

			expect(
				notices.some(
					notice =>
						notice.level === "warning" && notice.message.includes('Agent "persona-test" is no longer available'),
				),
			).toBe(true);
			expect(session.getEnabledToolNames()).toEqual(["read", "write"]);
			expect(session.getPersonaAppendPrompt()).toBeUndefined();
		},
		{ timeout: 30_000 },
	);

	it(
		"warns and keeps the baseline when the agent is disabled in settings",
		async () => {
			await fs.writeFile(
				path.join(agentsDir, "persona-test.md"),
				agentMd("persona-test", [
					"tools: [read, write]",
					"model: anthropic/claude-haiku-4-5",
					"thinkingLevel: high",
					"spawns: [scout]",
				]),
			);
			const sessionFile = path.join(tempHome, "persona.jsonl");
			await writePersonaSession(sessionFile, projectDir, { name: "persona-test" });

			const created = await resumePersonaSession(
				Settings.isolated({ "compaction.enabled": false, "task.disabledAgents": ["persona-test"] }),
				sessionFile,
			);
			mode = created.mode;
			session = created.session;
			const notices = collectNotices(session);

			await created.mode.init({ suppressWelcomeIntro: true });

			expect(
				notices.some(
					notice =>
						notice.level === "warning" && notice.message.includes('Agent "persona-test" is no longer available'),
				),
			).toBe(true);
			expect(session.getEnabledToolNames()).toEqual(["read", "write"]);
			expect(session.getPersonaAppendPrompt()).toBeUndefined();
		},
		{ timeout: 30_000 },
	);

	it(
		"keeps the restored model when the persona model pattern does not resolve",
		async () => {
			await fs.writeFile(
				path.join(agentsDir, "persona-test.md"),
				agentMd("persona-test", [
					"tools: [read, write]",
					"model: nonexistent/model",
					"thinkingLevel: high",
					"spawns: [scout]",
				]),
			);
			const sessionFile = path.join(tempHome, "persona.jsonl");
			await writePersonaSession(sessionFile, projectDir, { name: "persona-test" });

			const created = await resumePersonaSession(Settings.isolated({ "compaction.enabled": false }), sessionFile);
			mode = created.mode;
			session = created.session;
			const notices = collectNotices(session);

			await created.mode.init({ suppressWelcomeIntro: true });

			// Model stays the restored one; no warning on restore.
			expect(session.model?.id).toBe("claude-sonnet-4-5");
			expect(notices.some(notice => notice.level === "warning")).toBe(false);
			// The rest of the persona still applies.
			expect(session.getEnabledToolNames()).toEqual(["read", "write", "task"]);
			expect(session.configuredThinkingLevel()).toBe(Effort.High);
			expect(session.getPersonaAppendPrompt()).toBe("You are persona-test.");
		},
		{ timeout: 30_000 },
	);

	it(
		"launch --agent with an unresolvable persona model falls back to the transcript's saved model on resume",
		async () => {
			// Regression (codex #3758059195): on --continue/--resume with
			// --agent, buildSessionOptions skips startup model defaults
			// (restoringSession), so applyAgentPersonaOptions records no
			// modelPatternFallbackModel when it defers the persona's model
			// pattern. The deferred pattern then suppresses the SDK's
			// session-model restore (hasExplicitModel), leaving the resumed
			// session with NO model when the persona pattern does not resolve.
			// The transcript's restorable model must be preserved as the
			// fallback — the resume equivalent of the launch path's
			// startup-default fallback.
			await fs.writeFile(
				path.join(agentsDir, "persona-test.md"),
				agentMd("persona-test", [
					"tools: [read, write]",
					"model: nonexistent/model",
					"thinkingLevel: high",
					"spawns: [scout]",
				]),
			);
			const sessionFile = path.join(tempHome, "persona.jsonl");
			await writePersonaSession(sessionFile, projectDir, { name: "persona-test" });

			const created = await resumePersonaSession(
				Settings.isolated({ "compaction.enabled": false }),
				sessionFile,
				"persona-test",
			);
			mode = created.mode;
			session = created.session;

			// The persona's model pattern does not resolve; the transcript's
			// saved model (claude-sonnet-4-5) is the fallback — NOT undefined,
			// NOT a crash.
			expect(session.model?.id).toBe("claude-sonnet-4-5");
			// The rest of the persona still applies.
			expect(session.getEnabledToolNames()).toEqual(["read", "write", "task"]);
			expect(session.getPersonaAppendPrompt()).toBe("You are persona-test.");
		},
		{ timeout: 30_000 },
	);

	it(
		"launch --agent with a resolvable persona model wins over the transcript's saved model on resume",
		async () => {
			// Control: a resolvable persona model pattern must win over the
			// saved model on resume — the fallback is only used when the
			// persona's pattern fails to resolve.
			await fs.writeFile(
				path.join(agentsDir, "persona-test.md"),
				agentMd("persona-test", [
					"tools: [read, write]",
					"model: anthropic/claude-haiku-4-5",
					"thinkingLevel: high",
					"spawns: [scout]",
				]),
			);
			const sessionFile = path.join(tempHome, "persona.jsonl");
			await writePersonaSession(sessionFile, projectDir, { name: "persona-test" });

			const created = await resumePersonaSession(
				Settings.isolated({ "compaction.enabled": false }),
				sessionFile,
				"persona-test",
			);
			mode = created.mode;
			session = created.session;

			expect(session.model?.id).toBe("claude-haiku-4-5");
		},
		{ timeout: 30_000 },
	);

	it(
		"resume without --agent restores the transcript's saved model",
		async () => {
			// Control: without --agent the SDK's session-model restore path is
			// untouched — the saved model is restored (existing behavior).
			await fs.writeFile(
				path.join(agentsDir, "persona-test.md"),
				agentMd("persona-test", ["tools: [read, write]", "model: nonexistent/model"]),
			);
			const sessionFile = path.join(tempHome, "persona.jsonl");
			await writePersonaSession(sessionFile, projectDir, { name: "persona-test" });

			const created = await resumePersonaSession(Settings.isolated({ "compaction.enabled": false }), sessionFile);
			mode = created.mode;
			session = created.session;

			expect(session.model?.id).toBe("claude-sonnet-4-5");
		},
		{ timeout: 30_000 },
	);

	it("swallows discovery failures and keeps the baseline", async () => {
		await fs.writeFile(path.join(agentsDir, "persona-test.md"), agentMd("persona-test", ["tools: [read, write]"]));
		const sessionFile = path.join(tempHome, "persona.jsonl");
		await writePersonaSession(sessionFile, projectDir, { name: "persona-test" });

		const created = await resumePersonaSession(Settings.isolated({ "compaction.enabled": false }), sessionFile);
		mode = created.mode;
		session = created.session;
		const notices = collectNotices(session);

		const spy = vi.spyOn(discovery, "discoverAgents").mockRejectedValue(new Error("boom"));
		await created.mode.init({ suppressWelcomeIntro: true });
		spy.mockRestore();

		expect(notices).toEqual([]);
		expect(session.getEnabledToolNames()).toEqual(["read", "write"]);
		expect(session.getPersonaAppendPrompt()).toBeUndefined();
	});

	it(
		"launch --agent persona suppresses plan.defaultOnStartup and restored modes",
		async () => {
			// The persona is applied at session creation (buildSessionOptions); init
			// must not re-enter plan mode (defaultOnStartup) or a restored mode on
			// top of it — the transcript would claim the persona while the session
			// runs under the other mode.
			await fs.writeFile(
				path.join(agentsDir, "persona-test.md"),
				agentMd("persona-test", ["tools: [read, write]", "model: anthropic/claude-haiku-4-5"]),
			);
			const sessionFile = path.join(tempHome, "persona.jsonl");
			await writePersonaSession(sessionFile, projectDir, { name: "persona-test" });

			const created = await resumePersonaSession(
				Settings.isolated({ "compaction.enabled": false, "plan.enabled": true, "plan.defaultOnStartup": true }),
				sessionFile,
				"persona-test",
			);
			mode = created.mode;
			session = created.session;
			await created.mode.init({ suppressWelcomeIntro: true, personaName: "persona-test" });

			// Persona applied, plan mode NOT entered. (The persona's system prompt
			// lands in the mutable persona channel via applyAgentPersonaOptions —
			// the same channel live switch and reconcile use — so a later /agent
			// switch replaces it rather than stacking both personas.)
			expect(session.getEnabledToolNames()).toEqual(["read", "write"]);
			expect(session.model?.id).toBe("claude-haiku-4-5");
			expect(session.getPlanModeState()).toBeUndefined();
		},
		{ timeout: 30_000 },
	);

	it("clears persona state when a goal session (goal.enabled false) is reconciled", async () => {
		// Regression: the persona reset (spawns/prompt/baseline tools) used to
		// live only in the fall-through path of #reconcileModeFromSession. The
		// goal.enabled=false early-return branch (which appends "none" and
		// returns) ran BEFORE it, so a persona session resumed into a goal
		// target kept the persona's spawn policy, prompt, and restricted tools.
		await fs.writeFile(
			path.join(agentsDir, "persona-test.md"),
			agentMd("persona-test", [
				"tools: [read]",
				"model: anthropic/claude-haiku-4-5",
				"thinkingLevel: high",
				"spawns: [scout]",
			]),
		);
		// Apply the persona at creation (launch `--agent` path) so the SDK
		// seeds the baseline tool set and the persona's mutable state.
		const sessionFile = path.join(tempHome, "persona.jsonl");
		await writePersonaSession(sessionFile, projectDir, undefined, "goal");
		const created = await resumePersonaSession(
			Settings.isolated({ "compaction.enabled": false, "goal.enabled": false }),
			sessionFile,
			"persona-test",
		);
		mode = created.mode;
		session = created.session;

		// The persona's restricted toolset and prompt are live before reconcile
		// runs (the launch path seeds the prompt channel; the spawn policy
		// lives in the SDK options closure, so the session field is null until
		// a live switch populates it).
		expect(session.getEnabledToolNames()).toEqual(["read", "task"]);
		expect(session.getPersonaAppendPrompt()).toBe("You are persona-test.");
		const baseline = session.getBaselineToolNames();
		expect(baseline).toBeDefined();
		// Baseline = the full registry (every allowed built-in), NOT the
		// persona's restricted [read] — leaving agent mode must restore the
		// wider set. The registry is expanded at launch (personaName set), so
		// bash/write/etc. are all present.
		expect(baseline).toEqual(expect.arrayContaining(["read", "write", "bash"]));
		expect(baseline).not.toContain("goal");
		const baselineTools = baseline!;

		// Init WITHOUT personaName: the session file's last mode_change is
		// "goal" and goal.enabled is false, so reconcile appends "none" and
		// returns via the early branch — which must still clear persona state.
		await created.mode.init({ suppressWelcomeIntro: true });

		expect(session.getSessionSpawns()).toBeNull();
		expect(session.getPersonaAppendPrompt()).toBeUndefined();
		// The baseline is restored; discoverable tools are presented under
		// `xd://` (the default presentation), so the enabled set is a superset
		// of the baseline names.
		expect(session.getEnabledToolNames()).toEqual(expect.arrayContaining(baselineTools));
		// The stale goal mode was cleared to "none".
		const entries = session.sessionManager.getEntries();
		const lastModeChange = [...entries].reverse().find(entry => entry.type === "mode_change");
		expect(lastModeChange?.type === "mode_change" && lastModeChange.mode).toBe("none");
	});

	it(
		"re-captures the baseline for the target transcript on a session switch",
		async () => {
			// Regression (codex wave-16 P2): switchSession() reuses the same
			// AgentSession for a different transcript, but the first-write
			// guard in setBaselineToolNames kept the baseline captured by the
			// PREVIOUS logical session. A launch `--tools read` (toolsSet)
			// baseline of ["read"] used to leak into the target: the reconciler
			// restored the stale CLI list instead of the target's normal tool
			// set. The baseline must be re-captured from the registry on a
			// logical session switch, clamped to the explicit CLI grant.
			await fs.writeFile(path.join(agentsDir, "persona-test.md"), agentMd("persona-test", ["tools: [read, write]"]));
			const sessionFile = path.join(tempHome, "persona.jsonl");
			await writePersonaSession(sessionFile, projectDir, { name: "persona-test" });
			// Target session with no persona (mode "none").
			const targetFile = path.join(tempHome, "target.jsonl");
			await writePersonaSession(targetFile, projectDir, undefined, "none");

			const created = await resumePersonaSession(
				Settings.isolated({ "compaction.enabled": false }),
				sessionFile,
				"persona-test",
				{ modelSet: false, thinkingSet: false, toolsSet: true },
			);
			mode = created.mode;
			session = created.session;

			// Launch baseline honors the explicit CLI `--tools read` override.
			expect(session.getBaselineToolNames()).toEqual(["read"]);
			expect(session.getEnabledToolNames()).toEqual(["read"]);

			// In-process switch to the non-agent target: the baseline is
			// re-captured from the registry for the new transcript, but the
			// explicit CLI grant bounds the recapture (de-novo review P1) — an
			// unrestricted re-capture would let the non-agent reconciler's
			// restoreBaselineTools() enable bash/write past the user's
			// `--tools read`.
			await expect(session.switchSession(targetFile)).resolves.toBe(true);

			const baseline = session.getBaselineToolNames();
			expect(baseline).toEqual(["read"]);
			// The target's active set stays within the CLI grant.
			expect(session.getEnabledToolNames()).toEqual(["read"]);
		},
		{ timeout: 30_000 },
	);

	it(
		"clears the persona-dropped-mutation flag on a session switch to a non-agent target",
		async () => {
			// De-novo review (P1): switchSession() re-captures the baseline
			// for a different transcript, but the SDK's
			// `personaDroppedMutation` flag (the read-only persona's
			// revocation of the Cursor `editWasGranted` floor) was not reset
			// — it leaked from the source session into the target. The
			// re-capture now clears the flag (the reconciler below re-signals
			// the target's real persona state, or the baseline restore clears
			// it through `restoreBaselineTools` anyway).
			await fs.writeFile(path.join(agentsDir, "persona-test.md"), agentMd("persona-test", ["tools: [read, write]"]));
			const sessionFile = path.join(tempHome, "persona.jsonl");
			await writePersonaSession(sessionFile, projectDir, { name: "persona-test" });
			// Target session with no persona (mode "none").
			const targetFile = path.join(tempHome, "target.jsonl");
			await writePersonaSession(targetFile, projectDir, undefined, "none");

			const created = await resumePersonaSession(
				Settings.isolated({ "compaction.enabled": false }),
				sessionFile,
				"persona-test",
			);
			mode = created.mode;
			session = created.session;

			// Init WITHOUT personaName: the reconcile path runs (no launch-persona
			// short-circuit) and re-applies the persona from the first session file.
			await created.mode.init({ suppressWelcomeIntro: true });
			expect(session.getEnabledToolNames()).toEqual(["read", "write"]);

			// Switch to a READ-ONLY persona so the Cursor `editWasGranted`
			// floor is revoked, then simulate a session switch to the
			// non-agent target: the revocation must not carry over.
			await session.applyPersonaTools(["read"]);
			expect(session.getLastPersonaDroppedMutation()).toBe(true);

			await expect(session.switchSession(targetFile)).resolves.toBe(true);

			expect(session.getLastPersonaDroppedMutation()).toBe(false);
			expect(session.getSessionSpawns()).toBeNull();
			expect(session.getPersonaAppendPrompt()).toBeUndefined();
			const baseline = session.getBaselineToolNames();
			expect(baseline).toEqual(expect.arrayContaining(["read", "write", "bash"]));
		},
		{ timeout: 30_000 },
	);

	it(
		"clears the previous persona's state when the target session's agent is unavailable",
		async () => {
			// Regression: switching in-process from a persona session to another
			// session whose persisted agent is gone used to leave the PREVIOUS
			// persona's tools/spawns/prompt active in the target transcript — the
			// else branch of #reconcilePersonaFromSession only emitted a warning.
			await fs.writeFile(
				path.join(agentsDir, "persona-test.md"),
				agentMd("persona-test", [
					"tools: [read]",
					"model: anthropic/claude-haiku-4-5",
					"thinkingLevel: high",
					"spawns: [scout]",
				]),
			);
			const sessionFile = path.join(tempHome, "persona.jsonl");
			await writePersonaSession(sessionFile, projectDir, { name: "persona-test" });
			// Target session whose mode_change names an agent that does NOT exist
			// on disk.
			const targetFile = path.join(tempHome, "target.jsonl");
			await writePersonaSession(targetFile, projectDir, { name: "ghost-agent" });

			const created = await resumePersonaSession(
				Settings.isolated({ "compaction.enabled": false }),
				sessionFile,
				"persona-test",
			);
			mode = created.mode;
			session = created.session;
			const notices = collectNotices(session);

			// Init WITHOUT personaName: the reconcile path runs (no launch-persona
			// short-circuit) and re-applies the persona from the first session file.
			await created.mode.init({ suppressWelcomeIntro: true });
			expect(session.getEnabledToolNames()).toEqual(["read", "task"]);
			expect(session.getSessionSpawns()).toBe("scout");
			expect(session.getPersonaAppendPrompt()).toBe("You are persona-test.");
			const baseline = session.getBaselineToolNames();
			// Baseline = the full registry (every allowed built-in), NOT the
			// persona's restricted [read] — leaving agent mode must restore the
			// wider set.
			expect(baseline).toEqual(expect.arrayContaining(["read", "write", "bash"]));

			// In-process switch to the target: the persisted persona is missing, so
			// the previous session's persona-owned state must be cleared.
			await expect(session.switchSession(targetFile)).resolves.toBe(true);

			expect(session.getSessionSpawns()).toBeNull();
			expect(session.getPersonaAppendPrompt()).toBeUndefined();
			expect(session.getEnabledToolNames()).toEqual(expect.arrayContaining(baseline!));
			expect(
				notices.some(
					notice =>
						notice.level === "warning" && notice.message.includes('Agent "ghost-agent" is no longer available'),
				),
			).toBe(true);
		},
		{ timeout: 30_000 },
	);

	it(
		"keeps the persona state intact when the baseline restoration fails during a live /plan entry",
		async () => {
			// Regression (codex #3821198710): #clearPersonaOwnedState used to
			// clear the spawns/prompt BEFORE restoring the baseline, so a
			// failed restoration (e.g. a system-prompt rebuild error) left a
			// half-cleared persona — spawns/prompt gone while the restricted
			// tools and the persisted `mode_change: agent` remained. The clear
			// now runs only after the restoration succeeds.
			await fs.writeFile(
				path.join(agentsDir, "persona-test.md"),
				agentMd("persona-test", [
					"tools: [read]",
					"model: anthropic/claude-haiku-4-5",
					"thinkingLevel: high",
					"spawns: [scout]",
				]),
			);
			const sessionFile = path.join(tempHome, "persona.jsonl");
			await writePersonaSession(sessionFile, projectDir, { name: "persona-test" });

			const created = await resumePersonaSession(
				Settings.isolated({ "compaction.enabled": false, "plan.enabled": true }),
				sessionFile,
				"persona-test",
			);
			mode = created.mode;
			session = created.session;
			await created.mode.init({ suppressWelcomeIntro: true });
			expect(session.getSessionSpawns()).toBe("scout");
			expect(session.getPersonaAppendPrompt()).toBe("You are persona-test.");

			// The baseline restoration fails: the persona state must survive.
			vi.spyOn(session, "restoreBaselineTools").mockRejectedValueOnce(new Error("prompt rebuild failed"));
			await expect(created.mode.handlePlanModeCommand()).rejects.toThrow("prompt rebuild failed");

			expect(session.getSessionSpawns()).toBe("scout");
			expect(session.getPersonaAppendPrompt()).toBe("You are persona-test.");
			expect(session.getEnabledToolNames()).toEqual(["read", "task"]);
		},
		{ timeout: 30_000 },
	);
	it(
		"clears to a coherent non-persona baseline when the persona apply fails during a session switch",
		async () => {
			// Wave-21 P2 (codex #3821198710): switchSession catches reconciler
			// errors and still commits the target, so a failed persona apply
			// must NOT leave the committed target under the SOURCE persona's
			// snapshot (tools/spawns/prompt). The reconcile now clears the
			// persona-owned state to a coherent non-persona baseline instead.
			await fs.writeFile(
				path.join(agentsDir, "persona-test.md"),
				agentMd("persona-test", [
					"tools: [read, write]",
					"model: anthropic/claude-haiku-4-5",
					"thinkingLevel: high",
					"spawns: [scout]",
				]),
			);
			const sessionFile = path.join(tempHome, "persona.jsonl");
			await writePersonaSession(sessionFile, projectDir, { name: "persona-test" });
			// Target session with the same persona (mode "agent").
			const targetFile = path.join(tempHome, "target.jsonl");
			await writePersonaSession(targetFile, projectDir, { name: "persona-test" });

			const created = await resumePersonaSession(
				Settings.isolated({ "compaction.enabled": false }),
				sessionFile,
				"persona-test",
			);
			mode = created.mode;
			session = created.session;
			await created.mode.init({ suppressWelcomeIntro: true });
			expect(session.getSessionSpawns()).toBe("scout");
			expect(session.getPersonaAppendPrompt()).toBe("You are persona-test.");

			// The persona apply fails during the switch reconcile (the final
			// system-prompt rebuild rejects). switchSession catches the error
			// and still commits the target.
			vi.spyOn(session, "refreshBaseSystemPrompt").mockRejectedValueOnce(new Error("prompt rebuild failed"));
			await expect(session.switchSession(targetFile)).resolves.toBe(true);

			// The committed target must NOT run the source persona's state:
			// the reconcile cleared spawns/prompt and restored the baseline.
			expect(session.getSessionSpawns()).toBeNull();
			expect(session.getPersonaAppendPrompt()).toBeUndefined();
			const baseline = session.getBaselineToolNames();
			expect(baseline).toEqual(expect.arrayContaining(["read", "write", "bash"]));
			expect(session.getEnabledToolNames()).toEqual(expect.arrayContaining(baseline!));
		},
		{ timeout: 30_000 },
	);
});
