import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import {
	allowAuthBrokerForTests,
	resolveAuthBrokerConfig as resolveAuthBrokerConfigUncached,
	startAuthBroker,
} from "@oh-my-pi/pi-ai/auth-broker";
import { runAuthBrokerCommand } from "@oh-my-pi/pi-coding-agent/cli/auth-broker-cli";
import { resolveAuthBrokerConfig } from "@oh-my-pi/pi-coding-agent/session/auth-broker-config";
import { getAgentDbPath, getAgentDir, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";

const BROKER_ENV = ["OMP_AUTH_BROKER_URL", "OMP_AUTH_BROKER_TOKEN"] as const;

/**
 * The CLI's broker memo outlives one call, so it must not outlive the test declaration a
 * resolution ran under: withdrawing the declaration stops the next operation from reaching
 * the broker, and making one lets the next operation reach it.
 */
describe("resolveAuthBrokerConfig memo and test broker declarations", () => {
	let dir: TempDir;
	let originalAgentDir: string;
	const savedEnv: Partial<Record<(typeof BROKER_ENV)[number], string>> = {};

	beforeEach(() => {
		dir = TempDir.createSync("@omp-broker-declaration-memo-");
		originalAgentDir = getAgentDir();
		setAgentDir(dir.join("agent"));
		for (const key of BROKER_ENV) {
			savedEnv[key] = process.env[key];
			delete process.env[key];
		}
	});

	afterEach(() => {
		setAgentDir(originalAgentDir);
		for (const key of BROKER_ENV) {
			if (savedEnv[key] === undefined) delete process.env[key];
			else process.env[key] = savedEnv[key];
		}
		dir.removeSync();
	});

	it("sends a credential import after the declaration is withdrawn to the local store, not the broker", async () => {
		const brokerStore = await SqliteAuthCredentialStore.open(dir.join("broker.db"));
		const brokerStorage = new AuthStorage(brokerStore);
		const broker = startAuthBroker({
			storage: brokerStorage,
			bind: "127.0.0.1:0",
			bearerTokens: ["developer-token"],
			disableRefresher: true,
		});
		const requests: string[] = [];
		const front = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(req) {
				const url = new URL(req.url);
				requests.push(`${req.method} ${url.pathname}`);
				const headers = new Headers(req.headers);
				headers.delete("host");
				const body = req.method === "GET" ? undefined : await req.arrayBuffer();
				return fetch(new URL(url.pathname + url.search, broker.url), { method: req.method, headers, body });
			},
		});
		const writeStdout = process.stdout.write;
		try {
			process.env.OMP_AUTH_BROKER_URL = front.url.origin;
			process.env.OMP_AUTH_BROKER_TOKEN = "developer-token";
			// Disposed by hand below; `using` withdraws it too when an assertion fails first.
			using declaration = allowAuthBrokerForTests(front.url);
			expect(await resolveAuthBrokerConfig()).toEqual({ url: front.url.origin, token: "developer-token" });
			declaration[Symbol.dispose]();

			const fixture = dir.join("claude.json");
			await Bun.write(
				fixture,
				JSON.stringify({
					type: "claude",
					access_token: "fixture-access",
					refresh_token: "fixture-refresh",
					expired: "2099-12-31T23:59:59Z",
					email: "fixture@example.com",
				}),
			);
			process.stdout.write = (() => true) as typeof process.stdout.write;
			try {
				await runAuthBrokerCommand({ action: "import", flags: { source: fixture, json: true } });
			} finally {
				process.stdout.write = writeStdout;
			}

			expect(requests).toEqual([]);
			expect(brokerStore.listAuthCredentials()).toEqual([]);
			const localStore = await SqliteAuthCredentialStore.open(getAgentDbPath());
			try {
				expect(localStore.listAuthCredentials().map(row => row.credential)).toEqual([
					expect.objectContaining({ type: "oauth", access: "fixture-access", email: "fixture@example.com" }),
				]);
			} finally {
				localStore.close();
			}
		} finally {
			process.stdout.write = writeStdout;
			await front.stop(true);
			await broker.close();
			brokerStorage.close();
			brokerStore.close();
		}
	});

	it("resolves a broker declared after an undeclared lookup of the same configuration", async () => {
		const url = "https://declared-later.invalid";
		process.env.OMP_AUTH_BROKER_URL = url;
		process.env.OMP_AUTH_BROKER_TOKEN = "fixture-token";
		expect(await resolveAuthBrokerConfig()).toBeNull();

		using _broker = allowAuthBrokerForTests(url);
		expect(await resolveAuthBrokerConfig()).toEqual({ url, token: "fixture-token" });
		expect(await resolveAuthBrokerConfigUncached({ agentDir: getAgentDir() })).toEqual({
			url,
			token: "fixture-token",
		});
	});

	it("does not revive a lookup refused mid-flight when the same broker is declared again", async () => {
		// A broker named only in config.yml makes the resolver read the file before it checks
		// the declaration, so withdrawing the declaration during that read refuses the lookup.
		const url = "https://redeclared.invalid";
		await Bun.write(
			path.join(getAgentDir(), "config.yml"),
			`auth.broker.url: ${url}\nauth.broker.token: config-token\n`,
		);
		const first = allowAuthBrokerForTests(url);
		const refused = resolveAuthBrokerConfig();
		first[Symbol.dispose]();
		expect(await refused).toBeNull();

		using _again = allowAuthBrokerForTests(url);
		expect(await resolveAuthBrokerConfig()).toEqual({ url, token: "config-token" });
	});
});
