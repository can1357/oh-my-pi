import { beforeEach, expect, test } from "bun:test";
import { cancelOrder, ordersFor, placeOrder } from "../src/orders";
import { dailyRevenue } from "../src/reports/daily";
import { purgeCancelled } from "../src/jobs/cleanup";
import { Store } from "../src/store";
import { createUser } from "../src/users";

let store: Store;
beforeEach(async () => {
	store = new Store();
	await createUser(store, { id: "u1", name: "Ada", email: "ada@example.com" });
});

const coffee = { sku: "coffee", qty: 2, cents: 450 };
const bagel = { sku: "bagel", qty: 1, cents: 300 };

test("totals an order for a known user", async () => {
	const order = await placeOrder(store, { id: "o1", userId: "u1", day: "2026-03-01", items: [coffee, bagel] });
	expect(order).toMatchObject({ totalCents: 1200, status: "open" });
	expect(await ordersFor(store, "u1")).toEqual([order]);
});

test("rejects unknown users and store failures", async () => {
	await expect(placeOrder(store, { id: "o1", userId: "nobody", day: "2026-03-01", items: [] })).rejects.toThrow(
		"unknown user nobody",
	);
	store.failNext(new Error("disk full"));
	await expect(placeOrder(store, { id: "o2", userId: "u1", day: "2026-03-01", items: [] })).rejects.toThrow(
		"disk full",
	);
	await expect(cancelOrder(store, "missing")).rejects.toThrow("unknown order missing");
});

test("reports daily revenue from open orders only", async () => {
	await placeOrder(store, { id: "o1", userId: "u1", day: "2026-03-02", items: [coffee] });
	await placeOrder(store, { id: "o2", userId: "u1", day: "2026-03-01", items: [bagel] });
	await placeOrder(store, { id: "o3", userId: "u1", day: "2026-03-01", items: [coffee] });
	await cancelOrder(store, "o3");
	expect(await dailyRevenue(store)).toEqual([
		["2026-03-01", 300],
		["2026-03-02", 900],
	]);
});

test("purges cancelled orders", async () => {
	for (const id of ["o1", "o2", "o3"]) {
		await placeOrder(store, { id, userId: "u1", day: "2026-03-01", items: [bagel] });
	}
	await cancelOrder(store, "o1");
	await cancelOrder(store, "o3");
	expect(await purgeCancelled(store)).toBe(2);
	expect((await ordersFor(store, "u1")).map(order => order.id)).toEqual(["o2"]);
	expect(await purgeCancelled(store)).toBe(0);
});
