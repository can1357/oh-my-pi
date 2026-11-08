import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { streamSimple } from "@oh-my-pi/pi-ai";
import { type ApiKeyResolution, resolveApiKeyOnce, seedApiKeyResolver } from "@oh-my-pi/pi-ai/auth-retry";
import type { Api, AssistantMessage, Context, FetchImpl, Model } from "@oh-my-pi/pi-ai/types";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import {
	clearConfigValueCache,
	remintCommandConfig,
	resolveConfigValue,
} from "@oh-my-pi/pi-coding-agent/config/resolve-config-value";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { authService } from "@oh-my-pi/pi-coding-agent/thread/services/auth";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";
import type { RemintProbe } from "./fixtures/credential-remint-worker";
import { startServiceWorker } from "./helpers/service-worker";

/**
 * A `!command` credential the provider refuses.
 *
 * The body is Theorem's model gateway's own, measured 2026-11-08 with a junk
 * identity token: a LiteLLM proxy answers every route with
 * `{"error":{"message":…,"type":"auth_error","param":"Authorization","code":"401"}}`.
 *
 * What these tests hold, each with the mutation that reds it:
 * - the refusal re-mints the credential and the request is retried once
 *   (mutation: make `credentialRejectionVerdict` return `"status"`, or drop
 *   the `invalidateCommandConfig` call in `remintCommandConfig`);
 * - requests sharing one credential, refused together, cost ONE execution of
 *   the mint (mutation: do not join the in-flight re-mint);
 * - a provider that refuses forever stops at two requests and one re-mint
 *   (mutation: drop the `state.refreshedCurrent` guard in
 *   `resolveNextAuthRetryKey`);
 * - a failed shared re-mint is decisive for every waiter and does not latch
 *   (mutation: keep the settled promise in `commandRemintInFlight`).
 */
const GATEWAY_401_BODY = JSON.stringify({
	error: {
		message: "This identity token is not one this gateway accepts.",
		type: "auth_error",
		param: "Authorization",
		code: "401",
	},
});

function gatewayRefusal(): Response {
	return new Response(GATEWAY_401_BODY, { status: 401, headers: { "Content-Type": "application/json" } });
}

function okStream(): Response {
	const chunks = [
		JSON.stringify({
			id: "cmpl",
			object: "chat.completion.chunk",
			choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }],
		}),
		JSON.stringify({
			id: "cmpl",
			object: "chat.completion.chunk",
			choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
		}),
		"[DONE]",
	];
	return new Response(chunks.map(chunk => `data: ${chunk}\n\n`).join(""), {
		status: 200,
		headers: { "Content-Type": "text/event-stream" },
	});
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Mint that records one invocation and prints the token file's current contents. */
function mintFromFile(counterFile: string, tokenFile: string, delaySeconds = 0): string {
	const delay = delaySeconds > 0 ? `sleep ${delaySeconds}; ` : "";
	return `!printf 1 >> ${shellQuote(counterFile)}; ${delay}IFS= read -r t < ${shellQuote(tokenFile)}; [ "$t" = FAIL ] && exit 1; printf %s "$t"`;
}

/** Mint that records one invocation and prints a value no earlier run produced. */
function mintFresh(counterFile: string): string {
	return `!printf 1 >> ${shellQuote(counterFile)}; printf 'tok-%s' "$(date +%s%N)"`;
}

const CONTEXT: Context = { systemPrompt: ["s"], messages: [{ role: "user", content: "hi", timestamp: 0 }] };

/**
 * A JWT with the given `exp`, a junk payload and no real signature. Only the
 * `exp` claim is read, and only to decide whether to mint again.
 */
function junkJwt(expSeconds: number): string {
	const part = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");
	return `${part({ alg: "RS256", typ: "JWT" })}.${part({ sub: "junk", exp: expSeconds })}.${part("junk")}`;
}

interface Rig {
	registry: ModelRegistry;
	model: Model<Api>;
	/** Bearer of every request the provider saw, in arrival order. */
	seen: string[];
	/** How many times the mint ran. */
	mints: () => number;
	/** Resolve and seed a turn the way `agent-loop` does, without sending it. */
	prepare: () => Promise<() => Promise<AssistantMessage>>;
	/** One turn, resolved and seeded the way `agent-loop` does. */
	turn: () => Promise<AssistantMessage>;
}

describe("a `!command` credential the provider refuses", () => {
	let tempDir = "";
	let authStorage: AuthStorage;

	beforeEach(async () => {
		clearConfigValueCache();
		tempDir = path.join(os.tmpdir(), `pi-test-remint-401-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		authStorage = await AuthStorage.create(":memory:");
	});

	afterEach(() => {
		clearConfigValueCache();
		authStorage.close();
		if (!tempDir || !fs.existsSync(tempDir)) return;
		try {
			removeSyncWithRetries(tempDir);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EBUSY") throw error;
		}
	});

	function buildRig(
		apiKeyConfig: string,
		counterFile: string,
		accept: (bearer: string | undefined) => boolean,
		extraProviderConfig: Record<string, unknown> = {},
	): Rig {
		const modelsPath = path.join(tempDir, "models.json");
		fs.writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					"probe-gw": {
						baseUrl: "https://gateway.invalid/v1",
						api: "openai-completions",
						apiKey: apiKeyConfig,
						...extraProviderConfig,
						models: [{ id: "gw-model", name: "GW Model" }],
					},
				},
			}),
		);
		const registry = new ModelRegistry(authStorage, modelsPath);
		const model = registry.find("probe-gw", "gw-model");
		if (!model) throw new Error("probe model missing");

		const seen: string[] = [];
		const fetchImpl: FetchImpl = async (_url, init) => {
			const headers = (init?.headers ?? {}) as Record<string, string>;
			const auth = headers.Authorization;
			const bearer = auth?.startsWith("Bearer ") ? auth.slice(7) : auth;
			seen.push(bearer ?? "<none>");
			return accept(bearer) ? okStream() : gatewayRefusal();
		};

		/** Resolve and seed a turn now; the returned function sends it. */
		const prepare = async (): Promise<() => Promise<AssistantMessage>> => {
			const resolver = registry.resolver(model);
			let seeded: ApiKeyResolution;
			const first = await resolveApiKeyOnce(resolver, undefined, resolved => {
				seeded = resolved;
			});
			return async () => {
				const handle = streamSimple(model, CONTEXT, {
					apiKey: seedApiKeyResolver(seeded ?? first, resolver),
					fetch: fetchImpl,
					maxTokens: 16,
				});
				for await (const _event of handle) {
					// drain
				}
				return await handle.result();
			};
		};
		const turn = async (): Promise<AssistantMessage> => (await prepare())();

		return {
			registry,
			model,
			seen,
			mints: () => fs.readFileSync(counterFile, "utf8").length,
			prepare,
			turn,
		};
	}

	test("is re-minted and the request retried once", async () => {
		const counterFile = path.join(tempDir, "mints");
		const tokenFile = path.join(tempDir, "token");
		fs.writeFileSync(counterFile, "");
		fs.writeFileSync(tokenFile, "expired-token");
		const rig = buildRig(mintFromFile(counterFile, tokenFile), counterFile, bearer => bearer !== "expired-token");

		// First use of the provider mints and caches the credential.
		expect(await rig.registry.getApiKey(rig.model)).toBe("expired-token");
		// It lapses; the issuer would now hand out a live one.
		fs.writeFileSync(tokenFile, "renewed-token");

		const result = await rig.turn();

		expect(result.stopReason).not.toBe("error");
		expect(rig.seen).toEqual(["expired-token", "renewed-token"]);
		expect(rig.mints()).toBe(2);
	});

	test("is retried once even when the mint hands back the same bytes", async () => {
		const counterFile = path.join(tempDir, "mints");
		const tokenFile = path.join(tempDir, "token");
		fs.writeFileSync(counterFile, "");
		fs.writeFileSync(tokenFile, "unchanging-token");
		// The provider refuses every request, so the retry is observable as a
		// second request carrying the same bearer rather than as a recovery.
		const rig = buildRig(mintFromFile(counterFile, tokenFile), counterFile, () => false);

		const result = await rig.turn();

		expect(result.errorStatus).toBe(401);
		// Two requests: the original, and one with the credential minted after
		// the refusal — which happens to be byte-identical. Before the refusal
		// signal existed the bearer-identity check dropped this retry, so the
		// mint was spent and nothing was sent with it.
		expect(rig.seen).toEqual(["unchanging-token", "unchanging-token"]);
		expect(rig.mints()).toBe(2);
	});

	test("stops at two requests and one re-mint against a provider that refuses forever", async () => {
		const counterFile = path.join(tempDir, "mints");
		fs.writeFileSync(counterFile, "");
		// A fresh bearer every run: nothing in the bearer dedupe can stop a
		// runaway loop, so only the single-retry bound can.
		const rig = buildRig(mintFresh(counterFile), counterFile, () => false);

		const result = await rig.turn();

		expect(result.errorStatus).toBe(401);
		expect(rig.seen.length).toBe(2);
		expect(new Set(rig.seen).size).toBe(2);
		// One mint for the initial resolve, one for the single re-mint.
		expect(rig.mints()).toBe(2);
	});

	test("costs one execution of the mint when concurrent requests are refused together", async () => {
		const counterFile = path.join(tempDir, "mints");
		const tokenFile = path.join(tempDir, "token");
		fs.writeFileSync(counterFile, "");
		fs.writeFileSync(tokenFile, "expired-token");
		// The mint is slow enough that every refusal lands while it runs: the
		// case a thundering re-mint would show up in.
		const rig = buildRig(
			mintFromFile(counterFile, tokenFile, 0.3),
			counterFile,
			bearer => bearer !== "expired-token",
		);

		await rig.registry.getApiKey(rig.model);
		const mintsBefore = rig.mints();
		fs.writeFileSync(tokenFile, "renewed-token");

		const results = await Promise.all(Array.from({ length: 10 }, () => rig.turn()));

		expect(results.filter(result => result.stopReason === "error")).toEqual([]);
		// Ten refusals, ten retries, and exactly one run of the mint. Each run
		// of a real mint is a call to the credential's issuer.
		expect(rig.seen.length).toBe(20);
		expect(rig.mints() - mintsBefore).toBe(1);
	});

	test("gives every waiter a decisive answer when the shared re-mint fails", async () => {
		const counterFile = path.join(tempDir, "mints");
		const tokenFile = path.join(tempDir, "token");
		fs.writeFileSync(counterFile, "");
		fs.writeFileSync(tokenFile, "expired-token");
		const rig = buildRig(
			mintFromFile(counterFile, tokenFile, 0.3),
			counterFile,
			bearer => bearer === "renewed-token",
		);

		await rig.registry.getApiKey(rig.model);
		const mintsBeforeFailure = rig.mints();
		// The issuer is down: the mint exits non-zero.
		fs.writeFileSync(tokenFile, "FAIL");

		const failed = await Promise.all(Array.from({ length: 5 }, () => rig.turn()));

		// Every waiter settles on the provider's refusal rather than waiting on
		// a re-mint that will never produce a credential.
		expect(failed.map(result => result.errorStatus)).toEqual([401, 401, 401, 401, 401]);
		expect(rig.mints() - mintsBeforeFailure).toBe(1);
	});

	test("lets the next refusal start a fresh re-mint rather than join the dead one", async () => {
		const counterFile = path.join(tempDir, "mints");
		const tokenFile = path.join(tempDir, "token");
		fs.writeFileSync(counterFile, "");
		fs.writeFileSync(tokenFile, "FAIL");
		const config = mintFromFile(counterFile, tokenFile);

		// A refusal whose re-mint fails: the waiter gets `undefined`, decisively.
		expect(await remintCommandConfig(config)).toBeUndefined();
		expect(fs.readFileSync(counterFile, "utf8").length).toBe(1);

		fs.writeFileSync(tokenFile, "renewed-token");
		// An ordinary resolve is still parked by the failed command's backoff
		// window — which is what it is for.
		expect(await resolveConfigValue(config)).toBeUndefined();
		expect(fs.readFileSync(counterFile, "utf8").length).toBe(1);

		// The next refusal is not: it runs the mint again instead of joining a
		// promise that has already settled, and it clears that backoff.
		expect(await remintCommandConfig(config)).toBe("renewed-token");
		expect(fs.readFileSync(counterFile, "utf8").length).toBe(2);
		expect(await resolveConfigValue(config)).toBe("renewed-token");
	});

	test("is not re-minted when the 401's own error class says it is not an auth failure", async () => {
		const counterFile = path.join(tempDir, "mints");
		const tokenFile = path.join(tempDir, "token");
		fs.writeFileSync(counterFile, "");
		fs.writeFileSync(tokenFile, "live-token");
		const modelsPath = path.join(tempDir, "models.json");
		fs.writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					"probe-gw": {
						baseUrl: "https://gateway.invalid/v1",
						api: "openai-completions",
						apiKey: mintFromFile(counterFile, tokenFile),
						models: [{ id: "gw-model", name: "GW Model" }],
					},
				},
			}),
		);
		const registry = new ModelRegistry(authStorage, modelsPath);
		const model = registry.find("probe-gw", "gw-model");
		if (!model) throw new Error("probe model missing");

		const seen: string[] = [];
		const policyBody = JSON.stringify({
			error: { message: "request blocked by policy", type: "invalid_request_error", code: "policy_blocked" },
		});
		const fetchImpl: FetchImpl = async (_url, init) => {
			const headers = (init?.headers ?? {}) as Record<string, string>;
			seen.push(headers.Authorization ?? "<none>");
			return new Response(policyBody, { status: 401, headers: { "Content-Type": "application/json" } });
		};

		const handle = streamSimple(model, CONTEXT, {
			apiKey: registry.resolver(model),
			fetch: fetchImpl,
			maxTokens: 16,
		});
		for await (const _event of handle) {
			// drain
		}
		const result = await handle.result();

		expect(result.errorStatus).toBe(401);
		// One mint for the initial resolve and no re-mint: the provider's own
		// class says the credential is not what it refused.
		expect(fs.readFileSync(counterFile, "utf8").length).toBe(1);
		expect(seen.length).toBe(1);
	});

	test("does not run another model's credential helper", async () => {
		const counterFile = path.join(tempDir, "mints");
		const tokenFile = path.join(tempDir, "token");
		const otherCounter = path.join(tempDir, "other-mints");
		const otherToken = path.join(tempDir, "other-token");
		fs.writeFileSync(counterFile, "");
		fs.writeFileSync(tokenFile, "expired-token");
		fs.writeFileSync(otherCounter, "");
		fs.writeFileSync(otherToken, "other-header");
		const modelsPath = path.join(tempDir, "models.json");
		fs.writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					"probe-gw": {
						baseUrl: "https://gateway.invalid/v1",
						api: "openai-completions",
						apiKey: mintFromFile(counterFile, tokenFile),
						models: [
							{ id: "gw-model", name: "GW Model" },
							// Never selected, and its header command must stay unrun:
							// a real one is another call to another issuer, and the
							// refused model's recovery would wait for it.
							{
								id: "other-model",
								name: "Other Model",
								headers: { "x-other": mintFromFile(otherCounter, otherToken) },
							},
						],
					},
				},
			}),
		);
		const registry = new ModelRegistry(authStorage, modelsPath);
		const model = registry.find("probe-gw", "gw-model");
		if (!model) throw new Error("probe model missing");

		const seen: string[] = [];
		const fetchImpl: FetchImpl = async (_url, init) => {
			const headers = (init?.headers ?? {}) as Record<string, string>;
			const auth = headers.Authorization;
			const bearer = auth?.startsWith("Bearer ") ? auth.slice(7) : auth;
			seen.push(bearer ?? "<none>");
			return bearer === "expired-token" ? gatewayRefusal() : okStream();
		};

		await registry.getApiKey(model);
		fs.writeFileSync(tokenFile, "renewed-token");
		const resolver = registry.resolver(model);
		let seeded: ApiKeyResolution;
		const first = await resolveApiKeyOnce(resolver, undefined, resolved => {
			seeded = resolved;
		});
		const handle = streamSimple(model, CONTEXT, {
			apiKey: seedApiKeyResolver(seeded ?? first, resolver),
			fetch: fetchImpl,
			maxTokens: 16,
		});
		for await (const _event of handle) {
			// drain
		}
		const result = await handle.result();

		expect(result.stopReason).not.toBe("error");
		expect(seen).toEqual(["expired-token", "renewed-token"]);
		expect(fs.readFileSync(otherCounter, "utf8").length).toBe(0);
	});

	test("re-mints once for refusals that straddle the mint's own settlement", async () => {
		const counterFile = path.join(tempDir, "mints");
		const tokenFile = path.join(tempDir, "token");
		fs.writeFileSync(counterFile, "");
		fs.writeFileSync(tokenFile, "expired-token");
		const rig = buildRig(mintFromFile(counterFile, tokenFile), counterFile, bearer => bearer !== "expired-token");

		await rig.registry.getApiKey(rig.model);
		const mintsBefore = rig.mints();
		fs.writeFileSync(tokenFile, "renewed-token");

		// Every turn is resolved while the credential is still the stale one,
		// so all five carry it — the wave that was already on the wire when the
		// provider started refusing. They are then sent one at a time, so each
		// refusal lands after the previous turn's re-mint has already settled.
		// Joining an in-flight run cannot help here: there is none left to join.
		const sends = await Promise.all(Array.from({ length: 5 }, () => rig.prepare()));
		for (const send of sends) {
			const result = await send();
			expect(result.stopReason).not.toBe("error");
		}

		// Two requests each: the stale credential, then the retry.
		expect(rig.seen.length).toBe(10);
		// One mint for the whole wave: the four later refusals name a
		// credential the cache no longer holds, so the mint already made
		// answers them.
		expect(rig.mints() - mintsBefore).toBe(1);
	});

	test("re-mints again when the refusal names the credential the cache holds", async () => {
		const counterFile = path.join(tempDir, "mints");
		fs.writeFileSync(counterFile, "");
		// A distinct bearer per run, so a reused mint is visible as a repeat of
		// the bearer the provider has already refused rather than as a count.
		const rig = buildRig(mintFresh(counterFile), counterFile, () => false);

		const first = await rig.registry.getApiKey(rig.model);
		const mintsBefore = rig.mints();
		const result = await rig.turn();

		expect(result.errorStatus).toBe(401);
		// The refusal names the cached credential, because the request that
		// earned it is the one that read the cache. Reusing it would retry with
		// bytes the provider has already answered; the issuer is asked instead.
		expect(rig.seen).toEqual([first, expect.not.stringMatching(`^${first}$`)]);
		expect(rig.mints() - mintsBefore).toBe(1);
	});

	test("re-mints rather than reuse a cached credential past its own exp", async () => {
		const counterFile = path.join(tempDir, "mints");
		const tokenFile = path.join(tempDir, "token");
		fs.writeFileSync(counterFile, "");
		// A JWT whose `exp` is in the past, with a junk signature: only the
		// claim is read, and only to decide whether to mint again.
		fs.writeFileSync(tokenFile, junkJwt(Math.floor(Date.now() / 1000) - 60));
		const rig = buildRig(mintFromFile(counterFile, tokenFile), counterFile, () => false);

		const cached = await rig.registry.getApiKey(rig.model);
		const mintsBefore = rig.mints();
		// A refusal of some other bearer: the cached credential is not the one
		// it names, so only its own `exp` stands between it and reuse.
		expect(await remintCommandConfig(mintFromFile(counterFile, tokenFile), "a-bearer-nobody-cached")).toBe(cached);
		expect(rig.mints() - mintsBefore).toBe(1);
	});

	test("costs one mint when the same command is spelled two ways", async () => {
		const counterFile = path.join(tempDir, "mints");
		const tokenFile = path.join(tempDir, "token");
		fs.writeFileSync(counterFile, "");
		fs.writeFileSync(tokenFile, "expired-token");
		const apiKeyConfig = mintFromFile(counterFile, tokenFile, 0.3);
		// The same command as the apiKey, spelled with a space after the `!`.
		// Configuration allows both, and they share one cached result and one
		// re-mint — so invalidating this one must not drop the apiKey's.
		const headerConfig = `! ${apiKeyConfig.slice(1)}`;
		const rig = buildRig(apiKeyConfig, counterFile, bearer => bearer !== "expired-token", {
			headers: { "x-alias": headerConfig },
		});

		await rig.registry.getApiKey(rig.model);
		const mintsBefore = rig.mints();
		fs.writeFileSync(tokenFile, "renewed-token");

		const results = await Promise.all(Array.from({ length: 10 }, () => rig.turn()));

		expect(results.filter(result => result.stopReason === "error")).toEqual([]);
		expect(rig.seen.length).toBe(20);
		expect(rig.mints() - mintsBefore).toBe(1);
	});

	test("does not run the configured mint when a runtime key owns the provider", async () => {
		const counterFile = path.join(tempDir, "mints");
		const tokenFile = path.join(tempDir, "token");
		fs.writeFileSync(counterFile, "");
		// The helper would hang for its full 10s process bound if it ran. The
		// turn must not wait for a credential the cascade never selected.
		fs.writeFileSync(tokenFile, "unused");
		const hangingMint = `!printf 1 >> ${shellQuote(counterFile)}; exec sleep 60`;
		const rig = buildRig(hangingMint, counterFile, () => false);
		// `--api-key` / `AuthStorage.keys.setRuntime`: the top of the cascade.
		authStorage.keys.setRuntime("probe-gw", "runtime-key");

		const started = performance.now();
		const result = await rig.turn();
		const elapsedMs = performance.now() - started;

		expect(result.errorStatus).toBe(401);
		// The retry resends the key the cascade selected, which a peer may have
		// rotated under it; what it must not do is call an issuer that owns
		// none of these bearers.
		expect(rig.seen).toEqual(["runtime-key", "runtime-key"]);
		// Zero executions of that command, and no wait on it either.
		expect(rig.mints()).toBe(0);
		expect(elapsedMs).toBeLessThan(5_000);
	});

	test("costs one re-mint when the refused request runs on a worker mirror", async () => {
		const counterFile = path.join(tempDir, "mints");
		const tokenFile = path.join(tempDir, "token");
		fs.writeFileSync(counterFile, "");
		fs.writeFileSync(tokenFile, "expired-token");
		const seen: string[] = [];
		// A real socket: the worker's own `fetch` makes the request, so the
		// refusal and the retry happen there while the credential the retry
		// reads is cached on main.
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: request => {
				const auth = request.headers.get("authorization") ?? "<none>";
				const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : auth;
				seen.push(bearer);
				return bearer === "expired-token" ? gatewayRefusal() : okStream();
			},
		});
		const modelsPath = path.join(tempDir, "models.json");
		fs.writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					"probe-gw": {
						baseUrl: `http://127.0.0.1:${server.port}/v1`,
						api: "openai-completions",
						apiKey: mintFromFile(counterFile, tokenFile),
						models: [{ id: "gw-model", name: "GW Model", compat: { supportsStore: false } }],
					},
				},
			}),
		);
		const registry = new ModelRegistry(authStorage, modelsPath, { cacheDbPath: path.join(tempDir, "models.db") });
		const worker = await startServiceWorker<RemintProbe>(
			new URL("./fixtures/credential-remint-worker.ts", import.meta.url),
			[authService],
		);
		try {
			await registry.getApiKeyForProvider("probe-gw");
			const mintsBefore = fs.readFileSync(counterFile, "utf8").length;
			fs.writeFileSync(tokenFile, "renewed-token");

			const result = await worker.probe.turn(registry, "probe-gw", "gw-model");

			expect(result.ok).toBe(true);
			expect(seen).toEqual(["expired-token", "renewed-token"]);
			// The owner mints once and the mirror awaits it. Minting locally as
			// well — the route before the owner served this request — costs a
			// second call to the issuer for one refusal.
			expect(fs.readFileSync(counterFile, "utf8").length - mintsBefore).toBe(1);
		} finally {
			await worker.stop();
			server.stop(true);
		}
	});
});
