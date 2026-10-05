/**
 * Regression for https://github.com/can1357/oh-my-pi/issues/14346
 *
 * When the host is missing the C++ runtime the prebuilt `onnxruntime-node`
 * addon links against, the embed worker's `init` fails with the loader's own
 * `libstdc++.so.6: cannot open shared object file` text. `initialize()` used to
 * answer that with `null`, and `state.ts` turned `null` into the fixed string
 * `mnemopi embed subprocess unavailable`, so the only thing recorded anywhere
 * was "the subprocess is unavailable" — the loader diagnostic was dropped on
 * the floor and recall silently degraded to the SHA1 fallback. The parent must
 * surface the worker's message verbatim.
 *
 * Fake workers, so no fastembed/onnxruntime is loaded.
 */
import { describe, expect, it } from "bun:test";
import { MnemopiEmbedClient, type MnemopiEmbedWorkerHandle } from "@oh-my-pi/pi-coding-agent/mnemopi/embed-client";
import type {
	MnemopiEmbedWorkerInbound,
	MnemopiEmbedWorkerOutbound,
} from "@oh-my-pi/pi-coding-agent/mnemopi/embed-protocol";

const LOADER_ERROR = "libstdc++.so.6: cannot open shared object file: No such file or directory";

/** A worker that answers every `init` with `error`, the way a broken dlopen does. */
function failingEmbedWorker(error: string): () => MnemopiEmbedWorkerHandle {
	return () => {
		let handler: ((message: MnemopiEmbedWorkerOutbound) => void) | undefined;
		return {
			send(message: MnemopiEmbedWorkerInbound) {
				if (message.type === "init") {
					queueMicrotask(() => handler?.({ type: "error", id: message.id, error }));
				}
			},
			onMessage(next) {
				handler = next;
				return () => {
					if (handler === next) handler = undefined;
				};
			},
			onError() {
				return () => {};
			},
			ref() {},
			unref() {},
			async terminate() {
				handler = undefined;
			},
		};
	};
}

describe("issue #14346 — a failed embed init reports the loader's own error", () => {
	it("rejects with the worker's error instead of a generic unavailable string", async () => {
		const client = new MnemopiEmbedClient(failingEmbedWorker(LOADER_ERROR));
		try {
			const failure = await client.initialize("fast-bge-base-en-v1.5", "/tmp/cache").then(
				() => undefined,
				(error: unknown) => error,
			);
			if (!(failure instanceof Error)) throw new Error("expected init to reject");
			// `state.ts` used to replace the worker's message with exactly this.
			expect(failure.message).toBe(LOADER_ERROR);
		} finally {
			await client.terminate();
		}
	}, 10_000);

	it("reports a terminated worker as the reason init failed", async () => {
		// `initialize` stats the model cache before it spawns the worker, so
		// wait on the worker actually attaching rather than on a guessed delay.
		const attached = Promise.withResolvers<void>();
		const client = new MnemopiEmbedClient(
			() => ({
				send() {
					/* never answers `init` */
				},
				onMessage() {
					attached.resolve();
					return () => {};
				},
				onError() {
					return () => {};
				},
				ref() {},
				unref() {},
				async terminate() {},
			}),
			10_000,
		);
		try {
			const init = client.initialize("fast-bge-base-en-v1.5", "/tmp/cache");
			await attached.promise;
			await client.terminate();
			await expect(init).rejects.toThrow("mnemopi embed worker terminated");
		} finally {
			await client.terminate();
		}
	}, 10_000);
});
