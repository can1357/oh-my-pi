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
	createConfigHeaderResolver,
	invalidateCommandConfig,
	refuseCommandGeneration,
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
 * The fixture uses LiteLLM's `auth_error` / `401` envelope. Classification
 * provenance is documented in `credential-rejection.ts`.
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
		refuse: (bearer?: string) => Response | Promise<Response> = gatewayRefusal,
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
						models: [{ id: "gw-model", name: "GW Model" }],
						...extraProviderConfig,
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
			return accept(bearer) ? okStream() : refuse(bearer);
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

	test("a permission-only 403 does not prevent a valid prepared header request from sending", async () => {
		const counterFile = path.join(tempDir, "mints");
		const tokenFile = path.join(tempDir, "token");
		fs.writeFileSync(counterFile, "");
		fs.writeFileSync(tokenFile, "valid-junk");
		let permitted = false;
		const rig = buildRig(
			"literal-placeholder",
			counterFile,
			() => permitted,
			{ headers: { Authorization: mintFromFile(counterFile, tokenFile) } },
			() =>
				new Response(
					JSON.stringify({ error: { message: "This model is not permitted.", type: "auth_error", code: "403" } }),
					{ status: 403, headers: { "Content-Type": "application/json" } },
				),
		);
		const send = await rig.prepare();
		expect((await rig.turn()).errorStatus).toBe(403);
		permitted = true;
		const beforeRequests = rig.seen.length;
		expect((await send()).stopReason).not.toBe("error");
		expect(rig.seen.length - beforeRequests).toBe(1);
		expect(rig.mints()).toBe(1);
	});

	test.each(["apiKey", "header"] as const)(
		"a permission-only 403 leaves the %s refusal watermark unmoved",
		async source => {
			const counterFile = path.join(tempDir, "mints");
			const tokenFile = path.join(tempDir, "token");
			fs.writeFileSync(counterFile, "");
			fs.writeFileSync(tokenFile, "valid-junk");
			const command = mintFromFile(counterFile, tokenFile);
			const rig = buildRig(
				source === "apiKey" ? command : "literal-placeholder",
				counterFile,
				() => false,
				source === "header" ? { headers: { Authorization: command } } : {},
				() =>
					new Response(JSON.stringify({ error: { message: "Forbidden.", type: "auth_error", code: "403" } }), {
						status: 403,
						headers: { "Content-Type": "application/json" },
					}),
			);
			expect((await rig.turn()).errorStatus).toBe(403);
			const before = rig.mints();
			// An unchanged watermark leaves the accepted credential available without another mint.
			expect(await resolveConfigValue(command)).toBe("valid-junk");
			expect(rig.mints() - before).toBe(0);
		},
	);

	test("a token_not_found_in_db 401 shares a replacement and both prepared operations recover", async () => {
		const counterFile = path.join(tempDir, "mints");
		const tokenFile = path.join(tempDir, "token");
		fs.writeFileSync(counterFile, "");
		fs.writeFileSync(tokenFile, "junk-1");
		const rig = buildRig(
			mintFromFile(counterFile, tokenFile),
			counterFile,
			bearer => bearer === "junk-2",
			{},
			() =>
				new Response(
					JSON.stringify({
						error: { message: "Virtual key expected.", type: "token_not_found_in_db", code: "401" },
					}),
					{ status: 401, headers: { "Content-Type": "application/json" } },
				),
		);
		const sends = await Promise.all([rig.prepare(), rig.prepare()]);
		fs.writeFileSync(tokenFile, "junk-2");
		const before = rig.mints();
		const results = [];
		for (const send of sends) results.push(await send());
		expect(results.filter(result => result.stopReason !== "error").length).toBe(2);
		expect(rig.mints() - before).toBe(1);
		expect(rig.seen.map(value => Number(value.slice(5)))).toEqual([1, 2, 1, 2]);
	});

	test("an expired_token 403 condemns generation 2 before a straggler's genuine 401", async () => {
		const counterFile = path.join(tempDir, "mints");
		const tokenFile = path.join(tempDir, "token");
		fs.writeFileSync(counterFile, "");
		fs.writeFileSync(tokenFile, "junk-1");
		let expiry = false;
		const rig = buildRig(
			mintFromFile(counterFile, tokenFile),
			counterFile,
			bearer => bearer === "junk-3" || (bearer === "junk-2" && !expiry),
			{},
			bearer =>
				bearer === "junk-2"
					? new Response(
							JSON.stringify({
								error: { message: "Signature has expired", type: "auth_error", code: "expired_token" },
							}),
							{ status: 403, headers: { "Content-Type": "application/json" } },
						)
					: gatewayRefusal(),
		);
		const send = await rig.prepare();
		fs.writeFileSync(tokenFile, "junk-2");
		expect((await rig.turn()).stopReason).not.toBe("error");
		expiry = true;
		expect((await rig.turn()).errorStatus).toBe(403);
		fs.writeFileSync(tokenFile, "junk-3");
		const before = rig.mints();
		expect((await send()).stopReason).not.toBe("error");
		expect(rig.mints() - before).toBe(1);
		expect(rig.seen.map(value => Number(value.slice(5)))).toEqual([1, 2, 2, 1, 3]);
	});

	test("a refused prepared header obtains a missing replacement without dispatching the dead generation", async () => {
		const counterFile = path.join(tempDir, "mints");
		const tokenFile = path.join(tempDir, "token");
		fs.writeFileSync(counterFile, "");
		fs.writeFileSync(tokenFile, "junk-1");
		const command = mintFromFile(counterFile, tokenFile);
		const rig = buildRig("literal-placeholder", counterFile, bearer => bearer !== "junk-1", {
			headers: { Authorization: command },
		});
		const send = await rig.prepare();
		fs.writeFileSync(tokenFile, "junk-2");
		expect((await rig.turn()).stopReason).not.toBe("error");
		invalidateCommandConfig(command);
		fs.writeFileSync(tokenFile, "junk-3");
		const beforeRequests = rig.seen.length;
		const beforeMints = rig.mints();
		expect((await send()).stopReason).not.toBe("error");
		expect(rig.seen.length - beforeRequests).toBe(1);
		expect(rig.seen.slice(beforeRequests).map(value => Number(value.slice(5)))).toEqual([3]);
		expect(rig.mints() - beforeMints).toBe(1);
	});

	test.each(["initial", "retry"] as const)(
		"cancelling the %s prepared-header wait leaves the shared mint available to another operation",
		async phase => {
			const counterFile = path.join(tempDir, "mints");
			const tokenFile = path.join(tempDir, "token");
			const gateFile = path.join(tempDir, "mint-gate");
			fs.writeFileSync(counterFile, "");
			fs.writeFileSync(tokenFile, "prepared-junk");
			const command = `!printf 1 >> ${shellQuote(counterFile)}; while [ -f ${shellQuote(gateFile)} ]; do sleep 0.01; done; IFS= read -r value < ${shellQuote(tokenFile)}; printf %s "$value"`;
			const rig = buildRig("literal-placeholder", counterFile, () => false, {
				headers: { Authorization: command },
			});
			const resolver = rig.registry.resolver(rig.model);
			let prepared: ApiKeyResolution;
			await resolveApiKeyOnce(resolver, undefined, resolved => {
				prepared = resolved;
			});
			if (typeof prepared !== "object" || !prepared?.readHeaders) throw new Error("prepared headers missing");
			const readHeaders = prepared.readHeaders;
			const bothReading = Promise.withResolvers<void>();
			let reads = 0;
			const seed = {
				...prepared,
				readHeaders: () => {
					if (++reads === 2) bothReading.resolve();
					return readHeaders();
				},
			};
			for (const [config, generation] of Object.entries(prepared.headerGenerations ?? {})) {
				refuseCommandGeneration(config, generation);
			}
			invalidateCommandConfig(command);
			fs.writeFileSync(tokenFile, "replacement-junk");
			fs.writeFileSync(gateFile, "");
			const before = rig.mints();
			const started = Promise.withResolvers<void>();
			const watcher = fs.watch(counterFile, () => {
				if (rig.mints() > before) started.resolve();
			});
			let requests = 0;
			const fetchImpl: FetchImpl = async (_url, init) => {
				requests++;
				return new Headers(init?.headers).get("Authorization") === "replacement-junk"
					? okStream()
					: gatewayRefusal();
			};
			const send = async (signal?: AbortSignal): Promise<boolean> => {
				const handle = streamSimple({ ...rig.model, resolveHeaders: undefined }, CONTEXT, {
					apiKey:
						phase === "initial"
							? seedApiKeyResolver(seed, resolver)
							: ({ error }) => (error === undefined ? "initial-junk" : seed),
					fetch: fetchImpl,
					signal,
					maxTokens: 16,
				});
				try {
					for await (const _event of handle) {
						// drain
					}
					return (await handle.result()).stopReason !== "error";
				} catch {
					return false;
				}
			};
			const abort = new AbortController();
			const cancelled = send(abort.signal);
			let survivor: Promise<boolean> | undefined;
			try {
				await started.promise;
				survivor = send();
				await bothReading.promise;
				abort.abort();
				// This bounds real subprocess cancellation latency; fake timers cannot drive the shell issuer.
				const prompt = await Promise.race([cancelled.then(() => true), Bun.sleep(250).then(() => false)]);
				// The issuer remains blocked until after the cancellation observation.
				expect(prompt).toBe(true);
				expect(rig.mints() - before).toBe(1);
				fs.unlinkSync(gateFile);
				expect(await cancelled).toBe(false);
				expect(await survivor).toBe(true);
				expect(rig.mints() - before).toBe(1);
				expect(requests).toBe(phase === "initial" ? 1 : 3);
			} finally {
				watcher.close();
				fs.rmSync(gateFile, { force: true });
				await Promise.all([cancelled, survivor]);
			}
		},
	);

	test("a prepared header obtains a new mint when a refused generation has no replacement", async () => {
		const counterFile = path.join(tempDir, "mints");
		const tokenFile = path.join(tempDir, "token");
		fs.writeFileSync(counterFile, "");
		fs.writeFileSync(tokenFile, "prepared-junk");
		const command = mintFromFile(counterFile, tokenFile);
		let permitted = false;
		const rig = buildRig("literal-placeholder", counterFile, () => permitted, {
			headers: { Authorization: command },
		});
		const send = await rig.prepare();
		expect((await rig.turn()).errorStatus).toBe(401);
		invalidateCommandConfig(command);
		permitted = true;
		const beforeRequests = rig.seen.length;
		const beforeMints = rig.mints();
		expect((await send()).stopReason).not.toBe("error");
		expect(rig.seen.length - beforeRequests).toBe(1);
		expect(rig.mints() - beforeMints).toBe(1);
	});

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

	test.each(["provider", "model"])("shares one header mint per refusal wave (%s headers)", async scope => {
		const counterFile = path.join(tempDir, "mints");
		const tokenFile = path.join(tempDir, "token");
		fs.writeFileSync(counterFile, "");
		fs.writeFileSync(tokenFile, "expired-token");
		const headers = { Authorization: mintFromFile(counterFile, tokenFile) };
		const gates = Array.from({ length: 10 }, () => Promise.withResolvers<void>());
		gates[0].resolve();
		let refused = 0;
		let recovered = 0;
		const rig = buildRig(
			"literal-placeholder",
			counterFile,
			bearer => {
				if (bearer !== "renewed-token") return false;
				// Release the next refusal only after the preceding retry used its mint.
				gates[++recovered]?.resolve();
				return true;
			},
			scope === "provider" ? { headers } : { models: [{ id: "gw-model", name: "GW Model", headers }] },
			async () => {
				await gates[refused++].promise;
				return gatewayRefusal();
			},
		);
		await rig.model.resolveHeaders?.();
		const before = rig.mints();
		const sends = await Promise.all(Array.from({ length: 10 }, () => rig.prepare()));
		fs.writeFileSync(tokenFile, "renewed-token");

		const results = await Promise.all(sends.map(send => send()));

		expect(results.every(result => result.stopReason !== "error")).toBe(true);
		expect(rig.seen.length).toBe(20);
		expect(refused).toBe(10);
		expect(recovered).toBe(10);
		expect(rig.mints() - before).toBe(1);
	});

	async function staleHeaderWave(count: number): Promise<{ refusedResends: number; recovered: number }> {
		const counterFile = path.join(tempDir, "mints");
		const tokenFile = path.join(tempDir, "token");
		fs.writeFileSync(counterFile, "");
		fs.writeFileSync(tokenFile, "prepared-junk");
		const command = mintFromFile(counterFile, tokenFile);
		const rig = buildRig("literal-placeholder", counterFile, bearer => bearer !== "refused-junk", {
			headers: { Authorization: command },
		});
		const sends = await Promise.all(Array.from({ length: count }, () => rig.prepare()));
		// Another provider using this command advances its slot after these
		// operations prepared their auth. The live header resolver now reads 2,
		// but their seeded metadata still names 1. The gateway refuses 2.
		fs.writeFileSync(tokenFile, "refused-junk");
		await remintCommandConfig(command, 1);
		fs.writeFileSync(tokenFile, "replacement-junk");
		const results = await Promise.all(sends.map(send => send()));
		return {
			refusedResends: results.reduce((sum, _result, index) => {
				const attempts = rig.seen.slice(index * 2, index * 2 + 2);
				return sum + Number(attempts.length === 2 && attempts.every(value => value === "refused-junk"));
			}, 0),
			recovered: results.filter(result => result.stopReason !== "error").length,
		};
	}

	test("a header retry never resends the generation its request just had refused", async () => {
		expect((await staleHeaderWave(1)).refusedResends).toBe(0);
	});

	test("every prepared header operation recovers after a shared command advances", async () => {
		expect((await staleHeaderWave(10)).recovered).toBe(10);
	});

	test.each([1, 2])("a prepared header skips known-refused generations after %s recoveries", async advances => {
		const counterFile = path.join(tempDir, "mints");
		const tokenFile = path.join(tempDir, "token");
		fs.writeFileSync(counterFile, "");
		fs.writeFileSync(tokenFile, "generation-1-junk");
		let accepted = "generation-1-junk";
		const rig = buildRig("literal-placeholder", counterFile, bearer => bearer === accepted, {
			headers: { Authorization: mintFromFile(counterFile, tokenFile) },
		});
		const send = await rig.prepare();
		for (let generation = 2; generation <= advances + 1; generation++) {
			accepted = `generation-${generation}-junk`;
			fs.writeFileSync(tokenFile, accepted);
			expect((await rig.turn()).stopReason).not.toBe("error");
		}
		const requestsBefore = rig.seen.length;
		const mintsBefore = rig.mints();
		const result = await send();
		const sent = rig.seen.slice(requestsBefore);
		expect(sent.filter(value => value !== accepted).length).toBe(0);
		expect(result.stopReason).not.toBe("error");
		expect(sent.length).toBe(1);
		expect(rig.mints() - mintsBefore).toBe(0);
	});

	test.each(["apiKey", "header"])("a %s snapshot outliving two ordinary mints still recovers", async source => {
		const counterFile = path.join(tempDir, "mints");
		const tokenFile = path.join(tempDir, "token");
		fs.writeFileSync(counterFile, "");
		fs.writeFileSync(tokenFile, "generation-1-junk");
		const command = mintFromFile(counterFile, tokenFile);
		const rig = buildRig(
			source === "apiKey" ? command : "literal-placeholder",
			counterFile,
			bearer => bearer === "generation-3-junk",
			source === "header" ? { headers: { Authorization: command } } : {},
		);
		const send = await rig.prepare();
		for (const generation of [2, 3]) {
			fs.writeFileSync(tokenFile, `generation-${generation}-junk`);
			invalidateCommandConfig(command);
			await resolveConfigValue(command);
		}
		const before = rig.mints();
		expect((await send()).stopReason).not.toBe("error");
		expect(rig.seen).toEqual(["generation-1-junk", "generation-3-junk"]);
		expect(rig.mints() - before).toBe(0);
	});

	test.each(["apiKey", "header"])(
		"a prepared %s snapshot recovers every refusal with one helper execution",
		async source => {
			const counterFile = path.join(tempDir, "mints");
			const tokenFile = path.join(tempDir, "token");
			fs.writeFileSync(counterFile, "");
			fs.writeFileSync(tokenFile, "prepared-junk");
			const command = mintFromFile(counterFile, tokenFile);
			const gate = Promise.withResolvers<void>();
			let refusals = 0;
			const rig = buildRig(
				source === "apiKey" ? command : "literal-placeholder",
				counterFile,
				bearer => bearer === "replacement-junk",
				source === "header" ? { headers: { Authorization: command } } : {},
				async () => {
					if (++refusals === 10) gate.resolve();
					await gate.promise;
					return gatewayRefusal();
				},
			);
			const sends = await Promise.all(Array.from({ length: 10 }, () => rig.prepare()));
			const before = rig.mints();
			fs.writeFileSync(tokenFile, "replacement-junk");
			// The gateway genuinely refuses the prepared credential, whatever the
			// snapshot timing. Only the next generation can recover these turns.
			const results = await Promise.all(sends.map(send => send()));
			expect(refusals).toBe(10);
			expect(results.filter(result => result.stopReason !== "error").length).toBe(10);
			expect(rig.mints() - before).toBe(1);
			expect(rig.seen.length).toBe(20);
		},
	);

	test.each([
		["apiKey", "boundary"],
		["apiKey", "serialized"],
		["header", "boundary"],
		["header", "serialized"],
	] as const)(
		"a same-byte %s refusal wave recovers across %s settlement with one helper execution",
		async (source, schedule) => {
			const counterFile = path.join(tempDir, "mints");
			const tokenFile = path.join(tempDir, "token");
			fs.writeFileSync(counterFile, "");
			fs.writeFileSync(tokenFile, "unchanging-junk");
			const command = mintFromFile(counterFile, tokenFile);
			const gates = Array.from({ length: 10 }, () => Promise.withResolvers<void>());
			const allRefused = Promise.withResolvers<void>();
			let requests = 0;
			let refusals = 0;
			const rig = buildRig(
				source === "apiKey" ? command : "literal-placeholder",
				counterFile,
				() => ++requests > 10,
				source === "header" ? { headers: { Authorization: command } } : {},
				async () => {
					const index = refusals++;
					if (refusals === 10) allRefused.resolve();
					await gates[index].promise;
					return gatewayRefusal();
				},
			);
			const sends = await Promise.all(Array.from({ length: 10 }, () => rig.prepare()));
			const before = rig.mints();
			// All first attempts must be on the wire before any refusal lands.
			// Serializing sends instead would refuse each replacement generation.
			const pending = sends.map(send => send());
			const unsettled = new Set(pending);
			for (const operation of pending) void operation.then(() => unsettled.delete(operation));
			await allRefused.promise;
			if (schedule === "serialized") {
				for (const gate of gates) {
					gate.resolve();
					await Promise.race(unsettled);
				}
			} else {
				gates[0].resolve();
				await Promise.race(pending);
				for (const gate of gates.slice(1)) gate.resolve();
			}
			const results = await Promise.all(pending);
			expect(refusals).toBe(10);
			expect(results.filter(result => result.stopReason !== "error").length).toBe(10);
			expect(rig.mints() - before).toBe(1);
			expect(rig.seen.length).toBe(20);
		},
	);

	test("a header snapshot keeps the generation that produced its values during composition", async () => {
		const counterFile = path.join(tempDir, "mints");
		const tokenFile = path.join(tempDir, "token");
		fs.writeFileSync(counterFile, "");
		fs.writeFileSync(tokenFile, "prepared-junk");
		const command = mintFromFile(counterFile, tokenFile);
		let refusals = 0;
		const rig = buildRig(
			"literal-placeholder",
			counterFile,
			bearer => bearer === "replacement-junk",
			{
				headers: { Authorization: command },
			},
			() => {
				refusals++;
				return gatewayRefusal();
			},
		);
		let advanced = false;
		rig.model.resolveHeaders = createConfigHeaderResolver([
			rig.model.resolveHeaders,
			async () => {
				if (!advanced) {
					advanced = true;
					fs.writeFileSync(tokenFile, "replacement-junk");
					invalidateCommandConfig(command);
					await resolveConfigValue(command);
				}
				return { "x-probe": "present" };
			},
		]);
		const send = await rig.prepare();
		const before = rig.mints();
		expect((await send()).stopReason).not.toBe("error");
		// The snapshot sent generation 1, even though the cache changed while
		// composing its next layer. Its refusal can reuse the already-minted 2.
		expect(refusals).toBe(1);
		expect(rig.seen.length).toBe(2);
		expect(rig.mints() - before).toBe(0);
	});

	test("a refused snapshot joins an ordinary replacement already being minted", async () => {
		const counterFile = path.join(tempDir, "mints");
		const tokenFile = path.join(tempDir, "token");
		fs.writeFileSync(counterFile, "");
		fs.writeFileSync(tokenFile, "prepared-junk");
		const gateFile = path.join(tempDir, "mint-gate");
		const command = `!printf 1 >> '${counterFile}'; i=0; while [ -f '${gateFile}' ] && [ "$i" -lt 500 ]; do i=$((i+1)); sleep 0.01; done; IFS= read -r value < '${tokenFile}'; printf '%s' "$value"`;
		await resolveConfigValue(command);
		fs.writeFileSync(tokenFile, "replacement-junk");
		fs.writeFileSync(gateFile, "");
		const started = Promise.withResolvers<void>();
		const watcher = fs.watch(counterFile, () => {
			if (fs.readFileSync(counterFile, "utf8").length >= 2) started.resolve();
		});
		try {
			invalidateCommandConfig(command);
			const pending = resolveConfigValue(command);
			await started.promise;
			const replacements = Array.from({ length: 10 }, () => remintCommandConfig(command, 1));
			fs.unlinkSync(gateFile);
			const results = await Promise.all(replacements);
			await pending;
			expect(results.every(value => value === "replacement-junk")).toBe(true);
			// One initial mint and one replacement, not an ordinary mint plus a
			// competing recovery mint for the same refusal wave.
			expect(fs.readFileSync(counterFile, "utf8").length).toBe(2);
		} finally {
			watcher.close();
		}
	});

	test("a new operation never sends a generation already recorded as refused", async () => {
		const counterFile = path.join(tempDir, "mints");
		const tokenFile = path.join(tempDir, "token");
		fs.writeFileSync(counterFile, "");
		fs.writeFileSync(tokenFile, "refused-token");
		const rig = buildRig(mintFromFile(counterFile, tokenFile), counterFile, bearer => bearer === "accepted-token");

		expect((await rig.turn()).errorStatus).toBe(401);
		// Exhausting A's retry records generation 2, without spending an unused mint.
		expect(rig.mints()).toBe(2);
		fs.writeFileSync(tokenFile, "accepted-token");
		const beforeRequests = rig.seen.length;

		expect((await rig.turn()).stopReason).not.toBe("error");
		// B obtains generation 3 before its first request, not after another 401.
		expect(rig.seen.length - beforeRequests).toBe(1);
		expect(rig.mints()).toBe(3);
	});

	test("a header mint earns its same-byte retry on a bare 401", async () => {
		const counterFile = path.join(tempDir, "mints");
		const tokenFile = path.join(tempDir, "token");
		fs.writeFileSync(counterFile, "");
		fs.writeFileSync(tokenFile, "unchanging-token");
		let requests = 0;
		const rig = buildRig(
			"literal-placeholder",
			counterFile,
			() => requests++ > 0,
			{ headers: { Authorization: mintFromFile(counterFile, tokenFile) } },
			() => new Response(null, { status: 401 }),
		);

		expect((await rig.turn()).stopReason).not.toBe("error");
		expect(rig.seen.length).toBe(2);
		expect(rig.mints()).toBe(2);
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

	test("reuses a replacement the provider has not refused, whatever the client clock says of it", async () => {
		const counterFile = path.join(tempDir, "mints");
		const tokenFile = path.join(tempDir, "token");
		fs.writeFileSync(counterFile, "");
		// A JWT whose `exp` passed a minute ago, with a junk signature. Every
		// mint prints this same one, so the replacement is byte-identical to
		// the credential it replaces and equally "expired" by the local clock.
		fs.writeFileSync(tokenFile, junkJwt(Math.floor(Date.now() / 1000) - 60));
		const config = mintFromFile(counterFile, tokenFile);
		const rig = buildRig(config, counterFile, () => false);

		await rig.registry.getApiKey(rig.model);
		const mintsBefore = rig.mints();
		// Generation 1 is refused: the issuer is asked, and answers with the
		// same bytes as generation 2.
		const replacement = await remintCommandConfig(config, 1);
		expect(rig.mints() - mintsBefore).toBe(1);

		// A second request that also sent generation 1. Generation 2 is past
		// the `exp` it states and the clock agrees — and a clock running fast
		// would say so of a credential the provider is accepting. Only a
		// refusal of generation 2 may disqualify it, and none has arrived.
		expect(await remintCommandConfig(config, 1)).toBe(replacement);
		expect(rig.mints() - mintsBefore).toBe(1);
	});

	test("does not retry a replacement the provider already refused", async () => {
		const counterFile = path.join(tempDir, "mints");
		const tokenFile = path.join(tempDir, "token");
		fs.writeFileSync(counterFile, "");
		fs.writeFileSync(tokenFile, "first-token");
		const rig = buildRig(mintFromFile(counterFile, tokenFile), counterFile, bearer => bearer === "third-token");

		await rig.registry.getApiKey(rig.model);
		const mintsBefore = rig.mints();
		// Two operations resolved before any refusal, so both carry the first
		// credential.
		const first = await rig.prepare();
		const late = await rig.prepare();

		fs.writeFileSync(tokenFile, "second-token");
		// The first one's re-mint produces the second credential, and the
		// provider refuses that too; this operation has no retry left.
		expect((await first()).errorStatus).toBe(401);

		fs.writeFileSync(tokenFile, "third-token");
		// The late refusal still names the first credential. The second is
		// newer, but the provider has answered it, so handing it over would
		// spend this operation's one retry on a certainty.
		expect((await late()).stopReason).not.toBe("error");
		expect(rig.seen).toEqual(["first-token", "second-token", "first-token", "third-token"]);
		expect(rig.mints() - mintsBefore).toBe(2);
	});

	test("re-mints once across settlement when the issuer renews to the same bytes", async () => {
		const counterFile = path.join(tempDir, "mints");
		const tokenFile = path.join(tempDir, "token");
		fs.writeFileSync(counterFile, "");
		fs.writeFileSync(tokenFile, "unchanging-token");
		// Every mint prints the same bytes, so nothing about the credential
		// itself says which mint produced it. The provider refuses each turn's
		// first request and accepts its retry.
		let seenRequests = 0;
		const rig = buildRig(mintFromFile(counterFile, tokenFile), counterFile, () => seenRequests++ % 2 === 1);

		await rig.registry.getApiKey(rig.model);
		const mintsBefore = rig.mints();

		// All five resolve before any refusal, so all five carry the first
		// credential; they are then sent one at a time, so every refusal after
		// the first lands once the previous turn's re-mint has settled and
		// there is no in-flight run left to join.
		const sends = await Promise.all(Array.from({ length: 5 }, () => rig.prepare()));
		for (const send of sends) {
			expect((await send()).stopReason).not.toBe("error");
		}

		expect(rig.seen.length).toBe(10);
		// One mint for the wave. The four later refusals name a generation
		// older than the one cached, which the identical bytes cannot show.
		expect(rig.mints() - mintsBefore).toBe(1);
	});

	test("sends the retry its mint earned when the 401 carries no error class", async () => {
		const counterFile = path.join(tempDir, "mints");
		const tokenFile = path.join(tempDir, "token");
		fs.writeFileSync(counterFile, "");
		fs.writeFileSync(tokenFile, "unchanging-token");
		// A 401 with no body at all: nothing states the credential was
		// refused, so the recovery mints on the bare status alone.
		let seenRequests = 0;
		const rig = buildRig(
			mintFromFile(counterFile, tokenFile),
			counterFile,
			() => seenRequests++ >= 1,
			{},
			() => new Response(null, { status: 401 }),
		);

		await rig.registry.getApiKey(rig.model);
		const mintsBefore = rig.mints();
		const result = await rig.turn();

		expect(result.stopReason).not.toBe("error");
		// The mint ran, so the credential's generation advanced and the retry
		// is worth sending — even though the issuer handed back the same bytes
		// and nothing in the refusal said the credential was the problem.
		expect(rig.seen).toEqual(["unchanging-token", "unchanging-token"]);
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
	test("shares one header re-mint across ten worker-mirror refusals", async () => {
		const counterFile = path.join(tempDir, "mints");
		const tokenFile = path.join(tempDir, "token");
		fs.writeFileSync(counterFile, "");
		fs.writeFileSync(tokenFile, "expired-token");
		const wave = Promise.withResolvers<void>();
		let requests = 0;
		let refusals = 0;
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: async request => {
				requests++;
				if (request.headers.get("authorization") !== "expired-token") return okStream();
				if (++refusals === 10) {
					fs.writeFileSync(tokenFile, "renewed-token");
					wave.resolve();
				}
				await wave.promise;
				return gatewayRefusal();
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
						apiKey: "test",
						headers: { Authorization: mintFromFile(counterFile, tokenFile) },
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
			const results = await Promise.all(
				Array.from({ length: 10 }, () => worker.probe.turn(registry, "probe-gw", "gw-model")),
			);
			expect(results.every(result => result.ok)).toBe(true);
			expect(requests).toBe(20);
			// One cold initial execution plus one shared recovery execution.
			expect(fs.readFileSync(counterFile, "utf8").length).toBe(2);
		} finally {
			await worker.stop();
			server.stop(true);
		}
	});
});
