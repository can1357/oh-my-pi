import type { AgentDefinition } from "../task/types";

/**
 * A discovered or bundled agent definition, as consumed by persona switching.
 * Plan §1 names this `DiscoveredAgent`; it is the repo's existing {@link AgentDefinition} shape.
 */
export type DiscoveredAgent = AgentDefinition;

/**
 * Explicit per-invocation persona overrides (CLI flags / RPC parameters) that
 * take precedence over the agent definition's own frontmatter.
 */
export interface PersonaExplicitOverrides {
	model?: string;
	thinking?: string;
	tools?: readonly string[];
}

/** Durable persona + toggle state captured by {@link SessionToolPolicy.snapshot}. */
export interface PolicySnapshot {
	persona: {
		agent: DiscoveredAgent;
		explicit: PersonaExplicitOverrides;
		grant: ReadonlySet<string> | null;
		spawnsBroken: boolean;
	} | null;
	sessionToggles: Map<string, boolean>;
}

/**
 * Single source of truth for what a session may do right now.
 * Layers: registry ∩ cliGrant ∩ sessionToggles ∩ personaGrant.
 * Mutators restricted to PersonaRuntime + session-level toggle APIs.
 *
 * Replaces 16 shadow fields + 3 apply sequences + 4 task-suppression copies +
 * 4 LSP/Hub lift copies with one layered intersect: 12+ codex P1 fixes across
 * 25 review waves were all copy-divergence between parallel persona/shadow
 * state — a single policy object makes that bug class structurally impossible.
 */
/**
 * Whether a persona's declared `spawns` frontmatter permits spawning at all.
 * Declared-but-unknown agent names are NOT validated here (upstream-consistent
 * don't-validate convention): only a declared-and-empty list disables spawns.
 */
function spawnsUsable(spawns: string[] | "*"): boolean {
	return spawns === "*" || spawns.length > 0;
}

export class SessionToolPolicy {
	// Durable at construction
	/** From options.toolNames; null = no CLI grant. */
	readonly cliGrant: ReadonlySet<string> | null;
	/** options.lspReadOnly ?? restrictToolNames (preserves restricted-session default). */
	readonly cliLspReadOnly: boolean;

	// Live state (mutated by PersonaRuntime + session-level toggles only)
	#globalRegistry: () => ReadonlySet<string>; // getter into ToolSession registry (live, not snapshot)
	#persona: {
		agent: DiscoveredAgent;
		explicit: PersonaExplicitOverrides;
		/**
		 * `agent.tools` when declared (with `task` stripped if the persona cannot
		 * spawn), or `null` when frontmatter omits `tools:` — meaning "every
		 * registered tool", evaluated live so MCP/extension tools registered after
		 * the persona activated remain grantable. Never a frozen registry copy.
		 */
		grant: ReadonlySet<string> | null;
		/** Declared spawns that cannot spawn (e.g. `spawns: []`) — `task` stays off even under a null (registry-wide) grant. */
		spawnsBroken: boolean;
	} | null;
	#sessionToggles: Map<string, boolean>; // sparse-delta; !has = default
	#isDefaultActive: (name: string) => boolean;

	constructor(options: {
		toolNames?: readonly string[]; // raw CLI grant
		restrictToolNames?: boolean; // whether CLI grant restricts
		lspReadOnly?: boolean;
		registry: () => ReadonlySet<string>; // ToolSession registry getter
		isDefaultActive: (name: string) => boolean; // registry tool defaultActive metadata
	}) {
		this.cliGrant = options.toolNames ? new Set(options.toolNames) : null;
		this.cliLspReadOnly = options.lspReadOnly ?? options.restrictToolNames ?? false;
		this.#globalRegistry = options.registry;
		this.#isDefaultActive = options.isDefaultActive;
		this.#persona = null;
		this.#sessionToggles = new Map();
	}

	// Pure derivations — every read recomputes; no caching; no side effects
	effective(name: string): boolean {
		return (
			this.#globalRegistry().has(name) &&
			(this.cliGrant === null || this.cliGrant.has(name)) &&
			this.#toggledOnOrDefault(name) &&
			(this.#persona === null || this.#persona.grant === null || this.#persona.grant.has(name)) &&
			!(this.#persona?.spawnsBroken === true && name === "task")
		);
	}

	isPersonaActive(): boolean {
		return this.#persona !== null;
	}

	/** Persona with a declared-but-unusable `spawns` frontmatter is NEVER spawnable, regardless of its `tools:` field. */
	spawnable(): boolean {
		const spawns = this.#persona?.agent.spawns;
		if (spawns !== undefined && !spawnsUsable(spawns)) {
			return false;
		}
		return this.effective("task");
	}

	/** True when any layer narrows the default capability envelope. */
	isRestricted(): boolean {
		// Size-comparison against the registry is unsound: a cliGrant with unknown
		// names (size >= registry) can still omit default-active tools, and a
		// sessionToggle that only ADDS a tool is not a restriction. Restriction =
		// some default-active registered tool is not effective.
		if (this.#persona !== null) return true;
		for (const name of this.#globalRegistry()) {
			if (this.#isDefaultActive(name) && !this.effective(name)) return true;
		}
		return false;
	}

	/** cliLspReadOnly is durable; the derivation covers persona-narrowed sessions. */
	lspReadOnly(): boolean {
		return this.cliLspReadOnly || (!this.effective("write") && !this.effective("edit"));
	}

	hubEnabled(): boolean {
		return this.effective("hub");
	}

	mutating(): boolean {
		return this.effective("write") || this.effective("edit") || this.effective("bash");
	}

	/**
	 * The full effective grant: intersection of every layer across the
	 * currently-registered tools. Consumers (subagent spawn inheritance) use it
	 * to cap child tool lists at what this session itself may run.
	 */
	effectiveSet(): ReadonlySet<string> {
		const grant = new Set<string>();
		for (const name of this.#globalRegistry()) {
			if (this.effective(name)) grant.add(name);
		}
		return grant;
	}

	// Mutators (PersonaRuntime + session toggles ONLY)
	enterPersona(agent: DiscoveredAgent, explicit: PersonaExplicitOverrides): void {
		this.#persona = {
			agent,
			explicit,
			grant: this.#computePersonaGrant(agent),
			spawnsBroken: agent.spawns !== undefined && !spawnsUsable(agent.spawns),
		};
	}

	exitPersona(): void {
		this.#persona = null;
	}

	setSessionToolEnabled(name: string, on: boolean): void {
		this.#sessionToggles.set(name, on);
	}

	snapshot(): PolicySnapshot {
		return {
			persona: this.#persona
				? {
						...this.#persona,
						grant: this.#persona.grant ? new Set(this.#persona.grant) : null,
					}
				: null,
			sessionToggles: new Map(this.#sessionToggles),
		};
	}

	restore(snapshot: PolicySnapshot): void {
		this.#persona = snapshot.persona
			? {
					...snapshot.persona,
					grant: snapshot.persona.grant ? new Set(snapshot.persona.grant) : null,
				}
			: null;
		this.#sessionToggles = new Map(snapshot.sessionToggles);
	}

	#toggledOnOrDefault(name: string): boolean {
		return this.#sessionToggles.get(name) ?? this.#isDefaultActive(name);
	}
	/**
	 * Persona grant: declared `agent.tools` (with `task` stripped when the persona
	 * declares a spawns policy that cannot spawn — an explicit `tools:[...,task]`
	 * with `spawns: []` still cannot spawn, so advertising `task` would promise a
	 * tool that fails every invocation). When `tools:` is omitted the grant is
	 * `null` = "every registered tool", evaluated live so tools registered after
	 * activation remain grantable.
	 */
	#computePersonaGrant(agent: DiscoveredAgent): ReadonlySet<string> | null {
		const declared = agent.tools;
		const spawnsBroken = agent.spawns !== undefined && !spawnsUsable(agent.spawns);
		if (declared === undefined) return null;
		const grant = new Set(declared);
		if (spawnsBroken) grant.delete("task");
		return grant;
	}
}
