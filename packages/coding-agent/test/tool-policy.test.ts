import { describe, expect, it } from "bun:test";
import type { DiscoveredAgent, PersonaExplicitOverrides } from "@oh-my-pi/pi-coding-agent/session/tool-policy";
import { SessionToolPolicy } from "@oh-my-pi/pi-coding-agent/session/tool-policy";
import { makePersonaAgent } from "./persona-test-utils";

/** Shared persona fixture with this suite's name-only identity default. */
const makeAgent = (overrides: Partial<DiscoveredAgent> = {}): DiscoveredAgent =>
	makePersonaAgent({
		name: "test-agent",
		description: "test",
		systemPrompt: "test prompt",
		...overrides,
	});

const NO_EXPLICIT: PersonaExplicitOverrides = {};

const ALL_TOOLS = new Set(["read", "grep", "glob", "write", "edit", "bash", "task", "hub", "lsp", "eval"]);
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
	it("persona with declared-and-empty spawns strips task", () => {
		const policy = makePolicy();
		policy.enterPersona(makeAgent({ spawns: [] }), NO_EXPLICIT);
		expect(policy.effective("task")).toBe(false);
		expect(policy.isPersonaActive()).toBe(true);
	});

	// Acceptance 6: tools:[read] persona → no mutation anywhere
	it("read-only persona grant blocks write/edit/bash mutations", () => {
		const policy = makePolicy();
		policy.enterPersona(makeAgent({ tools: ["read"] }), NO_EXPLICIT);
		expect(policy.effective("read")).toBe(true);
		expect(policy.effective("write")).toBe(false);
		expect(policy.effective("edit")).toBe(false);
		expect(policy.effective("bash")).toBe(false);
		expect(policy.lspReadOnly()).toBe(true);
	});

	// Acceptance 7: persona never widens past CLI grant
	it("persona grant intersects with cliGrant — never widens", () => {
		const policy = makePolicy({
			toolNames: ["read", "grep", "write"],
			restrictToolNames: true,
		});
		policy.enterPersona(makeAgent(), NO_EXPLICIT); // no tools frontmatter → registry-wide grant
		expect(policy.effective("read")).toBe(true);
		expect(policy.effective("bash")).toBe(false); // outside cliGrant despite persona registry-wide grant
	});

	// Acceptance 8: spawn inheritance — parent effective grant governs task spawnability
	it("task effectiveness follows persona grant, not raw agent tools", () => {
		const policy = makePolicy({
			toolNames: ["read", "task"],
			restrictToolNames: true,
		});
		policy.enterPersona(makeAgent({ tools: ["read"] }), NO_EXPLICIT);
		expect(policy.effective("task")).toBe(false); // persona tools lack task
		policy.exitPersona();
		expect(policy.effective("task")).toBe(true);
	});

	// Acceptance 12: unknown/disabled spawns still advertise task (don't-validate convention)
	it("persona with unknown spawn names keeps task", () => {
		const policy = makePolicy();
		policy.enterPersona(makeAgent({ spawns: ["totally-unknown-agent"] }), NO_EXPLICIT);
		expect(policy.effective("task")).toBe(true);
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
		expect(policy.effective("write")).toBe(true);
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
	});

	it("exitPersona restores pre-persona capability state", () => {
		const policy = makePolicy({
			restrictToolNames: true,
			toolNames: ["read", "grep"],
		});
		expect(policy.lspReadOnly()).toBe(true);
		expect(policy.isPersonaActive()).toBe(false);
		policy.enterPersona(makeAgent({ tools: ["read", "write"] }), NO_EXPLICIT);
		expect(policy.effective("write")).toBe(false); // still narrowed by cliGrant
		policy.exitPersona();
		expect(policy.effective("read")).toBe(true);
		expect(policy.effective("write")).toBe(false);
	});

	// foy5e: explicit.tools (the CLI --tools grant at launch) must intersect the
	// persona grant; on resume the persisted explicit list IS the durable grant.
	it("explicit.tools narrows the persona grant (launch path)", () => {
		const policy = makePolicy();
		policy.enterPersona(makeAgent({ tools: ["read", "bash"] }), {
			tools: ["read"],
		});
		expect(policy.effective("read")).toBe(true);
		expect(policy.effective("bash")).toBe(false);
	});

	it("explicit.tools survives snapshot/restore round-trip", () => {
		const policy = makePolicy();
		policy.enterPersona(makeAgent(), { tools: ["read"] });
		const snap = policy.snapshot();
		policy.exitPersona();
		policy.restore(snap);
		expect(policy.effective("read")).toBe(true);
		expect(policy.effective("bash")).toBe(false); // still narrowed after restore
	});

	// P1-1: an empty (or fully-intersected-away) persona grant is deny-all —
	// collapsing it to `null` would widen it back to "every registered tool".
	it("declared-empty tools is an empty (deny-all) grant, never registry-wide", () => {
		const policy = makePolicy();
		policy.enterPersona(makeAgent({ tools: [] }), NO_EXPLICIT);
		for (const name of ALL_TOOLS) {
			expect(policy.effective(name)).toBe(false);
		}
		expect(policy.effective("task")).toBe(false);
		expect(policy.isPersonaActive()).toBe(true);
		policy.exitPersona();
		expect(policy.effective("read")).toBe(true); // back to unrestricted
	});

	it("explicit.tools disjoint from declared tools collapses to deny-all, not registry-wide", () => {
		const policy = makePolicy();
		policy.enterPersona(makeAgent({ tools: ["read", "edit"] }), {
			tools: ["bash"],
		});
		expect(policy.effective("read")).toBe(false);
		expect(policy.effective("bash")).toBe(false);
		expect(policy.effective("edit")).toBe(false);
	});

	// fr-vW: `exec` is a supported TOOLS SHORTHAND — the persona grant must
	// expand it to concrete tool names BEFORE the grant is stored, so
	// effective()/granted() only ever see bash (and eval when backends allow).
	it("persona tools:[exec] expands to bash/eval in the grant", () => {
		const policy = makePolicy();
		policy.enterPersona(makeAgent({ tools: ["exec"] }), NO_EXPLICIT);
		expect(policy.effective("bash")).toBe(true);
		expect(policy.effective("eval")).toBe(true);
		expect(policy.effective("exec")).toBe(false); // shorthand never surfaces as a tool
		expect(policy.effective("write")).toBe(false);
	});

	it("persona exec grant intersects with explicit.tools on the EXPANDED names", () => {
		const policy = makePolicy();
		policy.enterPersona(makeAgent({ tools: ["exec", "read"] }), { tools: ["bash"] });
		// explicit [bash] intersects the expanded [bash, eval, read]: only bash survives.
		expect(policy.effective("bash")).toBe(true);
		expect(policy.effective("eval")).toBe(false);
		expect(policy.effective("read")).toBe(false);
	});

	// fo80e: a persona declaring a usable spawns list needs `task` for the
	// policy to be usable — mirror the executor's child auto-add rule.
	it("persona tools:[read] + spawns:[scout] auto-adds task", () => {
		const policy = makePolicy();
		policy.enterPersona(makeAgent({ tools: ["read"], spawns: ["scout"] }), NO_EXPLICIT);
		expect(policy.effective("read")).toBe(true);
		expect(policy.effective("task")).toBe(true);
		expect(policy.effective("write")).toBe(false);
	});

	it("persona spawns:'*' auto-adds task under a null (registry-wide) grant", () => {
		const policy = makePolicy();
		policy.enterPersona(makeAgent({ spawns: "*" }), NO_EXPLICIT);
		expect(policy.effective("task")).toBe(true);
	});

	it("declared-empty spawns still strips task (auto-add does not resurrect it)", () => {
		const policy = makePolicy();
		policy.enterPersona(makeAgent({ spawns: [] }), NO_EXPLICIT);
		expect(policy.effective("task")).toBe(false);
	});
});
