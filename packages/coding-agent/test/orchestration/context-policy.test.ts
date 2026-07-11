import { describe, expect, it } from "bun:test";
import { resolveCollaborationPolicy } from "../../src/orchestration/collaboration-policy";
import {
	applyContextPolicy,
	applyContextPolicyWithSiblingFindings,
	compileLanePolicy,
} from "../../src/orchestration/context-policy";

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

	it("staged synthesis reveals sibling findings when requested", () => {
		const result = applyContextPolicyWithSiblingFindings("staged", "# Parent hypothesis\nFavored route A", {
			siblingFindings: "- persistence: schema mismatch in migration",
		});
		expect(result).toContain("Sibling Findings");
		expect(result).toContain("schema mismatch");
		expect(result).not.toContain("Favored route A");
	});

	it("compiles legacy context strings while clamping independent blind lanes", () => {
		const requested = resolveCollaborationPolicy({ mode: "self-coordinate", parentId: "Main" });
		const sharedContext = "# Goal\nImplement feature";
		const siblingFindings = "- evidence: alternate route";

		const shared = compileLanePolicy({
			contextPolicy: "shared",
			sharedContext,
			requestedCollaboration: requested,
		});
		expect(shared.context).toBe(applyContextPolicy("shared", sharedContext));
		expect(shared.collaboration).toBe(requested);

		const blind = compileLanePolicy({
			contextPolicy: "blind",
			sharedContext,
			requestedCollaboration: requested,
		});
		expect(blind.context).toBe(applyContextPolicy("blind", sharedContext));
		expect(blind.collaboration.mode).toBe("report-only");

		const stagedIndependent = compileLanePolicy({
			contextPolicy: "staged",
			sharedContext,
			requestedCollaboration: requested,
			phase: "independent",
		});
		expect(stagedIndependent.context).toBe(applyContextPolicy("staged", sharedContext));
		expect(stagedIndependent.collaboration.mode).toBe("report-only");

		const stagedRevealed = compileLanePolicy({
			contextPolicy: "staged",
			sharedContext,
			requestedCollaboration: requested,
			siblingFindings,
			phase: "evidence-reveal",
		});
		expect(stagedRevealed.context).toBe(
			applyContextPolicyWithSiblingFindings("staged", sharedContext, { siblingFindings }),
		);
		expect(stagedRevealed.collaboration).toBe(requested);
	});
});
