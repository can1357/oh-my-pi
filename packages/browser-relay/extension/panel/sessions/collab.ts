/**
 * Panel session that joins a running interactive omp as a collab guest. collab-web's `GuestClient` already keeps
 * the replica; this adapter only narrows it to {@link PanelSession}. Guests can prompt, continue, stop and answer, but not
 * switch models or compact, so those members are absent.
 */
import { GuestClient } from "@oh-my-pi/collab-web/src/lib/client";
import { parseCollabLink } from "@oh-my-pi/collab-web/src/lib/link";
import type { CollabUiResponseValue, ImageContent } from "@oh-my-pi/pi-wire";
import type { PanelSession, PanelSnapshot, QueuedDraft } from "../session";

/** How long `abort()` waits for the host's turn to end before giving up. */
const ABORT_TIMEOUT_MS = 30_000;

/** {@link PanelSession} over a collab room joined through a control link. */
export class CollabPanelSession implements PanelSession {
	readonly kind = "collab";
	readonly id: string;
	readonly #client: GuestClient;

	/** @throws Error when the link does not parse. */
	constructor(link: string, displayName: string) {
		const parsed = parseCollabLink(link);
		if ("error" in parsed) throw new Error(parsed.error);
		this.id = parsed.roomId;
		this.#client = new GuestClient(link, displayName);
		this.#client.connect();
	}

	get title(): string {
		const { header, state } = this.#client.getSnapshot();
		const cwd = header?.cwd ?? state?.cwd ?? "";
		return state?.sessionName || header?.title || cwd.split(/[\\/]/).filter(Boolean).at(-1) || "omp";
	}

	subscribe(listener: () => void): () => void {
		return this.#client.subscribe(listener);
	}

	getSnapshot(): PanelSnapshot {
		return this.#client.getSnapshot();
	}

	prompt(text: string, images: readonly ImageContent[], options?: { followUp?: boolean }): void {
		this.#client.sendPrompt(text, images, options);
	}

	resume(): void {
		this.#client.sendResume();
	}

	deliverQueue(): void {
		this.#client.sendDeliverQueue();
	}

	abort(): Promise<readonly QueuedDraft[]> {
		if (this.#client.getSnapshot().phase !== "live") return Promise.reject(new Error("not connected to the host"));
		this.#client.sendAbort();
		if (!this.#client.getSnapshot().working) return Promise.resolve([]);
		const { promise, resolve, reject } = Promise.withResolvers<readonly QueuedDraft[]>();
		const settle = (error?: Error) => {
			unsubscribe();
			clearTimeout(timer);
			if (error) reject(error);
			else resolve([]);
		};
		const unsubscribe = this.#client.subscribe(() => {
			const snapshot = this.#client.getSnapshot();
			if (snapshot.phase === "ended") settle(new Error(snapshot.endedReason ?? "the session ended"));
			else if (!snapshot.working) settle();
		});
		const timer = setTimeout(() => settle(new Error("the host did not stop in time")), ABORT_TIMEOUT_MS);
		return promise;
	}

	answer(reqId: number, value: CollabUiResponseValue): void {
		this.#client.sendUiResponse(reqId, value);
	}

	detach(): void {
		this.#client.close();
	}

	close(): void {
		this.#client.close();
	}
}
