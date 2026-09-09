import { expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype/ark";

it("no shallow default in tuple expression", () => {
	expect(() => type(["string?", "|", "number"])).toThrow();

	expect(() => type(["string", "|", ["number", "?"]])).toThrow();
});

it("no shallow default in scope", () => {
	expect(() => type.module({ foo: "string?" })).toThrow();

	expect(() => type.module({ foo: ["string", "?"] })).toThrow();
});
