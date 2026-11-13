import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import * as capabilityFs from "@oh-my-pi/pi-coding-agent/capability/fs";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { DefaultResourceLoader } from "@oh-my-pi/pi-coding-agent/extensibility/legacy-pi-coding-agent-shim";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { cfgContextStopAtRepoRoot } from "@oh-my-pi/pi-coding-agent/session/context-settings";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

const WORKSPACE_AGENTS = "workspace-agents-boundary-marker";
const WORKSPACE_CLAUDE = "workspace-claude-boundary-marker";
const REPO_CONTEXT = "repository-boundary-marker";
const HOME_CONTEXT = "home-boundary-marker";

interface ContextSession {
	session: AgentSession;
	authStorage: AuthStorage;
}

describe("session context repository boundary", () => {
	let temp: TempDir;
	let home: string;
	let workspace: string;
	const sessions: ContextSession[] = [];

	beforeEach(async () => {
		temp = await TempDir.create("@omp-context-boundary-");
		home = temp.join("home");
		workspace = path.join(home, "workspace");
		await Bun.write(path.join(home, "AGENTS.md"), HOME_CONTEXT);
		await Bun.write(path.join(workspace, "AGENTS.md"), WORKSPACE_AGENTS);
		await Bun.write(path.join(workspace, "packages", "CLAUDE.md"), WORKSPACE_CLAUDE);
		vi.spyOn(os, "homedir").mockReturnValue(home);
	});

	afterEach(async () => {
		for (const { session, authStorage } of sessions.splice(0)) {
			await session.dispose();
			authStorage.close();
		}
		vi.restoreAllMocks();
		capabilityFs.clearCache();
		await temp.remove();
	});

	async function createRepo(name: string): Promise<string> {
		const repoRoot = path.join(workspace, "packages", name);
		const cwd = path.join(repoRoot, "src");
		await fs.mkdir(path.join(repoRoot, ".git"), { recursive: true });
		await fs.mkdir(cwd, { recursive: true });
		await Bun.write(path.join(repoRoot, "AGENTS.md"), REPO_CONTEXT);
		return cwd;
	}

	async function startSession(cwd: string, settings: Settings): Promise<AgentSession> {
		const agentDir = path.join(cwd, "agent-config");
		const authStorage = await AuthStorage.create(path.join(agentDir, "auth.db"));
		try {
			const { session } = await createAgentSession({
				cwd,
				agentDir,
				settings,
				modelRegistry: new ModelRegistry(authStorage, path.join(agentDir, "models.yml")),
				model: getBundledModel("openai", "gpt-4o-mini"),
				sessionManager: SessionManager.inMemory(cwd),
				disableExtensionDiscovery: true,
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
				toolNames: [],
				restrictToolNames: true,
				skipPythonPreflight: true,
			});
			sessions.push({ session, authStorage });
			return session;
		} catch (error) {
			authStorage.close();
			throw error;
		}
	}

	function expectContext(session: AgentSession, includesWorkspace: boolean): void {
		const prompt = session.systemPrompt.join("\n");
		expect(prompt).toContain(REPO_CONTEXT);
		expect(prompt).not.toContain(HOME_CONTEXT);
		for (const marker of [WORKSPACE_AGENTS, WORKSPACE_CLAUDE]) {
			if (includesWorkspace) expect(prompt).toContain(marker);
			else expect(prompt).not.toContain(marker);
		}
	}

	it("walks to home by default and updates live for true and explicit false", async () => {
		const cwd = await createRepo("service");
		const settings = Settings.isolated({});
		const session = await startSession(cwd, settings);
		expectContext(session, true);

		cfgContextStopAtRepoRoot.set(settings, true);
		// Let the settings watch enqueue its prompt rebuild, then drain the queue.
		await Promise.resolve();
		await session.runToolRegistryMutation(async () => {});
		expectContext(session, false);

		cfgContextStopAtRepoRoot.set(settings, false);
		await Promise.resolve();
		await session.runToolRegistryMutation(async () => {});
		expectContext(session, true);
	});

	it("applies the session boundary to additional workspace roots", async () => {
		const cwd = await createRepo("primary");
		const extraWorkspace = path.join(home, "extra-workspace");
		const extraRepo = path.join(extraWorkspace, "extra-repo");
		await fs.mkdir(path.join(extraRepo, ".git"), { recursive: true });
		await Bun.write(path.join(extraRepo, "AGENTS.md"), "additional-repository-marker");
		await Bun.write(path.join(extraWorkspace, "CLAUDE.md"), "additional-workspace-marker");
		const settings = Settings.isolated({
			context: { stopAtRepoRoot: true },
			workspace: { additionalDirectories: [extraRepo] },
		});
		const session = await startSession(cwd, settings);
		const prompt = session.systemPrompt.join("\n");
		expect(prompt).toContain("additional-repository-marker");
		expect(prompt).not.toContain("additional-workspace-marker");
	});

	it("honors a legacy resource loader's local settings during reload", async () => {
		const cwd = await createRepo("legacy");
		const settings = Settings.isolated({ context: { stopAtRepoRoot: true } });
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir: path.join(cwd, "agent-config"),
			settingsManager: settings,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
		});
		await loader.reload();
		let loaded = loader
			.getAgentsFiles()
			.agentsFiles.map(file => file.content)
			.join("\n");
		expect(loaded).toContain(REPO_CONTEXT);
		expect(loaded).not.toContain(WORKSPACE_AGENTS);
		expect(loaded).not.toContain(WORKSPACE_CLAUDE);

		cfgContextStopAtRepoRoot.override(settings, false);
		await loader.reload();
		loaded = loader
			.getAgentsFiles()
			.agentsFiles.map(file => file.content)
			.join("\n");
		expect(loaded).toContain(WORKSPACE_AGENTS);
		expect(loaded).toContain(WORKSPACE_CLAUDE);
	});

	it("keeps delayed startup and reload discovery on each session's own boundary", async () => {
		const cwdA = await createRepo("first");
		const cwdB = await createRepo("second");
		const settingsA = Settings.isolated({ context: { stopAtRepoRoot: true } });
		const settingsB = Settings.isolated({ context: { stopAtRepoRoot: false } });
		const blocked = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const findRepoRoot = capabilityFs.findRepoRoot;
		vi.spyOn(capabilityFs, "findRepoRoot").mockImplementation(async cwd => {
			if (cwd === cwdA) {
				blocked.resolve();
				await release.promise;
			}
			return findRepoRoot(cwd);
		});
		const sessionAPromise = startSession(cwdA, settingsA);
		sessionAPromise.catch(blocked.reject);
		let sessionB: AgentSession;
		try {
			await blocked.promise;
			// The second session takes the registry's process-wide settings hold while
			// the first session's real filesystem discovery is paused.
			sessionB = await startSession(cwdB, settingsB);
		} finally {
			release.resolve();
			await sessionAPromise;
		}
		const sessionA = await sessionAPromise;
		expectContext(sessionA, false);
		expectContext(sessionB, true);

		cfgContextStopAtRepoRoot.override(settingsA, false);
		cfgContextStopAtRepoRoot.override(settingsB, true);
		await Promise.all([sessionA.refreshSkills(), sessionB.refreshSkills()]);
		expectContext(sessionA, true);
		expectContext(sessionB, false);
	});
});
