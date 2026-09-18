import { randomUUID } from "node:crypto";
import { RLM_DEFAULT_SPILL_BYTES, RlmStore } from "./store";
import { appendRlmRuntimeGuide } from "./guide";

/**
 * Host surface for RLM store binding. Prefer stable runtime ids over cwd.
 * `rlmStore` is the session-owned instance when the host attaches one.
 */
export interface RlmSessionHost {
	cwd: string;
	settings: {
		get(path: string): unknown;
	};
	sessionManager?: { getSessionId?: () => string | undefined };
	/** Session-owned store when present (preferred over process map). */
	rlmStore?: RlmStore;
	/** Stable id for this agent runtime (eval kernel owner, agent id, etc.). */
	getRlmRuntimeId?: () => string | null | undefined;
	getEvalKernelOwnerId?: () => string | null | undefined;
	getAgentId?: () => string | null | undefined;
	getSessionId?: () => string | null | undefined;
}

/** Process registry keyed only by true runtime ids — never cwd. */
const stores = new Map<string, RlmStore>();
/** Ephemeral runtime ids for hosts that lack every other identity (tests). */
const ephemeralIds = new WeakMap<object, string>();

export type ContextEngine = "native" | "rlm";

/**
 * Resolve a stable runtime key. **Never** falls back to `cwd` alone (would collide
 * concurrent agents in the same directory).
 */
export function rlmSessionKey(session: RlmSessionHost): string {
	const candidates = [
		session.getRlmRuntimeId?.(),
		session.getEvalKernelOwnerId?.(),
		session.getSessionId?.(),
		session.sessionManager?.getSessionId?.(),
		session.getAgentId?.(),
	];
	for (const c of candidates) {
		if (typeof c === "string" && c.length > 0) return `rlm:${c}`;
	}
	// Last resort: per-object ephemeral UUID (tests / incomplete hosts).
	let id = ephemeralIds.get(session as object);
	if (!id) {
		id = `ephemeral:${randomUUID()}`;
		ephemeralIds.set(session as object, id);
	}
	return `rlm:${id}`;
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
 */
export function rlmIsExclusiveEngine(session: Pick<RlmSessionHost, "settings">): boolean {
	return getContextEngine(session) === "rlm" || session.settings.get("rlm.enabled") === true;
}

function createStoreFromSettings(session: RlmSessionHost): RlmStore {
	return new RlmStore({
		maxDepth: Number(session.settings.get("rlm.maxDepth") ?? 0),
		maxCalls: Number(session.settings.get("rlm.maxCalls") ?? 32),
		maxTotalTokens: Number(session.settings.get("rlm.maxTotalTokens") ?? 1_000_000),
		maxCost: Number(session.settings.get("rlm.maxCost") ?? 0),
		wallClockMs: Number(session.settings.get("rlm.wallClockMs") ?? 0),
	});
}

/**
 * Return the session-owned RLM store. Prefers `session.rlmStore` when set;
 * otherwise creates one and attaches it to the host when the field is writable.
 */
export function getRlmStore(session: RlmSessionHost): RlmStore {
	if (session.rlmStore && !session.rlmStore.disposed) {
		return session.rlmStore;
	}
	const key = rlmSessionKey(session);
	let store = stores.get(key);
	if (!store || store.disposed) {
		store = createStoreFromSettings(session);
		stores.set(key, store);
	}
	// Attach for direct session ownership when the host object allows it.
	try {
		(session as { rlmStore?: RlmStore }).rlmStore = store;
	} catch {
		/* frozen host */
	}
	return store;
}

/** Dispose the store for this session (AgentSession.dispose path). */
export function disposeRlmStore(session: RlmSessionHost): void {
	const attached = session.rlmStore;
	if (attached) {
		attached.dispose("session-dispose");
		try {
			(session as { rlmStore?: RlmStore }).rlmStore = undefined;
		} catch {
			/* */
		}
	}
	const key = rlmSessionKey(session);
	const mapped = stores.get(key);
	if (mapped) {
		if (!mapped.disposed) mapped.dispose("session-dispose");
		stores.delete(key);
	}
}

/** Test-only. Production compaction must never call this. */
export function resetRlmStoresForTest(): void {
	for (const store of stores.values()) {
		if (!store.disposed) store.dispose("test-reset");
	}
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
 * Optional sub-model id for query/subcall. null → session active model
 * (wired by host via `ToolSession.rlmComplete`).
 */
export function rlmSubModel(session: Pick<RlmSessionHost, "settings">): string | null {
	const value = session.settings.get("rlm.subModel");
	return typeof value === "string" && value.length > 0 ? value : null;
}

/** When true, hosts may inject read-only RLM helpers into the session kernel. */
export function rlmKernelBindEnabled(session: Pick<RlmSessionHost, "settings">): boolean {
	return session.settings.get("rlm.kernelBind") === true;
}
