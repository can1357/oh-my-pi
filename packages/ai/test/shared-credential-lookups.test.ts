/**
 * The AWS credential and Vertex access-token lookups are shared by concurrent callers. Each runs on the
 * transport its own callers asked for: a caller that brings a different `fetch` gets its own lookup,
 * never a lookup sent through another caller's `fetch`. A lookup lives as long as any caller still
 * waits for it, is cancelled once every caller has left, and is never started by a held caller.
 *
 * Fixtures reach loopback endpoints through the global `fetch` (Bun's native fetch, plain HTTP). The
 * cases wait real time where nothing observable marks the moment: a caller joining a lookup in flight,
 * and a held caller that must send nothing, which only a span of silence at the endpoint can show.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearAwsCredentialCache, resolveAwsCredentials } from "@oh-my-pi/pi-ai/providers/aws-credentials";
import { __resetVertexTokenCache, getVertexAccessToken } from "@oh-my-pi/pi-ai/providers/google-auth";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import { runInRequestHoldScope } from "../src/request-hold";

interface RecordedRequest {
	readonly path: string;
	/** Set when the client gave up on the request before it was answered. */
	aborted: boolean;
}

/** A local endpoint that records each request and answers none until released. */
interface Endpoint {
	readonly requests: RecordedRequest[];
	/** A fetch that sends every request to this endpoint, keeping its path. */
	readonly fetch: FetchImpl;
	received(count: number): Promise<void>;
	release(): void;
}

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function endpoint(answer: () => Response): Endpoint {
	const requests: RecordedRequest[] = [];
	const gate = Promise.withResolvers<void>();
	const waiters: Array<{ count: number; resolve: () => void }> = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const recorded: RecordedRequest = { path: new URL(request.url).pathname, aborted: false };
			requests.push(recorded);
			request.signal.addEventListener("abort", () => {
				recorded.aborted = true;
			});
			for (const waiter of waiters.splice(0)) {
				if (requests.length >= waiter.count) waiter.resolve();
				else waiters.push(waiter);
			}
			await gate.promise;
			return answer();
		},
	});
	cleanups.push(() => server.stop(true));
	return {
		requests,
		fetch: (input, init) =>
			fetch(`${server.url.origin}${new URL(input instanceof Request ? input.url : String(input)).pathname}`, init),
		received(count) {
			if (requests.length >= count) return Promise.resolve();
			const { promise, resolve } = Promise.withResolvers<void>();
			waiters.push({ count, resolve });
			return promise;
		},
		release: () => gate.resolve(),
	};
}

/** Set `values` in the environment until the case ends. */
function withEnv(values: Record<string, string | undefined>): void {
	for (const [key, value] of Object.entries(values)) {
		const saved = Bun.env[key];
		if (value === undefined) delete Bun.env[key];
		else Bun.env[key] = value;
		cleanups.push(() => {
			if (saved === undefined) delete Bun.env[key];
			else Bun.env[key] = saved;
		});
	}
}

async function tempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-shared-credentials-"));
	cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
	return dir;
}

const settle = <T>(promise: Promise<T>): Promise<{ value: T } | { error: unknown }> =>
	promise.then(
		value => ({ value }),
		(error: unknown) => ({ error }),
	);

const outcomeOf = (outcome: { value: unknown } | { error: unknown }): unknown =>
	"value" in outcome ? outcome.value : outcome.error instanceof Error ? outcome.error.name : outcome.error;

interface Lookup {
	readonly name: string;
	/** Configure the environment so the lookup reaches the network through the given fetch. */
	setup(): Promise<void>;
	/** An endpoint answering this lookup with `secret` as the credential it hands back. */
	answer(secret: string): () => Response;
	/** Run the lookup, resolving to the credential's secret. */
	run(fetchImpl: FetchImpl, signal?: AbortSignal): Promise<string>;
}

const lookups: Lookup[] = [
	{
		name: "an AWS credential lookup",
		async setup() {
			const dir = await tempDir();
			const empty = path.join(dir, "empty");
			await Bun.write(empty, "");
			withEnv({
				AWS_ACCESS_KEY_ID: undefined,
				AWS_SECRET_ACCESS_KEY: undefined,
				AWS_SESSION_TOKEN: undefined,
				AWS_PROFILE: undefined,
				AWS_WEB_IDENTITY_TOKEN_FILE: undefined,
				AWS_ROLE_ARN: undefined,
				AWS_CONTAINER_CREDENTIALS_FULL_URI: undefined,
				AWS_CONTAINER_AUTHORIZATION_TOKEN: undefined,
				AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE: undefined,
				AWS_SHARED_CREDENTIALS_FILE: empty,
				AWS_CONFIG_FILE: empty,
				AWS_EC2_METADATA_DISABLED: "true",
				AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: "/v2/credentials/shared",
			});
			clearAwsCredentialCache();
			cleanups.push(() => clearAwsCredentialCache());
		},
		answer: secret => () =>
			Response.json({
				AccessKeyId: secret,
				SecretAccessKey: "secret",
				Token: "token",
				Expiration: "2099-01-01T00:00:00Z",
			}),
		run: async (fetchImpl, signal) =>
			(await resolveAwsCredentials({ region: "us-east-1", fetch: fetchImpl, signal })).accessKeyId,
	},
	{
		name: "a Vertex access token lookup",
		async setup() {
			const adc = path.join(await tempDir(), "adc.json");
			await Bun.write(
				adc,
				JSON.stringify({
					type: "authorized_user",
					client_id: "id",
					client_secret: "secret",
					refresh_token: "refresh",
				}),
			);
			withEnv({
				GOOGLE_APPLICATION_CREDENTIALS: adc,
				GOOGLE_CLOUD_ACCESS_TOKEN: undefined,
				CLOUDSDK_AUTH_ACCESS_TOKEN: undefined,
			});
			__resetVertexTokenCache();
			cleanups.push(() => __resetVertexTokenCache());
		},
		answer: secret => () => Response.json({ access_token: secret, expires_in: 3600 }),
		run: (fetchImpl, signal) => getVertexAccessToken({ fetch: fetchImpl, signal }),
	},
];

for (const lookup of lookups) {
	describe(lookup.name, () => {
		it("runs on each caller's own fetch", async () => {
			await lookup.setup();
			const first = endpoint(lookup.answer("FIRST"));
			const second = endpoint(lookup.answer("SECOND"));
			const firstCaller = lookup.run(first.fetch);
			await first.received(1);
			const secondCaller = settle(lookup.run(second.fetch));
			await Bun.sleep(100);
			first.release();
			second.release();

			expect({
				first: await firstCaller,
				second: outcomeOf(await secondCaller),
				firstRequests: first.requests.length,
				secondRequests: second.requests.length,
			}).toEqual({ first: "FIRST", second: "SECOND", firstRequests: 1, secondRequests: 1 });
		});

		it("serves a live joiner after the caller that started it leaves", async () => {
			await lookup.setup();
			const site = endpoint(lookup.answer("SHARED"));
			const starter = new AbortController();
			const started = settle(lookup.run(site.fetch, starter.signal));
			await site.received(1);
			const joiner = lookup.run(site.fetch, AbortSignal.timeout(5_000));
			await Bun.sleep(50);
			starter.abort();
			site.release();

			expect({
				starter: outcomeOf(await started),
				joiner: await joiner,
				requests: site.requests.length,
			}).toEqual({ starter: "AbortError", joiner: "SHARED", requests: 1 });
		});

		it("is cancelled once every caller has left", async () => {
			await lookup.setup();
			const site = endpoint(lookup.answer("UNUSED"));
			const first = new AbortController();
			const second = new AbortController();
			const outcomes = [settle(lookup.run(site.fetch, first.signal))];
			await site.received(1);
			outcomes.push(settle(lookup.run(site.fetch, second.signal)));
			await Bun.sleep(50);
			first.abort();
			second.abort();
			await Bun.sleep(100);
			site.release();

			expect({
				callers: (await Promise.all(outcomes)).map(outcomeOf),
				requestAborted: site.requests[0]?.aborted,
				requests: site.requests.length,
			}).toEqual({ callers: ["AbortError", "AbortError"], requestAborted: true, requests: 1 });
		});

		it("is not started by a held caller, which a live caller then starts", async () => {
			await lookup.setup();
			const site = endpoint(lookup.answer("LIVE"));
			const held = new AbortController();
			const ended = new AbortController();
			held.abort();
			cleanups.push(() => ended.abort());
			const heldCaller = settle(runInRequestHoldScope(held.signal, ended.signal, () => lookup.run(site.fetch)));
			await Bun.sleep(150);
			const sentWhileOnlyHeld = site.requests.length;
			const live = lookup.run(site.fetch);
			site.release();
			const liveSecret = await live;
			ended.abort();

			expect({
				sentWhileOnlyHeld,
				live: liveSecret,
				held: outcomeOf(await heldCaller),
				requests: site.requests.length,
			}).toEqual({ sentWhileOnlyHeld: 0, live: "LIVE", held: "AbortError", requests: 1 });
		});
	});
}
