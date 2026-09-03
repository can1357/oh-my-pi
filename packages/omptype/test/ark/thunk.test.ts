import { expect, it } from "bun:test";
import { type Scope, scope, type } from "@oh-my-pi/omptype/ark";
import type { Eq } from "./type-assert";

it("in type", () => {
	const T = type(() => type("boolean"));
	const _assert1: Eq<typeof T.infer, boolean> = true;
	expect(() => {
		type(() => type("moolean"));
	}).toThrow();
});

it("in scope", () => {
	const $ = scope({
		a: () => $.type({ b: "b" }),
		b: () => $.type({ a: "string" }),
	});
	const _assert2: Eq<
		(typeof $)["t"],
		{
			a: {
				b: {
					a: string;
				};
			};
			b: {
				a: string;
			};
		}
	> = true;

	const types = $.export();
	const _assert3: Eq<
		typeof types.a.infer,
		{
			b: {
				a: string;
			};
		}
	> = true;

	expect(types.a({ b: { a: "ok" } })).toEqual({ b: { a: "ok" } });
	const _assert4: Eq<typeof types.b.infer, { a: string }> = true;

	expect(types.b({ a: "ok" })).toEqual({ a: "ok" });
});

it("expression from thunk", () => {
	const $ = scope({
		a: () => $.type({ a: "string" }),
		b: { b: "boolean" },
		aAndB: () => $.type("a&b"),
	});
	const types = $.export();
	const _assert5: Eq<typeof types.aAndB.infer, { a: string; b: boolean }> = true;
	expect(types.aAndB({ a: "ok", b: true })).toEqual({ a: "ok", b: true });
	expect(types.aAndB({ a: "ok", b: 1 }).toString()).toBe("b must be boolean (was a number)");
});

it("shallow in type", () => {
	const T = type(() => type("string"));
	expect(T("ok")).toBe("ok");
	const _assert6: Eq<typeof T.infer, string> = true;
});

it("deep in type", () => {
	const T = type({ a: () => type("string") });
	expect(T.json).toEqual(type({ a: "string" }).json);
	const _assert7: Eq<typeof T.infer, { a: string }> = true;
});

it("non-type thunk in scope", () => {
	const $ = scope({
		a: () => 42,
	});
	expect(() => $.export()).toThrow("number");
});

it("parse error in thunk in scope", () => {
	const $ = scope({
		a: () => $.type("bad"),
	});
	expect(() => $.export()).toThrow("bad");
});

it("docs example", () => {
	const $ = type.scope({
		id: "string#id",
		expandUserGroup: () =>
			$.type({
				name: "string",
				id: "id",
			})
				.or("id")
				.pipe(function _docsExampleThunkMorph(user) {
					return typeof user === "string" ? { id: user, name: "Anonymous" } : user;
				})
				.array()
				.atLeastLength(2),
	});

	const _docsExample: Eq<
		typeof $,
		Scope<{
			id: string & { readonly __brand: "id" };
			expandUserGroup: ((
				In:
					| string
					| {
							name: string;
							id: string;
					  },
			) => {
				name: string;
				id: string & { readonly __brand: "id" };
			})[];
		}>
	> = true;

	const types = $.export();

	const groups = types.expandUserGroup([{ name: "Magical Crawdad", id: "777" }, "778"]);

	type BrandedId = typeof types.id.t;

	expect(groups).toEqual([
		{ name: "Magical Crawdad", id: "777" as BrandedId },
		{ id: "778" as BrandedId, name: "Anonymous" },
	]);
});

it("docs inelegant", () => {
	// you *can* use them anywhere, but *should* you? (no)
	const Inelegant = type(() => type({ inelegantKey: () => type("'inelegant value'") }));

	void Inelegant.t;
	expect(Inelegant.expression).toBe('{ inelegantKey: "inelegant value" }');
});
