import type { CollabUiRequestDraft, CollabUiResponseValue } from "@oh-my-pi/pi-wire";

/**
 * Outcome of {@link RemoteDialogHost.requestGuestUi}. `answered` carries the
 * remote response (an `undefined` value is a genuine remote cancel);
 * `unavailable` means the channel went away or the request was aborted before
 * any remote answered — callers MUST NOT treat it as a cancel.
 */
export type RemoteDialogResult = { kind: "answered"; value: CollabUiResponseValue } | { kind: "unavailable" };

/**
 * A remote surface (collab guest, Telegram chat, …) that can answer a dialog
 * the local TUI is showing. Dialogs race every host against the local UI;
 * the first `answered` result wins and the rest are aborted via `signal`.
 */
export interface RemoteDialogHost {
	/** Returns `null` when the host cannot take a request right now. */
	requestGuestUi(request: CollabUiRequestDraft, signal?: AbortSignal): Promise<RemoteDialogResult> | null;
}

/** Registry of remote dialog hosts active for the interactive session. */
export class RemoteDialogHosts {
	#hosts: RemoteDialogHost[] = [];

	/** Registers `host`; the returned disposer removes it (idempotent). */
	add(host: RemoteDialogHost): () => void {
		this.#hosts = [...this.#hosts, host];
		return () => {
			this.#hosts = this.#hosts.filter(entry => entry !== host);
		};
	}

	/** Snapshot of the registered hosts, in registration order. */
	list(): readonly RemoteDialogHost[] {
		return this.#hosts;
	}
}
