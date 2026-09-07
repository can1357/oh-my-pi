import { describe, expect, it } from "bun:test";
import { SttClient } from "@oh-my-pi/pi-coding-agent/stt/asr-client";
import type { SttWorkerInbound, SttWorkerOutbound } from "@oh-my-pi/pi-coding-agent/stt/asr-protocol";
import { TinyTitleClient } from "@oh-my-pi/pi-coding-agent/tiny/title-client";
import type { TinyWorkerRequest, TinyWorkerResponse } from "@oh-my-pi/pi-coding-agent/tiny/title-protocol";

class FakeTinyWorker {
	terminated = false;
	refCalls = 0;
	unrefCalls = 0;
	#messageHandlers = new Set<(message: TinyWorkerResponse) => void>();
	#errorHandlers = new Set<(error: Error) => void>();
	#onSend: (message: TinyWorkerRequest, worker: FakeTinyWorker) => void;
	/** Resolves with the first non-ping request the client sends. */
	readonly firstRequest = Promise.withResolvers<TinyWorkerRequest>();

	constructor(onSend: (message: TinyWorkerRequest, worker: FakeTinyWorker) => void) {
		this.#onSend = onSend;
	}

	send(message: TinyWorkerRequest): void {
		if (message.type !== "ping") this.firstRequest.resolve(message);
		this.#onSend(message, this);
	}

	onMessage(handler: (message: TinyWorkerResponse) => void): () => void {
		this.#messageHandlers.add(handler);
		return () => this.#messageHandlers.delete(handler);
	}

	onError(handler: (error: Error) => void): () => void {
		this.#errorHandlers.add(handler);
		return () => this.#errorHandlers.delete(handler);
	}

	async terminate(): Promise<void> {
		this.terminated = true;
	}

	ref(): void {
		this.refCalls += 1;
	}

	unref(): void {
		this.unrefCalls += 1;
	}

	emit(message: TinyWorkerResponse): void {
		for (const handler of this.#messageHandlers) handler(message);
	}

	emitError(error: Error): void {
		for (const handler of this.#errorHandlers) handler(error);
	}
}

class FakeSttWorker {
	terminated = false;
	refCalls = 0;
	unrefCalls = 0;
	#messageHandlers = new Set<(message: SttWorkerOutbound) => void>();
	#errorHandlers = new Set<(error: Error) => void>();
	#onSend: (message: SttWorkerInbound, worker: FakeSttWorker) => void;

	constructor(onSend: (message: SttWorkerInbound, worker: FakeSttWorker) => void) {
		this.#onSend = onSend;
	}

	send(message: SttWorkerInbound): void {
		this.#onSend(message, this);
	}

	onMessage(handler: (message: SttWorkerOutbound) => void): () => void {
		this.#messageHandlers.add(handler);
		return () => this.#messageHandlers.delete(handler);
	}

	onError(handler: (error: Error) => void): () => void {
		this.#errorHandlers.add(handler);
		return () => this.#errorHandlers.delete(handler);
	}

	async terminate(): Promise<void> {
		this.terminated = true;
	}

	ref(): void {
		this.refCalls += 1;
	}

	unref(): void {
		this.unrefCalls += 1;
	}

	emit(message: SttWorkerOutbound): void {
		for (const handler of this.#messageHandlers) handler(message);
	}
}

describe("tiny title client prompt construction", () => {
	it("renders the title chat with a custom system prompt, the <title> prefill, and extracts the reply", async () => {
		let sent: TinyWorkerRequest | undefined;
		const worker = new FakeTinyWorker((message, worker) => {
			sent = message;
			if (message.type === "chat") {
				worker.emit({ type: "text", id: message.id, text: " Custom Title</title> trailing" });
			}
		});
		const client = new TinyTitleClient(async () => worker);

		try {
			const title = await client.generate("lfm2.5-230m", "Investigate routing", {
				systemPrompt: "Custom title prompt",
			});

			expect(title).toBe("Custom Title");
			expect(sent).toMatchObject({
				type: "chat",
				prefill: "<title>",
				stop: "</title>",
				messages: [
					{ role: "system", content: "Custom title prompt" },
					{ role: "user", content: expect.stringContaining("Investigate routing") },
				],
			});
		} finally {
			await client.terminate();
		}
	});

	it("caps completion length and returns null for empty output", async () => {
		const worker = new FakeTinyWorker((message, worker) => {
			if (message.type === "chat") worker.emit({ type: "text", id: message.id, text: "   " });
		});
		const client = new TinyTitleClient(async () => worker);
		try {
			expect(await client.complete("qwen3-1.7b", "prompt", { maxTokens: 999_999 })).toBeNull();
			expect(await worker.firstRequest.promise).toMatchObject({ type: "chat", maxNewTokens: 1024 });
		} finally {
			await client.terminate();
		}
	});
});

describe("issue #1940 — local model failures release the worker process", () => {
	it("releases the failed worker and suppresses repeated local model attempts", async () => {
		const first = new FakeTinyWorker((message, worker) => {
			if (message.type === "chat") {
				worker.emit({ type: "error", id: message.id, error: "Error: Unknown failure" });
			}
		});
		let spawnCount = 0;
		const client = new TinyTitleClient(async () => {
			spawnCount += 1;
			return first;
		});

		try {
			expect(await client.complete("qwen3-1.7b", "long prompt")).toBeNull();
			expect(first.terminated).toBe(true);
			expect(await client.complete("qwen3-1.7b", "retry prompt")).toBeNull();
			expect(spawnCount).toBe(1);
		} finally {
			await client.terminate();
		}
	});

	it("faults queued local completions when the failed worker is recycled", async () => {
		const worker = new FakeTinyWorker(() => {});
		const client = new TinyTitleClient(async () => worker);

		try {
			const first = client.complete("qwen3-1.7b", "first prompt");
			const second = client.complete("qwen3-1.7b", "second prompt");
			const firstRequest = await worker.firstRequest.promise;
			worker.emit({ type: "error", id: firstRequest.id, error: "Error: Unknown failure" });

			expect(await first).toBeNull();
			expect(await second).toBeNull();
			expect(worker.terminated).toBe(true);
		} finally {
			await client.terminate();
		}
	});

	it("keeps other models' workers alive when one model's worker crashes", async () => {
		const memoryWorker = new FakeTinyWorker(() => {});
		const titleWorker = new FakeTinyWorker((message, worker) => {
			if (message.type === "chat") worker.emit({ type: "text", id: message.id, text: "recovered title" });
		});
		const spawned: string[] = [];
		const client = new TinyTitleClient(async modelKey => {
			spawned.push(modelKey);
			return modelKey === "qwen3-1.7b" ? memoryWorker : titleWorker;
		});

		try {
			const crashedMemory = client.complete("qwen3-1.7b", "first prompt");
			const title = client.generate("lfm2.5-230m", "title prompt");
			await memoryWorker.firstRequest.promise;
			memoryWorker.emitError(new Error("tiny worker connection closed"));

			expect(await crashedMemory).toBeNull();
			expect(memoryWorker.terminated).toBe(true);
			// One worker per model: the title worker never noticed.
			expect(await title).toBe("recovered title");
			expect(titleWorker.terminated).toBe(false);
			expect(spawned).toEqual(["qwen3-1.7b", "lfm2.5-230m"]);
		} finally {
			await client.terminate();
		}
	});
});

describe("issue #3291 — tiny-model downloads keep the worker referenced", () => {
	it("references the worker while a download request is pending", async () => {
		const worker = new FakeTinyWorker(() => {});
		const client = new TinyTitleClient(async () => worker);

		try {
			const download = client.downloadModel("lfm2.5-350m");
			const request = await worker.firstRequest.promise;

			expect(request.type).toBe("load");
			expect(worker.refCalls).toBe(1);
			expect(worker.unrefCalls).toBe(0);

			worker.emit({ type: "loaded", id: request.id });

			expect(await download).toEqual({ ok: true });
			expect(worker.unrefCalls).toBe(1);
		} finally {
			await client.terminate();
		}
	});

	it("returns the worker error for failed download requests", async () => {
		const worker = new FakeTinyWorker(() => {});
		const client = new TinyTitleClient(async () => worker);

		try {
			const download = client.downloadModel("lfm2.5-350m");
			const request = await worker.firstRequest.promise;
			worker.emit({ type: "error", id: request.id, error: "Error: runtime install failed" });

			expect(await download).toEqual({ ok: false, error: "Error: runtime install failed" });
			expect(worker.terminated).toBe(true);
		} finally {
			await client.terminate();
		}
	});
});

describe("issue #3939 — stt downloads keep the worker referenced", () => {
	it("references the worker while a download request is pending", async () => {
		let downloadRequestId = "";
		const worker = new FakeSttWorker(message => {
			if (message.type === "download") downloadRequestId = message.id;
		});
		const client = new SttClient(() => worker);

		try {
			const download = client.downloadModel("turbo");

			expect(downloadRequestId).not.toBe("");
			expect(worker.refCalls).toBe(1);
			expect(worker.unrefCalls).toBe(0);

			worker.emit({ type: "downloaded", id: downloadRequestId });

			expect(await download).toEqual({ ok: true });
			expect(worker.unrefCalls).toBe(1);
		} finally {
			await client.terminate();
		}
	});

	it("surfaces worker download errors to setup callers", async () => {
		let downloadRequestId = "";
		const worker = new FakeSttWorker(message => {
			if (message.type === "download") downloadRequestId = message.id;
		});
		const client = new SttClient(() => worker);

		try {
			const download = client.downloadModel("turbo");

			expect(downloadRequestId).not.toBe("");
			worker.emit({ type: "error", id: downloadRequestId, error: "Error: Hub returned 403" });

			expect(await download).toEqual({ ok: false, error: "Error: Hub returned 403" });
			expect(worker.unrefCalls).toBe(1);
		} finally {
			await client.terminate();
		}
	});
});
