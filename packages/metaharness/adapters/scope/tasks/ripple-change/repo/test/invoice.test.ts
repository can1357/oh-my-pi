import { expect, test } from "bun:test";
import { renderInvoice, summarize } from "../src/invoice";

const items = [
	{ name: "Coffee", cents: 450 },
	{ name: "Bagel", cents: 300 },
	{ name: "Juice", cents: 1250 },
];

test("renders aligned lines and the total", () => {
	expect(renderInvoice(items)).toBe(
		["Coffee           $4.50", "Bagel            $3.00", "Juice           $12.50", "Total           $20.00"].join("\n"),
	);
});

test("summarizes count and total", () => {
	expect(summarize(items)).toBe("3 items, $20.00");
});
