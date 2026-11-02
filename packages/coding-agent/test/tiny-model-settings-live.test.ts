import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { TinyTitleClient } from "@oh-my-pi/pi-coding-agent/tiny/title-client";
import type { TinyWorkerRequest, TinyWorkerResponse } from "@oh-my-pi/pi-coding-agent/tiny/title-protocol";

import { cfgProvidersTinyModelDtype } from "@oh-my-pi/pi-coding-agent/session/settings";

/** Minimal worker that answers every chat with a fixed reply. */
class ReplyingWorker {
	terminated = false;
	#handlers = new Set<(message: TinyWorkerResponse) => void>();

	send(message: TinyWorkerRequest): void {
		if (message.type !== "chat") return;
		queueMicrotask(() => {
			for (const handler of this.#handlers) handler({ type: "text", id: message.id, text: "reply" });
		});
	}

	onMessage(handler: (message: TinyWorkerResponse) => void): () => void {
		this.#handlers.add(handler);
		return () => this.#handlers.delete(handler);
	}

	onError(): () => void {
		return () => {};
	}

	async terminate(): Promise<void> {
		this.terminated = true;
	}

	ref(): void {}

	unref(): void {}
}

describe("providers.tinyModelDtype live change", () => {
	const savedEnv = { device: Bun.env.PI_TINY_DEVICE, dtype: Bun.env.PI_TINY_DTYPE };

	beforeEach(async () => {
		delete Bun.env.PI_TINY_DEVICE;
		delete Bun.env.PI_TINY_DTYPE;
		await Settings.init({ inMemory: true });
	});

	afterEach(() => {
		resetSettingsForTest();
		if (savedEnv.device !== undefined) Bun.env.PI_TINY_DEVICE = savedEnv.device;
		if (savedEnv.dtype !== undefined) Bun.env.PI_TINY_DTYPE = savedEnv.dtype;
	});

	it("serves the next call from a fresh worker after the dtype changes", async () => {
		const workers: ReplyingWorker[] = [];
		const client = new TinyTitleClient(async () => {
			const worker = new ReplyingWorker();
			workers.push(worker);
			return worker;
		});
		try {
			expect(await client.complete("qwen3-1.7b", "one")).toBe("reply");
			expect(await client.complete("qwen3-1.7b", "two")).toBe("reply");
			expect(workers).toHaveLength(1);

			cfgProvidersTinyModelDtype.set(settings, "q8");
			expect(await client.complete("qwen3-1.7b", "three")).toBe("reply");

			expect(workers).toHaveLength(2);
			expect(workers[0]!.terminated).toBe(true);
			expect(workers[1]!.terminated).toBe(false);
		} finally {
			await client.terminate();
		}
	});
});
