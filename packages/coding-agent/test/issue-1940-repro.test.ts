import { describe, expect, it } from "bun:test";
import { TinyTitleClient } from "@pk-nerdsaver-ai/pi-coding-agent/tiny/title-client";
import type {
	TinyTitleWorkerInbound,
	TinyTitleWorkerOutbound,
} from "@pk-nerdsaver-ai/pi-coding-agent/tiny/title-protocol";

class FakeTinyWorker {
	terminated = false;
	readonly sent: TinyTitleWorkerInbound[] = [];
	#messageHandlers = new Set<(message: TinyTitleWorkerOutbound) => void>();
	#onSend: (message: TinyTitleWorkerInbound, worker: FakeTinyWorker) => void;

	constructor(onSend: (message: TinyTitleWorkerInbound, worker: FakeTinyWorker) => void) {
		this.#onSend = onSend;
	}

	send(message: TinyTitleWorkerInbound): void {
		this.sent.push(message);
		this.#onSend(message, this);
	}

	onMessage(handler: (message: TinyTitleWorkerOutbound) => void): () => void {
		this.#messageHandlers.add(handler);
		return () => this.#messageHandlers.delete(handler);
	}

	onError(): () => void {
		return () => {};
	}

	async terminate(): Promise<void> {
		this.terminated = true;
	}

	emit(message: TinyTitleWorkerOutbound): void {
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
			const title = await client.generate("lfm2-350m", "Investigate routing", {
				systemPrompt: "Custom title prompt",
			});

			expect(title).toBe("custom title");
			expect(sent).toMatchObject({
				type: "generate",
				modelKey: "lfm2-350m",
				message: "Investigate routing",
				systemPrompt: "Custom title prompt",
			});
		} finally {
			await client.terminate();
		}
	});
});

describe("issue #1940 — local model failures release the worker process", () => {
	it("recycles the tiny-model worker after model execution returns an error", async () => {
		const first = new FakeTinyWorker((message, worker) => {
			if (message.type === "complete") {
				worker.emit({ type: "error", id: message.id, error: "Error: Unknown failure" });
			}
		});
		const second = new FakeTinyWorker((message, worker) => {
			if (message.type === "complete") {
				worker.emit({ type: "completion", id: message.id, text: "recovered" });
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
			expect(await client.complete("qwen3-1.7b", "long prompt")).toBeNull();
			expect(first.terminated).toBe(true);
			expect(await client.complete("qwen3-1.7b", "retry prompt")).toBe("recovered");
			expect(nextWorker).toBe(2);
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
});

describe("tiny model worker idle lifecycle", () => {
	it("terminates the worker after the idle window", async () => {
		let spawned: FakeTinyWorker | undefined;
		const client = new TinyTitleClient(
			() => {
				spawned = new FakeTinyWorker((message, worker) => {
					if (message.type === "complete") {
						queueMicrotask(() => worker.emit({ type: "completion", id: message.id, text: "done" }));
					}
				});
				return spawned;
			},
			{ idleTimeoutMs: 20 },
		);

		try {
			expect(await client.complete("lfm2-1.2b", "prompt")).toBe("done");
			await Bun.sleep(50);
			expect(spawned?.terminated).toBe(true);
		} finally {
			await client.terminate();
		}
	});

	it("does not terminate while a request is pending", async () => {
		let spawned: FakeTinyWorker | undefined;
		const client = new TinyTitleClient(
			() => {
				spawned = new FakeTinyWorker((message, worker) => {
					if (message.type === "complete") {
						const delayMs = message.prompt === "slow prompt" ? 120 : 0;
						setTimeout(() => worker.emit({ type: "completion", id: message.id, text: "done" }), delayMs);
					}
				});
				return spawned;
			},
			{ idleTimeoutMs: 80 },
		);

		try {
			expect(await client.complete("lfm2-1.2b", "warm up")).toBe("done");
			await Bun.sleep(20);
			const completion = client.complete("lfm2-1.2b", "slow prompt");
			await Bun.sleep(80);
			expect(spawned?.terminated).toBe(false);
			expect(await completion).toBe("done");
			await Bun.sleep(100);
			expect(spawned?.terminated).toBe(true);
		} finally {
			await client.terminate();
		}
	});

	it("respawns after an idle termination", async () => {
		const workers: FakeTinyWorker[] = [];
		const client = new TinyTitleClient(
			() => {
				const worker = new FakeTinyWorker((message, activeWorker) => {
					if (message.type === "complete") {
						queueMicrotask(() =>
							activeWorker.emit({ type: "completion", id: message.id, text: `worker-${workers.length}` }),
						);
					}
				});
				workers.push(worker);
				return worker;
			},
			{ idleTimeoutMs: 20 },
		);

		try {
			expect(await client.complete("lfm2-1.2b", "first")).toBe("worker-1");
			await Bun.sleep(50);
			expect(workers[0]?.terminated).toBe(true);

			expect(await client.complete("lfm2-1.2b", "second")).toBe("worker-2");
			expect(workers).toHaveLength(2);
			expect(workers[1]?.sent.some(message => message.type === "complete")).toBe(true);
		} finally {
			await client.terminate();
		}
	});

	it("terminates immediately when abort removes the final pending request", async () => {
		const controller = new AbortController();
		let spawned: FakeTinyWorker | undefined;
		const client = new TinyTitleClient(
			() => {
				spawned = new FakeTinyWorker(() => {});
				return spawned;
			},
			{ idleTimeoutMs: 60_000 },
		);

		try {
			const completion = client.complete("lfm2-1.2b", "cancel me", { signal: controller.signal });
			await Bun.sleep(0);
			controller.abort();

			expect(await completion).toBeNull();
			expect(spawned?.terminated).toBe(true);
		} finally {
			await client.terminate();
		}
	});
});
