import { describe, expect, test } from "bun:test";
import type { Skill } from "../../src/extensibility/skills";
import { resolveAgentExecutionProfile } from "../../src/orchestration/agent-execution-profile";
import {
	defaultAgentTypeHarnessPolicy,
	filterSkillsForHarness,
	resolveAgentHarness,
} from "../../src/orchestration/agent-harness";
import { isToolCapabilityAllowed } from "../../src/tools/tool-profiles";

function skill(name: string): Skill {
	return {
		name,
		description: `${name} skill`,
		filePath: `/tmp/${name}/SKILL.md`,
		baseDir: `/tmp/${name}`,
		source: "test",
	};
}

describe("defaultAgentTypeHarnessPolicy", () => {
	test("seeds explore as light/simple and quick_task as mid/bound mechanical", () => {
		expect(defaultAgentTypeHarnessPolicy("explore")).toEqual({
			tier: "light",
			autonomy: "bound",
			collaboration: "report-only",
			workClass: "mechanical",
			editMode: "none",
		});
		expect(defaultAgentTypeHarnessPolicy("quick_task")).toEqual({
			tier: "mid",
			autonomy: "bound",
			collaboration: "report-only",
			workClass: "mechanical",
			editMode: "replace",
		});
	});

	test("leaves general-purpose agents unrestricted", () => {
		expect(defaultAgentTypeHarnessPolicy("task")).toBeUndefined();
		expect(defaultAgentTypeHarnessPolicy("oracle")).toBeUndefined();
		expect(defaultAgentTypeHarnessPolicy(undefined)).toBeUndefined();
	});

	test("explore seed resolves to simple harness; quick_task seed to standard with replace edits", () => {
		const explore = resolveAgentHarness({
			profileInput: { agentTypePolicy: defaultAgentTypeHarnessPolicy("explore") },
			agentTools: ["read", "search", "find", "web_search"],
		});
		expect(explore.kind).toBe("simple");
		expect(explore.profile.tier).toBe("light");
		expect(isToolCapabilityAllowed(explore.toolProfile, { source: "builtin", name: "web_search" })).toBe(true);
		expect(isToolCapabilityAllowed(explore.toolProfile, { source: "builtin", name: "bash" })).toBe(false);
		expect(explore.skillPolicy.mode).toBe("none");

		const quick = resolveAgentHarness({
			profileInput: { agentTypePolicy: defaultAgentTypeHarnessPolicy("quick_task") },
		});
		expect(quick.kind).toBe("standard");
		expect(quick.profile.tier).toBe("mid");
		expect(quick.toolProfile.editMode).toBe("replace");
		expect(isToolCapabilityAllowed(quick.toolProfile, { source: "builtin", name: "edit" })).toBe(true);
		expect(isToolCapabilityAllowed(quick.toolProfile, { source: "builtin", name: "task" })).toBe(true);
		expect(quick.decisionSurface.allowSkillBrowse).toBe(false);
		expect(quick.collaborationPolicy.mode).toBe("report-only");
	});
});

describe("resolveAgentHarness", () => {
	test("light tier selects the simple harness with bounded tools and no skill browse", () => {
		const harness = resolveAgentHarness({
			execution: resolveAgentExecutionProfile({
				override: {
					tier: "light",
					autonomy: "bound",
					collaboration: "report-only",
					workClass: "mechanical",
					editMode: "none",
				},
			}),
		});

		expect(harness.kind).toBe("simple");
		expect(harness.skillPolicy.mode).toBe("none");
		expect(harness.decisionSurface.allowAsk).toBe(false);
		expect(harness.decisionSurface.allowTaskSpawn).toBe(false);
		expect(harness.decisionSurface.allowToolDiscovery).toBe(false);
		expect(harness.decisionSurface.allowSkillBrowse).toBe(false);
		expect(harness.collaborationPolicy.mode).toBe("report-only");
		expect(isToolCapabilityAllowed(harness.toolProfile, { source: "builtin", name: "read" })).toBe(true);
		expect(isToolCapabilityAllowed(harness.toolProfile, { source: "builtin", name: "bash" })).toBe(false);
		expect(isToolCapabilityAllowed(harness.toolProfile, { source: "builtin", name: "task" })).toBe(false);
		expect(isToolCapabilityAllowed(harness.toolProfile, { source: "builtin", name: "ask" })).toBe(false);
	});

	test("simple harness allowlists only declared autoload skills up to the cap", () => {
		const harness = resolveAgentHarness({
			execution: resolveAgentExecutionProfile({ override: { tier: "light", autonomy: "bound" } }),
			autoloadSkills: ["alpha", "beta", "gamma"],
		});

		expect(harness.kind).toBe("simple");
		expect(harness.skillPolicy.mode).toBe("allowlist");
		expect(harness.skillPolicy.allowNames).toEqual(["alpha", "beta", "gamma"]);
		expect(harness.skillPolicy.maxSkills).toBe(2);
	});

	test("mid tier selects standard harness; frontier stays full", () => {
		const mid = resolveAgentHarness({
			execution: resolveAgentExecutionProfile({
				override: { tier: "mid", autonomy: "supervised", workClass: "judgment" },
			}),
		});
		expect(mid.kind).toBe("standard");
		expect(mid.skillPolicy.mode).toBe("none");
		expect(mid.decisionSurface.allowSkillBrowse).toBe(false);

		const full = resolveAgentHarness({
			execution: resolveAgentExecutionProfile({
				override: { tier: "frontier", autonomy: "independent" },
			}),
		});
		expect(full.kind).toBe("full");
		expect(full.skillPolicy.mode).toBe("all");
		expect(full.decisionSurface.allowSkillBrowse).toBe(true);
	});

	test("frontier mechanical bound narrows to standard, not full", () => {
		const harness = resolveAgentHarness({
			execution: resolveAgentExecutionProfile({
				override: {
					tier: "frontier",
					autonomy: "bound",
					workClass: "mechanical",
					collaboration: "report-only",
				},
			}),
		});
		expect(harness.kind).toBe("standard");
		expect(harness.decisionSurface.allowSkillBrowse).toBe(false);
	});

	test("agent tool lists intersect the tier ceiling and never widen it", () => {
		const harness = resolveAgentHarness({
			execution: resolveAgentExecutionProfile({ override: { tier: "light", autonomy: "bound" } }),
			agentTools: ["read", "bash", "task", "ask"],
		});

		expect(isToolCapabilityAllowed(harness.toolProfile, { source: "builtin", name: "read" })).toBe(true);
		expect(isToolCapabilityAllowed(harness.toolProfile, { source: "builtin", name: "bash" })).toBe(false);
		expect(isToolCapabilityAllowed(harness.toolProfile, { source: "builtin", name: "task" })).toBe(false);
	});
});

describe("filterSkillsForHarness", () => {
	const catalog = [skill("alpha"), skill("beta"), skill("gamma"), skill("delta")];

	test("simple none mode drops the entire catalog", () => {
		const harness = resolveAgentHarness({
			execution: resolveAgentExecutionProfile({ override: { tier: "light" } }),
		});
		expect(filterSkillsForHarness(harness, catalog)).toEqual([]);
	});

	test("simple allowlist prefers autoload names and respects maxSkills", () => {
		const harness = resolveAgentHarness({
			execution: resolveAgentExecutionProfile({ override: { tier: "light" } }),
			autoloadSkills: ["gamma", "alpha", "beta"],
		});
		const filtered = filterSkillsForHarness(harness, catalog, ["gamma", "alpha", "beta"]);
		expect(filtered.map(s => s.name)).toEqual(["gamma", "alpha"]);
	});

	test("full mode passes the catalog through", () => {
		const harness = resolveAgentHarness({
			execution: resolveAgentExecutionProfile({ override: { tier: "frontier", autonomy: "independent" } }),
		});
		expect(filterSkillsForHarness(harness, catalog).map(s => s.name)).toEqual(["alpha", "beta", "gamma", "delta"]);
	});
});
