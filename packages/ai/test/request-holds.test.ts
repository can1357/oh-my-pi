import { describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";
import {
	afterRequestHolds,
	captureRequestHolds,
	exemptFromRequestHolds,
	type RequestHoldView,
	type RequestHolds,
	RequestHoldsAlias,
	type RequestHoldContext,
	runOutsideRequestHolds,
	openRequestHolds,
	runWithRequestHoldView,
	runWithRequestHolds,
} from "@oh-my-pi/pi-ai";
import { heldFetch } from "@oh-my-pi/pi-ai/utils/held-fetch";

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

	it("sends nothing when the signal aborts after the hold lets go but before the send's turn", async () => {
		const holds = new TestHolds();
		const controller = new AbortController();
		const sent = runWithRequestHolds(holds, () => request(controller.signal));
		await turns(2);
		holds.let();
		// Queued behind the hold's release, ahead of the gate's continuation.
		queueMicrotask(() => controller.abort());
		await expect(sent.result!).rejects.toThrow();
		expect(sent.sent).toBe(false);
	});

	it("opens a view of its own when the request it carried a view for ends while it waits", async () => {
		const holds = new TestHolds();
		// The request's own view, which stops holding once released.
		let viewReleased = false;
		const wake = Promise.withResolvers<void>();
		const carried: RequestHoldView = {
			check: () => (viewReleased ? undefined : wake.promise),
			release: () => {
				viewReleased = true;
			},
		};
		let sent: SentRequest | undefined;
		await runWithRequestHoldView(holds, carried, async () => {
			sent = request();
		});
		carried.release();
		// The owner ended and released its view; the hold itself still holds.
		wake.resolve();
		await turns();
		expect({ sent: sent?.sent, opened: holds.opened }).toEqual({ sent: false, opened: 1 });
		holds.let();
		await sent?.result;
		expect(sent?.sent).toBe(true);
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

	it("keeps the carried view when a request re-enters the holds it carries", async () => {
		const holds = new TestHolds();
		holds.armed = false;
		const view = holds.open();
		await runWithRequestHoldView(holds, view, () =>
			runWithRequestHolds(holds, () => afterRequestHolds(undefined, () => undefined)),
		);
		// The send used the carried view: it opened none of its own.
		expect(holds.opened).toBe(1);
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

describe("what the last check covers", () => {
	it("holds work an exempt step left behind once the step settled", async () => {
		const holds = new TestHolds();
		const later = Promise.withResolvers<void>();
		let sent: SentRequest | undefined;
		await runWithRequestHolds(holds, () =>
			runOutsideRequestHolds(holds, async () => {
				// Work the step schedules for after it is done, and a context it hands on.
				const context = captureRequestHolds();
				void later.promise.then(() => {
					sent = context.run(() => request());
				});
			}),
		);
		later.resolve();
		await turns();
		expect(sent?.sent).toBe(false);
		holds.let();
		await sent?.result;
		expect(sent?.sent).toBe(true);
	});

	it("holds work an exempt step left behind when only the step itself named the holds", async () => {
		const holds = new TestHolds();
		const later = Promise.withResolvers<void>();
		let sent: SentRequest | undefined;
		// The exemption comes first, as for a handler a host runs outside any of its own work.
		await runOutsideRequestHolds(holds, () =>
			runWithRequestHolds(holds, async () => {
				void later.promise.then(() => {
					sent = request();
				});
			}),
		);
		later.resolve();
		await turns();
		expect(sent?.sent).toBe(false);
		holds.let();
		await sent?.result;
		expect(sent?.sent).toBe(true);
	});

	it("holds a request that borrowed an outer request's view, once that request ended, with a view of its own", async () => {
		const holds = new TestHolds();
		// The outer request's view stops holding once released; the holds themselves still hold.
		let released = false;
		const wake = Promise.withResolvers<void>();
		const outerView: RequestHoldView = {
			check: () => (released ? undefined : wake.promise),
			release: () => {
				released = true;
			},
		};
		let sent: SentRequest | undefined;
		await runWithRequestHoldView(holds, outerView, async () => {
			const inner = openRequestHolds();
			void inner.carry(async () => {
				sent = request();
				await sent.result;
			});
		});
		outerView.release();
		wake.resolve();
		await turns();
		expect({ sent: sent?.sent, opened: holds.opened }).toEqual({ sent: false, opened: 1 });
		holds.let();
		await sent?.result;
		expect(sent?.sent).toBe(true);
	});

	it("holds work started before its owning context existed by that context's holds, once bound", async () => {
		const alias = new RequestHoldsAlias();
		const owner = new TestHolds();
		// Not bound yet: nothing holds.
		const early = runWithRequestHolds(alias, () => request());
		await early.result;
		expect(early.sent).toBe(true);
		const pending = Promise.withResolvers<() => SentRequest>();
		runWithRequestHolds(alias, () => {
			const context = captureRequestHolds();
			pending.resolve(() => context.run(() => request()));
		});
		alias.bind(runWithRequestHolds(owner, captureRequestHolds));
		const sent = (await pending.promise)();
		await turns();
		expect(sent.sent).toBe(false);
		owner.let();
		await sent.result;
		expect(sent.sent).toBe(true);
		// In both the alias's context and the owner's, the owner's holds are asked once.
		const both = runWithRequestHolds(owner, () => runWithRequestHolds(alias, () => request()));
		await both.result;
		expect(owner.opened).toBe(2);
	});

	it("opens every view before the last checks, so a view's opening cannot slip past an earlier check", async () => {
		const checkedFirst = new TestHolds();
		checkedFirst.armed = false;
		// Its opening is host code that makes the nearer holds hold.
		const openedLater: RequestHolds = {
			open: () => {
				checkedFirst.armed = true;
				return { check: () => undefined, release: () => {} };
			},
		};
		const sent = runWithRequestHolds(openedLater, () => runWithRequestHolds(checkedFirst, () => request()));
		await turns();
		expect(sent.sent).toBe(false);
		checkedFirst.let();
		await sent.result;
		expect(sent.sent).toBe(true);
	});

	it("wakes a send waiting on a carried view when its request ends, and goes on with a view of its own", async () => {
		const holds = new TestHolds();
		holds.armed = false;
		// A carried view whose wait never settles by itself.
		const carried: RequestHoldView = { check: () => Promise.withResolvers<void>().promise, release: () => {} };
		let sent: SentRequest | undefined;
		await runWithRequestHoldView(holds, carried, async () => {
			sent = request();
		});
		await turns();
		expect({ sent: sent?.sent, opened: holds.opened }).toEqual({ sent: true, opened: 1 });
		await sent?.result;
	});
});

describe("heldFetch", () => {
	it("reads the signal as fetch does: an explicit null replaces the Request's aborted signal", async () => {
		const holds = new TestHolds();
		holds.armed = false;
		const calls: string[] = [];
		const fetchImpl = async (input: string | URL | Request) => {
			calls.push(input instanceof Request ? input.url : String(input));
			return new Response("ok");
		};
		const aborted = new AbortController();
		aborted.abort(new Error("old request"));
		const input = new Request("http://held.test/v1", { signal: aborted.signal });
		const held = heldFetch(fetchImpl);
		await runWithRequestHolds(holds, async () => {
			await held(input, { signal: null });
			await expect(held(input, {})).rejects.toThrow("old request");
		});
		expect(calls).toEqual(["http://held.test/v1"]);
	});
});

describe("openRequestHolds", () => {
	it("carries one view per holds of the context, so every send inside a request spends each hold once", async () => {
		const parent = new TestHolds();
		const own = new TestHolds();
		parent.armed = false;
		own.armed = false;
		const ownView = own.open();
		await runWithRequestHolds(parent, () =>
			runWithRequestHolds(own, async () => {
				const views = openRequestHolds({ holds: own, view: ownView });
				try {
					expect(views.check()).toBeUndefined();
					await views.carry(async () => {
						await afterRequestHolds(undefined, () => undefined);
						await afterRequestHolds(undefined, () => undefined);
					});
				} finally {
					views.release();
				}
			}),
		);
		// The parent's one view, opened by `openRequestHolds`; the own holds only through the view given.
		expect({ parent: [parent.opened, parent.released], own: [own.opened, own.released] }).toEqual({
			parent: [1, 1],
			own: [1, 0],
		});
		ownView.release();
	});

	it("leaves out a holds the context is exempt from, even given as the request's own; else counts it, in the context or not", () => {
		const holds = new TestHolds();
		const view = holds.open();
		// Outside any context the own holds still counts.
		expect(exemptFromRequestHolds(holds)).toBe(false);
		expect(openRequestHolds({ holds, view }).check()).toBeDefined();
		runWithRequestHolds(holds, () => {
			runOutsideRequestHolds(holds, () => {
				expect(runWithRequestHolds(holds, () => exemptFromRequestHolds(holds))).toBe(true);
				expect(openRequestHolds({ holds, view }).check()).toBeUndefined();
			});
		});
		view.release();
	});

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

	it("captures exemptions while they last, but not carried views", async () => {
		const holds = new TestHolds();
		const own = new TestHolds();
		own.armed = false;
		const view = own.open();
		const captured = Promise.withResolvers<RequestHoldContext>();
		const stepDone = Promise.withResolvers<void>();
		const step = runWithRequestHolds(holds, () =>
			runOutsideRequestHolds(holds, () =>
				runWithRequestHoldView(own, view, async () => {
					captured.resolve(captureRequestHolds());
					await stepDone.promise;
				}),
			),
		);
		const context = await captured.promise;
		expect(context.holds).toEqual([own]);
		// Run from outside the step while it lasts: exempt from `holds`.
		const during = context.run(() => request());
		await during.result;
		expect(during.sent).toBe(true);
		// The captured context opened its own view rather than the carrying request's.
		expect(own.opened).toBe(2);
		stepDone.resolve();
		await step;
		// Once the step settled, the same context is held by `holds` again.
		const after = context.run(() => request());
		await turns();
		expect(after.sent).toBe(false);
		holds.let();
		await after.result;
		expect(after.sent).toBe(true);
		view.release();
	});
});
