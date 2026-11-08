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
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

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

interface Rig {
	registry: ModelRegistry;
	model: Model<Api>;
	/** Bearer of every request the provider saw, in arrival order. */
	seen: string[];
	/** How many times the mint ran. */
	mints: () => number;
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

	function buildRig(apiKeyConfig: string, counterFile: string, accept: (bearer: string | undefined) => boolean): Rig {
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

		const turn = async (): Promise<AssistantMessage> => {
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
			return await handle.result();
		};

		return { registry, model, seen, mints: () => fs.readFileSync(counterFile, "utf8").length, turn };
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
});
