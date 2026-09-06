import type { PersonaExplicitOverrides } from "./tool-policy";

/**
 * The persisted `mode_change` payload for an agent-persona session.
 * Kept as `Record<string, unknown>` on the journal entry (ModeChangeEntry.data
 * is untyped); these keys are the persona contract: `name` (required),
 * `explicit` (optional per-invocation overrides carried through resume), and
 * `baseline` (optional pre-persona model/thinking captured at enter time —
 * on resume it is the authoritative exit baseline, so exiting after a resume
 * restores the pre-persona model instead of the persona-produced one, which
 * the model_change journal entries make indistinguishable from a deliberate
 * user pick).
 */
export interface AgentPersonaBaseline {
	/** Model string at enter time ("provider/modelId"); `undefined` = no model. */
	model?: string;
	/** Configured thinking level at enter time; `undefined` = none configured. */
	thinkingLevel?: string;
}

export interface AgentPersonaModeData {
	name: string;
	explicit?: PersonaExplicitOverrides;
	baseline?: AgentPersonaBaseline;
}

/**
 * Serializes the runtime's captured pre-persona baseline for the journal
 * (j2g). The runtime stays pure — callers append the entry — so this helper
 * shapes the `baseline` key the resume reconcile reads back. Returns
 * `undefined` when nothing was captured (e.g. a deferred enter that never
 * applied a model), which the writer omits.
 */
export function serializePersonaBaseline(baseline: {
	model: unknown;
	thinkingLevel: unknown;
}): AgentPersonaBaseline | undefined {
	const model = baseline.model as { provider: string; id: string } | undefined;
	const out: AgentPersonaBaseline = {};
	if (model) out.model = `${model.provider}/${model.id}`;
	if (baseline.thinkingLevel !== undefined) out.thinkingLevel = String(baseline.thinkingLevel);
	return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Mode entries that do not touch the persona. Plan/goal/vibe partition tools
 * temporarily while the persona stays active underneath, so their journal
 * entries (and their paused variants) are skipped when locating the persona
 * identity; only an explicit persona exit (`none`) or an unrecognized mode
 * clears it.
 */
const PERSONA_TRANSPARENT_MODES = new Set(["plan", "plan_paused", "goal", "goal_paused", "vibe"]);

/**
 * Extracts the desired persona from a session journal's LAST agent mode_change
 * entry that is not followed by an explicit persona exit (`none`) — plan/goal/
 * vibe entries in between are transparent (the persona stays active under the
 * mode's temporary partition). Session files are user-editable and survive
 * across versions, so anything that does not match the contract is treated as
 * absent rather than trusted.
 */
export function readPersistedAgentPersona(
	entries: ReadonlyArray<{ type: unknown; mode?: unknown; data?: unknown }>,
): AgentPersonaModeData | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry.type !== "mode_change") continue;
		if (entry.mode === "agent") {
			const data: Record<string, unknown> =
				typeof entry.data === "object" && entry.data !== null ? (entry.data as Record<string, unknown>) : {};
			const name = data.name;
			if (typeof name !== "string" || name.length === 0) return undefined;
			const explicitRaw: unknown = data.explicit;
			let explicit: PersonaExplicitOverrides | undefined;
			if (typeof explicitRaw === "object" && explicitRaw !== null) {
				const explicitSource = explicitRaw as Record<string, unknown>;
				const model = explicitSource.model;
				const thinking = explicitSource.thinking;
				const toolsRaw = explicitSource.tools;
				const candidate: PersonaExplicitOverrides = {
					model: typeof model === "string" ? model : undefined,
					thinking: typeof thinking === "string" ? thinking : undefined,
					tools:
						Array.isArray(toolsRaw) && toolsRaw.every((tool): tool is string => typeof tool === "string")
							? toolsRaw
							: undefined,
				};
				if (Object.keys(candidate).some(key => candidate[key as keyof PersonaExplicitOverrides] !== undefined)) {
					explicit = candidate;
				}
			}
			const baselineRaw: unknown = data.baseline;
			let baseline: AgentPersonaBaseline | undefined;
			if (typeof baselineRaw === "object" && baselineRaw !== null) {
				const baselineSource = baselineRaw as Record<string, unknown>;
				const model = baselineSource.model;
				const thinkingLevel = baselineSource.thinkingLevel;
				const candidate: AgentPersonaBaseline = {
					model: typeof model === "string" ? model : undefined,
					thinkingLevel: typeof thinkingLevel === "string" ? thinkingLevel : undefined,
				};
				if (candidate.model !== undefined || candidate.thinkingLevel !== undefined) baseline = candidate;
			}
			if (explicit || baseline)
				return { name, ...(explicit ? { explicit } : {}), ...(baseline ? { baseline } : {}) };
			return { name };
		}
		if (PERSONA_TRANSPARENT_MODES.has(entry.mode as string)) continue;
		return undefined;
	}
	return undefined;
}
