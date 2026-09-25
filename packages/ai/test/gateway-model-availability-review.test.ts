import { expect, it } from "bun:test";
import { classifyGatewayError } from "../src/error/gateway";
it("uses statusless model availability codes without overriding an authoritative outage status", () => {
	const denied = Object.assign(new Error("not enabled"), { code: "model_not_available" });
	expect(classifyGatewayError(denied)).toMatchObject({
		status: 404,
		owner: "model",
		disposition: "model_unavailable",
	});
	expect(classifyGatewayError(Object.assign(denied, { status: 503 }))).toMatchObject({
		status: 503,
		owner: "provider",
		disposition: "provider_unavailable",
	});
});
