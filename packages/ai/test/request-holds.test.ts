import { describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";
import {
	afterRequestHolds,
	captureRequestHolds,
	type RequestHoldView,
	type RequestHolds,
	type RequestHoldContext,
	runOutsideRequestHolds,
	openRequestHolds,
	runWithRequestHoldView,
	runWithRequestHolds,
} from "@oh-my-pi/pi-ai";

/** A hold that holds while `armed`, counting the views it opened and released. */
class TestHolds implements RequestHolds {
	armed = true;
	release = Promise.withResolvers<void>();
	opened = 0;
	released = 0;
	checks = 0;
	open(): RequestHoldView {
		this.opened++;
		let released = false;
		return {
			check: () => {
				this.checks++;
				return this.armed ? this.release.promise : undefined;
			},
			release: () => {
				if (released) throw new Error("view released twice");
				released = true;
				this.released++;
			},
		};
	}
	let(): void {
		this.armed = false;
		this.release.resolve();
	}
}

async function turns(count = 10): Promise<void> {
	for (let i = 0; i < count; i++) {
		const turn = Promise.withResolvers<void>();
		setImmediate(turn.resolve);
		await turn.promise;
	}
}

interface SentRequest {
	sent: boolean;
	result: Promise<string> | undefined;
}

/** Starts a "request" through the gate and reports whether it was sent. */
function request(signal?: AbortSignal): SentRequest {
	const state: SentRequest = { sent: false, result: undefined };
	state.result = afterRequestHolds(signal, () => {
		state.sent = true;
		return "sent";
	});
	return state;
}

describe("afterRequestHolds", () => {
	it("sends at once outside any context", async () => {
		const sent = request();
		expect(sent.sent).toBe(true);
		expect(await sent.result).toBe("sent");
	});

	it("holds a request started in the context until the hold lets go, then releases the view it opened", async () => {
		const holds = new TestHolds();
		const sent = runWithRequestHolds(holds, () => request());
		await turns();
		expect(sent.sent).toBe(false);
		holds.let();
		expect(await sent.result).toBe("sent");
		expect({ opened: holds.opened, released: holds.released }).toEqual({ opened: 1, released: 1 });
	});

	it("runs the last check and the send in one turn: a hold added a microtask later does not hold it", async () => {
		const holds = new TestHolds();
		holds.armed = false;
		const order: string[] = [];
		const late = new TestHolds();
		const wrapped: RequestHolds = {
			open: () => {
				const view = holds.open();
				return {
					check: () => {
						queueMicrotask(() => order.push("microtask"));
						return view.check();
					},
					release: () => view.release(),
				};
			},
		};
		await runWithRequestHolds(wrapped, () =>
			runWithRequestHolds(late, async () => {
				late.armed = false;
				await afterRequestHolds(undefined, () => order.push("send"));
			}),
		);
		expect(order).toEqual(["send", "microtask"]);
	});

	it("rejects with an abort when the signal aborts while held, without sending", async () => {
		const holds = new TestHolds();
		const controller = new AbortController();
		const sent = runWithRequestHolds(holds, () => request(controller.signal));
		await turns(2);
		controller.abort();
		await expect(sent.result!).rejects.toThrow();
		expect(sent.sent).toBe(false);
		expect(holds.released).toBe(holds.opened);
	});

	it("waits for every holds of the context, nested contexts included", async () => {
		const outer = new TestHolds();
		const inner = new TestHolds();
		const sent = runWithRequestHolds(outer, () => runWithRequestHolds(inner, () => request()));
		await turns();
		inner.let();
		await turns();
		expect(sent.sent).toBe(false);
		outer.let();
		await sent.result;
		expect(sent.sent).toBe(true);
	});

	it("uses the view a request carries, so every check of that request shares it", async () => {
		const holds = new TestHolds();
		holds.armed = false;
		const view = holds.open();
		await runWithRequestHolds(holds, () =>
			runWithRequestHoldView(holds, view, async () => {
				await afterRequestHolds(undefined, () => undefined);
				await afterRequestHolds(undefined, () => undefined);
			}),
		);
		// Only the carried view: neither send opened one of its own.
		expect(holds.opened).toBe(1);
		expect(holds.released).toBe(0);
		view.release();
	});

	it("opens a fresh view for work a carrying request left running after it ended", async () => {
		const holds = new TestHolds();
		holds.armed = false;
		const view = holds.open();
		const go = Promise.withResolvers<void>();
		let later: Promise<unknown> | undefined;
		await runWithRequestHoldView(holds, view, async () => {
			later = go.promise.then(() => afterRequestHolds(undefined, () => undefined));
		});
		go.resolve();
		await later;
		expect({ opened: holds.opened, released: holds.released }).toEqual({ opened: 2, released: 1 });
	});

	it("lets work the holds wait for run outside them, other holds still applying", async () => {
		const own = new TestHolds();
		const parent = new TestHolds();
		const sent = runWithRequestHolds(parent, () =>
			runWithRequestHolds(own, () => runOutsideRequestHolds(own, () => request())),
		);
		await turns();
		expect(sent.sent).toBe(false);
		expect(own.opened).toBe(0);
		parent.let();
		await sent.result;
		expect(sent.sent).toBe(true);
	});

	it("keeps the exemption for everything the exempt work starts, a re-entry of the same holds included", async () => {
		const own = new TestHolds();
		const view = own.open();
		const sent = await runWithRequestHolds(own, () =>
			runOutsideRequestHolds(own, () =>
				runWithRequestHolds(own, () => runWithRequestHoldView(own, view, async () => request())),
			),
		);
		await sent.result;
		expect(sent.sent).toBe(true);
		// Only the view this test opened: the exempt send opened none and checked none.
		expect({ opened: own.opened, checks: own.checks }).toEqual({ opened: 1, checks: 0 });
		view.release();
	});
});

describe("openRequestHolds", () => {
	it("checks every holds of the context, the carried view included, and releases only the views it opened", async () => {
		const outer = new TestHolds();
		const inner = new TestHolds();
		outer.armed = false;
		const carried = inner.open();
		const held = await runWithRequestHolds(outer, () =>
			runWithRequestHoldView(inner, carried, async () => {
				const view = openRequestHolds();
				const first = view.check();
				inner.let();
				const second = view.check();
				view.release();
				return { first: first !== undefined, second };
			}),
		);
		expect(held).toEqual({ first: true, second: undefined });
		// One carried view (not released here) and one view opened for `outer`, released.
		expect({ inner: [inner.opened, inner.released], outer: [outer.opened, outer.released] }).toEqual({
			inner: [1, 0],
			outer: [1, 1],
		});
		carried.release();
	});
});

describe("request hold context propagation", () => {
	// Real schedulers on purpose: the contract is that the runtime carries the
	// async context through each of them, which fake timers would not exercise.
	const schedulers: Record<string, (fn: () => void) => void> = {
		setTimeout: fn => setTimeout(fn, 1),
		setInterval: fn => {
			const interval = setInterval(() => {
				clearInterval(interval);
				fn();
			}, 1);
		},
		setImmediate: fn => setImmediate(fn),
		"process.nextTick": fn => process.nextTick(fn),
		queueMicrotask: fn => queueMicrotask(fn),
		"promise continuation": fn => void Promise.resolve().then(fn),
		"event emitter": fn => {
			const emitter = new EventEmitter();
			emitter.on("go", fn);
			setTimeout(() => emitter.emit("go"), 1);
		},
	};
	for (const [name, schedule] of Object.entries(schedulers)) {
		it(`holds a request started from ${name}`, async () => {
			const holds = new TestHolds();
			const started = Promise.withResolvers<SentRequest>();
			runWithRequestHolds(holds, () => schedule(() => started.resolve(request())));
			const sent = await started.promise;
			await turns();
			expect(sent.sent).toBe(false);
			holds.let();
			await sent.result;
			expect(sent.sent).toBe(true);
		});
	}

	it("does not carry a context into a Worker message handler; a captured context does", async () => {
		const holds = new TestHolds();
		const source = URL.createObjectURL(
			new Blob(["self.onmessage = event => postMessage(event.data);"], { type: "application/javascript" }),
		);
		const worker = new Worker(source);
		try {
			const results: SentRequest[] = [];
			const received = Promise.withResolvers<void>();
			runWithRequestHolds(holds, () => {
				const context = captureRequestHolds();
				worker.onmessage = event => {
					results.push(event.data === "captured" ? context.run(() => request()) : request());
					if (results.length === 2) received.resolve();
				};
				worker.postMessage("bare");
				worker.postMessage("captured");
			});
			await received.promise;
			await turns();
			const [bare, captured] = results;
			// The bare handler ran outside the context: nothing held it.
			expect(bare?.sent).toBe(true);
			expect(captured?.sent).toBe(false);
			holds.let();
			await captured?.result;
			expect(captured?.sent).toBe(true);
		} finally {
			worker.terminate();
			URL.revokeObjectURL(source);
		}
	});

	it("captures exemptions but not carried views", async () => {
		const holds = new TestHolds();
		const own = new TestHolds();
		own.armed = false;
		const view = own.open();
		let context: RequestHoldContext | undefined;
		await runWithRequestHolds(holds, () =>
			runOutsideRequestHolds(holds, () =>
				runWithRequestHoldView(own, view, async () => {
					context = captureRequestHolds();
				}),
			),
		);
		expect(context?.holds).toEqual([own]);
		const sent = context!.run(() => request());
		await sent.result;
		expect(sent.sent).toBe(true);
		// The captured context opened its own view rather than the ended request's.
		expect(own.opened).toBe(2);
		view.release();
	});
});
