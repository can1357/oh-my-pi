import { expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype/ark";

it("string.date", () => {
	const DateString = type("string.date");
	expect(DateString("2023-01-01")).toEqual("2023-01-01");
	expect(String(DateString("foo"))).toBe('must be a parsable date (was "foo")');
	expect(String(DateString(new Date()))).toBe("must be a string (was Date)");
});

it("string.date.parse", () => {
	const parseDate = type("string.date.parse");
	expect(parseDate("5/21/1993")).toEqual(new Date("5/21/1993"));
	expect(String(parseDate("foo"))).toBe('must be a parsable date (was "foo")');
	expect(String(parseDate(5))).toBe("must be a string (was a number)");
});

it("string.date.iso", () => {
	const IsoDate = type("string.date.iso");
	const d = new Date().toISOString();
	expect(IsoDate(d)).toEqual(d);
	expect(String(IsoDate("05-21-1993"))).toBe('must be an ISO 8601 date (was "05-21-1993")');
});
