import { describe, expect, it } from "bun:test";
import { IncomingRequests } from "../src/a2a/incoming-requests";

describe("incoming A2A requests", () => {
	it("scopes consumption to the addressed agent and peer", async () => {
		const registry = new IncomingRequests();
		const first = { to: "agent-a", from: "peer", messageId: "a", at: 1 };
		const other = { to: "agent-b", from: "peer", messageId: "b", at: 2 };
		await registry.note(first);
		await registry.note(other);
		expect(await registry.consume({ to: "agent-b", from: "peer", messageId: "a" })).toBeUndefined();
		expect(await registry.consume({ to: "agent-b", from: "other" })).toBeUndefined();
		const lease = await registry.consume({ to: "agent-b", from: "peer" });
		expect(lease?.request).toEqual(other);
		expect(typeof lease?.leaseId).toBe("string");
		expect(await registry.list()).toEqual([first]);
	});

	it("lists and consumes oldest matching requests, or a specific message", async () => {
		const registry = new IncomingRequests();
		const first = { to: "agent", from: "peer", messageId: "first", at: 1 };
		const second = { to: "agent", from: "peer", messageId: "second", at: 2 };
		const third = { to: "agent", from: "peer", messageId: "third", at: 3 };
		await registry.note(first);
		await registry.note(second);
		await registry.note(third);
		expect(await registry.list("agent")).toEqual([first, second, third]);
		expect(await registry.list("missing")).toEqual([]);
		expect(
			(
				await registry.consume({
					to: "agent",
					from: "peer",
					messageId: "second",
				})
			)?.request,
		).toEqual(second);
		expect((await registry.consume({ to: "agent", from: "peer" }))?.request).toEqual(first);
		expect((await registry.consume({ to: "agent" }))?.request).toEqual(third);
		expect(await registry.consume({ to: "agent" })).toBeUndefined();
	});

	it("gives exactly one concurrent consumer the request", async () => {
		const registry = new IncomingRequests();
		const request = { to: "agent", from: "peer", messageId: "one", at: 1 };
		await registry.note(request);
		const results = await Promise.all([
			registry.consume({ to: "agent", messageId: "one" }),
			registry.consume({ to: "agent", from: "peer" }),
		]);
		const leases = results.filter(result => result !== undefined);
		expect(leases).toHaveLength(1);
		expect(leases[0]?.request).toEqual(request);
		expect(await registry.list()).toEqual([]);
	});

	it("confirmed lease never reopens", async () => {
		const registry = new IncomingRequests();
		await registry.note({ to: "agent", from: "peer", messageId: "one", at: 1 });
		const lease = await registry.consume({ to: "agent" });
		expect(lease).toBeDefined();
		expect(await registry.confirm(lease!.leaseId)).toBe(true);
		// Duplicate and cross-shaped settlements never reopen or duplicate it.
		expect(await registry.confirm(lease!.leaseId)).toBe(false);
		expect(await registry.release(lease!.leaseId)).toBe(false);
		expect(await registry.list()).toEqual([]);
		expect(await registry.consume({ to: "agent" })).toBeUndefined();
	});

	it("releases a lease back to its original FIFO position", async () => {
		const registry = new IncomingRequests();
		const first = { to: "agent", from: "peer", messageId: "first", at: 1 };
		const second = { to: "agent", from: "peer", messageId: "second", at: 2 };
		const third = { to: "agent", from: "peer", messageId: "third", at: 3 };
		await registry.note(first);
		await registry.note(second);
		await registry.note(third);
		const lease = await registry.consume({ to: "agent", messageId: "second" });
		expect(await registry.list("agent")).toEqual([first, third]);
		expect(await registry.release(lease!.leaseId)).toBe(true);
		// The request returns to its original position, not the tail.
		expect(await registry.list("agent")).toEqual([first, second, third]);
		expect((await registry.consume({ to: "agent", from: "peer" }))?.request).toEqual(first);
		// A released token is spent: settling it again changes nothing.
		expect(await registry.release(lease!.leaseId)).toBe(false);
	});

	it("invalidates a stale lease token after a release and reclaim", async () => {
		const registry = new IncomingRequests();
		await registry.note({ to: "agent", from: "peer", messageId: "one", at: 1 });
		const original = await registry.consume({ to: "agent" });
		expect(await registry.release(original!.leaseId)).toBe(true);
		const reclaimed = await registry.consume({ to: "agent" });
		expect(reclaimed?.request.messageId).toBe("one");
		expect(reclaimed?.leaseId).not.toBe(original!.leaseId);
		// The old token can neither confirm nor release the new claim.
		expect(await registry.confirm(original!.leaseId)).toBe(false);
		expect(await registry.release(original!.leaseId)).toBe(false);
		expect(await registry.consume({ to: "agent", messageId: "one" })).toBeUndefined();
		expect(await registry.confirm(reclaimed!.leaseId)).toBe(true);
	});

	it("drops only one worker's leases and keeps unowned main claims independent", async () => {
		const registry = new IncomingRequests();
		const a = { to: "agent", from: "peer", messageId: "a", at: 1 };
		const b = { to: "agent", from: "peer", messageId: "b", at: 2 };
		const c = { to: "agent", from: "peer", messageId: "c", at: 3 };
		const d = { to: "agent", from: "peer", messageId: "d", at: 4 };
		await registry.note(a);
		await registry.note(b);
		await registry.note(c);
		await registry.note(d);
		const dropped = await registry.consume({ to: "agent", messageId: "a" }, "w1");
		const other = await registry.consume({ to: "agent", messageId: "b" }, "w2");
		const main = await registry.consume({ to: "agent", messageId: "c" });
		registry.dropHome("w1");
		// Only w1's lease reopened, at its original FIFO position (before d).
		expect(await registry.list("agent")).toEqual([a, d]);
		// w2's and main's claims are not open for another consumer.
		expect(await registry.consume({ to: "agent", messageId: "b" })).toBeUndefined();
		expect(await registry.consume({ to: "agent", messageId: "c" })).toBeUndefined();
		// The dead worker's stale token cannot settle the reopened request.
		expect(await registry.confirm(dropped!.leaseId)).toBe(false);
		expect(await registry.release(dropped!.leaseId)).toBe(false);
		// A home mismatch cannot settle a foreign lease.
		expect(await registry.confirm(other!.leaseId, "w1")).toBe(false);
		expect(await registry.release(main!.leaseId, "w1")).toBe(false);
		// Unowned main claims settle independently of any home.
		expect(await registry.confirm(main!.leaseId)).toBe(true);
		expect(await registry.confirm(other!.leaseId, "w2")).toBe(true);
		expect(await registry.list("agent")).toEqual([a, d]);
	});
});
