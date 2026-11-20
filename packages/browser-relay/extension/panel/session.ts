/**
 * The conversation the side panel shows. Two implementations share it: `sessions/collab.ts` joins a running
 * interactive omp as a collab guest, `sessions/rpc.ts` drives a worker-owned `omp --mode rpc` through the native
 * host. The UI renders only this interface and never knows which one it has.
 */
import type { GuestSnapshot } from "@oh-my-pi/collab-web/src/lib/client";
import type { CollabUiResponseValue, ImageContent } from "@oh-my-pi/pi-wire";
import type { PanelEvent, PanelRequestMap, PanelRequestOp, PanelResult } from "../messages";

/** The panel's connection to the service worker (`panel/worker-client.ts`); rpc sessions talk through it. */
export interface PanelWorker {
	request<Op extends PanelRequestOp>(op: Op, fields: PanelRequestMap[Op][0]): Promise<PanelResult<Op>>;
	/** Every worker event; returns an unsubscribe. */
	onEvent(listener: (event: PanelEvent) => void): () => void;
}

/** The transcript-facing part of collab-web's guest snapshot; rpc sessions produce the same shape. */
export type PanelSnapshot = Pick<
	GuestSnapshot,
	| "phase"
	| "endedReason"
	| "header"
	| "entries"
	| "state"
	| "stream"
	| "streamDone"
	| "activeTools"
	| "working"
	| "readOnly"
	| "uiRequest"
	| "notices"
	| "agents"
	| "progress"
	| "lifecycle"
>;

/** A model the session can switch to. */
export interface PanelModel {
	provider: string;
	id: string;
	name: string;
}

export interface PanelSession {
	readonly kind: "collab" | "rpc";
	/** Collab instance id or rpc session key; stable for the session's life. */
	readonly id: string;
	/** Display name: session name, else cwd basename. */
	readonly title: string;
	/** `useSyncExternalStore` pair: snapshots are immutable and change identity on every update. */
	subscribe(listener: () => void): () => void;
	getSnapshot(): PanelSnapshot;
	/** Send a user prompt; queued by the host when a turn is running. */
	prompt(text: string, images: readonly ImageContent[]): void;
	/** Stop the running turn. Resolves when the host acknowledged it, rejects when it can't reach the host. */
	abort(): Promise<void>;
	/** Answer the pending `uiRequest`; `undefined` cancels it. */
	answer(reqId: number, value: CollabUiResponseValue): void;
	/**
	 * Models the session can switch to, fetched once and shared by every caller; a failed fetch is retried on the next
	 * call. Absent when the host doesn't allow switching (collab guests).
	 */
	listModels?(): Promise<readonly PanelModel[]>;
	setModel?(model: PanelModel): Promise<void>;
	/** Compact the context now; absent when the host doesn't allow it (collab guests). */
	compact?(): Promise<void>;
	/**
	 * Stop showing the session without ending it: drop listeners and connections this object holds. The panel calls it
	 * when switching to another session or unmounting; the session keeps running and can be reopened.
	 */
	detach(): void;
	/** End the session. A collab host keeps running (the guest leaves); an rpc session's process is stopped. */
	close(): void;
}
