import { describe, expect, it } from "bun:test";

import {
	BinaryVectorStore,
	cosineSimilarity,
	FastBinarySearch,
	getVecType,
	hammingDistance,
	informationTheoreticScore,
	maximallyInformativeBinarization,
	quantizeInt8,
} from "@oh-my-pi/pi-mnemopi/core/binary-vectors";

describe("binary vector helpers", () => {
	it("packs positive signs into Moorcheh MIB bit vectors", () => {
		const binary = maximallyInformativeBinarization([1, -1, 0, 2, -2, 0.1, -0.1, 3, -1, 1]);

		expect(Array.from(binary)).toEqual([0b10010101, 0b01000000]);
	});

	it("quantizes unit float vectors to signed int8", () => {
		const quantized = quantizeInt8([-2, -1, -0.5, 0, 0.5, 1, 2, Number.NaN]);

		expect(Array.from(quantized)).toEqual([-127, -127, -64, 0, 64, 127, 127, 0]);
	});

	it("computes Hamming distance and information-theoretic score", () => {
		const left = new Uint8Array([0b10100000, 0b11110000]);
		const right = new Uint8Array([0b00110000, 0b11000000]);

		expect(hammingDistance(left, right)).toBe(4);
		expect(informationTheoreticScore(4, 16)).toBe(0.75);
	});

	it("computes cosine similarity with zero-vector fallback", () => {
		expect(cosineSimilarity([1, 0], [1, 0])).toBe(1);
		expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
		expect(cosineSimilarity([0, 0], [1, 2])).toBe(0);
		expect(cosineSimilarity([1, 1], [1, 1])).toBeCloseTo(1, 12);
		expect(cosineSimilarity([1], [1, 1])).toBeCloseTo(Math.SQRT1_2, 12);
		expect(cosineSimilarity([Number.NaN, 1], [1, 0])).toBe(0);
	});

	it("normalizes MNEMOPI_VEC_TYPE with Python-compatible fallback", () => {
		expect(getVecType({ MNEMOPI_VEC_TYPE: "bit" })).toBe("bit");
		expect(getVecType({ MNEMOPI_VEC_TYPE: "int8" })).toBe("int8");
		expect(getVecType({ MNEMOPI_VEC_TYPE: "float32" })).toBe("float32");
		expect(getVecType({ MNEMOPI_VEC_TYPE: "bogus" })).toBe("float32");
		expect(getVecType({})).toBe("int8");
	});
});

describe("BinaryVectorStore", () => {
	it("stores, searches, deletes, and reports compact binary vectors", () => {
		const store = new BinaryVectorStore({ dbPath: ":memory:" });
		try {
			store.storeVector("same", [1, -1, 1, -1]);
			store.storeVector("opposite", [-1, 1, -1, 1]);
			store.storeVector("near", [1, -1, -1, -1]);

			const results = store.search([1, -1, 1, -1], 3);

			expect(results[0]).toMatchObject({ memory_id: "same", distance: 0, score: 1 });
			expect(results[1]?.memory_id).toBe("near");
			expect(results[1]?.distance).toBe(1);
			expect(results[2]?.memory_id).toBe("opposite");
			expect(results[2]?.distance).toBe(4);
			expect(results[2]?.score).toBeCloseTo(0, 12);

			const stats = store.getStats();
			expect(stats.total_vectors).toBe(3);
			expect(stats.avg_bytes_per_vector).toBe(1);
			expect(stats.max_bytes).toBe(1);
			expect(stats.min_bytes).toBe(1);

			store.deleteVector("near");
			expect(store.search([1, -1, 1, -1], 10).map(row => row.memory_id)).toEqual(["same", "opposite"]);
		} finally {
			store.close();
		}
	});

	it("searches preloaded binary vectors with FastBinarySearch", () => {
		const query = maximallyInformativeBinarization([1, -1, 1, -1]);
		const search = new FastBinarySearch({
			same: maximallyInformativeBinarization([1, -1, 1, -1]),
			far: maximallyInformativeBinarization([-1, 1, -1, 1]),
		});

		expect(search.search(query, 2).map(row => row.memory_id)).toEqual(["same", "far"]);
	});
});
