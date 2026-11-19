import { describe, expect, it } from "bun:test";
import { resolveSubscriptionPostAction } from "@oh-my-pi/pi-coding-agent/mcp/manager";

describe("resolveSubscriptionPostAction", () => {
	it("returns rollback when notifications are disabled", () => {
		expect(resolveSubscriptionPostAction(false, 5, 5)).toBe("rollback");
		expect(resolveSubscriptionPostAction(false, 10, 2)).toBe("rollback");
	});

	it("returns ignore when notifications are enabled but epoch is stale", () => {
		expect(resolveSubscriptionPostAction(true, 8, 7)).toBe("ignore");
	});

	it("returns apply when notifications are enabled and epoch matches", () => {
		expect(resolveSubscriptionPostAction(true, 3, 3)).toBe("apply");
	});
});
