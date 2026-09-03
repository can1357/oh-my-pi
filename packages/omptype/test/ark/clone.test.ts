import { expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype/ark";

it("preserves the original references if no morphs are present", () => {
	const T = type({ foo: "string" });
	const original = { foo: "bar" };
	expect(T(original)).toBe(original);
});

it("clones by default before morphing", () => {
	const T = type({ foo: "string.trim" });
	const original = { foo: "  bar  " };
	expect(T(original)).toEqual({ foo: "bar" });
	expect(original).toEqual({ foo: "  bar  " });
});

it("default clone implementation preserves prototypes", () => {
	const T = type(["Date", "=>", d => d.toISOString()]);
	expect(T.from(new Date(Date.UTC(2000, 1, 1)))).toEqual("2000-02-01T00:00:00.000Z");
});

it("can be configured to mutate", () => {
	const types = type.module({ trimAndMutate: { foo: "string.trim" } }, { clone: false });
	const original = { foo: "  bar  " };
	const out = types.trimAndMutate(original);
	expect(out).toEqual({ foo: "bar" });
	expect(out).toBe(original);
});

it("can be configured to mutate", () => {
	const types = type.module({ trimAndMutate: { foo: "string.trim" } }, { clone: false });
	const original = { foo: "  bar  " };
	const out = types.trimAndMutate(original);
	expect(out).toEqual({ foo: "bar" });
	expect(out).toBe(original);
});

it("can be configured to use a custom clone implementation", () => {
	const types = type.module(
		{ trimAndMutate: { foo: "string.trim" } },
		{ clone: original => ({ ...original, customCloned: true }) },
	);
	expect(types.trimAndMutate({ foo: "  bar  " })).toEqual({ foo: "bar", customCloned: true });
});

it("can clone process.env", () => {
	const Env = type({ "+": "delete", PATH: type.unit(process.env.PATH) });
	const originalEnv = { ...process.env };
	expect(Env(process.env)).toEqual({ PATH: process.env.PATH });
	expect({ ...process.env }).toEqual(originalEnv);
});
