import type { ScopeLike } from "../config/registry";
import type { HindsightSessionState } from "../hindsight/state";
import { cfgMnemopiScoping } from "../mnemopi/settings";
import { cfgMemoryBackend } from "./settings";

/** Where `retain`/`learn` store an item: the active project's scope, or the scope every project recalls. */
export type MemoryWriteScope = "project" | "global";

/** The parts of a tool session that decide whether `scope: "global"` is offered. */
export interface GlobalMemoryScopeSession {
	settings: ScopeLike;
	getHindsightSessionState?: () => HindsightSessionState | undefined;
}

/**
 * Whether `retain`/`learn` can take `scope: "global"`: the active backend must have a destination that every
 * project recalls. Mnemopi writes to its shared bank and lacks one under `per-project` scoping. Hindsight writes
 * untagged memories; whether that is allowed comes from the session's Hindsight state rather than live settings,
 * because the retain queue enforces against that state's config (a subagent alias keeps its parent's snapshot), so the
 * schema never offers a scope the queue rejects. The other backends have no such destination. Tools hide the option
 * wherever this is false.
 */
export function isGlobalMemoryScopeAvailable(session: GlobalMemoryScopeSession): boolean {
	switch (cfgMemoryBackend.get(session.settings)) {
		case "mnemopi":
			return cfgMnemopiScoping.get(session.settings) !== "per-project";
		case "hindsight":
			return session.getHindsightSessionState?.()?.isGlobalRetainAvailable() ?? false;
		default:
			return false;
	}
}
