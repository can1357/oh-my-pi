import { expect, it } from "bun:test";
import { scope, type } from "@oh-my-pi/omptype/ark";

it("2 literal branches", () => {
	// should not use a switch with <=2 branches to avoid needless convolution
	const T = type("'a'|'b'");
	expect(T.allows("a")).toEqual(true);
	expect(T.allows("b")).toEqual(true);
	expect(T.allows("c")).toEqual(false);
});

it(">2 literal branches", () => {
	const T = type("'a'|'b'|'c'");
	expect(T.allows("a")).toEqual(true);
	expect(T.allows("b")).toEqual(true);
	expect(T.allows("c")).toEqual(true);
	expect(T.allows("d")).toEqual(false);
});

it(">2 domain branches", () => {
	const T = type("string|bigint|number");
	expect(T.allows("foo")).toEqual(true);
	expect(T.allows(5n)).toEqual(true);
	expect(T.allows(5)).toEqual(true);
	expect(T.allows(true)).toEqual(false);
});

it("literals can be included in domain branches", () => {
	const T = type("string|bigint|true");
	expect(T.allows("foo")).toEqual(true);
	expect(T.allows(5n)).toEqual(true);
	expect(T.allows(true)).toEqual(true);
	expect(T.allows(5)).toEqual(false);
});

const getPlaces = () =>
	scope({
		rainForest: {
			climate: "'wet'",
			color: "'green'",
			isRainForest: "true",
		},
		desert: { climate: "'dry'", color: "'brown'", isDesert: "true" },
		sky: { climate: "'dry'", color: "'blue'", isSky: "true" },
		ocean: { climate: "'wet'", color: "'blue'", isOcean: "true" },
	});

it("nested", () => {
	const $ = getPlaces();
	const climate = $.type("ocean | sky | rainForest | desert");

	const missingLabel = climate({
		climate: "wet",
		color: "blue",
	});

	expect(missingLabel.toString()).toBe("isOcean must be true (was missing)");

	const twoMissingKeys = climate({
		color: "blue",
	});

	expect(twoMissingKeys.toString()).toBe('climate must be "wet" or "dry" (was undefined)');
});

it("indiscriminable", () => {
	const T = getPlaces().type([
		"ocean",
		"|",
		{
			climate: "'wet'",
			color: "'blue'",
			indistinguishableFrom: "ocean",
		},
	]);

	expect(T.allows({ climate: "wet", color: "blue", isOcean: true })).toBe(true);
	expect(
		T.allows({
			climate: "wet",
			color: "blue",
			indistinguishableFrom: { climate: "wet", color: "blue", isOcean: true },
		}),
	).toBe(true);
	expect(T.allows({ climate: "wet", color: "green" })).toBe(false);
});

it("discriminate optional key", () => {
	const T = type({
		direction: "'forward' | 'backward'",
		"operator?": "'by'",
	}).or({
		duration: "'s' | 'min' | 'h'",
		operator: "'to'",
	});

	expect(T.allows({ direction: "forward" })).toBe(true);
	expect(T.allows({ direction: "backward", operator: "by" })).toBe(true);
	expect(T.allows({ duration: "min", operator: "to" })).toBe(true);
	expect(T.allows({ duration: "min", operator: "by" })).toBe(false);
});

it("overlapping default case", () => {
	const T = getPlaces().type(["ocean|rainForest", "|", { temperature: "'hot'" }]);

	expect(T.allows({ climate: "wet", color: "blue", isOcean: true })).toBe(true);
	expect(T.allows({ climate: "wet", color: "green", isRainForest: true })).toBe(true);
	expect(T.allows({ temperature: "hot" })).toBe(true);
	expect(T.allows({ temperature: "cold" })).toBe(false);
});

it("discriminable default", () => {
	const T = getPlaces().type([{ temperature: "'cold'" }, "|", ["ocean|rainForest", "|", { temperature: "'hot'" }]]);

	expect(T.allows({ temperature: "cold" })).toBe(true);
	expect(T.allows({ temperature: "hot" })).toBe(true);
	expect(T.allows({ climate: "wet", color: "blue", isOcean: true })).toBe(true);
	expect(T.allows({ temperature: "warm" })).toBe(false);
});

it("won't discriminate between possibly empty arrays", () => {
	const T = type("string[]|boolean[]");
	expect(T.allows([])).toBe(true);
	expect(T.allows(["value"])).toBe(true);
	expect(T.allows([false])).toBe(true);
	expect(T.allows([1])).toBe(false);
});

it("discriminant path including symbol", () => {
	const s = Symbol("lobmyS");
	const T = type({ [s]: "0" }).or({ [s]: "1" });
	expect(T.allows({ [s]: 0 })).toEqual(true);
	expect(T.allows({ [s]: -1 })).toEqual(false);

	expect(T({ [s]: 1 })).toEqual({ [s]: 1 });
	expect(T({ [s]: 2 }).toString()).toBe("[Symbol(lobmyS)] must be 0 or 1 (was 2)");
});

// https://github.com/arktypeio/arktype/issues/1100
it("discriminated null + object", () => {
	const Company = type({
		id: "number",
	}).or("string | null");

	expect(Company(null)).toEqual(null);
	expect(Company({ id: 1 })).toEqual({ id: 1 });
	expect(Company("foo")).toEqual("foo");
	expect(String(Company(5))).toBe("must be { id: a number }, a string or null (was a number)");
});

it("differing inner discriminated paths", () => {
	const Discriminated = type(
		{
			innerA: {
				id: "1",
			},
		},
		"|",
		{
			innerB: {
				id: "1",
			},
		},
	)
		.or({ innerA: { id: "2" } })
		.or({ innerB: { id: "2" } });

	expect(Discriminated({ innerA: { id: 1 } })).toEqual({ innerA: { id: 1 } });
	expect(Discriminated({ innerB: { id: 1 } })).toEqual({ innerB: { id: 1 } });
	expect(Discriminated({ innerA: { id: 2 } })).toEqual({ innerA: { id: 2 } });
	expect(Discriminated({ innerB: { id: 2 } })).toEqual({ innerB: { id: 2 } });

	expect(Discriminated({})?.toString()).toBe("innerB.id must be 1 or 2 (was undefined)");
});

it("allows strict discriminated keys", () => {
	const AorB = type({
		type: "'A'",
	})
		.or({
			type: "'B'",
		})
		.onUndeclaredKey("reject");

	expect(AorB({ type: "A" })).toEqual({ type: "A" });
	expect(AorB.allows({ type: "B" })).toBe(true);
	expect(AorB.allows({ type: "A", extra: true })).toBe(false);
});

it("can discriminated objects with disjoint strict keys", () => {
	const AorB = type({
		"+": "reject",
		something: "'A'",
	}).or({
		"+": "reject",
		something: "'B'",
		somethingelse: "number",
	});

	expect(AorB({ something: "A" })).toEqual({ something: "A" });
	expect(AorB({ something: "B", somethingelse: 1 })).toEqual({ something: "B", somethingelse: 1 });
	expect(AorB.allows({ something: "B" })).toBe(false);
});

it("includes non-disjoint branches in corresponding cases", () => {
	const T = type({
		id: "0",
		k1: "number",
	})
		.or({ id: "1", k1: "number" })
		.or({
			name: "string",
		});

	// should hit the case discriminated for id: 1,
	// but still resolve correctly via the { name: string } branch
	expect(T({ name: "foo", id: 1 })).toEqual({ name: "foo", id: 1 });
});

it("correctly dsicriminated onDeclaredKey: reject in the above scenario", () => {
	const T = type({
		id: "0",
		k1: "number",
	})
		.or({ id: "1", k1: "number" })
		.or({
			"+": "reject",
			name: "string",
		});

	// now that we are rejecting undeclared keys, all branches fail
	expect(T({ name: "foo", id: 1 }).toString()).toBe("k1 must be a number (was missing)");
});

it("discriminate array and tuple", () => {
	const T = type("null[] | false").or([type.undefined]);

	expect(T.allows(false)).toBe(true);
	expect(T.allows([null, null])).toBe(true);
	expect(T.allows([undefined])).toBe(true);
	expect(T.allows(true)).toBe(false);
	expect(T.allows([undefined, undefined])).toBe(false);
});

it("discriminate bounded array and tuple", () => {
	const T = type("3 <= null[] <= 10 | false").or([type.undefined]);

	expect(T.allows(false)).toBe(true);
	expect(T.allows([null, null, null])).toBe(true);
	// oxlint-disable-next-line unicorn/no-new-array -- length preallocation
	expect(T.allows(new Array(10).fill(null))).toBe(true);
	expect(T.allows([undefined])).toBe(true);
	expect(T.allows([null, null])).toBe(false);
	// oxlint-disable-next-line unicorn/no-new-array -- length preallocation
	expect(T.allows(new Array(11).fill(null))).toBe(false);
});

it("dimscrinate literal undefined value", () => {
	const T = type(["number[]", "|", ["undefined"]]);

	expect(T.assert([])).toEqual([]);
});

// https://github.com/arktypeio/arktype/issues/1547
it("discriminates cyclic union on nested path", () => {
	const s = scope({
		AChild: { type: "'AChild'", children: "(AParent)[] > 0" },
		AParent: { type: "'AParent'", children: "(AChild)[] > 0" },
		BChild: { type: "'BChild'", children: "unknown[]" },
		BParent: {
			type: "'BParent'",
			layout: "number[]",
			children: "(BChild)[] > 0",
		},
	});

	const Thing = s.type("AParent | BParent");

	expect(
		Thing({
			type: "BParent",
			layout: "",
			children: [{ type: "BChild", children: [] }],
		}).toString(),
	).toBe("layout must be an array (was a string)");
});
