import { describe, expect, it } from "bun:test";
import { finalize } from "../src/error/finalize";
import { withAuth } from "../src/auth-retry";
import { OpenAIHttpError } from "../src/error/classes";

// The display formatter must not discard evidence that callers use for routing.
describe("provider error evidence", () => {
	it("exposes a missing credential structurally when dispatch cannot start", async () => {
		let dispatched = false;
		try {
			await withAuth(undefined, async () => {
				dispatched = true;
			});
			throw new Error("expected missing credential failure");
		} catch (error) {
			const result = await finalize(error);
			expect(result.errorCode).toBe("missing_api_key");
			expect(dispatched).toBe(false);
		}
	});

	it("retains billing type and code while formatting an HTTP failure", async () => {
		const response = {
			status: 402,
			headers: new Headers(),
			bodyJson: { error: { type: "billing_error", code: "billing_not_configured", message: "Payment required" } },
			bodyText: '{"error":{"type":"billing_error","code":"billing_not_configured"}}',
		};
		const result = await finalize(new OpenAIHttpError("Payment required", response), {
			capturedErrorResponse: response,
		});
		expect(result).toMatchObject({
			status: 402,
			errorType: "billing_error",
			errorCode: "billing_not_configured",
			stopReason: "error",
		});
	});
});
