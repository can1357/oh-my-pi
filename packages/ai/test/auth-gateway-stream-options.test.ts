import { describe, expect, it } from "bun:test";
import { applyParsedGatewayOptions } from "@oh-my-pi/pi-ai/auth-gateway";
import type { SimpleStreamOptions } from "@oh-my-pi/pi-ai/types";

describe("applyParsedGatewayOptions", () => {
	it("forwards previousResponseId and parallelToolCalls onto SimpleStreamOptions", () => {
		const opts: SimpleStreamOptions = {};
		applyParsedGatewayOptions(opts, {
			previousResponseId: "resp_client_123",
			parallelToolCalls: false,
		});
		expect(opts.previousResponseId).toBe("resp_client_123");
		expect(opts.parallelToolCalls).toBe(false);
	});

	it("does not drop seed, logitBias, user, or responseFormat", () => {
		const opts: SimpleStreamOptions = {};
		applyParsedGatewayOptions(opts, {
			seed: 7,
			logitBias: { "42": -1 },
			user: "acct_1",
			responseFormat: { type: "json_object" },
		});
		expect(opts.seed).toBe(7);
		expect(opts.logitBias).toEqual({ "42": -1 });
		expect(opts.user).toBe("acct_1");
		expect(opts.responseFormat).toEqual({ type: "json_object" });
	});

	it("does not invent fields that were omitted (negative)", () => {
		const opts: SimpleStreamOptions = { temperature: 0.2 };
		applyParsedGatewayOptions(opts, { temperature: 0.9 });
		expect(opts.previousResponseId).toBeUndefined();
		expect(opts.parallelToolCalls).toBeUndefined();
		expect(opts.temperature).toBe(0.2);
	});
});
