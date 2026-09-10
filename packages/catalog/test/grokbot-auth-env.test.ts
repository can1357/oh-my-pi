import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fetchGrokbotAvailableModels } from "../src/discovery/grokbot";
import * as grokbotAuth from "../src/discovery/grokbot-auth";
import {
	clearGrokbotTokenCache,
	GROKBOT_RENEWAL_PATH,
	joinGrokbotBackendUrl,
	loadGrokbotConfig,
	GROKBOT_AUTHENTICATED_SENTINEL,
	resolveGrokbotCacheCredential,
	resolveGrokbotCacheCredentialAsync,
	resolveGrokbotEnvApiKey,
	resolveGrokbotMachineId,
	loadGrokbotSecretFile,
	loadGrokbotSecretFileSync,
	mintGrokbotAccessToken,
	resolveGrokbotDiscoveryIdentity,
	resolveGrokbotDiscoveryIdentityAsync,
	runWithGrokbotAuthSource,
	runWithGrokbotAuthSourceAsync,
	type GrokbotAuthSource,
} from "../src/discovery/grokbot-auth";
import { resolveModelCacheProviderId } from "../src/provider-models/cache-provider-id";
import { grokbotModelManagerOptions } from "../src/provider-models/special";

function secretsPathFor(agentDir: string): string {
	return path.join(agentDir, "secrets", "grokbot.env");
}

/** Clear ambient Grok Bot env keys so only the injected overlay / secrets file apply. */
const CLEAR_GROKBOT_ENV: Record<string, string | undefined> = {
	GROKBOT_RENEWAL_CREDENTIAL: undefined,
	SAND_INFERENCE_RENEWAL_CREDENTIAL: undefined,
	GROKBOT_MACHINE_ID: undefined,
	GROKBOT_NAMESPACE: undefined,
	GROKBOT_CLIENT_VERSION: undefined,
};

function authSource(agentDir: string, env: Record<string, string | undefined> = {}): GrokbotAuthSource {
	return {
		secretsPath: secretsPathFor(agentDir),
		env: { ...CLEAR_GROKBOT_ENV, ...env },
	};
}

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
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-grokbot-env-precedence-"));
		dirs.push(agentDir);
		await fs.mkdir(path.join(agentDir, "secrets"), { recursive: true });
		await Bun.write(
			secretsPathFor(agentDir),
			["GROKBOT_RENEWAL_CREDENTIAL=file-renewal", "GROKBOT_MACHINE_ID=file-machine"].join("\n"),
		);

		const cfg = await runWithGrokbotAuthSourceAsync(
			authSource(agentDir, { SAND_INFERENCE_RENEWAL_CREDENTIAL: "env-sand-renewal" }),
			() => loadGrokbotConfig(),
		);
		expect(cfg.renewal).toBe("env-sand-renewal");
		expect(cfg.machineId).toBe("file-machine");
	});

	test("discovery identity and cache id honor secrets-file namespace/client version", async () => {
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-grokbot-agent-"));
		dirs.push(agentDir);
		await fs.mkdir(path.join(agentDir, "secrets"), { recursive: true });
		await Bun.write(
			secretsPathFor(agentDir),
			["GROKBOT_NAMESPACE=lab", "GROKBOT_CLIENT_VERSION=0.30.0-lab"].join("\n"),
		);

		await runWithGrokbotAuthSourceAsync(authSource(agentDir), async () => {
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
		});
	});

	test("resolved identity pass-through skips secrets file and uses overrides", async () => {
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-grokbot-pass-"));
		dirs.push(agentDir);
		await fs.mkdir(path.join(agentDir, "secrets"), { recursive: true });
		await Bun.write(
			secretsPathFor(agentDir),
			["GROKBOT_NAMESPACE=lab", "GROKBOT_CLIENT_VERSION=0.30.0-lab"].join("\n"),
		);

		await runWithGrokbotAuthSourceAsync(
			authSource(agentDir, {
				GROKBOT_MACHINE_ID: "machine",
				GROKBOT_NAMESPACE: "lab",
				GROKBOT_CLIENT_VERSION: "0.30.0-lab",
			}),
			async () => {
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

				// Discovery must use the same identity as cache scoping — not ambient
				// secrets/env that may differ after construction.
				const seen: Array<Record<string, string>> = [];
				const fetchImpl = Object.assign(
					async (_url: string | URL | Request, init?: RequestInit) => {
						seen.push((init?.headers ?? {}) as Record<string, string>);
						if (String(_url).includes("inference-credential")) {
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
				const manager = grokbotModelManagerOptions({
					apiKey: "renewer",
					namespace: "prod",
					clientVersion: "0.30.0",
					fetch: fetchImpl,
				});
				expect(await manager.fetchDynamicModels?.()).not.toBeNull();
				expect(seen.length).toBeGreaterThanOrEqual(2);
				expect(seen.every(h => h["x-sand-box-namespace"] === "prod")).toBe(true);
				expect(seen.every(h => h["x-cursor-client-version"] === "0.30.0")).toBe(true);
				expect(seen.some(h => h["x-sand-box-namespace"] === "lab")).toBe(false);
			},
		);
	});

	test("file-only renewal advertises auth via authenticated sentinel, not the secret", async () => {
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-grokbot-env-sentinel-"));
		dirs.push(agentDir);
		await fs.mkdir(path.join(agentDir, "secrets"), { recursive: true });
		await Bun.write(
			secretsPathFor(agentDir),
			["GROKBOT_RENEWAL_CREDENTIAL=file-only-renewal", "GROKBOT_MACHINE_ID=file-machine"].join("\n"),
		);
		await runWithGrokbotAuthSourceAsync(authSource(agentDir), async () => {
			expect(resolveGrokbotEnvApiKey()).toBe("<authenticated>");
			const cfg = await loadGrokbotConfig();
			expect(cfg.renewal).toBe("file-only-renewal");
		});
	});

	test("renewal without machine id does not advertise Grok Bot auth", async () => {
		// Incomplete pairs must stay unavailable so ModelRegistry cannot select a
		// model that streamGrokBot will always reject with "machine id missing".
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-grokbot-env-no-machine-"));
		dirs.push(agentDir);
		await fs.mkdir(path.join(agentDir, "secrets"), { recursive: true });
		await Bun.write(secretsPathFor(agentDir), "GROKBOT_RENEWAL_CREDENTIAL=file-only-renewal\n");

		runWithGrokbotAuthSource(authSource(agentDir), () => {
			expect(resolveGrokbotEnvApiKey()).toBeUndefined();
		});
		runWithGrokbotAuthSource(authSource(agentDir, { GROKBOT_RENEWAL_CREDENTIAL: "env-renewal" }), () => {
			expect(resolveGrokbotEnvApiKey()).toBeUndefined();
			expect(resolveGrokbotMachineId()).toBeUndefined();
		});
		runWithGrokbotAuthSource(
			authSource(agentDir, { GROKBOT_RENEWAL_CREDENTIAL: "env-renewal", GROKBOT_MACHINE_ID: "env-machine" }),
			() => {
				expect(resolveGrokbotEnvApiKey()).toBe("env-renewal");
				expect(resolveGrokbotMachineId()).toBe("env-machine");
			},
		);
	});

	test("env renewal pairs with secrets-file machine id to advertise auth", async () => {
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-grokbot-env-pair-"));
		dirs.push(agentDir);
		await fs.mkdir(path.join(agentDir, "secrets"), { recursive: true });
		await Bun.write(secretsPathFor(agentDir), "GROKBOT_MACHINE_ID=file-machine\n");
		runWithGrokbotAuthSource(authSource(agentDir, { GROKBOT_RENEWAL_CREDENTIAL: "env-renewal" }), () => {
			expect(resolveGrokbotEnvApiKey()).toBe("env-renewal");
		});
	});

	test("loadGrokbotConfig ignores authenticated sentinel as renewal override", async () => {
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-grokbot-cfg-sentinel-"));
		dirs.push(agentDir);
		await fs.mkdir(path.join(agentDir, "secrets"), { recursive: true });
		await Bun.write(
			secretsPathFor(agentDir),
			["GROKBOT_RENEWAL_CREDENTIAL=file-renewal", "GROKBOT_MACHINE_ID=file-machine"].join("\n"),
		);
		const cfg = await runWithGrokbotAuthSourceAsync(authSource(agentDir), () => loadGrokbotConfig("<authenticated>"));
		expect(cfg.renewal).toBe("file-renewal");
	});

	test("file-backed cache ids expand the authenticated sentinel to the renewer", async () => {
		const agentDirA = await fs.mkdtemp(path.join(os.tmpdir(), "omp-grokbot-cache-a-"));
		const agentDirB = await fs.mkdtemp(path.join(os.tmpdir(), "omp-grokbot-cache-b-"));
		dirs.push(agentDirA, agentDirB);
		await fs.mkdir(path.join(agentDirA, "secrets"), { recursive: true });
		await fs.mkdir(path.join(agentDirB, "secrets"), { recursive: true });
		await Bun.write(
			secretsPathFor(agentDirA),
			["GROKBOT_RENEWAL_CREDENTIAL=file-renewal-a", "GROKBOT_MACHINE_ID=machine-a"].join("\n"),
		);
		await Bun.write(
			secretsPathFor(agentDirB),
			["GROKBOT_RENEWAL_CREDENTIAL=file-renewal-b", "GROKBOT_MACHINE_ID=machine-b"].join("\n"),
		);

		const cacheA = runWithGrokbotAuthSource(authSource(agentDirA), () => {
			expect(resolveGrokbotEnvApiKey()).toBe(GROKBOT_AUTHENTICATED_SENTINEL);
			expect(resolveGrokbotCacheCredential(GROKBOT_AUTHENTICATED_SENTINEL)).toBe("file-renewal-a");
			return resolveModelCacheProviderId("grokbot", {
				apiKey: GROKBOT_AUTHENTICATED_SENTINEL,
				baseUrl: "https://api2.cursor.sh",
				namespace: "prod",
				clientVersion: "0.30.0",
			});
		});
		const cacheB = runWithGrokbotAuthSource(authSource(agentDirB), () => {
			expect(resolveGrokbotCacheCredential(GROKBOT_AUTHENTICATED_SENTINEL)).toBe("file-renewal-b");
			return resolveModelCacheProviderId("grokbot", {
				apiKey: GROKBOT_AUTHENTICATED_SENTINEL,
				baseUrl: "https://api2.cursor.sh",
				namespace: "prod",
				clientVersion: "0.30.0",
			});
		});
		expect(cacheA).not.toBe(cacheB);

		await runWithGrokbotAuthSourceAsync(authSource(agentDirA), async () => {
			// Explicit renewer still matches the expanded sentinel for the same account.
			expect(
				resolveModelCacheProviderId("grokbot", {
					apiKey: "file-renewal-a",
					baseUrl: "https://api2.cursor.sh",
					namespace: "prod",
					clientVersion: "0.30.0",
				}),
			).toBe(cacheA);
			// Precomputed cacheCredential matches the expanded sentinel and skips
			// a second secrets-file read (catalog refresh passes this after async prep).
			expect(await resolveGrokbotCacheCredentialAsync(GROKBOT_AUTHENTICATED_SENTINEL)).toBe("file-renewal-a");
			expect(
				resolveModelCacheProviderId("grokbot", {
					apiKey: GROKBOT_AUTHENTICATED_SENTINEL,
					cacheCredential: "file-renewal-a",
					baseUrl: "https://api2.cursor.sh",
					namespace: "prod",
					clientVersion: "0.30.0",
				}),
			).toBe(cacheA);
			expect(
				grokbotModelManagerOptions({
					apiKey: GROKBOT_AUTHENTICATED_SENTINEL,
					namespace: "prod",
					clientVersion: "0.30.0",
					cacheCredential: "file-renewal-a",
				}).cacheProviderId,
			).toBe(cacheA);
		});
	});

	test("sentinel discovery uses captured cacheCredential, not a later secrets file", async () => {
		const agentDirA = await fs.mkdtemp(path.join(os.tmpdir(), "omp-grokbot-disc-a-"));
		const agentDirB = await fs.mkdtemp(path.join(os.tmpdir(), "omp-grokbot-disc-b-"));
		dirs.push(agentDirA, agentDirB);
		await fs.mkdir(path.join(agentDirA, "secrets"), { recursive: true });
		await fs.mkdir(path.join(agentDirB, "secrets"), { recursive: true });
		await Bun.write(
			secretsPathFor(agentDirA),
			["GROKBOT_RENEWAL_CREDENTIAL=file-renewal-a", "GROKBOT_MACHINE_ID=machine-a"].join("\n"),
		);
		await Bun.write(
			secretsPathFor(agentDirB),
			["GROKBOT_RENEWAL_CREDENTIAL=file-renewal-b", "GROKBOT_MACHINE_ID=machine-b"].join("\n"),
		);

		const seenRenewals: string[] = [];
		const fetchImpl = Object.assign(
			async (url: string | URL | Request, init?: RequestInit) => {
				if (String(url).includes("inference-credential")) {
					const body = typeof init?.body === "string" ? init.body : "";
					seenRenewals.push(body);
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

		const manager = grokbotModelManagerOptions({
			apiKey: GROKBOT_AUTHENTICATED_SENTINEL,
			namespace: "prod",
			clientVersion: "0.30.0",
			cacheCredential: "file-renewal-a",
			fetch: fetchImpl,
		});
		// Ambient secrets now point at account B — discovery must still mint with A.
		await runWithGrokbotAuthSourceAsync(authSource(agentDirB), async () => {
			expect(await manager.fetchDynamicModels?.()).not.toBeNull();
		});
		expect(seenRenewals.length).toBeGreaterThanOrEqual(1);
		expect(seenRenewals.every(body => body.includes("file-renewal-a"))).toBe(true);
		expect(seenRenewals.some(body => body.includes("file-renewal-b"))).toBe(false);
	});
});

describe("grokbot backend URL join", () => {
	afterEach(() => {
		clearGrokbotTokenCache();
	});

	test("refreshes a cached pair when the inference JWT expires before the metadata JWT", async () => {
		const cfg = {
			renewal: "early-inference-expiry",
			machineId: "machine",
			namespace: "prod",
			clientVersion: "0.44.0",
		};
		const jwt = (expires: number) =>
			`header.${Buffer.from(JSON.stringify({ exp: expires })).toString("base64url")}.signature`;
		let mints = 0;
		const fetchImpl = async () => {
			mints++;
			return Response.json({
				accessToken: `metadata-${mints}`,
				grokBotToken: jwt(Math.floor(Date.now() / 1000) + (mints === 1 ? 30 : 600)),
				expiresAtMs: Date.now() + 600_000,
			});
		};
		await mintGrokbotAccessToken(cfg, fetchImpl);
		await mintGrokbotAccessToken(cfg, fetchImpl, undefined, undefined, undefined, "inference");
		expect(mints).toBe(2);
		expect(await mintGrokbotAccessToken(cfg, fetchImpl)).toBe("metadata-2");
		expect(mints).toBe(2);
	});

	test("preserves reverse-proxy path prefixes for renewal", () => {
		expect(joinGrokbotBackendUrl("https://proxy.example/grokbot", GROKBOT_RENEWAL_PATH).href).toBe(
			"https://proxy.example/grokbot/sand-box/inference-credential",
		);
		expect(joinGrokbotBackendUrl("https://api2.cursor.sh/", GROKBOT_RENEWAL_PATH).href).toBe(
			"https://api2.cursor.sh/sand-box/inference-credential",
		);
	});

	test("appends onto pathname while preserving query strings", () => {
		// Raw `${base}${path}` would yield `?api_key=secret/sand-box/...` and miss the endpoint.
		expect(joinGrokbotBackendUrl("https://proxy.example/grokbot?api_key=secret", GROKBOT_RENEWAL_PATH).href).toBe(
			"https://proxy.example/grokbot/sand-box/inference-credential?api_key=secret",
		);
		expect(
			joinGrokbotBackendUrl("https://proxy.example/grokbot?api_key=secret", "/aiserver.v1.AiService/AvailableModels")
				.href,
		).toBe("https://proxy.example/grokbot/aiserver.v1.AiService/AvailableModels?api_key=secret");
	});

	test("preserves trailing slash inside query values", () => {
		// Pre-parse `.replace(/\/+$/, "")` on the whole URL would strip `signed-value/`.
		expect(
			joinGrokbotBackendUrl("https://proxy.example/grokbot?token=signed-value/", GROKBOT_RENEWAL_PATH).href,
		).toBe("https://proxy.example/grokbot/sand-box/inference-credential?token=signed-value/");
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
	afterEach(() => {
		clearGrokbotTokenCache();
	});

	test("forwards configured headers on mint and AvailableModels", async () => {
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
		const models = await runWithGrokbotAuthSourceAsync(
			{
				env: {
					...CLEAR_GROKBOT_ENV,
					GROKBOT_MACHINE_ID: "machine",
					GROKBOT_NAMESPACE: "prod",
					GROKBOT_CLIENT_VERSION: "0.30.0",
				},
			},
			() =>
				fetchGrokbotAvailableModels({
					apiKey: "renewer",
					baseUrl: "https://proxy.example/grokbot",
					fetch: fetchImpl,
					headers: { "x-proxy-api-key": "proxy-secret" },
				}),
		);
		expect(models).not.toBeNull();
		expect(seen.length).toBe(2);
		expect(seen.every(s => s.headers["x-proxy-api-key"] === "proxy-secret")).toBe(true);
		expect(seen[1]?.url).toContain("/aiserver.v1.AiService/AvailableModels");
		expect(seen[1]?.headers["connect-protocol-version"]).toBe("1");
	});

	test("namespace-only AvailableModels override recomputes client version", async () => {
		// Direct callers may pass namespace: "lab" without clientVersion — identity
		// must recompute 0.30.0-lab rather than keep the ambient production version.
		const seen: Array<Record<string, string>> = [];
		const syncIdentitySpy = spyOn(grokbotAuth, "resolveGrokbotDiscoveryIdentity");
		const fetchImpl = Object.assign(
			async (url: string | URL | Request, init?: RequestInit) => {
				seen.push((init?.headers ?? {}) as Record<string, string>);
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
		try {
			const models = await runWithGrokbotAuthSourceAsync(
				{
					secretsPath: path.join(os.tmpdir(), crypto.randomUUID(), "grokbot.env"),
					env: {
						...CLEAR_GROKBOT_ENV,
						GROKBOT_MACHINE_ID: "machine",
						// Ambient production namespace with no explicit clientVersion so
						// loadGrokbotConfig derives 0.30.0 — the namespace-only override
						// must recompute 0.30.0-lab rather than keep that derived value.
						GROKBOT_NAMESPACE: "prod",
					},
				},
				() =>
					fetchGrokbotAvailableModels({
						apiKey: "renewer",
						baseUrl: "https://api2.cursor.sh",
						fetch: fetchImpl,
						namespace: "lab",
					}),
			);
			expect(models).not.toBeNull();
			// AvailableModels is the second call (after mint); both carry identity.
			const modelsHeaders = seen[1] ?? seen[0];
			expect(modelsHeaders?.["x-sand-box-namespace"]).toBe("lab");
			expect(modelsHeaders?.["x-cursor-client-version"]).toBe("0.30.0-lab");
			// Derive overrides from the async-loaded config — no sync identity helper.
			expect(syncIdentitySpy).not.toHaveBeenCalled();
		} finally {
			syncIdentitySpy.mockRestore();
		}
	});

	test("AvailableModels preserves trailing slash inside proxy query values", async () => {
		// Callers must not pre-strip `/` from the whole base URL — that would
		// invalidate `?token=signed-value/` before joinGrokbotBackendUrl parses.
		const seen: string[] = [];
		const fetchImpl = Object.assign(
			async (url: string | URL | Request) => {
				seen.push(String(url));
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
		await runWithGrokbotAuthSourceAsync(
			{
				env: {
					...CLEAR_GROKBOT_ENV,
					GROKBOT_MACHINE_ID: "machine",
					GROKBOT_NAMESPACE: "prod",
					GROKBOT_CLIENT_VERSION: "0.30.0",
				},
			},
			() =>
				fetchGrokbotAvailableModels({
					apiKey: "renewer",
					baseUrl: "https://proxy.example/grokbot?token=signed-value/",
					fetch: fetchImpl,
				}),
		);
		expect(seen).toEqual([
			"https://proxy.example/grokbot/sand-box/inference-credential?token=signed-value/",
			"https://proxy.example/grokbot/aiserver.v1.AiService/AvailableModels?token=signed-value/",
		]);
	});

	test("remints once and retries AvailableModels after a cached JWT is rejected", async () => {
		let mintCount = 0;
		let availableModelsCalls = 0;
		const fetchImpl = Object.assign(
			async (url: string | URL | Request) => {
				if (String(url).includes("inference-credential")) {
					mintCount += 1;
					return new Response(
						JSON.stringify({ accessToken: `tok-${mintCount}`, expiresAtMs: Date.now() + 600_000 }),
						{ status: 200, headers: { "content-type": "application/json" } },
					);
				}
				availableModelsCalls += 1;
				if (availableModelsCalls === 1) {
					return new Response("Unauthorized", { status: 401 });
				}
				return new Response(JSON.stringify({ models: [] }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			},
			{ preconnect: fetch.preconnect },
		) as typeof fetch;
		const models = await runWithGrokbotAuthSourceAsync(
			{
				env: {
					...CLEAR_GROKBOT_ENV,
					GROKBOT_MACHINE_ID: "machine",
					GROKBOT_NAMESPACE: "prod",
					GROKBOT_CLIENT_VERSION: "0.30.0",
				},
			},
			() =>
				fetchGrokbotAvailableModels({
					apiKey: "renewer",
					baseUrl: "https://proxy.example/grokbot",
					fetch: fetchImpl,
				}),
		);
		// One discovery call remints and replays instead of failing until a later refresh.
		expect(models).not.toBeNull();
		expect(availableModelsCalls).toBe(2);
		expect(mintCount).toBe(2);
	});

	test("gives up after a second AvailableModels 401", async () => {
		let mintCount = 0;
		let availableModelsCalls = 0;
		const fetchImpl = Object.assign(
			async (url: string | URL | Request) => {
				if (String(url).includes("inference-credential")) {
					mintCount += 1;
					return new Response(
						JSON.stringify({ accessToken: `tok-${mintCount}`, expiresAtMs: Date.now() + 600_000 }),
						{ status: 200, headers: { "content-type": "application/json" } },
					);
				}
				availableModelsCalls += 1;
				return new Response("Unauthorized", { status: 401 });
			},
			{ preconnect: fetch.preconnect },
		) as typeof fetch;
		const models = await runWithGrokbotAuthSourceAsync(
			{
				env: {
					...CLEAR_GROKBOT_ENV,
					GROKBOT_MACHINE_ID: "machine",
					GROKBOT_NAMESPACE: "prod",
					GROKBOT_CLIENT_VERSION: "0.30.0",
				},
			},
			() =>
				fetchGrokbotAvailableModels({
					apiKey: "renewer",
					baseUrl: "https://proxy.example/grokbot",
					fetch: fetchImpl,
				}),
		);
		expect(models).toBeNull();
		expect(availableModelsCalls).toBe(2);
		expect(mintCount).toBe(2);
	});
});
