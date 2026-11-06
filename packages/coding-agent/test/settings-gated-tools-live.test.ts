import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, toolWireSchema } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { logger, removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

import { cfgEditMode } from "@oh-my-pi/pi-coding-agent/edit/settings";
import { cfgBashEnabled } from "@oh-my-pi/pi-coding-agent/exec/settings";
import { cfgGithubEnabled, cfgGrepEnabled, cfgToolsLoadMode } from "@oh-my-pi/pi-coding-agent/tools/settings";

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

	async function startSession(settings: Settings, toolNames?: string[], enableLsp = false): Promise<AgentSession> {
		const { session } = await createAgentSession({
			cwd: registryDir,
			agentDir: registryDir,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			settings,
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			enableMCP: false,
			enableLsp,
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

	it("updates callable grep and its shell-search restriction together", async () => {
		const settings = Settings.isolated({});
		const session = await startSession(settings);
		expect(session.getActiveToolNames()).toContain("grep");
		// Without native grep, forbidding shell search would also remove the fallback.
		const shellSearchRestriction = /\b(?:NEVER|MUST NOT)\b[^\n]*\b(?:shell|bash)\b[^\n]*\b(?:grep|rg|awk)\b/i;
		expect(session.systemPrompt.join("\n")).toMatch(shellSearchRestriction);

		cfgGrepEnabled.set(settings, false);
		await settle(session);
		expect(session.getActiveToolNames()).not.toContain("grep");
		expect(session.getToolByName("grep")).toBeUndefined();
		expect(session.getActiveToolNames()).toContain("read");
		expect(session.systemPrompt.join("\n")).not.toMatch(shellSearchRestriction);

		cfgGrepEnabled.set(settings, true);
		await settle(session);
		expect(session.getActiveToolNames()).toContain("grep");
		expect(session.systemPrompt.join("\n")).toMatch(shellSearchRestriction);
	});

	it("edit.mode none swaps edit out and keeps bash despite bash.enabled", async () => {
		const settings = Settings.isolated({ "bash.enabled": false });
		const session = await startSession(settings);
		expect(session.getActiveToolNames()).toContain("edit");
		expect(session.getActiveToolNames()).not.toContain("bash");

		cfgEditMode.set(settings, "none");
		await settle(session);
		expect(session.getToolByName("edit")).toBeUndefined();
		expect(session.getActiveToolNames()).not.toContain("edit");
		expect(session.getActiveToolNames()).toContain("bash");

		cfgEditMode.set(settings, "replace");
		await settle(session);
		expect(session.getActiveToolNames()).toContain("edit");
		expect(session.getToolByName("bash")).toBeUndefined();
	});

	it("never widens an explicit tool list", async () => {
		const settings = Settings.isolated({ "grep.enabled": false, "github.enabled": false });
		const session = await startSession(settings, ["read", "bash"]);
		const before = session.getActiveToolNames();
		expect(before).not.toContain("grep");

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

	it("changes schema loading in both directions without changing normal tool names", async () => {
		const settings = Settings.isolated({ "tools.loadMode": { task: "discoverable", lsp: "essential" } });
		const session = await startSession(settings, undefined, true);
		const originalNames = session.getActiveToolNames();
		expect(originalNames).toContain("task");
		expect(originalNames).toContain("lsp");
		let request = await session.agent.buildSideRequestContext([]);
		expect(toolWireSchema(request.tools!.find(tool => tool.name === "task")!)).toMatchObject({
			additionalProperties: true,
		});
		expect(toolWireSchema(request.tools!.find(tool => tool.name === "task")!).properties).not.toHaveProperty("tasks");
		expect(toolWireSchema(request.tools!.find(tool => tool.name === "lsp")!).properties).toHaveProperty("action");

		session.setClientBridge(undefined);
		request = await session.agent.buildSideRequestContext([]);
		expect(toolWireSchema(request.tools!.find(tool => tool.name === "task")!).properties).not.toHaveProperty("tasks");

		cfgToolsLoadMode.override(settings, { task: "essential", lsp: "discoverable" });
		await settle(session);
		expect(session.getActiveToolNames()).toEqual(originalNames.filter(name => name !== "lsp"));
		expect(session.getMountedXdevToolNames()).toContain("lsp");
		request = await session.agent.buildSideRequestContext([]);
		expect(toolWireSchema(request.tools!.find(tool => tool.name === "task")!).properties).toHaveProperty("tasks");
		expect(request.tools!.some(tool => tool.name === "lsp")).toBe(false);

		cfgToolsLoadMode.override(settings, {});
		await settle(session);
		expect(session.getActiveToolNames()).not.toContain("lsp");
		expect(session.getMountedXdevToolNames()).toContain("lsp");
	});

	it.each([true, false])("keeps the default discoverable presentation (xdev=%s)", async xdev => {
		const session = await startSession(
			Settings.isolated({ "tools.xdev": xdev, "tools.loadMode": { lsp: "discoverable" } }),
			undefined,
			true,
		);
		expect(session.getActiveToolNames().includes("lsp")).toBe(!xdev);
		expect(session.getMountedXdevToolNames().includes("lsp")).toBe(xdev);
		if (!xdev) {
			const request = await session.agent.buildSideRequestContext([]);
			expect(toolWireSchema(request.tools!.find(tool => tool.name === "lsp")!).properties).toHaveProperty("action");
		}
	});

	it("warns once per ignored value without granting disabled tools", async () => {
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const settings = Settings.isolated({
			"grep.enabled": false,
			"tools.loadMode": { grep: "essential", read: "discoverable", task: "discoverable", unknown_tool: "essential" },
		});
		const session = await startSession(settings, ["read", "write", "task"]);
		expect(session.getToolByName("grep")).toBeUndefined();
		const request = await session.agent.buildSideRequestContext([]);
		expect(toolWireSchema(request.tools!.find(tool => tool.name === "task")!).properties).not.toHaveProperty("tasks");
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("tools.loadMode.read"));
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("tools.loadMode.unknown_tool"));
		const warningCount = (name: string) =>
			warn.mock.calls.filter(([message]) => message.includes(`tools.loadMode.${name}`)).length;
		expect(warningCount("read")).toBe(1);
		expect(warningCount("unknown_tool")).toBe(1);
		const notices: string[] = [];
		session.subscribe(event => {
			if (event.type === "notice" && event.source === "tools.loadMode") notices.push(event.message);
		});
		for (const enabled of [true, false, true]) {
			cfgGrepEnabled.override(settings, enabled);
			await settle(session);
		}
		expect(warningCount("read")).toBe(1);
		expect(warningCount("unknown_tool")).toBe(1);
		expect(notices).toEqual([]);

		const modes = { grep: "essential", read: "discoverable", task: "discoverable" } as const;
		cfgToolsLoadMode.override(settings, { ...modes, unknown_tool: "discoverable" });
		await settle(session);
		expect(warningCount("read")).toBe(1);
		expect(warningCount("unknown_tool")).toBe(2);
		expect(notices).toHaveLength(1);
		cfgToolsLoadMode.override(settings, modes);
		await settle(session);
		cfgToolsLoadMode.override(settings, { ...modes, unknown_tool: "discoverable" });
		await settle(session);
		expect(warningCount("read")).toBe(1);
		expect(warningCount("unknown_tool")).toBe(3);
		expect(notices).toHaveLength(2);
	});

	it("serves full native-tool parameters even when device mounting is disabled", async () => {
		const session = await startSession(
			Settings.isolated({ "tools.xdev": false, "tools.loadMode": { glob: "discoverable" } }),
		);
		const glob = session.agent.state.tools.find(tool => tool.name === "glob")!;
		expect(toolWireSchema(glob).properties).not.toHaveProperty("hidden");
		const read = session.agent.state.tools.find(tool => tool.name === "read")!;
		const docs = await read.execute("discover-glob", { path: "xd://glob" });
		expect(docs.isError).not.toBe(true);
		expect(
			docs.content
				.filter(part => part.type === "text")
				.map(part => part.text)
				.join("\n"),
		).toContain("hidden");
	});
});
