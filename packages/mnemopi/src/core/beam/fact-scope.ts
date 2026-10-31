import type { BeamMemoryState } from "./types";

/**
 * The scope that facts derived from a stored memory should inherit: facts are
 * never more visible than the memory they were extracted from. The source may
 * be a working-memory row or an episode row (consolidation output). A missing
 * source row (forgotten before the async extraction ran) falls back to the
 * conservative 'session'.
 */
export function sourceMemoryScope(beam: BeamMemoryState, memoryId: string): string {
	const wm = beam.db.query("SELECT scope FROM working_memory WHERE id = ?").get(memoryId) as
		| { scope: string | null }
		| null;
	const wmScope = wm?.scope;
	if (typeof wmScope === "string" && wmScope.length > 0) return wmScope;
	const ep = beam.db.query("SELECT scope FROM episodic_memory WHERE id = ?").get(memoryId) as
		| { scope: string | null }
		| null;
	const epScope = ep?.scope;
	return typeof epScope === "string" && epScope.length > 0 ? epScope : "session";
}
