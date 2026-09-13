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
import { getActiveRules, type Rule } from "@oh-my-pi/pi-coding-agent/capability/rule";
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
	cwd: string;
	dispose: () => Promise<void>;
}

async function makeSession(opts: {
	agentRegistry?: AgentRegistry;
	agentId?: string;
	parentAgentId?: string;
	taskDepth?: number;
	/**
	 * Share an existing session's cwd, so a parent and its child discover the
	 * SAME on-disk roster — the real subagent shape, and what makes a parent's
	 * rediscovery meaningful to the child.
	 */
	cwd?: string;
	/** Stage on-disk rule/skill fixtures before the session is constructed. */
	seed?: (cwd: string) => Promise<void>;
	/**
	 * Let rules come from DISK discovery instead of the frozen `rules: []`
	 * policy, so a refresh actually re-reads them. The skill roster stays frozen
	 * either way (`skills: []`).
	 */
	reloadableRules?: boolean;
	/**
	 * Spawn the way a real structured subagent is spawned: with the parent's
	 * `rules` array forwarded AND marked inherited. The spawn path always
	 * forwards `session.rules`, so a child's `#rulesPolicy` is defined even
	 * though it is a disk roster the parent discovered rather than a restriction
	 * anyone chose — which is what a parent's refresh must be allowed to widen.
	 */
	inheritedRules?: readonly Rule[];
	/**
	 * Pin the skill roster the way an SDK caller does — an EXPLICIT policy the
	 * parent's fan-out must not widen. Every other session models the real
	 * spawn, which forwards the parent's roster and marks it inherited.
	 */
	explicitSkills?: readonly Skill[];
}): Promise<SessionHandle> {
	// A shared cwd is owned by the session that created it, so only an
	// own-tempdir session removes it on dispose.
	const tempDir = opts.cwd === undefined ? TempDir.createSync("@pi-skill-fanout-") : undefined;
	const cwd = opts.cwd ?? tempDir!.path();
	await fs.mkdir(path.join(cwd, ".git"), { recursive: true });
	if (opts.seed) await opts.seed(cwd);
	const api = `skill-fanout-${Bun.nanoseconds().toString(36)}`;
	const authDir = TempDir.createSync("@pi-skill-fanout-auth-");
	const authStorage = await AuthStorage.create(authDir.join("auth.db"));
	authStorage.setRuntimeApiKey("managed-primary", "test-key");
	const modelRegistry = new ModelRegistry(authStorage, authDir.join("models.yml"));

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
		// and only an explicit `applyReloadedSkills` mutates it. Marked INHERITED
		// by default, which is what the structured-subagent spawn does: it always
		// forwards `session.skills`, so a child carries a roster nobody chose and
		// a parent's refresh must still reach it. `explicitSkills` models the
		// other case — an SDK caller pinning the roster.
		...(opts.explicitSkills !== undefined
			? { skills: [...opts.explicitSkills] }
			: { skills: [], skillsInherited: true }),
		...(opts.inheritedRules !== undefined
			? { rules: [...opts.inheritedRules], rulesInherited: true }
			: opts.reloadableRules
				? {}
				: { rules: [] }),
		agentRegistry: opts.agentRegistry,
		agentId: opts.agentId,
		parentAgentId: opts.parentAgentId,
		taskDepth: opts.taskDepth,
	});

	return {
		session,
		cwd,
		dispose: async () => {
			await session.dispose();
			authStorage.close();
			await authDir.remove();
			await tempDir?.remove();
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
	}, 20000);

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
	}, 20000);

	it("rebuilds a running descendant's system prompt after the skill fan-out", async () => {
		const customRegistry = new AgentRegistry();
		const parent = await makeSession({ agentRegistry: customRegistry, agentId: "Parent" });
		const child = await makeSession({
			agentRegistry: customRegistry,
			agentId: "Child",
			parentAgentId: "Parent",
			taskDepth: 1,
		});

		try {
			const marker = `fanout-prompt-${Bun.nanoseconds().toString(36)}`;
			await child.session.refreshBaseSystemPrompt();
			expect(child.session.systemPrompt.join("\n")).not.toContain(marker);

			parent.session.applyReloadedSkills([fakeSkill(marker)]);
			// The snapshot lands synchronously; the rebuild is triggered onto the
			// descendant's own tool-registry mutation tail. Queue an empty mutation
			// behind it as a barrier — it resolves only once that rebuild has
			// landed, without performing a rebuild of its own (which would mask the
			// bug). Pre-fix, nothing was queued, so the barrier resolves immediately
			// against the stale prompt.
			await child.session.runToolRegistryMutation(async () => {});

			// Pre-fix: the fan-out updated the descendant's `skill://` snapshot but
			// only the PARENT rebuilt at the end of `#doRefresh`, so the child's
			// later turns kept advertising the launch-time skill roster.
			expect(child.session.systemPrompt.join("\n")).toContain(marker);
		} finally {
			await parent.dispose();
			await child.dispose();
		}
	}, 20000);

	it("does not widen a descendant spawned with an explicit skills policy", async () => {
		// An SDK caller that passes `skills` — including `skills: []` — has chosen
		// that child's roster. The child's OWN refresh honors it (`refreshSkills`
		// skips rediscovery when the roster is non-reloadable), but this fan-out
		// wrote straight into the snapshot, so the child gained `skill://` access
		// and a prompt advertising skills the caller deliberately excluded.
		const customRegistry = new AgentRegistry();
		const parent = await makeSession({ agentRegistry: customRegistry, agentId: "Parent" });
		const child = await makeSession({
			agentRegistry: customRegistry,
			agentId: "Child",
			parentAgentId: "Parent",
			taskDepth: 1,
			// The distinguishing input: pinned by the caller, not forwarded.
			explicitSkills: [],
		});

		try {
			const marker = `explicit-policy-${Bun.nanoseconds().toString(36)}`;
			await child.session.refreshBaseSystemPrompt();

			parent.session.applyReloadedSkills([fakeSkill(marker)]);
			await child.session.runToolRegistryMutation(async () => {});

			// The parent still gets the fresh roster; only the pinned child is left alone.
			expect(parent.session.skills.map(skill => skill.name)).toEqual([marker]);
			expect(child.session.skills.map(skill => skill.name)).toEqual([]);
			expect(child.session.systemPrompt.join("\n")).not.toContain(marker);
		} finally {
			await parent.dispose();
			await child.dispose();
		}
	}, 20000);

	it("leaves a descendant's prompt byte-identical when its snapshot did not change", async () => {
		// The no-op guard: a refresh that changes nothing must not re-render a
		// descendant's prompt, or every parent refresh would break the child's
		// provider prompt caching.
		const customRegistry = new AgentRegistry();
		const parent = await makeSession({ agentRegistry: customRegistry, agentId: "Parent" });
		const child = await makeSession({
			agentRegistry: customRegistry,
			agentId: "Child",
			parentAgentId: "Parent",
			taskDepth: 1,
		});

		try {
			const skills = [fakeSkill(`stable-${Bun.nanoseconds().toString(36)}`)];
			parent.session.applyReloadedSkills(skills);
			await child.session.runToolRegistryMutation(async () => {});
			const before = child.session.systemPrompt.join("\n");

			// An identical roster: the descendant's snapshot reports no change.
			parent.session.applyReloadedSkills([...skills]);
			await child.session.runToolRegistryMutation(async () => {});

			expect(child.session.systemPrompt.join("\n")).toBe(before);
		} finally {
			await parent.dispose();
			await child.dispose();
		}
	}, 20000);
});

// A rules refresh must reach a running descendant too. The skill fan-out above
// handles skills ONLY, so a child kept three independently stale pieces of rule
// state captured at spawn: its `activeRules` snapshot (which `rule://`
// resolution PREFERS over the process global), its rendered prompt buckets, and
// its own TtsrManager registrations.
describe("AgentSession refresh: rule fan-out to running descendants", () => {
	afterEach(() => {
		AgentRegistry.resetGlobalForTests();
	});

	/** Seeds one on-disk rule file under the session's project rules dir. */
	async function writeRule(cwd: string, name: string, body: string, extraFrontmatter = ""): Promise<void> {
		await fs.mkdir(path.join(cwd, ".omp", "rules"), { recursive: true });
		await fs.writeFile(
			path.join(cwd, ".omp", "rules", `${name}.md`),
			`---\nname: ${name}\ndescription: fanout fixture\n${extraFrontmatter}---\n${body}\n`,
		);
	}

	/**
	 * Names in a session's SESSION-LOCAL rule snapshot — the array `read` threads
	 * as `rule://` resolution context, which the protocol handler prefers over
	 * the process global. Read off the live production `ToolSession` the SDK
	 * built this session's tools against.
	 */
	function childRuleNames(session: AgentSession): string[] {
		const readTool = session.getToolByName("read");
		if (!readTool) throw new Error("Expected the read tool");
		const inner = Reflect.get(readTool, "session");
		if (!inner || typeof inner !== "object") throw new Error("Expected a ToolSession on the read tool");
		return ((inner as { activeRules?: readonly Rule[] }).activeRules ?? []).map(rule => rule.name);
	}

	it("re-renders a descendant's prompt when the parent refreshes an EDITED rule", async () => {
		const customRegistry = new AgentRegistry();
		const marker = Bun.nanoseconds().toString(36);
		const ruleName = `fanout-rule-${marker}`;
		const original = `ORIGINAL_FANOUT_BODY_${marker}`;
		const edited = `EDITED_FANOUT_BODY_${marker}`;

		// Parent and child share one cwd so the parent's disk rediscovery is the
		// same roster the child was spawned against — the real subagent shape.
		const parent = await makeSession({
			agentRegistry: customRegistry,
			agentId: "Parent",
			reloadableRules: true,
			seed: cwd => writeRule(cwd, ruleName, original, "alwaysApply: true\n"),
		});
		const child = await makeSession({
			agentRegistry: customRegistry,
			agentId: "Child",
			parentAgentId: "Parent",
			taskDepth: 1,
			reloadableRules: true,
			cwd: parent.cwd,
		});

		try {
			await child.session.refreshBaseSystemPrompt();
			expect(child.session.systemPrompt.join("\n")).toContain(original);

			await writeRule(parent.cwd, ruleName, edited, "alwaysApply: true\n");
			await parent.session.refresh("rules");
			// The rebuild is dispatched onto the child's own mutation tail; queue an
			// empty mutation behind it as a barrier (see the skill fan-out tests).
			await child.session.runToolRegistryMutation(async () => {});

			// Pre-fix: only the parent's closure and toolSession were updated, so
			// the child kept advertising the pre-edit rule body forever.
			expect(child.session.systemPrompt.join("\n")).toContain(edited);
			expect(child.session.systemPrompt.join("\n")).not.toContain(original);
		} finally {
			await child.dispose();
			await parent.dispose();
		}
	}, 20000);

	it("serves fresh rule:// content from a descendant after the parent refreshes", async () => {
		const customRegistry = new AgentRegistry();
		const marker = Bun.nanoseconds().toString(36);
		const ruleName = `fanout-snapshot-${marker}`;
		const edited = `EDITED_SNAPSHOT_BODY_${marker}`;

		const parent = await makeSession({
			agentRegistry: customRegistry,
			agentId: "Parent",
			reloadableRules: true,
			seed: cwd => writeRule(cwd, ruleName, "original snapshot body"),
		});
		const child = await makeSession({
			agentRegistry: customRegistry,
			agentId: "Child",
			parentAgentId: "Parent",
			taskDepth: 1,
			reloadableRules: true,
			cwd: parent.cwd,
		});

		try {
			await writeRule(parent.cwd, ruleName, edited);
			await parent.session.refresh("rules");

			// `read` threads the CHILD's own `session.activeRules` as resolution
			// context, and RuleProtocolHandler prefers it over the process global.
			// Pre-fix that snapshot stayed frozen at spawn, so the child resolved
			// the pre-edit body even though the global had been swapped.
			const readTool = child.session.agent.state.tools.find(t => t.name === "read");
			expect(readTool).toBeDefined();
			const result = await readTool!.execute(
				"call-child-rule-read",
				{ path: `rule://${ruleName}` },
				undefined,
				undefined as never,
				undefined as never,
			);
			expect(JSON.stringify(result.content)).toContain(edited);
		} finally {
			await child.dispose();
			await parent.dispose();
		}
	}, 20000);

	it("stops a descendant's TTSR rule from triggering after the parent refresh deletes it", async () => {
		const customRegistry = new AgentRegistry();
		const marker = Bun.nanoseconds().toString(36);
		const ruleName = `fanout-ttsr-${marker}`;
		const trigger = `FANOUT_TRIGGER_${marker}`;

		const parent = await makeSession({
			agentRegistry: customRegistry,
			agentId: "Parent",
			reloadableRules: true,
			seed: cwd => writeRule(cwd, ruleName, "ttsr body", `condition: "${trigger}"\nscope: "text"\n`),
		});
		const child = await makeSession({
			agentRegistry: customRegistry,
			agentId: "Child",
			parentAgentId: "Parent",
			taskDepth: 1,
			reloadableRules: true,
			cwd: parent.cwd,
		});

		try {
			// The child registered the condition rule on ITS OWN manager at spawn.
			expect(child.session.ttsrManager?.hasRule(ruleName)).toBe(true);
			expect(
				child.session.ttsrManager?.checkDelta(`has ${trigger} token`, { source: "text" }).map(r => r.name),
			).toEqual([ruleName]);
			child.session.ttsrManager?.resetBuffer();

			// DELETE the rule from disk and refresh from the parent.
			await fs.rm(path.join(parent.cwd, ".omp", "rules", `${ruleName}.md`));
			await parent.session.refresh("rules");

			// Pre-fix: the parent's `retainRules` reconciled only the PARENT's
			// manager, so the child's registration survived and the deleted rule
			// kept matching inside the child.
			expect(child.session.ttsrManager?.hasRule(ruleName)).toBe(false);
			expect(
				child.session.ttsrManager?.checkDelta(`has ${trigger} token`, { source: "text" }).map(r => r.name),
			).toEqual([]);
		} finally {
			await child.dispose();
			await parent.dispose();
		}
	}, 20000);

	it("leaves a descendant's prompt byte-identical when the rule roster did not move", async () => {
		// The no-op guard: a refresh that rediscovers the same roster must not
		// re-render a child's prompt, or every parent refresh breaks the child's
		// provider prompt caching.
		const customRegistry = new AgentRegistry();
		const marker = Bun.nanoseconds().toString(36);
		const ruleName = `fanout-stable-${marker}`;

		const parent = await makeSession({
			agentRegistry: customRegistry,
			agentId: "Parent",
			reloadableRules: true,
			seed: cwd => writeRule(cwd, ruleName, `STABLE_BODY_${marker}`, "alwaysApply: true\n"),
		});
		const child = await makeSession({
			agentRegistry: customRegistry,
			agentId: "Child",
			parentAgentId: "Parent",
			taskDepth: 1,
			reloadableRules: true,
			cwd: parent.cwd,
		});

		try {
			await child.session.refreshBaseSystemPrompt();
			const before = child.session.systemPrompt.join("\n");

			// No on-disk change at all.
			await parent.session.refresh("rules");
			await child.session.runToolRegistryMutation(async () => {});

			expect(child.session.systemPrompt.join("\n")).toBe(before);
		} finally {
			await child.dispose();
			await parent.dispose();
		}
	}, 20000);

	it("does not fan rules out to a non-descendant sibling sharing the registry", async () => {
		const customRegistry = new AgentRegistry();
		const marker = Bun.nanoseconds().toString(36);
		const ruleName = `fanout-sibling-${marker}`;
		const original = `SIBLING_ORIGINAL_${marker}`;

		const parent = await makeSession({
			agentRegistry: customRegistry,
			agentId: "Parent",
			reloadableRules: true,
			seed: cwd => writeRule(cwd, ruleName, original, "alwaysApply: true\n"),
		});
		// Registered on the SAME registry but NOT under Parent.
		const sibling = await makeSession({
			agentRegistry: customRegistry,
			agentId: "Sibling",
			parentAgentId: "OtherRoot",
			taskDepth: 1,
			reloadableRules: true,
			cwd: parent.cwd,
		});

		try {
			await sibling.session.refreshBaseSystemPrompt();
			const before = sibling.session.systemPrompt.join("\n");
			expect(before).toContain(original);

			await writeRule(parent.cwd, ruleName, `SIBLING_EDITED_${marker}`, "alwaysApply: true\n");
			await parent.session.refresh("rules");
			await sibling.session.runToolRegistryMutation(async () => {});

			// Not Parent's descendant, so its roster is untouched.
			expect(sibling.session.systemPrompt.join("\n")).toBe(before);
		} finally {
			await sibling.dispose();
			await parent.dispose();
		}
	}, 20000);

	// The real spawn path ALWAYS forwards `session.rules`, so every structured
	// subagent has a defined rule policy even when nobody restricted it. Treating
	// that as an EXPLICIT policy pinned the child to its launch-time snapshot, so
	// an edited rule stayed stale in the child forever — the exact staleness this
	// fan-out exists to fix.
	it("refreshes an EDITED rule in a child spawned with an inherited policy", async () => {
		const customRegistry = new AgentRegistry();
		const marker = Bun.nanoseconds().toString(36);
		const ruleName = `inherited-policy-${marker}`;
		const edited = `EDITED_INHERITED_BODY_${marker}`;

		const parent = await makeSession({
			agentRegistry: customRegistry,
			agentId: "Parent",
			reloadableRules: true,
			seed: cwd => writeRule(cwd, ruleName, "original inherited body"),
		});
		// Forwarded rules + `rulesInherited`, exactly what the spawn path sends.
		const child = await makeSession({
			agentRegistry: customRegistry,
			agentId: "Child",
			parentAgentId: "Parent",
			taskDepth: 1,
			cwd: parent.cwd,
			// The spawn path forwards the ToolSession's `rules` (the parent's full
			// discovered roster); the process-global active set is the same list
			// here, and is what the harness can reach.
			inheritedRules: getActiveRules(),
		});

		try {
			await writeRule(parent.cwd, ruleName, edited);
			await parent.session.refresh("rules");

			const readTool = child.session.agent.state.tools.find(t => t.name === "read");
			expect(readTool).toBeDefined();
			const result = await readTool!.execute(
				"call-inherited-rule-read",
				{ path: `rule://${ruleName}` },
				undefined,
				undefined as never,
				undefined as never,
			);
			expect(JSON.stringify(result.content)).toContain(edited);
		} finally {
			await child.dispose();
			await parent.dispose();
		}
	}, 20000);
	// The child's OWN refresh is a different path from the parent fan-out above.
	// A structured subagent's `#rulesPolicy` is the launch-time parent array and
	// never moves, so re-bucketing it on `refresh("rules")` rolled the child back
	// to the launch-time rule contents — undoing a newer roster the parent had
	// already installed.
	it("keeps a parent-refreshed rule current through the child's own rules refresh", async () => {
		const customRegistry = new AgentRegistry();
		const marker = Bun.nanoseconds().toString(36);
		const ruleName = `child-own-refresh-${marker}`;
		const original = `ORIGINAL_CHILD_BODY_${marker}`;
		const edited = `EDITED_CHILD_BODY_${marker}`;

		const parent = await makeSession({
			agentRegistry: customRegistry,
			agentId: "Parent",
			reloadableRules: true,
			seed: cwd => writeRule(cwd, ruleName, original),
		});
		const child = await makeSession({
			agentRegistry: customRegistry,
			agentId: "Child",
			parentAgentId: "Parent",
			taskDepth: 1,
			cwd: parent.cwd,
			inheritedRules: getActiveRules(),
		});

		try {
			// The parent rediscovers the edited rule and fans it into the child.
			await writeRule(parent.cwd, ruleName, edited);
			await parent.session.refresh("rules");

			const readRule = async (): Promise<string> => {
				const readTool = child.session.agent.state.tools.find(t => t.name === "read");
				expect(readTool).toBeDefined();
				const result = await readTool!.execute(
					`call-child-refresh-${Bun.nanoseconds().toString(36)}`,
					{ path: `rule://${ruleName}` },
					undefined,
					undefined as never,
					undefined as never,
				);
				return JSON.stringify(result.content);
			};
			expect(await readRule()).toContain(edited);

			// Now the CHILD refreshes its own rules. Its inherited policy is the
			// stale launch-time array; re-bucketing that republished the pre-edit
			// content and rolled the fan-out back.
			await child.session.refresh("rules");

			const afterOwnRefresh = await readRule();
			expect(afterOwnRefresh).toContain(edited);
			expect(afterOwnRefresh).not.toContain(original);
		} finally {
			await child.dispose();
			await parent.dispose();
		}
	}, 20000);

	// The process-global rule snapshot belongs to the TOP-LEVEL session: `sdk.ts`
	// publishes it at init only for one, and contextless consumers (a
	// `RuleProtocolHandler` with no session-local array) read it. A subagent
	// buckets under the CHILD's agent name, so its roster is a different set —
	// publishing it replaced the parent's globals with the child's scoped view
	// until the parent itself refreshed.
	it("does not let a child's rules refresh replace the process-global rule snapshot", async () => {
		const customRegistry = new AgentRegistry();
		const marker = Bun.nanoseconds().toString(36);
		// Scoped to `main`, so the CHILD's own bucketing (agent name `sub`)
		// legitimately excludes it — which is exactly what must not reach the
		// process globals.
		const mainOnly = `main-scoped-global-${marker}`;

		const parent = await makeSession({
			agentRegistry: customRegistry,
			agentId: "Parent",
			reloadableRules: true,
			seed: cwd => writeRule(cwd, mainOnly, "main scoped body", "alwaysApply: true\nagents:\n  - main\n"),
		});
		const child = await makeSession({
			agentRegistry: customRegistry,
			agentId: "Child",
			parentAgentId: "Parent",
			taskDepth: 1,
			cwd: parent.cwd,
			inheritedRules: getActiveRules(),
		});

		try {
			// The PARENT owns the globals: its refresh republishes the main-scoped
			// rule, establishing the state a contextless consumer would read.
			await parent.session.refresh("rules");
			expect(getActiveRules().map(rule => rule.name)).toContain(mainOnly);

			// The child is granted `refresh` and runs a rules refresh of its own.
			await child.session.refresh("rules");

			// Pre-fix the child's publication was unconditional, so the globals now
			// held the child's `sub`-scoped roster and the parent's main-scoped rule
			// was gone from `rule://` for every contextless consumer.
			expect(getActiveRules().map(rule => rule.name)).toContain(mainOnly);

			// And the child's refresh really did re-bucket under its OWN agent
			// scope: the fix suppresses the global swap, not the child's narrowing.
			// Without this the test would also pass if the child's refresh had
			// simply become a no-op, or if `sub` scoping had stopped narrowing at
			// all — either of which makes the global assertion above vacuous.
			expect(childRuleNames(child.session)).not.toContain(mainOnly);
		} finally {
			await child.dispose();
			await parent.dispose();
		}
	}, 20000);

	// The other direction of the same gate. The test above shares a process with
	// a parent refresh, so suppressing publication for EVERY session reds it too
	// — meaning it detects a wrong gate but not which way it is wrong. This one
	// isolates the top-level half: a main session's refresh must keep publishing,
	// because that is how `rule://` self-heals for contextless consumers.
	it("still publishes the process-global rule snapshot for a top-level refresh", async () => {
		const marker = Bun.nanoseconds().toString(36);
		const topLevel = `top-level-global-${marker}`;

		const parent = await makeSession({
			agentId: "Solo",
			reloadableRules: true,
		});

		try {
			// Written AFTER construction, so startup cannot have published it — the
			// refresh is the only thing that can put it in the globals. (`seed` runs
			// before the session is built, which would make the precondition false.)
			writeRule(parent.cwd, topLevel, "top level body", "alwaysApply: true\n");
			expect(getActiveRules().map(rule => rule.name)).not.toContain(topLevel);

			await parent.session.refresh("rules");

			// A main session owns the globals, so its refresh must swap them.
			expect(getActiveRules().map(rule => rule.name)).toContain(topLevel);
		} finally {
			await parent.dispose();
		}
	}, 20000);
});
