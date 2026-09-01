import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, type OAuthCredential, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import { removeWithRetries } from "../../utils/src/temp";

const PROVIDER = "openai-codex";

function oauth(args: { suffix: string; accountId?: string; email?: string; orgId?: string }): OAuthCredential {
	return {
		type: "oauth",
		access: `access-${args.suffix}`,
		refresh: `refresh-${args.suffix}`,
		expires: Date.now() + 3_600_000,
		accountId: args.accountId,
		email: args.email,
		orgId: args.orgId,
	};
}

describe("AuthStorage credential incarnation and workspace fan-out", () => {
	let tempDir = "";
	let store: SqliteAuthCredentialStore | null = null;
	let storage: AuthStorage | null = null;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-incarnation-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		storage = new AuthStorage(store, {
			rankingStrategyResolver: () => undefined,
			usageProviderResolver: () => undefined,
		});
	});

	afterEach(async () => {
		store?.close();
		store = null;
		storage = null;
		if (tempDir) await removeWithRetries(tempDir);
	});

	it("increments incarnation and purges blocks on a confirmed identity change", async () => {
		if (!storage || !store) throw new Error("setup failed");
		await storage.set(PROVIDER, [oauth({ suffix: "a", accountId: "acc-old", email: "old@example.com" })]);
		const id = storage.listStoredCredentials(PROVIDER)[0]?.id;
		if (id === undefined) throw new Error("missing credential");
		expect(storage.getCredentialIncarnation(id)).toBe(1);
		await storage.markUsageLimitReached(PROVIDER, undefined, { credentialId: id });
		expect(storage.listCredentialBlocks([id]).length).toBeGreaterThan(0);

		store.updateAuthCredential(id, oauth({ suffix: "a2", accountId: "acc-new", email: "new@example.com" }));
		await storage.reload();
		expect(storage.getCredentialIncarnation(id)).toBe(2);
		expect(storage.listCredentialBlocks([id])).toEqual([]);
	});

	it("does not treat missing or malformed identity as a switch (negative)", async () => {
		if (!storage || !store) throw new Error("setup failed");
		await storage.set(PROVIDER, [oauth({ suffix: "a", accountId: "acc-old", email: "old@example.com" })]);
		const id = storage.listStoredCredentials(PROVIDER)[0]?.id;
		if (id === undefined) throw new Error("missing credential");
		store.updateAuthCredential(id, oauth({ suffix: "a", accountId: "acc-old", email: "old@example.com" }));
		await storage.reload();
		expect(storage.getCredentialIncarnation(id)).toBe(1);

		store.updateAuthCredential(id, {
			type: "oauth",
			access: "access-stripped",
			refresh: "refresh-stripped",
			expires: Date.now() + 3_600_000,
		});
		await storage.reload();
		expect(storage.getCredentialIncarnation(id)).toBe(1);
	});

	it("does not bump incarnation when identity is only enriched with new fields", async () => {
		if (!storage || !store) throw new Error("setup failed");
		await storage.set(PROVIDER, [oauth({ suffix: "a", accountId: "acc-same", email: "same@example.com" })]);
		const id = storage.listStoredCredentials(PROVIDER)[0]?.id;
		if (id === undefined) throw new Error("missing credential");
		store.updateAuthCredential(
			id,
			oauth({ suffix: "a", accountId: "acc-same", email: "same@example.com", orgId: "org-new" }),
		);
		await storage.reload();
		expect(storage.getCredentialIncarnation(id)).toBe(1);
	});

	it("does not fan out a plain 402 payment_required without deactivated_workspace (negative)", async () => {
		if (!storage) throw new Error("setup failed");
		await storage.set(PROVIDER, [
			oauth({ suffix: "team-a", accountId: "chatgpt-shared", email: "shared@example.com", orgId: "ws-team-a" }),
			oauth({
				suffix: "team-a-sibling",
				accountId: "chatgpt-shared",
				email: "shared-alias@example.com",
				orgId: "ws-team-a-seat",
			}),
		]);
		const rows = storage.listStoredCredentials(PROVIDER);
		const byAccess = new Map(
			rows.map(row => {
				const cred = row.credential;
				if (cred.type !== "oauth") throw new Error("expected oauth");
				return [cred.access, row.id] as const;
			}),
		);
		const idA = byAccess.get("access-team-a");
		const idSibling = byAccess.get("access-team-a-sibling");
		if (idA === undefined || idSibling === undefined) throw new Error("expected two credentials");
		await storage.rotateSessionCredential(PROVIDER, undefined, {
			credentialId: idA,
			error: Object.assign(new Error("payment_required"), { status: 402 }),
		});
		const blocked = new Set(storage.listCredentialBlocks([idA, idSibling]).map(block => block.credentialId));
		expect(blocked.has(idA)).toBe(true);
		expect(blocked.has(idSibling)).toBe(false);
	});

	it("does not fan deactivated_workspace across distinct organization-qualified identities", async () => {
		if (!storage) throw new Error("setup failed");
		await storage.set(PROVIDER, [
			oauth({ suffix: "team-a", accountId: "chatgpt-shared", email: "shared@example.com", orgId: "ws-team-a" }),
			oauth({
				suffix: "team-a-sibling",
				accountId: "chatgpt-shared",
				email: "shared-alias@example.com",
				orgId: "ws-team-a-seat",
			}),
			oauth({ suffix: "team-b", accountId: "chatgpt-other", email: "other@example.com", orgId: "ws-team-b" }),
		]);
		const rows = storage.listStoredCredentials(PROVIDER);
		expect(rows.length).toBe(3);
		const byAccess = new Map(
			rows.map(row => {
				const cred = row.credential;
				if (cred.type !== "oauth") throw new Error("expected oauth");
				return [cred.access, row.id] as const;
			}),
		);
		const idA = byAccess.get("access-team-a");
		const idSibling = byAccess.get("access-team-a-sibling");
		const idOther = byAccess.get("access-team-b");
		if (idA === undefined || idSibling === undefined || idOther === undefined) {
			throw new Error("expected three distinct credentials");
		}

		await storage.rotateSessionCredential(PROVIDER, undefined, {
			credentialId: idA,
			error: Object.assign(new Error("deactivated_workspace"), { status: 402 }),
		});

		const blocked = new Set(storage.listCredentialBlocks([idA, idSibling, idOther]).map(block => block.credentialId));
		expect(blocked.has(idA)).toBe(true);
		// Shared accountId alone must not fan out across different org workspaces.
		expect(blocked.has(idSibling)).toBe(false);
		expect(blocked.has(idOther)).toBe(false);

		const key = await storage.getApiKey(PROVIDER, "fresh-session");
		expect(key === "access-team-a-sibling" || key === "access-team-b").toBe(true);
	});
});
