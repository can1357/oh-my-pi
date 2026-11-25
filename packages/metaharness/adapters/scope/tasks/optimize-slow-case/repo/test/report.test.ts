import { expect, test } from "bun:test";
import { regionOf } from "../src/customers";
import type { Order } from "../src/data";
import { dedupe } from "../src/dedupe";
import { buildReport } from "../src/report";

const order = (id: string, amountCents: number): Order => ({ id, customerId: "CUST-00001", month: "2025-01", amountCents });

test("a re-exported order keeps its first line", () => {
	const unique = dedupe([order("ord-1", 100), order("ord-2", 200), order("ord-1", 900)]);
	expect(unique.map(entry => [entry.id, entry.amountCents])).toEqual([
		["ord-1", 100],
		["ord-2", 200],
	]);
});

test("customer ids match in any case; unknown customers have no region", () => {
	const customers = [
		{ id: "CUST-00001", region: "EMEA" },
		{ id: "CUST-00002", region: "APAC" },
	];
	expect(regionOf(customers, "cust-00002")).toBe("APAC");
	expect(regionOf(customers, "CUST-00009")).toBe("UNKNOWN");
});

test("the 300-line report matches the stored one", async () => {
	const stored = await Bun.file(new URL("./golden-300.txt", import.meta.url)).text();
	expect(buildReport(300)).toBe(stored.trimEnd());
});
