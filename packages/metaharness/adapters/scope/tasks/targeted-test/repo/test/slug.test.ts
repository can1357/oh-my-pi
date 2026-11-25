import { expect, test } from "bun:test";
import { slugify } from "../src/slug";

test("joins words with dashes", () => {
	expect(slugify("Hello World")).toBe("hello-world");
});

test("drops punctuation at the edges", () => {
	expect(slugify("  Hello, World!  ")).toBe("hello-world");
});

test("collapses runs of separators", () => {
	expect(slugify("a -- b")).toBe("a-b");
});
