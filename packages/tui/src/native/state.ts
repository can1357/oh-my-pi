/**
 * Process-wide flag: a Tern Surface Protocol backend is rendering.
 *
 * Components that animate by re-rendering on a timer (spinners, shimmer,
 * thinking frames, countdowns) check it and skip scheduling, because the
 * terminal clocks motion from the described nodes. Set only by the native
 * backend when a surface opens and cleared when it closes.
 */
let active = false;
const listeners = new Set<(on: boolean) => void>();

/** Whether a TSP surface is live in this process. */
export function isNativeRendering(): boolean {
	return active;
}

/** Called by the native backend on surface open and close. */
export function setNativeRendering(on: boolean): void {
	if (active === on) return;
	active = on;
	for (const listener of listeners) listener(on);
}

/** Call `listener` whenever native rendering starts or stops; returns the unsubscribe. */
export function onNativeRenderingChange(listener: (on: boolean) => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}
