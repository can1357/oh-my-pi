import { describe, expect, it } from "bun:test";
import { snapshotAfterPendingOperationsSettle } from "./pending-ops";

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>(res => {
		resolve = res;
	});
	return { promise, resolve };
}

async function flushMicrotasks(times = 10): Promise<void> {
	for (let i = 0; i < times; i++) await Promise.resolve();
}

describe("snapshotAfterPendingOperationsSettle", () => {
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
