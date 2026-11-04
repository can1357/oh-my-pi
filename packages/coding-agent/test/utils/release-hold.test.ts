import { describe, expect, it } from "bun:test";
import { createReleaseHold } from "@oh-my-pi/pi-coding-agent/utils/release-hold";

describe("ReleaseHold", () => {
	it("runs the release once when the release itself discharges the hold again", async () => {
		// A release that reaches the same hold on its own synchronous path — a
		// kernel shutdown whose teardown hook touches the borrow it is releasing
		// — must not start a second one.
		let calls = 0;
		let reentrant: Promise<void> | undefined;
		const hold = createReleaseHold(() => {
			calls += 1;
			reentrant ??= hold();
		});

		await hold();
		await reentrant;

		expect(calls).toBe(1);
		expect(hold.isOwed()).toBe(false);
	});

	it("shares one rejected discharge instead of retrying a failing release", async () => {
		let calls = 0;
		const hold = createReleaseHold(() => {
			calls += 1;
			throw new Error("release rejected");
		});

		const first = hold();
		await expect(first).rejects.toThrow("release rejected");
		expect(hold()).toBe(first);
		expect(calls).toBe(1);
	});

	it("hands a claim up the chain it was derived from, and discharges every link once", async () => {
		let claims = 0;
		let releases = 0;
		const base = createReleaseHold(
			() => void (releases += 1),
			() => void (claims += 1),
		);
		const derived = createReleaseHold(base, base.claim);

		derived.claim();
		derived.claim();

		expect(claims).toBe(1);
		expect(base.isOwed()).toBe(false);
		await derived();
		await base();
		expect(releases).toBe(1);
	});

	it("takes no claim over a hold already discharged, so nothing up the chain is told it has a new owner", async () => {
		// An isolation run reads a claim on its derived hold as "the lifecycle
		// owns the workspace" and skips its own teardown; a one-shot run whose
		// hold was discharged and then reported taken over leaked its sandbox.
		let claims = 0;
		let releases = 0;
		const derived = createReleaseHold(
			() => void (releases += 1),
			() => void (claims += 1),
		);

		await derived();
		derived.claim();

		expect(claims).toBe(0);
		expect(releases).toBe(1);
		expect(derived.isOwed()).toBe(false);
	});
});
