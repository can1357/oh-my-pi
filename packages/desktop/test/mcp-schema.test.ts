import { describe, expect, test } from "bun:test";
import { fieldsFor, TRANSPORTS } from "../src/manage/mcp-schema";

/**
 * Exercises the resolver against omp's real `mcp-schema.json`, imported by
 * relative path. If omp changes the schema, these fail — which is the point:
 * the MCP form is generated from it rather than mirroring it by hand.
 */
describe("MCP schema → form fields", () => {
	test("resolves the allOf + $ref composition every transport uses", () => {
		// Each transport is `allOf: [serverBase, {…}]`, so a resolver that does not
		// flatten would return nothing at all.
		for (const transport of TRANSPORTS) {
			expect(fieldsFor(transport).length).toBeGreaterThan(0);
		}
	});

	test("stdio requires a command and carries its process fields", () => {
		const fields = fieldsFor("stdio");
		const names = fields.map(field => field.name);

		expect(names).toContain("command");
		expect(names).toContain("args");
		expect(names).toContain("env");
		expect(names).toContain("cwd");

		const command = fields.find(field => field.name === "command");
		expect(command?.required).toBe(true);
		expect(command?.type).toBe("string");

		expect(fields.find(field => field.name === "args")?.type).toBe("array");
	});

	test("inherits serverBase fields through the allOf branch", () => {
		// `enabled` and `timeout` live on serverBase, not on stdioServer itself.
		const names = fieldsFor("stdio").map(field => field.name);
		expect(names).toContain("enabled");
		expect(names).toContain("timeout");
	});

	test("http and sse are url-shaped, not command-shaped", () => {
		for (const transport of ["http", "sse"] as const) {
			const names = fieldsFor(transport).map(field => field.name);
			expect(names).toContain("url");
			expect(names).not.toContain("command");
		}
	});

	test("the discriminant is not offered as a field", () => {
		// The transport picker owns `type`; showing it too would let the two
		// disagree.
		for (const transport of TRANSPORTS) {
			expect(fieldsFor(transport).map(field => field.name)).not.toContain("type");
		}
	});

	test("required fields sort first so the form leads with them", () => {
		const fields = fieldsFor("stdio");
		const firstOptional = fields.findIndex(field => !field.required);
		const lastRequired = fields.map(field => field.required).lastIndexOf(true);
		if (firstOptional !== -1 && lastRequired !== -1) {
			expect(lastRequired).toBeLessThan(firstOptional);
		}
	});

	test("an unknown transport yields nothing instead of throwing", () => {
		expect(fieldsFor("nope" as never)).toEqual([]);
	});
});
