/**
 * Work that one caller starts but every caller shares (a token or credential lookup, an OAuth refresh,
 * a usage poll, a saved-reset lookup or redemption, the broker's usage report and observed-usage
 * batch) belongs to no caller's provider-request hold. When a held job happens to start it, a live
 * caller that joins it gets its result: the shared request is sent, once, instead of waiting for the
 * held job's owner to end and then failing with the hold's refusal.
 *
 * Each case starts the shared work in a held scope, then has a live caller join it while the
 * endpoint holds its answer, so the live call can only join, never find a cached result. The cases
 * wait real time: the shared work registers after the held call's own awaits (database reads,
 * credential lookups), and only a loopback request shows whether it was sent.
 *
 * Every endpoint speaks HTTPS on `localhost` (`helpers/loopback-tls.ts`), and each case counts what it
 * receives. No request here is an Anthropic Messages request, so each goes through the global fetch
 * over HTTPS as over `http`; the scheme matches production's all the same. The path each fixture's
 * request takes, against production's:
 * - The Vertex and AWS lookups get a caller `fetch` that sends to the endpoint through the global
 *   fetch; production hands them the provider's `transportFetch`, which for these providers also ends
 *   in the global fetch. The caller fetch is needed to send the lookup to the endpoint at all: the
 *   real token URLs are fixed hosts.
 * - The OAuth refresh, the usage poll, the store's usage report and the saved-reset requests call the
 *   global fetch, as production's do. The saved-reset requests use a loopback base URL, not the
 *   official API.
 * - The auth broker serves only `http`, so its client reaches it through an HTTPS front that counts
 *   and holds each request. The client uses the global fetch, its production default.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, type OAuthCredential, type ResetCreditTarget, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import { AuthBrokerClient, RemoteAuthCredentialStore, startAuthBroker } from "@oh-my-pi/pi-ai/auth-broker";
import { clearAwsCredentialCache, resolveAwsCredentials } from "@oh-my-pi/pi-ai/providers/aws-credentials";
import { __resetVertexTokenCache, getVertexAccessToken } from "@oh-my-pi/pi-ai/providers/google-auth";
import { registerOAuthProvider, unregisterOAuthProviders } from "@oh-my-pi/pi-ai/registry/oauth";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import type { UsageProvider, UsageReport } from "@oh-my-pi/pi-ai/usage";
import { claudeUsageProvider } from "@oh-my-pi/pi-ai/usage/claude";
import { runInRequestHoldScope } from "../src/request-hold";
import { LOOPBACK_TLS, loopbackOrigin, trustLoopbackTls } from "./helpers/loopback-tls";

trustLoopbackTls();

/** A local HTTPS endpoint that records each request and answers none until released. */
interface SharedEndpoint {
	readonly url: string;
	/** The path of each request received. */
	readonly paths: string[];
	/** Answer the requests received so far, and every later one at once. */
	release(): void;
	stop(): void;
}

function sharedEndpoint(answer: (request: Request, body: string) => Response | Promise<Response>): SharedEndpoint {
	const paths: string[] = [];
	const gate = Promise.withResolvers<void>();
	const server = Bun.serve({
		...LOOPBACK_TLS,
		port: 0,
		fetch: async request => {
			const body = await request.text();
			paths.push(new URL(request.url).pathname);
			await gate.promise;
			return answer(request, body);
		},
	});
	return { url: loopbackOrigin(server), paths, release: () => gate.resolve(), stop: () => server.stop(true) };
}

/** A fetch that sends every request to `site`, keeping its path, through the global fetch. */
const toSite =
	(site: SharedEndpoint): FetchImpl =>
	(input, init) =>
		fetch(`${site.url}${new URL(input instanceof Request ? input.url : String(input)).pathname}`, init);

const STILL_WAITING = "still waiting";

describe("shared work a held job starts", () => {
	let held: AbortController;
	let ended: AbortController;
	const cleanups: Array<() => unknown> = [];

	beforeEach(() => {
		held = new AbortController();
		ended = new AbortController();
	});

	afterEach(async () => {
		ended.abort();
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	});

	/**
	 * `heldCall` runs first, in a held scope; while its shared work is in flight, `liveCall` runs outside
	 * every scope. `site` answers once both were made. Returns what the live call got within 1.5 s.
	 */
	async function liveCallerOf<T>(
		site: SharedEndpoint,
		heldCall: () => Promise<unknown>,
		liveCall: () => Promise<T>,
	): Promise<T | typeof STILL_WAITING> {
		held.abort();
		void runInRequestHoldScope(held.signal, ended.signal, heldCall).catch(() => undefined);
		await Bun.sleep(100);
		const live = liveCall();
		void live.catch(() => undefined);
		await Bun.sleep(50);
		site.release();
		return Promise.race([live, Bun.sleep(1_500).then((): typeof STILL_WAITING => STILL_WAITING)]);
	}

	function endpoint(answer: (request: Request, body: string) => Response | Promise<Response>): SharedEndpoint {
		const site = sharedEndpoint(answer);
		cleanups.push(() => site.stop());
		return site;
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
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-hold-shared-"));
		cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
		return dir;
	}

	it("a Vertex access token lookup", async () => {
		const dir = await tempDir();
		const adc = path.join(dir, "adc.json");
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
		const site = endpoint(() => Response.json({ access_token: "shared-token", expires_in: 3600 }));
		const lookup = () => getVertexAccessToken({ fetch: toSite(site) });

		const live = await liveCallerOf(site, lookup, lookup);

		expect({ live, sent: site.paths.length }).toEqual({ live: "shared-token", sent: 1 });
	});

	it("an AWS credential lookup", async () => {
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
		const site = endpoint(() =>
			Response.json({
				AccessKeyId: "AKIASHARED",
				SecretAccessKey: "secret",
				Token: "token",
				Expiration: "2099-01-01T00:00:00Z",
			}),
		);
		const lookup = () => resolveAwsCredentials({ region: "us-east-1", fetch: toSite(site) });

		const live = await liveCallerOf(site, lookup, async () => (await lookup()).accessKeyId);

		expect({ live, sent: site.paths.length }).toEqual({ live: "AKIASHARED", sent: 1 });
	});

	describe("an OAuth refresh", () => {
		const PROVIDER = "unit-hold-shared-refresh";
		const SOURCE = "request-hold-shared-work-test";
		let storage: AuthStorage;
		let site: SharedEndpoint;

		beforeEach(async () => {
			site = endpoint(() => Response.json({ access: "fresh-access" }));
			registerOAuthProvider({
				id: PROVIDER,
				name: "Hold Shared Refresh",
				sourceId: SOURCE,
				async login() {
					return { access: "login", refresh: "login", expires: Date.now() + 3_600_000 };
				},
				async refreshToken(credentials, signal) {
					const response = await fetch(`${site.url}/token`, { method: "POST", body: credentials.refresh, signal });
					const { access } = (await response.json()) as { access: string };
					return { ...credentials, access, refresh: "next-refresh", expires: Date.now() + 3_600_000 };
				},
				getApiKey: credentials => credentials.access,
			});
			cleanups.push(() => unregisterOAuthProviders(SOURCE));
			const dir = await tempDir();
			storage = await AuthStorage.create(path.join(dir, "agent.db"));
			cleanups.push(() => storage.close());
		});

		it("of an expired token, joined by a live key lookup", async () => {
			await storage.credentials.set(PROVIDER, [
				{ type: "oauth", access: "stale", refresh: "refresh", expires: Date.now() - 1_000 },
			]);

			const live = await liveCallerOf(
				site,
				() => storage.keys.get(PROVIDER, "held-session"),
				() => storage.keys.get(PROVIDER, "live-session"),
			);

			expect({ live, sent: site.paths.length }).toEqual({ live: "fresh-access", sent: 1 });
		});

		it("forced by its caller, joined by a live forced refresh", async () => {
			await storage.credentials.set(PROVIDER, [
				{ type: "oauth", access: "current", refresh: "refresh", expires: Date.now() + 3_600_000 },
			]);

			const live = await liveCallerOf(
				site,
				() => storage.oauth.access(PROVIDER, "held-session", { forceRefresh: true }),
				async () => (await storage.oauth.access(PROVIDER, "live-session", { forceRefresh: true }))?.accessToken,
			);

			expect({ live, sent: site.paths.length }).toEqual({ live: "fresh-access", sent: 1 });
		});

		it("of a stored row by id, joined by a live refresh of the same row", async () => {
			await storage.credentials.set(PROVIDER, [
				{ type: "oauth", access: "current", refresh: "refresh", expires: Date.now() + 3_600_000 },
			]);
			const account = storage.oauth.accounts(PROVIDER)[0];
			if (!account) throw new Error("expected the stored account");

			const live = await liveCallerOf(
				site,
				() => storage.oauth.refresh(account.credentialId),
				async () => {
					const { credential } = await storage.oauth.refresh(account.credentialId);
					return credential.type === "oauth" ? credential.access : credential.type;
				},
			);

			expect({ live, sent: site.paths.length }).toEqual({ live: "fresh-access", sent: 1 });
		});
	});

	it("a usage poll", async () => {
		const site = endpoint(() => new Response("ok"));
		const report: UsageReport = {
			provider: "anthropic",
			fetchedAt: Date.now(),
			limits: [],
			metadata: { email: "a@example.com", accountId: "account-a" },
		};
		const usage: UsageProvider = {
			...claudeUsageProvider,
			async fetchUsage() {
				await fetch(`${site.url}/usage`, { method: "POST", body: "{}" });
				return report;
			},
		};
		const storage = await AuthStorage.create(":memory:", {
			usageProviderResolver: provider => (provider === "anthropic" ? usage : undefined),
		});
		cleanups.push(() => storage.close());
		await storage.credentials.set("anthropic", [
			{
				type: "oauth",
				access: "access-a",
				refresh: "refresh-a",
				expires: Date.now() + 3_600_000,
				accountId: "account-a",
				email: "a@example.com",
			},
		]);

		const live = await liveCallerOf(
			site,
			() => storage.usage.reports(),
			async () => (await storage.usage.reports())?.filter(entry => entry.provider === "anthropic").length,
		);

		expect({ live, sent: site.paths.length }).toEqual({ live: 1, sent: 1 });
	});

	it("a usage report a credential store supplies", async () => {
		const site = endpoint(() => Response.json({ reports: [] }));
		const store = await SqliteAuthCredentialStore.open(":memory:");
		// A store that answers usage itself, as the broker-backed one does, over its own request.
		const fetchUsageReports = async (): Promise<UsageReport[]> => {
			const response = await fetch(`${site.url}/usage`, { method: "POST", body: "{}" });
			return ((await response.json()) as { reports: UsageReport[] }).reports;
		};
		const storage = new AuthStorage(Object.assign(store, { fetchUsageReports }));
		cleanups.push(() => storage.close());

		const live = await liveCallerOf(
			site,
			() => storage.usage.reports(),
			() => storage.usage.reports(),
		);

		expect({ live, sent: site.paths.length }).toEqual({ live: [], sent: 1 });
	});

	describe("a saved-reset", () => {
		let storage: AuthStorage;
		let site: SharedEndpoint;
		let target: ResetCreditTarget;
		const hour = 3_600_000;

		beforeEach(async () => {
			site = endpoint(request => {
				const url = new URL(request.url);
				if (request.method === "POST" && url.pathname.endsWith("/reset_rate_limits")) {
					return Response.json({ result: "reset", resets_left: 1, cleared: ["five_hour"] });
				}
				return Response.json({
					five_hour: { utilization: 100, resets_at: new Date(Date.now() + 2 * hour).toISOString() },
					seven_day: { utilization: 40, resets_at: new Date(Date.now() + 72 * hour).toISOString() },
					cedar_ember: {
						eligible: true,
						at_limit: true,
						exhausted: ["five_hour"],
						next_grant_id: "saved-reset",
						grants: [
							{
								id: "saved-reset",
								label: "Saved session reset",
								resets_total: 2,
								resets_left: 2,
								starts_at: new Date(Date.now() - hour).toISOString(),
								ends_at: new Date(Date.now() + 24 * hour).toISOString(),
								clears: ["five_hour"],
								paused: false,
								usable_now: true,
								use_requires_limit: true,
								percent_used: { five_hour: 100 },
								blocking: [],
							},
						],
					},
					juniper_tide: { eligible: false, in_experiment: false, available: false, arm: "control" },
				});
			});
			storage = await AuthStorage.create(":memory:", {
				usageProviderResolver: provider => (provider === "anthropic" ? claudeUsageProvider : undefined),
				// Resolved per request, as code that calls `fetch` does.
				usageFetch: ((input, init) => fetch(input, init)) as typeof fetch,
			});
			cleanups.push(() => storage.close());
			const credential: OAuthCredential = {
				type: "oauth",
				access: "token-org",
				refresh: "refresh-org",
				expires: Date.now() + hour,
				accountId: "account",
				email: "same@example.com",
				orgId: "org-a",
			};
			await storage.credentials.set("anthropic", [credential]);
			const account = storage.oauth.accounts("anthropic")[0];
			if (!account) throw new Error("expected the stored account");
			target = { provider: "anthropic", credentialId: account.credentialId, creditId: "saved-reset" };
		});

		const baseUrlResolver = () => site.url;

		it("lookup", async () => {
			const list = () => storage.resets.list({ provider: "anthropic", baseUrlResolver });

			const live = await liveCallerOf(site, list, async () => (await list()).length);

			expect({ live, sent: site.paths.length > 0 }).toEqual({ live: 1, sent: true });
		});

		it("redemption", async () => {
			const redeem = () => storage.resets.redeem({ target, baseUrlResolver });

			const live = await liveCallerOf(site, redeem, async () => (await redeem()).ok);

			expect({
				live,
				redemptions: site.paths.filter(entry => entry.endsWith("/reset_rate_limits")).length,
			}).toEqual({ live: true, redemptions: 1 });
		});
	});

	describe("the auth broker's", () => {
		const token = "hold-shared-bearer";
		let remote: RemoteAuthCredentialStore;
		let brokerStorage: AuthStorage;
		/**
		 * The HTTPS front the client reaches the broker through: it records each request's path and holds
		 * the broker's answer until released, so a live caller can join the request in flight.
		 */
		let front: SharedEndpoint;

		beforeEach(async () => {
			brokerStorage = await AuthStorage.create(":memory:", { usageProviderResolver: () => undefined });
			cleanups.push(() => brokerStorage.close());
			const handle = startAuthBroker({
				storage: brokerStorage,
				bind: "127.0.0.1:0",
				bearerTokens: [token],
				disableRefresher: true,
			});
			cleanups.push(() => handle.close());
			front = endpoint(async (request, body) => {
				const url = new URL(request.url);
				const headers = new Headers(request.headers);
				headers.delete("host");
				const upstream = await fetch(`${handle.url}${url.pathname}${url.search}`, {
					method: request.method,
					headers,
					body: request.method === "GET" || request.method === "HEAD" ? undefined : body,
				});
				return new Response(await upstream.arrayBuffer(), {
					status: upstream.status,
					headers: { "content-type": upstream.headers.get("content-type") ?? "application/json" },
				});
			});
			const client = new AuthBrokerClient({ url: front.url, token });
			remote = new RemoteAuthCredentialStore({ client, streamSnapshots: false, observedUsageFlushMs: 25 });
			cleanups.push(() => remote.close());
		});

		it("usage report", async () => {
			const live = await liveCallerOf(
				front,
				() => remote.fetchUsageReports(),
				() => remote.fetchUsageReports(),
			);

			expect({ live, sent: front.paths.filter(entry => entry === "/v1/usage").length }).toEqual({
				live: [],
				sent: 1,
			});
		});

		it("observed-usage batch", async () => {
			front.release();
			const entry = (model: string) => ({
				at: Date.now(),
				provider: "anthropic",
				model,
				requests: 1,
				inputTokens: 10,
				outputTokens: 5,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				costUsd: 0,
			});
			held.abort();
			// The held job's usage schedules the batch's flush; a live session's usage joins that batch.
			runInRequestHoldScope(held.signal, ended.signal, () => remote.recordObservedUsage([entry("held-model")]));
			remote.recordObservedUsage([entry("live-model")]);
			await Bun.sleep(500);

			// One request from each session, both reported in the one batch.
			const reported = brokerStorage.usage
				.clientSummary(0)
				.clients.flatMap(client => client.providers)
				.reduce((total, provider) => total + provider.requests, 0);
			expect({ reported, sent: front.paths.filter(path => path === "/v1/usage/observed").length }).toEqual({
				reported: 2,
				sent: 1,
			});
		});
	});
});
