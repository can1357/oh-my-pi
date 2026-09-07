import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir, setAgentDir } from "@oh-my-pi/pi-utils";
import { fetchGrokbotAvailableModels } from "../src/discovery/grokbot";
import {
	clearGrokbotTokenCache,
	GROKBOT_RENEWAL_PATH,
	joinGrokbotBackendUrl,
	loadGrokbotConfig,
	GROKBOT_AUTHENTICATED_SENTINEL,
	resolveGrokbotCacheCredential,
	resolveGrokbotEnvApiKey,
	loadGrokbotSecretFile,
	loadGrokbotSecretFileSync,
	mintGrokbotAccessToken,
	resolveGrokbotDiscoveryIdentity,
	resolveGrokbotDiscoveryIdentityAsync,
} from "../src/discovery/grokbot-auth";
import { resolveModelCacheProviderId } from "../src/provider-models/cache-provider-id";
import { grokbotModelManagerOptions } from "../src/provider-models/special";

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

	test("SAND_INFERENCE_RENEWAL_CREDENTIAL env beats secrets-file GROKBOT_RENEWAL_CREDENTIAL", async () => {
		const previousAgentDir = getAgentDir();
		const previousGrokbot = process.env.GROKBOT_RENEWAL_CREDENTIAL;
		const previousSand = process.env.SAND_INFERENCE_RENEWAL_CREDENTIAL;
		const previousMachine = process.env.GROKBOT_MACHINE_ID;
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-grokbot-env-precedence-"));
		dirs.push(agentDir);
		await fs.mkdir(path.join(agentDir, "secrets"), { recursive: true });
		await Bun.write(
			path.join(agentDir, "secrets", "grokbot.env"),
			["GROKBOT_RENEWAL_CREDENTIAL=file-renewal", "GROKBOT_MACHINE_ID=file-machine"].join("\n"),
		);

		try {
			delete process.env.GROKBOT_RENEWAL_CREDENTIAL;
			delete process.env.GROKBOT_MACHINE_ID;
			process.env.SAND_INFERENCE_RENEWAL_CREDENTIAL = "env-sand-renewal";
			setAgentDir(agentDir);

			const cfg = await loadGrokbotConfig();
			expect(cfg.renewal).toBe("env-sand-renewal");
			expect(cfg.machineId).toBe("file-machine");
		} finally {
			setAgentDir(previousAgentDir);
			if (previousGrokbot === undefined) delete process.env.GROKBOT_RENEWAL_CREDENTIAL;
			else process.env.GROKBOT_RENEWAL_CREDENTIAL = previousGrokbot;
			if (previousSand === undefined) delete process.env.SAND_INFERENCE_RENEWAL_CREDENTIAL;
			else process.env.SAND_INFERENCE_RENEWAL_CREDENTIAL = previousSand;
			if (previousMachine === undefined) delete process.env.GROKBOT_MACHINE_ID;
			else process.env.GROKBOT_MACHINE_ID = previousMachine;
		}
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

			const identity = await resolveGrokbotDiscoveryIdentityAsync();
			expect(identity).toEqual({ namespace: "lab", clientVersion: "0.30.0-lab" });
			expect(resolveGrokbotDiscoveryIdentity()).toEqual(identity);

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

	test("resolved identity pass-through skips secrets file and uses overrides", async () => {
		const previousAgentDir = getAgentDir();
		const previousNamespace = process.env.GROKBOT_NAMESPACE;
		const previousClientVersion = process.env.GROKBOT_CLIENT_VERSION;
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-grokbot-pass-"));
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

			// Fully resolved overrides must win over secrets-file values (no reread).
			expect(
				resolveGrokbotDiscoveryIdentity({
					namespace: "prod",
					clientVersion: "0.30.0",
				}),
			).toEqual({ namespace: "prod", clientVersion: "0.30.0" });
			expect(
				await resolveGrokbotDiscoveryIdentityAsync({
					namespace: "prod",
					clientVersion: "0.30.0",
				}),
			).toEqual({ namespace: "prod", clientVersion: "0.30.0" });

			const withPassThrough = resolveModelCacheProviderId("grokbot", {
				apiKey: "renewer",
				baseUrl: "https://api2.cursor.sh",
				namespace: "prod",
				clientVersion: "0.30.0",
			});
			const fromSecrets = resolveModelCacheProviderId("grokbot", {
				apiKey: "renewer",
				baseUrl: "https://api2.cursor.sh",
			});
			expect(withPassThrough).not.toBe(fromSecrets);

			const options = grokbotModelManagerOptions({
				apiKey: "renewer",
				namespace: "prod",
				clientVersion: "0.30.0",
			});
			expect(options.cacheProviderId).toBe(withPassThrough);
		} finally {
			setAgentDir(previousAgentDir);
			if (previousNamespace === undefined) delete process.env.GROKBOT_NAMESPACE;
			else process.env.GROKBOT_NAMESPACE = previousNamespace;
			if (previousClientVersion === undefined) delete process.env.GROKBOT_CLIENT_VERSION;
			else process.env.GROKBOT_CLIENT_VERSION = previousClientVersion;
		}
	});
	test("file-only renewal advertises auth via authenticated sentinel, not the secret", async () => {
		const previousAgentDir = getAgentDir();
		const previousGrokbot = process.env.GROKBOT_RENEWAL_CREDENTIAL;
		const previousSand = process.env.SAND_INFERENCE_RENEWAL_CREDENTIAL;
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-grokbot-env-sentinel-"));
		dirs.push(agentDir);
		await fs.mkdir(path.join(agentDir, "secrets"), { recursive: true });
		await Bun.write(
			path.join(agentDir, "secrets", "grokbot.env"),
			["GROKBOT_RENEWAL_CREDENTIAL=file-only-renewal", "GROKBOT_MACHINE_ID=file-machine"].join("\n"),
		);
		try {
			delete process.env.GROKBOT_RENEWAL_CREDENTIAL;
			delete process.env.SAND_INFERENCE_RENEWAL_CREDENTIAL;
			setAgentDir(agentDir);
			expect(resolveGrokbotEnvApiKey()).toBe("<authenticated>");
			const cfg = await loadGrokbotConfig();
			expect(cfg.renewal).toBe("file-only-renewal");
		} finally {
			setAgentDir(previousAgentDir);
			if (previousGrokbot === undefined) delete process.env.GROKBOT_RENEWAL_CREDENTIAL;
			else process.env.GROKBOT_RENEWAL_CREDENTIAL = previousGrokbot;
			if (previousSand === undefined) delete process.env.SAND_INFERENCE_RENEWAL_CREDENTIAL;
			else process.env.SAND_INFERENCE_RENEWAL_CREDENTIAL = previousSand;
		}
	});

	test("loadGrokbotConfig ignores authenticated sentinel as renewal override", async () => {
		const previousAgentDir = getAgentDir();
		const previousGrokbot = process.env.GROKBOT_RENEWAL_CREDENTIAL;
		const previousSand = process.env.SAND_INFERENCE_RENEWAL_CREDENTIAL;
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-grokbot-cfg-sentinel-"));
		dirs.push(agentDir);
		await fs.mkdir(path.join(agentDir, "secrets"), { recursive: true });
		await Bun.write(
			path.join(agentDir, "secrets", "grokbot.env"),
			["GROKBOT_RENEWAL_CREDENTIAL=file-renewal", "GROKBOT_MACHINE_ID=file-machine"].join("\n"),
		);
		try {
			delete process.env.GROKBOT_RENEWAL_CREDENTIAL;
			delete process.env.SAND_INFERENCE_RENEWAL_CREDENTIAL;
			setAgentDir(agentDir);
			const cfg = await loadGrokbotConfig("<authenticated>");
			expect(cfg.renewal).toBe("file-renewal");
		} finally {
			setAgentDir(previousAgentDir);
			if (previousGrokbot === undefined) delete process.env.GROKBOT_RENEWAL_CREDENTIAL;
			else process.env.GROKBOT_RENEWAL_CREDENTIAL = previousGrokbot;
			if (previousSand === undefined) delete process.env.SAND_INFERENCE_RENEWAL_CREDENTIAL;
			else process.env.SAND_INFERENCE_RENEWAL_CREDENTIAL = previousSand;
		}
	});


	test("file-backed cache ids expand the authenticated sentinel to the renewer", async () => {
		const previousAgentDir = getAgentDir();
		const previousGrokbot = process.env.GROKBOT_RENEWAL_CREDENTIAL;
		const previousSand = process.env.SAND_INFERENCE_RENEWAL_CREDENTIAL;
		const agentDirA = await fs.mkdtemp(path.join(os.tmpdir(), "omp-grokbot-cache-a-"));
		const agentDirB = await fs.mkdtemp(path.join(os.tmpdir(), "omp-grokbot-cache-b-"));
		dirs.push(agentDirA, agentDirB);
		await fs.mkdir(path.join(agentDirA, "secrets"), { recursive: true });
		await fs.mkdir(path.join(agentDirB, "secrets"), { recursive: true });
		await Bun.write(
			path.join(agentDirA, "secrets", "grokbot.env"),
			["GROKBOT_RENEWAL_CREDENTIAL=file-renewal-a", "GROKBOT_MACHINE_ID=machine-a"].join("\n"),
		);
		await Bun.write(
			path.join(agentDirB, "secrets", "grokbot.env"),
			["GROKBOT_RENEWAL_CREDENTIAL=file-renewal-b", "GROKBOT_MACHINE_ID=machine-b"].join("\n"),
		);
		try {
			delete process.env.GROKBOT_RENEWAL_CREDENTIAL;
			delete process.env.SAND_INFERENCE_RENEWAL_CREDENTIAL;
			setAgentDir(agentDirA);
			expect(resolveGrokbotEnvApiKey()).toBe(GROKBOT_AUTHENTICATED_SENTINEL);
			expect(resolveGrokbotCacheCredential(GROKBOT_AUTHENTICATED_SENTINEL)).toBe("file-renewal-a");
			const cacheA = resolveModelCacheProviderId("grokbot", {
				apiKey: GROKBOT_AUTHENTICATED_SENTINEL,
				baseUrl: "https://api2.cursor.sh",
				namespace: "prod",
				clientVersion: "0.30.0",
			});
			setAgentDir(agentDirB);
			expect(resolveGrokbotCacheCredential(GROKBOT_AUTHENTICATED_SENTINEL)).toBe("file-renewal-b");
			const cacheB = resolveModelCacheProviderId("grokbot", {
				apiKey: GROKBOT_AUTHENTICATED_SENTINEL,
				baseUrl: "https://api2.cursor.sh",
				namespace: "prod",
				clientVersion: "0.30.0",
			});
			expect(cacheA).not.toBe(cacheB);
			// Explicit renewer still matches the expanded sentinel for the same account.
			setAgentDir(agentDirA);
			expect(
				resolveModelCacheProviderId("grokbot", {
					apiKey: "file-renewal-a",
					baseUrl: "https://api2.cursor.sh",
					namespace: "prod",
					clientVersion: "0.30.0",
				}),
			).toBe(cacheA);
		} finally {
			setAgentDir(previousAgentDir);
			if (previousGrokbot === undefined) delete process.env.GROKBOT_RENEWAL_CREDENTIAL;
			else process.env.GROKBOT_RENEWAL_CREDENTIAL = previousGrokbot;
			if (previousSand === undefined) delete process.env.SAND_INFERENCE_RENEWAL_CREDENTIAL;
			else process.env.SAND_INFERENCE_RENEWAL_CREDENTIAL = previousSand;
		}
	});

});

describe("grokbot backend URL join", () => {
	afterEach(() => {
		clearGrokbotTokenCache();
	});

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
		const fetchImpl = Object.assign(
			async (url: string | URL | Request) => {
				seen.push(String(url));
				return new Response(JSON.stringify({ accessToken: "tok", expiresAtMs: Date.now() + 600_000 }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			},
			{ preconnect: fetch.preconnect },
		) as typeof fetch;
		await mintGrokbotAccessToken(
			{ renewal: "renewer", machineId: "machine", namespace: "prod", clientVersion: "0.30.0" },
			fetchImpl,
			"https://proxy.example/grokbot",
		);
		expect(seen).toEqual(["https://proxy.example/grokbot/sand-box/inference-credential"]);
	});

	test("mintGrokbotAccessToken forwards caller headers under provider-owned headers", async () => {
		let captured: Record<string, string> | undefined;
		const fetchImpl = Object.assign(
			async (_url: string | URL | Request, init?: RequestInit) => {
				captured = init?.headers as Record<string, string>;
				return new Response(JSON.stringify({ accessToken: "tok", expiresAtMs: Date.now() + 600_000 }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			},
			{ preconnect: fetch.preconnect },
		) as typeof fetch;
		await mintGrokbotAccessToken(
			{ renewal: "renewer", machineId: "machine", namespace: "prod", clientVersion: "0.30.0" },
			fetchImpl,
			"https://proxy.example/grokbot",
			undefined,
			{ "x-proxy-api-key": "proxy-secret", "x-cursor-client-type": "spoofed" },
		);
		expect(captured?.["x-proxy-api-key"]).toBe("proxy-secret");
		expect(captured?.["content-type"]).toBe("application/json");
		// Provider-owned client headers win over caller spoofing.
		expect(captured?.["x-cursor-client-type"]).toBe("sand");
		expect(captured?.["x-sand-box-namespace"]).toBe("prod");
	});

	test("mintGrokbotAccessToken replaces Content-Type case-insensitively", async () => {
		let captured: Record<string, string> | undefined;
		const fetchImpl = Object.assign(
			async (_url: string | URL | Request, init?: RequestInit) => {
				captured = init?.headers as Record<string, string>;
				return new Response(JSON.stringify({ accessToken: "tok", expiresAtMs: Date.now() + 600_000 }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			},
			{ preconnect: fetch.preconnect },
		) as typeof fetch;
		await mintGrokbotAccessToken(
			{ renewal: "renewer", machineId: "machine", namespace: "prod", clientVersion: "0.30.0" },
			fetchImpl,
			"https://proxy.example/grokbot",
			undefined,
			{ "Content-Type": "text/plain", "X-Proxy-Api-Key": "proxy-secret" },
		);
		const typeKeys = Object.keys(captured ?? {}).filter(k => k.toLowerCase() === "content-type");
		expect(typeKeys).toHaveLength(1);
		expect(captured?.[typeKeys[0]!]).toBe("application/json");
		expect(captured?.["X-Proxy-Api-Key"] ?? captured?.["x-proxy-api-key"]).toBe("proxy-secret");
	});

	test("JWT cache is scoped by caller/proxy headers", async () => {
		const seen: string[] = [];
		const fetchImpl = Object.assign(
			async (_url: string | URL | Request, init?: RequestInit) => {
				const headers = init?.headers as Record<string, string>;
				seen.push(headers?.["x-tenant"] ?? "");
				return new Response(
					JSON.stringify({ accessToken: `tok-${seen.length}`, expiresAtMs: Date.now() + 600_000 }),
					{
						status: 200,
						headers: { "content-type": "application/json" },
					},
				);
			},
			{ preconnect: fetch.preconnect },
		) as typeof fetch;
		const cfg = { renewal: "renewer", machineId: "machine", namespace: "prod", clientVersion: "0.30.0" };
		const first = await mintGrokbotAccessToken(cfg, fetchImpl, "https://proxy.example/grokbot", undefined, {
			"x-tenant": "a",
		});
		const cached = await mintGrokbotAccessToken(cfg, fetchImpl, "https://proxy.example/grokbot", undefined, {
			"x-tenant": "a",
		});
		const second = await mintGrokbotAccessToken(cfg, fetchImpl, "https://proxy.example/grokbot", undefined, {
			"x-tenant": "b",
		});
		expect(first).toBe("tok-1");
		expect(cached).toBe("tok-1");
		expect(second).toBe("tok-2");
		expect(seen).toEqual(["a", "b"]);
	});
});

describe("grokbot AvailableModels headers", () => {
	const previousMachineId = process.env.GROKBOT_MACHINE_ID;
	const previousNamespace = process.env.GROKBOT_NAMESPACE;
	const previousClientVersion = process.env.GROKBOT_CLIENT_VERSION;

	afterEach(() => {
		clearGrokbotTokenCache();
		if (previousMachineId === undefined) delete process.env.GROKBOT_MACHINE_ID;
		else process.env.GROKBOT_MACHINE_ID = previousMachineId;
		if (previousNamespace === undefined) delete process.env.GROKBOT_NAMESPACE;
		else process.env.GROKBOT_NAMESPACE = previousNamespace;
		if (previousClientVersion === undefined) delete process.env.GROKBOT_CLIENT_VERSION;
		else process.env.GROKBOT_CLIENT_VERSION = previousClientVersion;
	});

	test("forwards configured headers on mint and AvailableModels", async () => {
		process.env.GROKBOT_MACHINE_ID = "machine";
		process.env.GROKBOT_NAMESPACE = "prod";
		process.env.GROKBOT_CLIENT_VERSION = "0.30.0";
		const seen: Array<{ url: string; headers: Record<string, string> }> = [];
		const fetchImpl = Object.assign(
			async (url: string | URL | Request, init?: RequestInit) => {
				seen.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string> });
				if (String(url).includes("inference-credential")) {
					return new Response(JSON.stringify({ accessToken: "tok", expiresAtMs: Date.now() + 600_000 }), {
						status: 200,
						headers: { "content-type": "application/json" },
					});
				}
				return new Response(JSON.stringify({ models: [] }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			},
			{ preconnect: fetch.preconnect },
		) as typeof fetch;
		const models = await fetchGrokbotAvailableModels({
			apiKey: "renewer",
			baseUrl: "https://proxy.example/grokbot",
			fetch: fetchImpl,
			headers: { "x-proxy-api-key": "proxy-secret" },
		});
		expect(models).not.toBeNull();
		expect(seen.length).toBe(2);
		expect(seen.every(s => s.headers["x-proxy-api-key"] === "proxy-secret")).toBe(true);
		expect(seen[1]?.url).toContain("/aiserver.v1.AiService/AvailableModels");
		expect(seen[1]?.headers["connect-protocol-version"]).toBe("1");
	});

	test("clears the cached token after AvailableModels returns 401", async () => {
		process.env.GROKBOT_MACHINE_ID = "machine";
		process.env.GROKBOT_NAMESPACE = "prod";
		process.env.GROKBOT_CLIENT_VERSION = "0.30.0";
		let mintCount = 0;
		const fetchImpl = Object.assign(
			async (url: string | URL | Request) => {
				if (String(url).includes("inference-credential")) {
					mintCount += 1;
					return new Response(
						JSON.stringify({ accessToken: `tok-${mintCount}`, expiresAtMs: Date.now() + 600_000 }),
						{ status: 200, headers: { "content-type": "application/json" } },
					);
				}
				if (mintCount === 1) {
					return new Response("Unauthorized", { status: 401 });
				}
				return new Response(JSON.stringify({ models: [] }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			},
			{ preconnect: fetch.preconnect },
		) as typeof fetch;
		const first = await fetchGrokbotAvailableModels({
			apiKey: "renewer",
			baseUrl: "https://proxy.example/grokbot",
			fetch: fetchImpl,
		});
		expect(first).toBeNull();
		expect(mintCount).toBe(1);

		const second = await fetchGrokbotAvailableModels({
			apiKey: "renewer",
			baseUrl: "https://proxy.example/grokbot",
			fetch: fetchImpl,
		});
		expect(second).not.toBeNull();
		// Without clearing on 401, the second call would reuse tok-1 and never remint.
		expect(mintCount).toBe(2);
	});

});
