import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Effort } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { SelectorController } from "@oh-my-pi/pi-coding-agent/modes/controllers/selector-controller";
import { type CreateAgentSessionOptions, createAgentSession, discoverAuthStorage } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { cfgDefaultThinkingLevel } from "@oh-my-pi/pi-coding-agent/session/settings";
import { createSubagentSettings } from "@oh-my-pi/pi-coding-agent/task/executor";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";
import { createInteractiveModeContext } from "../helpers/interactive-mode-context";

// `defaultThinkingLevel` seeds new sessions. A later write that is not the user's
// in-process choice (config reload, another omp process, a parent session) must not
// re-steer a running session's explicit selection.
describe("defaultThinkingLevel on running sessions", () => {
	const tempDirs: string[] = [];
	const sessions: AgentSession[] = [];
	let modelRegistry!: ModelRegistry;
	let authDir: string;

	beforeAll(async () => {
		authDir = path.join(os.tmpdir(), `pi-thinking-default-auth-${Snowflake.next()}`);
		fs.mkdirSync(authDir, { recursive: true });
		modelRegistry = new ModelRegistry(await discoverAuthStorage(authDir));
	});

	afterEach(async () => {
		for (const session of sessions.splice(0)) await session.dispose();
		for (const dir of tempDirs.splice(0)) removeSyncWithRetries(dir);
	});

	afterAll(() => {
		removeSyncWithRetries(authDir);
	});

	const start = async (
		settings: Settings,
		extra: Pick<CreateAgentSessionOptions, "thinkingLevel" | "taskDepth" | "parentTaskPrefix" | "agentId">,
	): Promise<AgentSession> => {
		const cwd = path.join(os.tmpdir(), `pi-thinking-default-${Snowflake.next()}`);
		tempDirs.push(cwd);
		fs.mkdirSync(cwd, { recursive: true });
		const { session } = await createAgentSession({
			cwd,
			agentDir: cwd,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			settings,
			model: getBundledModel("anthropic", "claude-sonnet-4-5"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			rules: [],
			...extra,
		});
		sessions.push(session);
		return session;
	};

	it("keeps a subagent at its spawn-time level when the parent's default changes", async () => {
		const parent = Settings.isolated();
		cfgDefaultThinkingLevel.set(parent, Effort.High);
		const subagent = await start(createSubagentSettings(parent), {
			thinkingLevel: Effort.Low,
			taskDepth: 1,
			parentTaskPrefix: "0-Sub",
			agentId: "0-Sub",
		});
		expect(subagent.thinkingLevel).toBe(Effort.Low);

		cfgDefaultThinkingLevel.set(parent, Effort.Minimal);
		// Settings listeners are coalesced onto one microtask.
		await Promise.resolve();

		expect(subagent.thinkingLevel).toBe(Effort.Low);
		// The subagent's own default stays the spawn-time snapshot, so what it later seeds from
		// that default (a reload without a thinking entry, the children it spawns) is not
		// re-steered by the parent's edit either.
		expect(cfgDefaultThinkingLevel.get(subagent.settings)).toBe(Effort.High);
		expect(cfgDefaultThinkingLevel.get(createSubagentSettings(subagent.settings))).toBe(Effort.High);
	});

	it("switches the main session only for a settings-panel change, not a plain settings write", async () => {
		const settings = Settings.isolated();
		const session = await start(settings, { thinkingLevel: Effort.Low });

		// A reload or another writer lands the new default in the settings layers.
		cfgDefaultThinkingLevel.set(settings, Effort.Minimal);
		await Promise.resolve();
		expect(session.thinkingLevel).toBe(Effort.Low);

		// The settings panel (and approved `cfg://` writes) apply the user's choice live.
		const controller = new SelectorController(createInteractiveModeContext({ session, settings }));
		cfgDefaultThinkingLevel.set(settings, Effort.Medium);
		controller.handleSettingChange(cfgDefaultThinkingLevel.id, Effort.Medium);
		expect(session.thinkingLevel).toBe(Effort.Medium);
	});
});
