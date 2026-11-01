import { describe, expect, it } from "bun:test";
import { formatTtsrRecordKey, parseTtsrRecordKey } from "@oh-my-pi/pi-utils/ttsr-record-key";

describe("TTSR record keys", () => {
	it("round-trips a scoped key whose rule name contains `::`", () => {
		const key = formatTtsrRecordKey("a::b", "0f1e");
		expect(key).toBe("a::b::scope:0f1e");
		expect(parseTtsrRecordKey(key)).toEqual({ name: "a::b", scopeHash: "0f1e" });
	});

	it("keeps an unscoped rule's key as its bare name, including for an empty hash", () => {
		expect(formatTtsrRecordKey("a::b")).toBe("a::b");
		expect(formatTtsrRecordKey("a::b", "")).toBe("a::b");
		expect(parseTtsrRecordKey("a::b")).toEqual({ name: "a::b" });
	});

	it("reads a non-hex or empty scope suffix as part of a bare name", () => {
		expect(parseTtsrRecordKey("a::scope:not-hex")).toEqual({ name: "a::scope:not-hex" });
		expect(parseTtsrRecordKey("a::scope:")).toEqual({ name: "a::scope:" });
	});
});
