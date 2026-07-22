import { describe, expect, it } from "bun:test";
import { assertSqlIdentifier, quoteSqlIdentifier, quoteSqlQualifiedIdentifier } from "../src/util/sql";

describe("SQL identifier safety", () => {
	it("quotes validated identifier segments, including qualified names", () => {
		expect(assertSqlIdentifier("working_memory_2")).toBe("working_memory_2");
		expect(quoteSqlIdentifier("select")).toBe('"select"');
		expect(quoteSqlQualifiedIdentifier("main", "working_memory")).toBe('"main"."working_memory"');
	});

	it("rejects SQL syntax and empty qualified names", () => {
		expect(() => quoteSqlIdentifier('memories"; DROP TABLE memories; --')).toThrow("Invalid SQL identifier");
		expect(() => quoteSqlQualifiedIdentifier()).toThrow("requires at least one segment");
	});
});
