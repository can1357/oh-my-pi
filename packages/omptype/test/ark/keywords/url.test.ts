import { expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype/ark";
import type { Eq } from "../type-assert";

it("root", () => {
	const Url = type("string.url");

	const _0: Eq<typeof Url.infer, string> = true;

	expect(Url("https://arktype.io")).toBe("https://arktype.io");
	expect(String(Url("arktype"))).toBe('must be a URL string (was "arktype")');
});

it("parse", () => {
	const parseUrl = type("string.url.parse");

	const _1: Eq<typeof parseUrl.infer, URL> = true;
	expect(parseUrl("https://arktype.io")).toBeInstanceOf(URL);
	expect(String(parseUrl("arktype"))).toBe('must be a URL string (was "arktype")');
});
