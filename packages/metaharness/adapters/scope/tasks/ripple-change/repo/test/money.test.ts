import { expect, test } from "bun:test";
import { formatMoney } from "../src/money";

test("formats cents as dollars", () => {
	expect(formatMoney(1250)).toBe("$12.50");
	expect(formatMoney(5)).toBe("$0.05");
});
