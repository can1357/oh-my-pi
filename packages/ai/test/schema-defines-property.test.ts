import { expect, it } from "bun:test";
import { schemaDefinesProperty } from "@oh-my-pi/pi-ai/utils/schema/json-schema-validator";

/**
 * `schemaDefinesProperty` answers whether a JSON-Schema graph owns a property
 * name. The answer is memoized per schema, so a cache that keyed by the
 * property name alone (or a single shared entry) would hand one schema's
 * answer to another. These cases pin the observable contract a consumer
 * depends on: each schema and each property name keeps its own answer across
 * repeated calls, in any order.
 */
it("keeps each schema's answer to itself across repeated calls", () => {
	const ownsIntent = { type: "object", properties: { i: { type: "string" } } };
	const ownsPath = { type: "object", properties: { path: { type: "string" } } };

	expect(schemaDefinesProperty(ownsIntent, "i")).toBe(true);
	expect(schemaDefinesProperty(ownsPath, "i")).toBe(false);

	// Same two schemas again, reversed: a cache keyed by the property name
	// would now answer "true" for the schema that does not own it.
	expect(schemaDefinesProperty(ownsPath, "i")).toBe(false);
	expect(schemaDefinesProperty(ownsIntent, "i")).toBe(true);
});

it("keeps each property name's answer to itself within one schema", () => {
	const schema = { type: "object", properties: { i: { type: "string" }, path: { type: "string" } } };

	expect(schemaDefinesProperty(schema, "i")).toBe(true);
	expect(schemaDefinesProperty(schema, "path")).toBe(true);
	expect(schemaDefinesProperty(schema, "missing")).toBe(false);
	expect(schemaDefinesProperty(schema, "i")).toBe(true);
	expect(schemaDefinesProperty(schema, "missing")).toBe(false);
});
