/**
 * Decorative motion with no knob of its own — the status-line blink and brand fade, the editor's
 * magic-keyword sweep, native `fx` spans — behind one switch the host's `tui.motion` preset drives.
 */

let enabled = true;
const listeners = new Set<() => void>();

/** Whether decorative motion may run. */
export function motionEffectsEnabled(): boolean {
	return enabled;
}

/** Enable or disable decorative motion. Timer-driven effects stop at their next frame. */
export function setMotionEffects(next: boolean): void {
	if (next === enabled) return;
	enabled = next;
	for (const listener of listeners) listener();
}

/** Observe switch flips, for output nothing would otherwise re-describe; returns the unsubscribe. */
export function onMotionEffectsChange(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}
