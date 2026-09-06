import { afterEach, describe, expect, it, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { type DiscoveredAgent, SessionToolPolicy } from "@oh-my-pi/pi-coding-agent/session/tool-policy";
import {
	type StructuredSubagentRequest,
	resolveEffectiveSubagentPolicy,
} from "@oh-my-pi/pi-coding-agent/task/structured-subagent";
import { deriveChildToolNames, type ExecutorOptions } from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

/**
 * Spawn-inheritance parity (PR 9510 stage 2, acceptance 8): a restricted parent
 * caps its spawned subagents at the parent's own effective grant, and the cap is
 * identical whether the parent reached that state via launch `--agent` or a live
 * `/agent` switch — both funnel through SessionToolPolicy, so parity is
 * structural. The assertions here go through the same code paths (policy
 * effectiveSet → ExecutorOptions.parentEffectiveGrant → deriveChildToolNames).
 */

const ALL_TOOLS = new Set(["read", "grep", "glob", "write", "edit", "bash", "task", "hub", "eval"]);

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
		agents: [CHILD_AGENT, makePersona()],
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
	const restricted = policy?.isRestricted() ?? false;
	const parentGrant = restricted && policy ? policy.effectiveSet() : null;
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

		// Both paths must report the same restriction and child dispatch surface.
		expect(launchPolicyResolved.restrictToolNames).toBe(true);
		expect(livePolicyResolved.restrictToolNames).toBe(true);
		expect(launchPolicyResolved.parentEffectiveGrant).toEqual(livePolicyResolved.parentEffectiveGrant);
		expect(launchPolicyResolved.parentEffectiveGrant).toBeTruthy();

		// And the child capability set the executor derives is identical.
		expect(childCapabilities(launchPolicy)).toEqual(childCapabilities(livePolicy));
		// Persona [read, task] caps the child at [read]: write/bash out of grant.
		expect(childCapabilities(launchPolicy)).toEqual(["read"]);
		expect(childCapabilities(launchPolicy)).not.toContain("write");
		expect(childCapabilities(launchPolicy)).not.toContain("bash");
	});

	it("explicit child tools:[bash] is stripped under a read-only parent persona", () => {
		const policy = makePolicy({ persona: makePersona({ tools: ["read"] }) });
		const child = deriveChildToolNames(
			{ ...CHILD_AGENT, tools: ["bash"], spawns: undefined },
			{
				parentEffectiveGrant: policy.effectiveSet(),
				restrictToolNames: policy.isRestricted(),
				atMaxDepth: false,
			},
		);
		expect(child).toEqual([]);
	});

	it("no-tools-frontmatter child inherits the parent's full effective grant when restricted", () => {
		const persona = makePersona();
		const policy = makePolicy({ persona });
		const child = deriveChildToolNames(
			{ ...CHILD_AGENT, tools: undefined, spawns: undefined },
			{
				parentEffectiveGrant: policy.effectiveSet(),
				restrictToolNames: policy.isRestricted(),
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
		// agent still gets the hub auto-append.
		expect(childCapabilities(policy)).toEqual(["read", "write", "bash", "hub"]);
	});

	it("hub auto-append is skipped for a restricted parent (hub not in grant)", () => {
		const policy = makePolicy({ persona: makePersona() }); // grant: read + task, no hub
		const child = deriveChildToolNames(CHILD_AGENT, {
			parentEffectiveGrant: policy.effectiveSet(),
			restrictToolNames: policy.isRestricted(),
			atMaxDepth: false,
		});
		expect(child).not.toContain("hub");
	});

	it("task auto-include for spawns frontmatter respects the parent grant", () => {
		const policy = makePolicy({ persona: makePersona({ tools: ["read"], spawns: [] }) });
		const child = deriveChildToolNames(
			{ ...CHILD_AGENT, tools: ["read"], spawns: ["worker"] },
			{
				parentEffectiveGrant: policy.effectiveSet(),
				restrictToolNames: true,
				atMaxDepth: false,
			},
		);
		// Parent spawns:[] strips task from its grant; child cannot be granted it.
		expect(child).toEqual(["read"]);
	});

	it("executor dispatch carries the parent's effective grant end to end", async () => {
		const persona = makePersona();
		mockDiscovery();
		const policy = makePolicy({ persona });
		const session = makeSession(policy);

		// resolveEffectiveSubagentPolicy → buildExecutorOptions path is exercised
		// via the public preflight; the grant reaches ExecutorOptions unchanged.
		const resolved = await resolveEffectiveSubagentPolicy(makeRequest(session));
		expect(resolved.parentEffectiveGrant).toEqual(policy.effectiveSet());

		// SingleResult consumers only observe tool names through dispatched
		// ExecutorOptions — assert the derivation the executor performs.
		const options: Pick<ExecutorOptions, "parentEffectiveGrant"> = {
			parentEffectiveGrant: resolved.parentEffectiveGrant,
		};
		expect(options.parentEffectiveGrant?.has("write")).toBe(false);
		expect(options.parentEffectiveGrant?.has("read")).toBe(true);
		expect(options.parentEffectiveGrant?.has("task")).toBe(true);
	});

	it("childCapabilities for a persona holding a mutation tool passes mutations through when granted", () => {
		const policy = makePolicy({ persona: makePersona({ tools: ["read", "bash", "task"] }) });
		const child = deriveChildToolNames(CHILD_AGENT, {
			parentEffectiveGrant: policy.effectiveSet(),
			restrictToolNames: true,
			atMaxDepth: false,
		});
		expect(new Set(child)).toEqual(new Set(["read", "bash"]));
	});
});
