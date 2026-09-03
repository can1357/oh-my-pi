import { it } from "bun:test";
import { scope, type } from "@oh-my-pi/omptype/ark";
import type { Eq } from "./type-assert";

it("ark", () => {
	const def = type.define({
		a: "string|number",
		b: ["boolean"],
	});
	const _assert1: Eq<typeof def, { a: "string|number"; b: readonly ["boolean"] }> = true;
});

it.todo("type attached");

it("ark error", () => {
	// currently is a no-op, so only has type error
	void (() => type.define({ a: "boolean|foo" }));
});

it("custom scope", () => {
	const $ = scope({
		a: "string[]",
	});

	const ok = $.define(["a[]|boolean"]);
	const _assert3: Eq<typeof ok, readonly ["a[]|boolean"]> = true;

	void (() => $.define({ not: "ok" }));
});
