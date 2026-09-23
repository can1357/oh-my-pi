import { describe, expect, it } from "bun:test";
import { mapWithConcurrencyLimit, mapWithConcurrencyLimitAllSettled } from "@oh-my-pi/pi-coding-agent/task/parallel";

describe("mapWithConcurrencyLimitAllSettled", () => {
	it("waits for valid siblings after one item rejects and keeps input order", async () => {
		const started: number[] = [];
		const secondGate = Promise.withResolvers<void>();
		const secondStarted = Promise.withResolvers<void>();
		const thirdStarted = Promise.withResolvers<void>();
		const pending = mapWithConcurrencyLimitAllSettled([0, 1, 2], 2, async item => {
			started.push(item);
			if (item === 0) throw new Error("first failed");
			if (item === 1) {
				secondStarted.resolve();
				await secondGate.promise;
			}
			if (item === 2) thirdStarted.resolve();
			return `item-${item}`;
		});
		await secondStarted.promise;
		await thirdStarted.promise;
		secondGate.resolve();
		const settled = await pending;
		expect(started).toEqual([0, 1, 2]);
		expect(settled.results.map(result => result?.status)).toEqual(["rejected", "fulfilled", "fulfilled"]);
		const second = settled.results[1];
		const third = settled.results[2];
		expect(second).toEqual({ status: "fulfilled", value: "item-1" });
		expect(third).toEqual({ status: "fulfilled", value: "item-2" });
	});

	it("stops scheduling after cancellation while awaiting an already launched sibling", async () => {
		const controller = new AbortController();
		const release = Promise.withResolvers<void>();
		const firstStarted = Promise.withResolvers<void>();
		const started: number[] = [];
		const pending = mapWithConcurrencyLimitAllSettled(
			[0, 1],
			1,
			async item => {
				started.push(item);
				firstStarted.resolve();
				await release.promise;
				return item;
			},
			controller.signal,
		);

		await firstStarted.promise;
		controller.abort();
		release.resolve();
		const settled = await pending;

		expect(started).toEqual([0]);
		expect(settled.aborted).toBe(true);
		expect(settled.results).toEqual([{ status: "fulfilled", value: 0 }, undefined]);
	});
});

describe("mapWithConcurrencyLimit", () => {
	it("aborts immediately but waits for launched siblings to finish cleanup before rejecting", async () => {
		const siblingStarted = Promise.withResolvers<void>();
		const siblingCleaningUp = Promise.withResolvers<void>();
		const releaseCleanup = Promise.withResolvers<void>();
		const siblingAborted = Promise.withResolvers<void>();

		const pending = mapWithConcurrencyLimit([0, 1], 2, async (item, _index, signal) => {
			if (item === 0) {
				await siblingStarted.promise;
				throw new Error("first failed");
			}

			siblingStarted.resolve();
			signal.addEventListener("abort", () => siblingAborted.resolve(), { once: true });
			await siblingAborted.promise;
			siblingCleaningUp.resolve();
			await releaseCleanup.promise;
			return item;
		});
		let settled = false;
		void pending.then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);

		await siblingCleaningUp.promise;
		for (let turn = 0; turn < 5; turn++) await Promise.resolve();
		expect(settled).toBe(false);

		releaseCleanup.resolve();
		await expect(pending).rejects.toThrow("first failed");
	});
});
