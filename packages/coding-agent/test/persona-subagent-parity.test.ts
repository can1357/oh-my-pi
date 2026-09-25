import { afterEach, describe, expect, it, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { type DiscoveredAgent, SessionToolPolicy } from "@oh-my-pi/pi-coding-agent/session/tool-policy";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import { deriveChildToolNames, type ExecutorOptions } from "@oh-my-pi/pi-coding-agent/task/executor";
import {
	resolveEffectiveSubagentPolicy,
	type StructuredSubagentRequest,
} from "@oh-my-pi/pi-coding-agent/task/structured-subagent";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

/**
 * Spawn-inheritance semantics (PR 11004): the persona layer scopes the main
 * agent's own behavior; it does NOT cage spawned descendants. Children are
 * bounded by the ORIGINAL main's BASELINE restriction state (registry ∩
 * cliGrant ∩ sessionToggles — persona excluded) intersected with their own
 * frontmatter. The cap is identical whether the parent reached that state via
 * launch `--agent` or a live `/agent` switch — both funnel through
 * SessionToolPolicy, so parity is structural. The assertions here go through
 * the same code paths (policy baselineEffectiveSet →
 * ExecutorOptions.parentEffectiveGrant → deriveChildToolNames).
 */

const ALL_TOOLS = new Set(["read", "grep", "glob", "write", "edit", "bash", "task", "wait", "eval"]);

function makePersona(overrides: Partial<DiscoveredAgent> = {}): DiscoveredAgent {
	return {
		name: "persona-reader",
		description: "read-only persona",
		systemPrompt: "You are the reader persona.",
		tools: ["read", "task"],
		spawns: "*",
		source: "bundled",
		...overrides,
	};
}

const CHILD_AGENT: AgentDefinition = {
	name: "worker",
	description: "Test worker",
	systemPrompt: "Do the assigned work.",
	source: "bundled",
	tools: ["read", "write", "bash"],
};

function makePolicy(options: { persona?: DiscoveredAgent } = {}): SessionToolPolicy {
	const policy = new SessionToolPolicy({
		registry: () => ALL_TOOLS,
		isDefaultActive: () => true,
	});
	if (options.persona) policy.enterPersona(options.persona, {});
	return policy;
}

/** A minimal ToolSession carrying the policy — the shape structured-subagent reads. */
function makeSession(policy: SessionToolPolicy | undefined): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		settings: Settings.isolated({ "task.maxRecursionDepth": 2 }),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getToolPolicy: () => policy,
	} as unknown as ToolSession;
}

/** A ToolSession whose spawn policy mirrors AgentSession: persona override first, host fallback. */
function makePersonaSpawnsSession(policy: SessionToolPolicy | undefined): {
	session: ToolSession;
	setPersonaSpawns: (spawns: string[] | "*" | null) => void;
} {
	let personaSpawns: string[] | "*" | null = null;
	const setSessionSpawns = (spawns: string[] | "*" | null) => {
		personaSpawns = spawns;
	};
	const session = {
		cwd: "/tmp",
		hasUI: false,
		settings: Settings.isolated({ "task.maxRecursionDepth": 2 }),
		getSessionFile: () => null,
		// Mirrors AgentSession.getSessionSpawns: the persona-owned override wins
		// when set; otherwise the host config (CLI --spawns) applies.
		getSessionSpawns: () => personaSpawns ?? "*",
		setSessionSpawns,
		getToolPolicy: () => policy,
	} as unknown as ToolSession;
	return { session, setPersonaSpawns: setSessionSpawns };
}

function makeRequest(session: ToolSession): StructuredSubagentRequest {
	return {
		session,
		invocationKind: "task",
		assignment: "Inspect the target.",
		agent: "worker",
	};
}

function mockDiscovery(): void {
	vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
		agents: [
			CHILD_AGENT,
			makePersona(),
			{
				name: "scout",
				description: "Fast read-only research",
				systemPrompt: "Research.",
				source: "bundled",
			},
		],
		projectAgentsDir: null,
	});
}

afterEach(() => {
	vi.restoreAllMocks();
});

/**
 * The shared capability oracle: whatever the child would be allowed to run,
 * derived exactly the way the executor derives it. Both launch and live-switch
 * parents flow through this with only the policy differing — and the policy
 * state is what launch and /agent produce identically.
 */
function childCapabilities(policy: SessionToolPolicy | undefined, childAgent: AgentDefinition = CHILD_AGENT): string[] {
	// Mirror of the production derivation: the persona layer is excluded from
	// spawn inheritance — the child is capped at the parent's BASELINE grant.
	const restricted = policy?.isBaselineRestricted() ?? false;
	const parentGrant = restricted && policy ? policy.baselineEffectiveSet() : null;
	return (
		deriveChildToolNames(childAgent, {
			parentEffectiveGrant: parentGrant,
			restrictToolNames: restricted,
			atMaxDepth: false,
		}) ?? []
	);
}

describe("subagent spawn inheritance parity", () => {
	it("child capabilities are identical via launch persona and live /agent switch", async () => {
		const persona = makePersona();
		mockDiscovery();

		// Path A — launch `--agent`: policy enters the persona at construction.
		const launchPolicy = makePolicy({ persona });
		const launchSession = makeSession(launchPolicy);
		const launchPolicyResolved = await resolveEffectiveSubagentPolicy(makeRequest(launchSession));

		// Path B — live `/agent` switch post-creation: an unrestricted session's
		// policy enters the persona later. Same policy class, same mutation.
		const livePolicy = makePolicy();
		const liveSession = makeSession(livePolicy);
		livePolicy.enterPersona(persona, {});
		const livePolicyResolved = await resolveEffectiveSubagentPolicy(makeRequest(liveSession));

		// Both paths must report the same baseline restriction and child dispatch
		// surface. Persona-active parents are baseline-restricted only when the
		// CLI/toggle layer narrows — here the baseline is unrestricted, so
		// restrictToolNames is false and the persona does NOT cage children.
		expect(launchPolicyResolved.restrictToolNames).toBe(false);
		expect(livePolicyResolved.restrictToolNames).toBe(false);
		expect(launchPolicyResolved.parentEffectiveGrant).toEqual(livePolicyResolved.parentEffectiveGrant);
		expect(launchPolicyResolved.parentEffectiveGrant).toBeNull();

		// And the child capability set the executor derives is identical:
		// persona [read, task] does not cage — child keeps its frontmatter
		// [read, write, bash] with no wait auto-append (subagents never block on wait upstream).
		expect(childCapabilities(launchPolicy)).toEqual(childCapabilities(livePolicy));
		expect(childCapabilities(launchPolicy)).toEqual(["read", "write", "bash"]);
	});

	it("persona-active parent with unrestricted baseline leaves child [read, bash] intact", async () => {
		const persona = makePersona({ tools: ["read", "task"] });
		mockDiscovery();
		const policy = makePolicy({ persona });
		const session = makeSession(policy);
		const resolved = await resolveEffectiveSubagentPolicy(makeRequest(session));
		const child = {
			...CHILD_AGENT,
			tools: ["read", "bash"],
			spawns: undefined,
		};

		expect(resolved.restrictToolNames).toBe(false);
		expect(resolved.parentEffectiveGrant).toBeNull();
		expect(childCapabilities(policy, child)).toEqual(["read", "bash"]);
	});

	it("CLI-restricted parent still cages the child even with a widening persona", async () => {
		// cliGrant [read]: the persona declares [read, write] but can never
		// widen past the CLI grant; the child inherits the baseline, not the
		// persona's narrowed-or-widened set.
		const policy = new SessionToolPolicy({
			toolNames: ["read"],
			restrictToolNames: true,
			registry: () => ALL_TOOLS,
			isDefaultActive: () => true,
		});
		policy.enterPersona(makePersona({ tools: ["read", "write", "task"] }), {});
		const child = {
			...CHILD_AGENT,
			tools: ["read", "bash"],
			spawns: undefined,
		};

		expect(policy.isBaselineRestricted()).toBe(true);
		expect(policy.baselineEffectiveSet()).toEqual(new Set(["read"]));
		expect(childCapabilities(policy, child)).toEqual(["read"]);
	});

	it("maintainer example: persona [read,write] cannot widen a CLI [read] parent; child [write] gets []", () => {
		const policy = new SessionToolPolicy({
			toolNames: ["read"],
			restrictToolNames: true,
			registry: () => ALL_TOOLS,
			isDefaultActive: () => true,
		});
		policy.enterPersona(makePersona({ tools: ["read", "write"] }), {});
		const child = deriveChildToolNames(
			{ ...CHILD_AGENT, tools: ["write"], spawns: undefined },
			{
				parentEffectiveGrant: policy.baselineEffectiveSet(),
				restrictToolNames: policy.isBaselineRestricted(),
				atMaxDepth: false,
			},
		);
		expect(child).toEqual([]);
	});

	it("maintainer example: CLI [read] parent with persona [read,task] caps child [read,bash] at [read]", () => {
		const policy = new SessionToolPolicy({
			toolNames: ["read"],
			restrictToolNames: true,
			registry: () => ALL_TOOLS,
			isDefaultActive: () => true,
		});
		policy.enterPersona(makePersona(), {});
		const child = deriveChildToolNames(
			{ ...CHILD_AGENT, tools: ["read", "bash"], spawns: undefined },
			{
				parentEffectiveGrant: policy.baselineEffectiveSet(),
				restrictToolNames: policy.isBaselineRestricted(),
				atMaxDepth: false,
			},
		);
		expect(child).toEqual(["read"]);
	});

	it("explicit child tools:[bash] is dropped under a CLI-restricted parent", () => {
		// CLI grant [read]: the persona is irrelevant to inheritance; the child
		// is intersected with the baseline, which excludes bash.
		const policy = new SessionToolPolicy({
			toolNames: ["read"],
			restrictToolNames: true,
			registry: () => ALL_TOOLS,
			isDefaultActive: () => true,
		});
		policy.enterPersona(makePersona({ tools: ["read"] }), {});
		const child = deriveChildToolNames(
			{ ...CHILD_AGENT, tools: ["bash"], spawns: undefined },
			{
				parentEffectiveGrant: policy.baselineEffectiveSet(),
				restrictToolNames: policy.isBaselineRestricted(),
				atMaxDepth: false,
			},
		);
		expect(child).toEqual([]);
	});

	it("no-tools-frontmatter child under persona-active parent inherits the baseline, not the persona set", async () => {
		// Persona narrows to [read, task], but the ORIGINAL main is unrestricted:
		// the child inherits the full baseline (every default-active registered
		// tool), NOT the persona's narrowed set.
		const persona = makePersona();
		mockDiscovery();
		const policy = makePolicy({ persona });
		const session = makeSession(policy);
		const resolved = await resolveEffectiveSubagentPolicy(makeRequest(session));

		expect(resolved.restrictToolNames).toBe(false);
		expect(resolved.parentEffectiveGrant).toBeNull();

		const child = deriveChildToolNames(
			{ ...CHILD_AGENT, tools: undefined, spawns: undefined },
			{
				parentEffectiveGrant: resolved.parentEffectiveGrant,
				restrictToolNames: resolved.restrictToolNames,
				atMaxDepth: false,
			},
		);
		// Unrestricted parent: no explicit tool-list override at all — the
		// executor falls back to the child's default tool set, undecorated.
		expect(child).toBeUndefined();
	});

	it("no-tools-frontmatter child under a CLI-restricted parent inherits the baseline grant", () => {
		const policy = new SessionToolPolicy({
			toolNames: ["read", "task"],
			restrictToolNames: true,
			registry: () => ALL_TOOLS,
			isDefaultActive: () => true,
		});
		policy.enterPersona(makePersona(), {});
		const child = deriveChildToolNames(
			{ ...CHILD_AGENT, tools: undefined, spawns: undefined },
			{
				parentEffectiveGrant: policy.baselineEffectiveSet(),
				restrictToolNames: policy.isBaselineRestricted(),
				atMaxDepth: false,
			},
		);
		expect(new Set(child)).toEqual(new Set(["read", "task"]));
	});

	it("unrestricted parent leaves child tool derivation unchanged", async () => {
		mockDiscovery();
		const policy = makePolicy();
		const session = makeSession(policy);
		const resolved = await resolveEffectiveSubagentPolicy(makeRequest(session));

		expect(resolved.restrictToolNames).toBe(false);
		expect(resolved.parentEffectiveGrant).toBeNull();

		// Unrestricted: child keeps its full frontmatter list, and an ordinary
		// agent keeps its frontmatter list unchanged (no wait auto-append).
		expect(childCapabilities(policy)).toEqual(["read", "write", "bash"]);
	});

	it("no wait auto-append for children: subagents never block on wait upstream", () => {
		// Upstream contract (executor-pass-through pin): createTools drops wait
		// at depth > 0, so deriving it onto a child would hand it a tool it
		// can never run. deriveChildToolNames leaves the frontmatter list alone.
		const policy = makePolicy();
		expect(childCapabilities(policy)).toEqual(["read", "write", "bash"]);
		const child = deriveChildToolNames(CHILD_AGENT, {
			parentEffectiveGrant: null,
			restrictToolNames: false,
			atMaxDepth: false,
		});
		expect(child).not.toContain("wait");
	});

	it("child with empty spawns keeps no task tool (deny-all)", () => {
		// An explicitly empty `spawns: []` denies all spawning: auto-adding
		// task would only fail later at preflight, so the derivation leaves
		// the intersected frontmatter alone.
		const child = deriveChildToolNames(
			{ ...CHILD_AGENT, tools: ["read"], spawns: [] },
			{ parentEffectiveGrant: null, restrictToolNames: false, atMaxDepth: false },
		);
		expect(child).toEqual(["read"]);
	});

	it("cliGrant narrowing counts as baseline restriction and caps the child", () => {
		// The baseline layer is registry ∩ cliGrant ∩ sessionToggles; a persona
		// (even a widening one) must not lift the CLI grant for descendants.
		const policy = new SessionToolPolicy({
			toolNames: ["read"],
			restrictToolNames: true,
			registry: () => ALL_TOOLS,
			isDefaultActive: () => true,
		});
		policy.enterPersona(makePersona(), {});
		const child = deriveChildToolNames(CHILD_AGENT, {
			parentEffectiveGrant: policy.baselineEffectiveSet(),
			restrictToolNames: policy.isBaselineRestricted(),
			atMaxDepth: false,
		});
		// restrictToolNames=true suppresses the wait auto-append for restricted
		// hosts: child is exactly the intersected frontmatter.
		expect(new Set(child)).toEqual(new Set(["read"]));
	});

	it("task auto-include for spawns frontmatter respects the parent baseline", () => {
		// spawnsBroken strips task from the persona grant (main agent layer),
		// but the baseline still carries task — the child's own spawns
		// frontmatter re-includes it only if the BASELINE grants it.
		const policy = makePolicy({
			persona: makePersona({ tools: ["read"], spawns: [] }),
		});
		const child = deriveChildToolNames(
			{ ...CHILD_AGENT, tools: ["read"], spawns: ["worker"] },
			{
				parentEffectiveGrant: policy.baselineEffectiveSet(),
				restrictToolNames: true,
				atMaxDepth: false,
			},
		);
		expect(new Set(child)).toEqual(new Set(["read", "task"]));
	});

	// fr-vW: the `exec` shorthand expands on the CHILD side BEFORE the parent
	// intersect — a [bash]-granting parent must not vanish a child's exec.
	it("child exec shorthand under a [bash]-granting parent keeps bash (fo80l)", () => {
		const policy = new SessionToolPolicy({
			toolNames: ["bash"],
			restrictToolNames: true,
			registry: () => ALL_TOOLS,
			isDefaultActive: () => true,
		});
		policy.enterPersona(makePersona(), {});
		const child = deriveChildToolNames(
			{ ...CHILD_AGENT, tools: ["exec"], spawns: undefined },
			{
				parentEffectiveGrant: policy.baselineEffectiveSet(),
				restrictToolNames: policy.isBaselineRestricted(),
				atMaxDepth: false,
			},
		);
		// exec → [bash, eval]; intersect with baseline [bash] keeps bash, drops eval.
		expect(child).toEqual(["bash"]);
	});

	it("child exec shorthand with backends expands to bash+eval before the intersect", () => {
		const grant = new Set(["bash", "eval"]);
		const child = deriveChildToolNames(
			{ ...CHILD_AGENT, tools: ["exec"], spawns: undefined },
			{
				parentEffectiveGrant: grant,
				restrictToolNames: true,
				atMaxDepth: false,
				evalBackends: { python: true, js: false },
			},
		);
		expect(new Set(child)).toEqual(new Set(["bash", "eval"]));
	});
	// fw_sH: a raw legacy alias (`search`→grep) must normalize BEFORE the
	// parent intersect — the grant holds canonical names only, so a
	// first-intersect alias would be discarded with nothing left to re-normalize.
	it("child legacy alias under a canonical-granting parent keeps the canonical tool (fw_sH)", () => {
		const grant = new Set(["read", "grep", "glob"]);
		const child = deriveChildToolNames(
			{ ...CHILD_AGENT, tools: ["search"], spawns: undefined },
			{
				parentEffectiveGrant: grant,
				restrictToolNames: true,
				atMaxDepth: false,
			},
		);
		expect(new Set(child)).toEqual(new Set(["grep"]));
	});
	it("executor dispatch carries the parent's baseline grant end to end", async () => {
		const persona = makePersona();
		mockDiscovery();
		const policy = makePolicy({ persona });
		const session = makeSession(policy);

		// resolveEffectiveSubagentPolicy → buildExecutorOptions path is exercised
		// via the public preflight; the grant reaches ExecutorOptions unchanged.
		const resolved = await resolveEffectiveSubagentPolicy(makeRequest(session));
		expect(resolved.restrictToolNames).toBe(false);
		expect(resolved.parentEffectiveGrant).toBeNull();

		// SingleResult consumers only observe tool names through dispatched
		// ExecutorOptions — assert the derivation the executor performs.
		const options: Pick<ExecutorOptions, "parentEffectiveGrant"> = {
			parentEffectiveGrant: resolved.parentEffectiveGrant,
		};
		expect(options.parentEffectiveGrant).toBeNull();
	});

	it("executor dispatch carries a CLI-restricted parent's baseline grant end to end", async () => {
		const policy = new SessionToolPolicy({
			toolNames: ["read", "task"],
			restrictToolNames: true,
			registry: () => ALL_TOOLS,
			isDefaultActive: () => true,
		});
		policy.enterPersona(makePersona(), {});
		mockDiscovery();
		const session = makeSession(policy);
		const resolved = await resolveEffectiveSubagentPolicy(makeRequest(session));

		expect(resolved.restrictToolNames).toBe(true);
		expect(resolved.parentEffectiveGrant).toEqual(policy.baselineEffectiveSet());

		const options: Pick<ExecutorOptions, "parentEffectiveGrant"> = {
			parentEffectiveGrant: resolved.parentEffectiveGrant,
		};
		expect(options.parentEffectiveGrant?.has("write")).toBe(false);
		expect(options.parentEffectiveGrant?.has("read")).toBe(true);
		expect(options.parentEffectiveGrant?.has("task")).toBe(true);
	});

	it("persona holding a mutation tool passes mutations through when the baseline grants them", () => {
		// Persona [read, bash, task]; baseline unrestricted → the persona does
		// not cage: the child keeps its full frontmatter [read, write, bash].
		// (restrictToolNames=false here would auto-append wait; restricted=true
		// via an explicit grant keeps the assertion on the intersect alone.)
		const policy = makePolicy({
			persona: makePersona({ tools: ["read", "bash", "task"] }),
		});
		const child = deriveChildToolNames(CHILD_AGENT, {
			parentEffectiveGrant: policy.baselineEffectiveSet(),
			restrictToolNames: policy.isBaselineRestricted(),
			atMaxDepth: false,
		});
		expect(new Set(child)).toEqual(new Set(["read", "write", "bash"]));
	});

	it("persona spawns:[scout] drives the task-tool preflight spawn gate (foxlt/foy5f)", async () => {
		// The persona owns the session spawn policy (PersonaRuntime.enter →
		// setSessionSpawns); the tool-session getter must reflect it so the
		// preflight rejects agents outside the whitelist.
		const persona = makePersona({ spawns: ["scout"], tools: ["read", "task"] });
		mockDiscovery();
		const policy = makePolicy({ persona });
		const { session, setPersonaSpawns } = makePersonaSpawnsSession(policy);
		// What PersonaRuntime.#enterInner does on persona activation:
		setPersonaSpawns(persona.spawns ?? null);

		// Whitelisted agent: preflight accepts.
		const allowed = await resolveEffectiveSubagentPolicy({
			...makeRequest(session),
			agent: "scout",
		});
		expect(allowed.agentName).toBe("scout");

		// Outside the whitelist: preflight rejects.
		await expect(
			resolveEffectiveSubagentPolicy({
				...makeRequest(session),
				agent: "worker",
			}),
		).rejects.toThrow(/Cannot spawn 'worker'/);

		// Exit (setSessionSpawns(null)) restores the host-unrestricted policy.
		setPersonaSpawns(null);
		const unrestricted = await resolveEffectiveSubagentPolicy({
			...makeRequest(session),
			agent: "worker",
		});
		expect(unrestricted.agentName).toBe("worker");
	});

	it("persona spawns:[] disables spawning outright in preflight", async () => {
		const persona = makePersona({ spawns: [], tools: ["read", "task"] });
		mockDiscovery();
		const { session, setPersonaSpawns } = makePersonaSpawnsSession(makePolicy({ persona }));
		setPersonaSpawns(persona.spawns ?? null);

		await expect(
			resolveEffectiveSubagentPolicy({
				...makeRequest(session),
				agent: "scout",
			}),
		).rejects.toThrow(/spawns disabled/);
	});
});
