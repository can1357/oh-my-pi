import { describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype/ark";
import type { Eq } from "./type-assert";

describe("intersections", () => {
	it("class & literal", () => {
		const a = [0];
		const Literal = type("===", a);
		const Cls = type("instanceof", Array);
		const lr = Literal.and(Cls);
		const _type: Eq<typeof lr.infer, number[]> = true;
		expect(lr.json).toEqual(Literal.json);
		const rl = Cls.and(Literal);
		const _typeRl: Eq<typeof rl.infer, number[]> = true;
		expect(rl.json).toEqual(Literal.json);
	});

	it("unsatisfiable class & literal", () => {
		const a = [0];
		const Literal = type("===", a);
		const Cls = type("instanceof", Date);
		expect(() => Literal.and(Cls)).toThrow();
		expect(() => Cls.and(Literal)).toThrow();
	});

	it("domain & literal", () => {
		const Literal = type("'foo'");
		const Domain = type("string");
		expect(Literal.and(Domain).json).toEqual(Literal.json);
		expect(Domain.and(Literal).json).toEqual(Literal.json);
	});

	it("unsatisfiable domain & literal", () => {
		const Literal = type("'foo'");
		const Domain = type("number");
		expect(() => Literal.and(Domain)).toThrow();
		expect(() => Domain.and(Literal)).toThrow();
	});

	it("domain & class", () => {
		const Domain = type("object");
		const Cls = type("instanceof", Date);
		expect(Domain.and(Cls).json).toEqual(Cls.json);
		expect(Cls.and(Domain).json).toEqual(Cls.json);
	});
});
