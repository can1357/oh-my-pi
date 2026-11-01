import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";
import { SEANCE_SLASH_COMMAND } from "@oh-my-pi/pi-coding-agent/slash-commands/seance";
import { getBundledAgent } from "@oh-my-pi/pi-coding-agent/task/agents";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import * as seanceResolver from "@oh-my-pi/pi-coding-agent/task/seance";
import { createInteractiveModeContext } from "./helpers/interactive-mode-context";

import { cfgBashEnabled } from "@oh-my-pi/pi-coding-agent/exec/settings";
import {
	cfgGithubEnabled,
	cfgGrepEnabled,
	cfgToolsForceDiscoverable,
	cfgToolsXdev,
} from "@oh-my-pi/pi-coding-agent/tools/settings";

// Tool-gating settings (`grep.enabled`, `*.enabled`, ...) must reconcile a live
// session's tools and prompt instead of waiting for the next session.
describe("settings-gated tools in a live session", () => {
	let registryDir: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	const sessions: AgentSession[] = [];

	beforeAll(async () => {
		registryDir = path.join(os.tmpdir(), `pi-settings-gated-tools-${Snowflake.next()}`);
		fs.mkdirSync(registryDir, { recursive: true });
		authStorage = await AuthStorage.create(path.join(registryDir, "auth.db"));
		modelRegistry = new ModelRegistry(authStorage, path.join(registryDir, "models.yml"));
	});

	afterEach(async () => {
		for (const session of sessions.splice(0)) await session.dispose().catch(() => {});
		vi.restoreAllMocks();
	});

	afterAll(() => {
		authStorage.close();
		if (fs.existsSync(registryDir)) removeSyncWithRetries(registryDir);
	});

	async function startSession(settings: Settings, toolNames?: string[]): Promise<AgentSession> {
		const { session } = await createAgentSession({
			cwd: registryDir,
			agentDir: registryDir,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			settings,
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			enableMCP: false,
			enableLsp: false,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			rules: [],
			workspaceTree: { rootPath: registryDir, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
			toolNames,
		});
		sessions.push(session);
		return session;
	}

	/** Lets the coalesced watch fire, then waits for the reconcile it queued on the registry lock. */
	async function settle(session: AgentSession): Promise<void> {
		await Promise.resolve();
		await session.runToolRegistryMutation(async () => {});
	}
	const GREP_POLICY = "NEVER shell `grep`/`rg`/`awk`";

	it("removes and restores grep in the request tools and system prompt", async () => {
		const settings = Settings.isolated({});
		const session = await startSession(settings);
		expect(session.getActiveToolNames()).toContain("grep");
		expect(session.systemPrompt.join("\n")).toContain(GREP_POLICY);

		cfgGrepEnabled.set(settings, false);
		await settle(session);
		expect(session.getActiveToolNames()).not.toContain("grep");
		expect(session.getToolByName("grep")).toBeUndefined();
		expect(session.systemPrompt.join("\n")).not.toContain(GREP_POLICY);
		expect(session.getActiveToolNames()).toContain("read");

		cfgGrepEnabled.set(settings, true);
		await settle(session);
		expect(session.getActiveToolNames()).toContain("grep");
		expect(session.systemPrompt.join("\n")).toContain(GREP_POLICY);
	});

	it("never widens an explicit tool list", async () => {
		const settings = Settings.isolated({
			"grep.enabled": false,
			"github.enabled": false,
			"tools.forceDiscoverable": ["read", "bash", "task"],
		});
		const session = await startSession(settings, ["read", "bash"]);
		const before = session.getActiveToolNames();
		expect(before).not.toContain("grep");
		expect(before).toContain("bash");

		cfgGrepEnabled.set(settings, true);
		cfgGithubEnabled.set(settings, true);
		await settle(session);
		expect(session.getActiveToolNames()).toEqual(before);
		expect(session.getToolByName("grep")).toBeUndefined();

		cfgBashEnabled.set(settings, false);
		await settle(session);
		expect(session.getActiveToolNames()).not.toContain("bash");
		expect(session.getActiveToolNames()).toContain("read");
	});

	it("defers built-ins at startup while keeping their docs reachable through read", async () => {
		const session = await startSession(
			Settings.isolated({
				"tools.forceDiscoverable": ["task", "eval", "todo", "web_search", "read", "write", "grep", "unknown"],
				"grep.enabled": false,
			}),
		);
		for (const name of ["task", "eval"]) {
			expect(session.getActiveToolNames()).not.toContain(name);
			expect(session.getMountedXdevToolNames()).toContain(name);
			expect(session.getEnabledToolNames()).toContain(name);
		}
		expect(session.getActiveToolNames()).toContain("todo");
		expect(session.getActiveToolNames()).toContain("web_search");
		expect(session.getEnabledToolNames()).not.toContain("grep");
		expect(session.getEnabledToolNames()).not.toContain("unknown");
		const read = session.getToolByName("read")!;
		const docs = await read.execute("discover-task", { path: "xd://task" });
		expect(docs.isError).not.toBe(true);
		const text = docs.content
			.filter(part => part.type === "text")
			.map(part => part.text)
			.join("\n");
		expect(text).toMatch(/tasks\??:/);
		expect(session.getActiveToolNames()).toContain("write");
	});

	it("retains prelude capabilities when eval is deferred and removes them when eval is disabled", async () => {
		const session = await startSession(
			Settings.isolated({
				"tools.forceDiscoverable": ["eval", "task"],
				"browser.enabled": true,
				"computer.enabled": true,
				"ratchet.enabled": true,
				"archive.enabled": true,
			}),
		);
		expect(session.getActiveToolNames()).not.toContain("eval");
		expect(session.getEvalPreludes().map(prelude => prelude.name)).toEqual([
			"browser",
			"computer",
			"ratchet",
			"archive",
		]);
		const result = await session.getToolByName("write")!.execute("deferred-preludes", {
			path: "xd://eval",
			content: JSON.stringify({ language: "js", code: "console.log(typeof archive)" }),
		});
		expect(result.isError).not.toBe(true);
		expect(
			result.content
				.filter(part => part.type === "text")
				.map(part => part.text)
				.join("\n"),
		).toContain("object");

		await session.setActiveToolsByName(session.getEnabledToolNames().filter(name => name !== "eval"));
		expect(session.getEvalPreludes()).toEqual([]);
	});

	it("repartitions a live task tool without disabling it, and honors the xdev switch", async () => {
		const settings = Settings.isolated({});
		const session = await startSession(settings);
		expect(session.getActiveToolNames()).toContain("task");

		cfgToolsForceDiscoverable.set(settings, ["task"]);
		await settle(session);
		expect(session.getActiveToolNames()).not.toContain("task");
		expect(session.getMountedXdevToolNames()).toContain("task");
		expect(session.getEnabledToolNames()).toContain("task");

		cfgToolsXdev.set(settings, false);
		await settle(session);
		expect(session.getActiveToolNames()).toContain("task");
		expect(session.getMountedXdevToolNames()).not.toContain("task");

		cfgToolsXdev.set(settings, true);
		await settle(session);
		expect(session.getMountedXdevToolNames()).toContain("task");

		cfgToolsForceDiscoverable.set(settings, []);
		await settle(session);
		expect(session.getActiveToolNames()).toContain("task");
		expect(session.getMountedXdevToolNames()).not.toContain("task");
	});

	it("runs /seance with a deferred task but refuses a disabled registered task", async () => {
		const session = await startSession(Settings.isolated({ "tools.forceDiscoverable": ["task"] }));
		const seanceAgent = getBundledAgent("seance")!;
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [seanceAgent], projectAgentsDir: null });
		vi.spyOn(seanceResolver, "resolveSeanceSource").mockResolvedValue({
			file: "/saved/session.jsonl",
			id: "saved",
			modelSelectors: [],
		});
		const execute = vi.spyOn(session.getToolByName("task")!, "execute").mockResolvedValue({
			content: [],
			details: { projectAgentsDir: null, results: [{ id: "consultation", exitCode: 0 }], totalDurationMs: 0 },
		});
		const ctx = createInteractiveModeContext({ session, sessionManager: session.sessionManager });
		const command = { name: "seance", args: "/saved/session.jsonl --model openai/requested", text: "/seance" };
		expect(session.getActiveToolNames()).not.toContain("task");
		await SEANCE_SLASH_COMMAND.handleTui!(command, { ctx });
		expect(ctx.showStatus).toHaveBeenCalledWith(expect.stringContaining("consultation"));

		await session.setActiveToolsByName(session.getEnabledToolNames().filter(name => name !== "task"));
		await SEANCE_SLASH_COMMAND.handleTui!(command, { ctx });
		expect(ctx.showError).toHaveBeenCalledWith(expect.stringContaining("not available"));
		expect(execute).toHaveBeenCalledTimes(1);
	});
});
