import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import { type AuthBrokerServerHandle, startAuthBroker } from "@oh-my-pi/pi-ai/auth-broker";
import { runAuthBrokerCommand } from "@oh-my-pi/pi-coding-agent/cli/auth-broker-cli";
import { getAgentDbPath, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";

const TEAM_ORG = "org-team-1111";

async function runMigrateCapturingStdout(): Promise<string> {
	const originalWrite = process.stdout.write.bind(process.stdout);
	let captured = "";
	process.stdout.write = ((chunk: string | Uint8Array): boolean => {
		captured += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
		return true;
	}) as typeof process.stdout.write;
	try {
		await runAuthBrokerCommand({
			action: "migrate",
			flags: { fromLocal: true, includeOauth: true },
		});
	} finally {
		process.stdout.write = originalWrite;
	}
	return captured;
}

describe("auth-broker migrate", () => {
	let agentDir = "";
	let brokerAgentDir = "";
	let brokerStore: SqliteAuthCredentialStore | undefined;
	let brokerStorage: AuthStorage | undefined;
	let handle: AuthBrokerServerHandle | undefined;
	const token = "broker-migrate-bearer";
	const savedEnv: Record<string, string | undefined> = {};

	beforeEach(async () => {
		savedEnv.OMP_AUTH_BROKER_URL = process.env.OMP_AUTH_BROKER_URL;
		savedEnv.OMP_AUTH_BROKER_TOKEN = process.env.OMP_AUTH_BROKER_TOKEN;
		agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-migrate-client-"));
		brokerAgentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-migrate-broker-"));
		setAgentDir(agentDir);

		brokerStore = await SqliteAuthCredentialStore.open(path.join(brokerAgentDir, "agent.db"));
		brokerStorage = new AuthStorage(brokerStore);
		await brokerStorage.credentials.reload();
		handle = startAuthBroker({
			storage: brokerStorage,
			bind: "127.0.0.1:0",
			bearerTokens: [token],
			disableRefresher: true,
		});
		process.env.OMP_AUTH_BROKER_URL = handle.url;
		process.env.OMP_AUTH_BROKER_TOKEN = token;
	});

	afterEach(async () => {
		await handle?.close();
		brokerStorage?.close();
		brokerStore?.close();
		await removeWithRetries(agentDir);
		await removeWithRetries(brokerAgentDir);
		for (const key of ["OMP_AUTH_BROKER_URL", "OMP_AUTH_BROKER_TOKEN"] as const) {
			if (savedEnv[key] === undefined) delete process.env[key];
			else process.env[key] = savedEnv[key];
		}
	});

	test("rerun skips an already-migrated org-only row instead of re-uploading a stale refresh token", async () => {
		// Local row where login recovered neither email nor account: the org id
		// is the only identity the broker snapshot can echo back.
		const localStore = await SqliteAuthCredentialStore.open(getAgentDbPath());
		try {
			await localStore.upsertAuthCredential("anthropic", {
				type: "oauth",
				access: "access-local",
				refresh: "refresh-local-stale",
				expires: Date.now() + 3_600_000,
				orgId: TEAM_ORG,
				orgName: "Team",
			});
		} finally {
			localStore.close();
		}

		const firstRun = await runMigrateCapturingStdout();
		expect(firstRun).toContain("uploaded");
		const uploaded = brokerStore!.getOAuth("anthropic");
		expect(uploaded?.refresh).toBe("refresh-local-stale");
		expect(uploaded?.orgId).toBe(TEAM_ORG);

		// The broker rotates the token after migration — its copy is now newer
		// than the local one.
		await brokerStore!.upsertAuthCredential("anthropic", {
			type: "oauth",
			access: "access-rotated",
			refresh: "refresh-rotated",
			expires: Date.now() + 7_200_000,
			orgId: TEAM_ORG,
			orgName: "Team",
		});
		await brokerStorage!.credentials.reload();

		// Rerun: the org-only row must be recognized as already migrated, not
		// re-uploaded (which would clobber the broker's newer refresh token).
		const secondRun = await runMigrateCapturingStdout();
		expect(secondRun).toContain("already on broker");
		expect(secondRun).toContain("Nothing to migrate");
		const persisted = brokerStore!.getOAuth("anthropic");
		expect(persisted?.refresh).toBe("refresh-rotated");
		expect(brokerStore!.listAuthCredentials("anthropic")).toHaveLength(1);
	});

	test.each([
		{
			provider: "google-antigravity",
			shared: "project",
			identity: { projectId: "aicode-consumers" },
			local: ["alice@gmail.com", "bob@gmail.com"],
		},
		{
			provider: "openai-codex",
			shared: "workspace",
			identity: { accountId: "ws-team-2222", orgId: "ws-team-2222" },
			local: ["alice@example.com"],
		},
	])(
		"uploads $provider accounts that only share a $shared id with an account on the broker",
		async ({ provider, identity, local }) => {
			const oauth = (email: string, refresh: string) => ({
				type: "oauth" as const,
				access: `access-${email}`,
				refresh,
				expires: Date.now() + 3_600_000,
				email,
				...identity,
			});
			await brokerStore!.upsertAuthCredential(provider, oauth("carol@example.com", "refresh-broker-carol"));
			await brokerStorage!.credentials.reload();
			const localStore = await SqliteAuthCredentialStore.open(getAgentDbPath());
			try {
				for (const email of local) {
					await localStore.upsertAuthCredential(provider, oauth(email, `refresh-local-${email}`));
				}
			} finally {
				localStore.close();
			}

			await runMigrateCapturingStdout();
			expect(brokerStore!.listAuthCredentials(provider).map(row => row.credential)).toMatchObject([
				{ email: "carol@example.com", refresh: "refresh-broker-carol" },
				...local.map(email => ({ email, refresh: `refresh-local-${email}` })),
			]);
		},
	);

	test.each([
		{
			// Stored before its email was recovered, so keyed by account: uploading the
			// local row would claim it and overwrite the broker's token.
			held: "an email-less row keyed by account",
			provider: "anthropic",
			onBroker: { accountId: "acct-3333", orgId: TEAM_ORG, orgName: "Team" },
			local: { email: "alice@example.com", accountId: "acct-3333", orgId: TEAM_ORG, orgName: "Team" },
		},
		{
			// Only the local row carries an account id, so the store keys the two apart:
			// uploading would add a second row for the same account.
			held: "a row keyed by email while the local one is keyed by account",
			provider: "google-antigravity",
			onBroker: { email: "alice@gmail.com", projectId: "aicode-consumers" },
			local: { email: "alice@gmail.com", accountId: "acct-4444", projectId: "aicode-consumers" },
		},
	])("keeps the broker's newer token for an account it holds as $held", async ({ provider, onBroker, local }) => {
		await brokerStore!.upsertAuthCredential(provider, {
			type: "oauth",
			...onBroker,
			access: "access-broker",
			refresh: "refresh-broker-newer",
			expires: Date.now() + 7_200_000,
		});
		await brokerStorage!.credentials.reload();
		const localStore = await SqliteAuthCredentialStore.open(getAgentDbPath());
		try {
			await localStore.upsertAuthCredential(provider, {
				type: "oauth",
				...local,
				access: "access-local",
				refresh: "refresh-local-stale",
				expires: Date.now() + 3_600_000,
			});
		} finally {
			localStore.close();
		}

		const output = await runMigrateCapturingStdout();
		expect(output).toContain("already on broker");
		expect(brokerStore!.listAuthCredentials(provider)).toHaveLength(1);
		expect(brokerStore!.getOAuth(provider)?.refresh).toBe("refresh-broker-newer");
	});
});
