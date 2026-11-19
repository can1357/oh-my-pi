/**
 * Shared contract between the {@link module-timer} preload and {@link logger}'s
 * timing tree. Kept in its own dependency-free module so the preload can import
 * it without pulling in winston (via logger) and the logger can drain the buffer
 * without importing the Bun-plugin preload.
 */

export interface ModuleLoadEvent {
	/** Absolute or Bun-resolved module path. */
	path: string;
	/** `performance.now()` timestamp captured at Bun `onLoad` entry. */
	start: number;
	/** Inclusive module window: `onLoad` entry → appended final marker. */
	durationMs: number;
	/** Own top-level body / TLA time: prepended body marker → appended final marker. */
	bodyMs?: number;
	/** Resolved static children imported by this module. */
	imports: string[];
}

/**
 * Registry-global key under which the preload accumulates module-load events.
 * `Symbol.for` so both modules resolve the same symbol independently.
 */
const KEY: symbol = Symbol.for("omp.moduleLoadBuffer");

type Store = Record<symbol, ModuleLoadEvent[] | undefined>;

/** The append-only buffer the preload pushes into (created on first access). */
export function moduleLoadBuffer(): ModuleLoadEvent[] {
	const store = globalThis as unknown as Store;
	let buffer = store[KEY];
	if (!buffer) {
		buffer = [];
		store[KEY] = buffer;
	}
	return buffer;
}

/** Drain and return all buffered events, leaving the buffer empty. */
export function drainModuleLoadEvents(): ModuleLoadEvent[] {
	const store = globalThis as unknown as Store;
	const buffer = store[KEY];
	if (!buffer || buffer.length === 0) return [];
	store[KEY] = [];
	return buffer;
}
