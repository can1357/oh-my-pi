import { describe, expect, it } from "bun:test";
import { findDuplicateJsonKey } from "@oh-my-pi/pi-utils/json-lexer";

// `JSON.parse` keeps only the last value for a repeated key, and a `reviver` is
// invoked once per SURVIVING member, so a duplicate is unrecoverable after
// parsing. Config loaders that must fail loudly rather than silently adopt the
// last spelling need this pre-parse scan.
describe("findDuplicateJsonKey", () => {
	it("returns undefined for an object with distinct keys", () => {
		expect(findDuplicateJsonKey(`{"a":1,"b":2}`)).toBeUndefined();
	});

	it("finds a repeated key and reports its name", () => {
		expect(findDuplicateJsonKey(`{"a":1,"a":2}`)).toBe("a");
	});

	it("finds a repeat nested one level deeper", () => {
		expect(findDuplicateJsonKey(`{"outer":{"a":1,"a":2}}`)).toBe("a");
	});

	// The same key in two SIBLING objects is legal JSON: each object has its own
	// namespace, so a per-object seen-set is required rather than a global one.
	it("allows the same key in sibling objects", () => {
		expect(findDuplicateJsonKey(`{"x":{"a":1},"y":{"a":2}}`)).toBeUndefined();
	});

	// Array members are positional, so nothing in one can collide — and a string
	// element must never be mistaken for a key.
	it("does not treat array elements as keys", () => {
		expect(findDuplicateJsonKey(`{"a":["k","k"],"b":["k"]}`)).toBeUndefined();
	});

	it("finds a repeated key after an array value", () => {
		expect(findDuplicateJsonKey(`{"a":[1,2],"a":3}`)).toBe("a");
	});

	// A value string equal to a key is the classic false positive: only the
	// member name position may seed the seen-set.
	it("does not report a value string that repeats its own key", () => {
		expect(findDuplicateJsonKey(`{"a":"a","b":"a"}`)).toBeUndefined();
	});

	// Without escape handling the scan ends the string at the backslash-quote,
	// resyncs half a token off, and misses the repeat entirely.
	it("stays in sync across an escaped quote in a value", () => {
		expect(findDuplicateJsonKey(`{"p":"x\\"","a":1,"a":2}`)).toBe("a");
	});

	// Two spellings of ONE key: keys are compared decoded, since that is what
	// `JSON.parse` collapses them to before dropping one.
	it("compares keys decoded, so escape spellings collide", () => {
		expect(findDuplicateJsonKey(`{"a\\u002db":1,"a-b":2}`)).toBe("a-b");
	});

	// A key whose value contains braces, brackets and commas must not disturb
	// the nesting the scan tracks.
	it("ignores structural characters inside strings", () => {
		expect(findDuplicateJsonKey(`{"a":"},{[\\"z\\"]","b":1}`)).toBeUndefined();
		expect(findDuplicateJsonKey(`{"a":"},{[\\"z\\"]","a":1}`)).toBe("a");
	});

	// Malformed text is the caller's parser's to reject — this scan runs beside
	// a real parse, not in place of one. So it must neither throw nor report a
	// duplicate: a key becomes a member only once its `:` arrives, so a key
	// truncated before that colon never survived into the parsed object and
	// nothing was dropped for it to collide with.
	it("reports no duplicate for malformed input", () => {
		expect(findDuplicateJsonKey(`{"a":`)).toBeUndefined();
		expect(findDuplicateJsonKey(`{"unterminated`)).toBeUndefined();
	});

	// The colon is the member boundary, but a truncated document is malformed
	// either way, so BOTH spellings must stay silent. The previous expectation
	// here — `{"a":1,"a":` reporting `"a"` — contradicted the documented
	// contract: it is not valid JSON, so the caller's parser owns it.
	it("reports no duplicate for a truncated document, colon or not", () => {
		expect(findDuplicateJsonKey(`{"a":1,"a"`)).toBeUndefined();
		expect(findDuplicateJsonKey(`{"a":1,"a":`)).toBeUndefined();
	});

	// The scan walks structure, not grammar, so these reach a genuine second
	// `"a":` and the raw scan would report a duplicate. A real parse refuses
	// them, so the retained candidate must be discarded.
	it("reports no duplicate when a complete repeat sits in malformed input", () => {
		// Unclosed object.
		expect(findDuplicateJsonKey(`{"a":1,"a":2`)).toBeUndefined();
		// Missing value.
		expect(findDuplicateJsonKey(`{"a":1,"a":}`)).toBeUndefined();
		// Trailing garbage after a document that is otherwise fine.
		expect(findDuplicateJsonKey(`{"a":1,"a":2}}`)).toBeUndefined();
	});

	// The confirmation must not suppress real duplicates in valid documents,
	// including nested inside an array.
	it("still reports a duplicate in a valid document", () => {
		expect(findDuplicateJsonKey(`{"a":1,"a":2}`)).toBe("a");
		expect(findDuplicateJsonKey(`[{"a":1,"a":2}]`)).toBe("a");
	});

	// An unterminated key never became a real member, so it cannot have been
	// dropped by a duplicate and must not be reported as one.
	it("does not report an unterminated key as a duplicate", () => {
		expect(findDuplicateJsonKey(`{"a":1,"a`)).toBeUndefined();
	});

	it("reports nothing for a non-object document", () => {
		expect(findDuplicateJsonKey(`[1,2,3]`)).toBeUndefined();
		expect(findDuplicateJsonKey(`"a"`)).toBeUndefined();
	});
});
