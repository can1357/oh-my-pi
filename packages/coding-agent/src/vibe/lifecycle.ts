import { type } from "@oh-my-pi/omptype";
import { type VibeCli } from "@oh-my-pi/pi-tui/tools/vibe";
/**
 * Vibe session lifecycle vocabulary: the persisted `vibe-session-lifecycle`
 * custom-entry schema and its parser.
 *
 * Deliberately a leaf module — it is consumed by persisted-roster scanning
 * ([`persistedVibeChildIds`] via `registry/persisted-agents`), which sits on
 * the internal-URL resolution path. Importing `vibe/runtime` from there would
 * drag the task executor and SDK into the render-utils module cycle.
 */

/** Custom-entry type tag for persisted Vibe lifecycle events. */
export const VIBE_LIFECYCLE_CUSTOM_TYPE = "vibe-session-lifecycle";
/** Schema version for persisted Vibe lifecycle events. */
export const VIBE_LIFECYCLE_VERSION = 1;

export type VibeTombstoneReason = "explicit-kill" | "mode-exit" | "spawn-failed" | "unrecoverable";

export interface VibeLifecycleBase {
	version: typeof VIBE_LIFECYCLE_VERSION;
	id: string;
	ownerId: string;
	parentSessionId: string;
}

export interface VibeSpawnLifecycleEvent extends VibeLifecycleBase {
	action: "spawn";
	cli: VibeCli;
	agent: string;
	childSessionFile: string;
	createdAt: number;
}

export interface VibeTurnLifecycleEvent extends VibeLifecycleBase {
	action: "turn-started" | "turn-settled";
	turn: number;
}

export interface VibeTombstoneLifecycleEvent extends VibeLifecycleBase {
	action: "tombstone";
	reason: VibeTombstoneReason;
}

export interface VibeTombstoneRevocationEvent extends VibeLifecycleBase {
	action: "tombstone-revoked";
	reason: "mode-exit";
}

export type VibeLifecycleEvent =
	| VibeSpawnLifecycleEvent
	| VibeTurnLifecycleEvent
	| VibeTombstoneLifecycleEvent
	| VibeTombstoneRevocationEvent;

function objectRecord(value: unknown): Record<string, unknown> | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	return value as Record<string, unknown>;
}

const lifecycleBase = {
	"+": "delete",
	version: type.unit(VIBE_LIFECYCLE_VERSION),
	id: "string > 0",
	ownerId: "string > 0",
	parentSessionId: "string > 0",
} as const;

const LifecycleEvent = type({
	...lifecycleBase,
	action: "'spawn'",
	cli: "'fast' | 'good'",
	agent: "string",
	childSessionFile: "string",
	createdAt: "number",
})
	.or({ ...lifecycleBase, action: "'turn-started' | 'turn-settled'", turn: "number.integer >= 1" })
	.or({
		...lifecycleBase,
		action: "'tombstone'",
		reason: "'explicit-kill' | 'mode-exit' | 'spawn-failed' | 'unrecoverable'",
	})
	.or({ ...lifecycleBase, action: "'tombstone-revoked'", reason: "'mode-exit'" });

/** Parse one persisted lifecycle payload; `undefined` for foreign/malformed data. */
export function parseLifecycleEvent(value: unknown): VibeLifecycleEvent | undefined {
	const event = LifecycleEvent(value);
	return event instanceof type.errors ? undefined : event;
}

/** Child ids claimed by valid Vibe spawn records from untrusted persisted JSON. */
export function persistedVibeChildIds(entries: Iterable<unknown>): Set<string> {
	const ids = new Set<string>();
	for (const value of entries) {
		const entry = objectRecord(value);
		if (entry?.type !== "custom" || entry.customType !== VIBE_LIFECYCLE_CUSTOM_TYPE) continue;
		const event = parseLifecycleEvent(entry.data);
		if (
			event?.action === "spawn" &&
			/^[A-Za-z0-9_-]+$/.test(event.id) &&
			event.childSessionFile === `${event.id}.jsonl`
		) {
			ids.add(event.id);
		}
	}
	return ids;
}
