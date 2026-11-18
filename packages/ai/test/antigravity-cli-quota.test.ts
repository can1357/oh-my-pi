import { describe, expect, it } from "bun:test";
import { quotaExhaustion } from "../src/providers/antigravity-cli/quota";

const notice = "Usage Limit Reached\n\nYou have reached your current quota for this period.";

describe("quotaExhaustion", () => {
	it("parses the relative reset from the official notice", () => {
		const now = Date.parse("2026-11-16T00:00:00Z");
		expect(quotaExhaustion(`${notice} Your limit will reset in 2 hours.`, now)).toEqual({
			resetAt: "2026-11-16T02:00:00.000Z",
		});
	});

	it("parses the absolute reset from the official notice", () => {
		expect(quotaExhaustion(`${notice} Your limit will reset on Nov 20, 2026 22:56 UTC.`)).toEqual({
			resetAt: "2026-11-20T22:56:00.000Z",
		});
	});

	it("still reports exhaustion when the reset wording is unknown", () => {
		expect(quotaExhaustion(notice)).toEqual({});
		expect(quotaExhaustion(`${notice} Your limit will reset eventually.`)).toEqual({});
	});

	it("rejects malformed relative reset wording without a timestamp", () => {
		expect(quotaExhaustion(`${notice} Your limit will reset in 2 hours3 minutes.`)).toEqual({});
		expect(quotaExhaustion(`${notice} Your limit will reset in 2 hours, .`)).toEqual({});
	});

	it("ignores ordinary assistant text", () => {
		expect(quotaExhaustion("Here is the answer.")).toBeUndefined();
	});
});
