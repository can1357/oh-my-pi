import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import type { UsageProvider, UsageReport } from "@oh-my-pi/pi-ai/usage";
import type { UsageAdmissionRequest, UsageRouteBinding } from "@oh-my-pi/pi-ai/usage-governor/types";
import { fingerprintBearer } from "../src/auth/bearer-fingerprint";
import { fakeStrategy, installFetchTripwire } from "./fixtures/usage-governor/harness";

installFetchTripwire();
const PROVIDER = "anthropic";
const TARGET = { selector: "anthropic/test-model", provider: PROVIDER, modelId: "test-model" };
const SESSION = "binding-session";
const oauth = (accountId: string, access = `token-${accountId}`) => ({
	type: "oauth" as const,
	access,
	refresh: `refresh-${accountId}`,
	expires: Date.now() + 3_600_000,
	accountId,
	email: `${accountId}@example.test`,
});

class World {
	dir = "";
	store!: SqliteAuthCredentialStore;
	auth!: AuthStorage;
	allowance: "included" | "unknown" | "paid" = "included";
	observedAt = Date.now();
	usedFraction = 0.1;
	exhausted = false;
	fetches = 0;
	adapter: UsageProvider = {
		id: PROVIDER,
		fetchUsage: async ({ credential, provider }): Promise<UsageReport> => {
			this.fetches++;
			const now = Date.now();
			return {
				provider,
				fetchedAt: now,
				limits: [
					{
						id: "primary",
						label: "Included",
						scope: { provider, accountId: credential.accountId },
						window: { id: "5h", label: "5 Hour", durationMs: 60_000, resetsAt: now + 30_000 },
						amount: { unit: "percent", usedFraction: this.usedFraction },
						status: this.exhausted ? "exhausted" : undefined,
						observedAt: this.observedAt,
					},
				],
			};
		},
		governorAllowance: () =>
			this.allowance === "included" ? ["primary"] : this.allowance === "paid" ? [] : undefined,
	};
	async open() {
		this.dir = await fs.mkdtemp(path.join(os.tmpdir(), "governor-binding-"));
		this.store = await SqliteAuthCredentialStore.open(path.join(this.dir, "auth.db"));
		this.auth = new AuthStorage(this.store, {
			usageProviderResolver: id => (id === PROVIDER || id === "openai" ? this.adapter : undefined),
			rankingStrategyResolver: id => (id === PROVIDER || id === "openai" ? fakeStrategy : undefined),
			governor: {
				dbPath: path.join(this.dir, "ledger.db"),
				config: { enabled: true, lead: 0.25, interactiveReserve: "hold" },
			},
		});
		this.scope(1);
		return this;
	}
	scope(revision: number) {
		this.auth.governor.setRoutingScope({ id: "scope", revision, roles: [{ role: "task", targets: [TARGET] }] });
	}
	async seed() {
		await this.auth.credentials.set(PROVIDER, [oauth("a"), oauth("b")]);
		await this.auth.usage.reports({ provider: PROVIDER });
	}
	async bind() {
		const accounts = this.auth.oauth.accounts(PROVIDER);
		const a = accounts.find(account => account.accountId === "a");
		const b = accounts.find(account => account.accountId === "b");
		if (!a || !b) throw new Error("missing accounts");
		const selected = await this.auth.keys.getWithCredential(PROVIDER, SESSION, {
			requestCredential: { credentialId: a.credentialId },
			recordAffinity: false,
		});
		if (!selected?.apiKey || selected.credentialId !== a.credentialId) throw new Error("failed to resolve account a");
		const binding: UsageRouteBinding = {
			scopeId: "scope",
			revision: 1,
			owner: { kind: "role", role: "task" },
			target: TARGET,
			credentialId: a.credentialId,
			intent: "proactive",
			bearerFingerprint: fingerprintBearer(selected.apiKey),
		};
		const request: UsageAdmissionRequest = {
			provider: PROVIDER,
			modelId: TARGET.modelId,
			credentialId: a.credentialId,
			bearerFingerprint: binding.bearerFingerprint,
			context: { source: "subagent", sessionId: SESSION },
		};
		const evaluation = await this.auth.governor.evaluateRoutes({
			scopeId: "scope",
			revision: 1,
			role: "task",
			sessionId: SESSION,
			targets: [TARGET],
		});
		expect(evaluation.accounts.find(row => row.credentialId === a.credentialId)).toMatchObject({
			eligibility: "eligible",
			allowance: "included",
			state: "open",
		});
		expect(this.auth.governor.validateRoute!(binding, request)).toBe(true);
		return { a, b, binding, request };
	}
	async refresh() {
		await this.auth.usage.invalidate(PROVIDER);
		await this.auth.usage.reports({ provider: PROVIDER });
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
	await world.seed();
	return world;
}

describe("request-local route binding", () => {
	test("only the bound credential, bearer and route validate", async () => {
		const w = await setup();
		const { a, b, binding, request } = await w.bind();
		const before = w.fetches;
		expect(
			w.auth.governor.validateRoute!(binding, { ...request, bearerFingerprint: fingerprintBearer("different") }),
		).toBe(false);
		expect(w.auth.governor.validateRoute!(binding, { ...request, credentialId: b.credentialId })).toBe(false);
		expect(w.auth.governor.validateRoute!(binding, { ...request, modelId: "other" })).toBe(false);
		expect(w.auth.governor.validateRoute!(binding, { ...request, context: undefined })).toBe(false);
		expect(w.auth.governor.validateRoute!(binding, request)).toBe(true);
		expect(a.credentialId).not.toBe(b.credentialId);
		expect(w.fetches).toBe(before);
	});
	test("a newly resolved bearer invalidates the previously bound bearer for the same account", async () => {
		const w = await setup();
		const { a, binding, request } = await w.bind();
		await w.auth.credentials.set(PROVIDER, [oauth("a", "rotated-token"), oauth("b")]);
		const current = await w.auth.keys.getWithCredential(PROVIDER, "rotated-session", {
			requestCredential: { credentialId: a.credentialId },
			recordAffinity: false,
		});
		expect(current?.apiKey).toBe("rotated-token");
		expect(current?.credentialId).toBe(a.credentialId);
		expect(w.auth.governor.validateRoute!(binding, request)).toBe(false);
	});
	test("restrictions, pins, overrides, blocks and scope revisions invalidate an allowed binding", async () => {
		const w = await setup();
		const { a, b, binding, request } = await w.bind();
		const validate = () => w.auth.governor.validateRoute!(binding, request);
		const lease = w.auth.sessions.restrict(PROVIDER, SESSION, ["account:b"]);
		expect(validate()).toBe(false);
		w.auth.sessions.unrestrict(PROVIDER, SESSION, lease);
		expect(validate()).toBe(true);
		expect(w.auth.sessions.pin(PROVIDER, SESSION, b.credentialId)).toBe(true);
		expect(validate()).toBe(false);
		expect(w.auth.sessions.pin(PROVIDER, SESSION, a.credentialId)).toBe(true);
		expect(validate()).toBe(true);
		w.auth.keys.setRuntime(PROVIDER, "override");
		expect(validate()).toBe(false);
		w.auth.keys.removeRuntime(PROVIDER);
		w.auth.keys.setConfig(PROVIDER, "override");
		expect(validate()).toBe(false);
		w.auth.keys.removeConfig(PROVIDER);
		expect(validate()).toBe(true);
		w.scope(2);
		expect(validate()).toBe(false);
		const currentBinding = { ...binding, revision: 2 };
		expect(w.auth.governor.validateRoute!(currentBinding, request)).toBe(true);
		await w.auth.limits.markReached(PROVIDER, SESSION, { credentialId: a.credentialId });
		expect(w.auth.governor.validateRoute!(currentBinding, request)).toBe(false);
	});
	test("a higher-priority environment key invalidates a stored non-login API-key route", async () => {
		const w = await setup();
		const previous = process.env.OPENAI_API_KEY;
		delete process.env.OPENAI_API_KEY;
		try {
			const target = { selector: "openai/test-model", provider: "openai", modelId: "test-model" };
			w.auth.governor.setRoutingScope({
				id: "env-scope",
				revision: 1,
				roles: [{ role: "task", targets: [target] }],
			});
			await w.auth.credentials.set("openai", [{ type: "api_key", key: "stored-key" }]);
			await w.auth.usage.reports({ provider: "openai" });
			const selected = await w.auth.keys.getWithCredential("openai", "env-session");
			if (!selected?.credentialId) throw new Error("missing stored key");
			const binding: UsageRouteBinding = {
				scopeId: "env-scope",
				revision: 1,
				owner: { kind: "role", role: "task" },
				target,
				credentialId: selected.credentialId,
				intent: "proactive",
				bearerFingerprint: fingerprintBearer(selected.apiKey),
			};
			const request: UsageAdmissionRequest = {
				provider: "openai",
				modelId: target.modelId,
				credentialId: selected.credentialId,
				bearerFingerprint: binding.bearerFingerprint,
				context: { source: "subagent", sessionId: "env-session" },
			};
			expect(w.auth.governor.validateRoute!(binding, request)).toBe(true);
			process.env.OPENAI_API_KEY = "env-key";
			expect(w.auth.governor.validateRoute!(binding, request)).toBe(false);
		} finally {
			if (previous === undefined) delete process.env.OPENAI_API_KEY;
			else process.env.OPENAI_API_KEY = previous;
		}
	});
	test("unknown, paid and stale allowance evidence cannot validate", async () => {
		const w = await setup();
		const { binding, request } = await w.bind();
		for (const allowance of ["unknown", "paid"] as const) {
			w.allowance = allowance;
			expect(w.auth.governor.validateRoute!(binding, request)).toBe(false);
		}
		w.allowance = "included";
		w.observedAt = Date.now() - 24 * 60 * 60_000;
		await w.refresh();
		expect(w.auth.governor.validateRoute!(binding, request)).toBe(false);
	});
	test("a bound route that becomes paced or closed with fresh evidence stays valid", async () => {
		const w = await setup();
		const { a, binding, request } = await w.bind();

		// Initially open:
		expect(w.auth.governor.validateRoute!(binding, request)).toBe(true);

		// Paced (usedFraction past the line):
		w.usedFraction = 0.8;
		await w.refresh();
		const pacedEval = await w.auth.governor.evaluateRoutes({
			scopeId: "scope",
			revision: 1,
			role: "task",
			sessionId: SESSION,
			targets: [TARGET],
		});
		expect(pacedEval.accounts.find(row => row.credentialId === a.credentialId)).toMatchObject({
			eligibility: "eligible",
			allowance: "included",
			state: "paced",
		});
		expect(w.auth.governor.validateRoute!(binding, request)).toBe(true);

		// Closed (reserve-held):
		w.usedFraction = 0.95;
		await w.refresh();
		const reserveHeldEval = await w.auth.governor.evaluateRoutes({
			scopeId: "scope",
			revision: 1,
			role: "task",
			sessionId: SESSION,
			targets: [TARGET],
		});
		expect(reserveHeldEval.accounts.find(row => row.credentialId === a.credentialId)).toMatchObject({
			eligibility: "eligible",
			allowance: "included",
			state: "closed",
		});
		expect(w.auth.governor.validateRoute!(binding, request)).toBe(true);

		// Closed (exhausted / allowance spent):
		w.usedFraction = 1.0;
		w.exhausted = true;
		await w.refresh();
		const spentEval = await w.auth.governor.evaluateRoutes({
			scopeId: "scope",
			revision: 1,
			role: "task",
			sessionId: SESSION,
			targets: [TARGET],
		});
		expect(spentEval.accounts.find(row => row.credentialId === a.credentialId)).toMatchObject({
			eligibility: "eligible",
			allowance: "spent",
			state: "closed",
		});
		expect(w.auth.governor.validateRoute!(binding, request)).toBe(true);
	});
	test("a paced or closed bound route becomes invalid if evidence goes stale or unknown", async () => {
		const w = await setup();
		const { binding, request } = await w.bind();

		// Set to paced
		w.usedFraction = 0.8;
		await w.refresh();
		expect(w.auth.governor.validateRoute!(binding, request)).toBe(true);

		// Stale evidence
		w.observedAt = Date.now() - 24 * 60 * 60_000;
		await w.refresh();
		expect(w.auth.governor.validateRoute!(binding, request)).toBe(false);

		// Reset observedAt, set to spent/closed
		w.observedAt = Date.now();
		w.usedFraction = 1.0;
		w.exhausted = true;
		await w.refresh();
		expect(w.auth.governor.validateRoute!(binding, request)).toBe(true);

		// Stale evidence when spent
		w.observedAt = Date.now() - 24 * 60 * 60_000;
		await w.refresh();
		expect(w.auth.governor.validateRoute!(binding, request)).toBe(false);

		// Unknown allowance when paced
		w.observedAt = Date.now();
		w.usedFraction = 0.8;
		w.exhausted = false;
		w.allowance = "unknown";
		await w.refresh();
		expect(w.auth.governor.validateRoute!(binding, request)).toBe(false);

		// Paid allowance when paced
		w.allowance = "paid";
		await w.refresh();
		expect(w.auth.governor.validateRoute!(binding, request)).toBe(false);
	});
	test("a paced or closed bound route rejects unauthorized switches", async () => {
		const w = await setup();
		const { b, binding, request } = await w.bind();

		w.usedFraction = 0.8;
		await w.refresh();
		expect(w.auth.governor.validateRoute!(binding, request)).toBe(true);

		// Switching credentialId
		expect(w.auth.governor.validateRoute!(binding, { ...request, credentialId: b.credentialId })).toBe(false);
		// Switching bearerFingerprint
		expect(
			w.auth.governor.validateRoute!(binding, { ...request, bearerFingerprint: fingerprintBearer("different") }),
		).toBe(false);
		// Switching provider
		expect(w.auth.governor.validateRoute!(binding, { ...request, provider: "openai" })).toBe(false);
		// Switching modelId
		expect(w.auth.governor.validateRoute!(binding, { ...request, modelId: "different-model" })).toBe(false);
		// Switching baseUrl
		expect(w.auth.governor.validateRoute!(binding, { ...request, baseUrl: "https://other.example.com" })).toBe(false);
		// Missing or different sessionId
		expect(w.auth.governor.validateRoute!(binding, { ...request, context: undefined })).toBe(false);
		expect(
			w.auth.governor.validateRoute!(binding, {
				...request,
				context: { source: "subagent", sessionId: "other-session" },
			}),
		).toBe(false);
	});
	test("a constrained resolution neither overrides an explicit pin nor records a new affinity", async () => {
		const w = await setup();
		const { a, b } = await w.bind();
		expect(w.auth.sessions.pin(PROVIDER, SESSION, a.credentialId)).toBe(true);
		const denied = await w.auth.keys.getWithCredential(PROVIDER, SESSION, {
			requestCredential: { credentialId: b.credentialId },
			recordAffinity: false,
		});
		expect(denied?.credentialId).not.toBe(b.credentialId);
		expect(w.auth.sessions.selected(PROVIDER, SESSION)).toEqual({ credentialId: a.credentialId, explicit: true });
		expect((await w.auth.keys.getWithCredential(PROVIDER, SESSION))?.credentialId).toBe(a.credentialId);
		const selected = await w.auth.keys.getWithCredential(PROVIDER, "unpinned", {
			requestCredential: { credentialId: b.credentialId },
			recordAffinity: false,
		});
		expect(selected?.credentialId).toBe(b.credentialId);
		expect(w.auth.sessions.selected(PROVIDER, "unpinned")).toBeUndefined();
		expect(w.auth.sessions.pin(PROVIDER, "unpinned", a.credentialId)).toBe(true);
		expect((await w.auth.keys.getWithCredential(PROVIDER, "unpinned"))?.credentialId).toBe(a.credentialId);
	});
});

describe("governor bearer-only attribution", () => {
	test("unique resolved OAuth bearer is attributed, but not across providers", async () => {
		const w = await setup();
		await w.bind();
		const bearerFingerprint = fingerprintBearer("token-a");
		expect(
			await w.auth.governor.admit({ provider: "openai", bearerFingerprint, modelId: TARGET.modelId }),
		).toBeUndefined();
		const grant = await w.auth.governor.admit({ provider: PROVIDER, bearerFingerprint, modelId: TARGET.modelId });
		expect(grant?.id).toBeDefined();
		if (grant) w.auth.governor.settle(grant.id, "not-sent");
	});
	test("ambiguous and deleted OAuth bearer mappings do not attribute", async () => {
		const w = await setup();
		await w.auth.credentials.set(PROVIDER, [oauth("a", "shared"), oauth("b", "shared")]);
		await w.refresh();
		for (const account of w.auth.oauth.accounts(PROVIDER))
			await w.auth.keys.getWithCredential(PROVIDER, `resolve-${account.accountId}`, {
				requestCredential: { credentialId: account.credentialId },
				recordAffinity: false,
			});
		const request = { provider: PROVIDER, bearerFingerprint: fingerprintBearer("shared"), modelId: TARGET.modelId };
		expect(await w.auth.governor.admit(request)).toBeUndefined();
		await w.auth.credentials.set(PROVIDER, []);
		expect(await w.auth.governor.admit(request)).toBeUndefined();
	});
	test("a stored API key is never attributed by bearer alone", async () => {
		const w = await setup();
		await w.auth.credentials.set(PROVIDER, [{ type: "api_key", key: "api-key-only", source: "login" }]);
		await w.refresh();
		const selected = await w.auth.keys.getWithCredential(PROVIDER, "api-key-session");
		expect(selected?.apiKey).toBe("api-key-only");
		const request = {
			provider: PROVIDER,
			bearerFingerprint: fingerprintBearer("api-key-only"),
			modelId: TARGET.modelId,
		};
		expect(await w.auth.governor.admit(request)).toBeUndefined();
		const control = await w.auth.governor.admit({ ...request, credentialId: selected?.credentialId });
		expect(control?.id).toBeDefined();
		if (control) w.auth.governor.settle(control.id, "not-sent");
	});
});
