/**
 * In-session `refresh` roster wiring, exercised through the real
 * `createAgentSession` SDK path (not a hand-wired session), so it defends the
 * user-visible contracts:
 *
 *   - A rules refresh reaches the model prompt. `rebuildSystemPrompt` renders
 *     from SDK-closure roster locals; without `applyReloadedRoster` wired, a
 *     refresh reports success and rebuilds the SAME stale launch-time roster.
 *   - Editing a rule's BODY without renaming it is detected. `rulesEqual`
 *     compares content identity, not just name+path, so an edited rulebook
 *     entry rebuilds the advertised roster.
 *   - `refresh('all')` discovers skills against the freshly reloaded settings,
 *     not the construction-time snapshot, so a changed `skills.*` config takes
 *     effect on the same refresh.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Api, Model, ModelSpec } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { BUILTIN_DEFAULTS_PROVIDER_ID, getActiveRules } from "@oh-my-pi/pi-coding-agent/capability/rule";
import { RuleProtocolHandler } from "@oh-my-pi/pi-coding-agent/internal-urls/rule-protocol";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import { runStructuredSubagent } from "@oh-my-pi/pi-coding-agent/task/structured-subagent";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { TempDir } from "@oh-my-pi/pi-utils";

function buildLocalModel(api: string): Model<Api> {
	return buildModel({
		id: "refresh-roster-model",
		name: "Refresh Roster Model",
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

interface Harness {
	session: AgentSession;
	cwd: string;
	settingsPath: string;
	dispose: () => Promise<void>;
}

async function makeHarness(
	overrides: Record<string, unknown> = {},
	sdkOverrides: Record<string, unknown> = {},
	seed?: (cwd: string) => Promise<void>,
): Promise<Harness> {
	const tempDir = TempDir.createSync("@pi-refresh-roster-");
	const cwd = tempDir.path();
	// A repo root so project-scoped RULES.md discovery walks up and stops here.
	await fs.mkdir(path.join(cwd, ".git"), { recursive: true });
	// Stage on-disk config BEFORE the session is constructed, so its initial
	// roster discovery picks these up (exposing bugs where a later settings-only
	// refresh must preserve the construction-time roster).
	if (seed) await seed(cwd);
	const api = `refresh-roster-${Bun.nanoseconds().toString(36)}`;
	const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
	authStorage.setRuntimeApiKey("managed-primary", "test-key");
	const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));

	const { session } = await createAgentSession({
		cwd,
		agentDir: cwd,
		sessionManager: SessionManager.inMemory(cwd),
		authStorage,
		modelRegistry,
		settings: await Settings.loadIsolated({
			cwd,
			agentDir: cwd,
			overrides: { "compaction.enabled": false, ...overrides },
		}),
		model: buildLocalModel(api),
		disableExtensionDiscovery: true,
		// contextFiles/skills/rules intentionally omitted so discovery runs on disk.
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
		skipPythonPreflight: true,
		...sdkOverrides,
	});

	return {
		session,
		cwd,
		settingsPath: path.join(cwd, "config.yml"),
		dispose: async () => {
			await session.dispose();
			authStorage.close();
			await tempDir.remove();
		},
	};
}

/** The live production ToolSession the SDK built this session's tools against. */
function toolSessionOf(session: AgentSession): ToolSession {
	const readTool = session.getToolByName("read");
	if (!readTool) throw new Error("Expected the read tool");
	const inner = Reflect.get(readTool, "session");
	if (!inner || typeof inner !== "object") throw new Error("Expected a ToolSession on the read tool");
	return inner as ToolSession;
}

/** Names in the SESSION-LOCAL rule snapshot `rule://` resolution prefers. */
function sessionRuleNames(session: AgentSession): string[] {
	return (toolSessionOf(session).activeRules ?? []).map(rule => rule.name).sort();
}

/** Resolve `rule://<name>` through the `read` tool, which threads the session-local array. */
async function readRuleUrl(session: AgentSession, ruleName: string): Promise<string> {
	const readTool = session.getToolByName("read");
	if (!readTool) throw new Error("Expected the read tool");
	const result = await readTool.execute(
		`call-rule-${ruleName}`,
		{ path: `rule://${ruleName}` },
		undefined,
		undefined as never,
		undefined as never,
	);
	return JSON.stringify(result.content);
}

describe("AgentSession refresh: roster reaches the prompt", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("renders a newly added always-apply rule into the system prompt after refresh('rules')", async () => {
		const marker = Bun.nanoseconds().toString(36);
		const ruleText = `NEWLY_ADDED_RULE_${marker}`;
		const h = await makeHarness();
		try {
			await h.session.refreshBaseSystemPrompt();
			expect(h.session.systemPrompt.join("\n")).not.toContain(ruleText);

			await fs.mkdir(path.join(h.cwd, ".omp"), { recursive: true });
			await fs.writeFile(path.join(h.cwd, ".omp", "RULES.md"), `${ruleText}\n`);

			const result = await h.session.refresh("rules");
			expect(result.rules).toBeGreaterThan(0);

			// Pre-fix (stale-roster rebuild), the prompt omitted the new rule even
			// though refresh reported success.
			expect(h.session.systemPrompt.join("\n")).toContain(ruleText);
		} finally {
			await h.dispose();
		}
	});

	it("re-renders an EDITED rule body (same name) into the prompt after refresh('rules')", async () => {
		const marker = Bun.nanoseconds().toString(36);
		const original = `ORIGINAL_BODY_${marker}`;
		const edited = `EDITED_BODY_${marker}`;
		const h = await makeHarness();
		try {
			await fs.mkdir(path.join(h.cwd, ".omp"), { recursive: true });
			const rulesMd = path.join(h.cwd, ".omp", "RULES.md");
			await fs.writeFile(rulesMd, `${original}\n`);
			await h.session.refresh("rules");
			expect(h.session.systemPrompt.join("\n")).toContain(original);

			// Edit the SAME rule's body without renaming: name+path unchanged.
			await fs.writeFile(rulesMd, `${edited}\n`);
			await h.session.refresh("rules");

			const prompt = h.session.systemPrompt.join("\n");
			// Pre-fix (rulesEqual compared only name+path), rosterChanged stayed
			// false and the prompt kept the original body.
			expect(prompt).toContain(edited);
			expect(prompt).not.toContain(original);
		} finally {
			await h.dispose();
		}
	});

	it("re-reads live skills settings before discovery on refresh('all')", async () => {
		const marker = Bun.nanoseconds().toString(36);
		const skillName = `refresh-skill-${marker}`;
		const h = await makeHarness();
		try {
			// A project skill under .omp/skills is discoverable on the first refresh.
			await fs.mkdir(path.join(h.cwd, ".omp", "skills", skillName), { recursive: true });
			await fs.writeFile(
				path.join(h.cwd, ".omp", "skills", skillName, "SKILL.md"),
				`---\nname: ${skillName}\ndescription: ${skillName} fixture\n---\nbody\n`,
			);
			await h.session.refresh("all");
			expect(h.session.skills.map(s => s.name)).toContain(skillName);

			// Turn skills off on disk. `refresh('all')` reloads settings BEFORE the
			// roster scan, so the disabled config must take effect on THIS refresh.
			await fs.writeFile(h.settingsPath, "skills:\n  enabled: false\n");
			await h.session.refresh("all");

			// Pre-fix (roster scanned with the construction-time skills snapshot
			// and before settings.reload()), the skill stayed loaded.
			expect(h.session.skills.map(s => s.name)).not.toContain(skillName);
		} finally {
			await h.dispose();
		}
	});

	it("keeps a --no-skills roster disabled across refresh (no ambient re-enable)", async () => {
		const marker = Bun.nanoseconds().toString(36);
		const skillName = `refresh-skill-${marker}`;
		// SDK `skills: []` (the --no-skills path) marks the roster non-reloadable.
		const h = await makeHarness({}, { skills: [] });
		try {
			// A project skill lands on disk that discovery WOULD pick up.
			await fs.mkdir(path.join(h.cwd, ".omp", "skills", skillName), { recursive: true });
			await fs.writeFile(
				path.join(h.cwd, ".omp", "skills", skillName, "SKILL.md"),
				`---\nname: ${skillName}\ndescription: ${skillName} fixture\n---\nbody\n`,
			);
			expect(h.session.skills.map(s => s.name)).not.toContain(skillName);

			await h.session.refresh("all");

			// Pre-fix (refresh scanned disk unconditionally), the ambient skill was
			// re-discovered and enabled even though the session opted out.
			expect(h.session.skills.map(s => s.name)).not.toContain(skillName);
		} finally {
			await h.dispose();
		}
	});

	it("keeps a --no-rules policy across refresh (no ambient rule re-enable)", async () => {
		const marker = Bun.nanoseconds().toString(36);
		const ruleText = `AMBIENT_RULE_${marker}`;
		// SDK `rules: []` (the --no-rules path) supplies an explicit empty policy.
		const h = await makeHarness({}, { rules: [] });
		try {
			await fs.mkdir(path.join(h.cwd, ".omp"), { recursive: true });
			await fs.writeFile(path.join(h.cwd, ".omp", "RULES.md"), `${ruleText}\n`);

			const result = await h.session.refresh("rules");

			// Pre-fix (refresh scanned the rules capability unconditionally), the
			// ambient RULES.md was re-discovered and rendered despite --no-rules.
			expect(result.rules).toBe(0);
			expect(h.session.systemPrompt.join("\n")).not.toContain(ruleText);
		} finally {
			await h.dispose();
		}
	});

	it("refreshes the skill-settings snapshot so enableSkillCommands takes effect", async () => {
		const h = await makeHarness();
		try {
			// Seed the initial value on disk (not a runtime override, which would
			// outrank the reload), then flip it and refresh.
			await fs.writeFile(h.settingsPath, "skills:\n  enableSkillCommands: false\n");
			await h.session.refresh("all");
			expect(h.session.skillsSettings?.enableSkillCommands).toBe(false);

			await fs.writeFile(h.settingsPath, "skills:\n  enableSkillCommands: true\n");
			await h.session.refresh("all");

			// Pre-fix (refresh left #skillsSettings at the construction snapshot),
			// the session kept reporting the stale enableSkillCommands value.
			expect(h.session.skillsSettings?.enableSkillCommands).toBe(true);
		} finally {
			await h.dispose();
		}
	});

	it("notifies command-metadata consumers when a refresh adds a skill (flag unchanged)", async () => {
		const marker = Bun.nanoseconds().toString(36);
		const skillName = `refresh-cmd-skill-${marker}`;
		// enableSkillCommands defaults to true, so it stays unchanged across the
		// refresh below — the only signal is the skill-roster change.
		const h = await makeHarness();
		try {
			let notified = 0;
			const unsubscribe = h.session.subscribeCommandMetadataChanged(() => {
				notified++;
			});
			// A project skill lands on disk AFTER construction, so the next
			// refresh('all') discovers it: skillsChanged true, flag unchanged.
			await fs.mkdir(path.join(h.cwd, ".omp", "skills", skillName), { recursive: true });
			await fs.writeFile(
				path.join(h.cwd, ".omp", "skills", skillName, "SKILL.md"),
				`---\nname: ${skillName}\ndescription: ${skillName} fixture\n---\nbody\n`,
			);

			await h.session.refresh("all");

			expect(h.session.skills.map(s => s.name)).toContain(skillName);
			// Pre-fix (notify gated on the enable flag alone), a roster change with
			// commands already enabled left the flag unchanged, so the new
			// /skill:* command stayed absent from consumers until an unrelated
			// notification.
			expect(notified).toBeGreaterThan(0);
			unsubscribe();
		} finally {
			await h.dispose();
		}
	});
});

describe("AgentSession refresh: settings-only TTSR gating reconcile", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("stops a disabled condition rule from triggering after refresh('settings')", async () => {
		const marker = Bun.nanoseconds().toString(36);
		const ruleName = `no-foo-${marker}`;
		const trigger = `FORBIDDEN_${marker}`;
		const h = await makeHarness();
		try {
			// A condition-bearing rule on disk, discovered by a rules refresh: it
			// registers with the TTSR manager and triggers on its condition.
			await fs.mkdir(path.join(h.cwd, ".omp", "rules"), { recursive: true });
			await fs.writeFile(
				path.join(h.cwd, ".omp", "rules", `${ruleName}.md`),
				`---\nname: ${ruleName}\ndescription: blocks\ncondition: "${trigger}"\nscope: "text"\n---\nbody\n`,
			);
			await h.session.refresh("rules");
			const mgr = h.session.ttsrManager;
			expect(mgr).toBeDefined();
			expect(mgr?.hasRule(ruleName)).toBe(true);
			expect(mgr?.checkDelta(`has ${trigger} token`, { source: "text" }).map(r => r.name)).toEqual([ruleName]);
			mgr?.resetBuffer();

			// Disable the rule on disk and refresh ONLY settings — never the roster.
			// The gating field must take effect without a disk rediscovery.
			await fs.writeFile(h.settingsPath, `ttsr:\n  disabledRules:\n    - ${ruleName}\n`);
			await h.session.refresh("settings");

			// Pre-fix (reconfigure stored disabledRules but matching never read it,
			// and the roster re-bucket that enforces it never runs on a settings
			// refresh), the disabled rule kept triggering.
			expect(mgr?.hasRule(ruleName)).toBe(false);
			expect(mgr?.checkDelta(`has ${trigger} token`, { source: "text" })).toEqual([]);
		} finally {
			await h.dispose();
		}
	});

	it("preserves non-TTSR rules on a settings-only refresh, dropping only the newly-gated rule", async () => {
		const marker = Bun.nanoseconds().toString(36);
		const keepName = `keep-me-${marker}`;
		const ttsrName = `no-foo-${marker}`;
		const trigger = `FORBIDDEN_${marker}`;
		// Seed BOTH rules on disk before construction so the session's initial
		// roster holds the non-TTSR (always-apply) rule AND registers the TTSR
		// condition rule — never populated by a settings-only refresh.
		const h = await makeHarness({}, {}, async cwd => {
			await fs.mkdir(path.join(cwd, ".omp", "rules"), { recursive: true });
			await fs.writeFile(
				path.join(cwd, ".omp", "rules", `${keepName}.md`),
				`---\nname: ${keepName}\nalwaysApply: true\n---\nkeep body\n`,
			);
			await fs.writeFile(
				path.join(cwd, ".omp", "rules", `${ttsrName}.md`),
				`---\nname: ${ttsrName}\ndescription: blocks\ncondition: "${trigger}"\nscope: "text"\n---\nbody\n`,
			);
		});
		try {
			// Both rules are live in the published active set after construction.
			expect(getActiveRules().map(r => r.name)).toEqual(expect.arrayContaining([keepName, ttsrName]));

			// Disable ONLY the TTSR condition rule on disk, then refresh settings —
			// never the roster.
			await fs.writeFile(h.settingsPath, `ttsr:\n  disabledRules:\n    - ${ttsrName}\n`);
			await h.session.refresh("settings");

			const activeNames = getActiveRules().map(r => r.name);
			// Pre-fix: `#rosterRules` was empty, so the re-bucket rebuilt from TTSR
			// entries alone and republished an empty rulebook/always set — the
			// non-TTSR always-apply rule vanished from the active rules.
			expect(activeNames).toContain(keepName);
			// The newly-gated TTSR rule is the only one dropped.
			expect(activeNames).not.toContain(ttsrName);
			expect(h.session.ttsrManager?.hasRule(ttsrName)).toBe(false);
		} finally {
			await h.dispose();
		}
	});

	it("re-enables a rule when its disabledRules entry is reverted (settings-only, both directions)", async () => {
		const marker = Bun.nanoseconds().toString(36);
		const alwaysName = `revertible-always-${marker}`;
		const alwaysBody = `REVERTIBLE_ALWAYS_BODY_${marker}`;
		const ttsrName = `revertible-ttsr-${marker}`;
		const trigger = `REVERTIBLE_TRIGGER_${marker}`;
		// Both an always-apply rule and a condition-bearing TTSR rule, so the
		// round trip is proven for both buckets the gating reaches.
		const h = await makeHarness({}, {}, async cwd => {
			await fs.mkdir(path.join(cwd, ".omp", "rules"), { recursive: true });
			await fs.writeFile(
				path.join(cwd, ".omp", "rules", `${alwaysName}.md`),
				`---\nname: ${alwaysName}\nalwaysApply: true\n---\n${alwaysBody}\n`,
			);
			await fs.writeFile(
				path.join(cwd, ".omp", "rules", `${ttsrName}.md`),
				`---\nname: ${ttsrName}\ndescription: blocks\ncondition: "${trigger}"\nscope: "text"\n---\nbody\n`,
			);
		});
		try {
			expect(getActiveRules().map(r => r.name)).toEqual(expect.arrayContaining([alwaysName, ttsrName]));
			expect(h.session.ttsrManager?.hasRule(ttsrName)).toBe(true);

			// Disable BOTH on disk, then refresh settings only.
			await fs.writeFile(h.settingsPath, `ttsr:\n  disabledRules:\n    - ${alwaysName}\n    - ${ttsrName}\n`);
			await h.session.refresh("settings");

			const disabledNames = getActiveRules().map(r => r.name);
			expect(disabledNames).not.toContain(alwaysName);
			expect(disabledNames).not.toContain(ttsrName);
			expect(h.session.ttsrManager?.hasRule(ttsrName)).toBe(false);
			expect(h.session.systemPrompt.join("\n")).not.toContain(alwaysBody);

			// REVERT the setting and refresh settings only — still no disk
			// rediscovery. Both rules must come back.
			await fs.writeFile(h.settingsPath, "ttsr:\n  disabledRules: []\n");
			await h.session.refresh("settings");

			const restoredNames = getActiveRules().map(r => r.name);
			// Pre-fix: the reconcile re-bucketed the surviving GATED set, from which
			// both rules had already been removed, so `currentRules` no longer held
			// them and reverting the setting could never restore either one.
			expect(restoredNames).toContain(alwaysName);
			expect(restoredNames).toContain(ttsrName);
			expect(h.session.ttsrManager?.hasRule(ttsrName)).toBe(true);
			expect(h.session.ttsrManager?.checkDelta(`has ${trigger} token`, { source: "text" }).map(r => r.name)).toEqual(
				[ttsrName],
			);
			h.session.ttsrManager?.resetBuffer();
			expect(h.session.systemPrompt.join("\n")).toContain(alwaysBody);
		} finally {
			await h.dispose();
		}
	});

	it("re-enables a builtin rule when builtinRules is flipped back on (settings-only)", async () => {
		const h = await makeHarness();
		try {
			const builtinNames = () =>
				getActiveRules()
					.filter(rule => rule._source?.provider === BUILTIN_DEFAULTS_PROVIDER_ID)
					.map(rule => rule.name);
			// Guard the premise: this session actually carries bundled defaults, so
			// dropping and restoring them is observable.
			const initialBuiltins = builtinNames();
			expect(initialBuiltins.length).toBeGreaterThan(0);

			await fs.writeFile(h.settingsPath, "ttsr:\n  builtinRules: false\n");
			await h.session.refresh("settings");
			expect(builtinNames()).toEqual([]);

			await fs.writeFile(h.settingsPath, "ttsr:\n  builtinRules: true\n");
			await h.session.refresh("settings");

			// Pre-fix: the builtins were gone from the gated set the reconcile
			// re-bucketed, so flipping the lever back on restored nothing.
			expect(builtinNames()).toEqual(expect.arrayContaining(initialBuiltins));
		} finally {
			await h.dispose();
		}
	});

	// `ttsr.enabled` false->true across two `/refresh settings` calls must
	// PRESERVE registrations and injection state (reconfigure's stated contract),
	// so a `repeatMode: "once"` rule that was already injected does not fire
	// again. Pre-fix, the disabled refresh's `bucketRules` pass rejected every
	// rule (addOrUpdateRule gates on `enabled`), so `ttsrRuleNames` was empty and
	// `retainRules` deleted every registration AND injection record — re-enabling
	// registered from scratch and re-armed the spent rule.
	it("does not re-fire an already-injected once rule after ttsr.enabled is flipped off and back on", async () => {
		const marker = Bun.nanoseconds().toString(36);
		const ruleName = `spent-once-${marker}`;
		const trigger = `SPENT_ONCE_${marker}`;
		const h = await makeHarness({}, {}, async cwd => {
			await fs.mkdir(path.join(cwd, ".omp", "rules"), { recursive: true });
			await fs.writeFile(
				path.join(cwd, ".omp", "rules", `${ruleName}.md`),
				`---\nname: ${ruleName}\ndescription: blocks\ncondition: "${trigger}"\nscope: "text"\n---\nbody\n`,
			);
		});
		try {
			const mgr = h.session.ttsrManager;
			expect(mgr).toBeDefined();
			// The rule is live and fires on its condition...
			expect(mgr?.checkDelta(`has ${trigger} token`, { source: "text" }).map(r => r.name)).toEqual([ruleName]);
			mgr?.resetBuffer();
			// ...then it is injected, and `repeatMode: "once"` (the default) spends
			// it: it must never fire again for the rest of the session.
			mgr?.markInjectedByNames([ruleName]);
			expect(mgr?.checkDelta(`has ${trigger} token`, { source: "text" })).toEqual([]);
			mgr?.resetBuffer();

			// Disable TTSR globally on disk and refresh settings.
			await fs.writeFile(h.settingsPath, "ttsr:\n  enabled: false\n");
			await h.session.refresh("settings");
			expect(h.session.settings.get("ttsr.enabled")).toBe(false);

			// Re-enable it and refresh again — no roster rediscovery either time.
			await fs.writeFile(h.settingsPath, "ttsr:\n  enabled: true\n");
			await h.session.refresh("settings");
			expect(h.session.settings.get("ttsr.enabled")).toBe(true);

			// The registration survived the round trip...
			expect(mgr?.hasRule(ruleName)).toBe(true);
			// ...and so did the injection record, so the spent `once` rule stays
			// spent instead of firing a second time.
			expect(mgr?.getInjectedRuleNames()).toContain(ruleName);
			expect(mgr?.checkDelta(`has ${trigger} token`, { source: "text" })).toEqual([]);
			mgr?.resetBuffer();
		} finally {
			await h.dispose();
		}
	});

	// While TTSR is disabled `retainRules` intentionally no-ops, so a
	// `/refresh rules` in that window installs a FRESH source roster while every
	// stale registration survives. The later settings-only re-enable must not let
	// those retained registrations outrank the roster: pre-fix the reconcile
	// unioned the live rules FIRST and gave each one precedence by name, so a
	// rule deleted from disk came back and an edited one resumed with its
	// pre-edit conditions and content until another rules refresh.
	it("does not resurrect a rule deleted while TTSR was disabled, after a re-enable", async () => {
		const marker = Bun.nanoseconds().toString(36);
		const ruleName = `deleted-while-off-${marker}`;
		const trigger = `DELETED_WHILE_OFF_${marker}`;
		const rulePath = (cwd: string) => path.join(cwd, ".omp", "rules", `${ruleName}.md`);
		const h = await makeHarness({}, {}, async cwd => {
			await fs.mkdir(path.join(cwd, ".omp", "rules"), { recursive: true });
			await fs.writeFile(
				rulePath(cwd),
				`---\nname: ${ruleName}\ndescription: blocks\ncondition: "${trigger}"\nscope: "text"\n---\nbody\n`,
			);
		});
		try {
			const mgr = h.session.ttsrManager;
			expect(mgr).toBeDefined();
			expect(mgr?.hasRule(ruleName)).toBe(true);

			// 1. Disable TTSR on disk, settings-only refresh.
			await fs.writeFile(h.settingsPath, "ttsr:\n  enabled: false\n");
			await h.session.refresh("settings");
			// The registration is deliberately RETAINED while disabled. `hasRule`
			// reports false whenever TTSR is off regardless of the registry, so
			// probe the ungated `getRules()` for what is actually still registered.
			expect(mgr?.getRules().map(rule => rule.name)).toContain(ruleName);

			// 2. DELETE the rule from disk and run a rules refresh in that window.
			//    The fresh source roster no longer contains it, but `retainRules`
			//    no-ops while disabled, so the registration still stands.
			await fs.rm(rulePath(h.cwd));
			await h.session.refresh("rules");

			// 3. Re-enable TTSR — settings only, no disk rediscovery.
			await fs.writeFile(h.settingsPath, "ttsr:\n  enabled: true\n");
			await h.session.refresh("settings");
			expect(h.session.settings.get("ttsr.enabled")).toBe(true);

			// The deleted rule must be GONE, not resurrected from the retained
			// registration, and must no longer trigger or resolve.
			expect(mgr?.hasRule(ruleName)).toBe(false);
			expect(mgr?.checkDelta(`has ${trigger} token`, { source: "text" })).toEqual([]);
			mgr?.resetBuffer();
			expect(getActiveRules().map(rule => rule.name)).not.toContain(ruleName);
		} finally {
			await h.dispose();
		}
	});

	it("uses the edited rule, not the retained one, after a TTSR re-enable", async () => {
		const marker = Bun.nanoseconds().toString(36);
		const ruleName = `edited-while-off-${marker}`;
		const oldTrigger = `OLD_TRIGGER_${marker}`;
		const newTrigger = `NEW_TRIGGER_${marker}`;
		const rulePath = (cwd: string) => path.join(cwd, ".omp", "rules", `${ruleName}.md`);
		const h = await makeHarness({}, {}, async cwd => {
			await fs.mkdir(path.join(cwd, ".omp", "rules"), { recursive: true });
			await fs.writeFile(
				rulePath(cwd),
				`---\nname: ${ruleName}\ndescription: blocks\ncondition: "${oldTrigger}"\nscope: "text"\n---\nbody\n`,
			);
		});
		try {
			const mgr = h.session.ttsrManager;
			expect(mgr?.checkDelta(`has ${oldTrigger} token`, { source: "text" }).map(r => r.name)).toEqual([ruleName]);
			mgr?.resetBuffer();

			await fs.writeFile(h.settingsPath, "ttsr:\n  enabled: false\n");
			await h.session.refresh("settings");

			// EDIT the condition while disabled, then refresh the roster.
			await fs.writeFile(
				rulePath(h.cwd),
				`---\nname: ${ruleName}\ndescription: blocks\ncondition: "${newTrigger}"\nscope: "text"\n---\nbody\n`,
			);
			await h.session.refresh("rules");

			await fs.writeFile(h.settingsPath, "ttsr:\n  enabled: true\n");
			await h.session.refresh("settings");

			// The rule is live under its NEW condition...
			expect(mgr?.hasRule(ruleName)).toBe(true);
			expect(mgr?.checkDelta(`has ${newTrigger} token`, { source: "text" }).map(r => r.name)).toEqual([ruleName]);
			mgr?.resetBuffer();
			// ...and the pre-edit condition no longer matches. Pre-fix the retained
			// registration won by name, so the OLD condition was still compiled.
			expect(mgr?.checkDelta(`has ${oldTrigger} token`, { source: "text" })).toEqual([]);
			mgr?.resetBuffer();
		} finally {
			await h.dispose();
		}
	});
	// Gating changes applied WHILE TTSR is off are the case the deleted-rule
	// handling does not cover. `retainRules` no-ops while disabled, so a
	// registration retained across `ttsr.enabled: false` is still in the manager
	// when the rule is then added to `disabledRules`. `bucketRules` correctly
	// omits it from the buckets, but spreading the manager's registrations
	// unfiltered republished it anyway.
	it("stops publishing a rule gated off while TTSR was disabled", async () => {
		const marker = Bun.nanoseconds().toString(36);
		const ruleName = `gated-while-off-${marker}`;
		const trigger = `GATED_WHILE_OFF_${marker}`;
		const h = await makeHarness({}, {}, async cwd => {
			await fs.mkdir(path.join(cwd, ".omp", "rules"), { recursive: true });
			await fs.writeFile(
				path.join(cwd, ".omp", "rules", `${ruleName}.md`),
				`---\nname: ${ruleName}\ndescription: blocks\ncondition: "${trigger}"\nscope: "text"\n---\nbody\n`,
			);
		});
		try {
			const mgr = h.session.ttsrManager;
			expect(mgr).toBeDefined();
			expect(mgr?.hasRule(ruleName)).toBe(true);
			expect(getActiveRules().map(rule => rule.name)).toContain(ruleName);

			// 1. Turn TTSR off. The registration is deliberately RETAINED.
			await fs.writeFile(h.settingsPath, "ttsr:\n  enabled: false\n");
			await h.session.refresh("settings");
			expect(mgr?.getRules().map(rule => rule.name)).toContain(ruleName);

			// 2. Gate the rule off while TTSR is still disabled. No disk
			//    rediscovery, so the rule stays in the source roster and only the
			//    gating verdict moves.
			await fs.writeFile(h.settingsPath, `ttsr:\n  enabled: false\n  disabledRules:\n    - ${ruleName}\n`);
			await h.session.refresh("settings");

			// Guard the premise: TTSR is genuinely still off, so `retainRules`
			// no-opped and the stale registration really does survive.
			expect(h.session.settings.get("ttsr.enabled")).toBe(false);
			expect(mgr?.getRules().map(rule => rule.name)).toContain(ruleName);

			// The disabled rule must NOT be published: the session snapshot must not
			// carry it and `rule://` must no longer serve it, without waiting for
			// TTSR to be re-enabled. Resolution REJECTS an unpublished name, which
			// is the observable contract here.
			expect(getActiveRules().map(rule => rule.name)).not.toContain(ruleName);
			await expect(
				new RuleProtocolHandler().resolve({ rawHost: ruleName, hostname: ruleName } as never),
			).rejects.toThrow(`Unknown rule: ${ruleName}`);
		} finally {
			await h.dispose();
		}
	});
});

// The equivalence a disabled session owes: whatever route it took to get
// there, a session running with TTSR off must end up with exactly the rule set
// a FRESH disabled session would have. `retainRules` deliberately no-ops while
// disabled, so a roster refresh in that window still holds every old
// registration internally — and filtering the republication only by disk
// discovery put all of them back into `activeRules`.
describe("AgentSession refresh('all'): a disabled-TTSR session matches a fresh disabled session", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	// A DESCRIBED conditioned rule: with TTSR off the manager rejects it, so it
	// falls through to the rulebook bucket. Republishing the retained
	// registration on top lists the same rule TWICE.
	it("does not duplicate a described conditioned rule that fell through to the rulebook", async () => {
		const marker = Bun.nanoseconds().toString(36);
		const ruleName = `described-conditioned-${marker}`;
		const trigger = `DESCRIBED_COND_${marker}`;
		const seed = async (cwd: string): Promise<void> => {
			await fs.mkdir(path.join(cwd, ".omp", "rules"), { recursive: true });
			await fs.writeFile(
				path.join(cwd, ".omp", "rules", `${ruleName}.md`),
				`---\nname: ${ruleName}\ndescription: blocks\ncondition: "${trigger}"\nscope: "text"\n---\nbody\n`,
			);
		};

		// TTSR starts ENABLED, so the rule registers with the manager.
		const h = await makeHarness({}, {}, seed);
		try {
			expect(h.session.ttsrManager?.hasRule(ruleName)).toBe(true);

			// Disable TTSR on disk, then refresh EVERYTHING (settings + roster).
			await fs.writeFile(h.settingsPath, "ttsr:\n  enabled: false\n");
			const result = await h.session.refresh("all");
			expect(h.session.settings.get("ttsr.enabled")).toBe(false);

			const names = getActiveRules().map(rule => rule.name);
			// Pre-fix: the manager's retained registration was republished on top
			// of the fresh rulebook entry, so the rule appeared twice — inflating
			// the reported count too.
			expect(names.filter(name => name === ruleName)).toHaveLength(1);
			expect(result.rules).toBe(names.length);
		} finally {
			await h.dispose();
		}
	});

	// A CONDITION-ONLY rule (no description, not alwaysApply) has no bucket to
	// fall through to, so a fresh disabled session drops it entirely. The
	// retained registration must not keep it addressable.
	it("drops a condition-only rule, matching a fresh disabled session's rule set", async () => {
		const marker = Bun.nanoseconds().toString(36);
		const conditionOnly = `condition-only-${marker}`;
		const described = `described-${marker}`;
		const trigger = `COND_ONLY_${marker}`;
		const seed = async (cwd: string): Promise<void> => {
			await fs.mkdir(path.join(cwd, ".omp", "rules"), { recursive: true });
			// No `description`, no `alwaysApply`: TTSR is this rule's only bucket.
			await fs.writeFile(
				path.join(cwd, ".omp", "rules", `${conditionOnly}.md`),
				`---\nname: ${conditionOnly}\ncondition: "${trigger}"\nscope: "text"\n---\nbody\n`,
			);
			// A described conditioned sibling, so the comparison covers both the
			// dropped and the falls-through shape in one rule set.
			await fs.writeFile(
				path.join(cwd, ".omp", "rules", `${described}.md`),
				`---\nname: ${described}\ndescription: blocks\ncondition: "${trigger}"\nscope: "text"\n---\nbody\n`,
			);
		};

		// Route A: started ENABLED, then disabled on disk and refreshed.
		const enabledThenDisabled = await makeHarness({}, {}, seed);
		let refreshedNames: string[];
		let refreshedCount: number | undefined;
		try {
			expect(enabledThenDisabled.session.ttsrManager?.hasRule(conditionOnly)).toBe(true);
			await fs.writeFile(enabledThenDisabled.settingsPath, "ttsr:\n  enabled: false\n");
			const result = await enabledThenDisabled.session.refresh("all");
			expect(enabledThenDisabled.session.settings.get("ttsr.enabled")).toBe(false);
			refreshedNames = getActiveRules()
				.map(rule => rule.name)
				.sort();
			refreshedCount = result.rules;
		} finally {
			await enabledThenDisabled.dispose();
		}

		// Route B: a FRESH session that was disabled from construction. Same cwd
		// contents, so the only difference is how the session reached "disabled".
		const freshDisabled = await makeHarness({ "ttsr.enabled": false }, {}, seed);
		try {
			const freshNames = getActiveRules()
				.map(rule => rule.name)
				.sort();
			// A fresh disabled session never registered the rules, so the
			// condition-only one has no bucket and is simply absent.
			expect(freshNames).not.toContain(conditionOnly);
			expect(freshNames).toContain(described);
			// The equivalence: identical rule sets, and an identical count.
			expect(refreshedNames).toEqual(freshNames);
			expect(refreshedCount).toBe(freshNames.length);
		} finally {
			await freshDisabled.dispose();
		}
	});

	// The same equivalence on the SESSION-LOCAL snapshot. `rule://` resolution
	// PREFERS `context.rules` — the array every tool threads as
	// `session.activeRules` — over the process global, so narrowing only the
	// global left a retained registration addressable through `read`: a
	// condition-only rule stayed resolvable and a described one was listed
	// twice, while the reported count came from the filtered global set.
	it("drops a condition-only rule from the SESSION-LOCAL snapshot too", async () => {
		const marker = Bun.nanoseconds().toString(36);
		const conditionOnly = `local-condition-only-${marker}`;
		const described = `local-described-${marker}`;
		const trigger = `LOCAL_COND_ONLY_${marker}`;
		const seed = async (cwd: string): Promise<void> => {
			await fs.mkdir(path.join(cwd, ".omp", "rules"), { recursive: true });
			// TTSR is this rule's only bucket: no description, not alwaysApply.
			await fs.writeFile(
				path.join(cwd, ".omp", "rules", `${conditionOnly}.md`),
				`---\nname: ${conditionOnly}\ncondition: "${trigger}"\nscope: "text"\n---\nbody\n`,
			);
			await fs.writeFile(
				path.join(cwd, ".omp", "rules", `${described}.md`),
				`---\nname: ${described}\ndescription: blocks\ncondition: "${trigger}"\nscope: "text"\n---\nbody\n`,
			);
		};

		// Route A: started ENABLED (so both rules registered), then disabled on
		// disk and refreshed.
		const enabledThenDisabled = await makeHarness({}, {}, seed);
		let refreshedLocalNames: string[];
		let conditionOnlyReadError: string | undefined;
		try {
			expect(enabledThenDisabled.session.ttsrManager?.hasRule(conditionOnly)).toBe(true);
			await fs.writeFile(enabledThenDisabled.settingsPath, "ttsr:\n  enabled: false\n");
			await enabledThenDisabled.session.refresh("all");
			expect(enabledThenDisabled.session.settings.get("ttsr.enabled")).toBe(false);
			// The premise the finding rests on: the manager really does still hold
			// the registration, because `retainRules` no-ops while disabled.
			expect(enabledThenDisabled.session.ttsrManager?.getRules().map(rule => rule.name)).toContain(conditionOnly);
			refreshedLocalNames = sessionRuleNames(enabledThenDisabled.session);
			// `read` resolves through the session-local array, so the bucket-less
			// rule must be unaddressable there.
			conditionOnlyReadError = await readRuleUrl(enabledThenDisabled.session, conditionOnly).then(
				() => undefined,
				(error: unknown) => String(error),
			);
			// The described rule falls through to the rulebook, so it stays
			// addressable — but exactly once.
			expect(refreshedLocalNames.filter(name => name === described)).toHaveLength(1);
		} finally {
			await enabledThenDisabled.dispose();
		}

		// Route B: a FRESH disabled session over the same disk contents.
		const freshDisabled = await makeHarness({ "ttsr.enabled": false }, {}, seed);
		try {
			const freshLocalNames = sessionRuleNames(freshDisabled.session);
			expect(freshLocalNames).not.toContain(conditionOnly);
			expect(freshLocalNames).toContain(described);
			expect(refreshedLocalNames).toEqual(freshLocalNames);
			expect(conditionOnlyReadError).toContain(`Unknown rule: ${conditionOnly}`);
		} finally {
			await freshDisabled.dispose();
		}
	});

	// Opposite-direction guard for the SESSION-LOCAL path: a rule the manager
	// legitimately consumed lives nowhere else, so narrowing must not make it
	// unreachable through the array `read` threads.
	it("still publishes a consumed condition-only rule into the session-local snapshot", async () => {
		const marker = Bun.nanoseconds().toString(36);
		const ruleName = `local-enabled-cond-${marker}`;
		const trigger = `LOCAL_ENABLED_COND_${marker}`;
		const body = `LOCAL_ENABLED_BODY_${marker}`;
		const h = await makeHarness({}, {}, async cwd => {
			await fs.mkdir(path.join(cwd, ".omp", "rules"), { recursive: true });
			await fs.writeFile(
				path.join(cwd, ".omp", "rules", `${ruleName}.md`),
				`---\nname: ${ruleName}\ncondition: "${trigger}"\nscope: "text"\n---\n${body}\n`,
			);
		});
		try {
			await h.session.refresh("all");
			expect(h.session.settings.get("ttsr.enabled")).not.toBe(false);
			expect(h.session.ttsrManager?.hasRule(ruleName)).toBe(true);

			expect(sessionRuleNames(h.session)).toContain(ruleName);
			expect(await readRuleUrl(h.session, ruleName)).toContain(body);
		} finally {
			await h.dispose();
		}
	});

	// The opposite-direction guard: narrowing publication must not stop
	// publishing a rule the manager legitimately CONSUMED. With TTSR enabled, a
	// condition-only rule lives nowhere but the manager, so if it is not
	// republished it becomes unreachable through `rule://` entirely.
	it("still publishes a consumed condition-only rule while TTSR is enabled", async () => {
		const marker = Bun.nanoseconds().toString(36);
		const ruleName = `enabled-condition-only-${marker}`;
		const trigger = `ENABLED_COND_ONLY_${marker}`;
		const h = await makeHarness({}, {}, async cwd => {
			await fs.mkdir(path.join(cwd, ".omp", "rules"), { recursive: true });
			await fs.writeFile(
				path.join(cwd, ".omp", "rules", `${ruleName}.md`),
				`---\nname: ${ruleName}\ncondition: "${trigger}"\nscope: "text"\n---\nbody\n`,
			);
		});
		try {
			await h.session.refresh("all");
			expect(h.session.settings.get("ttsr.enabled")).not.toBe(false);
			expect(h.session.ttsrManager?.hasRule(ruleName)).toBe(true);

			// The manager holds it, so the active set must carry it and `rule://`
			// must resolve it — the bucket-less rule has no other publisher.
			expect(getActiveRules().map(rule => rule.name)).toContain(ruleName);
			await expect(
				new RuleProtocolHandler().resolve({ rawHost: ruleName, hostname: ruleName } as never),
			).resolves.toBeDefined();
		} finally {
			await h.dispose();
		}
	});

	// The same equivalence reached through a SETTINGS-ONLY refresh, which is a
	// different code path: `refresh('all')` re-buckets from disk in the roster
	// block, while `refresh('settings')` runs the no-rediscovery reconcile.
	//
	// That reconcile filtered its republication by "still allowed by the current
	// gating" rather than "actually consumed by the manager". While TTSR is
	// disabled those differ for every conditioned rule: the manager declines it,
	// so it is allowed but NOT consumed — it reaches the active set through its
	// own bucket AND again through the retained registration.
	it("does not duplicate a described conditioned rule after a settings-only disable", async () => {
		const marker = Bun.nanoseconds().toString(36);
		const ruleName = `settings-only-described-${marker}`;
		const trigger = `SETTINGS_ONLY_DESC_${marker}`;
		const h = await makeHarness({}, {}, async cwd => {
			await fs.mkdir(path.join(cwd, ".omp", "rules"), { recursive: true });
			await fs.writeFile(
				path.join(cwd, ".omp", "rules", `${ruleName}.md`),
				`---\nname: ${ruleName}\ndescription: blocks\ncondition: "${trigger}"\nscope: "text"\n---\nbody\n`,
			);
		});
		try {
			expect(h.session.ttsrManager?.hasRule(ruleName)).toBe(true);

			// `ttsr.enabled: false` WITHOUT adding the rule to `disabledRules`, so
			// the gating verdict still allows it and only the manager declines it.
			await fs.writeFile(h.settingsPath, "ttsr:\n  enabled: false\n");
			await h.session.refresh("settings");
			expect(h.session.settings.get("ttsr.enabled")).toBe(false);
			// Premise guard: `retainRules` no-ops while disabled, so the stale
			// registration really is still there to be republished.
			expect(h.session.ttsrManager?.getRules().map(rule => rule.name)).toContain(ruleName);

			const names = getActiveRules().map(rule => rule.name);
			expect(names.filter(name => name === ruleName)).toHaveLength(1);
			// And on the session-local snapshot `rule://` actually prefers.
			expect(sessionRuleNames(h.session).filter(name => name === ruleName)).toHaveLength(1);
		} finally {
			await h.dispose();
		}
	});

	it("drops a condition-only rule after a settings-only disable", async () => {
		const marker = Bun.nanoseconds().toString(36);
		const conditionOnly = `settings-only-cond-${marker}`;
		const trigger = `SETTINGS_ONLY_COND_${marker}`;
		const seed = async (cwd: string): Promise<void> => {
			await fs.mkdir(path.join(cwd, ".omp", "rules"), { recursive: true });
			// No description, not alwaysApply: TTSR is this rule's only bucket, so
			// a fresh disabled session drops it outright.
			await fs.writeFile(
				path.join(cwd, ".omp", "rules", `${conditionOnly}.md`),
				`---\nname: ${conditionOnly}\ncondition: "${trigger}"\nscope: "text"\n---\nbody\n`,
			);
		};

		const h = await makeHarness({}, {}, seed);
		try {
			expect(h.session.ttsrManager?.hasRule(conditionOnly)).toBe(true);

			await fs.writeFile(h.settingsPath, "ttsr:\n  enabled: false\n");
			await h.session.refresh("settings");
			expect(h.session.settings.get("ttsr.enabled")).toBe(false);
			expect(h.session.ttsrManager?.getRules().map(rule => rule.name)).toContain(conditionOnly);

			// Pre-fix: the rule was still allowed by the gating, so the retained
			// registration was republished and stayed addressable — unlike a
			// freshly disabled session, which never registered it at all.
			expect(getActiveRules().map(rule => rule.name)).not.toContain(conditionOnly);
			expect(sessionRuleNames(h.session)).not.toContain(conditionOnly);
			await expect(
				new RuleProtocolHandler().resolve({ rawHost: conditionOnly, hostname: conditionOnly } as never),
			).rejects.toThrow(`Unknown rule: ${conditionOnly}`);
		} finally {
			await h.dispose();
		}
	});

	// Opposite direction for the settings-only path: narrowing must not stop
	// publishing a rule the manager legitimately consumed, or a condition-only
	// rule becomes unreachable on every settings refresh while TTSR is ON.
	it("still publishes a consumed condition-only rule across a settings-only refresh", async () => {
		const marker = Bun.nanoseconds().toString(36);
		const ruleName = `settings-only-enabled-cond-${marker}`;
		const trigger = `SETTINGS_ONLY_ENABLED_${marker}`;
		const h = await makeHarness({}, {}, async cwd => {
			await fs.mkdir(path.join(cwd, ".omp", "rules"), { recursive: true });
			await fs.writeFile(
				path.join(cwd, ".omp", "rules", `${ruleName}.md`),
				`---\nname: ${ruleName}\ncondition: "${trigger}"\nscope: "text"\n---\nbody\n`,
			);
		});
		try {
			// An UNRELATED settings edit, with TTSR left enabled.
			await fs.writeFile(h.settingsPath, "includeModelInPrompt: false\n");
			await h.session.refresh("settings");
			expect(h.session.settings.get("ttsr.enabled")).not.toBe(false);
			expect(h.session.ttsrManager?.hasRule(ruleName)).toBe(true);

			expect(getActiveRules().map(rule => rule.name)).toContain(ruleName);
			expect(sessionRuleNames(h.session)).toContain(ruleName);
		} finally {
			await h.dispose();
		}
	});
});

describe("AgentSession refresh: agent scoping and the session rule snapshot", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("keeps a foreign agent's scoped rule out of the roster after refresh('rules')", async () => {
		const marker = Bun.nanoseconds().toString(36);
		const scopedName = `scout-only-${marker}`;
		const scopedBody = `SCOUT_SCOPED_BODY_${marker}`;
		// A `main` session (no explicit agentName), so a rule scoped to `scout`
		// must never reach its roster.
		const h = await makeHarness();
		try {
			await fs.mkdir(path.join(h.cwd, ".omp", "rules"), { recursive: true });
			await fs.writeFile(
				path.join(h.cwd, ".omp", "rules", `${scopedName}.md`),
				`---\nname: ${scopedName}\nalwaysApply: true\nagents:\n  - scout\n---\n${scopedBody}\n`,
			);

			await h.session.refresh("rules");

			// Pre-fix (the reload called bucketRules with no agentName, which
			// disables `agents` scoping and admits every scoped rule), the
			// scout-only rule activated here and rendered into the main prompt.
			expect(getActiveRules().map(r => r.name)).not.toContain(scopedName);
			expect(h.session.systemPrompt.join("\n")).not.toContain(scopedBody);
		} finally {
			await h.dispose();
		}
	});

	it("does not let a subagent's refresh('settings') replace the process-global rule snapshot", async () => {
		// A `refresh("settings")` in a CHILD session reconciles its own scoped
		// rule set. Publishing that globally left contextless consumers in the
		// parent process (a `RuleProtocolHandler` with no session-local array)
		// serving the child's rules — the same hazard the roster reload already
		// guards with `publishGlobals: this.#agentKind === "main"`.
		//
		// The reconcile is reached only through the TTSR gating path (it returns
		// early without a manager), so the seed carries a CONDITIONED rule and
		// the refresh edits `ttsr.disabledRules`. Without that the publication
		// line never runs and the test would pass either way.
		const marker = Bun.nanoseconds().toString(36);
		const mainName = `main-global-${marker}`;
		const ttsrName = `gated-${marker}`;
		const seed = async (cwd: string): Promise<void> => {
			await fs.mkdir(path.join(cwd, ".omp", "rules"), { recursive: true });
			await fs.writeFile(
				path.join(cwd, ".omp", "rules", `${mainName}.md`),
				`---\nname: ${mainName}\nalwaysApply: true\nagents:\n  - main\n---\nMAIN_GLOBAL_BODY_${marker}\n`,
			);
			await fs.writeFile(
				path.join(cwd, ".omp", "rules", `${ttsrName}.md`),
				`---\nname: ${ttsrName}\ndescription: blocks\ncondition: "zzz-${marker}"\nscope: "text"\n---\nbody\n`,
			);
		};
		const main = await makeHarness({}, {}, seed);
		try {
			await main.session.refresh("rules");
			expect(getActiveRules().map(r => r.name)).toContain(mainName);

			// A child in the same process, over the same on-disk rules. Its own
			// bucketing is scoped to `sub`, so the `main`-scoped rule is absent
			// from the set it would publish.
			const child = await makeHarness({}, { parentTaskPrefix: `Child-${marker}` }, seed);
			try {
				expect(child.session.ttsrManager).toBeDefined();
				// A real gating change, so the child's reconcile actually runs.
				await fs.writeFile(child.settingsPath, `ttsr:\n  disabledRules:\n    - ${ttsrName}\n`);
				await child.session.refresh("settings");
				expect(child.session.ttsrManager?.hasRule(ttsrName)).toBe(false);

				// The parent's global snapshot is untouched.
				expect(getActiveRules().map(r => r.name)).toContain(mainName);
			} finally {
				await child.dispose();
			}
		} finally {
			await main.dispose();
		}
	});

	it("still reconciles a subagent's own rule gating", async () => {
		// The guard must narrow only the GLOBAL publication: gating TTSR off in
		// a child still has to take effect in that child.
		const marker = Bun.nanoseconds().toString(36);
		const ttsrName = `sub-gated-${marker}`;
		const child = await makeHarness({}, { parentTaskPrefix: `Child-${marker}` }, async cwd => {
			await fs.mkdir(path.join(cwd, ".omp", "rules"), { recursive: true });
			await fs.writeFile(
				path.join(cwd, ".omp", "rules", `${ttsrName}.md`),
				`---\nname: ${ttsrName}\ndescription: blocks\ncondition: "zzz-${marker}"\nscope: "text"\n---\nbody\n`,
			);
		});
		try {
			expect(child.session.ttsrManager?.hasRule(ttsrName)).toBe(true);

			await fs.writeFile(child.settingsPath, `ttsr:\n  disabledRules:\n    - ${ttsrName}\n`);
			await child.session.refresh("settings");

			expect(child.session.ttsrManager?.hasRule(ttsrName)).toBe(false);
		} finally {
			await child.dispose();
		}
	});

	it("still admits a main-scoped rule on refresh (scoping narrows, never blanket-drops)", async () => {
		const marker = Bun.nanoseconds().toString(36);
		const mainName = `main-only-${marker}`;
		const mainBody = `MAIN_SCOPED_BODY_${marker}`;
		const h = await makeHarness();
		try {
			await fs.mkdir(path.join(h.cwd, ".omp", "rules"), { recursive: true });
			await fs.writeFile(
				path.join(h.cwd, ".omp", "rules", `${mainName}.md`),
				`---\nname: ${mainName}\nalwaysApply: true\nagents:\n  - main\n---\n${mainBody}\n`,
			);

			await h.session.refresh("rules");

			// The scoping fix must pass THIS session's name through, not drop every
			// scoped rule: a `main`-scoped rule stays active in a main session.
			expect(getActiveRules().map(r => r.name)).toContain(mainName);
			expect(h.session.systemPrompt.join("\n")).toContain(mainBody);
		} finally {
			await h.dispose();
		}
	});

	it("refreshes the session's own rule snapshot so rule:// serves fresh content", async () => {
		const marker = Bun.nanoseconds().toString(36);
		const ruleName = `snapshot-rule-${marker}`;
		const edited = `EDITED_RULE_BODY_${marker}`;
		const h = await makeHarness();
		try {
			await fs.mkdir(path.join(h.cwd, ".omp", "rules"), { recursive: true });
			const rulePath = path.join(h.cwd, ".omp", "rules", `${ruleName}.md`);
			await fs.writeFile(rulePath, `---\nname: ${ruleName}\ndescription: snapshot fixture\n---\noriginal body\n`);
			await h.session.refresh("rules");

			await fs.writeFile(rulePath, `---\nname: ${ruleName}\ndescription: snapshot fixture\n---\n${edited}\n`);
			await h.session.refresh("rules");

			// `read` threads `session.activeRules` as the resolution context, and
			// RuleProtocolHandler PREFERS that over the process global. Pre-fix the
			// SDK closure updated only its prompt locals, so this snapshot stayed
			// frozen at launch and rule:// served the original body.
			const readTool = h.session.agent.state.tools.find(t => t.name === "read");
			expect(readTool).toBeDefined();
			const result = await readTool!.execute(
				"call-rule-read",
				{ path: `rule://${ruleName}` },
				undefined,
				undefined as never,
				undefined as never,
			);
			expect(JSON.stringify(result.content)).toContain(edited);
		} finally {
			await h.dispose();
		}
	});
});

// `skills.enableSkillCommands` gates the whole `/skill:*` surface, and every
// consumer reads the CACHED `SessionTools` snapshot rather than the live
// settings instance: ACP command discovery (available-commands.ts), ACP
// execution (acp-agent.ts), and RPC skill invocation (rpc-mode.ts). Editing the
// flag on disk must therefore both install the fresh snapshot AND notify
// command-metadata subscribers, on a settings-only refresh as well as an `all`
// one — otherwise those surfaces keep honoring the old flag until an unrelated
// metadata update.
describe("AgentSession refresh: skills.enableSkillCommands reaches the command surface", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	/** Seeds one on-disk skill so the roster is non-empty and stable across reloads. */
	async function seedSkill(cwd: string, name: string): Promise<void> {
		await fs.mkdir(path.join(cwd, ".omp", "skills", name), { recursive: true });
		await fs.writeFile(
			path.join(cwd, ".omp", "skills", name, "SKILL.md"),
			`---\nname: ${name}\ndescription: a skill\n---\nbody\n`,
		);
	}

	it("syncs the cached snapshot and notifies subscribers on a settings-ONLY refresh", async () => {
		const skillName = `refresh-skill-${Bun.nanoseconds().toString(36)}`;
		// Start with commands ENABLED on disk so the flag has somewhere to move.
		const h = await makeHarness({}, {}, async cwd => {
			await seedSkill(cwd, skillName);
			await fs.writeFile(path.join(cwd, "config.yml"), "skills:\n  enableSkillCommands: true\n");
		});
		try {
			expect(h.session.skillsSettings?.enableSkillCommands).toBe(true);
			let notifications = 0;
			const unsubscribe = h.session.subscribeCommandMetadataChanged(() => {
				notifications += 1;
			});
			try {
				// Flip the flag off on disk and refresh ONLY settings — the roster
				// block that would otherwise install the snapshot never runs.
				await fs.writeFile(h.settingsPath, "skills:\n  enableSkillCommands: false\n");
				const result = await h.session.refresh("settings");

				expect(result.settingsChanged).toBe(true);
				// Pre-fix: `/refresh settings` reloaded the live Settings but never
				// touched `SessionTools.#skillsSettings`, so ACP/RPC kept accepting
				// `/skill:*` under the stale `true`.
				expect(h.session.skillsSettings?.enableSkillCommands).toBe(false);
				// ...and no subscriber was ever told, so advertised commands stayed stale.
				expect(notifications).toBe(1);
			} finally {
				unsubscribe();
			}
		} finally {
			await h.dispose();
		}
	});

	it("notifies subscribers on refresh('all') when only the flag moved and the roster is unchanged", async () => {
		const skillName = `refresh-skill-${Bun.nanoseconds().toString(36)}`;
		const h = await makeHarness({}, {}, async cwd => {
			await seedSkill(cwd, skillName);
			await fs.writeFile(path.join(cwd, "config.yml"), "skills:\n  enableSkillCommands: true\n");
		});
		try {
			expect(h.session.skillsSettings?.enableSkillCommands).toBe(true);
			let notifications = 0;
			const unsubscribe = h.session.subscribeCommandMetadataChanged(() => {
				notifications += 1;
			});
			try {
				// Only the flag moves; the on-disk skill roster is byte-identical, so
				// `skillsChanged` is false and the flag delta is the ONLY thing that
				// can drive the notification.
				await fs.writeFile(h.settingsPath, "skills:\n  enableSkillCommands: false\n");
				await h.session.refresh("all");

				expect(h.session.skillsSettings?.enableSkillCommands).toBe(false);
				// Pre-fix: the comparison read `#tools.skillsSettings` BEFORE
				// `applyReloadedSkills` installed the fresh group, so it compared the
				// old value with itself, was always false, and — with an unchanged
				// roster — left subscribers unnotified.
				expect(notifications).toBe(1);
			} finally {
				unsubscribe();
			}
		} finally {
			await h.dispose();
		}
	});

	it("stays a no-op when the flag did not move", async () => {
		const skillName = `refresh-skill-${Bun.nanoseconds().toString(36)}`;
		const h = await makeHarness({}, {}, async cwd => {
			await seedSkill(cwd, skillName);
			await fs.writeFile(path.join(cwd, "config.yml"), "skills:\n  enableSkillCommands: true\n");
		});
		try {
			let notifications = 0;
			const unsubscribe = h.session.subscribeCommandMetadataChanged(() => {
				notifications += 1;
			});
			try {
				// An UNRELATED settings edit: the reload reports `changed`, but the
				// skill-command flag is untouched, so nobody should be woken and
				// prompt caching keeps hitting.
				await fs.writeFile(h.settingsPath, "defaultThinkingLevel: low\nskills:\n  enableSkillCommands: true\n");
				const result = await h.session.refresh("settings");

				expect(result.settingsChanged).toBe(true);
				expect(h.session.skillsSettings?.enableSkillCommands).toBe(true);
				expect(notifications).toBe(0);
			} finally {
				unsubscribe();
			}
		} finally {
			await h.dispose();
		}
	});
});

// A parent that refreshes rules and then spawns must hand the CHILD the fresh
// roster. `buildExecutorOptions` forwards `rules: session.rules` as the child's
// `options.rules`, and a defined `options.rules` is the child's authoritative
// rule policy (sdk.ts buckets exactly that list instead of scanning disk) — so a
// stale launch-time array silently drops a just-added rule from the child's
// prompt and `rule://` snapshot. The forwarded value must be the UNGATED source
// roster, never this session's gated active list, or the parent's TTSR gating
// would become unrecoverable inside the child.
describe("AgentSession refresh: the spawn-facing rule snapshot", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	/** Spawn a child through the real primitive and capture its executor options. */
	async function spawnAndCaptureRules(session: AgentSession): Promise<readonly string[]> {
		const captured: executorModule.ExecutorOptions[] = [];
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			captured.push(options);
			return {
				index: 0,
				id: "Scout",
				agent: "scout",
				agentSource: "bundled",
				task: "Inspect.",
				exitCode: 0,
				output: "{}",
				stderr: "",
				truncated: false,
				durationMs: 1,
				tokens: 0,
				requests: 1,
			};
		});
		await runStructuredSubagent({
			session: toolSessionOf(session),
			invocationKind: "task",
			assignment: "Inspect the target.",
			agent: "scout",
		});
		const forwarded = captured[0]?.rules;
		if (!forwarded) throw new Error("Expected the child to receive a rule policy");
		return forwarded.map(rule => rule.name);
	}

	it("forwards a rule added before the spawn to the child", async () => {
		const marker = Bun.nanoseconds().toString(36);
		const addedName = `spawn-visible-${marker}`;
		const h = await makeHarness();
		try {
			const before = await spawnAndCaptureRules(h.session);
			expect(before).not.toContain(addedName);

			await fs.mkdir(path.join(h.cwd, ".omp", "rules"), { recursive: true });
			await fs.writeFile(
				path.join(h.cwd, ".omp", "rules", `${addedName}.md`),
				`---\nname: ${addedName}\nalwaysApply: true\n---\nspawn body\n`,
			);
			await h.session.refresh("rules");

			// Pre-fix: the refresh callback updated only `activeRules`, leaving the
			// spawn-facing `rules` at the launch-time discovery output — so the child
			// was launched under a rule policy that predates the refresh.
			expect(await spawnAndCaptureRules(h.session)).toContain(addedName);
		} finally {
			await h.dispose();
		}
	});

	it("forwards the UNGATED roster, so the parent's gating stays reversible in the child", async () => {
		const marker = Bun.nanoseconds().toString(36);
		const gatedName = `spawn-gated-${marker}`;
		const h = await makeHarness({}, {}, async cwd => {
			await fs.mkdir(path.join(cwd, ".omp", "rules"), { recursive: true });
			await fs.writeFile(
				path.join(cwd, ".omp", "rules", `${gatedName}.md`),
				`---\nname: ${gatedName}\nalwaysApply: true\n---\ngated body\n`,
			);
		});
		try {
			await fs.writeFile(h.settingsPath, `ttsr:\n  disabledRules:\n    - ${gatedName}\n`);
			await h.session.refresh("settings");
			// The gate took effect on THIS session: the rule is out of the active set.
			expect(getActiveRules().map(rule => rule.name)).not.toContain(gatedName);

			// But the child's rule POLICY must still carry it. Forwarding the gated
			// active list instead would bake the parent's `disabledRules` into the
			// child as an unrecoverable policy: a child that reverts the setting
			// could never restore a rule its policy never listed.
			expect(await spawnAndCaptureRules(h.session)).toContain(gatedName);
		} finally {
			await h.dispose();
		}
	});
});
