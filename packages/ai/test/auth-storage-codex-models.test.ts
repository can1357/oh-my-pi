import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModelManager } from "@pk-nerdsaver-ai/pi-catalog/model-manager";
import { removeWithRetries } from "../../utils/src/temp";
import { AuthStorage, SqliteAuthCredentialStore } from "../src/auth-storage";

const provider = "openai-codex";
const astra = "gpt-6-astra";
const common = "gpt-5.5";

describe("Codex account-specific model capabilities", () => {
	let directory: string;
	let store: SqliteAuthCredentialStore;
	let auth: AuthStorage;
	let server: Bun.Server<undefined>;
	const catalogs = new Map<string, string[]>();
	const requests: string[] = [];
	let failedAccount: string | undefined;
	let npmAvailable: boolean;
	const versions: string[] = [];

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "codex-account-models-"));
		store = await SqliteAuthCredentialStore.open(join(directory, "agent.db"));
		catalogs.clear();
		requests.length = 0;
		versions.length = 0;
		failedAccount = undefined;
		npmAvailable = true;
		catalogs.set("first", [common]);
		catalogs.set("second", [common, astra]);
		server = Bun.serve({
			port: 0,
			fetch(request) {
				const url = new URL(request.url);
				if (url.pathname === "/version") {
					return npmAvailable ? Response.json({ version: "0.153.4" }) : new Response(null, { status: 503 });
				}
				const account = request.headers.get("chatgpt-account-id") ?? "";
				requests.push(account);
				versions.push(url.searchParams.get("client_version") ?? "");
				if (request.headers.get("authorization") !== `Bearer access-${account}`)
					return new Response(null, { status: 401 });
				if (account === failedAccount) return new Response(null, { status: 503 });
				return Response.json({
					models: (catalogs.get(account) ?? []).map(slug => ({ slug, supported_in_api: true })),
				});
			},
		});
		auth = new AuthStorage(store, {
			usageProviderResolver: () => undefined,
			rankingStrategyResolver: () => undefined,
			codexModelDiscovery: {
				cacheDbPath: join(directory, "models.db"),
				fetch: (input, init) => {
					const url = new URL(input instanceof Request ? input.url : input.toString());
					return fetch(
						new URL(
							url.hostname === "registry.npmjs.org" ? "/version" : `${url.pathname}${url.search}`,
							server.url,
						),
						init,
					);
				},
			},
		});
		await auth.set(
			provider,
			["first", "second"].map(accountId => ({
				type: "oauth" as const,
				access: `access-${accountId}`,
				refresh: `refresh-${accountId}`,
				accountId,
				expires: Date.now() + 3_600_000,
			})),
		);
	});

	afterEach(async () => {
		auth.close();
		await server.stop(true);
		await removeWithRetries(directory);
	});

	it("discovers both accounts independently and reuses their separate caches", async () => {
		const options = auth.getCodexModelManagerOptions();
		const first = await createModelManager(options[0]).refresh();
		const second = await createModelManager(options[1]).refresh();
		expect(first.models.map(model => model.id)).toEqual([common]);
		expect(second.models.map(model => model.id)).toContain(astra);
		expect(options[0].cacheProviderId).not.toBe(options[1].cacheProviderId);
		await Promise.all(options.map(option => createModelManager(option).refresh()));
		expect(requests).toEqual(["first", "second"]);
	});

	it("always routes Astra to its supporting account, including after credential rotation", async () => {
		for (let index = 0; index < 6; index++) {
			const access = await auth.getOAuthAccess(provider, `session-${index}`, { modelId: astra });
			expect(access?.accountId).toBe("second");
			expect(access?.accessToken).toBe("access-second");
		}
		await auth.rotateSessionCredential(provider, "session-0", { modelId: astra });
		expect((await auth.getOAuthAccess(provider, "session-0", { modelId: astra }))?.accountId).toBe("second");
		expect(requests.toSorted()).toEqual(["first", "second"]);
	});

	it("replaces an incompatible sticky account when switching models", async () => {
		let selectedSession: string | undefined;
		for (let index = 0; index < 20; index++) {
			const session = `sticky-${index}`;
			if ((await auth.getOAuthAccess(provider, session, { modelId: common }))?.accountId === "first") {
				selectedSession = session;
				break;
			}
		}
		expect(selectedSession).toBeDefined();
		expect((await auth.getOAuthAccess(provider, selectedSession, { modelId: astra }))?.accountId).toBe("second");
	});

	it("does not use a removed account's cached entitlement", async () => {
		await auth.getOAuthAccess(provider, "remove", { modelId: astra });
		const second = auth.listOAuthAccounts(provider).find(account => account.accountId === "second");
		if (!second) throw new Error("Missing second test account");
		store.deleteAuthCredential(second.credentialId, "test removal");
		await auth.reload();
		await expect(auth.getOAuthAccess(provider, "remove", { modelId: astra })).rejects.toThrow(
			"No available OpenAI Codex account advertises model",
		);
	});

	it("fails closed when only the supporting account's discovery fails", async () => {
		failedAccount = "second";
		await expect(auth.getOAuthAccess(provider, "failure", { modelId: astra })).rejects.toThrow(
			"No available OpenAI Codex account advertises model",
		);
		expect((await auth.getOAuthAccess(provider, "common", { modelId: common }))?.accountId).toBe("first");
		expect(auth.listOAuthAccounts(provider)).toHaveLength(2);
	});

	it("retains modern model discovery when the version registry is unavailable", async () => {
		npmAvailable = false;
		expect((await auth.getOAuthAccess(provider, "fallback-version", { modelId: astra }))?.accountId).toBe("second");
		expect(versions).toEqual(["0.153.4", "0.153.4"]);
	});

	it("refreshes account capabilities and rejects a revoked model", async () => {
		await auth.getOAuthAccess(provider, "revoked", { modelId: astra });
		catalogs.set("second", [common]);
		await Promise.all(auth.getCodexModelManagerOptions().map(option => createModelManager(option).refresh("online")));
		await expect(auth.getOAuthAccess(provider, "revoked", { modelId: astra })).rejects.toThrow(
			"No available OpenAI Codex account advertises model",
		);
	});

	it("single-flights capability discovery across concurrent model requests", async () => {
		const accesses = await Promise.all(
			Array.from({ length: 8 }, (_, index) =>
				auth.getOAuthAccess(provider, `concurrent-${index}`, { modelId: astra }),
			),
		);
		expect(accesses.every(access => access?.accountId === "second")).toBe(true);
		expect(requests.toSorted()).toEqual(["first", "second"]);
	});

	it("does not authorize requests from a stale catalog after refresh failure", async () => {
		await auth.getOAuthAccess(provider, "stale", { modelId: astra });
		failedAccount = "second";
		const refreshed = await createModelManager(auth.getCodexModelManagerOptions()[1]).refresh("online");
		expect(refreshed.stale).toBe(true);
		expect(refreshed.models.some(model => model.id === astra)).toBe(true);
		await expect(auth.getOAuthAccess(provider, "stale", { modelId: astra })).rejects.toThrow(
			"No available OpenAI Codex account advertises model",
		);
	});

	it("invalidates capabilities when a stored credential changes account identity", async () => {
		await auth.getOAuthAccess(provider, "identity", { modelId: astra });
		const second = auth.listOAuthAccounts(provider).find(account => account.accountId === "second");
		if (!second) throw new Error("Missing second test account");
		store.updateAuthCredential(second.credentialId, {
			type: "oauth",
			accountId: "replacement",
			access: "access-replacement",
			refresh: "refresh-replacement",
			expires: Date.now() + 3_600_000,
		});
		await auth.reload();
		await expect(auth.getOAuthAccess(provider, "identity", { modelId: astra })).rejects.toThrow(
			"No available OpenAI Codex account advertises model",
		);
		expect(requests).toContain("replacement");
	});
});
