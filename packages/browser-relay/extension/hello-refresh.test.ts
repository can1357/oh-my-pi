import { describe, expect, it } from "bun:test";
import { invalidatesHelloStructurally } from "./hello-refresh";

describe("hello refresh invalidation", () => {
	it("treats URL and group changes as reconciliation state", () => {
		expect(invalidatesHelloStructurally({ url: "https://example.com/next" })).toBe(true);
		expect(invalidatesHelloStructurally({ groupId: -1 })).toBe(true);
	});

	it("keeps cosmetic tab churn metadata-only", () => {
		expect(invalidatesHelloStructurally({})).toBe(false);
	});
});
