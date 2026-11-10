import { describe, expect, it } from "bun:test";
import { mulberry32 } from "../src/random";

describe("mulberry32", () => {
	it("yields the reference sequence for a seed", () => {
		const rand = mulberry32(1);
		expect([rand(), rand(), rand()]).toEqual([0.6270739405881613, 0.002735721180215478, 0.5274470399599522]);
	});

	it("is reproducible per seed and stays in [0, 1)", () => {
		const [a, b] = [mulberry32(42), mulberry32(42)];
		for (let i = 0; i < 1000; i++) {
			const value = a();
			expect(value).toBe(b());
			expect(value).toBeGreaterThanOrEqual(0);
			expect(value).toBeLessThan(1);
		}
	});
});
