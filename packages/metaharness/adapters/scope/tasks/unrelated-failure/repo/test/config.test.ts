import { expect, test } from "bun:test";
import { DEFAULT_RETRIES, DEFAULT_TIMEOUT_MS } from "../src/config";

test("defaults", () => {
	expect(DEFAULT_TIMEOUT_MS).toBe(30_000);
	expect(DEFAULT_RETRIES).toBe(2);
});
