import { describe, expect, it } from "bun:test";
import {
	invalidatesHelloReconciliation,
	shouldSuppressHelloSnapshot,
} from "./hello-refresh";

describe("hello refresh invalidation", () => {
	it("treats URL and group changes as reconciliation state", () => {
		expect(invalidatesHelloReconciliation({ url: "https://example.com/next" })).toBe(true);
		expect(invalidatesHelloReconciliation({ groupId: -1 })).toBe(true);
	});

	it("keeps cosmetic tab churn metadata-only", () => {
		expect(invalidatesHelloReconciliation({})).toBe(false);
	});

	it("suppresses the first stale reconciliation snapshot but bounds continuous churn", () => {
		expect(shouldSuppressHelloSnapshot(false, true, false)).toBe(true);
		expect(shouldSuppressHelloSnapshot(false, true, true)).toBe(false);
		expect(shouldSuppressHelloSnapshot(true, true, true)).toBe(true);
	});
});
