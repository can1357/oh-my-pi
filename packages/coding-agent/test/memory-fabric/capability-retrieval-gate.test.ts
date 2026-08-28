/**
 * Tests for the observe-only capability retrieval gate + report.
 */

import { describe, expect, it } from "bun:test";
import type { RetrievalLike } from "@oh-my-pi/pi-coding-agent/memory-fabric/capability-retrieval-gate";
import {
	formatRetrievalReport,
	gateRetrieval,
} from "@oh-my-pi/pi-coding-agent/memory-fabric/capability-retrieval-gate";

function cleanRetrieval(overrides: Partial<RetrievalLike> = {}): RetrievalLike {
	return {
		enabled: true,
		seeds: ["a"],
		included: ["a", "b"],
		order: ["a", "b"],
		blocked: false,
		missing: [],
		decisions: [],
		needsUser: [],
		truncated: false,
		...overrides,
	};
}

describe("gateRetrieval", () => {
	it("returns an inert off decision when disabled", () => {
		const d = gateRetrieval(cleanRetrieval());
		expect(d.enabled).toBe(false);
		expect(d.status).toBe("denied");
		expect(d.decidedBy).toBe("disabled");
	});

	it("denies a mandatory-cycle-blocked retrieval even if the gate allows", () => {
		const d = gateRetrieval(cleanRetrieval({ blocked: true, order: null }), {
			enabled: true,
			gate: () => ({ allow: true }),
		});
		expect(d.status).toBe("denied");
		expect(d.decidedBy).toBe("mandatory-cycle");
		expect(d.blocked).toBe(true);
	});

	it("forces needs-approval when needsUser flags exist, even if the gate allows", () => {
		const d = gateRetrieval(
			cleanRetrieval({ needsUser: [{ kind: "safety-standoff", reason: "conflict", ids: ["a", "b"] }] }),
			{ enabled: true, gate: () => ({ allow: true }) },
		);
		expect(d.status).toBe("needs-approval");
		expect(d.decidedBy).toBe("needs-user");
		expect(d.needsUserCount).toBe(1);
	});

	it("resolves to needs-approval when no gate is supplied", () => {
		const d = gateRetrieval(cleanRetrieval(), { enabled: true });
		expect(d.status).toBe("needs-approval");
		expect(d.decidedBy).toBe("no-gate");
	});

	it("approves a clean retrieval when the gate allows", () => {
		const d = gateRetrieval(cleanRetrieval(), {
			enabled: true,
			gate: () => ({ allow: true, reason: "policy ok" }),
		});
		expect(d.status).toBe("approved");
		expect(d.decidedBy).toBe("gate-allow");
		expect(d.reason).toBe("policy ok");
	});

	it("resolves to needs-approval when the gate does not allow", () => {
		const d = gateRetrieval(cleanRetrieval(), { enabled: true, gate: () => ({ allow: false }) });
		expect(d.status).toBe("needs-approval");
		expect(d.decidedBy).toBe("gate-deny");
	});

	it("fails CLOSED (denied) when the gate throws", () => {
		const d = gateRetrieval(cleanRetrieval(), {
			enabled: true,
			gate: () => {
				throw new Error("boom");
			},
		});
		expect(d.status).toBe("denied");
		expect(d.decidedBy).toBe("gate-throw");
	});

	it("never throws on hostile input (fails closed to deny)", () => {
		const d = gateRetrieval(null as unknown as RetrievalLike, { enabled: true, gate: () => ({ allow: true }) });
		expect(d.mode).toBe("observe");
		expect(d.status).toBe("approved");
	});
});

describe("formatRetrievalReport", () => {
	it("reports a disabled retrieval as a one-liner", () => {
		expect(formatRetrievalReport({ enabled: false })).toBe("Capability retrieval: disabled (no projection).");
	});

	it("renders seeds, included, order, missing, decisions, and flags", () => {
		const text = formatRetrievalReport(
			cleanRetrieval({
				missing: ["ghost"],
				decisions: [{ a: "a", b: "b", action: "auto-drop", keep: "a", drop: "b" }],
				needsUser: [{ kind: "ask-user", reason: "pick one", ids: ["a", "b"] }],
				truncated: true,
			}),
		);
		expect(text).toContain("seeds:    a");
		expect(text).toContain("included: a, b");
		expect(text).toContain("order:    a -> b");
		expect(text).toContain("missing:  ghost");
		expect(text).toContain("a vs b: auto-drop keep=a drop=b");
		expect(text).toContain("[ask-user] pick one (a, b)");
		expect(text).toContain("truncated");
	});

	it("marks a blocked order and appends the gate decision line", () => {
		const retrieval = cleanRetrieval({ blocked: true, order: null });
		const decision = gateRetrieval(retrieval, { enabled: true });
		const text = formatRetrievalReport(retrieval, decision);
		expect(text).toContain("(blocked — mandatory cycle)");
		expect(text).toContain("gate decision: denied (mandatory-cycle)");
	});

	it("fails open to a short string on hostile input", () => {
		const hostile = new Proxy(
			{ enabled: true },
			{
				get(_target, prop) {
					if (prop === "enabled") return true;
					throw new Error("hostile");
				},
			},
		) as RetrievalLike;
		expect(formatRetrievalReport(hostile)).toBe("Capability retrieval: report unavailable.");
	});
});
