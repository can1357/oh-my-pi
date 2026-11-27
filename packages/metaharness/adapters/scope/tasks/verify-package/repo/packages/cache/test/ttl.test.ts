import { expect, test } from "bun:test";
import { expiresAt, parseTtl } from "../src/ttl";

test("parses each unit", () => {
	expect(parseTtl("250ms")).toBe(250);
	expect(parseTtl("90s")).toBe(90_000);
	expect(parseTtl("5m")).toBe(300_000);
	expect(parseTtl("2h")).toBe(7_200_000);
});

test("rejects malformed TTLs", () => {
	for (const ttl of ["", "90", "s", "1.5s", "0s", "3 days"]) expect(() => parseTtl(ttl)).toThrow("invalid ttl");
});

test("expiry rounds up to the next whole second", () => {
	expect(expiresAt(1_000_250, "90s")).toBe(1_091_000);
	expect(expiresAt(1_000_001, "250ms")).toBe(1_001_000);
});

test("an expiry already on a whole second stays put", () => {
	expect(expiresAt(1_000_000, "90s")).toBe(1_090_000);
});
