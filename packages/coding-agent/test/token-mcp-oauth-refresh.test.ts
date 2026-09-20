import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import * as path from "node:path";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import { refreshStoredManagedMcpOAuthCredential } from "@oh-my-pi/pi-coding-agent/mcp/oauth-credentials";
import type { MCPStoredOAuthCredential } from "@oh-my-pi/pi-coding-agent/mcp/oauth-flow";
import { TempDir } from "@oh-my-pi/pi-utils";

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
		await storage.reload();
		const credential: MCPStoredOAuthCredential = {
			type: "oauth",
			access: "access-0",
			refresh: "refresh-0",
			expires: Date.now() - 60_000,
			tokenUrl: `http://127.0.0.1:${tokenServer.port}/token`,
		};
		await storage.set(provider, credential);
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
		await authStorage.reload();
		const credential: MCPStoredOAuthCredential = {
			type: "oauth",
			access: "access-0",
			refresh: "refresh-0",
			expires: Date.now() - 60_000,
			tokenUrl: `http://127.0.0.1:${tokenServer.port}/token`,
		};
		await authStorage.set(provider, credential);
		authStorage.close();

		const proc = Bun.spawn([process.execPath, cliEntry, "token", provider, "--force-refresh"], {
			cwd: path.resolve(import.meta.dir, "../../.."),
			env: {
				...process.env,
				NO_COLOR: "1",
				OMP_AUTH_BROKER_TOKEN: undefined,
				OMP_AUTH_BROKER_URL: undefined,
				PI_CODING_AGENT_DIR: tempDir.path(),
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
		await persistedStorage.reload();
		const persisted = persistedStorage.get(provider);
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

test("token refuses a managed MCP id scoped to another profile", async () => {
	using tempDir = TempDir.createSync("@omp-token-mcp-oauth-xprofile-");
	// A non-expired row that the fall-through resolver WOULD hand back verbatim.
	const foreignProvider = "mcp_oauth:profile:work:https://mcp.example.test/mcp";
	const dbPath = tempDir.join("agent.db");
	const store = await SqliteAuthCredentialStore.open(dbPath);
	const authStorage = new AuthStorage(store);
	await authStorage.reload();
	await authStorage.set(foreignProvider, {
		type: "oauth",
		access: "work-access",
		refresh: "work-refresh",
		expires: Date.now() + 3_600_000,
	});
	authStorage.close();

	const proc = Bun.spawn([process.execPath, cliEntry, "token", foreignProvider], {
		cwd: path.resolve(import.meta.dir, "../../.."),
		env: {
			...process.env,
			NO_COLOR: "1",
			OMP_AUTH_BROKER_TOKEN: undefined,
			OMP_AUTH_BROKER_URL: undefined,
			OMP_PROFILE: undefined,
			PI_PROFILE: undefined,
			PI_CODING_AGENT_DIR: tempDir.path(),
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
