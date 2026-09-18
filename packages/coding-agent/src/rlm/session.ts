import { RLM_DEFAULT_SPILL_BYTES, RlmStore } from "./store";
import { appendRlmRuntimeGuide } from "./guide";

interface RlmSessionHost {
	cwd: string;
	settings: {
		get(path: string): unknown;
	};
	sessionManager?: { getSessionId?: () => string | undefined };
}

const stores = new Map<string, RlmStore>();

export type ContextEngine = "native" | "rlm";

export function rlmSessionKey(session: Pick<RlmSessionHost, "cwd" | "sessionManager">): string {
	return session.sessionManager?.getSessionId?.() ?? session.cwd;
}

export function getContextEngine(session: Pick<RlmSessionHost, "settings">): ContextEngine {
	const engine = session.settings.get("context.engine");
	if (engine === "rlm") return "rlm";
	return "native";
}

/**
 * RLM is opt-in via `rlm.enabled` and/or `context.engine: rlm`.
 * Native remains default.
 */
export function rlmEnabled(session: Pick<RlmSessionHost, "settings">): boolean {
	if (session.settings.get("rlm.enabled") === true) return true;
	return getContextEngine(session) === "rlm";
}

/**
 * RFC exclusive routing: RLM and native compaction engines must not fight over
 * the same corpus on one provider request. Root-chat compaction may still run
 * (stubs are small); the store is never cleared by compaction.
 *
 * When RLM is the selected engine, callers should prefer spill/peek over stuffing
 * full tool bodies. If RLM is unready, fail open to native (caller responsibility).
 */
export function rlmIsExclusiveEngine(session: Pick<RlmSessionHost, "settings">): boolean {
	return getContextEngine(session) === "rlm" || session.settings.get("rlm.enabled") === true;
}

export function getRlmStore(session: RlmSessionHost): RlmStore {
	const key = rlmSessionKey(session);
	let store = stores.get(key);
	if (!store) {
		store = new RlmStore({
			maxDepth: Number(session.settings.get("rlm.maxDepth") ?? 0),
			maxCalls: Number(session.settings.get("rlm.maxCalls") ?? 32),
			maxTotalTokens: Number(session.settings.get("rlm.maxTotalTokens") ?? 1_000_000),
			maxCost: Number(session.settings.get("rlm.maxCost") ?? 0),
			wallClockMs: Number(session.settings.get("rlm.wallClockMs") ?? 0),
		});
		stores.set(key, store);
	}
	return store;
}

/** Test-only. Production compaction must never call this. */
export function resetRlmStoresForTest(): void {
	stores.clear();
}

export function rlmSpillBytes(session: RlmSessionHost): number {
	const value = session.settings.get("rlm.spillBytes");
	return typeof value === "number" ? value : RLM_DEFAULT_SPILL_BYTES;
}

/** Append-only runtime guide; base system prompt array is not rewritten in place. */
export function systemPromptWithRlmGuide(
	base: readonly string[],
	session: Pick<RlmSessionHost, "settings">,
): string[] {
	return appendRlmRuntimeGuide(base, rlmEnabled(session));
}

/**
 * Optional sub-model id for depth-0 llm_query. null/undefined → session active model
 * (wired by host via `ToolSession.rlmComplete`).
 */
export function rlmSubModel(session: Pick<RlmSessionHost, "settings">): string | null {
	const value = session.settings.get("rlm.subModel");
	return typeof value === "string" && value.length > 0 ? value : null;
}
