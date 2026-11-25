import { expect, test } from "bun:test";
import { slugify } from "../src/slug";

test.each([
	["Top 10 Tips", "top-10-tips"],
	["2024 Review", "2024-review"],
	["v2.1 release", "v2-1-release"],
	["Crème Brûlée", "creme-brulee"],
	["Ångström units", "angstrom-units"],
	["  --Hello,   World!!  ", "hello-world"],
	["a__b", "a-b"],
	["!!!", ""],
])("slugify(%p) = %p", (title, slug) => {
	expect(slugify(title)).toBe(slug);
});
