import { Database } from "bun:sqlite";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import type { UsageProvider, UsageReport } from "@oh-my-pi/pi-ai/usage";
import { AUTH_BLOCK_SCOPE } from "../src/auth/blocks";
import { fakeStrategy, installFetchTripwire } from "./fixtures/usage-governor/harness";

const strayFetches = installFetchTripwire();
const PROVIDER = "anthropic";
const SESSION = "blocked-opportunity-session";
const target = (account: string) => ({
	selector: `${PROVIDER}/${account}`,
	provider: PROVIDER,
	modelId: "test-model",
	accountIds: [account],
});
const A = target("a");
const B = target("b");
const C = target("c");
const oauth = (accountId: string) => ({
	type: "oauth" as const,
	access: `token-${accountId}`,
	refresh: `refresh-${accountId}`,
	expires: Date.now() + 3_600_000,
	accountId,
	email: `${accountId}@example.test`,
});

class World {
	dir = "";
	store!: SqliteAuthCredentialStore;
	auth!: AuthStorage;
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
						amount: { unit: "percent", usedFraction: 0.1 },
						observedAt: now,
					},
				],
			};
		},
		governorAllowance: () => ["primary"],
	};

	async open() {
		this.dir = await fs.mkdtemp(path.join(os.tmpdir(), "governor-blocked-opportunities-"));
		this.store = await SqliteAuthCredentialStore.open(path.join(this.dir, "auth.db"));
		this.auth = new AuthStorage(this.store, {
			usageProviderResolver: id => (id === PROVIDER ? this.adapter : undefined),
			rankingStrategyResolver: id => (id === PROVIDER ? fakeStrategy : undefined),
			governor: {
				dbPath: path.join(this.dir, "ledger.db"),
				config: { enabled: true, lead: 0.25, interactiveReserve: "hold", roleProtection: "prefer-alternatives" },
			},
		});
		await this.auth.credentials.set(PROVIDER, [oauth("a"), oauth("b"), oauth("c")]);
		await this.auth.usage.reports({ provider: PROVIDER });
		this.auth.governor.setRoutingScope({
			id: "scope",
			revision: 1,
			roles: [
				{ role: "task", targets: [A, C] },
				{ role: "smol", targets: [A, B] },
			],
		});
		return this;
	}

	id(accountId: string): number {
		const account = this.auth.oauth.accounts(PROVIDER).find(item => item.accountId === accountId);
		if (!account) throw new Error(`missing account ${accountId}`);
		return account.credentialId;
	}

	evaluate(role: "task" | "smol") {
		return this.auth.governor.evaluateRoutes({
			scopeId: "scope",
			revision: 1,
			role,
			sessionId: SESSION,
			targets: role === "task" ? [A, C] : [A, B],
		});
	}

	blocks() {
		const db = new Database(path.join(this.dir, "auth.db"), { readonly: true });
		try {
			return db
				.query(
					"SELECT credential_id, provider_key, block_scope, blocked_until_ms, updated_at FROM auth_credential_blocks ORDER BY credential_id, provider_key, block_scope",
				)
				.all();
		} finally {
			db.close();
		}
	}
}

let world: World | undefined;
afterEach(async () => {
	if (!world) return;
	world.auth?.close();
	await fs.rm(world.dir, { recursive: true, force: true });
	world = undefined;
});

async function setup() {
	world = new World();
	return world.open();
}

async function check(w: World, bEligibility: "eligible" | "ineligible" | "unknown", protectedFor: string[]) {
	const beforeBlocks = w.blocks();
	const beforeFetches = w.fetches;
	const task = await w.evaluate("task");
	const smol = await w.evaluate("smol");
	expect(task.accounts.find(row => row.selector === A.selector && row.credentialId === w.id("a"))).toMatchObject({
		eligibility: "eligible",
		allowance: "included",
		state: "open",
		protectedFor,
	});
	expect(smol.accounts.find(row => row.selector === B.selector && row.credentialId === w.id("b"))).toMatchObject({
		eligibility: bEligibility,
	});
	expect(w.blocks()).toEqual(beforeBlocks);
	expect(w.fetches).toBe(beforeFetches);
	expect(strayFetches()).toHaveLength(0);
}

describe("blocked route opportunities", () => {
	test("healthy independent account is an opportunity for the constrained role", async () => {
		const w = await setup();
		await check(w, "eligible", []);
	});

	test("a persisted authentication block from another process is not an independent opportunity", async () => {
		const w = await setup();
		const script = `import { Database } from 'bun:sqlite';
			const db = new Database(process.argv[1]);
			db.query('INSERT INTO auth_credential_blocks (credential_id, provider_key, block_scope, blocked_until_ms, updated_at) VALUES (?, ?, ?, ?, ?)').run(Number(process.argv[2]), process.argv[3], process.argv[4], Date.now() + 600000, Date.now());
			db.close();`;
		const child = Bun.spawn(
			[
				process.execPath,
				"-e",
				script,
				path.join(w.dir, "auth.db"),
				String(w.id("b")),
				`${PROVIDER}:oauth`,
				AUTH_BLOCK_SCOPE,
			],
			{ stdout: "pipe", stderr: "pipe" },
		);
		const exit = await child.exited;
		const stderr = await new Response(child.stderr).text();
		if (exit !== 0) throw new Error(`block writer exited ${exit}: ${stderr}`);
		expect(w.blocks()).toHaveLength(1);
		await check(w, "ineligible", ["smol"]);
	});

	test("an unreadable block snapshot is unknown and never counted", async () => {
		const w = await setup();
		const original = w.store.getCredentialBlockScopesSnapshot.bind(w.store);
		const spy = spyOn(w.store, "getCredentialBlockScopesSnapshot").mockImplementation((id, providerKey) => {
			if (id === w.id("b")) throw new Error("snapshot unavailable");
			return original(id, providerKey);
		});
		try {
			await check(w, "unknown", ["smol"]);
		} finally {
			spy.mockRestore();
		}
	});

	test("a store without snapshot support cannot establish route capacity", async () => {
		const w = await setup();
		Object.defineProperty(w.store, "getCredentialBlockScopesSnapshot", { value: undefined, configurable: true });
		try {
			const before = w.blocks();
			const fetches = w.fetches;
			const result = await w.evaluate("task");
			expect(result.accounts.every(row => row.eligibility === "unknown")).toBe(true);
			expect(w.blocks()).toEqual(before);
			expect(w.fetches).toBe(fetches);
			expect(strayFetches()).toHaveLength(0);
		} finally {
			Reflect.deleteProperty(w.store, "getCredentialBlockScopesSnapshot");
		}
	});

	test("evaluation preserves expired rows while an ordinary store read sweeps them", async () => {
		const w = await setup();
		const db = new Database(path.join(w.dir, "auth.db"));
		try {
			db.query(
				"INSERT INTO auth_credential_blocks (credential_id, provider_key, block_scope, blocked_until_ms, updated_at) VALUES (?, ?, ?, ?, ?)",
			).run(w.id("b"), `${PROVIDER}:oauth`, AUTH_BLOCK_SCOPE, Date.now() - 10_000, Date.now());
		} finally {
			db.close();
		}
		expect(w.blocks()).toHaveLength(1);
		await check(w, "eligible", []);
		const reader = await SqliteAuthCredentialStore.open(path.join(w.dir, "auth.db"));
		try {
			reader.getCredentialBlockScopes(w.id("b"), `${PROVIDER}:oauth`);
			expect(w.blocks()).toHaveLength(0);
		} finally {
			reader.close();
		}
	});
});
