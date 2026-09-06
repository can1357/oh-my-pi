import type { PersonaExplicitOverrides } from "./tool-policy";

/**
 * The persisted `mode_change` payload for an agent-persona session.
 * Kept as `Record<string, unknown>` on the journal entry (ModeChangeEntry.data
 * is untyped); these keys are the persona contract: `name` (required) and
 * `explicit` (optional per-invocation overrides carried through resume).
 */
export interface AgentPersonaModeData {
	name: string;
	explicit?: PersonaExplicitOverrides;
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
			if (typeof explicitRaw !== "object" || explicitRaw === null) return { name };
			const explicitSource = explicitRaw as Record<string, unknown>;
			const model = explicitSource.model;
			const thinking = explicitSource.thinking;
			const toolsRaw = explicitSource.tools;
			const explicit: PersonaExplicitOverrides = {
				model: typeof model === "string" ? model : undefined,
				thinking: typeof thinking === "string" ? thinking : undefined,
				tools:
					Array.isArray(toolsRaw) && toolsRaw.every((tool): tool is string => typeof tool === "string")
						? toolsRaw
						: undefined,
			};
			return Object.keys(explicit).some(key => explicit[key as keyof PersonaExplicitOverrides] !== undefined)
				? { name, explicit }
				: { name };
		}
		if (PERSONA_TRANSPARENT_MODES.has(entry.mode as string)) continue;
		return undefined;
	}
	return undefined;
}
