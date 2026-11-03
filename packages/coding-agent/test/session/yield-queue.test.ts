import { describe, expect, test } from "bun:test";
import {
	type AgentContext,
	type AgentLoopConfig,
	type AgentMessage,
	AppendOnlyContextManager,
	ASIDE_MESSAGE_CLAIM,
	ASIDE_MESSAGE_COMMIT,
	agentLoop,
	type CommittableAsideMessage,
} from "@oh-my-pi/pi-agent-core";
import type { Context, Message } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { type AsideProvenanceCarrier, kAsideProvenance } from "@oh-my-pi/pi-ai/utils/block-symbols";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { YieldQueue } from "@oh-my-pi/pi-coding-agent/session/yield-queue";
import { type Tracer, trace } from "@opentelemetry/api";

type Entry = {
	id: string;
	stale?: boolean;
};

function userMessage(text: string): AgentMessage {
	return {
		role: "user",
		content: [{ type: "text", text }],
		timestamp: 0,
	};
}

function messageText(message: AgentMessage): string {
	if (!("content" in message) || !Array.isArray(message.content)) return "";
	const block = message.content[0];
	return block?.type === "text" ? block.text : "";
}

function createHarness(initialStreaming: boolean) {
	let streaming = initialStreaming;
	const streamingMessages: AgentMessage[] = [];
	const idleBatches: AgentMessage[][] = [];
	const scheduledFlushes: Array<() => Promise<void>> = [];
	const queue = new YieldQueue({
		isStreaming: () => streaming,
		injectStreaming: message => {
			streamingMessages.push(message);
		},
		injectIdle: async messages => {
			idleBatches.push(messages);
		},
		scheduleIdleFlush: run => {
			scheduledFlushes.push(run);
		},
	});
	return {
		queue,
		streamingMessages,
		idleBatches,
		scheduledFlushes,
		setStreaming: (value: boolean) => {
			streaming = value;
		},
	};
}

describe("YieldQueue", () => {
	test("enqueue while streaming defers until streaming flush", async () => {
		const harness = createHarness(true);
		harness.queue.register<Entry>("items", {
			build: entries => userMessage(entries.map(entry => entry.id).join(",")),
		});

		harness.queue.enqueue("items", { id: "a" });

		expect(harness.scheduledFlushes).toHaveLength(0);
		expect(harness.streamingMessages).toHaveLength(0);
		expect(harness.queue.has("items")).toBe(true);

		await harness.queue.flush("streaming");

		expect(harness.queue.has()).toBe(false);
		expect(harness.streamingMessages.map(messageText)).toEqual(["a"]);
	});

	test("requested idle flush waits for an explicit stream-settlement retry", async () => {
		const harness = createHarness(true);
		harness.queue.register<Entry>("items", {
			build: entries => userMessage(entries.map(entry => entry.id).join(",")),
		});
		harness.queue.enqueue("items", { id: "late" });
		harness.queue.requestIdleFlush();
		expect(harness.scheduledFlushes).toHaveLength(1);

		await harness.scheduledFlushes[0]!();
		expect(harness.scheduledFlushes).toHaveLength(1);
		expect(harness.idleBatches).toHaveLength(0);

		harness.setStreaming(false);
		harness.queue.requestIdleFlush();
		await harness.scheduledFlushes[1]!();

		expect(harness.idleBatches[0]?.map(messageText)).toEqual(["late"]);
	});

	test("a deferred entry stays queued through a flush and is delivered at the next one", async () => {
		const harness = createHarness(false);
		let holding = true;
		harness.queue.register<Entry>("items", {
			isDeferred: () => holding,
			isStale: entry => entry.stale === true,
			build: entries => userMessage(entries.map(entry => entry.id).join(",")),
		});

		harness.queue.enqueue("items", { id: "held" });
		// Deferred: neither delivered nor dropped, and not deliverable yet.
		expect(harness.queue.hasDeliverable("items")).toBe(false);
		await harness.queue.flush("idle");
		expect(harness.idleBatches).toHaveLength(0);
		expect(harness.queue.has("items")).toBe(true);

		holding = false;
		expect(harness.queue.hasDeliverable("items")).toBe(true);
		await harness.queue.flush("idle");

		expect(harness.idleBatches.map(batch => batch.map(messageText))).toEqual([["held"]]);
		expect(harness.queue.has("items")).toBe(false);
	});
	test("requested idle flush preserves skip-only entries", async () => {
		const harness = createHarness(true);
		harness.queue.register<Entry>("advisor", {
			build: entries => userMessage(entries.map(entry => entry.id).join(",")),
			skipIdleFlush: true,
		});
		harness.queue.register<Entry>("completion", {
			build: entries => userMessage(entries.map(entry => entry.id).join(",")),
		});
		harness.queue.enqueue("advisor", { id: "advice" });
		harness.queue.requestIdleFlush();
		expect(harness.scheduledFlushes).toHaveLength(0);

		harness.queue.enqueue("completion", { id: "done" });
		harness.queue.requestIdleFlush();
		harness.setStreaming(false);
		await harness.scheduledFlushes[0]!();

		expect(harness.idleBatches[0]?.map(messageText)).toEqual(["done"]);
		expect(harness.queue.has("advisor")).toBe(true);
	});
	test("enqueue while idle schedules one debounced idle flush", async () => {
		const harness = createHarness(false);
		harness.queue.register<Entry>("items", {
			build: entries => userMessage(entries.map(entry => entry.id).join(",")),
		});

		harness.queue.enqueue("items", { id: "a" });
		harness.queue.enqueue("items", { id: "b" });

		expect(harness.scheduledFlushes).toHaveLength(1);
		expect(harness.idleBatches).toHaveLength(0);

		await harness.scheduledFlushes[0]!();

		expect(harness.idleBatches).toHaveLength(1);
		expect(harness.idleBatches[0]?.map(messageText)).toEqual(["a,b"]);
	});

	test("resolves delivery receipts only after idle injection succeeds", async () => {
		const injected = Promise.withResolvers<void>();
		const scheduledFlushes: Array<() => Promise<void>> = [];
		const queue = new YieldQueue({
			isStreaming: () => false,
			injectIdle: async () => injected.promise,
			scheduleIdleFlush: run => scheduledFlushes.push(run),
		});
		queue.register<Entry>("items", {
			build: entries => userMessage(entries.map(entry => entry.id).join(",")),
		});
		let delivered = false;
		const receipt = queue.enqueueWithReceipt("items", { id: "durable" }).then(() => {
			delivered = true;
		});

		const flush = scheduledFlushes[0]!();
		await Promise.resolve();
		expect(delivered).toBe(false);
		injected.resolve();
		await flush;
		await receipt;
		expect(delivered).toBe(true);
	});

	test("resolves an idle receipt when injection commits before the turn finishes", async () => {
		const finishTurn = Promise.withResolvers<void>();
		const scheduledFlushes: Array<() => Promise<void>> = [];
		const queue = new YieldQueue({
			isStreaming: () => false,
			injectIdle: async messages => {
				(messages[0] as AgentMessage & { [ASIDE_MESSAGE_COMMIT]?: () => void })[ASIDE_MESSAGE_COMMIT]?.();
				await finishTurn.promise;
			},
			scheduleIdleFlush: run => scheduledFlushes.push(run),
		});
		queue.register<Entry>("items", {
			build: entries => userMessage(entries.map(entry => entry.id).join(",")),
		});
		const receipt = queue.enqueueWithReceipt("items", { id: "idle-commit" });

		const flush = scheduledFlushes[0]!();
		await receipt;
		let flushFinished = false;
		void flush.then(() => {
			flushFinished = true;
		});
		await Promise.resolve();
		expect(flushFinished).toBe(false);
		finishTurn.resolve();
		await flush;
	});

	test("isStale drops stale entries and keeps survivors", async () => {
		const harness = createHarness(true);
		let survivorIds: string[] = [];
		harness.queue.register<Entry>("items", {
			isStale: entry => entry.stale === true,
			build: entries => {
				survivorIds = entries.map(entry => entry.id);
				return userMessage(survivorIds.join(","));
			},
		});

		harness.queue.enqueue("items", { id: "old", stale: true });
		harness.queue.enqueue("items", { id: "fresh" });
		await harness.queue.flush("streaming");

		expect(survivorIds).toEqual(["fresh"]);
		expect(harness.streamingMessages.map(messageText)).toEqual(["fresh"]);
	});

	test("build returning null does not inject", async () => {
		const harness = createHarness(true);
		harness.queue.register<Entry>("items", {
			build: () => null,
		});

		harness.queue.enqueue("items", { id: "a" });
		await harness.queue.flush("streaming");

		expect(harness.streamingMessages).toHaveLength(0);
		expect(harness.idleBatches).toHaveLength(0);
	});

	test("one kind failing in build does not abort other kinds", async () => {
		const harness = createHarness(true);
		harness.queue.register<Entry>("bad", {
			build: () => {
				throw new Error("boom");
			},
		});
		harness.queue.register<Entry>("good", {
			build: entries => userMessage(entries.map(entry => entry.id).join(",")),
		});

		harness.queue.enqueue("bad", { id: "bad" });
		harness.queue.enqueue("good", { id: "good" });
		await harness.queue.flush("streaming");

		expect(harness.streamingMessages.map(messageText)).toEqual(["good"]);
	});

	test("flush preserves registration order across kinds", async () => {
		const harness = createHarness(true);
		harness.queue.register<Entry>("second", {
			build: entries => userMessage(entries.map(entry => entry.id).join(",")),
		});
		harness.queue.register<Entry>("first", {
			build: entries => userMessage(entries.map(entry => entry.id).join(",")),
		});

		harness.queue.enqueue("first", { id: "first" });
		harness.queue.enqueue("second", { id: "second" });
		await harness.queue.flush("streaming");

		expect(harness.streamingMessages.map(messageText)).toEqual(["second", "first"]);
	});

	test("drainLazy snapshots+clears immediately but defers build+staleness to the thunk", () => {
		const harness = createHarness(true);
		const staleIds = new Set<string>();
		harness.queue.register<Entry>("items", {
			isStale: entry => staleIds.has(entry.id),
			build: entries => userMessage(entries.map(entry => entry.id).join(",")),
		});

		harness.queue.enqueue("items", { id: "a" });
		harness.queue.enqueue("items", { id: "b" });

		// Snapshot + clear happens at drain; the queue is emptied immediately.
		const thunks = harness.queue.drainLazy();
		expect(thunks).toHaveLength(1);
		expect(harness.queue.has()).toBe(false);

		// A mutation AFTER drainLazy but BEFORE the thunk runs supersedes "b".
		staleIds.add("b");

		// The thunk evaluates staleness at call time (injection), dropping "b".
		const message = thunks[0]!();
		expect(message && messageText(message)).toBe("a");
		// No injection side effects from the pull path.
		expect(harness.streamingMessages).toHaveLength(0);
		expect(harness.idleBatches).toHaveLength(0);
	});

	test("drainLazy thunk returns null when everything is stale by injection time", () => {
		const harness = createHarness(true);
		let stale = false;
		harness.queue.register<Entry>("items", {
			isStale: () => stale,
			build: entries => userMessage(entries.map(entry => entry.id).join(",")),
		});
		harness.queue.enqueue("items", { id: "x" });

		const thunks = harness.queue.drainLazy();
		stale = true; // superseded between drain and injection

		expect(thunks[0]!()).toBeNull();
	});
});

describe("YieldQueue claimAtRequest", () => {
	/** A claimed kind whose entries go stale or deferred when the test says. */
	function claimed() {
		const harness = createHarness(true);
		const stale = new Set<string>();
		const deferred = new Set<string>();
		harness.queue.register<Entry>("notices", {
			isStale: entry => stale.has(entry.id),
			isDeferred: entry => deferred.has(entry.id),
			build: entries => userMessage(entries.map(entry => entry.id).join(",")),
			claimAtRequest: true,
		});
		const settled = new Map<string, "resolved" | "rejected">();
		const enqueue = (id: string) =>
			harness.queue.enqueueWithReceipt<Entry>("notices", { id }).then(
				() => void settled.set(id, "resolved"),
				() => void settled.set(id, "rejected"),
			);
		const build = () => harness.queue.drainLazy()[0]!() as CommittableAsideMessage;
		return { harness, stale, deferred, settled, enqueue, build };
	}

	test("a live message answers itself at the hand-off and is delivered only by its commit", async () => {
		const q = claimed();
		const receipt = q.enqueue("a");
		const message = q.build();
		expect(message[ASIDE_MESSAGE_CLAIM]?.()).toBe(message);
		await Bun.sleep(0);
		expect(q.settled.size).toBe(0);
		message[ASIDE_MESSAGE_COMMIT]?.();
		await receipt;
		expect(q.settled.get("a")).toBe("resolved");
	});

	test("an entry stale at the hand-off is rejected and the rest are rebuilt into a claimable message", async () => {
		const q = claimed();
		const receipts = [q.enqueue("a"), q.enqueue("b")];
		const message = q.build();
		expect(messageText(message)).toBe("a,b");
		q.stale.add("b");
		const rebuilt = message[ASIDE_MESSAGE_CLAIM]?.() as CommittableAsideMessage;
		expect(rebuilt).not.toBe(message);
		expect(messageText(rebuilt)).toBe("a");
		// The withdrawn message can no longer deliver anything.
		message[ASIDE_MESSAGE_COMMIT]?.();
		expect(rebuilt[ASIDE_MESSAGE_CLAIM]?.()).toBe(rebuilt);
		rebuilt[ASIDE_MESSAGE_COMMIT]?.();
		await Promise.all(receipts);
		expect(Object.fromEntries(q.settled)).toEqual({ a: "resolved", b: "rejected" });
	});

	test("an entry deferred at the hand-off goes back to the queue unsettled", async () => {
		const q = claimed();
		void q.enqueue("a");
		const message = q.build();
		q.deferred.add("a");
		expect(message[ASIDE_MESSAGE_CLAIM]?.()).toBeNull();
		await Bun.sleep(0);
		expect(q.settled.size).toBe(0);
		expect(q.harness.queue.has("notices")).toBe(true);
	});

	test("an idle injection that sent no request carrying it rejects the receipt", async () => {
		const queue = new YieldQueue({
			isStreaming: () => false,
			injectIdle: async () => {},
			scheduleIdleFlush: () => {},
		});
		queue.register<Entry>("notices", {
			build: entries => userMessage(entries.map(entry => entry.id).join(",")),
			claimAtRequest: true,
		});
		const receipt = queue.enqueueWithReceipt<Entry>("notices", { id: "folded" });
		await queue.flush("idle");
		await expect(receipt).rejects.toThrow("No model request carried the entry");
	});

	test("a streaming insertion does not deliver a claimed entry", async () => {
		const q = claimed();
		const receipt = q.enqueue("a");
		await q.harness.queue.flush("streaming");
		await Bun.sleep(0);
		expect(q.settled.size).toBe(0);
		const message = q.harness.streamingMessages[0] as CommittableAsideMessage;
		expect(message[ASIDE_MESSAGE_CLAIM]?.()).toBe(message);
		message[ASIDE_MESSAGE_COMMIT]?.();
		await receipt;
		expect(q.settled.get("a")).toBe("resolved");
	});
});

describe("YieldQueue claimAtRequest through the real agent loop", () => {
	/**
	 * One claimed entry, built by the queue as the agent loop drains it, and a
	 * mock provider that records every request it is handed. The receipt says
	 * how the entry ended: delivered only by a request the provider received.
	 */
	function loop() {
		const queue = new YieldQueue({ isStreaming: () => true, injectIdle: async () => {}, scheduleIdleFlush() {} });
		let stale = false;
		queue.register<string>("notice", {
			claimAtRequest: true,
			isStale: () => stale,
			build: ids => ({ role: "user", content: ids.join(","), timestamp: Date.now() }),
		});
		let ended = "pending";
		const receipt = queue.enqueueWithReceipt<string>("notice", "NOTICE_TEXT").then(
			() => void (ended = "delivered"),
			() => void (ended = "discarded"),
		);
		const mock = createMockModel({ responses: [{ content: ["ok"] }, { content: ["ok"] }] });
		const config: AgentLoopConfig = { model: mock.model, convertToLlm: messages => messages as Message[] };
		const context: AgentContext = { systemPrompt: ["test"], messages: [], tools: [] };
		const run = async (prompts: AgentMessage[]) => {
			try {
				for await (const _ of agentLoop(prompts, context, config, undefined, mock.stream)) {
					// drain
				}
			} catch {
				// A failing host callback fails the run; the receipt is what is asserted.
			}
			await receipt;
			return ended;
		};
		const notice = () => queue.drainLazy()[0]!()!;
		/** Whether any request the provider received carried the notice. */
		const carried = () => mock.calls.some(call => JSON.stringify(call.context.messages).includes("NOTICE_TEXT"));
		return {
			mock,
			config,
			context,
			queue,
			run,
			notice,
			carried,
			makeStale: () => {
				stale = true;
			},
		};
	}
	const user: AgentMessage = { role: "user", content: "a real user request", timestamp: 1 };

	for (const callback of ["metadataResolver", "getCwd"] as const) {
		test(`a ${callback} that throws after the gates leaves the notice undelivered`, async () => {
			const l = loop();
			if (callback === "metadataResolver") {
				l.config.metadataResolver = () => {
					throw new Error("metadata failure");
				};
			} else {
				l.config.getCwd = () => {
					throw new Error("cwd failure");
				};
			}
			expect(await l.run([l.notice()])).toBe("discarded");
			expect(l.mock.calls).toHaveLength(0);
		});
	}

	for (const remover of ["transformContext", "beforeModelCall"] as const) {
		test(`a notice ${remover} takes out of the request is not delivered by it`, async () => {
			const l = loop();
			if (remover === "transformContext") {
				l.config.transformContext = async messages =>
					messages.filter(message => !JSON.stringify(message).includes("NOTICE_TEXT"));
			} else {
				l.config.beforeModelCall = context => {
					context.messages = context.messages.filter(message => !JSON.stringify(message).includes("NOTICE_TEXT"));
				};
			}
			expect(await l.run([user, l.notice()])).toBe("discarded");
			// The user's request still goes out, without the notice.
			expect(l.mock.calls.length).toBeGreaterThan(0);
			expect(l.carried()).toBe(false);
		});
	}

	test("a notice the sent request carries is delivered by it", async () => {
		const l = loop();
		expect(await l.run([user, l.notice()])).toBe("delivered");
		expect(l.carried()).toBe(true);
	});

	test("a tracer that fails on the chat span leaves the notice undelivered", async () => {
		const l = loop();
		const fallback = trace.getTracer("aside-claim-test");
		l.config.telemetry = {
			tracer: {
				startSpan(name, options, context) {
					if (name.startsWith("chat ")) throw new Error("tracer failure");
					return fallback.startSpan(name, options, context);
				},
				startActiveSpan: fallback.startActiveSpan.bind(fallback),
			} as Tracer,
		};
		expect(await l.run([user, l.notice()])).toBe("discarded");
		expect(l.mock.calls).toHaveLength(0);
	});

	test("a notice the chat span's start hook makes stale is not delivered", async () => {
		const l = loop();
		l.config.telemetry = {
			onSpanStart(span) {
				if (span.kind === "chat") l.makeStale();
			},
		};
		expect(await l.run([user, l.notice()])).toBe("discarded");
		expect(l.carried()).toBe(false);
	});

	test("a notice a telemetry serializer takes out of the request is not delivered by it", async () => {
		const l = loop();
		const notice = l.notice();
		l.config.telemetry = {
			captureMessageContent: "summary",
			contentSerializer: {
				requestMessages(request) {
					const list = request.messages as Message[];
					list.splice(0, list.length, ...list.filter(message => message !== notice));
					return "observed";
				},
			},
		};
		expect(await l.run([user, notice])).toBe("discarded");
		expect(l.carried()).toBe(false);
	});

	test("a conversion that rewrites the notice by spreading it still delivers it", async () => {
		const l = loop();
		const notice = l.notice();
		l.config.convertToLlm = messages =>
			messages.map(message =>
				message === notice
					? {
							...message,
							content: [
								{ type: "text", text: "NOTICE" },
								{ type: "text", text: "_TEXT" },
							],
						}
					: message,
			) as Message[];
		expect(await l.run([user, notice])).toBe("delivered");
	});

	test("a conversion that rebuilds the notice without its identity counts it lost, not read", async () => {
		const l = loop();
		const notice = l.notice();
		l.config.convertToLlm = messages =>
			messages.map(message =>
				message === notice ? { role: "user", content: "NOTICE_TEXT", timestamp: 2 } : message,
			) as Message[];
		expect(await l.run([user, notice])).toBe("discarded");
	});

	test("the same text earlier in history does not stand in for a removed notice", async () => {
		const l = loop();
		const notice = l.notice();
		l.context.messages.push({ role: "user", content: "NOTICE_TEXT", timestamp: 0 });
		l.config.convertToLlm = messages => messages.filter(message => message !== notice) as Message[];
		expect(await l.run([user, notice])).toBe("discarded");
	});

	test("withdrawing one notice keeps an unrelated claimable aside and rebuilds the request once", async () => {
		const l = loop();
		let other = "pending";
		l.queue.register<string>("other", {
			claimAtRequest: true,
			build: () => ({ role: "user", content: "OTHER_NOTICE", timestamp: 3 }),
		});
		const otherReceipt = l.queue.enqueueWithReceipt<string>("other", "x").then(
			() => void (other = "delivered"),
			() => void (other = "discarded"),
		);
		// One drain builds both kinds: the notice first, as it was registered first.
		const [notice, otherMessage] = l.queue.drainLazy().map(thunk => thunk()!);
		let conversions = 0;
		l.config.convertToLlm = messages => {
			conversions++;
			return messages.filter(message => message !== notice) as Message[];
		};
		expect(await l.run([user, notice, otherMessage])).toBe("discarded");
		await otherReceipt;
		expect(other).toBe("delivered");
		expect(conversions).toBe(2);
		expect(l.mock.calls).toHaveLength(1);
	});
});

describe("YieldQueue claimAtRequest through the production converter and caches", () => {
	const TEXT = "PIPELINE_NOTICE: a child is taking longer than you said";
	const user: AgentMessage = { role: "user", content: "an ordinary request", timestamp: 1 };
	const noticeLike = (timestamp: number): AgentMessage =>
		({
			role: "custom",
			customType: "subagent-overdue",
			content: TEXT,
			display: true,
			attribution: "agent",
			timestamp,
		}) as AgentMessage;
	/** A due-by-shaped notice through the queue, the coding-agent converter and the real loop. */
	function pipeline() {
		let ended = "pending";
		let stale = false;
		const queue = new YieldQueue({ isStreaming: () => true, injectIdle: async () => {}, scheduleIdleFlush() {} });
		queue.register<string>("notice", { claimAtRequest: true, isStale: () => stale, build: () => noticeLike(2) });
		const receipt = queue.enqueueWithReceipt<string>("notice", "x").then(
			() => void (ended = "delivered"),
			() => void (ended = "discarded"),
		);
		const notice = queue.drainLazy()[0]!()!;
		const mock = createMockModel({ responses: [{ content: ["ok"] }] });
		const config: AgentLoopConfig = { model: mock.model, convertToLlm };
		const context: AgentContext = { systemPrompt: ["test"], messages: [], tools: [] };
		const run = async () => {
			try {
				for await (const _ of agentLoop([user, notice], context, config, undefined, mock.stream)) {
					// drain
				}
			} catch {
				// A failing host callback fails the run; the receipt is what is asserted.
			}
			await receipt;
			return {
				ended,
				calls: mock.calls.length,
				carried: mock.calls.some(call => JSON.stringify(call.context.messages).includes(TEXT)),
			};
		};
		return {
			notice,
			config,
			run,
			makeStale: () => {
				stale = true;
			},
		};
	}

	for (const growth of [false, true]) {
		test(`a notice converted before the loop takes it in is delivered (${growth ? "array grew" : "same array"})`, async () => {
			const p = pipeline();
			const stable: AgentMessage[] = [user, p.notice, { role: "user", content: "tail", timestamp: 3 }];
			convertToLlm(stable);
			if (growth) stable.push({ role: "user", content: "growth", timestamp: 4 });
			p.config.transformContext = async () => stable;
			expect(await p.run()).toEqual({ ended: "delivered", calls: 1, carried: true });
		});
	}

	test("an append-only log entry with the same bytes stands for the new notice", async () => {
		const p = pipeline();
		const appendOnly = new AppendOnlyContextManager();
		appendOnly.syncMessages(convertToLlm([user, noticeLike(2)]));
		p.config.appendOnlyContext = appendOnly;
		expect(await p.run()).toEqual({ ended: "delivered", calls: 1, carried: true });
	});

	test("an identical notice after a stopped request is delivered through the same append-only log", async () => {
		const appendOnly = new AppendOnlyContextManager();
		const first = pipeline();
		first.config.appendOnlyContext = appendOnly;
		first.config.beforeModelCall = () => ({ stop: true });
		expect((await first.run()).ended).toBe("discarded");
		const next = pipeline();
		next.config.appendOnlyContext = appendOnly;
		expect(await next.run()).toEqual({ ended: "delivered", calls: 1, carried: true });
	});

	test("a host option getter that throws runs before the notice is committed", async () => {
		const p = pipeline();
		Object.defineProperty(p.config, "onPayload", {
			enumerable: true,
			get() {
				throw new Error("host option getter");
			},
		});
		expect(await p.run()).toEqual({ ended: "discarded", calls: 0, carried: false });
	});

	test("a host option getter cannot make a notice stale after it is committed", async () => {
		const p = pipeline();
		Object.defineProperty(p.config, "onPayload", {
			enumerable: true,
			get() {
				p.makeStale();
				return undefined;
			},
		});
		const result = await p.run();
		expect(result.ended).toBe("discarded");
		expect(result.carried).toBe(false);
	});

	/** One claimed notice with `content`, built by its own queue; `ended()` reads how its receipt settled. */
	function claimed(content: string) {
		let ended = "pending";
		const queue = new YieldQueue({ isStreaming: () => true, injectIdle: async () => {}, scheduleIdleFlush() {} });
		queue.register<string>("notice", {
			claimAtRequest: true,
			build: () => ({ ...noticeLike(2), content }) as AgentMessage,
		});
		const receipt = queue.enqueueWithReceipt<string>("notice", "x").then(
			() => void (ended = "delivered"),
			() => void (ended = "discarded"),
		);
		return { message: queue.drainLazy()[0]!()!, receipt, ended: () => ended };
	}
	async function loopWith(prompts: AgentMessage[], extra: Partial<AgentLoopConfig>) {
		const mock = createMockModel({ responses: [{ content: ["ok"] }] });
		const config: AgentLoopConfig = { model: mock.model, convertToLlm, ...extra };
		for await (const _ of agentLoop(
			prompts,
			{ systemPrompt: ["test"], messages: [], tools: [] },
			config,
			undefined,
			mock.stream,
		)) {
			// drain
		}
		return mock;
	}

	test("reordering two identical notices through the append-only log delivers both", async () => {
		const a = claimed(TEXT);
		const b = claimed(TEXT);
		const appendOnly = new AppendOnlyContextManager();
		appendOnly.syncMessages(convertToLlm([a.message, b.message]));
		const mock = await loopWith([a.message, b.message], {
			appendOnlyContext: appendOnly,
			transformContext: async messages => messages.toReversed(),
		});
		await Promise.all([a.receipt, b.receipt]);
		expect({ first: a.ended(), second: b.ended() }).toEqual({ first: "delivered", second: "delivered" });
		expect(mock.calls[0]!.context.messages.filter(message => JSON.stringify(message).includes(TEXT))).toHaveLength(2);
	});

	test("syncing the append-only log never changes the identity of a converted message", () => {
		const a = claimed(TEXT);
		const b = claimed(TEXT);
		const previous = convertToLlm([a.message, b.message]);
		const identities = previous.map(message => (message as AsideProvenanceCarrier)[kAsideProvenance]);
		const appendOnly = new AppendOnlyContextManager();
		appendOnly.syncMessages(previous);
		appendOnly.syncMessages([previous[1]!, previous[0]!]);
		expect(previous.map(message => (message as AsideProvenanceCarrier)[kAsideProvenance])).toEqual(identities);
		expect(identities[0]).not.toBe(identities[1]);
	});

	test("a kept append-only entry that only hashes like the notice is not counted as carrying it", async () => {
		// "Aa" and "BB" share the log's 32-bit digest; the provider must get the notice, not the old entry.
		const old = { ...noticeLike(2), content: "Aa is taking longer than you said" } as AgentMessage;
		const n = claimed("BB is taking longer than you said");
		const appendOnly = new AppendOnlyContextManager();
		appendOnly.syncMessages(convertToLlm([old]));
		const mock = await loopWith([n.message], { appendOnlyContext: appendOnly });
		await n.receipt;
		const sent = JSON.stringify(mock.calls[0]?.context.messages);
		expect(sent).toContain("BB is taking longer");
		expect(sent).not.toContain("Aa is taking longer");
		expect(n.ended()).toBe("delivered");
	});

	/** A claimed notice that goes stale on demand. */
	function staleable() {
		let ended = "pending";
		let stale = false;
		const queue = new YieldQueue({ isStreaming: () => true, injectIdle: async () => {}, scheduleIdleFlush() {} });
		queue.register<string>("notice", { claimAtRequest: true, isStale: () => stale, build: () => noticeLike(2) });
		const receipt = queue.enqueueWithReceipt<string>("notice", "x").then(
			() => void (ended = "delivered"),
			() => void (ended = "discarded"),
		);
		return {
			message: queue.drainLazy()[0]!()!,
			receipt,
			ended: () => ended,
			makeStale: () => {
				stale = true;
			},
		};
	}
	const carriedBy = (mock: Awaited<ReturnType<typeof loopWith>>) =>
		mock.calls.some(call => JSON.stringify(call.context.messages).includes(TEXT));

	for (const where of ["transformContext", "transformProviderContext"] as const) {
		test(`a ${where} cache cannot send a notice withdrawn at the previous hand-off`, async () => {
			const n = staleable();
			let cachedMessages: AgentMessage[] | undefined;
			let cachedContext: Context | undefined;
			let transforms = 0;
			const mock = await loopWith([user, n.message], {
				// Made stale while the first request is prepared; the rebuilt request then
				// gets the host's cached copy, which still descends from the notice.
				beforeModelCall: () => n.makeStale(),
				...(where === "transformContext"
					? {
							transformContext: async messages => {
								if (++transforms > 5) throw new Error("withdrawal loop");
								cachedMessages ??= messages.map(message => ({ ...message }));
								return cachedMessages;
							},
						}
					: {
							transformProviderContext: context => {
								if (++transforms > 5) throw new Error("withdrawal loop");
								cachedContext ??= { ...context, messages: context.messages.map(message => ({ ...message })) };
								return cachedContext;
							},
						}),
			});
			await n.receipt;
			expect(n.ended()).toBe("discarded");
			expect(mock.calls).toHaveLength(1);
			expect(carriedBy(mock)).toBe(false);
		});
	}

	test("a later run cannot send a descendant of a notice that ended unsent", async () => {
		const n = staleable();
		n.makeStale();
		const first = await loopWith([user, n.message], {});
		await n.receipt;
		expect(n.ended()).toBe("discarded");
		expect(carriedBy(first)).toBe(false);
		// A host that kept a spread of the notice puts it into the next run's context.
		const later = await loopWith([{ ...user, content: "next turn" }], {
			transformContext: async messages => [...messages, { ...n.message }],
		});
		expect(later.calls).toHaveLength(1);
		expect(carriedBy(later)).toBe(false);
	});

	test("a delivered notice stays sendable in later requests", async () => {
		const n = staleable();
		const first = await loopWith([user, n.message], {});
		await n.receipt;
		expect(n.ended()).toBe("delivered");
		expect(carriedBy(first)).toBe(true);
		const later = await loopWith([{ ...user, content: "next turn" }], {
			transformContext: async messages => [user, n.message, ...messages],
		});
		expect(carriedBy(later)).toBe(true);
	});
});
