import { describe, expect, it } from "bun:test";
import { SttClient } from "@oh-my-pi/pi-coding-agent/stt/asr-client";
import type { SttWorkerInbound, SttWorkerOutbound } from "@oh-my-pi/pi-coding-agent/stt/asr-protocol";
import { TinyTitleClient } from "@oh-my-pi/pi-coding-agent/tiny/title-client";
import type { TinyTitleWorkerInbound, TinyTitleWorkerOutbound } from "@oh-my-pi/pi-coding-agent/tiny/title-protocol";

class FakeTinyWorker {
	terminated = false;
	refCalls = 0;
	unrefCalls = 0;
	#messageHandlers = new Set<(message: TinyTitleWorkerOutbound) => void>();
	#errorHandlers = new Set<(error: Error) => void>();
	#onSend: (message: TinyTitleWorkerInbound, worker: FakeTinyWorker) => void;

	constructor(onSend: (message: TinyTitleWorkerInbound, worker: FakeTinyWorker) => void) {
		this.#onSend = onSend;
	}

	send(message: TinyTitleWorkerInbound): void {
		this.#onSend(message, this);
	}

	onMessage(handler: (message: TinyTitleWorkerOutbound) => void): () => void {
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

	emit(message: TinyTitleWorkerOutbound): void {
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

describe("tiny title client prompt options", () => {
	it("forwards a custom system prompt on local title requests", async () => {
		let sent: TinyTitleWorkerInbound | undefined;
		const worker = new FakeTinyWorker((message, worker) => {
			sent = message;
			if (message.type === "generate") {
				worker.emit({ type: "title", id: message.id, title: "custom title" });
			}
		});
		const client = new TinyTitleClient(() => worker);

		try {
			const title = await client.generate("lfm2.5-230m", "Investigate routing", {
				systemPrompt: "Custom title prompt",
			});

			expect(title).toBe("custom title");
			expect(sent).toMatchObject({
				type: "generate",
				modelKey: "lfm2.5-230m",
				message: "Investigate routing",
				systemPrompt: "Custom title prompt",
			});
		} finally {
			await client.terminate();
		}
	});
});

describe("issue #1940 — local model failures release the worker process", () => {
	it("releases the failed worker and suppresses repeated local model attempts", async () => {
		const first = new FakeTinyWorker((message, worker) => {
			if (message.type === "complete") {
				worker.emit({ type: "error", id: message.id, error: "Error: Unknown failure" });
			}
		});
		let spawnCount = 0;
		const client = new TinyTitleClient(() => {
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
		let firstRequestId = "";
		const worker = new FakeTinyWorker(message => {
			if (message.type !== "complete") return;
			firstRequestId ||= message.id;
		});
		const client = new TinyTitleClient(() => worker);

		try {
			const first = client.complete("qwen3-1.7b", "first prompt");
			const second = client.complete("qwen3-1.7b", "second prompt");
			worker.emit({ type: "error", id: firstRequestId, error: "Error: Unknown failure" });

			expect(await first).toBeNull();
			expect(await second).toBeNull();
			expect(worker.terminated).toBe(true);
		} finally {
			await client.terminate();
		}
	});

	it("does not suppress unrelated queued models after a worker crash", async () => {
		const first = new FakeTinyWorker(() => {});
		const second = new FakeTinyWorker((message, worker) => {
			if (message.type === "generate") {
				worker.emit({ type: "title", id: message.id, title: "recovered title" });
			}
		});
		const workers = [first, second];
		let nextWorker = 0;
		const client = new TinyTitleClient(() => {
			const worker = workers[nextWorker];
			if (!worker) throw new Error("unexpected worker spawn");
			nextWorker += 1;
			return worker;
		});

		try {
			const crashedMemory = client.complete("qwen3-1.7b", "first prompt");
			const queuedTitle = client.generate("lfm2.5-230m", "title prompt");
			first.emitError(new Error("tiny model subprocess exited with signal SIGKILL"));

			expect(await crashedMemory).toBeNull();
			expect(await queuedTitle).toBeNull();
			expect(first.terminated).toBe(true);
			expect(await client.generate("lfm2.5-230m", "retry title")).toBe("recovered title");
			expect(nextWorker).toBe(2);
		} finally {
			await client.terminate();
		}
	});
});

describe("issue #3291 — tiny-model downloads keep the worker referenced", () => {
	it("references the worker while a download request is pending", async () => {
		let downloadRequestId = "";
		const worker = new FakeTinyWorker(message => {
			if (message.type === "download") downloadRequestId = message.id;
		});
		const client = new TinyTitleClient(() => worker);

		try {
			const download = client.downloadModel("lfm2.5-350m");

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

	it("returns the worker error for failed download requests", async () => {
		let downloadRequestId = "";
		const worker = new FakeTinyWorker(message => {
			if (message.type === "download") downloadRequestId = message.id;
		});
		const client = new TinyTitleClient(() => worker);

		try {
			const download = client.downloadModel("lfm2.5-350m");

			expect(downloadRequestId).not.toBe("");
			worker.emit({ type: "error", id: downloadRequestId, error: "Error: runtime install failed" });

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
