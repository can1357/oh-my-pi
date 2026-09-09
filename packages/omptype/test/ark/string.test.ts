import { expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype/ark";
import type { Eq } from "./type-assert";

it("errors on empty string", () => {
	expect(() => type("")).toThrow();
});

it("ignores whitespace between identifiers/operators", () => {
	const T = type(`  \n   string  |
           number
    \t|boolean    []   `);
	const _type: Eq<typeof T.infer, string | number | boolean[]> = true;
	expect(T.json).toEqual(type("string|number|boolean[]").json);
});

it("errors on bad whitespace", () => {
	expect(() => type("string | boo lean[]")).toThrow();
});

it("unterminated string", () => {
	expect(() => type("'bob")).toThrow();
});

it.todo("shallow single autocomplete");

it.todo("shallow multi autocomplete");

it.todo("post-operator autocomplete");

it.todo("post-operator autocomplete with spaces");
