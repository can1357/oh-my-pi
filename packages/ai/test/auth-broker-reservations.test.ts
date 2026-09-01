import { describe, expect, it } from "bun:test";
import { ReservationBook } from "@oh-my-pi/pi-ai/auth-broker/reservations";

const TTL_MS = 60_000;

describe("ReservationBook", () => {
	it("acquires an exclusive hold per credentialId", () => {
		const book = new ReservationBook();
		expect(book.tryAcquire("req-1", 7, TTL_MS)).toBe(true);
		expect(book.tryAcquire("req-2", 8, TTL_MS)).toBe(true);
	});

	it("rejects a second acquire of the same credential (negative)", () => {
		const book = new ReservationBook();
		expect(book.tryAcquire("req-1", 7, TTL_MS)).toBe(true);
		expect(book.tryAcquire("req-2", 7, TTL_MS)).toBe(false);
	});

	it("allows acquire after release", () => {
		const book = new ReservationBook();
		expect(book.tryAcquire("req-1", 7, TTL_MS)).toBe(true);
		book.release("req-1");
		expect(book.tryAcquire("req-2", 7, TTL_MS)).toBe(true);
	});

	it("renews when the same requestId re-acquires", () => {
		const book = new ReservationBook();
		expect(book.tryAcquire("req-1", 7, TTL_MS)).toBe(true);
		expect(book.tryAcquire("req-1", 7, TTL_MS)).toBe(true);
		expect(book.tryAcquire("req-2", 7, TTL_MS)).toBe(false);
	});

	it("does not pin an expired reservation", () => {
		const book = new ReservationBook();
		expect(book.tryAcquire("req-1", 7, 0)).toBe(true);
		expect(book.tryAcquire("req-2", 7, TTL_MS)).toBe(true);
	});

	it("release of an unknown requestId is a no-op", () => {
		const book = new ReservationBook();
		book.release("missing");
		expect(book.tryAcquire("req-1", 7, TTL_MS)).toBe(true);
	});
});
