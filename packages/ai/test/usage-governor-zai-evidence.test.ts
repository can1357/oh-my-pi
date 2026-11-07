import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import type { UsageProvider, UsageReport } from "@oh-my-pi/pi-ai/usage";
import { zaiRankingStrategy, zaiUsageProvider } from "@oh-my-pi/pi-ai/usage/zai";
import { CredentialGovernor } from "../src/auth/governor";
import { installFetchTripwire } from "./fixtures/usage-governor/harness";

installFetchTripwire();
const BASE_URL = "https://api.z.ai/api/coding/paas/v4";
const KEY = "zai-test-key";
const TARGET = { selector: "zai/glm-5.3-flash", provider: "zai", modelId: "glm-5.3-flash", baseUrl: BASE_URL };

class World {
	dir = "";
	store!: SqliteAuthCredentialStore;
	auth!: AuthStorage;
	fetches = 0;
	report: UsageReport = {
		provider: "zai",
		fetchedAt: Date.now(),
		metadata: { accountId: "account-1", planType: "pro" },
		limits: [
			{
				id: "zai:credits:5h",
				label: "ZAI 5 Hour Credit Quota",
				scope: { provider: "zai", shared: true },
				window: { id: "5h", label: "5 Hours", durationMs: 18_000_000, resetsAt: Date.now() + 14_400_000 },
				amount: { unit: "credits", usedFraction: 0.9 },
				observedAt: Date.now(),
			},
		],
	};
	adapter: UsageProvider = {
		...zaiUsageProvider,
		fetchUsage: async () => {
			this.fetches++;
			return structuredClone(this.report);
		},
	};
	async open() {
		this.dir = await fs.mkdtemp(path.join(os.tmpdir(), "zai-governor-evidence-"));
		this.store = await SqliteAuthCredentialStore.open(path.join(this.dir, "auth.db"));
		this.auth = new AuthStorage(this.store, {
			usageProviderResolver: id => (id === "zai" ? this.adapter : undefined),
			rankingStrategyResolver: id => (id === "zai" ? zaiRankingStrategy : undefined),
			governor: {
				dbPath: path.join(this.dir, "governor.db"),
				config: { enabled: true, lead: 0.25, interactiveReserve: "hold" },
			},
		});
		this.auth.governor.setRoutingScope({ id: "scope", revision: 1, roles: [{ role: "task", targets: [TARGET] }] });
		await this.auth.credentials.set("zai", [{ type: "api_key", key: KEY, source: "login" }]);
		await this.auth.usage.reports({ provider: "zai", baseUrlResolver: () => BASE_URL });
		return this;
	}
	async evaluate(modelId = TARGET.modelId) {
		const target = { ...TARGET, modelId };
		// A routing target is constrained to the registered scope.
		const scopeId = `scope-${modelId}`;
		this.auth.governor.setRoutingScope({ id: scopeId, revision: 1, roles: [{ role: "task", targets: [target] }] });
		return this.auth.governor.evaluateRoutes({
			scopeId,
			revision: 1,
			role: "task",
			sessionId: "test",
			targets: [target],
		});
	}
	async close() {
		this.auth?.close();
		this.store?.close();
		if (this.dir) await fs.rm(this.dir, { recursive: true, force: true });
	}
}
let world: World | undefined;
afterEach(async () => {
	await world?.close();
	world = undefined;
});
async function setup() {
	world = await new World().open();
	return world;
}

describe("ZAI governor account evidence", () => {
	test("coding endpoint and a plan quota do not establish proactive included allowance", async () => {
		const w = await setup();
		const fetches = w.fetches;
		const evaluation = await w.evaluate();
		expect(evaluation.accounts).toHaveLength(1);
		expect(evaluation.accounts[0]).toMatchObject({ eligibility: "unknown", allowance: "unknown", state: "unknown" });
		expect(w.fetches).toBe(fetches);
	});

	test("an unsupported model cannot become a verified included route", async () => {
		const w = await setup();
		const fetches = w.fetches;
		const evaluation = await w.evaluate("unsupported-model");
		expect(evaluation.accounts).toHaveLength(1);
		expect(evaluation.accounts[0]).toMatchObject({ eligibility: "unknown", allowance: "unknown" });
		expect(w.fetches).toBe(fetches);
	});

	test("an explicitly selected account is paced by its fresh quota without classifying it as free", async () => {
		const w = await setup();
		const row = w.auth.credentials.list("zai")[0];
		if (!row) throw new Error("missing stored account");
		const selected = await w.auth.keys.getWithCredential("zai", "test", {
			requestCredential: { credentialId: row.id },
			recordAffinity: false,
		});
		expect(selected?.credentialId).toBe(row.id);
		expect(selected?.apiKey).toBe(KEY);
		const before = w.fetches;
		const pacing = (w.auth.governor as CredentialGovernor).pacing(
			"zai",
			row.credential,
			w.report,
			{ modelId: TARGET.modelId },
			BASE_URL,
		);
		expect(pacing.measured).toBe(true);
		expect(pacing.pacedUntil).toBeGreaterThan(Date.now());
		expect((await w.evaluate()).accounts[0]?.allowance).toBe("unknown");
		expect(w.fetches).toBe(before);
	});

	test("stale or absent quota cannot establish measured pacing", async () => {
		const w = await setup();
		const row = w.auth.credentials.list("zai")[0];
		if (!row) throw new Error("missing stored account");
		const stale = structuredClone(w.report);
		stale.limits[0]!.observedAt = Date.now() - 24 * 60 * 60_000;
		const missing = { ...w.report, limits: [] };
		expect(
			(w.auth.governor as CredentialGovernor).pacing(
				"zai",
				row.credential,
				stale,
				{ modelId: TARGET.modelId },
				BASE_URL,
			).measured,
		).toBe(false);
		expect(
			(w.auth.governor as CredentialGovernor).pacing(
				"zai",
				row.credential,
				missing,
				{ modelId: TARGET.modelId },
				BASE_URL,
			).measured,
		).toBe(false);
	});
});
