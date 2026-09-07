import { expandExecToolShorthand, normalizeToolNames } from "../tools/builtin-names";

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
		/** `null` = registry-wide (frontmatter omits `tools:`); an EMPTY set = deny-all — never collapsed to `null`. */
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
		 * the persona activated remain grantable. NEVER a frozen registry copy —
		 * and never the empty-grant→null collapse: a declared-but-empty (or
		 * fully-intersected-away) grant is an EMPTY set = deny-all, not `null`.
		 */
		grant: ReadonlySet<string> | null;
		/** Declared spawns that cannot spawn (e.g. `spawns: []`) — `task` stays off even under a null (registry-wide) grant. */
		spawnsBroken: boolean;
	} | null;
	// Sparse-delta layer captured and reinstated by snapshot()/restore() so a
	// rolled-back switch restores the pre-switch toggle state byte-for-byte.
	// Live tool activation/deactivation flows through the granted() funnel (the
	// PERMISSION question) rather than mutating this layer — the toggles map is
	// policy-owned transaction state, not a user-input mirror.
	#sessionToggles: Map<string, boolean>;
	#isDefaultActive: (name: string) => boolean;

	constructor(options: {
		toolNames?: readonly string[]; // raw CLI grant
		restrictToolNames?: boolean; // whether CLI grant restricts
		lspReadOnly?: boolean;
		registry: () => ReadonlySet<string>; // ToolSession registry getter
		isDefaultActive: (name: string) => boolean; // registry tool defaultActive metadata
	}) {
		// Legacy aliases (`search` → `grep`, `find` → `glob`) normalize here: the
		// grant drives effective() and the persona explicit.tools intersect, so
		// a raw alias would silently strip the canonical name.
		this.cliGrant = options.toolNames ? new Set(normalizeToolNames(options.toolNames)) : null;
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
	/**
	 * The PERMISSION question for presentation/toggle funnels — personaGrant when
	 * a persona is active, else everything. The CLI whitelist deliberately does
	 * NOT narrow this gate: `toolNames`-only sessions keep the legacy presentation
	 * behavior (a runtime caller may still surface `write` for the xd:// transport
	 * upgrade — the transport write is a presentation-level feature ON the
	 * whitelist, not a filesystem grant), while a persona's declared `tools:` is
	 * a real restriction the funnel must respect. `/mcp` toggles and RPC
	 * activations pass through freely so a `defaultInactive` tool can be turned
	 * ON (the toggles layer answers "on by default", not "may it run").
	 */
	granted(name: string): boolean {
		if (this.#persona === null) return true;
		return (
			(this.#persona.grant === null || this.#persona.grant.has(name)) &&
			!(this.#persona.spawnsBroken === true && name === "task")
		);
	}

	isPersonaActive(): boolean {
		return this.#persona !== null;
	}

	/** cliLspReadOnly is durable; the derivation covers persona-narrowed sessions. */
	lspReadOnly(): boolean {
		return this.cliLspReadOnly || (!this.effective("write") && !this.effective("edit"));
	}

	hubEnabled(): boolean {
		return this.effective("hub");
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
	/**
	 * The effective set computed IGNORING the persona layer: registry ∩
	 * cliGrant ∩ sessionToggles. Spawn inheritance uses this baseline instead
	 * of {@link effectiveSet}: the persona layer scopes the main agent's own
	 * behavior; it does not cage spawned descendants. Children are bounded by
	 * the ORIGINAL main's restriction state (CLI grant ∩ session toggles)
	 * plus their own frontmatter.
	 */
	baselineEffectiveSet(): ReadonlySet<string> {
		const grant = new Set<string>();
		for (const name of this.#globalRegistry()) {
			if (this.#baselineEffective(name)) grant.add(name);
		}
		return grant;
	}

	/**
	 * True when cliGrant or sessionToggles narrow the default capability
	 * envelope — the persona layer is deliberately excluded, so a persona-active
	 * session with an unrestricted baseline is NOT baseline-restricted.
	 */
	isBaselineRestricted(): boolean {
		// Restriction = some default-active registered tool is not
		// baseline-effective (a size-comparison against the registry is unsound:
		// a cliGrant with unknown names can still omit default-active tools, and
		// a sessionToggle that only ADDS a tool is not a restriction).
		for (const name of this.#globalRegistry()) {
			if (this.#isDefaultActive(name) && !this.#baselineEffective(name)) return true;
		}
		return false;
	}

	// Mutators (PersonaRuntime + session toggles ONLY)
	enterPersona(agent: DiscoveredAgent, explicit: PersonaExplicitOverrides): void {
		this.#persona = {
			agent,
			explicit,
			grant: this.#computePersonaGrant(agent, explicit),
			spawnsBroken: agent.spawns !== undefined && !spawnsUsable(agent.spawns),
		};
	}

	exitPersona(): void {
		this.#persona = null;
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
		// An explicit CLI grant of a defaultInactive tool IS its activation: the
		// user named it on the command line, which is a stronger statement than
		// the registry's default. Session toggles still override both ways.
		if (this.#sessionToggles.has(name)) return this.#sessionToggles.get(name)!;
		return this.#isDefaultActive(name) || (this.cliGrant !== null && this.cliGrant.has(name));
	}
	/** Baseline layer of {@link effective}: registry ∩ cliGrant ∩ sessionToggles — persona grant/spawnsBroken conjuncts removed. */
	#baselineEffective(name: string): boolean {
		return (this.cliGrant === null || this.cliGrant.has(name)) && this.#toggledOnOrDefault(name);
	}
	/**
	 * Persona grant: declared `agent.tools` (with `exec` expanded to its
	 * concrete tools — fr-vW — and `task` added when the persona declares a
	 * usable spawns list, fo80e; `task` is stripped again when the
	 * spawns policy cannot spawn — an explicit `tools:[...,task]` with
	 * `spawns: []` still cannot spawn, so advertising `task` would promise a
	 * tool that fails every invocation). When `tools:` is omitted the grant is
	 * `null` = "every registered tool", evaluated live so tools registered after
	 * the persona activated remain grantable.
	 *
	 * `explicit.tools` intersects on top when present. It is the CLI `--tools`
	 * grant at launch, and — critically — the DURABLE grant carried through
	 * resume: on resume there is no CLI flag, so the persisted explicit list is
	 * the only remaining launch-time narrowing and the persona must not widen
	 * past it (foy5e: without this, tools outside the explicit grant became
	 * effective after a resume).
	 */
	#computePersonaGrant(agent: DiscoveredAgent, explicit: PersonaExplicitOverrides): ReadonlySet<string> | null {
		const declared = agent.tools;
		const spawnsBroken = agent.spawns !== undefined && !spawnsUsable(agent.spawns);
		if (declared === undefined && explicit.tools === undefined) return null;
		// The intersect target: the persona's declared tools, or — when the
		// frontmatter omits `tools:` — the CLI grant. On RESUME there is no CLI
		// flag (cliGrant null), so `explicit.tools` (the persisted launch grant)
		// is the ONLY remaining narrowing: it becomes the grant directly rather
		// than intersecting an unrestricted set down to nothing. `exec` expands
		// through the shared shorthand rule (fr-vW) BEFORE the grant is stored so
		// effective()/granted() only ever see concrete tool names.
		const declaredOrInherited =
			declared !== undefined ? expandExecToolShorthand(declared) : [...(this.cliGrant ?? explicit.tools ?? [])];
		const grant = new Set(declaredOrInherited);

		// fo80e: a persona that declares a usable spawns list needs `task` to
		// make that policy usable — mirror the executor's child derivation
		// (deriveChildToolNames): auto-add `task` for declared-and-non-empty
		// (or "*") spawns unless already present. The add is bounded by the
		// inherited base below: when `explicit.tools` (the persisted launch
		// grant on resume) never included `task`, resurrecting it through the
		// auto-add would widen the session past its original CLI grant.
		// spawnsBroken (declared-empty) strips it after; unknown spawn names
		// still auto-add (upstream don't-validate convention).
		const inheritedBase = declared === undefined ? (this.cliGrant ?? new Set(explicit.tools ?? [])) : undefined;
		const baseGrantsTask = inheritedBase === undefined || inheritedBase.has("task");
		if (agent.spawns !== undefined && spawnsUsable(agent.spawns) && !grant.has("task")) {
			// Bounded by the inherited base: when the launch grant (CLI or the
			// persisted explicit.tools on resume) never included `task`, the
			// auto-add must not resurrect it past the session's original ceiling.
			if (baseGrantsTask) grant.add("task");
		}
		if (spawnsBroken) grant.delete("task");
		if (explicit.tools && declared !== undefined) {
			// Both layers present: intersect (never widen). The persisted
			// explicit.tools can carry legacy aliases (raw `--tools search`
			// persists verbatim); normalize before intersecting so the canonical
			// name survives.
			const explicitSet = new Set(normalizeToolNames(explicit.tools));
			for (const name of grant) {
				if (!explicitSet.has(name)) grant.delete(name);
			}
		}
		// An empty grant stays an EMPTY SET (deny-all): collapsing it to `null`
		// would widen it back to "every registered tool" and silently grant
		// everything. Only an OMITTED `tools:` frontmatter (with no other
		// narrowing source) is registry-wide.
		return grant;
	}
}
