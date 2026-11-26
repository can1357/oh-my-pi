import { expect, test } from "bun:test";
import { slugify } from "../src/slug";

test("lowercases and joins words with dashes", () => {
	expect(slugify("Hello World")).toBe("hello-world");
});

test("keeps digits", () => {
	expect(slugify("Top 10 Tips")).toBe("top-10-tips");
});

test("strips accents", () => {
	expect(slugify("Crème Brûlée")).toBe("creme-brulee");
});

test("collapses separator runs and trims both ends", () => {
	expect(slugify("  --Hello,   World!!  ")).toBe("hello-world");
});
