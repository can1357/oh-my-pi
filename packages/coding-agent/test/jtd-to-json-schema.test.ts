import { describe, expect, it } from "bun:test";
import { jtdToJsonSchema } from "@oh-my-pi/pi-coding-agent/tools/jtd-to-json-schema";

describe("jtdToJsonSchema", () => {
	it("escapes ref names per JSON Pointer", () => {
		const converted = jtdToJsonSchema({
			definitions: { "a/b~c": { type: "string" } },
			ref: "a/b~c",
		}) as Record<string, unknown>;
		expect(converted.$ref).toBe("#/$defs/a~1b~0c");
		const defs = converted.$defs as Record<string, unknown>;
		expect(Object.keys(defs)).toEqual(["a/b~c"]);
	});

	it("maps the JTD root definitions to $defs so refs resolve", () => {
		const converted = jtdToJsonSchema({
			definitions: { name: { type: "string" } },
			properties: { name: { ref: "name" } },
		}) as Record<string, unknown>;
		expect(converted.$defs).toMatchObject({ name: { type: "string" } });
		const props = converted.properties as Record<string, unknown>;
		expect(props.name).toEqual({ $ref: "#/$defs/name" });
	});

	it("leaves ref documents without definitions unchanged", () => {
		expect(jtdToJsonSchema({ ref: "x" })).toEqual({ $ref: "#/$defs/x" });
	});
});
