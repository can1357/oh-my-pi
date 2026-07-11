import { describe, expect, it } from "bun:test";
import { applyContextPolicy, resolveWorkerMode } from "../../src/orchestration/context-policy";
import { getBundledAgent } from "../../src/task/agents";

describe("context policy", () => {
	it("withholds shared batch context for blind policy", () => {
		const result = applyContextPolicy("blind", "# Goal\nTry hypothesis A");
		expect(result).toContain("blind policy");
		expect(result).not.toContain("hypothesis A");
	});

	it("passes shared context through by default", () => {
		const shared = "# Goal\nImplement feature";
		expect(applyContextPolicy(undefined, shared)).toBe(shared);
	});

	it("loads falsify and audit bundled agents", () => {
		expect(getBundledAgent("falsify")?.name).toBe("falsify");
		expect(getBundledAgent("audit")?.name).toBe("audit");
		expect(resolveWorkerMode("falsify")).toBe("falsify");
		expect(resolveWorkerMode("audit")).toBe("audit");
	});
});
