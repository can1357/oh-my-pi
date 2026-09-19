import type { Settings } from "../config/settings";
import { localBackend } from "./local-backend";
import { offBackend } from "./off-backend";
import type { MemoryBackend } from "./types";
import { withSharpshooter } from "./with-sharpshooter";

/**
 * Pick the active memory backend for a Settings instance.
 *
 * Selection rules (single source of truth — every memory consumer routes
 * through this):
 *   - `memory.backend === "hindsight"`  → Hindsight remote memory
 *   - `memory.backend === "mnemopi"`  → local Mnemopi SQLite memory
 *   - `memory.backend === "sharpshooter"` → friction-gated project decision memory
 *   - `memory.backend === "local"`      → local rollout summary pipeline
 *   - everything else                   → no-op
 *
 * `memories.enabled` remains accepted only as a legacy migration input. Once
 * a config is loaded, `memory.backend` is the sole runtime selector.
 *
 * `sharpshooter.enabled` is the one exception, and it does not select a backend.
 * Sharpshooter distills project decisions rather than storing memories, so it can
 * run beside a store; when the flag is set and the store is not sharpshooter
 * itself, the selected backend is wrapped to run both. The wrapper keeps the
 * store's `id`, so tool gating that reads `memory.backend` is unaffected.
 */
export async function resolveMemoryBackend(settings: Settings): Promise<MemoryBackend> {
	const id = settings.get("memory.backend");
	const selected = await selectMemoryBackend(id);
	if (id === "sharpshooter" || !settings.get("sharpshooter.enabled")) return selected;
	return withSharpshooter(selected);
}

async function selectMemoryBackend(id: string | undefined): Promise<MemoryBackend> {
	if (id === "hindsight") return (await import("../hindsight/backend")).hindsightBackend;
	if (id === "mnemopi") return (await import("../mnemopi/backend")).mnemopiBackend;
	if (id === "sharpshooter") return (await import("../sharpshooter/backend")).sharpshooterBackend;
	if (id === "local") return localBackend;
	return offBackend;
}
