import { describe, expect, it } from "bun:test";
import { type Type, type } from "@oh-my-pi/omptype/ark";
import { regex } from "arkregex";
import type { Eq } from "./type-assert";

describe("intersection", () => {
	it("distinct strings", () => {
		const T = type("/a/&/b/");
		const _type: Eq<typeof T.infer, `${string}a${string}` & `${string}b${string}`> = true;
		expect(T.allows("a")).toEqual(false);
		expect(T.allows("b")).toEqual(false);
		expect(T.allows("ab")).toEqual(true);
	});

	it("identical strings", () => {
		const T = type("/a/&/a/");
		expect(T.allows("a")).toBe(true);
	});

	it("string and list", () => {
		const Expected = type("/a/&/b/&/c/").json;
		expect(Expected).toBeDefined();
	});

	it("redundant string and list", () => {
		const Expected = type("/a/&/b/&/c/").json;
		expect(Expected).toBeDefined();
	});

	it("distinct lists", () => {
		const T = type(["/a/&/b/", "&", "/c/&/d/"]);
		expect(T.allows("abcd")).toBe(true);
	});

	it("overlapping lists", () => {
		const T = type(["/a/&/b/", "&", "/c/&/b/"]);
		expect(T.allows("abc")).toBe(true);
	});

	it("identical lists", () => {
		const T = type(["/a/&/b/", "&", "/b/&/a/"]);
		expect(T.allows("ab")).toBe(true);
	});
});

describe("instance", () => {
	it("flagless", () => {
		const T = type(/.*/);
		const _type: Eq<typeof T.infer, string> = true;
	});

	it("single flag preserved", () => {
		const T = type(/a/i);
		expect(T.allows("A")).toEqual(true);
	});

	it("flag order doesn't matter", () => {
		const A = type(/a/gi);
		const B = type(/a/gi);
		expect(A.json).toEqual(B.json);
	});
});

describe("chained", () => {
	it("matching", () => {
		const T = type("string").matching("foo");
		const Expected = type("/foo/");
		const _type: Eq<typeof T, typeof Expected> = true;
	});

	it("invalid operand", () => {
		expect(() => type("number").matching("foo")).toThrow();
	});
});

it("expression doesn't include string basis", () => {
	const T = type(/^a.*z$/);
	expect(T.allows("abz")).toBe(true);
});

it("arkregex integration", () => {
	const T = type({
		email: regex("^.*@.*$"),
	});
	const _type: Eq<
		typeof T,
		Type<{
			email: `${string}@${string}`;
		}>
	> = true;
});
