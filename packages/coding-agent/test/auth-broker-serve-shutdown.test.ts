import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import { type MCPStoredOAuthCredential, mcpOAuthCredentialId } from "@oh-my-pi/pi-coding-agent/mcp/oauth-flow";
import { TempDir } from "@oh-my-pi/pi-utils";

const cliEntry = path.resolve(import.meta.dir, "../src/cli.ts");
const MCP_PROVIDER = mcpOAuthCredentialId("https://mcp.example.test/mcp", "default");

/** Reads until `marker` appears without cancelling the stream, so the child never meets a closed stdout. */
async function readUntil(stream: ReadableStream<Uint8Array>, marker: string): Promise<void> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let text = "";
	while (!text.includes(marker)) {
		const { done, value } = await reader.read();
		if (done) throw new Error(`stdout ended before "${marker}":\n${text}`);
		text += decoder.decode(value, { stream: true });
	}
}

async function storedRefreshToken(dbPath: string): Promise<string | undefined> {
	const store = await SqliteAuthCredentialStore.open(dbPath);
	try {
		const credential = store.listAuthCredentials(MCP_PROVIDER)[0]?.credential;
		return credential?.type === "oauth" ? credential.refresh : undefined;
	} finally {
		store.close();
	}
}

describe("omp auth-broker serve shutdown", () => {
	// The broker's background refresher exchanges the expiring row at startup; the provider
	// answers only after the broker began stopping, as when a restart lands mid-refresh.
	// POSIX signals: on Windows `kill("SIGTERM")` terminates the child outright. The budget
	// covers cold-starting the CLI graph in the child process.
	it.skipIf(process.platform === "win32")(
		"saves a token the provider rotated after SIGTERM before exiting",
		async () => {
			using tempDir = TempDir.createSync("@omp-auth-broker-shutdown-");
			const home = tempDir.join("home");
			fs.mkdirSync(home);
			const dbPath = path.join(home, ".omp", "agent", "agent.db");
			fs.mkdirSync(path.dirname(dbPath), { recursive: true });

			const tokenRequested = Promise.withResolvers<void>();
			const tokenResponse = Promise.withResolvers<Response>();
			using tokenServer = Bun.serve({
				port: 0,
				fetch() {
					tokenRequested.resolve();
					return tokenResponse.promise;
				},
			});

			const seedStore = await SqliteAuthCredentialStore.open(dbPath);
			const seed = new AuthStorage(seedStore);
			// MCP rows carry their own token endpoint, so the broker's refresh reaches the local server.
			const credential: MCPStoredOAuthCredential = {
				type: "oauth",
				access: "stale-access",
				refresh: "original-refresh",
				expires: Date.now() - 60_000,
				tokenUrl: `http://127.0.0.1:${tokenServer.port}/token`,
				clientId: "client-xyz",
			};
			await seed.credentials.set(MCP_PROVIDER, credential);
			seed.close();
			seedStore.close();

			// The child must resolve its agent dir from the isolated home, not an inherited override or profile.
			const env: Record<string, string | undefined> = {
				...process.env,
				HOME: home,
				USERPROFILE: home,
				NO_COLOR: "1",
			};
			for (const key of [
				"PI_CODING_AGENT_DIR",
				"PI_CONFIG_DIR",
				"OMP_PROFILE",
				"PI_PROFILE",
				"XDG_CACHE_HOME",
				"XDG_CONFIG_HOME",
				"XDG_DATA_HOME",
				"XDG_STATE_HOME",
				// The test waits for an info-level line, which OMP_LOG_LEVEL can silence.
				"OMP_LOG_LEVEL",
			]) {
				delete env[key];
			}
			const proc = Bun.spawn([process.execPath, cliEntry, "auth-broker", "serve", "--bind=127.0.0.1:0"], {
				cwd: tempDir.path(),
				env,
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			});
			try {
				const exitedFirst = await Promise.race([tokenRequested.promise.then(() => undefined), proc.exited]);
				if (exitedFirst !== undefined) {
					throw new Error(
						`serve exited ${exitedFirst} before refreshing:\n${await new Response(proc.stderr).text()}`,
					);
				}
				proc.kill("SIGTERM");
				await readUntil(proc.stdout, "auth-broker shutting down");
				tokenResponse.resolve(
					Response.json({ access_token: "rotated-access", refresh_token: "rotated-refresh", expires_in: 3600 }),
				);
				await proc.exited;
			} finally {
				proc.kill("SIGKILL");
				await proc.exited;
			}

			expect(await storedRefreshToken(dbPath)).toBe("rotated-refresh");
		},
		30_000,
	);
});
