/**
 * Print/RPC persona persistence: `omp --print --agent X` and `omp --mode rpc
 * --agent X` must persist a `mode_change` entry (`mode: "agent"`, `data:
 * { name }`) on the session manager so a later resume/fork re-applies the
 * persona. The interactive branch already persists via runInteractiveMode's
 * personaName param; this covers the two branch-only runners in
 * runRootCommand (src/main.ts).
 *
 * The resume half covers the branch-only reconcile
 * (`reconcilePersistedPersona` in src/main.ts, which mirrors
 * InteractiveMode.#reconcilePersonaFromSession): `--continue` must re-apply a
 * PERSISTED persona (last `mode_change` is `agent`) to the session's tools,
 * spawns, prompt, and (unless explicitly overridden) model/thinking — the
 * InteractiveMode.init reconcile never runs in rpc/print.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Effort } from "@oh-my-pi/pi-ai";
import { type Args, parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { runRootCommand } from "@oh-my-pi/pi-coding-agent/main";
import * as printModeModule from "@oh-my-pi/pi-coding-agent/modes/print-mode";
import * as rpcModeModule from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import type { CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { getProjectDir, postmortem, setProjectDir, TempDir } from "@oh-my-pi/pi-utils";

const MYAGENT_MD = [
	"---",
	"name: myagent",
	"description: Test main-session persona agent.",
	"---",
	"You are the myagent persona.",
].join("\n");

/** Rich persona frontmatter: every persona-owned field the reconcile applies. */
const PERSONA_MD = [
	"---",
	"name: myagent",
	"description: Test main-session persona agent.",
	"tools: [read, write]",
	"model: anthropic/claude-haiku-4-5",
	"thinkingLevel: high",
	"spawns: [scout]",
	"---",
	"You are the myagent persona.",
].join("\n");

/** State-tracking fake session: the persona reconcile mutates it through the
 * same AgentSession surface (`setSessionSpawns`, `setPersonaAppendPrompt`,
 * `setActiveToolsByName`, `setModelTemporary`, …) and assertions read it back
 * through the matching accessors. */
function makeFakeSession(
	sessionManager: SessionManager,
	authStorage: AuthStorage,
	seed: { enabledTools?: string[]; spawns?: string | null; personaPrompt?: string | undefined } = {},
): AgentSession & { state: { enabledTools: string[]; spawns: string | null; personaPrompt: string | undefined } } {
	const state = {
		enabledTools: seed.enabledTools ?? [],
		spawns: seed.spawns ?? null,
		personaPrompt: seed.personaPrompt,
	};
	return {
		state,
		sessionManager,
		settings: Settings.isolated({}),
		modelRegistry: new ModelRegistry(authStorage),
		// The non-interactive branch exits unless the session has a model.
		model: {},
		dispose: async () => {},
		getEnabledToolNames: () => state.enabledTools,
		getAllToolNames: () => state.enabledTools,
		getMountedXdevToolNames: () => [],
		setBaselineToolNames: () => {},
		setBaselineMountedToolNames: () => {},
		restoreBaselineTools: async () => {},
		setActiveToolsByName: async (names: string[]) => {
			state.enabledTools = [...names];
		},
		applyPersonaTools: async (names: string[]) => {
			state.enabledTools = [...names];
		},
		setThinkingLevel: () => {},
		setSessionSpawns: (spawns: string | null) => {
			state.spawns = spawns;
		},
		setModelTemporary: async () => {},
		getSessionSpawns: () => state.spawns,
		setPersonaAppendPrompt: (prompt: string | undefined) => {
			state.personaPrompt = prompt;
		},
		getPersonaAppendPrompt: () => state.personaPrompt,
		// Mirrors the real AgentSession.clearPersonaOwnedState contract: no-op
		// unless a persona is active, then restoreBaselineTools → clears →
		// refreshBaseSystemPrompt, in that order.
		clearPersonaOwnedState: async () => {
			if (state.personaPrompt === undefined && state.spawns === null) return;
			state.spawns = null;
			state.personaPrompt = undefined;
		},
		refreshBaseSystemPrompt: async () => {},
		emitNotice: () => {},
		getLastPersonaDroppedMutation: () => undefined,
		getLastPersonaDroppedEdit: () => undefined,
		getPersonaToolRestriction: () => undefined,
		setPersonaToolRestriction: () => {},
		getBaselineToolNames: () => undefined,
		getBaselineMountedToolNames: () => undefined,
		clearBaselineTools: () => {},
		configuredThinkingLevel: () => undefined,
		setActiveToolPresentation: async () => {},
		isStreaming: false,
	} as unknown as AgentSession & { state: typeof state };
}

describe("runRootCommand — print/rpc persona persistence", () => {
	let originalProjectDir: string;
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let sessionManager: SessionManager;
	let capturedOptionsManager: SessionManager | undefined;

	beforeEach(async () => {
		originalProjectDir = getProjectDir();
		tempDir = TempDir.createSync("@omp-print-rpc-persona-");
		fs.mkdirSync(path.join(tempDir.path(), ".omp", "agents"), { recursive: true });
		fs.writeFileSync(path.join(tempDir.path(), ".omp", "agents", "myagent.md"), MYAGENT_MD);
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		// The print branch of runRootCommand ends with `postmortem.quit(0)`. The
		// tests stub `process.exit`, so the exit never happens — but the real
		// `quit` still flips the process-global postmortem state to "complete",
		// and every later `postmortem.register` (e.g. InteractiveMode.init's
		// session-teardown callback) then fires its cleanup immediately,
		// disposing sessions that are still in use. Stub `quit` so the global
		// teardown never runs inside the test process (same approach as
		// cli-completions-exit.test.ts / commit-command-exit.test.ts).
		vi.spyOn(postmortem, "quit").mockResolvedValue(undefined);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		authStorage.close();
		await sessionManager.close();
		await capturedOptionsManager?.close();
		capturedOptionsManager = undefined;
		setProjectDir(originalProjectDir);
		tempDir.removeSync();
	});

	async function runRoot(rawArgs: string[], parsed: Args, session?: AgentSession): Promise<AgentSession> {
		const fakeSession = session ?? makeFakeSession(sessionManager, authStorage);
		await runRootCommand(parsed, rawArgs, {
			discoverAuthStorage: async () => authStorage,
			settings: Settings.isolated({ "marketplace.autoUpdate": "off" }),
			createAgentSession: async options => {
				if (!options) throw new Error("Expected session options");
				capturedOptionsManager = options.sessionManager;
				return {
					session: fakeSession,
					extensionsResult: {
						extensions: [],
						errors: [],
						runner: undefined,
					} as unknown as CreateAgentSessionResult["extensionsResult"],
					setToolUIContext: () => {},
					eventBus: {
						emit: () => {},
						on: () => () => {},
						off: () => {},
					} as unknown as CreateAgentSessionResult["eventBus"],
				} as CreateAgentSessionResult;
			},
		});
		return fakeSession;
	}

	function parsedFor(rawArgs: string[], options: { noTools?: boolean } = {}): Args {
		const parsed = parseArgs(rawArgs);
		parsed.noExtensions = true;
		parsed.noSkills = true;
		parsed.noRules = true;
		// Default to --no-tools for the harness (matches the original tests);
		// resume tests pass `noTools: false` because a real `--continue` carries
		// no `--no-tools` flag, so the persona's `tools:` frontmatter must apply.
		parsed.noTools = options.noTools ?? true;
		parsed.noLsp = true;
		parsed.sessionDir = tempDir.path();
		parsed.cwd = tempDir.path();
		return parsed;
	}

	function agentModeChange() {
		return sessionManager
			.getEntries()
			.find(
				(entry): entry is Extract<typeof entry, { type: "mode_change" }> =>
					entry.type === "mode_change" && entry.mode === "agent",
			);
	}

	/** Session file whose last mode_change is `agent { name }`, like the interactive restore tests. */
	function writePersonaSession(sessionFile: string, data: Record<string, unknown> | undefined): void {
		const timestamp = "2026-06-01T00:00:00.000Z";
		const entries = [
			{ type: "session", version: 3, id: "persona-session", timestamp, cwd: tempDir.path() },
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
				thinkingLevel: "medium",
				configured: "medium",
			},
			{ type: "mode_change", id: "mc1", parentId: "t1", timestamp, mode: "agent", data },
		];
		fs.writeFileSync(sessionFile, `${entries.map(entry => JSON.stringify(entry)).join("\n")}\n`);
	}

	/** Point the harness session manager at a pre-written session file (resume). */
	async function wireResumedSession(sessionFile: string): Promise<void> {
		await sessionManager.setSessionFile(sessionFile);
	}

	it("persists an agent mode_change for --print --agent", async () => {
		vi.spyOn(printModeModule, "runPrintMode").mockResolvedValue(undefined);
		vi.spyOn(process, "exit").mockImplementation((() => {}) as typeof process.exit);

		const rawArgs = ["--print", "--agent", "myagent"];
		await runRoot(rawArgs, parsedFor(rawArgs));

		const modeChange = agentModeChange();
		expect(modeChange).toBeDefined();
		expect(modeChange?.data).toEqual({ name: "myagent" });
	});

	it("does not append an agent mode_change without --agent", async () => {
		vi.spyOn(printModeModule, "runPrintMode").mockResolvedValue(undefined);
		vi.spyOn(process, "exit").mockImplementation((() => {}) as typeof process.exit);

		const rawArgs = ["--print"];
		await runRoot(rawArgs, parsedFor(rawArgs));

		expect(sessionManager.getEntries().some(entry => entry.type === "mode_change" && entry.mode === "agent")).toBe(
			false,
		);
	});

	it("persists an agent mode_change for --mode rpc --agent", async () => {
		vi.spyOn(rpcModeModule, "runRpcMode").mockResolvedValue(undefined as never);

		const rawArgs = ["--mode", "rpc", "--agent", "myagent"];
		await runRoot(rawArgs, parsedFor(rawArgs));

		const modeChange = agentModeChange();
		expect(modeChange).toBeDefined();
		expect(modeChange?.data).toEqual({ name: "myagent" });
	});

	it("reapplies a persisted persona on --print --continue", async () => {
		vi.spyOn(printModeModule, "runPrintMode").mockResolvedValue(undefined);
		vi.spyOn(process, "exit").mockImplementation((() => {}) as typeof process.exit);
		fs.writeFileSync(path.join(tempDir.path(), ".omp", "agents", "myagent.md"), PERSONA_MD);

		const sessionFile = path.join(tempDir.path(), "session.jsonl");
		writePersonaSession(sessionFile, { name: "myagent" });
		await wireResumedSession(sessionFile);

		const session = await runRoot(
			["--print", "--continue"],
			parsedFor(["--print", "--continue"], { noTools: false }),
		);

		// The persona's frontmatter is applied to the fresh session: tools,
		// spawns, and prompt all reflect the re-discovered definition.
		expect(session.getEnabledToolNames()).toEqual(["read", "write", "task"]);
		expect(session.getSessionSpawns()).toBe("scout");
		expect(session.getPersonaAppendPrompt()).toBe("You are the myagent persona.");
		// No duplicate mode_change is appended on resume — only the persisted
		// entry from the session file remains.
		const agentChanges = sessionManager
			.getEntries()
			.filter((entry): entry is Extract<typeof entry, { type: "mode_change" }> => entry.type === "mode_change");
		expect(agentChanges).toHaveLength(1);
		expect(agentChanges[0]?.id).toBe("mc1");
	});

	it("reapplies a persisted persona on --mode rpc --continue", async () => {
		vi.spyOn(rpcModeModule, "runRpcMode").mockResolvedValue(undefined as never);
		fs.writeFileSync(path.join(tempDir.path(), ".omp", "agents", "myagent.md"), PERSONA_MD);

		const sessionFile = path.join(tempDir.path(), "session.jsonl");
		writePersonaSession(sessionFile, { name: "myagent" });
		await wireResumedSession(sessionFile);

		const fake = makeFakeSession(sessionManager, authStorage);
		const setModelTemporary = vi.spyOn(fake, "setModelTemporary");
		await runRoot(
			["--mode", "rpc", "--continue"],
			parsedFor(["--mode", "rpc", "--continue"], { noTools: false }),
			fake,
		);

		expect(setModelTemporary).toHaveBeenCalledTimes(1);
		expect(setModelTemporary.mock.calls[0]?.[0]?.id).toBe("claude-haiku-4-5");
		expect(fake.getEnabledToolNames()).toEqual(["read", "write", "task"]);
		expect(fake.getSessionSpawns()).toBe("scout");
		expect(fake.getPersonaAppendPrompt()).toBe("You are the myagent persona.");
	});

	it("applies the frontmatter thinkingLevel AFTER setModelTemporary on rpc/print resume", async () => {
		// The reconcile must apply the frontmatter thinkingLevel after the
		// model switch: setModelTemporary with no explicit level re-applies
		// the model's `defaultLevel` (kimi-k3's is `max`), which would
		// otherwise clobber the frontmatter `thinkingLevel: high`.
		vi.spyOn(rpcModeModule, "runRpcMode").mockResolvedValue(undefined as never);
		authStorage.setRuntimeApiKey("moonshot", "test-key");
		fs.writeFileSync(
			path.join(tempDir.path(), ".omp", "agents", "myagent.md"),
			[
				"---",
				"name: myagent",
				"description: Test main-session persona agent.",
				"tools: [read, write]",
				"model: moonshot/kimi-k3",
				"thinkingLevel: high",
				"spawns: [scout]",
				"---",
				"You are the myagent persona.",
			].join("\n"),
		);

		const sessionFile = path.join(tempDir.path(), "session.jsonl");
		writePersonaSession(sessionFile, { name: "myagent" });
		await wireResumedSession(sessionFile);

		const fake = makeFakeSession(sessionManager, authStorage);
		const setModelTemporary = vi.spyOn(fake, "setModelTemporary");
		const setThinkingLevel = vi.spyOn(fake, "setThinkingLevel");
		await runRoot(
			["--mode", "rpc", "--continue"],
			parsedFor(["--mode", "rpc", "--continue"], { noTools: false }),
			fake,
		);

		expect(setModelTemporary).toHaveBeenCalledTimes(1);
		expect(setModelTemporary.mock.calls[0]?.[0]?.id).toBe("kimi-k3");
		// The frontmatter level is applied after the model switch, so the
		// model's defaultLevel cannot clobber it.
		expect(setThinkingLevel).toHaveBeenCalledWith(Effort.High);
		expect(setThinkingLevel.mock.invocationCallOrder[0]).toBeGreaterThan(
			setModelTemporary.mock.invocationCallOrder[0] ?? 0,
		);
	});

	it("applies the model-suffix thinking level, not frontmatter thinkingLevel, on rpc/print resume", async () => {
		// Control: a `:level` suffix on the SELECTED pattern is the more
		// specific selector and wins over the frontmatter `thinkingLevel` —
		// the same precedence the launch path gives it.
		vi.spyOn(rpcModeModule, "runRpcMode").mockResolvedValue(undefined as never);
		fs.writeFileSync(
			path.join(tempDir.path(), ".omp", "agents", "myagent.md"),
			[
				"---",
				"name: myagent",
				"description: Test main-session persona agent.",
				"tools: [read, write]",
				"model: anthropic/claude-sonnet-4-5:low",
				"thinkingLevel: high",
				"spawns: [scout]",
				"---",
				"You are the myagent persona.",
			].join("\n"),
		);

		const sessionFile = path.join(tempDir.path(), "session.jsonl");
		writePersonaSession(sessionFile, { name: "myagent" });
		await wireResumedSession(sessionFile);

		const fake = makeFakeSession(sessionManager, authStorage);
		const setModelTemporary = vi.spyOn(fake, "setModelTemporary");
		const setThinkingLevel = vi.spyOn(fake, "setThinkingLevel");
		await runRoot(
			["--mode", "rpc", "--continue"],
			parsedFor(["--mode", "rpc", "--continue"], { noTools: false }),
			fake,
		);

		expect(setModelTemporary).toHaveBeenCalledTimes(1);
		expect(setModelTemporary.mock.calls[0]?.[0]?.id).toBe("claude-sonnet-4-5");
		// The suffix-derived level is applied via setModelTemporary; the
		// frontmatter level must NOT be applied on top.
		expect(setThinkingLevel).not.toHaveBeenCalled();
	});

	it("clears persona state when the persisted agent is missing on --print --continue", async () => {
		vi.spyOn(printModeModule, "runPrintMode").mockResolvedValue(undefined);
		vi.spyOn(process, "exit").mockImplementation((() => {}) as typeof process.exit);

		const sessionFile = path.join(tempDir.path(), "session.jsonl");
		writePersonaSession(sessionFile, { name: "ghost-agent" });
		await wireResumedSession(sessionFile);

		const fake = makeFakeSession(sessionManager, authStorage, {
			enabledTools: ["read", "write"],
			spawns: "scout",
			personaPrompt: "stale persona prompt",
		});
		const emitNotice = vi.spyOn(fake, "emitNotice");
		await runRoot(["--print", "--continue"], parsedFor(["--print", "--continue"], { noTools: false }), fake);

		// The stale persona-owned state is cleared, not leaked.
		expect(fake.getSessionSpawns()).toBeNull();
		expect(fake.getPersonaAppendPrompt()).toBeUndefined();
		expect(emitNotice).toHaveBeenCalledWith("warning", expect.stringContaining("ghost-agent"));
	});

	it("does not apply the persona's model when --model is explicitly set", async () => {
		vi.spyOn(rpcModeModule, "runRpcMode").mockResolvedValue(undefined as never);
		fs.writeFileSync(path.join(tempDir.path(), ".omp", "agents", "myagent.md"), PERSONA_MD);

		const sessionFile = path.join(tempDir.path(), "session.jsonl");
		writePersonaSession(sessionFile, { name: "myagent" });
		await wireResumedSession(sessionFile);

		const fake = makeFakeSession(sessionManager, authStorage);
		const setModelTemporary = vi.spyOn(fake, "setModelTemporary");
		await runRoot(
			["--mode", "rpc", "--continue", "--model", "anthropic/claude-sonnet-4-5"],
			parsedFor(["--mode", "rpc", "--continue", "--model", "anthropic/claude-sonnet-4-5"], { noTools: false }),
			fake,
		);

		// Explicit --model wins: the persona's haiku frontmatter is NOT applied.
		expect(setModelTemporary).not.toHaveBeenCalled();
		expect(fake.getEnabledToolNames()).toEqual(["read", "write", "task"]);
		expect(fake.getSessionSpawns()).toBe("scout");
		expect(fake.getPersonaAppendPrompt()).toBe("You are the myagent persona.");
	});

	it("does not reconcile a persona when a fresh --agent is passed on resume", async () => {
		vi.spyOn(printModeModule, "runPrintMode").mockResolvedValue(undefined);
		vi.spyOn(process, "exit").mockImplementation((() => {}) as typeof process.exit);
		fs.writeFileSync(path.join(tempDir.path(), ".omp", "agents", "myagent.md"), PERSONA_MD);

		const sessionFile = path.join(tempDir.path(), "session.jsonl");
		writePersonaSession(sessionFile, { name: "myagent" });
		await wireResumedSession(sessionFile);

		const fake = makeFakeSession(sessionManager, authStorage);
		const setModelTemporary = vi.spyOn(fake, "setModelTemporary");
		await runRoot(
			["--print", "--continue", "--agent", "myagent"],
			parsedFor(["--print", "--continue", "--agent", "myagent"]),
			fake,
		);

		// createAgentSession (faked here) already applied the fresh --agent, so
		// the branch must not double-apply through the reconcile — it only
		// persists the identity.
		expect(setModelTemporary).not.toHaveBeenCalled();
		expect(fake.getSessionSpawns()).toBeNull();
		expect(fake.getPersonaAppendPrompt()).toBeUndefined();
		expect(agentModeChange()).toBeDefined();
		expect(agentModeChange()?.data).toEqual({ name: "myagent" });
	});
});
