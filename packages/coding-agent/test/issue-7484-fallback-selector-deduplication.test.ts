import { describe, expect, test } from "bun:test";
import { FallbackSelectorResolutionCoordinator } from "@oh-my-pi/pi-coding-agent/session/retry-fallback-chains";

describe("issue #7484 fallback selector deduplication", () => {
	test("deduplicates simultaneous resolution of the same key", async () => {
		const deferred = Promise.withResolvers<string>();
		let invocationCount = 0;

		const coordinator = new FallbackSelectorResolutionCoordinator<string>();

		const resolver = async (_key: string): Promise<string> => {
			invocationCount += 1;
			return deferred.promise;
		};

		const calls = Array.from({ length: 8 }, () =>
			coordinator.resolve("unknown-provider/unknown-model", () => resolver("unknown-provider/unknown-model")),
		);

		expect(invocationCount).toBe(1);
		expect(coordinator.activeCount).toBe(1);

		deferred.resolve("resolved-value");

		const results = await Promise.all(calls);

		expect(results).toHaveLength(8);
		expect(results.every(r => r === "resolved-value")).toBe(true);
		expect(invocationCount).toBe(1);
		expect(coordinator.activeCount).toBe(0);
	});

	test("resolves different selectors independently", async () => {
		const coordinator = new FallbackSelectorResolutionCoordinator<string>();
		let invocationCount = 0;

		const results = await Promise.all([
			coordinator.resolve("provider-a/model-1", async () => {
				invocationCount += 1;
				return "result-a";
			}),
			coordinator.resolve("provider-b/model-2", async () => {
				invocationCount += 1;
				return "result-b";
			}),
		]);

		expect(results).toEqual(["result-a", "result-b"]);
		expect(invocationCount).toBe(2);
		expect(coordinator.activeCount).toBe(0);
	});

	test("propagates rejection to all concurrent waiters", async () => {
		const deferred = Promise.withResolvers<never>();
		let invocationCount = 0;

		const coordinator = new FallbackSelectorResolutionCoordinator<string>();

		const first = coordinator.resolve("unknown-selector", () => {
			invocationCount += 1;
			return deferred.promise;
		});

		const second = coordinator.resolve("unknown-selector", () => {
			invocationCount += 1;
			return deferred.promise;
		});

		expect(invocationCount).toBe(1);

		deferred.reject(new Error("unknown selector error"));

		await expect(first).rejects.toThrow("unknown selector error");
		await expect(second).rejects.toThrow("unknown selector error");
		expect(invocationCount).toBe(1);
		expect(coordinator.activeCount).toBe(0);
	});

	test("allows retry after resolution settles (no stale negative caching)", async () => {
		const coordinator = new FallbackSelectorResolutionCoordinator<string>();
		let invocationCount = 0;

		await expect(
			coordinator.resolve("missing-model", async () => {
				invocationCount += 1;
				throw new Error("temporary failure");
			}),
		).rejects.toThrow("temporary failure");

		expect(invocationCount).toBe(1);
		expect(coordinator.activeCount).toBe(0);

		const recovered = await coordinator.resolve("missing-model", async () => {
			invocationCount += 1;
			return "now-available";
		});

		expect(recovered).toBe("now-available");
		expect(invocationCount).toBe(2);
		expect(coordinator.activeCount).toBe(0);
	});

	test("keeps separate coordinator instances isolated", async () => {
		const coordinatorA = new FallbackSelectorResolutionCoordinator<string>();
		const coordinatorB = new FallbackSelectorResolutionCoordinator<string>();
		let invocationCount = 0;

		await Promise.all([
			coordinatorA.resolve("shared-key", async () => {
				invocationCount += 1;
				return "from-a";
			}),
			coordinatorB.resolve("shared-key", async () => {
				invocationCount += 1;
				return "from-b";
			}),
		]);

		expect(invocationCount).toBe(2);
	});

	test("one caller aborting does not cancel shared resolution for other waiters", async () => {
		const deferred = Promise.withResolvers<string>();
		let invocationCount = 0;

		const coordinator = new FallbackSelectorResolutionCoordinator<string>();

		const sharedPromise = coordinator.resolve("key", async () => {
			invocationCount += 1;
			return deferred.promise;
		});

		const abortController = new AbortController();
		const abortedWaiter = Promise.race([
			sharedPromise,
			new Promise<never>((_, reject) => {
				abortController.signal.addEventListener("abort", () => {
					reject(new Error("aborted by caller"));
				});
			}),
		]);

		abortController.abort();
		await expect(abortedWaiter).rejects.toThrow("aborted by caller");

		deferred.resolve("success");
		const result = await sharedPromise;
		expect(result).toBe("success");
		expect(invocationCount).toBe(1);
	});
});
