import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import { startAuthBroker } from "@oh-my-pi/pi-ai/auth-broker";
import { TempDir } from "@oh-my-pi/pi-utils";

const TOKEN = "developer-broker-bearer";
const packageDir = path.resolve(import.meta.dir, "..");
const fixture = path.join(import.meta.dir, "fixtures/broker-test-children.ts");

/**
 * An omp CLI that a test spawns has a production entrypoint, so only the test-runtime
 * marker it inherits keeps it off the broker the developer's environment names. A direct
 * `bun test` starts without that marker; the test preload must give it to every child,
 * including one that native code or a Worker starts, which never sees the test's realm.
 */
describe("omp children of a direct `bun test`", () => {
	it.each([
		["an RPC child completes startup", "starts an RPC child and reads its state"],
		["an ACP child completes startup", "starts an ACP child and opens a session"],
		["a native shell's child runs credential discovery", "runs credential discovery in a child of a native shell"],
		[
			"a native terminal's child runs credential discovery",
			"runs credential discovery in a child of a native terminal",
		],
		["a Worker's child runs credential discovery", "runs credential discovery in a child a Worker spawns"],
	])(
		"%s without a request to the inherited auth broker",
		async (_child, fixtureTest) => {
			using dir = TempDir.createSync("@omp-broker-test-children-");
			fs.mkdirSync(dir.join("home"));
			fs.mkdirSync(dir.join("agent"));
			const brokerStore = await SqliteAuthCredentialStore.open(dir.join("developer-broker.db"));
			const brokerStorage = new AuthStorage(brokerStore);
			await brokerStorage.credentials.set("inherited-broker-provider", { type: "api_key", key: "developer-key" });
			const broker = startAuthBroker({
				storage: brokerStorage,
				bind: "127.0.0.1:0",
				bearerTokens: [TOKEN],
				disableRefresher: true,
			});
			const requests: string[] = [];
			const front = Bun.serve({
				hostname: "127.0.0.1",
				port: 0,
				async fetch(req) {
					const url = new URL(req.url);
					requests.push(`${req.method} ${url.pathname} ${req.headers.get("authorization") ?? "(no bearer)"}`);
					const headers = new Headers(req.headers);
					headers.delete("host");
					const body = req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer();
					return fetch(new URL(url.pathname + url.search, broker.url), { method: req.method, headers, body });
				},
			});
			try {
				const run = Bun.spawn([process.execPath, "test", "-t", fixtureTest, fixture], {
					// The package's own bunfig.toml decides what a `bun test` started here preloads.
					cwd: packageDir,
					env: {
						...process.env,
						PI_TEST_RUNTIME: undefined,
						OMP_AUTH_BROKER_URL: `http://127.0.0.1:${front.port}`,
						OMP_AUTH_BROKER_TOKEN: TOKEN,
						OMP_AUTH_BROKER_SNAPSHOT_CACHE: dir.join("snapshot.enc"),
						// A child started with the run's own environment gets this home, not the
						// developer's; the RPC and ACP children replace it with homes of their own.
						HOME: dir.join("home"),
						USERPROFILE: dir.join("home"),
						PI_CODING_AGENT_DIR: dir.join("agent"),
						XDG_DATA_HOME: undefined,
						XDG_STATE_HOME: undefined,
						XDG_CACHE_HOME: undefined,
					},
					stdin: "ignore",
					stdout: "pipe",
					stderr: "pipe",
				});
				const [stdout, stderr, exitCode] = await Promise.all([
					new Response(run.stdout).text(),
					new Response(run.stderr).text(),
					run.exited,
				]);
				const summary = `${stdout}\n${stderr}`.split("\n").filter(line => /^\s*\d+ (pass|fail)$/.test(line));
				expect({ exitCode, summary, requests }).toEqual({
					exitCode: 0,
					summary: [" 1 pass", " 0 fail"],
					requests: [],
				});
			} finally {
				await front.stop(true);
				await broker.close();
				brokerStorage.close();
				brokerStore.close();
			}
		},
		60_000,
	);
});
