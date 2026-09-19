import { randomUUID } from "node:crypto";
import { RLM_DEFAULT_SPILL_BYTES, RlmStore } from "./store";
import { RlmRuntime } from "./runtime";
import { appendRlmRuntimeGuide } from "./guide";

/**
 * Host surface for RLM runtime binding. Prefer stable runtime ids over cwd.
 */
export interface RlmSessionHost {
	cwd: string;
	settings: {
		get(path: string): unknown;
	};
	sessionManager?: { getSessionId?: () => string | undefined };
	/** Session-owned store when present (legacy attach). */
	rlmStore?: RlmStore;
	/** Session-owned full runtime (RFC v3 preferred). */
	rlmRuntime?: RlmRuntime;
	getRlmRuntimeId?: () => string | null | undefined;
	getEvalKernelOwnerId?: () => string | null | undefined;
	getAgentId?: () => string | null | undefined;
	getSessionId?: () => string | null | undefined;
}

/** Process registry keyed only by true runtime ids — never cwd. */
const runtimes = new Map<string, RlmRuntime>();
/** Ephemeral runtime ids for hosts that lack every other identity (tests). */
const ephemeralIds = new WeakMap<object, string>();

export type ContextEngine = "native" | "rlm";

/**
 * Resolve a stable runtime key. **Never** falls back to `cwd` alone.
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

export function rlmEnabled(session: Pick<RlmSessionHost, "settings">): boolean {
	if (session.settings.get("rlm.enabled") === true) return true;
	return getContextEngine(session) === "rlm";
}

export function rlmIsExclusiveEngine(session: Pick<RlmSessionHost, "settings">): boolean {
	return getContextEngine(session) === "rlm" || session.settings.get("rlm.enabled") === true;
}

function createRuntimeFromSettings(session: RlmSessionHost): RlmRuntime {
	return new RlmRuntime({
		ownerId: rlmSessionKey(session),
		maxDepth: Number(session.settings.get("rlm.maxDepth") ?? 0),
		maxCalls: Number(session.settings.get("rlm.maxCalls") ?? 32),
		maxTotalTokens: Number(session.settings.get("rlm.maxTotalTokens") ?? 1_000_000),
		maxCost: Number(session.settings.get("rlm.maxCost") ?? 0),
		wallClockMs: Number(session.settings.get("rlm.wallClockMs") ?? 0),
	});
}

function attachRuntime(session: RlmSessionHost, runtime: RlmRuntime): void {
	try {
		(session as { rlmRuntime?: RlmRuntime }).rlmRuntime = runtime;
		(session as { rlmStore?: RlmStore }).rlmStore = runtime.store;
	} catch {
		/* frozen host */
	}
}

/**
 * Return the session-owned {@link RlmRuntime}. Creates and attaches when missing.
 */
export function getRlmRuntime(session: RlmSessionHost): RlmRuntime {
	if (session.rlmRuntime && !session.rlmRuntime.disposed) {
		return session.rlmRuntime;
	}
	if (session.rlmStore && !session.rlmStore.disposed) {
		const runtime = RlmRuntime.fromStore(session.rlmStore, rlmSessionKey(session));
		attachRuntime(session, runtime);
		runtimes.set(rlmSessionKey(session), runtime);
		return runtime;
	}
	const key = rlmSessionKey(session);
	let runtime = runtimes.get(key);
	if (!runtime || runtime.disposed) {
		runtime = createRuntimeFromSettings(session);
		runtimes.set(key, runtime);
	}
	attachRuntime(session, runtime);
	return runtime;
}

/** Back-compat: store accessor delegates to runtime. */
export function getRlmStore(session: RlmSessionHost): RlmStore {
	return getRlmRuntime(session).store;
}

/** Dispose runtime + store for this session (AgentSession.dispose path). */
export function disposeRlmStore(session: RlmSessionHost): void {
	disposeRlmRuntime(session);
}

export function disposeRlmRuntime(session: RlmSessionHost): void {
	const key = rlmSessionKey(session);
	const attached = session.rlmRuntime;
	if (attached) {
		attached.dispose("session-dispose");
		try {
			(session as { rlmRuntime?: RlmRuntime }).rlmRuntime = undefined;
			(session as { rlmStore?: RlmStore }).rlmStore = undefined;
		} catch {
			/* */
		}
	}
	const mapped = runtimes.get(key);
	if (mapped) {
		if (!mapped.disposed) mapped.dispose("session-dispose");
		runtimes.delete(key);
	} else if (session.rlmStore && !session.rlmStore.disposed) {
		session.rlmStore.dispose("session-dispose");
	}
}

/** Test-only. Production compaction must never call this. */
export function resetRlmStoresForTest(): void {
	for (const runtime of runtimes.values()) {
		if (!runtime.disposed) runtime.dispose("test-reset");
	}
	runtimes.clear();
}

export function rlmSpillBytes(session: RlmSessionHost): number {
	const value = session.settings.get("rlm.spillBytes");
	return typeof value === "number" ? value : RLM_DEFAULT_SPILL_BYTES;
}

export function systemPromptWithRlmGuide(
	base: readonly string[],
	session: Pick<RlmSessionHost, "settings">,
): string[] {
	return appendRlmRuntimeGuide(base, rlmEnabled(session));
}

export function rlmSubModel(session: Pick<RlmSessionHost, "settings">): string | null {
	const value = session.settings.get("rlm.subModel");
	return typeof value === "string" && value.length > 0 ? value : null;
}

export type RlmWorkerMode = "prose" | "evidence-packet";
export type RlmWorkerModeSetting = "prose" | "evidence-packet" | "auto";
export type RlmWorkerModeOverride = "prose" | "evidence-packet" | "";

export function rlmWorkerModeSetting(session: Pick<RlmSessionHost, "settings">): RlmWorkerModeSetting {
	const value = session.settings.get("rlm.workerMode");
	if (value === "evidence-packet" || value === "auto") return value;
	return "prose";
}

export function rlmWorkerModeOverride(session: Pick<RlmSessionHost, "settings">): RlmWorkerModeOverride {
	const value = session.settings.get("rlm.workerModeOverride");
	return value === "prose" || value === "evidence-packet" ? value : "";
}

/** Legacy helper: fixed modes only (auto → prose for callers that have not resolved grants). */
export function rlmWorkerMode(session: Pick<RlmSessionHost, "settings">): RlmWorkerMode {
	return rlmWorkerModeSetting(session) === "evidence-packet" ? "evidence-packet" : "prose";
}

export function rlmKernelBindEnabled(session: Pick<RlmSessionHost, "settings">): boolean {
	return session.settings.get("rlm.kernelBind") === true;
}
