import { describe, expect, it } from "bun:test";
import { QuotaProbeLeaseBook } from "../src/auth/probe-lease";

describe("QuotaProbeLeaseBook", () => {
	it("refuses a second live lease for the same credential+scope (single-flight)", () => {
		const book = new QuotaProbeLeaseBook();
		const first = book.tryAcquire(7, "scope");
		expect(typeof first).toBe("string");
		expect(book.tryAcquire(7, "scope")).toBeNull();
	});

	it("release drops a matching lease without clearing cooldown generation", () => {
		const book = new QuotaProbeLeaseBook();
		book.noteHardCooldown(3, "");
		const gen = book.cooldownGeneration(3, "");
		const lease = book.tryAcquire(3, "");
		expect(typeof lease).toBe("string");
		expect(book.release(3, "", lease!)).toBe(true);
		expect(book.cooldownGeneration(3, "")).toBe(gen);
		// A fresh probe is allowed after abandon; success would still clear.
		const again = book.tryAcquire(3, "");
		expect(typeof again).toBe("string");
		expect(book.recordSuccess(3, "", again)).toBe(true);
	});

	it("release ignores a mismatched lease id (negative)", () => {
		const book = new QuotaProbeLeaseBook();
		const lease = book.tryAcquire(1, "");
		expect(book.release(1, "", "not-the-lease")).toBe(false);
		expect(book.tryAcquire(1, "")).toBeNull();
		expect(book.release(1, "", lease!)).toBe(true);
		expect(book.tryAcquire(1, "")).toBeTypeOf("string");
	});
});
