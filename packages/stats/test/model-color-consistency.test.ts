import { describe, expect, it } from "bun:test";
import { buildModelColorLookup, MODEL_COLORS } from "../src/client/components/chart-shared";

type ModelRequestRecord = Readonly<{
	model: string;
	provider: string;
	totalRequests: number;
}>;

describe("buildModelColorLookup", () => {
	it("ranks by requests and keeps provider variants distinct", () => {
		const records: readonly ModelRequestRecord[] = [
			{ model: "Luna", provider: "provider-luna", totalRequests: 10_505 },
			{ model: "Sol", provider: "provider-sol", totalRequests: 389 },
			{ model: "Fable", provider: "provider-fable", totalRequests: 106 },
			{ model: "Opus", provider: "provider-opus", totalRequests: 191 },
			{ model: "Shared", provider: "provider-z", totalRequests: 5 },
			{ model: "Shared", provider: "provider-a", totalRequests: 5 },
		];
		const originalRecords = records.map(record => ({ ...record }));

		const lookup = buildModelColorLookup(records);

		expect(lookup.get("Luna::provider-luna")).toBe(MODEL_COLORS[0]);
		expect(lookup.get("Sol::provider-sol")).toBe(MODEL_COLORS[1]);
		expect(lookup.get("Opus::provider-opus")).toBe(MODEL_COLORS[2]);
		expect(lookup.get("Fable::provider-fable")).toBe(MODEL_COLORS[3]);
		expect(lookup.get("Shared::provider-a")).toBe(MODEL_COLORS[4]);
		expect(lookup.get("Shared::provider-z")).toBe(MODEL_COLORS[5]);
		expect(lookup.get("Shared::provider-a")).not.toBe(lookup.get("Shared::provider-z"));
		expect(records).toEqual(originalRecords);
	});
});
