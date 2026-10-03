/**
 * Decorative motion with no knob of its own — the status-line speculation blink and the brand
 * fade — behind one switch the host's `tui.motion` preset drives. Enabled by default (the
 * historical behaviour); `reduced` and `none` turn it off so a quiet pane is quiet.
 */

let enabled = true;
const listeners = new Set<(enabled: boolean) => void>();

/** Whether decorative one-off motion (blink, fade) may run. */
export function motionEffectsEnabled(): boolean {
	return enabled;
}

/** Enable or disable decorative motion for every consumer; listeners stop in-flight timers at once. */
export function setMotionEffects(next: boolean): void {
	if (next === enabled) return;
	enabled = next;
	for (const listener of listeners) listener(next);
}

/** Observe switch changes (for consumers that own a timer); returns the unsubscribe. */
export function onMotionEffectsChange(listener: (enabled: boolean) => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}
