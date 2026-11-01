import type { BeamMemoryState } from "./types";

/**
 * The scope that facts derived from a stored memory should inherit: facts are
 * never more visible than the memory they were extracted from. The source may
 * be a working-memory row or an episode row (consolidation output). A missing
 * source row (forgotten before the async extraction ran) falls back to the
 * conservative 'session'.
 */
const STANDARD_SCOPE_RANK: Record<string, number> = { session: 0, channel: 1, global: 2 };

export function sourceMemoryScope(beam: BeamMemoryState, memoryId: string): string {
	const wm = beam.db.query("SELECT scope FROM working_memory WHERE id = ?").get(memoryId) as
		| { scope: string | null }
		| null;
	const ep = beam.db.query("SELECT scope FROM episodic_memory WHERE id = ?").get(memoryId) as
		| { scope: string | null }
		| null;
	// An untyped id present in BOTH tiers is ambiguous: a fact must never be
	// wider than either candidate source, so combine conservatively (the
	// narrower standard scope wins; an unrecognizable mix is most
	// restrictive). A working-first pick would let an episode-derived fact
	// inherit the unrelated working row's visibility.
	if (wm !== null && ep !== null) {
		const a = typeof wm.scope === "string" && wm.scope.length > 0 ? wm.scope : "session";
		const b = typeof ep.scope === "string" && ep.scope.length > 0 ? ep.scope : "session";
		if (a === b) return a;
		const ra = STANDARD_SCOPE_RANK[a];
		const rb = STANDARD_SCOPE_RANK[b];
		if (ra !== undefined && rb !== undefined) return ra <= rb ? a : b;
		return "session";
	}
	const wmScope = wm?.scope;
	if (typeof wmScope === "string" && wmScope.length > 0) return wmScope;
	const epScope = ep?.scope;
	return typeof epScope === "string" && epScope.length > 0 ? epScope : "session";
}
