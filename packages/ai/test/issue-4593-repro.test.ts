import { describe, expect, it } from "bun:test";
import { setBedrockProviderModule, streamBedrock } from "@oh-my-pi/pi-ai/providers/register-builtins";
import type { AssistantMessage, Context, Model } from "@oh-my-pi/pi-ai/types";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { iterateWithIdleTimeout } from "@oh-my-pi/pi-ai/utils/idle-iterator";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

// Issue #4593: the generic lazy stream watchdog treats "no AssistantMessageEvent"
// as "provider stalled". During a Cursor exec-channel round-trip the server is
// waiting on OUR local tool result and legitimately sends nothing, so a local
// tool outliving the idle budget aborted a healthy stream with "Provider stream
// stalled while waiting for the next event". Provider streams now advertise
// pending local work and the watchdog slides its deadline instead of aborting.
//
// These tests exercise the real watchdog timer against the platform clock (that
// timer IS the unit under test), but never guess durations: the simulated local
// work completes only once the watchdog has demonstrably reached an expired
// deadline and consulted the local-work probe, so the tests stay causal on a
// loaded machine. Budgets are tens of milliseconds — wide enough that a noisy
// virtualized CI runner cannot make a single scheduling hiccup span a full
// idle budget.

function createModel(): Model<"bedrock-converse-stream"> {
	return buildModel({
		id: "mock-bedrock",
		name: "Mock Bedrock",
		api: "bedrock-converse-stream",
		provider: "amazon-bedrock",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 2048,
	});
}

function createAssistantMessage(): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "ok" }],
		api: "bedrock-converse-stream",
		provider: "amazon-bedrock",
		model: "mock-bedrock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

const baseContext: Context = { messages: [] };

describe("idle watchdog local-work deferral (issue #4593)", () => {
	it("slides the idle deadline while consumer-side local work is pending", async () => {
		const workDone = Promise.withResolvers<void>();
		let probeCalls = 0;
		let busy = true;
		async function* source() {
			yield "first";
			// The "local tool": finishes only after the watchdog has hit an
			// expired deadline twice and deferred both times.
			await workDone.promise;
			busy = false;
			yield "second";
		}
		let idleFired = false;
		const items: string[] = [];
		for await (const item of iterateWithIdleTimeout(source(), {
			idleTimeoutMs: 50,
			errorMessage: "stalled",
			onIdle: () => {
				idleFired = true;
			},
			hasPendingLocalWork: () => {
				probeCalls++;
				if (probeCalls >= 2) workDone.resolve();
				return busy;
			},
		})) {
			items.push(item);
		}
		expect(items).toEqual(["first", "second"]);
		expect(probeCalls).toBeGreaterThanOrEqual(2);
		expect(idleFired).toBe(false);
	});

	it("still aborts a silent stream once local work has finished", async () => {
		const workDone = Promise.withResolvers<void>();
		let busy = true;
		async function* source() {
			yield "first";
			await workDone.promise;
			busy = false;
			// The provider genuinely stalls after the local work completed.
			await new Promise<never>(() => {});
			yield "never";
		}
		const items: string[] = [];
		let error: Error | undefined;
		try {
			for await (const item of iterateWithIdleTimeout(source(), {
				idleTimeoutMs: 50,
				errorMessage: "stalled",
				hasPendingLocalWork: () => {
					workDone.resolve();
					return busy;
				},
			})) {
				items.push(item);
			}
		} catch (err) {
			error = err as Error;
		}
		expect(items).toEqual(["first"]);
		expect(error?.message).toBe("stalled");
	});

	it("slides the first-event deadline while local work is pending", async () => {
		const workDone = Promise.withResolvers<void>();
		let probeCalls = 0;
		let busy = true;
		async function* source() {
			// Local bridge work before the model has produced any event.
			await workDone.promise;
			yield "first";
		}
		const items: string[] = [];
		for await (const item of iterateWithIdleTimeout(source(), {
			idleTimeoutMs: 50,
			firstItemTimeoutMs: 50,
			errorMessage: "stalled",
			firstItemErrorMessage: "first event timed out",
			hasPendingLocalWork: () => {
				probeCalls++;
				if (probeCalls >= 2) workDone.resolve();
				return busy;
			},
		})) {
			items.push(item);
			busy = false;
		}
		expect(items).toEqual(["first"]);
		expect(probeCalls).toBeGreaterThanOrEqual(2);
	});

	it("does not abort a lazy provider stream while tracked local work outlives the idle budget", async () => {
		const workDone = Promise.withResolvers<void>();
		// Counts how often the lazy wrapper's watchdog consults the stream's
		// local-work state at an expired deadline; the tracked work completes
		// only after two deferrals, proving the budget was truly exceeded.
		class ProbedStream extends AssistantMessageEventStream {
			probeCalls = 0;
			override get hasPendingLocalWork(): boolean {
				this.probeCalls++;
				if (this.probeCalls >= 2) workDone.resolve();
				return super.hasPendingLocalWork;
			}
		}
		const source = new ProbedStream();
		let providerSignal: AbortSignal | undefined;
		setBedrockProviderModule({
			streamBedrock: (_model, _context, options) => {
				providerSignal = options.signal;
				void (async () => {
					const partial = createAssistantMessage();
					source.push({ type: "start", partial });
					source.push({ type: "text_delta", contentIndex: 0, delta: "running a local tool", partial });
					// Server-driven local tool run: no events flow while the
					// tracked work is pending.
					await source.trackLocalWork(workDone.promise);
					source.push({ type: "done", reason: "stop", message: createAssistantMessage() });
				})();
				return source;
			},
		});

		const stream = streamBedrock(createModel(), baseContext, { streamIdleTimeoutMs: 50 });
		const result = await stream.result();

		expect(providerSignal?.aborted).toBe(false);
		expect(source.probeCalls).toBeGreaterThanOrEqual(2);
		expect(result.stopReason).toBe("stop");
		expect(result.errorMessage).toBeUndefined();
	});
});
