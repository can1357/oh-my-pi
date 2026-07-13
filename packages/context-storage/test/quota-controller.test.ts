import { describe, expect, it } from "bun:test";
import { authorizeWrite, type QuotaSnapshot, type StorageBudget } from "../src";

const budget: StorageBudget = {
	tempBytes: 100,
	rawBytes: 100,
	processedBytes: 100,
	databaseBytes: 100,
	totalBytes: 1_000,
	minimumFreeDiskBytes: 100,
	minimumFreeDiskPercent: 10,
};

const snapshot: QuotaSnapshot = {
	tempBytes: 0,
	rawBytes: 0,
	processedBytes: 0,
	databaseBytes: 0,
	totalBytes: 850,
	freeDiskBytes: 200,
	freeDiskPercent: 20,
	diskCapacityBytes: 1_000,
};

describe("persistent context quota admission", () => {
	it("rejects a non-audit write before it violates the disk reserve", () => {
		expect(
			authorizeWrite(
				{ category: "processed", estimatedBytes: 101, userId: "user", sessionId: "session" },
				budget,
				snapshot,
			),
		).toMatchObject({
			allowed: false,
			state: "emergency",
			recommendedAction: "reject_and_cleanup",
		});
	});

	it("rejects raw persistence at critical pressure while allowing processed text", () => {
		const critical = { ...snapshot, totalBytes: 860 };
		expect(
			authorizeWrite({ category: "raw", estimatedBytes: 1, userId: "user", sessionId: "session" }, budget, critical),
		).toMatchObject({
			allowed: false,
			state: "critical",
			recommendedAction: "processed_only",
		});
		expect(
			authorizeWrite(
				{ category: "processed", estimatedBytes: 1, userId: "user", sessionId: "session" },
				budget,
				critical,
			),
		).toMatchObject({
			allowed: true,
			state: "critical",
		});
	});
});
