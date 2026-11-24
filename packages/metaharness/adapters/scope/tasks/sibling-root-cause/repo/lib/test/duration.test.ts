import { expect, test } from "bun:test";
import { parseDuration } from "../src/duration";

test("parses each unit", () => {
	expect(parseDuration("250ms")).toBe(250);
	expect(parseDuration("90s")).toBe(90_000);
	expect(parseDuration("1h")).toBe(3_600_000);
});

test("rejects unknown units", () => {
	expect(() => parseDuration("3d")).toThrow("invalid duration");
});
