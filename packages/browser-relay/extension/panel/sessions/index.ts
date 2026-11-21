/**
 * Factories for the two {@link PanelSession} sources: a collab guest of a running omp, and a worker-owned
 * `omp --mode rpc` session behind the native host.
 */
import type { RpcSessionInfo } from "../../messages";
import type { PanelSession, PanelWorker } from "../session";
import { CollabPanelSession } from "./collab";
import { RpcPanelSession } from "./rpc";

/** Joins the collab room behind a control `link` as `displayName`. @throws Error when the link does not parse. */
export function openCollabSession(link: string, displayName: string): PanelSession {
	return new CollabPanelSession(link, displayName);
}

/** Attaches to the rpc session `info` names, rebuilding its transcript so far. */
export function openRpcSession(worker: PanelWorker, info: RpcSessionInfo): PanelSession {
	return new RpcPanelSession(worker, info);
}
