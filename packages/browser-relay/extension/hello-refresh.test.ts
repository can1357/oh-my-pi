import { describe, expect, it } from "bun:test";
import {
	invalidatesHelloStructurally,
	shouldSuppressHelloSnapshot,
} from "./hello-refresh";

describe("hello refresh invalidation", () => {
	it("treats URL and group changes as reconciliation state", () => {
		expect(invalidatesHelloStructurally({ url: "https://example.com/next" })).toBe(true);
		expect(invalidatesHelloStructurally({ groupId: -1 })).toBe(true);
	});

	it("keeps cosmetic tab churn metadata-only", () => {
		expect(invalidatesHelloStructurally({})).toBe(false);
	});

	it("suppresses the first stale URL snapshot but bounds continuous churn", () => {
		expect(shouldSuppressHelloSnapshot(false, true, false)).toBe(true);
		expect(shouldSuppressHelloSnapshot(false, true, true)).toBe(false);
		expect(shouldSuppressHelloSnapshot(true, true, true)).toBe(true);
	});
});
