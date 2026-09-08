import { expect, it } from "bun:test";
import { type Out, type Type, type } from "@oh-my-pi/omptype/ark";
import type { Eq } from "./type-assert";

type RegexExecArray<captures extends readonly string[], groups extends object, input extends string> = captures & {
	groups: groups;
	index: number;
	input: input;
};

it("with spaces", () => {
	const T = type("'this has spaces'");
	const _infer: Eq<typeof T.infer, "this has spaces"> = true;
	expect(_infer).toBe(true);
});

it("with neighbors", () => {
	const T = type("'foo'|/.*/[]");
	const _infer: Eq<typeof T.infer, "foo" | string[]> = true;
	expect(_infer).toBe(true);
});

it("unterminated regex", () => {
	expect(() => type("/.*")).toThrow();
});

it("unterminated single-quote", () => {
	expect(() => type("'.*")).toThrow();
});

it("unterminated double-quote", () => {
	expect(() => type('".*')).toThrow();
});

it("single-quoted", () => {
	const T = type("'hello'");
	const _infer: Eq<typeof T.infer, "hello"> = true;
	expect(_infer).toBe(true);
});

it("double-quoted", () => {
	const T = type('"goodbye"');
	const _infer: Eq<typeof T.infer, "goodbye"> = true;
	expect(_infer).toBe(true);
});

it("regex literal", () => {
	const T = type("/.*/");
	const _infer: Eq<typeof T.infer, string> = true;
	expect(_infer).toBe(true);
});

it("invalid regex", () => {
	expect(() => type("/[/")).toThrow('invalid regular expression "/[/"');
});

it("regex exec literal", () => {
	const T = type("x/^a(b)c$/");
	const _type: Eq<typeof T, Type<(In: "abc") => Out<RegexExecArray<["abc", "b"], {}, "">>>> = true;
	expect(_type).toBe(true);
	expect(T("abc")).toEqual(["abc", "b"]);
});

it("invalid regex exec literal", () => {
	expect(() => type("x/[/")).toThrow('invalid regular expression "/[/"');
});

it("nested regex exec literal", () => {
	const User = type({
		birthday: "x/^(?<month>\\d{2})-(?<day>\\d{2})-(?<year>\\d{4})$/",
	});

	const _type: Eq<
		typeof User,
		Type<{
			birthday: (
				In: `${number}-${number}-${number}`,
			) => Out<
				RegexExecArray<
					[`${number}-${number}-${number}`, `${number}`, `${number}`, `${number}`],
					{ month: `${number}`; day: `${number}`; year: `${number}` },
					""
				>
			>;
		}>
	> = true;
	expect(_type).toBe(true);

	const data = User.assert({ birthday: "05-21-1993" });
	expect(data.birthday.groups).toEqual({ month: "05", day: "21", year: "1993" });
});

it("mixed quote types", () => {
	const T = type(`"'single-quoted'"`);
	const _tInfer: Eq<typeof T.infer, "'single-quoted'"> = true;
	expect(_tInfer).toBe(true);

	const U = type(`'"double-quoted"'`);
	const _uInfer: Eq<typeof U.infer, '"double-quoted"'> = true;
	expect(_uInfer).toBe(true);
});

it("ignores enclosed operators", () => {
	const T = type("'yes|no|maybe'");
	const _infer: Eq<typeof T.infer, "yes|no|maybe"> = true;
	expect(_infer).toBe(true);
});

it("mix of enclosed and unenclosed operators", () => {
	const T = type("'yes|no'|'true|false'");
	const _infer: Eq<typeof T.infer, "yes|no" | "true|false"> = true;
	expect(_infer).toBe(true);
});

it("escaped enclosing", () => {
	const T = type("'don\\'t'");
	const _infer: Eq<typeof T.infer, "don't"> = true;
	expect(_infer).toBe(true);
});

it("escaped backslash", () => {
	const T = type("'\\\\'");
	const Expected = type.unit("\\");
	const _infer: Eq<typeof T.t, typeof Expected.t> = true;
	expect(_infer).toBe(true);
});

it("string literal stress", () => {
	const s = `"3.
14159265358979323846264338327950288419716939937510
58209749445923078164062862089986280348253421170679
82148086513282306647093844609550582231725359408128
48111745028410270193852110555964462294895493038196
44288109756659334461284756482337867831652712019091
45648566923460348610454326648213393607260249141273
72458700660631558817488152092096282925409171536436
78925903600113305305488204665213841469519415116094
33057270365759591953092186117381932611793105118548
07446237996274956735188575272489122793818301194912
98336733624406566430860213949463952247371907021798
60943702770539217176293176752384674818467669405132
00056812714526356082778577134275778960917363717872
14684409012249534301465495853710507922796892589235
42019956112129021960864034418159813629774771309960
51870721134999999837297804995105973173281609631859
50244594553469083026425223082533446850352619311881
71010003137838752886587533208381420617177669147303
59825349042875546873115956286388235378759375195778
185778053217122680661300192"`;
	const T = type(s);
	type Expected = typeof s extends `"${infer enclosed}"` ? enclosed : never;
	const _infer: Eq<typeof T.infer, Expected> = true;
	expect(_infer).toBe(true);
});
