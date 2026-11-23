import { mock, describe, expect, it } from "bun:test";

// The real @oh-my-pi/pi-utils pulls in the pi_natives native addon, which is
// not built in this environment; stub the handful of exports the hindsight
// modules use so the seed-race logic can be tested in isolation.
mock.module("@oh-my-pi/pi-utils", () => ({
	logger: { debug() {}, info() {}, warn() {}, error() {} },
	USER_AGENT: "omp-test",
	truncate: (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`),
	tryParseJson: (text: string) => {
		try {
			return JSON.parse(text) as unknown;
		} catch {
			return null;
		}
	},
}));

const { HindsightError } = await import("../src/hindsight/client");
const { ensureMentalModels, isDuplicateMentalModelError } = await import("../src/hindsight/mental-models");
type HindsightClientApi = import("../src/hindsight/client").HindsightClientApi;
type MentalModelSeed = import("../src/hindsight/mental-models").MentalModelSeed;

function fakeClient(overrides: Partial<HindsightClientApi>): HindsightClientApi {
	return {
		listMentalModels: async () => ({ items: [], total: 0 }),
		createMentalModel: async () => ({}),
		...overrides,
	} as HindsightClientApi;
}

const seed: MentalModelSeed = {
	id: "project-conventions-demo",
	name: "Project Conventions",
	sourceQuery: "*",
	tags: [],
};

describe("isDuplicateMentalModelError", () => {
	it("recognizes a 409 conflict as duplicate", () => {
		expect(isDuplicateMentalModelError(new HindsightError("createMentalModel failed", 409))).toBe(true);
	});

	it("recognizes a duplicate-key message from an older server", () => {
		expect(
			isDuplicateMentalModelError(
				new HindsightError(
					'createMentalModel failed: duplicate key value violates unique constraint "mental_models_pkey"',
				),
			),
		).toBe(true);
	});

	it("recognizes an already-exists message", () => {
		expect(isDuplicateMentalModelError(new HindsightError("createMentalModel failed: already exists"))).toBe(true);
	});

	it("does not treat other status codes or errors as duplicates", () => {
		expect(isDuplicateMentalModelError(new HindsightError("createMentalModel failed: boom", 500))).toBe(false);
		expect(isDuplicateMentalModelError(new Error("duplicate key"))).toBe(false);
		expect(isDuplicateMentalModelError(undefined)).toBe(false);
	});
});

describe("ensureMentalModels", () => {
	it("resolves without surfacing an error when a concurrent session already created the model", async () => {
		let creates = 0;
		const client = fakeClient({
			createMentalModel: async () => {
				creates++;
				throw new HindsightError("createMentalModel failed: duplicate key", 409);
			},
		});
		await expect(ensureMentalModels(client, "omp", [seed], false)).resolves.toBeUndefined();
		expect(creates).toBe(1);
	});

	it("still skips seeds already listed on the bank", async () => {
		let creates = 0;
		const client = fakeClient({
			listMentalModels: async () => ({ items: [{ id: seed.id, bank_id: "omp", name: seed.name }], total: 1 }),
			createMentalModel: async () => {
				creates++;
				return {};
			},
		});
		await ensureMentalModels(client, "omp", [seed], false);
		expect(creates).toBe(0);
	});
});
