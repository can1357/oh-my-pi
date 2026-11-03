import { describe, expect, it } from "bun:test";
import { heapStats } from "bun:jsc";
import { EventEmitter } from "node:events";
import { createContext, runInContext } from "node:vm";
import {
	afterRequestHolds,
	captureRequestHolds,
	exemptFromRequestHolds,
	type RequestHoldView,
	type RequestHoldViews,
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

	it("lets work the holds wait for run outside them while it lasts, other holds still applying", async () => {
		const own = new TestHolds();
		const parent = new TestHolds();
		const started = Promise.withResolvers<SentRequest>();
		const step = runWithRequestHolds(parent, () =>
			runWithRequestHolds(own, () =>
				runOutsideRequestHolds(own, async () => {
					// Work that waits for its own request, as a handler does.
					const sent = request();
					started.resolve(sent);
					await sent.result;
				}),
			),
		);
		const sent = await started.promise;
		await turns();
		expect(sent.sent).toBe(false);
		expect(own.opened).toBe(0);
		parent.let();
		await step;
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

	it("asks again which holds apply while a send waits: an exemption that ended, an alias bound meanwhile", async () => {
		const parent = new TestHolds();
		const own = new TestHolds();
		const owner = new TestHolds();
		const alias = new RequestHoldsAlias();
		const step = Promise.withResolvers<void>();
		let exemptSend: SentRequest | undefined;
		let aliasSend: SentRequest | undefined;
		// Both sends first wait on `parent`; meanwhile the exemption ends and the alias is bound.
		const exempt = runWithRequestHolds(parent, () =>
			runWithRequestHolds(own, () =>
				runOutsideRequestHolds(own, async () => {
					exemptSend = request();
					await step.promise;
				}),
			),
		);
		runWithRequestHolds(parent, () =>
			runWithRequestHolds(alias, () => {
				aliasSend = request();
			}),
		);
		await turns();
		step.resolve();
		await exempt;
		alias.bind(runWithRequestHolds(owner, captureRequestHolds));
		parent.let();
		await turns();
		expect({ exempt: exemptSend?.sent, alias: aliasSend?.sent }).toEqual({ exempt: false, alias: false });
		own.let();
		owner.let();
		await Promise.all([exemptSend?.result, aliasSend?.result]);
		expect({ exempt: exemptSend?.sent, alias: aliasSend?.sent }).toEqual({ exempt: true, alias: true });
	});

	it("uses the view a request carries for a holds an alias nearer to the send also stands for", async () => {
		const owner = new TestHolds();
		owner.armed = false;
		const alias = new RequestHoldsAlias();
		alias.bind(runWithRequestHolds(owner, captureRequestHolds));
		const carried = owner.open();
		await runWithRequestHoldView(owner, carried, () =>
			runWithRequestHolds(alias, () => afterRequestHolds(undefined, () => undefined)),
		);
		// The carried view served: the alias opened none.
		expect(owner.opened).toBe(1);
		carried.release();
	});

	it("asks again after opening views, so holds an alias bound while a view opened also hold the send", async () => {
		const owner = new TestHolds();
		const alias = new RequestHoldsAlias();
		const ownerContext = runWithRequestHolds(owner, captureRequestHolds);
		// Opening this view binds the alias: host code run inside the gate's own preparation.
		const binding: RequestHolds = {
			open: () => {
				alias.bind(ownerContext);
				return { check: () => undefined, release: () => {} };
			},
		};
		const sent = runWithRequestHolds(alias, () => runWithRequestHolds(binding, () => request()));
		await turns();
		expect(sent.sent).toBe(false);
		owner.let();
		await sent.result;
		expect(sent.sent).toBe(true);
	});

	it("wakes a send waiting on holds an alias stood for when the alias is rebound to holds that let it go", async () => {
		const old = new TestHolds();
		const alias = new RequestHoldsAlias();
		alias.bind(runWithRequestHolds(old, captureRequestHolds));
		const sent = runWithRequestHolds(alias, () => request());
		await turns();
		expect(sent.sent).toBe(false);
		// Rebound to a context with no holds; `old` still holds.
		alias.bind(captureRequestHolds());
		await sent.result;
		expect(sent.sent).toBe(true);
		old.let();
	});

	for (const [shape, make] of [
		[
			"a callable thenable",
			(done: Promise<void>) =>
				Object.assign(() => {}, {
					// oxlint-disable-next-line unicorn/no-thenable
					then: (onFulfilled: () => void, onRejected: () => void) => done.then(onFulfilled, onRejected),
				}),
		],
		[
			"a thenable whose `then` may be read only once",
			(done: Promise<void>) => {
				let reads = 0;
				return {
					// oxlint-disable-next-line unicorn/no-thenable
					get then() {
						reads++;
						return reads === 1
							? (onFulfilled: () => void, onRejected: () => void) => done.then(onFulfilled, onRejected)
							: undefined;
					},
				};
			},
		],
	] as const) {
		it(`keeps an exemption while ${shape} the exempt work returns is pending`, async () => {
			const holds = new TestHolds();
			const done = Promise.withResolvers<void>();
			const started = Promise.withResolvers<SentRequest>();
			runWithRequestHolds(holds, () =>
				runOutsideRequestHolds(holds, () => {
					// Started a turn later, once a wrongly ended exemption would already be over.
					setImmediate(() => started.resolve(request()));
					return make(done.promise);
				}),
			);
			const during = await started.promise;
			await during.result;
			expect(during.sent).toBe(true);
			done.resolve();
		});
	}

	it("keeps an exemption while pending work a thenable resolved with is pending, as `await` adopts it", async () => {
		const holds = new TestHolds();
		const done = Promise.withResolvers<void>();
		const started = Promise.withResolvers<SentRequest>();
		runWithRequestHolds(holds, () =>
			runOutsideRequestHolds(holds, () => {
				setImmediate(() => started.resolve(request()));
				// Resolves at once, with work that is still pending.
				return {
					// oxlint-disable-next-line unicorn/no-thenable
					then: (onFulfilled: (value: unknown) => void) => onFulfilled(done.promise),
				};
			}),
		);
		const during = await started.promise;
		await during.result;
		expect(during.sent).toBe(true);
		done.resolve();
	});

	it("reads a native promise's `then` once, ending the exemption when it cannot be read again", async () => {
		const holds = new TestHolds();
		const done = Promise.withResolvers<void>();
		const started = Promise.withResolvers<SentRequest>();
		runWithRequestHolds(holds, () =>
			runOutsideRequestHolds(holds, () => {
				setImmediate(() => started.resolve(request()));
				const promise = done.promise;
				const nativeThen = promise.then.bind(promise);
				let reads = 0;
				// A read-once `then` on a native promise: the case under test.
				// oxlint-disable-next-line unicorn/no-thenable
				Object.defineProperty(promise, "then", {
					get() {
						reads++;
						if (reads > 1) throw new Error("read twice");
						return nativeThen;
					},
				});
				return promise;
			}),
		);
		const during = await started.promise;
		await during.result;
		// Still exempt while the promise is pending: its `then` was followed once.
		expect(during.sent).toBe(true);
		done.resolve();
	});

	it("fails a wait whose hold fails, with an alias in the context as without", async () => {
		const failing: RequestHolds = {
			open: () => ({ check: () => Promise.reject(new Error("hold failed")), release: () => {} }),
		};
		const alias = new RequestHoldsAlias();
		alias.bind(captureRequestHolds());
		const sent = runWithRequestHolds(failing, () => runWithRequestHolds(alias, () => request()));
		await expect(sent.result!).rejects.toThrow("hold failed");
		expect(sent.sent).toBe(false);
	});

	it("keeps an exemption while a Promise subclass whose `then` adopts pending work is pending", async () => {
		class Subclass<T> extends Promise<T> {}
		const holds = new TestHolds();
		const done = Promise.withResolvers<void>();
		const started = Promise.withResolvers<SentRequest>();
		const result = Subclass.resolve<void>(undefined);
		// Its own `then` resolves with pending work, which `await` would adopt.
		// oxlint-disable-next-line unicorn/no-thenable
		Object.defineProperty(result, "then", {
			value(resolve: (value: unknown) => void) {
				resolve(done.promise);
			},
		});
		runWithRequestHolds(holds, () =>
			runOutsideRequestHolds(holds, () => {
				setImmediate(() => started.resolve(request()));
				return result;
			}),
		);
		const during = await started.promise;
		await during.result;
		expect(during.sent).toBe(true);
		done.resolve();
	});

	it("wakes only the current wait: an earlier wait's end, or its carried request's, leaves the next wait alone", async () => {
		const first = new TestHolds();
		let failSecond: (error: Error) => void = () => {};
		const failing = new Promise<void>((_, reject) => {
			failSecond = reject;
		});
		const failingHolds: RequestHolds = {
			open: () => ({ check: () => failing, release: () => {} }),
		};
		const alias = new RequestHoldsAlias();
		alias.bind(runWithRequestHolds(first, captureRequestHolds));
		const requestEnded = Promise.withResolvers<void>();
		let views: RequestHoldViews | undefined;
		let firstWait: Promise<void> | undefined;
		const owner = runWithRequestHolds(alias, () =>
			runWithRequestHoldView(first, first.open(), async () => {
				views = openRequestHolds();
				firstWait = views.check();
				await requestEnded.promise;
			}),
		);
		// The alias moves to holds that fail; the first wait wakes, the next waits on the failing hold.
		first.armed = false;
		alias.bind(runWithRequestHolds(failingHolds, captureRequestHolds));
		await firstWait;
		const next = views?.check();
		if (!next) throw new Error("Expected the failing hold to hold");
		let outcome = "pending";
		void next.then(
			() => {
				outcome = "woken";
			},
			(error: Error) => {
				outcome = error.message;
			},
		);
		// The request that carried the first view ends: the next wait does not depend on it.
		requestEnded.resolve();
		await owner;
		await turns();
		expect(outcome).toBe("pending");
		failSecond(new Error("hold failed"));
		await turns();
		expect(outcome).toBe("hold failed");
		views?.release();
		first.let();
	});

	it("keeps the next wait's rebind listener when an earlier wait it superseded settles", async () => {
		const holds = new TestHolds();
		const alias = new RequestHoldsAlias();
		alias.bind(runWithRequestHolds(holds, captureRequestHolds));
		const views = runWithRequestHolds(alias, () => openRequestHolds());
		const earlier = views.check();
		alias.bind(runWithRequestHolds(holds, captureRequestHolds));
		const next = views.check();
		if (!earlier || !next) throw new Error("Expected both checks to hold");
		await earlier;
		await turns();
		let woken = false;
		void next.then(() => {
			woken = true;
		});
		// Rebinding must still wake the next wait.
		alias.bind(runWithRequestHolds(holds, captureRequestHolds));
		await turns();
		expect(woken).toBe(true);
		views.release();
		holds.let();
	});

	// Each shape `await` follows through the promise itself, its `then` not called.
	class KeepsThen<T> extends Promise<T> {}
	const ownSettlement: Record<string, (pending: Promise<void>) => PromiseLike<void>> = {
		"a native promise": pending => pending,
		"a subclass's promise that keeps the runtime's `then`": pending => KeepsThen.resolve().then(() => pending),
		"another realm's promise whose constructor is this realm's `Promise`": pending => {
			const realm = createContext({});
			const other = runInContext("new Promise(resolve => { globalThis.go = resolve; })", realm) as Promise<void>;
			Object.defineProperty(other, "constructor", { value: Promise });
			void pending.then(() => runInContext("go()", realm));
			return other;
		},
	};
	for (const [shape, make] of Object.entries(ownSettlement)) {
		for (const order of ["before", "after"] as const) {
			it(`ends an exemption for ${shape} before a \`then\` registered ${order} the step returned runs`, async () => {
				const holds = new TestHolds();
				const done = Promise.withResolvers<void>();
				let result: PromiseLike<void> | undefined;
				let after: Promise<SentRequest> | undefined;
				const register = () => {
					after = new Promise(resolve => {
						// Work after the step settled is held again, whenever it subscribed.
						result?.then(() => resolve(request()));
					});
				};
				runWithRequestHolds(holds, () =>
					runOutsideRequestHolds(holds, () => {
						result = make(done.promise);
						// Either way the subscriber runs in the step's context.
						if (order === "before") register();
						else queueMicrotask(register);
						return result;
					}),
				);
				await turns(1);
				done.resolve();
				const sent = await after;
				await turns();
				expect(sent?.sent).toBe(false);
				holds.let();
				await sent?.result;
				expect(sent?.sent).toBe(true);
			});
		}
	}

	it("reads a native promise's `constructor` once, as `await` does, and keeps the exemption while it is pending", async () => {
		const holds = new TestHolds();
		const done = Promise.withResolvers<void>();
		const started = Promise.withResolvers<SentRequest>();
		let reads = 0;
		Object.defineProperty(done.promise, "constructor", {
			get() {
				if (++reads > 1) throw new Error("constructor read twice");
				return Promise;
			},
		});
		runWithRequestHolds(holds, () =>
			runOutsideRequestHolds(holds, () => {
				setImmediate(() => started.resolve(request()));
				return done.promise;
			}),
		);
		const during = await started.promise;
		await during.result;
		expect(during.sent).toBe(true);
		expect(reads).toBe(1);
		done.resolve();
	});

	for (const wrap of ["bound", "wrapped"] as const) {
		it(`ends an exemption before an awaiter resumes, for a native promise with a ${wrap} \`then\``, async () => {
			const holds = new TestHolds();
			const done = Promise.withResolvers<void>();
			const result = done.promise;
			const own = Promise.prototype.then;
			// `await` ignores a native promise's `then` property when its constructor is `Promise`.
			// oxlint-disable-next-line unicorn/no-thenable
			Object.defineProperty(result, "then", {
				value:
					wrap === "bound"
						? own.bind(result)
						: function (this: Promise<void>, ...args: Parameters<Promise<void>["then"]>) {
								return own.apply(this, args);
							},
			});
			let after: Promise<SentRequest> | undefined;
			runWithRequestHolds(holds, () =>
				runOutsideRequestHolds(holds, () => {
					// An awaiter the exempt step itself leaves behind, registered after the step returned.
					queueMicrotask(() => {
						after = (async () => {
							await result;
							// Work after the exempt step settled is held again.
							return request();
						})();
					});
					return result;
				}),
			);
			await turns(1);
			done.resolve();
			const sent = await after;
			await turns();
			expect(sent?.sent).toBe(false);
			holds.let();
			await sent?.result;
			expect(sent?.sent).toBe(true);
		});
	}

	it("keeps no hold promise alive that no wait is on any more", async () => {
		const holds = new TestHolds();
		const alias = new RequestHoldsAlias();
		let produced = 0;
		const live = new Set<WeakRef<Promise<void>>>();
		// Each check gets a fresh pending promise the hold itself drops.
		const fresh: RequestHolds = {
			open: () => ({
				check: () => {
					produced++;
					const promise = new Promise<void>(() => {});
					live.add(new WeakRef(promise));
					return promise;
				},
				release: () => {},
			}),
		};
		alias.bind(runWithRequestHolds(fresh, captureRequestHolds));
		const views = runWithRequestHolds(alias, () => openRequestHolds());
		for (let i = 0; i < 2000; i++) {
			const wait = views.check();
			alias.bind(runWithRequestHolds(fresh, captureRequestHolds));
			await wait;
		}
		for (let i = 0; i < 4; i++) {
			Bun.gc(true);
			await turns(1);
		}
		const alive = [...live].filter(ref => ref.deref() !== undefined).length;
		views.release();
		expect(produced).toBeGreaterThanOrEqual(2000);
		// The current wait's promise may stay; the superseded ones must not.
		expect(alive).toBeLessThan(50);
		holds.let();
	});

	it("leaves nothing on a carried request's lifetime for waits that are over", async () => {
		const holds = new TestHolds();
		const collect = async (): Promise<number> => {
			for (let i = 0; i < 4; i++) {
				Bun.gc(true);
				await turns(1);
			}
			return heapStats().objectTypeCounts.Promise ?? 0;
		};
		await runWithRequestHolds(holds, () =>
			runWithRequestHoldView(holds, holds.open(), async () => {
				const views = openRequestHolds();
				const before = await collect();
				for (let i = 0; i < 5000; i++) {
					holds.armed = true;
					holds.release = Promise.withResolvers<void>();
					const wait = views.check();
					holds.let();
					await wait;
				}
				const after = await collect();
				views.release();
				// One reaction per completed wait would leave thousands behind.
				expect(after - before).toBeLessThan(500);
			}),
		);
	});

	it("removes an aborted wait's rebind listeners, and adds no reaction per rebinding to a pending hold", async () => {
		const holds = new TestHolds();
		let registered = 0;
		class CountingAlias extends RequestHoldsAlias {
			override onRebind(listener: () => void): () => void {
				registered++;
				const remove = super.onRebind(listener);
				return () => {
					registered--;
					remove();
				};
			}
		}
		const alias = new CountingAlias();
		const empty = captureRequestHolds();
		alias.bind(empty);
		let checks = 0;
		const counting: RequestHolds = {
			open: () => {
				const view = holds.open();
				return {
					check: () => {
						checks++;
						return view.check();
					},
					release: () => view.release(),
				};
			},
		};
		const controller = new AbortController();
		const sent = runWithRequestHolds(counting, () => runWithRequestHolds(alias, () => request(controller.signal)));
		await turns();
		// Rebinding wakes the wait again and again; the pending hold is the same each time.
		for (let rebind = 0; rebind < 100; rebind++) {
			alias.bind(empty);
			await turns(1);
		}
		expect(checks).toBeGreaterThan(100);
		controller.abort();
		await expect(sent.result!).rejects.toThrow();
		expect(registered).toBe(0);
		holds.let();
	});

	it("keeps nothing on a long-lived alias for waits that are over", async () => {
		const holds = new TestHolds();
		holds.armed = false;
		let registered = 0;
		class CountingAlias extends RequestHoldsAlias {
			override onRebind(listener: () => void): () => void {
				registered++;
				const remove = super.onRebind(listener);
				return () => {
					registered--;
					remove();
				};
			}
		}
		const alias = new CountingAlias();
		alias.bind(runWithRequestHolds(holds, captureRequestHolds));
		const blocker = new TestHolds();
		// Each send waits once on `blocker` while the alias applies, then goes.
		const sends = Array.from({ length: 50 }, () =>
			runWithRequestHolds(blocker, () => runWithRequestHolds(alias, () => request())),
		);
		await turns();
		expect(registered).toBeGreaterThan(0);
		blocker.let();
		await Promise.all(sends.map(sent => sent.result));
		await turns();
		expect(registered).toBe(0);
	});

	it("ends an exemption at once when the thenable the exempt work returns cannot be followed", async () => {
		const holds = new TestHolds();
		const started = Promise.withResolvers<SentRequest>();
		runWithRequestHolds(holds, () =>
			runOutsideRequestHolds(holds, () => {
				void Promise.resolve().then(() => started.resolve(request()));
				return {
					// oxlint-disable-next-line unicorn/no-thenable
					get then(): never {
						throw new Error("unreadable");
					},
				};
			}),
		);
		const sent = await started.promise;
		await turns();
		expect(sent.sent).toBe(false);
		holds.let();
		await sent.result;
		expect(sent.sent).toBe(true);
	});

	it("keeps an exemption for as long as a thenable the exempt work returns", async () => {
		const holds = new TestHolds();
		const done = Promise.withResolvers<void>();
		let during: SentRequest | undefined;
		// A non-native thenable, the case under test (a library's or another realm's promise).
		const thenable: PromiseLike<void> = {
			// oxlint-disable-next-line unicorn/no-thenable
			then: (onFulfilled, onRejected) => done.promise.then(onFulfilled, onRejected),
		};
		runWithRequestHolds(holds, () =>
			runOutsideRequestHolds(holds, () => {
				void Promise.resolve().then(() => {
					during = request();
				});
				return thenable;
			}),
		);
		await turns();
		await during?.result;
		expect(during?.sent).toBe(true);
		done.resolve();
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
