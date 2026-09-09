/**
 * Vibe session lifecycle vocabulary: the persisted `vibe-session-lifecycle`
 * custom-entry schema and its parser.
 *
 * Deliberately a leaf module — it is consumed by persisted-roster scanning
 * ([`persistedVibeChildIds`] via `registry/persisted-agents`), which sits on
 * the internal-URL resolution path. Importing `vibe/runtime` from there would
 * drag the task executor and SDK into the render-utils module cycle.
 */

/** The two worker CLI flavors the director drives. */
export type VibeCli = "fast" | "good";

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

/** Parse one persisted lifecycle payload; `undefined` for foreign/malformed data. */
export function parseLifecycleEvent(value: unknown): VibeLifecycleEvent | undefined {
	const data = objectRecord(value);
	if (!data || data.version !== VIBE_LIFECYCLE_VERSION) return undefined;
	if (typeof data.id !== "string" || !data.id) return undefined;
	if (typeof data.ownerId !== "string" || !data.ownerId) return undefined;
	if (typeof data.parentSessionId !== "string" || !data.parentSessionId) return undefined;
	const base: VibeLifecycleBase = {
		version: VIBE_LIFECYCLE_VERSION,
		id: data.id,
		ownerId: data.ownerId,
		parentSessionId: data.parentSessionId,
	};
	if (data.action === "spawn") {
		const cli = data.cli === "fast" || data.cli === "good" ? data.cli : undefined;
		if (!cli || typeof data.agent !== "string" || typeof data.childSessionFile !== "string") return undefined;
		if (typeof data.createdAt !== "number" || !Number.isFinite(data.createdAt)) return undefined;
		return {
			...base,
			action: "spawn",
			cli,
			agent: data.agent,
			childSessionFile: data.childSessionFile,
			createdAt: data.createdAt,
		};
	}
	if (data.action === "turn-started" || data.action === "turn-settled") {
		if (typeof data.turn !== "number" || !Number.isInteger(data.turn) || data.turn < 1) return undefined;
		return { ...base, action: data.action, turn: data.turn };
	}
	if (data.action === "tombstone") {
		const reason = data.reason;
		if (
			reason !== "explicit-kill" &&
			reason !== "mode-exit" &&
			reason !== "spawn-failed" &&
			reason !== "unrecoverable"
		) {
			return undefined;
		}
		return { ...base, action: "tombstone", reason };
	}
	if (data.action === "tombstone-revoked" && data.reason === "mode-exit") {
		return { ...base, action: "tombstone-revoked", reason: "mode-exit" };
	}
	return undefined;
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
