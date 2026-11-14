/**
 * Settings declared by this domain (see `config/registry.ts`). Declaration order is the
 * settings-panel order; `config/all-settings.ts` registers every domain.
 */
import { register } from "../config/registry";

// Supermemory (https://supermemory.ai). The API key, origin and namespace override are deliberately not settings:
// they come from SUPERMEMORY_API_KEY / SUPERMEMORY_BASE_URL / SUPERMEMORY_NAMESPACE only (see supermemory/config.ts).

export const cfgSupermemoryScoping = register({
	id: "supermemory.scoping",
	type: "enum",
	values: ["global", "per-project"] as const,
	default: "per-project",
	ui: {
		tab: "memory",
		group: "Supermemory",
		label: "Supermemory Scoping",
		description:
			"global = one namespace for every project; per-project = one namespace per repository (SUPERMEMORY_NAMESPACE overrides both)",
		options: [
			{
				value: "global",
				label: "Global",
				description: "One shared namespace — every project sees the same memories",
			},
			{
				value: "per-project",
				label: "Per project",
				description: "One namespace per repository (shared by its worktrees), keyed by an opaque hash",
			},
		],
		condition: "supermemoryActive",
	},
});

export const cfgSupermemoryAutoRecall = register({
	id: "supermemory.autoRecall",
	type: "boolean",
	default: true,
	ui: {
		tab: "memory",
		group: "Supermemory",
		label: "Supermemory Auto Recall",
		description: "Recall profile and memories on the first turn of each session",
		condition: "supermemoryActive",
	},
});

export const cfgSupermemoryRecallEveryTurn = register({
	id: "supermemory.recallEveryTurn",
	type: "boolean",
	default: false,
	ui: {
		tab: "memory",
		group: "Supermemory",
		label: "Supermemory Recall Every Turn",
		description:
			"Re-run auto recall on each user turn, replacing the previous block (changes the system prompt each turn)",
		condition: "supermemoryActive",
	},
});

export const cfgSupermemoryAutoRetain = register({
	id: "supermemory.autoRetain",
	type: "boolean",
	default: true,
	ui: {
		tab: "memory",
		group: "Supermemory",
		label: "Supermemory Auto Retain",
		description: "Store the conversation every N user turns",
		condition: "supermemoryActive",
	},
});

/** Clamped to 1..100 by `loadSupermemoryConfig`. */
export const cfgSupermemoryRetainEveryNTurns = register({
	id: "supermemory.retainEveryNTurns",
	type: "number",
	default: 3,
});

/** Clamped to 1..50 by `loadSupermemoryConfig`. */
export const cfgSupermemoryRecallLimit = register({ id: "supermemory.recallLimit", type: "number", default: 8 });

/** Minimum similarity, clamped to 0..1 by `loadSupermemoryConfig`. */
export const cfgSupermemoryThreshold = register({ id: "supermemory.threshold", type: "number", default: 0.5 });

export const cfgSupermemorySearchMode = register({
	id: "supermemory.searchMode",
	type: "enum",
	values: ["hybrid", "memories"] as const,
	default: "hybrid",
});
