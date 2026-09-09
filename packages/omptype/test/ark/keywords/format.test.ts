import { expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype/ark";

it("trim", () => {
	const trim = type("string.trim");
	expect(trim("  foo  ")).toEqual("foo");
	expect(String(trim(5))).toBe("must be a string (was a number)");
});

it("lower", () => {
	const lower = type("string.lower");
	expect(lower("FOO")).toEqual("foo");
	expect(String(lower(5))).toBe("must be a string (was a number)");
});

it("lower.preformatted", () => {
	const Lower = type("string.lower.preformatted");
	expect(Lower("var")).toBe("var");
	expect(String(Lower("newVar"))).toBe('must be only lowercase letters (was "newVar")');
});

it("upper", () => {
	const upper = type("string.upper");
	expect(upper("foo")).toEqual("FOO");
	expect(String(upper(5))).toBe("must be a string (was a number)");
});

it("upper.preformatted", () => {
	const Upper = type("string.upper.preformatted");
	expect(Upper("VAR")).toBe("VAR");
	expect(String(Upper("CONST_VAR"))).toBe('must be only uppercase letters (was "CONST_VAR")');
	expect(String(Upper("myVar"))).toBe('must be only uppercase letters (was "myVar")');
});

it("capitalize", () => {
	const capitalize = type("string.capitalize");
	expect(capitalize("foo")).toEqual("Foo");
	expect(String(capitalize(5))).toBe("must be a string (was a number)");
});

it("capitalize.preformatted", () => {
	const Capitalized = type("string.capitalize.preformatted");
	expect(Capitalized("Foo")).toEqual("Foo");
	expect(String(Capitalized("bar"))).toBe('must be capitalized (was "bar")');
});

it("normalize", () => {
	const normalize = type("string.normalize");
	expect(normalize("\u00F1")).toEqual("ñ");
	expect(normalize("\u006E\u0303")).toEqual("ñ");
	expect(normalize("\u00F1")).toEqual(normalize("\u006E\u0303"));
	expect(String(normalize(5))).toBe("must be a string (was a number)");
});
