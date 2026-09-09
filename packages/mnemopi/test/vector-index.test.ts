import { describe, expect, it } from "bun:test";
import { buildExactVectorIndex, searchExactVectorIndex } from "../src/core/vector-index";

describe("exact vector index", () => {
	it("normalizes vectors and returns nearest ids by cosine score", () => {
		const index = buildExactVectorIndex([
			{ id: "x", vector: [1, 0] },
			{ id: "y", vector: [0, 2] },
			{ id: "z", vector: [0, 0] },
		]);

		expect(index.count).toBe(2);
		expect(searchExactVectorIndex(index, [0, 3], 2)).toEqual([
			{ id: "y", score: 1 },
			{ id: "x", score: 0 },
		]);
	});

	it("returns no hits for invalid or empty queries", () => {
		const index = buildExactVectorIndex([{ id: 1, vector: [1, 0] }]);

		expect(searchExactVectorIndex(index, [], 10)).toEqual([]);
		expect(searchExactVectorIndex(index, [Number.NaN], 10)).toEqual([]);
		expect(searchExactVectorIndex(index, [1, 0], 0)).toEqual([]);
	});
});
