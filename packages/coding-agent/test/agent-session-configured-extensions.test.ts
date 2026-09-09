/**
 * Regression (#9769 review): a session's extension roots must survive
 * post-startup discovery. Exercised through the real `AgentSession.refreshSkills`
 * path against on-disk extension packages, so it defends the user-visible
 * contract — explicit `additionalExtensionPaths` skills still resolve after a
 * reload, and an `explicit-only` (`disableExtensionDiscovery`) session drops the
 * ambient `extensions:` configured lane — not merely that the getter echoes its
 * constructor inputs.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import type { EffectiveExtensionRoots } from "@oh-my-pi/pi-coding-agent/capability/types";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import "@oh-my-pi/pi-coding-agent/discovery";
import { setActiveSkills } from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { discoverAgents } from "@oh-my-pi/pi-coding-agent/task/discovery";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";

interface SessionInputs {
	additionalExtensionPaths?: readonly string[];
	disableExtensionDiscovery?: boolean;
	extensionRoots?: () => EffectiveExtensionRoots;
	extensions?: string[];
}

/** Write a minimal extension package exposing a single named skill. */
function buildSkillPackage(dir: string, skillName: string): void {
	fs.mkdirSync(path.join(dir, "skills", skillName), { recursive: true });
	fs.writeFileSync(
		path.join(dir, "skills", skillName, "SKILL.md"),
		`---\nname: ${skillName}\ndescription: ${skillName} fixture\n---\nbody\n`,
	);
}

/** Write a minimal extension package exposing a single task agent. */
function buildAgentPackage(dir: string, agentName: string): void {
	fs.mkdirSync(path.join(dir, "agents"), { recursive: true });
	fs.writeFileSync(
		path.join(dir, "agents", `${agentName}.md`),
		`---\nname: ${agentName}\ndescription: ${agentName} fixture\n---\nHandle the assigned task.\n`,
	);
}

describe("AgentSession extension-root discovery (post-startup)", () => {
	const sessions: AgentSession[] = [];
	const authStorages: AuthStorage[] = [];
	let tempDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-session-ext-"));
	});

	afterEach(async () => {
		for (const session of sessions.splice(0)) await session.dispose();
		for (const authStorage of authStorages.splice(0)) authStorage.close();
		setActiveSkills([]);
		removeSyncWithRetries(tempDir);
	});

	async function makeSession(inputs: SessionInputs): Promise<AgentSession> {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			convertToLlm,
		});
		const authStorage = await AuthStorage.create(":memory:");
		authStorages.push(authStorage);
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ extensions: inputs.extensions ?? [] }),
			modelRegistry: new ModelRegistry(authStorage),
			additionalExtensionPaths: inputs.additionalExtensionPaths,
			disableExtensionDiscovery: inputs.disableExtensionDiscovery,
			extensionRoots: inputs.extensionRoots,
			skillsReloadable: true,
		});
		sessions.push(session);
		return session;
	}

	it("surfaces an additionalExtensionPaths package's skills through refreshSkills", async () => {
		const ext = path.join(tempDir, "explicit-pkg");
		buildSkillPackage(ext, "explicit-skill");
		// Empty settings.extensions: the only source is the explicit SDK root,
		// which lives solely in the construction-time scope. A stale/flattened
		// getter would drop it on this post-startup reload.
		const session = await makeSession({ additionalExtensionPaths: [ext] });

		await session.refreshSkills();

		expect(session.skills.map(skill => skill.name)).toContain("explicit-skill");
	});

	it("drops the ambient configured lane for an explicit-only session on refresh", async () => {
		const explicitExt = path.join(tempDir, "explicit-pkg");
		const configuredExt = path.join(tempDir, "configured-pkg");
		buildSkillPackage(explicitExt, "explicit-skill");
		buildSkillPackage(configuredExt, "configured-skill");
		// disableExtensionDiscovery ⇒ explicit-only: the explicit root is honored,
		// the ambient `extensions:` (configured) root is suppressed on reload.
		const session = await makeSession({
			additionalExtensionPaths: [explicitExt],
			extensions: [configuredExt],
			disableExtensionDiscovery: true,
		});

		await session.refreshSkills();

		const names = session.skills.map(skill => skill.name);
		expect(names).toContain("explicit-skill");
		expect(names).not.toContain("configured-skill");
	});

	it("discovers sibling task agents from an inherited explicit-only root policy", async () => {
		const explicitExt = path.join(tempDir, "explicit-pkg");
		const configuredExt = path.join(tempDir, "configured-pkg");
		buildAgentPackage(explicitExt, "explicit-sibling");
		buildAgentPackage(configuredExt, "configured-sibling");
		const extensionRoots = (): EffectiveExtensionRoots => ({
			explicit: [explicitExt],
			mode: "explicit-only",
			configured: [configuredExt],
			configuredLevel: "project",
		});
		const session = await makeSession({
			extensions: [configuredExt],
			extensionRoots,
		});

		const { agents } = await discoverAgents(tempDir, tempDir, session.effectiveExtensionRoots);
		const names = agents.map(agent => agent.name);

		expect(names).toContain("explicit-sibling");
		expect(names).not.toContain("configured-sibling");
	});

	it("reflects a runtime extensions override on the next refresh", async () => {
		const configuredExt = path.join(tempDir, "configured-pkg");
		buildSkillPackage(configuredExt, "configured-skill");
		const session = await makeSession({});

		await session.refreshSkills();
		expect(session.skills.map(skill => skill.name)).not.toContain("configured-skill");

		// The live getter reads settings per call, so the override lands on refresh.
		session.settings.override("extensions", [configuredExt]);
		await session.refreshSkills();
		expect(session.skills.map(skill => skill.name)).toContain("configured-skill");
	});
});
