import { describe, expect, it } from "bun:test";
import { pickQuotaShare, type QuotaShareInput } from "@oh-my-pi/pi-ai/auth-gateway/quota-share";

function q(id: string, weight: number, inFlight: number, saturated = false): QuotaShareInput {
	return { id, weight, inFlight, saturated };
}

describe("pickQuotaShare", () => {
	it("returns undefined for an empty list", () => {
		expect(pickQuotaShare([])).toBeUndefined();
	});

	it("picks a sole unsaturated candidate as eligible", () => {
		expect(pickQuotaShare([q("solo", 1, 4)])).toMatchObject({ id: "solo", disposition: "eligible" });
	});

	it("lets unsaturated win over a lower-inFlight higher-weight saturated peer", () => {
		const picked = pickQuotaShare([q("sat-idle-heavy", 100, 0, true), q("unsat-busy-light", 1, 50)]);
		expect(picked).toMatchObject({ id: "unsat-busy-light", disposition: "eligible" });
	});

	it("does not return undefined when every candidate is saturated (negative)", () => {
		const picked = pickQuotaShare([q("a", 1, 3, true), q("b", 9, 1, true)]);
		expect(picked).toBeDefined();
		expect(picked?.disposition).toBe("deprioritized");
		expect(picked?.id).toBe("b");
	});

	it("picks min inFlight among all-saturated, not the heavier busier peer (negative)", () => {
		const picked = pickQuotaShare([q("idle-light", 1, 0, true), q("busier-heavy", 10, 1, true)]);
		expect(picked).toMatchObject({ id: "idle-light", disposition: "deprioritized" });
	});

	it("returns deprioritized for a sole saturated candidate", () => {
		expect(pickQuotaShare([q("only-sat", 3, 2, true)])).toMatchObject({
			id: "only-sat",
			disposition: "deprioritized",
		});
	});

	it("among two unsaturated, picks higher weight of the two lowest inFlight", () => {
		const picked = pickQuotaShare([q("idle-light", 1, 0), q("busier-heavy", 10, 1)]);
		expect(picked).toMatchObject({ id: "busier-heavy", disposition: "eligible" });
	});

	it("does not pick a high-weight third outside the two lowest inFlight (negative)", () => {
		const picked = pickQuotaShare([q("idle", 1, 0), q("mid", 2, 1), q("busy-heavy", 100, 9)]);
		expect(picked).toMatchObject({ id: "mid", disposition: "eligible" });
		expect(picked?.id).not.toBe("busy-heavy");
	});

	it("among equal inFlight unsaturated, picks the higher weight", () => {
		const picked = pickQuotaShare([q("light", 1, 2), q("heavy", 8, 2)]);
		expect(picked).toMatchObject({ id: "heavy", disposition: "eligible" });
	});

	it("ignores a saturated idle when two unsaturated remain for P2C", () => {
		const picked = pickQuotaShare([q("sat", 100, 0, true), q("u1", 1, 2), q("u2", 5, 3)]);
		expect(picked).toMatchObject({ id: "u2", disposition: "eligible" });
	});

	it("breaks all-saturated inFlight ties with max weight", () => {
		const picked = pickQuotaShare([q("light", 1, 4, true), q("heavy", 7, 4, true)]);
		expect(picked).toMatchObject({ id: "heavy", disposition: "deprioritized" });
	});
});

describe("pickQuotaShare DRR fairness", () => {
	it("alternates equally healthy accounts instead of hammering the top-ranked", () => {
		const a = { id: "a", weight: 1, inFlight: 0, saturated: false };
		const b = { id: "b", weight: 1, inFlight: 0, saturated: false };
		const first = pickQuotaShare([a, b])!;
		expect(first.id).toBe("a");
		// persist the returned accounting
		a.deficit = first.deficitUpdates.find(u => u.id === "a")!.deficit;
		b.deficit = first.deficitUpdates.find(u => u.id === "b")!.deficit;
		const second = pickQuotaShare([a, b])!;
		expect(second.id).toBe("b");
	});

	it("reproduces pure P2C when deficits are all zero (negative)", () => {
		const pick = pickQuotaShare([
			{ id: "a", weight: 1, inFlight: 0, saturated: false },
			{ id: "b", weight: 3, inFlight: 0, saturated: false },
		])!;
		expect(pick.id).toBe("b");
	});

	it("keeps saturated pools deprioritized without deficit churn", () => {
		const pick = pickQuotaShare([
			{ id: "a", weight: 1, inFlight: 0, saturated: true },
			{ id: "b", weight: 1, inFlight: 0, saturated: true },
		])!;
		expect(pick.disposition).toBe("deprioritized");
		expect(pick.deficitUpdates).toEqual([]);
	});
});
