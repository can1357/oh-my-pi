import { describe, expect, it } from "bun:test";
import { SessionToolPolicy } from "@oh-my-pi/pi-coding-agent/session/tool-policy";
import type { DiscoveredAgent, PersonaExplicitOverrides } from "@oh-my-pi/pi-coding-agent/session/tool-policy";

function makeAgent(overrides: Partial<DiscoveredAgent> = {}): DiscoveredAgent {
	return {
		name: "test-agent",
		description: "test",
		systemPrompt: "test prompt",
		source: "bundled",
		...overrides,
	};
}

const NO_EXPLICIT: PersonaExplicitOverrides = {};

const ALL_TOOLS = new Set(["read", "grep", "glob", "write", "edit", "bash", "task", "hub", "lsp"]);
const defaultActive = (name: string): boolean => name !== "lsp"; // lsp tools are defaultInactive

function makePolicy(
	options: {
		toolNames?: readonly string[];
		restrictToolNames?: boolean;
		lspReadOnly?: boolean;
		registry?: ReadonlySet<string>;
	} = {},
): SessionToolPolicy {
	return new SessionToolPolicy({
		toolNames: options.toolNames,
		restrictToolNames: options.restrictToolNames,
		lspReadOnly: options.lspReadOnly,
		registry: () => options.registry ?? ALL_TOOLS,
		isDefaultActive: defaultActive,
	});
}

describe("SessionToolPolicy", () => {
	// Acceptance 1: explicit CLI flags are durable at construction
	it("cliGrant exists whenever toolNames is given, regardless of restrictToolNames", () => {
		expect(makePolicy({ toolNames: ["read", "grep"] }).cliGrant).toEqual(new Set(["read", "grep"]));
		expect(makePolicy({ toolNames: ["read"], restrictToolNames: false }).cliGrant).toEqual(new Set(["read"]));
		expect(makePolicy().cliGrant).toBeNull();
	});

	// Acceptance 5: spawns:[] persona → task off, no spawn affordance
	it("persona with declared-and-empty spawns strips task and reports not spawnable", () => {
		const policy = makePolicy();
		policy.enterPersona(makeAgent({ spawns: [] }), NO_EXPLICIT);
		expect(policy.effective("task")).toBe(false);
		expect(policy.spawnable()).toBe(false);
		expect(policy.isPersonaActive()).toBe(true);
	});

	// Acceptance 6: tools:[read] persona → no mutation anywhere
	it("read-only persona grant blocks write/edit/bash mutations", () => {
		const policy = makePolicy();
		policy.enterPersona(makeAgent({ tools: ["read"] }), NO_EXPLICIT);
		expect(policy.effective("read")).toBe(true);
		expect(policy.mutating()).toBe(false);
		expect(policy.lspReadOnly()).toBe(true);
	});

	// Acceptance 7: persona never widens past CLI grant
	it("persona grant intersects with cliGrant — never widens", () => {
		const policy = makePolicy({ toolNames: ["read", "grep", "write"], restrictToolNames: true });
		policy.enterPersona(makeAgent(), NO_EXPLICIT); // no tools frontmatter → registry-wide grant
		expect(policy.effective("read")).toBe(true);
		expect(policy.effective("bash")).toBe(false); // outside cliGrant despite persona registry-wide grant
		expect(policy.isRestricted()).toBe(true);
	});

	// Acceptance 8: spawn inheritance — parent effective grant governs task spawnability
	it("spawnable() follows persona grant, not raw agent tools", () => {
		const policy = makePolicy({ toolNames: ["read", "task"], restrictToolNames: true });
		policy.enterPersona(makeAgent({ tools: ["read"] }), NO_EXPLICIT);
		expect(policy.effective("task")).toBe(false); // persona tools lack task
		expect(policy.spawnable()).toBe(false);
		policy.exitPersona();
		expect(policy.effective("task")).toBe(true);
		expect(policy.spawnable()).toBe(true);
	});

	// Acceptance 11: ad-hoc activations survive persona enter/exit
	it("session toggles survive persona enter and exit", () => {
		const policy = makePolicy();
		policy.setSessionToolEnabled("lsp", true); // defaultInactive tool activated
		expect(policy.effective("lsp")).toBe(true);
		policy.enterPersona(makeAgent({ tools: ["read", "lsp"] }), NO_EXPLICIT);
		expect(policy.effective("lsp")).toBe(true);
		expect(policy.effective("bash")).toBe(false); // persona narrows
		policy.exitPersona();
		expect(policy.effective("lsp")).toBe(true); // toggle survived
		expect(policy.effective("bash")).toBe(true);
	});

	// Acceptance 12: unknown/disabled spawns still advertise task (don't-validate convention)
	it("persona with unknown spawn names keeps task", () => {
		const policy = makePolicy();
		policy.enterPersona(makeAgent({ spawns: ["totally-unknown-agent"] }), NO_EXPLICIT);
		expect(policy.effective("task")).toBe(true);
		expect(policy.spawnable()).toBe(true);
	});

	it("cliLspReadOnly defaults to restrictToolNames and is durable across persona switches", () => {
		expect(makePolicy({ restrictToolNames: true }).cliLspReadOnly).toBe(true);
		expect(makePolicy({ restrictToolNames: false }).cliLspReadOnly).toBe(false);
		expect(makePolicy({ restrictToolNames: false, lspReadOnly: true }).cliLspReadOnly).toBe(true);

		const policy = makePolicy({ restrictToolNames: true });
		policy.enterPersona(makeAgent({ tools: ["read", "write"] }), NO_EXPLICIT);
		expect(policy.lspReadOnly()).toBe(true); // durable cli default wins
	});

	it("lspReadOnly derives false when persona keeps a mutation tool", () => {
		const policy = makePolicy();
		policy.enterPersona(makeAgent({ tools: ["read", "write"] }), NO_EXPLICIT);
		expect(policy.lspReadOnly()).toBe(false);
		expect(policy.mutating()).toBe(true);
	});

	it("hubEnabled follows effective('hub') with no extra persona check", () => {
		const policy = makePolicy();
		expect(policy.hubEnabled()).toBe(true);
		policy.enterPersona(makeAgent({ tools: ["read"] }), NO_EXPLICIT);
		expect(policy.hubEnabled()).toBe(false);
		policy.exitPersona();
		expect(policy.hubEnabled()).toBe(true);
	});

	it("persona grant from registry (no tools frontmatter) keeps hub and strips task only for spawns:[]", () => {
		const policy = makePolicy();
		policy.enterPersona(makeAgent(), NO_EXPLICIT);
		expect(policy.hubEnabled()).toBe(true);
		expect(policy.effective("task")).toBe(true); // spawns undefined → no strip
		expect(policy.spawnable()).toBe(true);
	});

	it("snapshot/restore round-trips persona and toggles without aliasing", () => {
		const policy = makePolicy();
		policy.setSessionToolEnabled("grep", false);
		policy.enterPersona(makeAgent({ tools: ["read"] }), { model: "openai/gpt-4o" });
		const snap = policy.snapshot();

		policy.exitPersona();
		policy.setSessionToolEnabled("grep", true);
		expect(policy.effective("grep")).toBe(true);
		expect(policy.isPersonaActive()).toBe(false);

		policy.restore(snap);
		expect(policy.isPersonaActive()).toBe(true);
		expect(policy.effective("grep")).toBe(false);
		expect(policy.effective("read")).toBe(true);

		// mutating the restored toggle must not leak back into the snapshot
		policy.setSessionToolEnabled("grep", true);
		expect(snap.sessionToggles.get("grep")).toBe(false);
	});

	it("exitPersona restores pre-persona capability state", () => {
		const policy = makePolicy({ restrictToolNames: true, toolNames: ["read", "grep"] });
		expect(policy.lspReadOnly()).toBe(true);
		expect(policy.isPersonaActive()).toBe(false);
		policy.enterPersona(makeAgent({ tools: ["read", "write"] }), NO_EXPLICIT);
		expect(policy.effective("write")).toBe(false); // still narrowed by cliGrant
		expect(policy.mutating()).toBe(false);
		policy.exitPersona();
		expect(policy.effective("read")).toBe(true);
		expect(policy.effective("write")).toBe(false);
	});
});
