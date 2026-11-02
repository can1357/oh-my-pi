import { untilAborted } from "@oh-my-pi/pi-utils";
import type { AgentHold } from "./types";

/**
 * Waits until no hold in `holds` holds its model request or tool call: asks
 * every hold, waits for everything they return, and asks them all again,
 * until none returns anything. Rejects when `signal` aborts.
 */
export async function passHolds(holds: readonly AgentHold[], signal: AbortSignal | undefined): Promise<void> {
	for (;;) {
		const pending: Promise<void>[] = [];
		for (const hold of holds) {
			const wait = hold.pending();
			if (wait) pending.push(wait);
		}
		if (pending.length === 0) return;
		await untilAborted(signal, Promise.all(pending));
	}
}

/** Tells every hold in `holds` that its request or call no longer waits on it. */
export function releaseHolds(holds: readonly AgentHold[] | undefined): void {
	if (!holds) return;
	for (const hold of holds) hold.release?.();
}
