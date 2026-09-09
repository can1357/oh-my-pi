import { expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype/ark";
import type { Eq } from "./type-assert";

it("entire expression", () => {
	const T = type("(string)");
	const Expected = type("string");
	const _1: Eq<typeof T, typeof Expected> = true;
	expect(T.json).toEqual(Expected.json);
});

it("overrides default precedence", () => {
	const T = type("(boolean|number)[]");
	const Expected = type("boolean|number").array();
	const _2: Eq<typeof T, typeof Expected> = true;
	expect(T.json).toEqual(Expected.json);
});

it("nested", () => {
	const T = type("((boolean|number)[]|(string|undefined)[])[]");
	const _3: Eq<typeof T.infer, ((number | boolean)[] | (string | undefined)[])[]> = true;
});

it("empty", () => {
	expect(() => {
		type("()");
	}).toThrow();
});

it("unmatched (", () => {
	expect(() => {
		type("string|(boolean|number[]");
	}).toThrow();
});

it("unmatched )", () => {
	expect(() => {
		type("string|number[]|boolean)");
	}).toThrow();
});

it("lone )", () => {
	expect(() => {
		type(")");
	}).toThrow();
});

it("lone (", () => {
	expect(() => {
		type("(");
	}).toThrow();
});

it("deep unmatched (", () => {
	expect(() => {
		type("(null|(undefined|(1))|2");
	}).toThrow();
});

it("deep unmatched )", () => {
	expect(() => {
		type("((string|number)[]|boolean))[]");
	}).toThrow();
});

it("starting )", () => {
	expect(() => {
		type(")number(");
	}).toThrow();
});
