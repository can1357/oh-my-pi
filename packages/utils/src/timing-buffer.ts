/** Observed wall-clock intervals from the optional Bun development preload, in performance.now() milliseconds. */
export interface ModuleLoadEvent {
	path: string;
	readStart: number;
	readEnd: number;
	/** First instrumented statement through completion, including top-level await. Not CPU time. */
	bodyStart: number;
	bodyEnd: number;
}

export function timingModeIncludes(option: "full" | "modules" | "x"): boolean {
	const value = process.env.PI_TIMING;
	if (!value) return false;
	if (value === option) return true;
	let start = 0;
	for (let i = 0; i <= value.length; i++) {
		const code = i === value.length ? 44 : value.charCodeAt(i);
		const separator = code === 44 || code === 58 || code === 59 || code === 43 || code <= 32;
		if (!separator) continue;
		if (i > start && value.slice(start, i) === option) return true;
		start = i + 1;
	}
	return false;
}

/** Set only by the optional startup preload. Ending ordinary timing needs no plugin import. */
export const STOP_MODULE_LOAD_TIMING = Symbol.for("omp.stopModuleLoadTiming");

export function stopModuleLoadTiming(): void {
	(globalThis as { [STOP_MODULE_LOAD_TIMING]?: () => void })[STOP_MODULE_LOAD_TIMING]?.();
}

const KEY = Symbol.for("omp.moduleLoadBuffer");
type Store = { [KEY]?: ModuleLoadEvent[] };

/** Keep the same queue across drains: the preload holds a reference to it. */
export function moduleLoadBuffer(): ModuleLoadEvent[] {
	return ((globalThis as Store)[KEY] ??= []);
}

export function drainModuleLoadEvents(): ModuleLoadEvent[] {
	return (globalThis as Store)[KEY]?.splice(0) ?? [];
}
