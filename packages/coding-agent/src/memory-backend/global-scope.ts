import type { ScopeLike } from "../config/registry";
import { cfgHindsightScoping } from "../hindsight/settings";
import { cfgMnemopiScoping } from "../mnemopi/settings";
import { cfgMemoryBackend } from "./settings";

/** Where `retain`/`learn` store an item: the active project's scope, or the scope every project recalls. */
export type MemoryWriteScope = "project" | "global";

/**
 * Whether `retain`/`learn` can take `scope: "global"`: the active backend must have a destination that every
 * project recalls. Mnemopi writes to its shared bank; Hindsight writes untagged memories, which
 * `per-project-tagged` recall surfaces in every project. Both lack such a destination under `per-project`
 * scoping, and the other backends have none at all. Tools hide the option wherever this is false.
 */
export function isGlobalMemoryScopeAvailable(scope: ScopeLike): boolean {
	switch (cfgMemoryBackend.get(scope)) {
		case "mnemopi":
			return cfgMnemopiScoping.get(scope) !== "per-project";
		case "hindsight":
			return cfgHindsightScoping.get(scope) !== "per-project";
		default:
			return false;
	}
}
