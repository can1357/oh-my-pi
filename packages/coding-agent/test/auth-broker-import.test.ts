import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import { type AuthBrokerServerHandle, startAuthBroker } from "@oh-my-pi/pi-ai/auth-broker";
import { runAuthBrokerCommand } from "@oh-my-pi/pi-coding-agent/cli/auth-broker-cli";
import { getAgentDbPath, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";

const ORIGINAL_STDOUT_WRITE = process.stdout.write.bind(process.stdout);

function silenceStdout(): () => string {
	let captured = "";
	process.stdout.write = ((chunk: string | Uint8Array): boolean => {
		captured += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
		return true;
	}) as typeof process.stdout.write;
	return () => captured;
}

describe("auth-broker import (CLIProxyAPI)", () => {
	let agentDir = "";
	let cliproxyDir = "";
	let originalAgentDir: string | undefined;
	const savedEnv: Record<string, string | undefined> = {};

	beforeEach(async () => {
		originalAgentDir = process.env.OMP_AGENT_DIR;
		savedEnv.OMP_AUTH_BROKER_URL = process.env.OMP_AUTH_BROKER_URL;
		savedEnv.OMP_AUTH_BROKER_TOKEN = process.env.OMP_AUTH_BROKER_TOKEN;
		delete process.env.OMP_AUTH_BROKER_URL;
		delete process.env.OMP_AUTH_BROKER_TOKEN;
		agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-import-agent-"));
		cliproxyDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-import-cliproxy-"));
		setAgentDir(agentDir);
	});

	afterEach(async () => {
		process.stdout.write = ORIGINAL_STDOUT_WRITE;
		if (originalAgentDir === undefined) delete process.env.OMP_AGENT_DIR;
		else process.env.OMP_AGENT_DIR = originalAgentDir;
		await removeWithRetries(agentDir);
		await removeWithRetries(cliproxyDir);
		for (const key of ["OMP_AUTH_BROKER_URL", "OMP_AUTH_BROKER_TOKEN"] as const) {
			if (savedEnv[key] === undefined) delete process.env[key];
			else process.env[key] = savedEnv[key];
		}
	});

	async function writeCliProxyJson(name: string, body: Record<string, unknown>): Promise<string> {
		const file = path.join(cliproxyDir, name);
		await Bun.write(file, JSON.stringify(body));
		return file;
	}

	test("imports a directory of CLIProxyAPI JSONs and maps types to omp providers", async () => {
		await writeCliProxyJson("claude-sample.json", {
			type: "claude",
			access_token: "claude-access-1",
			refresh_token: "claude-refresh-1",
			expired: "2099-12-31T23:59:59Z",
			email: "claude-user@example.com",
			id_token: "ignored",
			last_refresh: "2025-01-01T00:00:00Z",
		});
		await writeCliProxyJson("codex-sample.json", {
			type: "codex",
			access_token: "codex-access-1",
			refresh_token: "codex-refresh-1",
			expired: "2099-12-31T23:59:59Z",
			email: "codex-user@example.com",
			account_id: "acct-codex-1",
			websockets: true,
		});
		await writeCliProxyJson("disabled.json", {
			type: "claude",
			access_token: "x",
			refresh_token: "y",
			expired: "2099-12-31T23:59:59Z",
			email: "disabled@example.com",
			disabled: true,
		});

		const restore = silenceStdout();
		await runAuthBrokerCommand({
			action: "import",
			flags: { source: cliproxyDir, json: false },
		});
		restore();

		const store = await SqliteAuthCredentialStore.open(getAgentDbPath());
		try {
			const claude = store.listAuthCredentials("anthropic");
			expect(claude).toHaveLength(1);
			expect(claude[0].credential.type).toBe("oauth");
			if (claude[0].credential.type === "oauth") {
				expect(claude[0].credential.access).toBe("claude-access-1");
				expect(claude[0].credential.refresh).toBe("claude-refresh-1");
				expect(claude[0].credential.email).toBe("claude-user@example.com");
				expect(claude[0].credential.expires).toBe(Date.parse("2099-12-31T23:59:59Z"));
			}

			const codex = store.listAuthCredentials("openai-codex");
			expect(codex).toHaveLength(1);
			if (codex[0].credential.type === "oauth") {
				expect(codex[0].credential.access).toBe("codex-access-1");
				expect(codex[0].credential.accountId).toBe("acct-codex-1");
			}

			// disabled.json was skipped by default
			const disabled = store
				.listAuthCredentials("anthropic")
				.find(r => r.credential.type === "oauth" && r.credential.email === "disabled@example.com");
			expect(disabled).toBeUndefined();
		} finally {
			store.close();
		}
	});

	test("dry-run does not write any credentials", async () => {
		await writeCliProxyJson("claude.json", {
			type: "claude",
			access_token: "a",
			refresh_token: "b",
			expired: "2099-12-31T23:59:59Z",
			email: "dryrun@example.com",
		});

		const restore = silenceStdout();
		await runAuthBrokerCommand({
			action: "import",
			flags: { source: cliproxyDir, dryRun: true, json: true },
		});
		const output = restore();

		const store = await SqliteAuthCredentialStore.open(getAgentDbPath());
		try {
			expect(store.listAuthCredentials()).toHaveLength(0);
		} finally {
			store.close();
		}
		const parsed = JSON.parse(output.trim().split("\n").pop() ?? "{}");
		expect(parsed.dryRun).toBe(true);
		expect(parsed.plan).toHaveLength(1);
		expect(parsed.plan[0].provider).toBe("anthropic");
	});

	test("--provider override forces a provider id when the JSON type is unrecognized", async () => {
		await writeCliProxyJson("weird.json", {
			type: "some-future-type",
			access_token: "z",
			refresh_token: "w",
			expired: "2099-12-31T23:59:59Z",
			email: "future@example.com",
		});

		const restore = silenceStdout();
		await runAuthBrokerCommand({
			action: "import",
			flags: { source: cliproxyDir, provider: "anthropic" },
		});
		restore();

		const store = await SqliteAuthCredentialStore.open(getAgentDbPath());
		try {
			const rows = store.listAuthCredentials("anthropic");
			expect(rows).toHaveLength(1);
		} finally {
			store.close();
		}
	});

	test("--include-disabled imports rows marked disabled", async () => {
		await writeCliProxyJson("disabled.json", {
			type: "claude",
			access_token: "d",
			refresh_token: "e",
			expired: "2099-12-31T23:59:59Z",
			email: "disabled-import@example.com",
			disabled: true,
		});

		const restore = silenceStdout();
		await runAuthBrokerCommand({
			action: "import",
			flags: { source: cliproxyDir, includeDisabled: true },
		});
		restore();

		const store = await SqliteAuthCredentialStore.open(getAgentDbPath());
		try {
			expect(store.listAuthCredentials("anthropic")).toHaveLength(1);
		} finally {
			store.close();
		}
	});
});

describe("auth-broker import (broker-routed)", () => {
	let agentDir = "";
	let brokerAgentDir = "";
	let cliproxyDir = "";
	let brokerStore: SqliteAuthCredentialStore | undefined;
	let brokerStorage: AuthStorage | undefined;
	let handle: AuthBrokerServerHandle | undefined;
	const token = "broker-import-bearer";
	const savedEnv: Record<string, string | undefined> = {};

	beforeEach(async () => {
		savedEnv.OMP_AUTH_BROKER_URL = process.env.OMP_AUTH_BROKER_URL;
		savedEnv.OMP_AUTH_BROKER_TOKEN = process.env.OMP_AUTH_BROKER_TOKEN;
		agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-import-client-"));
		brokerAgentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-import-broker-"));
		cliproxyDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-import-cliproxy-broker-"));
		setAgentDir(agentDir);

		brokerStore = await SqliteAuthCredentialStore.open(path.join(brokerAgentDir, "agent.db"));
		brokerStorage = new AuthStorage(brokerStore);
		await brokerStorage.reload();
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
		await removeWithRetries(cliproxyDir);
		for (const key of ["OMP_AUTH_BROKER_URL", "OMP_AUTH_BROKER_TOKEN"] as const) {
			if (savedEnv[key] === undefined) delete process.env[key];
			else process.env[key] = savedEnv[key];
		}
	});

	test("uploads CLIProxyAPI JSONs to the broker when configured, not the local store", async () => {
		await Bun.write(
			path.join(cliproxyDir, "claude-foo@bar.json"),
			JSON.stringify({
				type: "claude",
				access_token: "broker-access",
				refresh_token: "broker-refresh-real",
				expired: "2099-12-31T23:59:59Z",
				email: "foo@bar.com",
			}),
		);

		const ORIGINAL_STDOUT = process.stdout.write.bind(process.stdout);
		let captured = "";
		process.stdout.write = ((chunk: string | Uint8Array): boolean => {
			captured += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
			return true;
		}) as typeof process.stdout.write;
		try {
			await runAuthBrokerCommand({
				action: "import",
				flags: { source: cliproxyDir },
			});
		} finally {
			process.stdout.write = ORIGINAL_STDOUT;
		}

		// The broker received it (and persisted the real refresh token).
		const persisted = brokerStore!.getOAuth("anthropic");
		expect(persisted?.access).toBe("broker-access");
		expect(persisted?.refresh).toBe("broker-refresh-real");
		expect(persisted?.email).toBe("foo@bar.com");

		// The local client SQLite store was NOT touched.
		const localStore = await SqliteAuthCredentialStore.open(getAgentDbPath());
		try {
			expect(localStore.listAuthCredentials()).toHaveLength(0);
		} finally {
			localStore.close();
		}

		expect(captured).toContain("uploaded");
		expect(captured).toContain(handle!.url);
	});

	test("dry-run does not upload even when broker is configured", async () => {
		await Bun.write(
			path.join(cliproxyDir, "claude-dry.json"),
			JSON.stringify({
				type: "claude",
				access_token: "a",
				refresh_token: "b",
				expired: "2099-12-31T23:59:59Z",
				email: "dry@example.com",
			}),
		);

		const ORIGINAL_STDOUT = process.stdout.write.bind(process.stdout);
		process.stdout.write = (() => true) as typeof process.stdout.write;
		try {
			await runAuthBrokerCommand({
				action: "import",
				flags: { source: cliproxyDir, dryRun: true },
			});
		} finally {
			process.stdout.write = ORIGINAL_STDOUT;
		}

		expect(brokerStore!.listAuthCredentials()).toHaveLength(0);
	});
});

describe("auth-broker import (--from-antigravity)", () => {
	let agentDir = "";
	let fakeHome = "";
	let originalAgentDir: string | undefined;
	const savedEnv: Record<string, string | undefined> = {};
	let homedirSpy: { mockRestore(): void } | undefined;

	beforeEach(async () => {
		originalAgentDir = process.env.OMP_AGENT_DIR;
		savedEnv.OMP_AUTH_BROKER_URL = process.env.OMP_AUTH_BROKER_URL;
		savedEnv.OMP_AUTH_BROKER_TOKEN = process.env.OMP_AUTH_BROKER_TOKEN;
		delete process.env.OMP_AUTH_BROKER_URL;
		delete process.env.OMP_AUTH_BROKER_TOKEN;
		process.exitCode = 0;

		agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-ag-import-agent-"));
		fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), "omp-ag-fake-home-"));
		setAgentDir(agentDir);
		homedirSpy = vi.spyOn(os, "homedir").mockReturnValue(fakeHome);
	});

	afterEach(async () => {
		process.stdout.write = ORIGINAL_STDOUT_WRITE;
		process.exitCode = 0;
		homedirSpy?.mockRestore();
		if (originalAgentDir === undefined) delete process.env.OMP_AGENT_DIR;
		else process.env.OMP_AGENT_DIR = originalAgentDir;
		await removeWithRetries(agentDir);
		await removeWithRetries(fakeHome);
		for (const key of ["OMP_AUTH_BROKER_URL", "OMP_AUTH_BROKER_TOKEN"] as const) {
			if (savedEnv[key] === undefined) delete process.env[key];
			else process.env[key] = savedEnv[key];
		}
	});

	async function writeLocalAntigravityTokens(options?: { email?: string; tokenFilename?: string }) {
		const filename = options?.tokenFilename ?? "antigravity-oauth-token";
		const agyDir = path.join(fakeHome, ".gemini", "antigravity-cli");
		await fs.mkdir(agyDir, { recursive: true });
		await Bun.write(
			path.join(agyDir, filename),
			JSON.stringify({
				token: {
					access_token: "ag-access-token",
					refresh_token: "ag-refresh-token",
					expiry: "2099-12-31T23:59:59Z",
				},
				auth_method: "consumer",
			}),
		);

		if (options?.email) {
			const header = Buffer.from(JSON.stringify({ alg: "RS256" })).toString("base64url");
			const payload = Buffer.from(JSON.stringify({ email: options.email })).toString("base64url");
			await Bun.write(
				path.join(fakeHome, ".gemini", "oauth_creds.json"),
				JSON.stringify({
					access_token: "ag-access-token",
					refresh_token: "ag-refresh-token",
					id_token: `${header}.${payload}.signature`,
				}),
			);
		}
	}

	test("rejects conflicting --provider override", async () => {
		await writeLocalAntigravityTokens();
		const restore = silenceStdout();
		try {
			await runAuthBrokerCommand({
				action: "import",
				flags: { fromAntigravity: true, provider: "anthropic" },
			});
		} finally {
			restore();
		}
		expect(process.exitCode).toBe(1);
	});

	test("dry-run outputs plan without writing to store", async () => {
		await writeLocalAntigravityTokens({ email: "dryrun@example.com" });
		const restore = silenceStdout();
		let captured = "";
		try {
			captured = restore();
			const restoreCapture = silenceStdout();
			await runAuthBrokerCommand({
				action: "import",
				flags: { fromAntigravity: true, dryRun: true },
			});
			captured = restoreCapture();
		} finally {
			restore();
		}

		expect(captured).toContain("Dry run");
		expect(captured).toContain("google-antigravity");
		expect(captured).toContain("dryrun@example.com");

		const store = await SqliteAuthCredentialStore.open(getAgentDbPath());
		try {
			expect(store.listAuthCredentials("google-antigravity")).toHaveLength(0);
		} finally {
			store.close();
		}
	});

	test("local import clears only the imported account's blocks, preserving sibling blocks", async () => {
		const importedEmail = "imported@example.com";
		const siblingEmail = "sibling@example.com";
		await writeLocalAntigravityTokens({ email: importedEmail });

		const store = await SqliteAuthCredentialStore.open(getAgentDbPath());
		let importedRowId: number;
		let siblingRowId: number;
		try {
			// Pre-populate sibling credential
			const siblingRows = store.upsertAuthCredentialForProvider("google-antigravity", {
				type: "oauth",
				access: "sibling-access",
				refresh: "sibling-refresh",
				expires: Date.now() + 3600_000,
				email: siblingEmail,
				projectId: "aicode-consumers",
			});
			siblingRowId = siblingRows.find(r => r.credential.type === "oauth" && r.credential.email === siblingEmail)!.id;

			// Pre-populate existing imported credential
			const existingRows = store.upsertAuthCredentialForProvider("google-antigravity", {
				type: "oauth",
				access: "old-access",
				refresh: "old-refresh",
				expires: Date.now() + 3600_000,
				email: importedEmail,
				projectId: "aicode-consumers",
			});
			importedRowId = existingRows.find(
				r => r.credential.type === "oauth" && r.credential.email === importedEmail,
			)!.id;

			// Block both credentials
			store.upsertCredentialBlock({
				credentialId: siblingRowId,
				providerKey: "google-antigravity:oauth",
				blockScope: "",
				blockedUntilMs: Date.now() + 600_000,
			});
			store.upsertCredentialBlock({
				credentialId: importedRowId,
				providerKey: "google-antigravity:oauth",
				blockScope: "",
				blockedUntilMs: Date.now() + 600_000,
			});

			expect(store.listCredentialBlocks([siblingRowId])).toHaveLength(1);
			expect(store.listCredentialBlocks([importedRowId])).toHaveLength(1);
		} finally {
			store.close();
		}

		const restore = silenceStdout();
		try {
			await runAuthBrokerCommand({
				action: "import",
				flags: { fromAntigravity: true },
			});
		} finally {
			restore();
		}

		const verifyStore = await SqliteAuthCredentialStore.open(getAgentDbPath());
		try {
			const activeRows = verifyStore.listAuthCredentials("google-antigravity");
			const importedRow = activeRows.find(
				r => r.credential.type === "oauth" && r.credential.email === importedEmail,
			);
			expect(importedRow).toBeDefined();
			expect(importedRow!.credential.type === "oauth" && importedRow!.credential.access).toBe("ag-access-token");

			// The imported account's blocks are deleted
			expect(verifyStore.listCredentialBlocks([importedRow!.id])).toHaveLength(0);
			// The sibling account's blocks remain untouched!
			expect(verifyStore.listCredentialBlocks([siblingRowId])).toHaveLength(1);
		} finally {
			verifyStore.close();
		}
	});

	test("reports error and sets exitCode when token file is missing", async () => {
		const restore = silenceStdout();
		try {
			await runAuthBrokerCommand({
				action: "import",
				flags: { fromAntigravity: true },
			});
		} finally {
			restore();
		}
		expect(process.exitCode).toBe(1);
	});

	test("uploads to remote broker and clears only the uploaded account's blocks", async () => {
		const importedEmail = "remote-agy@example.com";
		const siblingEmail = "remote-sibling@example.com";
		await writeLocalAntigravityTokens({ email: importedEmail });

		const brokerAgentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-ag-broker-"));
		const brokerStore = await SqliteAuthCredentialStore.open(path.join(brokerAgentDir, "agent.db"));
		const brokerStorage = new AuthStorage(brokerStore);
		await brokerStorage.reload();

		// Pre-populate broker with imported account AND sibling account, both blocked
		const importedRows = brokerStore.upsertAuthCredentialForProvider("google-antigravity", {
			type: "oauth",
			access: "old-broker-access",
			refresh: "old-broker-refresh",
			expires: Date.now() + 3600_000,
			email: importedEmail,
			projectId: "aicode-consumers",
		});
		const importedRowId = importedRows.find(
			r => r.credential.type === "oauth" && r.credential.email === importedEmail,
		)!.id;

		const siblingRows = brokerStore.upsertAuthCredentialForProvider("google-antigravity", {
			type: "oauth",
			access: "sibling-broker-access",
			refresh: "sibling-broker-refresh",
			expires: Date.now() + 3600_000,
			email: siblingEmail,
			projectId: "aicode-consumers",
		});
		const siblingRowId = siblingRows.find(
			r => r.credential.type === "oauth" && r.credential.email === siblingEmail,
		)!.id;

		brokerStore.upsertCredentialBlock({
			credentialId: importedRowId,
			providerKey: "google-antigravity:oauth",
			blockScope: "",
			blockedUntilMs: Date.now() + 600_000,
		});
		brokerStore.upsertCredentialBlock({
			credentialId: siblingRowId,
			providerKey: "google-antigravity:oauth",
			blockScope: "",
			blockedUntilMs: Date.now() + 600_000,
		});
		expect(brokerStore.listCredentialBlocks([importedRowId])).toHaveLength(1);
		expect(brokerStore.listCredentialBlocks([siblingRowId])).toHaveLength(1);

		const token = "ag-broker-token";
		const handle = startAuthBroker({
			storage: brokerStorage,
			bind: "127.0.0.1:0",
			bearerTokens: [token],
			disableRefresher: true,
		});
		process.env.OMP_AUTH_BROKER_URL = handle.url;
		process.env.OMP_AUTH_BROKER_TOKEN = token;

		const restore = silenceStdout();
		try {
			await runAuthBrokerCommand({
				action: "import",
				flags: { fromAntigravity: true },
			});

			// Assert remote broker block state before teardown:
			// Imported credential block was deleted
			expect(brokerStore.listCredentialBlocks([importedRowId])).toHaveLength(0);
			// Sibling credential block remains intact
			expect(brokerStore.listCredentialBlocks([siblingRowId])).toHaveLength(1);
		} finally {
			restore();
			await handle.close();
			brokerStorage.close();
			brokerStore.close();
			await removeWithRetries(brokerAgentDir);
		}

		// Local store was NOT written
		const localStore = await SqliteAuthCredentialStore.open(getAgentDbPath());
		try {
			expect(localStore.listAuthCredentials()).toHaveLength(0);
		} finally {
			localStore.close();
		}
	});
});
