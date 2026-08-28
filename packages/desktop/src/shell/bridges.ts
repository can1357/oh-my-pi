import type { RpcBridge } from "../rpc/bridge";
import type { SessionProcess } from "../rpc/sessionOps";
import { isTauri, TauriTransport } from "../rpc/transport";

/**
 * Which tab's bridge is which, for the parts of the app that are not inside a
 * session view.
 *
 * The sidebar's context menu needs it: renaming a session that is open must go
 * through the process that already has it, because a second process on a live
 * jsonl is two agents appending to one file. `activity.ts` established this
 * shape — a module-level registry the views publish into.
 */
const bridges = new Map<string, RpcBridge>();

export function registerBridge(tabId: string, bridge: RpcBridge): () => void {
	bridges.set(tabId, bridge);
	return () => {
		// Only if it is still ours: a remount registers the new one first.
		if (bridges.get(tabId) === bridge) bridges.delete(tabId);
	};
}

export function bridgeFor(tabId: string | undefined): RpcBridge | undefined {
	return tabId ? bridges.get(tabId) : undefined;
}

/**
 * Who has this tab's session open, as far as anything outside a session view can
 * tell.
 *
 * `bridgeFor` answers for any mounted session view, and a view stays mounted
 * with its bridge sitting at `idle` when it is not the visible tab — its boot is
 * gated on `autoStart`. So "has a bridge" and even "the bridge says ready" both
 * mean less than they look: after any route change every background tab reports
 * idle while its sidecar is alive in the pool.
 *
 * Rust owns the processes, so Rust is asked. And the answer is three-valued on
 * purpose: leaving the session route unmounts every view while the pool keeps the
 * sidecars, so "this webview has no bridge" is not "nothing is running". Calling
 * that `none` is what sent a rename into a throwaway child and put two agents on
 * one jsonl.
 */
export async function sessionProcess(tabId: string | undefined): Promise<SessionProcess> {
	if (!tabId || !isTauri()) return { kind: "none" };
	const bridge = bridges.get(tabId);
	const status = await new TauriTransport().poolStatus().catch(() => null);
	// Only a pool that answered may say "nothing is running". A rejected
	// `agent_pool_status` falls through to the line below, where a missing bridge
	// reads as detached: refusing costs a rename, guessing costs the transcript.
	if (status && !status.tabs.includes(tabId)) return { kind: "none" };
	return bridge ? { kind: "mounted", bridge } : { kind: "detached" };
}

/** Tab ids the Rust pool currently has a process for. */
export async function liveTabs(): Promise<Set<string>> {
	if (!isTauri()) return new Set();
	const status = await new TauriTransport().poolStatus().catch(() => null);
	return new Set(status?.tabs ?? []);
}
