import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir, setAgentDir } from "@oh-my-pi/pi-utils";
import {
	joinGrokbotBackendUrl,
	loadGrokbotSecretFile,
	loadGrokbotSecretFileSync,
	mintGrokbotAccessToken,
	resolveGrokbotDiscoveryIdentity,
	GROKBOT_RENEWAL_PATH,
} from "../src/discovery/grokbot-auth";
import { resolveModelCacheProviderId } from "../src/provider-models/cache-provider-id";

describe("grokbot secrets dotenv parsing", () => {
	const dirs: string[] = [];

	afterEach(async () => {
		await Promise.all(dirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
	});

	test("strips quotes, export prefixes, and inline comments via shared parseEnvFile", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-grokbot-env-"));
		dirs.push(dir);
		const filePath = path.join(dir, "grokbot.env");
		await Bun.write(
			filePath,
			[
				"# host secrets",
				"export GROKBOT_MACHINE_ID=machine-1",
				'GROKBOT_RENEWAL_CREDENTIAL="token-with-spaces"',
				"GROKBOT_NAMESPACE=prod # inline",
			].join("\n"),
		);

		const asyncFile = await loadGrokbotSecretFile(filePath);
		const syncFile = loadGrokbotSecretFileSync(filePath);

		expect(asyncFile).toEqual({
			GROKBOT_MACHINE_ID: "machine-1",
			GROKBOT_RENEWAL_CREDENTIAL: "token-with-spaces",
			GROKBOT_NAMESPACE: "prod",
		});
		expect(syncFile).toEqual(asyncFile);
	});

	test("missing secrets file yields an empty map", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-grokbot-env-missing-"));
		dirs.push(dir);
		const missing = path.join(dir, "absent.env");
		expect(await loadGrokbotSecretFile(missing)).toEqual({});
		expect(loadGrokbotSecretFileSync(missing)).toEqual({});
	});

	test("discovery identity and cache id honor secrets-file namespace/client version", async () => {
		const previousAgentDir = getAgentDir();
		const previousNamespace = process.env.GROKBOT_NAMESPACE;
		const previousClientVersion = process.env.GROKBOT_CLIENT_VERSION;
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-grokbot-agent-"));
		dirs.push(agentDir);
		await fs.mkdir(path.join(agentDir, "secrets"), { recursive: true });
		await Bun.write(
			path.join(agentDir, "secrets", "grokbot.env"),
			["GROKBOT_NAMESPACE=lab", "GROKBOT_CLIENT_VERSION=0.30.0-lab"].join("\n"),
		);

		try {
			delete process.env.GROKBOT_NAMESPACE;
			delete process.env.GROKBOT_CLIENT_VERSION;
			setAgentDir(agentDir);

			const identity = resolveGrokbotDiscoveryIdentity();
			expect(identity).toEqual({ namespace: "lab", clientVersion: "0.30.0-lab" });

			const fromSecrets = resolveModelCacheProviderId("grokbot", {
				apiKey: "renewer",
				baseUrl: "https://api2.cursor.sh",
			});
			const explicit = resolveModelCacheProviderId("grokbot", {
				apiKey: "renewer",
				baseUrl: "https://api2.cursor.sh",
				namespace: "lab",
				clientVersion: "0.30.0-lab",
			});
			const prod = resolveModelCacheProviderId("grokbot", {
				apiKey: "renewer",
				baseUrl: "https://api2.cursor.sh",
				namespace: "prod",
				clientVersion: "0.30.0",
			});
			expect(fromSecrets).toBe(explicit);
			expect(fromSecrets).not.toBe(prod);
		} finally {
			setAgentDir(previousAgentDir);
			if (previousNamespace === undefined) delete process.env.GROKBOT_NAMESPACE;
			else process.env.GROKBOT_NAMESPACE = previousNamespace;
			if (previousClientVersion === undefined) delete process.env.GROKBOT_CLIENT_VERSION;
			else process.env.GROKBOT_CLIENT_VERSION = previousClientVersion;
		}
	});
});

describe("grokbot backend URL join", () => {
	test("preserves reverse-proxy path prefixes for renewal", () => {
		expect(joinGrokbotBackendUrl("https://proxy.example/grokbot", GROKBOT_RENEWAL_PATH).href).toBe(
			"https://proxy.example/grokbot/sand-box/inference-credential",
		);
		expect(joinGrokbotBackendUrl("https://api2.cursor.sh/", GROKBOT_RENEWAL_PATH).href).toBe(
			"https://api2.cursor.sh/sand-box/inference-credential",
		);
	});

	test("mintGrokbotAccessToken posts to the path-preserving renewal URL", async () => {
		const seen: string[] = [];
		const fetchImpl: typeof fetch = async url => {
			seen.push(String(url));
			return new Response(JSON.stringify({ accessToken: "tok", expiresAtMs: Date.now() + 600_000 }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		};
		await mintGrokbotAccessToken(
			{ renewal: "renewer", machineId: "machine", namespace: "prod", clientVersion: "0.30.0" },
			fetchImpl,
			"https://proxy.example/grokbot",
		);
		expect(seen).toEqual(["https://proxy.example/grokbot/sand-box/inference-credential"]);
	});
});
