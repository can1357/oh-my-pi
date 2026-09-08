import { expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype/ark";
import type { Eq } from "../type-assert";

// by default because of the toJSON method, it wouldn't be clear
// if the snapshotted props were requied or optional
const snapshottableProps = (props: array<BaseTypeProp>) =>
	props.map(p => ({
		kind: p.kind,
		key: p.key,
		value: p.value.expression,
	}));

it("strings", () => {
	const T = type({
		foo: "1",
		bar: "2",
		"baz?": "3",
	});

	const _type1: Eq<
		typeof T.props,
		array<
			| BaseTypeProp<"required", "foo", 1, {}>
			| BaseTypeProp<"required", "bar", 2, {}>
			| BaseTypeProp<"optional", "baz", 3, {}>
		>
	> = true;

	expect(snapshottableProps(T.props)).toEqual([
		{ kind: "required", key: "foo", value: "1" },
		{ kind: "required", key: "bar", value: "2" },
		{ kind: "optional", key: "baz", value: "3" },
	]);
});

it("mixed keys", () => {
	const s = Symbol();
	const s2 = Symbol();

	const T = type({
		[s]: "1",
		[s2]: ["2", "?"],
		foo: "3",
		foo2: ["4", "?"],
	});

	const _type3: Eq<
		typeof T.infer,
		{
			[s]: 1;
			foo: 3;
			[s2]?: 2;
			foo2?: 4;
		}
	> = true;

	expect(snapshottableProps(T.props)).toEqual([
		{ kind: "required", key: "foo", value: "3" },
		{ kind: "optional", key: "foo2", value: "4" },
		{ kind: "required", key: s, value: "1" },
		{ kind: "optional", key: s2, value: "2" },
	]);
});

it("union", () => {
	const T = type({ foo: "string" }).or({ bar: "number" });
	expect(() => T.props).toThrow("props");
});

it("structural operation removes narrow", () => {
	const T = type({ foo: { key: "string" } })
		.narrow(o => o.foo.key.length > 0)
		.merge({
			foo: "null",
		});

	expect(T({ foo: null })).toEqual({ foo: null });
});

it("duplicate optional key", () => {
	expect(() =>
		type({
			a: "true",
			"a?": "true",
		}),
	).toThrow("a");
});

it("allows prototype method names as keys", () => {
	// constructor, hasOwnProperty, toString, etc. are valid object keys
	// and should not be incorrectly flagged as duplicates
	const T = type({
		constructor: "string",
		hasOwnProperty: "number",
		toString: "boolean",
	});

	const _type9: Eq<
		typeof T.t,
		{
			constructor: string;
			hasOwnProperty: number;
			toString: boolean;
		}
	> = true;
});
