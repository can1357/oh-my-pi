import { expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype/ark";
import type { Eq } from "./type-assert";

it("base", () => {
	const T = type("d'2000/05/05'");
	const _type: Eq<typeof T.infer, Date> = true;
	expect(T.allows(new Date("2000/05/05"))).toEqual(true);
	expect(T.allows(new Date("2000/06/05"))).toEqual(false);
	expect(T.allows(new Date("2000-05-05T09:00:00.000Z"))).toEqual(false);
});

it("with punctuation", () => {
	const ISO = type("d'2000-05-05T04:00:00.000Z'");
	const _type: Eq<typeof ISO.infer, Date> = true;
	expect(ISO.allows(new Date("2000-05-05T04:00:00.000Z"))).toEqual(true);
	expect(ISO.allows(new Date("2000/07/05"))).toEqual(false);
});

it("allows spaces", () => {
	const T = type("d' 2021  /  05  /  01  '");
	expect(T.allows(new Date("2021/05/01"))).toEqual(true);
});

it("epoch", () => {
	const now = new Date();
	const T = type(`d'${now.valueOf()}'`);
	expect(T.allows(now)).toEqual(true);
	expect(T.allows(new Date(now.valueOf() + 1))).toEqual(false);
});

it("invalid date", () => {
	expect(() => type("d'tuesday'")).toThrow();
});

it("morphable", () => {
	const T = type(["Date", "=>", d => d.toISOString()]);
	const input = new Date(2000, 1);
	expect(T.from(input)).toBe(input.toISOString());
});
