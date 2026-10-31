/**
 * Process-wide native rendering state, set only by the native backend.
 *
 * Whether a Tern Surface Protocol backend is rendering: components that
 * animate by re-rendering on a timer (spinners, shimmer, thinking frames,
 * countdowns) check it and skip scheduling, because the terminal clocks
 * motion from the described nodes. Set when a surface opens and cleared when
 * it closes.
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

/**
 * Whether the live terminal draws the `button` kind (its `hello` lists it),
 * and with it `tabs` `variant: "segmented"`. The button builders
 * (`native/overlay.ts`) read it; older Terns get the `row` buttons they style
 * by role. Set only by the native backend from the `hello` it adopts; false
 * while no surface is live.
 */
let buttons = false;

/** Whether omp's buttons go out as `button` nodes (see {@link setNativeButtons}). */
export function nativeButtons(): boolean {
	return buttons;
}

/** Called by the native backend when it adopts a `hello` reply and when it stops. */
export function setNativeButtons(on: boolean): void {
	buttons = on;
}

/** Call `listener` whenever native rendering starts or stops; returns the unsubscribe. */
export function onNativeRenderingChange(listener: (on: boolean) => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}
