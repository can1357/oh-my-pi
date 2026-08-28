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
		expect(pickQuotaShare([q("solo", 1, 4)])).toEqual({ id: "solo", disposition: "eligible" });
	});

	it("lets unsaturated win over a lower-inFlight higher-weight saturated peer", () => {
		const picked = pickQuotaShare([q("sat-idle-heavy", 100, 0, true), q("unsat-busy-light", 1, 50)]);
		expect(picked).toEqual({ id: "unsat-busy-light", disposition: "eligible" });
	});

	it("does not return undefined when every candidate is saturated (negative)", () => {
		const picked = pickQuotaShare([q("a", 1, 3, true), q("b", 9, 1, true)]);
		expect(picked).toBeDefined();
		expect(picked?.disposition).toBe("deprioritized");
		expect(picked?.id).toBe("b");
	});

	it("picks min inFlight among all-saturated, not the heavier busier peer (negative)", () => {
		const picked = pickQuotaShare([q("idle-light", 1, 0, true), q("busier-heavy", 10, 1, true)]);
		expect(picked).toEqual({ id: "idle-light", disposition: "deprioritized" });
	});

	it("returns deprioritized for a sole saturated candidate", () => {
		expect(pickQuotaShare([q("only-sat", 3, 2, true)])).toEqual({
			id: "only-sat",
			disposition: "deprioritized",
		});
	});

	it("among two unsaturated, picks higher weight of the two lowest inFlight", () => {
		const picked = pickQuotaShare([q("idle-light", 1, 0), q("busier-heavy", 10, 1)]);
		expect(picked).toEqual({ id: "busier-heavy", disposition: "eligible" });
	});

	it("does not pick a high-weight third outside the two lowest inFlight (negative)", () => {
		const picked = pickQuotaShare([q("idle", 1, 0), q("mid", 2, 1), q("busy-heavy", 100, 9)]);
		expect(picked).toEqual({ id: "mid", disposition: "eligible" });
		expect(picked?.id).not.toBe("busy-heavy");
	});

	it("among equal inFlight unsaturated, picks the higher weight", () => {
		const picked = pickQuotaShare([q("light", 1, 2), q("heavy", 8, 2)]);
		expect(picked).toEqual({ id: "heavy", disposition: "eligible" });
	});

	it("ignores a saturated idle when two unsaturated remain for P2C", () => {
		const picked = pickQuotaShare([q("sat", 100, 0, true), q("u1", 1, 2), q("u2", 5, 3)]);
		expect(picked).toEqual({ id: "u2", disposition: "eligible" });
	});

	it("breaks all-saturated inFlight ties with max weight", () => {
		const picked = pickQuotaShare([q("light", 1, 4, true), q("heavy", 7, 4, true)]);
		expect(picked).toEqual({ id: "heavy", disposition: "deprioritized" });
	});
});
