import { expect, test } from "bun:test";
import { editDistance } from "../src/distance";

const CASES: Array<[string, string, number]> = [
	["", "", 0],
	["", "abc", 3],
	["abc", "", 3],
	["kitten", "sitting", 3],
	["flaw", "lawn", 2],
	["saturday", "sunday", 3],
	["bamboo coffee mug", "bamboo coffee mug", 0],
	["bamboo coffee mug", "bambo cofee mug", 2],
	["copper frying pan large", "cooper frying pan", 7],
	["café", "cafe", 1],
];

test.each(CASES)("editDistance(%p, %p) = %p", (a, b, expected) => {
	expect(editDistance(a, b)).toBe(expected);
	expect(editDistance(b, a)).toBe(expected);
});
