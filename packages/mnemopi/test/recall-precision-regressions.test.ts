import { afterEach, describe, expect, it } from "bun:test";
import { BeamMemory } from "@oh-my-pi/pi-mnemopi/core/beam";
import { storeFactStrings } from "@oh-my-pi/pi-mnemopi/core/beam/consolidate";

type TestBeam = BeamMemory;

const beams: TestBeam[] = [];

function makeBeam(): TestBeam {
	const beam = new BeamMemory({ sessionId: "precision", dbPath: ":memory:" });
	beams.push(beam);
	return beam;
}

afterEach(() => {
	while (beams.length > 0) beams.pop()?.close();
});

function seedPrecisionFixture(beam: TestBeam): void {
	for (const content of [
		"Project Orion lab runner starts from the OpenJDK downloads directory with artifact orion-runner-2026.4.jar and must bind only to 127.0.0.1.",
		"For training modules, display full course titles only: Application Security, Data Analysis, Database Design, Technical Writing, and Product Marketing; never use abbreviated module codes in user-facing summaries.",
		"Scheduled automation prompts must discover current context dynamically at runtime by reading files and querying memory; do not hardcode stale project facts.",
		"For the conference trip, the attendee stays at Hotel Meridian and the safer running plan is rideshare to Central Park Loop, then run the 1.6 km park loops.",
		"Inference routing after Premium Plan: avoid BudgetCloud unless approved; foreground chat uses Model-A and Model-B is preferred for scheduled and background work.",
		"Portfolio checkpoint review is due June 5, 2026, marked lower urgency but useful to maintain momentum.",
	]) {
		beam.remember(content, {
			source: "imported_fixture",
			importance: 0.6,
			scope: "global",
			veracity: "unknown",
		});
	}
}

async function expectTopContains(beam: TestBeam, query: string, expected: string): Promise<void> {
	const results = await beam.recall(query, 5, { queryTime: "2026-05-30T12:00:00.000Z" });
	expect(results.length).toBeGreaterThan(0);
	expect(results[0]?.content.toLowerCase()).toContain(expected.toLowerCase());
}

function bulletLinesUnder(context: string, heading: string): string[] {
	const start = context.indexOf(heading);
	if (start < 0) return [];
	const rest = context.slice(start + heading.length);
	const nextHeading = rest.search(/\n## /);
	const section = nextHeading >= 0 ? rest.slice(0, nextHeading) : rest;
	return section.split("\n").filter(line => line.startsWith("- "));
}

describe("recall precision regressions", () => {
	it("prefers the artifact memory for a natural deployment question", async () => {
		const beam = makeBeam();
		seedPrecisionFixture(beam);

		await expectTopContains(beam, "Where is the Orion runner jar and how should it bind?", "orion-runner-2026.4.jar");
	});

	it("ranks the correct fact first for specific memory probes", async () => {
		const beam = makeBeam();
		seedPrecisionFixture(beam);

		for (const [query, expected] of [
			["What training module naming rule avoids abbreviated codes?", "Application Security"],
			["How should scheduled automation handle context instead of hardcoding facts?", "dynamically"],
			["What Hotel Meridian running route plan should be used?", "Central Park Loop"],
			["What inference routing rule says avoid BudgetCloud?", "avoid BudgetCloud"],
		] as const) {
			await expectTopContains(beam, query, expected);
		}
	});

	it("abstains on nonsense and single-token overlap noise", async () => {
		const beam = makeBeam();
		seedPrecisionFixture(beam);
		beam.remember("Quantum field theory research notes are stored in the physics archive.", {
			source: "imported_fixture",
			importance: 0.9,
			scope: "global",
		});
		beam.remember("Invoice drills use the order identifier as the primary key.", {
			source: "imported_fixture",
			importance: 0.9,
			scope: "global",
		});

		expect(await beam.recall("zxqvplm norf greeble snargle twompset", 5)).toEqual([]);
		expect(await beam.recall("purple bicycle quantum oatmeal unrelated", 5)).toEqual([]);
		expect(await beam.recall("customer invoices quantum", 5)).toEqual([]);
	});

	it("keeps separate aspects of a multi-fact query in top results", async () => {
		const beam = makeBeam();
		seedPrecisionFixture(beam);
		beam.remember("Ava profile URL is https://example.test/ava for her professional page.", {
			source: "imported_fixture",
			importance: 0.6,
			scope: "global",
		});
		beam.remember("Ava rejects AI hype positioning and wants grounded software builder wording.", {
			source: "imported_fixture",
			importance: 0.6,
			scope: "global",
		});
		for (let n = 0; n < 10; n += 1) {
			beam.remember(
				`Ava profile checklist item ${n}: professional photo headline about section skills portfolio connections completed.`,
				{ source: "imported_fixture", importance: 0.8, scope: "global" },
			);
		}

		const joined = (
			await beam.recall("What is Ava profile URL and professional branding preference?", 5, {
				queryTime: "2026-05-30T12:00:00.000Z",
			})
		)
			.map(result => result.content.toLowerCase())
			.join("\n");

		expect(joined).toContain("https://example.test/ava");
		expect(joined).toContain("grounded software builder");
	});

	it("prefers a current correction over stale history", async () => {
		const beam = makeBeam();
		const oldId = beam.remember(
			"Project Atlas deployment target was legacy-cluster and should use Model-Old for background work.",
			{ source: "imported_fixture", importance: 0.7, scope: "global" },
		);
		const newId = beam.remember(
			"Current Project Atlas deployment target is stable-cluster and should use Model-New for background work.",
			{ source: "imported_fixture", importance: 0.7, scope: "global" },
		);
		beam.db.prepare("UPDATE working_memory SET timestamp = ? WHERE id = ?").run("2025-01-01T00:00:00.000Z", oldId);
		beam.db.prepare("UPDATE working_memory SET timestamp = ? WHERE id = ?").run("2026-05-24T00:00:00.000Z", newId);

		const results = await beam.recall("What should Project Atlas deployment use now?", 3, {
			queryTime: "2026-05-30T12:00:00.000Z",
		});

		expect(results.length).toBeGreaterThan(0);
		expect(results[0]?.content).toContain("stable-cluster");
	});

	it("surfaces extracted flat facts proportionally and buckets each fact once", async () => {
		const beam = makeBeam();
		const facts = [
			"redis cluster runs on port 6379",
			"api-server depends on redis for session storage",
			"redis eviction policy is allkeys-lru",
			"redis maxmemory is set to 4gb",
			"redis persistence uses append-only file",
			"worker queues are backed by redis streams",
			"redis sentinel handles failover",
			"cache invalidation publishes to redis pubsub",
		];
		storeFactStrings(beam, facts, 0, "repro-source");

		const results = await beam.recallEnhanced("redis", 20, { includeFacts: true });
		const factContents = results.filter(result => result.tier === "fact").map(result => result.content);
		expect(factContents.toSorted()).toEqual(facts.toSorted());

		const context = beam.formatContext(results, "bullet");
		expect(bulletLinesUnder(context, "## Top Facts")).toHaveLength(3);
		expect(bulletLinesUnder(context, "## Supporting Context")).toHaveLength(5);
		expect(context).not.toContain("## Recent Signals");
		const bullets = context.split("\n").filter(line => line.startsWith("- "));
		expect(new Set(bullets).size).toBe(bullets.length);
	});

	it("keeps small enhanced fact recalls filled and split into supporting context", async () => {
		const beam = makeBeam();
		const facts = ["redis alpha runs on port 6379", "redis beta handles failover"];
		storeFactStrings(beam, facts, 0, "repro-source");

		const results = await beam.recallEnhanced("redis", 2, { includeFacts: true });
		const factContents = results.filter(result => result.tier === "fact").map(result => result.content);
		expect(factContents.toSorted()).toEqual(facts.toSorted());

		const context = beam.formatContext(results, "bullet");
		expect(bulletLinesUnder(context, "## Top Facts")).toHaveLength(1);
		expect(bulletLinesUnder(context, "## Supporting Context")).toHaveLength(1);
		expect(context).not.toContain("## Recent Signals");
	});

	it("does not recall flat facts through storage-only fact/entity fields", () => {
		const beam = makeBeam();
		storeFactStrings(beam, ["redis cluster runs on port 6379"], 0, "repro-source");

		expect(beam.factRecall("fact entity", 10)).toEqual([]);
		expect(beam.factRecall("redis", 10).map(result => result.content)).toEqual(["redis cluster runs on port 6379"]);
	});
});
