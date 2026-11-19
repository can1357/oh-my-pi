import { expect, it } from "bun:test";
import { scope, type } from "@oh-my-pi/omptype/ark";
import type { Eq } from "./type-assert";

it("resolves from type", () => {
	const DisappointingGift = type({
		label: "string",
		"box?": "this",
	});

	type ExpectedDisappointingGift = {
		label: string;
		box?: ExpectedDisappointingGift;
	};
	const _assert1: Eq<typeof DisappointingGift.infer, ExpectedDisappointingGift> = true;

	expect(DisappointingGift({ label: "foo" })).toEqual({ label: "foo" });
	expect(DisappointingGift({ label: "foo", box: { label: "bar" } })).toEqual({
		label: "foo",
		box: { label: "bar" },
	});
	expect(
		DisappointingGift({
			label: "foo",
			box: { label: "bar", box: {} },
		}).toString(),
	).toBe("box.box.label must be a string (was missing)");
});

it("at nested path", () => {
	const T = type({ foo: { bar: "this" } });

	void T;

	const validData = { foo: { bar: {} } } as typeof T.infer;
	validData.foo.bar = validData;

	expect(T(validData)).toEqual(validData);

	const invalidData = { foo: { bar: {} as any } };
	invalidData.foo.bar = invalidData.foo;
	expect(T(invalidData).toString()).toBe("foo.bar.foo must be an object (was missing)");
});

it("this preserved when referencing at path", () => {
	const Initial = type({
		initial: "this",
	});

	const Reference = type({
		reference: Initial,
	});
	type Initial = {
		initial: Initial;
	};
	type Expected = {
		reference: Initial;
	};

	const _assert2: Eq<typeof Reference.infer, Expected> = true;

	const initialData = {} as typeof Initial.infer;
	initialData.initial = initialData;

	const referenceData = { reference: initialData };

	expect(Initial(initialData)).toEqual(initialData);
	expect(Reference(referenceData)).toEqual(referenceData);
	expect(Reference({ reference: {} }).toString()).toBe("reference.initial must be an object (was missing)");
});

it("unresolvable in scope", () => {
	expect(() =>
		scope({
			disappointingGift: {
				label: "string",
				"box?": "this",
			},
		}).export(),
	).toThrow();
});

it("tuple expression", () => {
	const T = type([{ a: "string" }, "|", { b: "this" }]);
	void T.infer;
	expect(T({ a: "foo" })).toEqual({ a: "foo" });
	expect(T({ b: { a: "bar" } })).toEqual({ b: { a: "bar" } });
	expect(T({ b: { b: {} } }).toString()).toBe(
		"a must be a string (was missing) or b.a must be a string (was missing) or b.b.a must be a string (was missing) or b.b.b must be an object (was missing)",
	);
});

it("root expression", () => {
	const T = type({ a: "string" }, "|", { b: "this" });
	void T.infer;
	expect(T({ a: "foo" })).toEqual({ a: "foo" });
	expect(T({ b: { a: "bar" } })).toEqual({ b: { a: "bar" } });
	expect(T({ b: { b: {} } }).toString()).toBe(
		"a must be a string (was missing) or b.a must be a string (was missing) or b.b.a must be a string (was missing) or b.b.b must be an object (was missing)",
	);
});
