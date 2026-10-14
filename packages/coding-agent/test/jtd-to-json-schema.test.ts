import { describe, expect, it } from "bun:test";
import { jtdToJsonSchema } from "@oh-my-pi/pi-coding-agent/tools/jtd-to-json-schema";
import { buildOutputValidator } from "@oh-my-pi/pi-coding-agent/tools/output-schema-validator";

describe("jtdToJsonSchema", () => {
	it("resolves escaped ref names for full and incremental output validation", () => {
		const schema = {
			definitions: { "a/b~c": { properties: { answer: { type: "string" } } } },
			ref: "a/b~c",
		};
		const converted = jtdToJsonSchema(schema) as Record<string, unknown>;
		expect(converted.$ref).toBe("#/$defs/a~1b~0c");
		const { validator, error } = buildOutputValidator(schema);
		expect(error).toBeUndefined();
		if (!validator) throw new Error("expected an output validator");
		expect(validator.validate({ answer: "yes" }).success).toBe(true);
		expect(validator.validate({ answer: 42 }).success).toBe(false);
		expect(validator.requiredFields).toEqual(["answer"]);
		expect(validator.rejectUnknownSections).toBe(true);
		expect(validator.isKnownSection("unknown")).toBe(false);
		const validateAnswer = validator.validateSection.get("answer");
		if (!validateAnswer) throw new Error("expected an answer section validator");
		expect(validateAnswer("yes").success).toBe(true);
		expect(validateAnswer(42).success).toBe(false);
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
