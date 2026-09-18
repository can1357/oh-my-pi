import { RLM_DEFAULT_SPILL_BYTES, RlmStore } from "./store";

interface RlmSessionHost {
	cwd: string;
	settings: {
		get(path: string): unknown;
	};
	sessionManager?: { getSessionId?: () => string | undefined };
}

const stores = new Map<string, RlmStore>();

export function rlmSessionKey(session: Pick<RlmSessionHost, "cwd" | "sessionManager">): string {
	return session.sessionManager?.getSessionId?.() ?? session.cwd;
}

export function getRlmStore(session: RlmSessionHost): RlmStore {
	const key = rlmSessionKey(session);
	let store = stores.get(key);
	if (!store) {
		store = new RlmStore({
			maxDepth: Number(session.settings.get("rlm.maxDepth") ?? 0),
			maxCalls: Number(session.settings.get("rlm.maxCalls") ?? 32),
			maxTotalTokens: Number(session.settings.get("rlm.maxTotalTokens") ?? 1_000_000),
		});
		stores.set(key, store);
	}
	return store;
}

export function resetRlmStoresForTest(): void {
	stores.clear();
}

export function rlmSpillBytes(session: RlmSessionHost): number {
	const value = session.settings.get("rlm.spillBytes");
	return typeof value === "number" ? value : RLM_DEFAULT_SPILL_BYTES;
}

export function rlmEnabled(session: Pick<RlmSessionHost, "settings">): boolean {
	return session.settings.get("rlm.enabled") === true;
}
