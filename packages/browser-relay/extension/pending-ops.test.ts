import { describe, expect, it } from "bun:test";
import {
	afterPendingOperationsSettle,
	snapshotAfterPendingOperationsSettle,
} from "./pending-ops";

function deferred<T>() {
	const { promise, resolve } = Promise.withResolvers<T>();
	return { promise, resolve };
}

async function flushMicrotasks(times = 10): Promise<void> {
	for (let i = 0; i < times; i++) await Promise.resolve();
}

describe("pending operation settlement", () => {
	it("runs the callback after a pending operation rejects", async () => {
		let callbacks = 0;

		await expect(
			afterPendingOperationsSettle(
				[Promise.reject(new Error("detach failed"))],
				async () => ++callbacks,
			),
		).resolves.toBe(1);
		expect(callbacks).toBe(1);
	});

	it("retries when a new pending operation is added while waiting for the current set", async () => {
		let generation = 0;
		const first = deferred<void>();
		const second = deferred<void>();
		let phase: "first" | "second" = "first";
		const snapshots: string[] = [];

		const resultPromise = snapshotAfterPendingOperationsSettle(
			() => generation,
			() => (phase === "first" ? [first.promise] : [second.promise]),
			async () => {
				snapshots.push(phase);
				return phase;
			},
		);

		phase = "second";
		generation++;
		first.resolve();
		await flushMicrotasks();
		expect(snapshots).toEqual([]);

		second.resolve();
		await expect(resultPromise).resolves.toBe("second");
		expect(snapshots).toEqual(["second"]);
	});

	it("retries when the pending set changes while taking the snapshot", async () => {
		let generation = 0;
		const current = deferred<void>();
		const next = deferred<void>();
		let includeNext = false;
		const snapshots: string[] = [];

		const resultPromise = snapshotAfterPendingOperationsSettle(
			() => generation,
			() => (includeNext ? [next.promise] : [current.promise]),
			async () => {
				snapshots.push(includeNext ? "next" : "current");
				if (!includeNext) {
					includeNext = true;
					generation++;
				}
				return includeNext ? "next" : "current";
			},
		);

		current.resolve();
		await flushMicrotasks();
		expect(snapshots).toEqual(["current"]);

		next.resolve();
		await expect(resultPromise).resolves.toBe("next");
		expect(snapshots).toEqual(["current", "next"]);
	});
});
