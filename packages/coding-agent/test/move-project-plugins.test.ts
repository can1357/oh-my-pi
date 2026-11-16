import { afterEach, beforeAll, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TaskTool } from "@oh-my-pi/pi-coding-agent/task";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { getMCPConfigPath, getProjectDir, setProjectDir } from "@oh-my-pi/pi-utils";
import { createMcpManagerStub } from "./helpers/interactive-mode-context";

const originalProjectDir = getProjectDir();

beforeAll(() => initTheme());
afterEach(() => {
	vi.restoreAllMocks();
	setProjectDir(originalProjectDir);
	resetSettingsForTest();
});

describe("project-scoped plugins after an interactive move", () => {
	test("replaces source agents and MCP servers with the destination project's", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-move-project-plugins-"));
		const source = path.join(root, "source");
		const target = path.join(root, "target");
		let session: AgentSession | undefined;
		let mode: InteractiveMode | undefined;
		let auth: AuthStorage | undefined;
		try {
			for (const [dir, name] of [
				[source, "alpha"],
				[target, "beta"],
			]) {
				await fs.mkdir(path.join(dir, ".omp", "agents"), { recursive: true });
				await Bun.write(
					path.join(dir, ".omp", "agents", `${name}.md`),
					`---\nname: ${name}\ndescription: ${name} project agent\n---\n${name} agent.\n`,
				);
				await Bun.write(
					getMCPConfigPath("project", dir),
					JSON.stringify({ mcpServers: { [name]: { type: "stdio", command: name } } }),
				);
			}
			setProjectDir(source);
			await Settings.init({ inMemory: true, cwd: source });
			auth = await AuthStorage.create(path.join(root, "auth.db"));
			const registry = new ModelRegistry(auth);
			const model = registry.find("anthropic", "claude-sonnet-4-5");
			if (!model) throw new Error("Expected bundled model");
			const manager = SessionManager.inMemory(source);
			session = new AgentSession({
				agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
				sessionManager: manager,
				settings: Settings.isolated(),
				modelRegistry: registry,
				rebuildSystemPrompt: async () => ({ systemPrompt: ["Test"] }),
			});
			const currentSession = session;
			const taskSession = {
				get cwd() {
					return manager.getCwd();
				},
				hasUI: false,
				settings: currentSession.settings,
				effectiveExtensionRoots: () => currentSession.effectiveExtensionRoots,
				getSessionFile: () => null,
				getSessionSpawns: () => "*",
			} satisfies ToolSession;
			const taskTool = await TaskTool.create(taskSession);
			expect(taskTool.description).toContain("alpha project agent");
			let connected = "alpha";
			const mcpManager = createMcpManagerStub({
				disconnectAll: vi.fn(async () => {
					connected = "";
				}),
				discoverAndConnect: vi.fn(async () => {
					const config = await Bun.file(getMCPConfigPath("project", getProjectDir())).json();
					for (const name in config.mcpServers) connected = name;
					return { errors: new Map(), connectedServers: [], tools: [], exaApiKeys: [] };
				}),
			});
			mode = new InteractiveMode(session, "test");
			mode.mcpManager = mcpManager;
			vi.spyOn(mode, "refreshTitleSystemPrompt").mockResolvedValue(undefined);
			vi.spyOn(mode, "showError").mockImplementation(() => {});
			manager.setCwdWithoutRelocation(target);
			const moved = await mode.applyCwdChange(target);
			expect(moved).toBe(true);
			expect(taskTool.description).toContain("beta project agent");
			expect(taskTool.description).not.toContain("alpha project agent");
			expect(connected).toBe("beta");
		} finally {
			mode?.stop();
			await session?.dispose();
			auth?.close();
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});
