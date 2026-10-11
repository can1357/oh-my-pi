import { describe, expect, it } from "bun:test";
import { awaitServiceObservationBarrier, registerServiceObservationBarrier } from "../src/launch/diagnostic-observers";

describe("service diagnostic observation readiness", () => {
	it("does not admit a fast service until its owner subscription is armed", async () => {
		const armed = Promise.withResolvers<void>();
		const remove = registerServiceObservationBarrier("owner", armed.promise);
		let admitted = false;
		const pending = awaitServiceObservationBarrier("owner").then(() => {
			admitted = true;
		});
		await Promise.resolve();
		expect(admitted).toBe(false);
		await awaitServiceObservationBarrier("different-owner");
		armed.resolve();
		await pending;
		expect(admitted).toBe(true);
		remove();
		await awaitServiceObservationBarrier("owner");
	});

	it("removes an invalidated observer barrier without affecting another subscription", async () => {
		const first = Promise.withResolvers<void>();
		const second = Promise.withResolvers<void>();
		const removeFirst = registerServiceObservationBarrier("shared-owner", first.promise);
		const removeSecond = registerServiceObservationBarrier("shared-owner", second.promise);
		removeFirst();
		let admitted = false;
		const pending = awaitServiceObservationBarrier("shared-owner").then(() => {
			admitted = true;
		});
		await Promise.resolve();
		expect(admitted).toBe(false);
		second.resolve();
		await pending;
		removeSecond();
		first.resolve();
	});
});
