import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { applyAgentPersonaOptions } from "@oh-my-pi/pi-coding-agent/main";
import type { CustomTool } from "@oh-my-pi/pi-coding-agent/sdk";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as discovery from "@oh-my-pi/pi-coding-agent/task/discovery";

describe("launch persona affordances after construction", () => {
	let tempHome: string;
	let projectDir: string;
	let authStorage: AuthStorage;

	beforeEach(async () => {
		resetSettingsForTest();
		tempHome = await fs.promises.mkdtemp(path.join(os.tmpdir(), "probe-launch-afford-"));
		projectDir = path.join(tempHome, "project");
		await fs.promises.mkdir(projectDir, { recursive: true });
		authStorage = await AuthStorage.create(path.join(tempHome, "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		await Settings.init({ inMemory: true, cwd: projectDir });
		Settings.instance.set("startup.quiet", true);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		authStorage?.close();
		await fs.promises.rm(tempHome, { recursive: true, force: true });
		resetSettingsForTest();
	});

	it("keeps a persona-tools launch persona's restriction live after construction (no CLI grant)", async () => {
		// `--agent foo` where foo has `tools: [read]`, NO `--tools` on the CLI:
		// the persona path sets `restrictToolNames` and seeds the session with
		// the persona's exact grant. The creation-time flag only covers the
		// FIRST prompt build (before the session exists); post-construction
		// rebuilds and refreshes must stay gated by the seeded
		// `personaToolRestriction`. Regression: a stale-range edit silently
		// deleted the seeding, so the first `refreshBaseSystemPrompt()` lifted
		// the restriction and a late MCP refresh could activate tools past the
		// persona's grant.
		const agentsDir = path.join(tempHome, ".omp", "agents");
		await fs.promises.mkdir(agentsDir, { recursive: true });
		await fs.promises.writeFile(
			path.join(agentsDir, "persona-readonly.md"),
			[
				"---",
				"name: persona-readonly",
				"description: read-only persona",
				"tools: [read]",
				"---",
				"You are persona-readonly.",
			].join("\n"),
		);

		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("missing bundled anthropic model");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempHome, "models.yml"));
		const sessionManager = SessionManager.inMemory(projectDir);
		const options: Parameters<typeof createAgentSession>[0] = {
			cwd: projectDir,
			agentDir: tempHome,
			authStorage,
			modelRegistry,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			model,
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
		const { agents } = await discovery.discoverAgents(projectDir, tempHome);
		const agent = agents.find(candidate => candidate.name === "persona-readonly");
		expect(agent).toBeDefined();
		applyAgentPersonaOptions(options, agent!, { modelSet: false, thinkingSet: false, toolsSet: false });
		options.personaName = "persona-readonly";

		const { session } = await createAgentSession(options);
		try {
			// The persona's `tools: [read]` grant is seeded as a live
			// restriction from construction on.
			expect(session.getEnabledToolNames()).toEqual(["read"]);
			const restriction = session.getPersonaToolRestriction();
			expect(restriction).toBeDefined();

			// A post-construction prompt rebuild keeps the restriction (the
			// creation-time flag alone cannot — it only covers the first
			// build).
			await session.refreshBaseSystemPrompt();
			expect(session.getPersonaToolRestriction()).toBeDefined();

			// A late MCP refresh cannot widen the active set past the grant.
			const mcpTool: CustomTool = {
				name: "mcp__db_query",
				label: "db/query",
				description: "Query",
				parameters: type({}),
				mcpServerName: "db",
				mcpToolName: "query",
				async execute() {
					return { content: [{ type: "text", text: "ok" }] };
				},
			};
			await session.refreshMCPTools([mcpTool]);
			expect(session.getEnabledToolNames()).toEqual(["read"]);
		} finally {
			await session.dispose();
		}
	}, 20_000);
});
