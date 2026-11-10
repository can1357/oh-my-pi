import { describe, expect, it } from "bun:test";
import { scheduler } from "node:timers/promises";
import { type TurnClaim, TurnGate, type TurnGateHost } from "@oh-my-pi/pi-coding-agent/session/turn-gate";

/** A session stand-in: the cancellation stamp and the admitted-submission barrier are the test's to move. */
function createHost() {
	let generation = 0;
	let settled: PromiseWithResolvers<void> | undefined;
	const host: TurnGateHost = {
		cancellationGeneration: () => generation,
		whenAdmittedSubmissionsSettled: () => settled?.promise,
	};
	return {
		host,
		cancel: () => {
			generation++;
		},
		admitSubmission: () => {
			settled = Promise.withResolvers<void>();
		},
		settleSubmissions: () => {
			const current = settled;
			settled = undefined;
			current?.resolve();
		},
	};
}

const dispatched = (log: string[], label: string) => () => {
	log.push(label);
	return Promise.resolve(label);
};

describe("TurnGate", () => {
	it("admits every claim kind while no hold exists", async () => {
		const gate = new TurnGate(createHost().host);
		const log: string[] = [];

		for (const kind of ["recovery", "background", "user"] as const) {
			expect(await gate.start({ kind }, undefined, dispatched(log, kind))).toBe(kind);
		}

		expect(log).toEqual(["recovery", "background", "user"]);
	});

	it("refuses background and user claims under a hold and admits that hold's own holder claim", async () => {
		const gate = new TurnGate(createHost().host);
		const hold = gate.hold();
		const log: string[] = [];

		expect(gate.start({ kind: "background" }, undefined, dispatched(log, "background"))).toBeUndefined();
		expect(gate.start({ kind: "user" }, undefined, dispatched(log, "user"))).toBeUndefined();
		gate.release(hold);
		const fresh = gate.hold();
		expect(await gate.start({ kind: "holder", hold: fresh }, undefined, dispatched(log, "holder"))).toBe("holder");

		// The user claim cancelled the hold it found, so that hold's own continuation no longer runs.
		expect(gate.start({ kind: "holder", hold }, undefined, dispatched(log, "cancelled holder"))).toBeUndefined();
		expect(log).toEqual(["holder"]);
	});

	it("queues a second hold behind the one in force and hands the session over at its release, parked work still parked", async () => {
		const gate = new TurnGate(createHost().host);
		const first = gate.hold();
		const second = gate.hold();
		const log: string[] = [];
		let secondHeld = false;
		void gate.whenHeld(second).then(() => {
			secondHeld = true;
		});
		gate.tryAdmit({ kind: "background", park: () => log.push("parked") });

		// Only the hold in force runs its continuation: the queued pass neither judges nor continues yet.
		expect(gate.start({ kind: "holder", hold: second }, undefined, dispatched(log, "second"))).toBeUndefined();
		await scheduler.yield();
		expect(secondHeld).toBe(false);
		gate.release(first);
		await scheduler.yield();

		expect(secondHeld).toBe(true);
		expect(gate.held).toBe(true);
		expect(await gate.start({ kind: "holder", hold: second }, undefined, dispatched(log, "second"))).toBe("second");
		gate.release(second);
		expect(log).toEqual(["second", "parked"]);
	});

	it("refuses a recovery claim only while a hold consults, and replays its park when consulting ends", async () => {
		const gate = new TurnGate(createHost().host);
		const hold = gate.hold();
		const log: string[] = [];

		expect(await gate.start({ kind: "recovery" }, undefined, dispatched(log, "before consult"))).toBe(
			"before consult",
		);
		gate.consult(hold);
		const parked: TurnClaim = { kind: "recovery", park: () => log.push("replayed") };
		expect(gate.start(parked, undefined, dispatched(log, "during consult"))).toBeUndefined();
		expect(log).toEqual(["before consult"]);

		gate.endConsult(hold);

		expect(log).toEqual(["before consult", "replayed"]);
		expect(gate.held).toBe(true);
	});

	it("cancels every hold's signal once for a refused user claim, queued ones included, and admits it once the hold in force releases", async () => {
		const gate = new TurnGate(createHost().host);
		const first = gate.hold();
		const second = gate.hold();
		let aborts = 0;
		for (const hold of [first, second]) hold.cancel.signal.addEventListener("abort", () => aborts++);
		let admitted = false;

		const waiting = gate.whenAdmissible({ kind: "user" }).then(() => {
			admitted = true;
		});
		expect(gate.start({ kind: "user" }, undefined, () => Promise.resolve())).toBeUndefined();
		await scheduler.yield();
		expect(admitted).toBe(false);
		// The cancelled queued pass never gets the session: the release of the one in force ends the wait.
		gate.release(first);
		await waiting;

		expect(aborts).toBe(2);
		expect(admitted).toBe(true);
		gate.release(second);
	});

	it("replays parked claims once, in park order, after the last hold releases and admitted submissions settle", async () => {
		const { host, admitSubmission, settleSubmissions } = createHost();
		const gate = new TurnGate(host);
		const first = gate.hold();
		const second = gate.hold();
		const log: string[] = [];
		const wake = () => log.push("wake");
		gate.start({ kind: "background", park: wake }, undefined, dispatched(log, "unreachable"));
		gate.start({ kind: "background", park: () => log.push("hidden turn") }, undefined, dispatched(log, "x"));
		// The same pending input parked twice is one replay.
		gate.start({ kind: "background", park: wake }, undefined, dispatched(log, "unreachable"));
		admitSubmission();

		gate.release(first);
		expect(log).toEqual([]);
		gate.release(second);
		expect(log).toEqual([]);
		settleSubmissions();
		await scheduler.yield();

		expect(log).toEqual(["wake", "hidden turn"]);
		gate.release(second);
		await scheduler.yield();
		expect(log).toEqual(["wake", "hidden turn"]);
	});

	it("drops a parked claim whose cancellation generation changed before the release", () => {
		const { host, cancel } = createHost();
		const gate = new TurnGate(host);
		const hold = gate.hold();
		const log: string[] = [];
		gate.start({ kind: "background", park: () => log.push("stale") }, undefined, dispatched(log, "x"));
		cancel();
		gate.start({ kind: "background", park: () => log.push("fresh") }, undefined, dispatched(log, "x"));

		gate.release(hold);

		expect(log).toEqual(["fresh"]);
	});

	it("refuses a holder claim while another claim's reservation is open, and admits it once that reservation ends", async () => {
		const gate = new TurnGate(createHost().host);
		const hold = gate.hold();
		const holder: TurnClaim = { kind: "holder", hold };
		const log: string[] = [];
		const reservation = gate.reserve({ kind: "background" });
		const own = gate.reserve(holder);

		expect(gate.admits(holder)).toBe(false);
		const admissible = gate.whenAdmissible(holder, hold.cancel.signal).then(() => log.push("holder admissible"));
		await scheduler.yield();
		expect(log).toEqual([]);
		reservation.end();
		await admissible;

		expect(log).toEqual(["holder admissible"]);
		expect(await gate.start(holder, undefined, dispatched(log, "holder"))).toBe("holder");
		own.end();
	});

	it("reports dispatching only inside start's synchronous dispatch call", async () => {
		const gate = new TurnGate(createHost().host);
		const seen: boolean[] = [];

		const run = gate.start(
			{ kind: "user" },
			() => seen.push(gate.dispatching),
			async () => {
				seen.push(gate.dispatching);
				await Promise.resolve();
				seen.push(gate.dispatching);
			},
		);
		seen.push(gate.dispatching);
		await run;

		expect(seen).toEqual([true, true, false, false]);
	});

	it("rejects whenAdmissible with the signal's reason when the signal aborts while held", async () => {
		const gate = new TurnGate(createHost().host);
		gate.hold();
		const controller = new AbortController();
		const reason = new Error("run cancelled");

		const waiting = gate.whenAdmissible({ kind: "background" }, controller.signal);
		controller.abort(reason);

		await expect(waiting).rejects.toMatchObject({ cause: reason });
	});

	it("cancels a hold when the run signal linked to it aborts, and not after its release", () => {
		const gate = new TurnGate(createHost().host);
		const linked = new AbortController();
		const released = new AbortController();
		const hold = gate.hold(linked.signal);
		const done = gate.hold(released.signal);
		gate.release(done);

		linked.abort();
		released.abort();

		expect(hold.cancel.signal.aborted).toBe(true);
		expect(done.cancel.signal.aborted).toBe(false);
	});

	it("tells a hold's listeners whether an interrupt or a user claim cancels it", () => {
		const gate = new TurnGate(createHost().host);
		const hold = gate.hold();
		const reasons: (string | undefined)[] = [];
		hold.cancel.signal.addEventListener("abort", () => reasons.push(gate.cancelling));

		gate.cancelAll("interrupt");
		const next = gate.hold();
		next.cancel.signal.addEventListener("abort", () => reasons.push(gate.cancelling));
		gate.start({ kind: "user" }, undefined, () => Promise.resolve());

		expect(reasons).toEqual(["interrupt", "user"]);
		expect(gate.cancelling).toBeUndefined();
	});
});
