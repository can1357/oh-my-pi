import { describe, expect, it } from "bun:test";
import { deriveChildToolNames } from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import type { DiscoveredAgent } from "@oh-my-pi/pi-coding-agent/session/tool-policy";
import { SessionToolPolicy } from "@oh-my-pi/pi-coding-agent/session/tool-policy";

// The default-active registry surface plus a default-INACTIVE extension tool
// the CLI whitelist deliberately omits (checkpoint/rewind are default-active
// registry tools and are included in the every-default-active grant).
const REGISTRY = new Set([
	"read",
	"grep",
	"glob",
	"write",
	"edit",
	"bash",
	"checkpoint",
	"rewind",
	"task",
	"hub",
	"ext_tool",
]);
const DEFAULT_ACTIVE = (name: string): boolean => name !== "ext_tool";
const EVERY_DEFAULT_ACTIVE = [...REGISTRY].filter(name => DEFAULT_ACTIVE(name));

function makePersona(overrides: Partial<DiscoveredAgent> = {}): DiscoveredAgent {
	return { name: "p", description: "", systemPrompt: "", source: "bundled", ...overrides };
}

describe("SessionToolPolicy baseline restriction and persona grants", () => {
	// P1: `--tools` naming every default-ACTIVE tool while omitting a
	// default-INACTIVE one left isBaselineRestricted() false, so
	// resolveEffectiveSubagentPolicy passed no parent grant and a child
	// definition naming the omitted tool could activate it past the whitelist.
	it("a CLI grant covering every default-active tool still bounds default-INACTIVE tools", () => {
		const policy = new SessionToolPolicy({
			toolNames: EVERY_DEFAULT_ACTIVE,
			restrictToolNames: false,
			registry: () => REGISTRY,
			isDefaultActive: DEFAULT_ACTIVE,
		});
		expect(policy.isBaselineRestricted()).toBe(true);
		expect(policy.baselineEffectiveSet().has("ext_tool")).toBe(false);
	});

	it("the omitted default-inactive tool cannot reach a child that names it", () => {
		// Mirrors resolveEffectiveSubagentPolicy's wiring (structured-subagent.ts):
		// restrictToolNames → parentEffectiveGrant → deriveChildToolNames. Pre-fix
		// the unrestricted derivation left the child's frontmatter list unfiltered
		// and the child session activated the omitted tool.
		const policy = new SessionToolPolicy({
			toolNames: EVERY_DEFAULT_ACTIVE,
			restrictToolNames: false,
			registry: () => REGISTRY,
			isDefaultActive: DEFAULT_ACTIVE,
		});
		const child: AgentDefinition = {
			name: "worker",
			description: "",
			systemPrompt: "",
			source: "bundled",
			tools: ["ext_tool"],
		};
		const restricted = policy.isBaselineRestricted();
		const parentGrant = restricted && policy ? policy.baselineEffectiveSet() : null;
		const childTools = deriveChildToolNames(child, {
			parentEffectiveGrant: parentGrant,
			restrictToolNames: restricted,
			atMaxDepth: false,
		});
		expect(childTools ?? []).not.toContain("ext_tool");
	});

	it("a journal-installed ceiling is a restriction too", () => {
		const policy = new SessionToolPolicy({
			registry: () => REGISTRY,
			isDefaultActive: DEFAULT_ACTIVE,
		});
		policy.installJournalCeiling(EVERY_DEFAULT_ACTIVE);
		expect(policy.isBaselineRestricted()).toBe(true);
		expect(policy.baselineEffectiveSet().has("ext_tool")).toBe(false);
	});

	// P2: the registry/SDK builders auto-include the checkpoint/rewind sister
	// for one-sided lists; the persona grant stored only the declared name.
	it("persona tools:[checkpoint] pairs rewind in the stored grant", () => {
		const policy = new SessionToolPolicy({ registry: () => REGISTRY, isDefaultActive: DEFAULT_ACTIVE });
		policy.enterPersona(makePersona({ tools: ["checkpoint"] }), {});
		expect(policy.effective("checkpoint")).toBe(true);
		expect(policy.effective("rewind")).toBe(true);
	});

	it("persona tools:[rewind] pairs checkpoint in the stored grant", () => {
		const policy = new SessionToolPolicy({ registry: () => REGISTRY, isDefaultActive: DEFAULT_ACTIVE });
		policy.enterPersona(makePersona({ tools: ["rewind"] }), {});
		expect(policy.effective("checkpoint")).toBe(true);
		expect(policy.effective("rewind")).toBe(true);
	});

	it("the pairing does not widen an inherited (CLI-bounded) grant", () => {
		// Frontmatter omits tools: the grant inherits the CLI list; effective()
		// still intersects cliGrant, so the paired sister stays denied there.
		const policy = new SessionToolPolicy({
			toolNames: ["checkpoint"],
			restrictToolNames: false,
			registry: () => REGISTRY,
			isDefaultActive: DEFAULT_ACTIVE,
		});
		policy.enterPersona(makePersona(), {});
		expect(policy.effective("checkpoint")).toBe(true);
		expect(policy.effective("rewind")).toBe(false);
	});

	it("an unrelated persona grant does not gain checkpoint tools", () => {
		const policy = new SessionToolPolicy({ registry: () => REGISTRY, isDefaultActive: DEFAULT_ACTIVE });
		policy.enterPersona(makePersona({ tools: ["read"] }), {});
		expect(policy.effective("checkpoint")).toBe(false);
		expect(policy.effective("rewind")).toBe(false);
	});
});
