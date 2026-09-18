import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { resetCapabilityForTests } from "@oh-my-pi/pi-coding-agent/capability";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createExtensionDashboardRuntime } from "@oh-my-pi/pi-coding-agent/modes/components/extensions/dashboard-runtime";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { ExtensionDashboard } from "@oh-my-pi/pi-tui/overlays/extensions/extension-dashboard";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { getAgentDir, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";

describe("extension dashboard live skills (#12220)", () => {
	let cwd: string;
	let originalAgentDir: string;
	let settings: Settings;
	let auth: AuthStorage;
	let session: AgentSession;
	let dashboard: ExtensionDashboard | undefined;

	beforeAll(async () => {
		await initTheme();
	});

	beforeEach(async () => {
		cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-dashboard-skills-"));
		originalAgentDir = getAgentDir();
		const agentDir = path.join(cwd, "agent");
		setAgentDir(agentDir);
		resetCapabilityForTests();
		settings = Settings.isolated({
			"skills.enablePiUser": false,
			"skills.enableClaudeUser": false,
			"skills.enableCodexUser": false,
			"skills.enableAgentsUser": false,
		});
		for (const [directory, name] of [
			[".omp", "dashboard-native"],
			[".github", "dashboard-provider"],
		]) {
			await Bun.write(
				path.join(cwd, directory, "skills", name, "SKILL.md"),
				`---\nname: ${name}\ndescription: Dashboard activation regression fixture.\n---\nFixture body.\n`,
			);
		}
		auth = await AuthStorage.create(path.join(agentDir, "auth.db"));
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Missing test model");
		auth.setRuntimeApiKey(model.provider, "test-key");
		({ session } = await createAgentSession({
			cwd,
			agentDir,
			settings,
			model,
			authStorage: auth,
			modelRegistry: new ModelRegistry(auth, path.join(agentDir, "models.yml")),
			sessionManager: SessionManager.inMemory(cwd),
			disableExtensionDiscovery: true,
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			toolNames: ["read"],
			restrictToolNames: true,
		}));
	});

	afterEach(async () => {
		dashboard?.dispose();
		dashboard = undefined;
		await session?.dispose();
		auth?.close();
		resetCapabilityForTests();
		resetSettingsForTest();
		setAgentDir(originalAgentDir);
		await removeWithRetries(cwd);
	});

	it("applies a dashboard skill toggle to the session prompt and command metadata without restarting", async () => {
		const runtime = createExtensionDashboardRuntime({
			cwd,
			settings,
			onSkillsChanged: () => session.refreshSkills(),
		});
		dashboard = await ExtensionDashboard.create({ runtime });
		const commandSkills: string[][] = [];
		session.subscribeCommandMetadataChanged(() => {
			commandSkills.push(session.skills.map(skill => skill.name));
		});
		expect(session.agent.state.systemPrompt.join("\n")).toContain("dashboard-native");
		for (const char of "dashboard-native") dashboard.handleInput(char);

		dashboard.handleInput(" ");
		await runtime.loadExtensions(runtime.getDisabledExtensions());
		expect(settings.get("disabledExtensions")).toContain("skill:dashboard-native");
		expect(session.skills.map(skill => skill.name)).not.toContain("dashboard-native");
		expect(session.agent.state.systemPrompt.join("\n")).not.toContain("dashboard-native");
		expect(commandSkills.at(-1)).not.toContain("dashboard-native");

		dashboard.handleInput(" ");
		await runtime.loadExtensions(runtime.getDisabledExtensions());
		expect(session.skills.map(skill => skill.name)).toContain("dashboard-native");
		expect(session.agent.state.systemPrompt.join("\n")).toContain("dashboard-native");
		expect(commandSkills.at(-1)).toContain("dashboard-native");
	});

	it("removes and restores a provider's skills while retaining skills from other providers", async () => {
		const runtime = createExtensionDashboardRuntime({
			cwd,
			settings,
			onSkillsChanged: () => session.refreshSkills(),
		});
		expect(session.skills.map(skill => skill.name)).toContain("dashboard-provider");
		runtime.toggleProvider("github");
		await runtime.loadExtensions(runtime.getDisabledExtensions());
		expect(session.skills.map(skill => skill.name)).not.toContain("dashboard-provider");
		expect(session.skills.map(skill => skill.name)).toContain("dashboard-native");

		runtime.toggleProvider("github");
		await runtime.loadExtensions(runtime.getDisabledExtensions());
		expect(session.skills.map(skill => skill.name)).toContain("dashboard-provider");
	});

	it("finishes rapid toggles in order before publishing the refreshed inventory", async () => {
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const order: string[] = [];
		let first = true;
		const runtime = createExtensionDashboardRuntime({
			cwd,
			settings,
			onSkillsChanged: async () => {
				order.push("start");
				await session.refreshSkills();
				if (first) {
					first = false;
					started.resolve();
					await release.promise;
				}
				order.push("finish");
			},
		});
		runtime.setDisabledExtensions(["skill:dashboard-native"]);
		await started.promise;
		runtime.setDisabledExtensions([]);
		const inventory = runtime.loadExtensions([]).then(items => {
			order.push("inventory");
			return items;
		});
		try {
			expect(session.skills.map(skill => skill.name)).not.toContain("dashboard-native");
			expect(order).toEqual(["start"]);
		} finally {
			release.resolve();
			await inventory;
		}
		expect(session.skills.map(skill => skill.name)).toContain("dashboard-native");
		expect(order).toEqual(["start", "finish", "start", "finish", "inventory"]);
		expect((await inventory).find(item => item.id === "skill:dashboard-native")?.state).toBe("active");
	});
});
