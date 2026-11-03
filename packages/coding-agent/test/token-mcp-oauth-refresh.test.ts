import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import * as path from "node:path";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import { refreshStoredManagedMcpOAuthCredential } from "@oh-my-pi/pi-coding-agent/mcp/oauth-credentials";
import type { MCPStoredOAuthCredential } from "@oh-my-pi/pi-coding-agent/mcp/oauth-flow";
import { TempDir } from "@oh-my-pi/pi-utils";
import { allowMCPInTests } from "./helpers/mcp-policy";

// The in-process refresh helpers below run against a stub; the test runner exports PI_NO_MCP=1.
allowMCPInTests();

/** Capture the `resource` form field of the single refresh_token grant a helper call makes. */
async function captureRefreshResource(
	recoverServerUrlFromCredentialId: boolean,
): Promise<{ resources: (string | null)[]; access: string | undefined }> {
	// Credential id embeds a DIFFERENT origin than the token endpoint, so a
	// recovered fallback resource survives same-origin filtering and is observable.
	const provider = "mcp_oauth:profile:default:https://remote.example.test/mcp";
	const resources: (string | null)[] = [];
	const tokenServer = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const body = new URLSearchParams(await request.text());
			resources.push(body.get("resource"));
			return Response.json({ access_token: "access-1", refresh_token: "refresh-1", expires_in: 3600 });
		},
	});
	try {
		const storage = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")));
		await storage.credentials.reload();
		const credential: MCPStoredOAuthCredential = {
			type: "oauth",
			access: "access-0",
			refresh: "refresh-0",
			expires: Date.now() - 60_000,
			tokenUrl: `http://127.0.0.1:${tokenServer.port}/token`,
		};
		await storage.credentials.set(provider, credential);
		const result = await refreshStoredManagedMcpOAuthCredential(storage, provider, {
			forceRefresh: true,
			recoverServerUrlFromCredentialId,
		});
		storage.close();
		return { resources, access: result.credential?.access };
	} finally {
		tokenServer.stop(true);
	}
}

test("standalone refresh recovers the fallback resource from the credential id", async () => {
	const { resources, access } = await captureRefreshResource(true);
	expect(access).toBe("access-1");
	expect(resources).toEqual(["https://remote.example.test/mcp"]);
});

test("refresh without server-url recovery advertises no resource", async () => {
	const { resources, access } = await captureRefreshResource(false);
	expect(access).toBe("access-1");
	expect(resources).toEqual([null]);
});

const cliEntry = path.join(import.meta.dir, "..", "src", "cli.ts");

test("token refreshes and persists a rotating local MCP OAuth grant", async () => {
	using tempDir = TempDir.createSync("@omp-token-mcp-oauth-");
	const provider = "mcp_oauth:profile:default:https://mcp.example.test/MCP";
	const dbPath = tempDir.join("agent.db");
	const refreshTokens: string[] = [];
	const tokenServer = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const body = new URLSearchParams(await request.text());
			refreshTokens.push(body.get("refresh_token") ?? "");
			return Response.json({
				access_token: "access-1",
				refresh_token: "refresh-1",
				expires_in: 3600,
			});
		},
	});

	try {
		const store = await SqliteAuthCredentialStore.open(dbPath);
		const authStorage = new AuthStorage(store);
		await authStorage.credentials.reload();
		const credential: MCPStoredOAuthCredential = {
			type: "oauth",
			access: "access-0",
			refresh: "refresh-0",
			expires: Date.now() - 60_000,
			tokenUrl: `http://127.0.0.1:${tokenServer.port}/token`,
		};
		await authStorage.credentials.set(provider, credential);
		authStorage.close();

		const proc = Bun.spawn([process.execPath, cliEntry, "token", provider, "--force-refresh"], {
			cwd: path.resolve(import.meta.dir, "../../.."),
			env: {
				...process.env,
				NO_COLOR: "1",
				OMP_AUTH_BROKER_TOKEN: undefined,
				OMP_AUTH_BROKER_URL: undefined,
				PI_CODING_AGENT_DIR: tempDir.path(),
				// The test runner exports PI_NO_MCP=1, which refuses MCP credential refreshes.
				PI_NO_MCP: "",
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		const [exitCode, stdout, stderr] = await Promise.all([
			proc.exited,
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);

		expect(exitCode, stderr).toBe(0);
		expect(stdout).toBe("access-1\n");
		expect(refreshTokens).toEqual(["refresh-0"]);

		const persistedStore = await SqliteAuthCredentialStore.open(dbPath);
		const persistedStorage = new AuthStorage(persistedStore);
		await persistedStorage.credentials.reload();
		const persisted = persistedStorage.credentials.get(provider);
		expect(persisted?.type).toBe("oauth");
		if (persisted?.type === "oauth") {
			expect(persisted.access).toBe("access-1");
			expect(persisted.refresh).toBe("refresh-1");
		}
		persistedStorage.close();

		const db = new Database(dbPath, { readonly: true });
		const blockCount = db.query<{ count: number }, []>("SELECT count(*) AS count FROM auth_credential_blocks").get();
		db.close();
		expect(blockCount?.count).toBe(0);
	} finally {
		tokenServer.stop(true);
	}
}, 30_000);

// PR #17795 review, round 7: `omp --no-mcp token` refreshed an MCP credential,
// contacting the server's token endpoint. MCP off refuses every refresh (an
// expired token, `--force-refresh`), however the id is spelled (round 9:
// `MCP_OAUTH:` skipped the managed-id checks); a stored, unexpired token is
// printed as stored, since reading it contacts nothing.
const storedId = "mcp_oauth:profile:default:https://mcp.example.test/mcp";
for (const { name, args, noMcp, stored, lead, typed } of [
	{ name: "PI_NO_MCP=1", args: ["--force-refresh"], noMcp: "1", stored: "expired" },
	{ name: "--no-mcp", args: ["--force-refresh"], noMcp: "", stored: "expired", lead: ["--no-mcp"] },
	{ name: "PI_NO_MCP=1, an expired token", args: [], noMcp: "1", stored: "expired" },
	{
		name: "PI_NO_MCP=1, MCP_OAUTH: spelling",
		args: ["--force-refresh"],
		noMcp: "1",
		stored: "expired",
		typed: storedId.toUpperCase(),
	},
	{
		name: "--no-mcp, Mcp_oauth: spelling, --account 1",
		args: ["--account", "1", "--force-refresh"],
		noMcp: "",
		stored: "expired",
		lead: ["--no-mcp"],
		typed: `Mcp_oauth${storedId.slice("mcp_oauth".length)}`,
	},
	{ name: "PI_NO_MCP=1, a valid stored token", args: [], noMcp: "1", stored: "valid" },
	{ name: "--no-mcp, a valid stored token", args: [], noMcp: "", stored: "valid", lead: ["--no-mcp"] },
	{ name: "PI_NO_MCP=1, --account 1", args: ["--account", "1"], noMcp: "1", stored: "valid" },
	{
		name: "PI_NO_MCP=1, MCP_OAUTH: spelling, a valid stored token",
		args: [],
		noMcp: "1",
		stored: "valid",
		typed: storedId.toUpperCase(),
	},
] as Array<{
	name: string;
	args: string[];
	noMcp: string;
	stored: "expired" | "valid";
	lead?: string[];
	typed?: string;
}>) {
	test(`token ${stored === "valid" ? "prints the stored" : "refreshes no"} MCP credential under ${name}`, async () => {
		using tempDir = TempDir.createSync("@omp-token-mcp-oauth-off-");
		const provider = storedId;
		let requests = 0;
		const tokenServer = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch() {
				requests += 1;
				return Response.json({ access_token: "access-1", refresh_token: "refresh-1", expires_in: 3600 });
			},
		});
		try {
			const authStorage = new AuthStorage(await SqliteAuthCredentialStore.open(tempDir.join("agent.db")));
			await authStorage.credentials.reload();
			const credential: MCPStoredOAuthCredential = {
				type: "oauth",
				access: "access-0",
				refresh: "refresh-0",
				expires: stored === "valid" ? Date.now() + 3_600_000 : Date.now() - 60_000,
				tokenUrl: `http://127.0.0.1:${tokenServer.port}/token`,
			};
			await authStorage.credentials.set(provider, credential);
			authStorage.close();

			const proc = Bun.spawn([process.execPath, cliEntry, ...(lead ?? []), "token", typed ?? provider, ...args], {
				cwd: path.resolve(import.meta.dir, "../../.."),
				env: {
					...process.env,
					NO_COLOR: "1",
					OMP_AUTH_BROKER_TOKEN: undefined,
					OMP_AUTH_BROKER_URL: undefined,
					PI_CODING_AGENT_DIR: tempDir.path(),
					PI_NO_MCP: noMcp,
				},
				stdout: "pipe",
				stderr: "pipe",
			});
			const [exitCode, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);

			expect(requests).toBe(0);
			if (stored === "valid") {
				expect(stdout).toBe("access-0\n");
				expect(exitCode).toBe(0);
			} else {
				expect(stdout).not.toContain("access-");
				expect(exitCode).not.toBe(0);
			}
		} finally {
			tokenServer.stop(true);
		}
	}, 30_000);
}

// An id typed in another case (`MCP_OAUTH:`) is looked up lowercased; it gets
// the same profile check (PR #17795 review, round 9).
for (const spelling of ["as stored", "MCP_OAUTH:"] as const) {
	test(`token refuses a managed MCP id scoped to another profile, typed ${spelling}`, async () => {
		using tempDir = TempDir.createSync("@omp-token-mcp-oauth-xprofile-");
		// A non-expired row that the fall-through resolver WOULD hand back verbatim.
		const foreignProvider = "mcp_oauth:profile:work:https://mcp.example.test/mcp";
		const dbPath = tempDir.join("agent.db");
		const store = await SqliteAuthCredentialStore.open(dbPath);
		const authStorage = new AuthStorage(store);
		await authStorage.credentials.reload();
		await authStorage.credentials.set(foreignProvider, {
			type: "oauth",
			access: "work-access",
			refresh: "work-refresh",
			expires: Date.now() + 3_600_000,
		});
		authStorage.close();

		const typed = spelling === "MCP_OAUTH:" ? foreignProvider.toUpperCase() : foreignProvider;
		const proc = Bun.spawn([process.execPath, cliEntry, "token", typed], {
			cwd: path.resolve(import.meta.dir, "../../.."),
			env: {
				...process.env,
				NO_COLOR: "1",
				OMP_AUTH_BROKER_TOKEN: undefined,
				OMP_AUTH_BROKER_URL: undefined,
				OMP_PROFILE: undefined,
				PI_PROFILE: undefined,
				PI_CODING_AGENT_DIR: tempDir.path(),
				// The test runner exports PI_NO_MCP=1, which refuses MCP credentials before the profile check.
				PI_NO_MCP: "",
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		const [exitCode, stdout, stderr] = await Promise.all([
			proc.exited,
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);

		expect(exitCode).toBe(1);
		expect(stdout).not.toContain("work-access");
		expect(stderr).toContain('profile "work"');
	}, 30_000);
}
