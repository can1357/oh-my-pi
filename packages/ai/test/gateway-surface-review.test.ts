import { expect, it } from "bun:test";
import { classifyGatewayError } from "../src/error/gateway";

it("treats a product-surface model denial as model availability without rotating healthy credentials", () => {
	const message = "This model is only available via Cline product surfaces";
	expect(classifyGatewayError(Object.assign(new Error(message), { status: 403 }))).toMatchObject({
		status: 403,
		owner: "model",
		disposition: "model_unavailable",
	});
	expect(classifyGatewayError(Object.assign(new Error(message), { status: 503 }))).toMatchObject({
		status: 503,
		owner: "provider",
		disposition: "provider_unavailable",
	});
});
