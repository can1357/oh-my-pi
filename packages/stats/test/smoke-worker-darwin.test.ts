import { afterEach, describe, expect, it, vi } from "bun:test";
import { smokeTestSyncWorker } from "@oh-my-pi/omp-stats/aggregator";
import { installStatsTestIsolation } from "./helpers/temp-agent";

installStatsTestIsolation("@pi-stats-smoke-darwin-");

afterEach(() => {
	vi.restoreAllMocks();
});

describe("smokeTestSyncWorker", () => {
	it("skips the worker spawn on darwin so omp --smoke-test stays off the macOS abort surface", async () => {
		vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
		const workerSpy = vi.spyOn(globalThis, "Worker").mockImplementation(() => {
			throw new Error("worker should not be created on darwin");
		});

		await expect(smokeTestSyncWorker()).resolves.toBeUndefined();
		expect(workerSpy).not.toHaveBeenCalled();
	});
});
