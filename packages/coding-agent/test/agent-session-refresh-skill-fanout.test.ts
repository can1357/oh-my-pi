/**
 * Skill fan-out on refresh targets the registry the session was created against
 * (SDK `CreateAgentSessionOptions.agentRegistry`, else the global) and is
 * restricted to THIS session's own descendants.
 *
 * Pre-fix, `applyReloadedSkills` iterated `AgentRegistry.global().list()`
 * unconditionally, so a session created on a caller-supplied registry (a) never
 * reached its own subagents (registered on THAT registry) and (b) overwrote the
 * skills snapshot of an unrelated session living in the global tree with a
 * roster discovered from this session's cwd.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Api, Model, ModelSpec } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { Skill } from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

function buildLocalModel(api: string): Model<Api> {
	return buildModel({
		id: "skill-fanout-model",
		name: "Skill Fanout Model",
		api,
		provider: "managed-primary",
		baseUrl: "http://127.0.0.1:8080/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 4096,
		maxTokens: 1024,
	} as ModelSpec<Api>) as Model<Api>;
}

function fakeSkill(name: string): Skill {
	return {
		name,
		description: `${name} fixture`,
		filePath: `/tmp/${name}/SKILL.md`,
		baseDir: `/tmp/${name}`,
		source: "test",
	};
}

interface SessionHandle {
	session: AgentSession;
	dispose: () => Promise<void>;
}

async function makeSession(opts: {
	agentRegistry?: AgentRegistry;
	agentId?: string;
	parentAgentId?: string;
	taskDepth?: number;
}): Promise<SessionHandle> {
	const tempDir = TempDir.createSync("@pi-skill-fanout-");
	const cwd = tempDir.path();
	await fs.mkdir(path.join(cwd, ".git"), { recursive: true });
	const api = `skill-fanout-${Bun.nanoseconds().toString(36)}`;
	const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
	authStorage.setRuntimeApiKey("managed-primary", "test-key");
	const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));

	const { session } = await createAgentSession({
		cwd,
		agentDir: cwd,
		sessionManager: SessionManager.inMemory(cwd),
		authStorage,
		modelRegistry,
		settings: await Settings.loadIsolated({ cwd, agentDir: cwd, overrides: { "compaction.enabled": false } }),
		model: buildLocalModel(api),
		disableExtensionDiscovery: true,
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
		skipPythonPreflight: true,
		// A frozen (non-reloadable) roster so the seeded skills snapshot is stable
		// and only an explicit `applyReloadedSkills` mutates it.
		skills: [],
		agentRegistry: opts.agentRegistry,
		agentId: opts.agentId,
		parentAgentId: opts.parentAgentId,
		taskDepth: opts.taskDepth,
	});

	return {
		session,
		dispose: async () => {
			await session.dispose();
			authStorage.close();
			await tempDir.remove();
		},
	};
}

describe("AgentSession refresh: skill fan-out registry scoping", () => {
	afterEach(() => {
		AgentRegistry.resetGlobalForTests();
	});

	it("refreshes a subagent on a non-global registry without touching an unrelated global-tree session", async () => {
		const customRegistry = new AgentRegistry();

		// Parent + its descendant both live on the caller-supplied registry.
		const parent = await makeSession({ agentRegistry: customRegistry, agentId: "Parent" });
		const child = await makeSession({
			agentRegistry: customRegistry,
			agentId: "Child",
			parentAgentId: "Parent",
			taskDepth: 1,
		});
		// An unrelated session in the GLOBAL tree — a different agent entirely.
		const unrelated = await makeSession({ agentId: "Unrelated" });

		try {
			expect(parent.session.skills.map(s => s.name)).toEqual([]);
			expect(child.session.skills.map(s => s.name)).toEqual([]);
			expect(unrelated.session.skills.map(s => s.name)).toEqual([]);

			const skills = [fakeSkill("alpha"), fakeSkill("beta")];
			parent.session.applyReloadedSkills(skills);

			// The descendant on the custom registry got the refreshed skills...
			expect(child.session.skills.map(s => s.name)).toEqual(["alpha", "beta"]);
			// ...and the unrelated global-tree session was NOT overwritten.
			expect(unrelated.session.skills.map(s => s.name)).toEqual([]);
		} finally {
			await parent.dispose();
			await child.dispose();
			await unrelated.dispose();
		}
	});

	it("does not fan out to a non-descendant sibling sharing the same registry", async () => {
		const customRegistry = new AgentRegistry();

		const parent = await makeSession({ agentRegistry: customRegistry, agentId: "Parent" });
		// A sibling registered on the SAME registry but NOT under Parent.
		const sibling = await makeSession({
			agentRegistry: customRegistry,
			agentId: "Sibling",
			parentAgentId: "OtherRoot",
			taskDepth: 1,
		});

		try {
			parent.session.applyReloadedSkills([fakeSkill("gamma")]);

			// The sibling is not Parent's descendant, so its snapshot is untouched.
			expect(sibling.session.skills.map(s => s.name)).toEqual([]);
		} finally {
			await parent.dispose();
			await sibling.dispose();
		}
	});
});
