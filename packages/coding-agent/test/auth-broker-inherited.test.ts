import { describe, expect, it } from "bun:test";
import { fileURLToPath } from "node:url";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import { startAuthBroker } from "@oh-my-pi/pi-ai/auth-broker";
import { TempDir } from "@oh-my-pi/pi-utils";

const TOKEN = "developer-broker-bearer";

/**
 * Run the inherited-broker probe with OMP_AUTH_BROKER_URL and OMP_AUTH_BROKER_TOKEN naming a
 * broker this test serves, a stand-in for a developer's own broker. Every request reaches it
 * through a recording front. Reports what the probe observed, each request the broker got, and
 * the credential the probe tried to save, as the broker now holds it.
 */
async function runInheritedBrokerProbe(testChild: boolean, ...args: string[]) {
	using dir = TempDir.createSync("@omp-broker-probe-");
	const brokerStore = await SqliteAuthCredentialStore.open(dir.join("developer-broker.db"));
	const brokerStorage = new AuthStorage(brokerStore);
	await brokerStorage.credentials.set("inherited-broker-provider", { type: "api_key", key: "developer-broker-key" });
	const broker = startAuthBroker({
		storage: brokerStorage,
		bind: "127.0.0.1:0",
		bearerTokens: [TOKEN],
		disableRefresher: true,
	});
	const requests = new Set<string>();
	const front = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(req) {
			const url = new URL(req.url);
			requests.add(`${req.method} ${url.pathname}`);
			const body = req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer();
			const headers = new Headers(req.headers);
			headers.delete("host");
			return fetch(new URL(url.pathname + url.search, broker.url), { method: req.method, headers, body });
		},
	});
	try {
		const probe = fileURLToPath(new URL("./auth-broker-inherited-probe.ts", import.meta.url));
		const proc = Bun.spawn([process.execPath, probe, ...args], {
			env: {
				...process.env,
				HOME: dir.join("home"),
				USERPROFILE: dir.join("home"),
				PI_CODING_AGENT_DIR: dir.join("agent"),
				// The probe is no test entrypoint, so without the marker it runs as production.
				PI_TEST_RUNTIME: testChild ? "1" : undefined,
				OMP_AUTH_BROKER_URL: `http://127.0.0.1:${front.port}`,
				OMP_AUTH_BROKER_TOKEN: TOKEN,
				OMP_AUTH_BROKER_SNAPSHOT_CACHE: dir.join("snapshot.enc"),
				OMP_AUTH_BROKER_ACCOUNT_POOL_FILE: undefined,
			},
			stdin: "ignore",
			stdout: "pipe",
			stderr: "ignore",
		});
		const [output, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
		const line = output.split("\n").find(entry => entry.startsWith("PROBE: "));
		await brokerStorage.credentials.reload();
		return {
			exitCode,
			observed: line && JSON.parse(line.slice("PROBE: ".length)),
			requests: [...requests].sort(),
			brokerHolds: (await brokerStorage.keys.get("probe-provider")) ?? null,
		};
	} finally {
		await front.stop(true);
		await broker.close();
		brokerStorage.close();
		brokerStore.close();
	}
}

describe("discoverAuthStorage with an inherited auth broker", () => {
	it("neither reads from nor writes to it from a test process that declared no broker", async () => {
		expect(await runInheritedBrokerProbe(true)).toEqual({
			exitCode: 0,
			observed: { testRuntime: true, loaded: null },
			requests: [],
			brokerHolds: null,
		});
	}, 20_000);

	it("reads from and writes to it from a production process", async () => {
		expect(await runInheritedBrokerProbe(false)).toEqual({
			exitCode: 0,
			observed: { testRuntime: false, loaded: "developer-broker-key" },
			requests: expect.arrayContaining(["GET /v1/snapshot", "POST /v1/credential"]),
			brokerHolds: "probe-written-key",
		});
	}, 20_000);

	it("reads from and writes to it from a test process that declared it", async () => {
		expect(await runInheritedBrokerProbe(true, "declare")).toEqual({
			exitCode: 0,
			observed: { testRuntime: true, loaded: "developer-broker-key" },
			requests: expect.arrayContaining(["GET /v1/snapshot", "POST /v1/credential"]),
			brokerHolds: "probe-written-key",
		});
	}, 20_000);
});
