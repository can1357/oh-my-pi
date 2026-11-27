import { expect, test } from "bun:test";
import { parseLegacyDate } from "../src/legacy";

test("parses single-digit months and days", () => {
	expect(parseLegacyDate("2024-3-7").toISOString()).toBe("2024-03-07T00:00:00.000Z");
});
