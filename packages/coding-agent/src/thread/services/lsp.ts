/**
 * Shared-LSP mode bridge between the main thread and subagent workers.
 *
 * Whether a language-server cold start attaches to the per-project LSP mux
 * daemon is a hold stack in `lsp/client.ts` that main's process-binding
 * sessions push from their `lsp.shared` setting. A worker's stack starts
 * empty, so its subagents would spawn private servers; instead the worker
 * holds main's current mode at the bottom of its own stack and follows every
 * change main pushes until it exits.
 */
import { logger } from "@oh-my-pi/pi-utils";
import { holdSharedLsp, isSharedLspEnabled, onSharedLspChange } from "../../lsp/client";
import type { MainThreadLink } from "../protocol";
import type { ThreadService, WorkerPeer } from "../services";

/** Boot globals of {@link lspThreadService}. */
export interface LspServiceGlobals {
	/**
	 * Subscribe `listener` to main's effective shared-LSP mode and answer the
	 * mode at subscription; the subscription lasts until the worker exits.
	 */
	readonly watchSharedLsp: (listener: (enabled: boolean) => unknown) => boolean | Promise<boolean>;
}

/** Main-side shared-LSP subscriptions of one worker, released when it exits. */
class PeerLspSubscriptions {
	readonly #unsubscribes: Array<() => void> = [];

	add(unsubscribe: () => void): void {
		this.#unsubscribes.push(unsubscribe);
	}

	release(): void {
		for (const unsubscribe of this.#unsubscribes.splice(0)) unsubscribe();
	}
}

const kPeerLsp = Symbol("thread.lsp.subscriptions");

/** This worker link's shared-LSP subscriptions, created on first use. */
function peerSubscriptions(link: MainThreadLink): PeerLspSubscriptions {
	const existing: unknown = Reflect.get(link, kPeerLsp);
	if (existing instanceof PeerLspSubscriptions) return existing;
	const subscriptions = new PeerLspSubscriptions();
	Reflect.set(link, kPeerLsp, subscriptions);
	return subscriptions;
}

function isLspGlobals(value: unknown): value is LspServiceGlobals {
	return typeof value === "object" && value !== null && typeof Reflect.get(value, "watchSharedLsp") === "function";
}

/** Keeps each worker's shared-LSP mode equal to the main thread's. */
export const lspThreadService: ThreadService = {
	name: "lsp",

	globals(peer: WorkerPeer): LspServiceGlobals {
		const subscriptions = peerSubscriptions(peer.link);
		return {
			watchSharedLsp: listener => {
				subscriptions.add(
					onSharedLspChange(enabled => {
						// The worker may be exiting; its link rejects the push.
						Promise.resolve(listener(enabled)).catch((error: unknown) =>
							logger.debug("Worker shared-LSP listener failed", { error: String(error) }),
						);
					}),
				);
				return isSharedLspEnabled();
			},
		};
	},

	onWorkerExit(peer: WorkerPeer): void {
		peerSubscriptions(peer.link).release();
	},

	async boot(globals: unknown): Promise<void> {
		if (!isLspGlobals(globals)) throw new Error("lsp service: boot globals lack the shared-LSP watch");
		const hold = holdSharedLsp(false);
		let pushed = false;
		const current = await globals.watchSharedLsp(enabled => {
			pushed = true;
			hold.set(enabled);
		});
		// A change pushed before the answer was handled is newer than the answer.
		if (!pushed) hold.set(current);
	},
};
