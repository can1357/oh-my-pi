import { expect, it } from "bun:test";
import { classifyGatewayError } from "../src/error/gateway";
import { enforceStrictSchema } from "../src/utils/schema/normalize";

it("keeps a circular strict schema terminal instead of retrying a provider", () => {
	const schema: Record<string, unknown> = { type: "object" };
	schema.properties = { recursive: schema };
	let caught: unknown;
	try {
		enforceStrictSchema(schema);
	} catch (error) {
		caught = error;
	}
	expect(classifyGatewayError(caught)).toMatchObject({ owner: "request", disposition: "request_terminal" });
});
